import { useEffect, useRef } from 'react';

import {
  claimQueuedMessage,
  clearQueuedMessage,
  readQueuedMessage,
  releaseQueuedMessage,
} from '../components/chat/utils/chatStorage';
import { queueLockName, runExclusive } from '../components/chat/utils/queueClaim';

import type { MarkSessionProcessing, SessionActivityMap } from './useSessionProtection';

interface UseQueuedMessageAutoSendArgs {
  processingSessions: SessionActivityMap;
  /**
   * The session currently open in the chat view. Its queued draft is owned by
   * the composer (which also handles image attachments and slash commands),
   * so this hook never touches it.
   */
  activeSessionId: string | null;
  /** Returns false when the socket was not open, so the draft can be kept. */
  sendMessage: (message: unknown) => boolean;
  markSessionProcessing: MarkSessionProcessing;
}

/**
 * 后台续发的上限。
 *
 * 服务端任何一条不回 ACK 的早退都回 `protocol_error`,前端对多数 code 会把会话标回空闲,
 * 而"会话从跑着变成空闲"正是这个 hook 的触发条件。记录只在 ACK 时清、自己的戳恒可认领,
 * 不设上限就会"发 → 拒 → 空闲 → 再发 → 再拒"以 WS 往返为周期无限循环。
 * 同一条消息在窗口内连发 N 次都没等到 ACK 就放弃,把记录清掉。
 */
export const AUTO_SEND_MAX_ATTEMPTS = 3;
export const AUTO_SEND_ATTEMPT_WINDOW_MS = 60_000;

/**
 * 这一次是否还允许续发;会就地更新 `attempts` 里该会话的计数。
 *
 * 按"同一条消息"计数,不是按会话:计的是同一个 clientMessageId 反复发出去都没等到
 * ACK 的次数。换了一条消息(上一条已 ACK、用户又排了新的)就从 1 重新数 —— 否则一个
 * 后台会话里连着几个短回合各排一条,第 4 条会被当成死循环清掉。
 */
export function autoSendAttemptAllowed(
  attempts: Map<string, { messageId: string | null; count: number; firstAt: number }>,
  sessionId: string,
  now: number,
  messageId: string | null = null,
  max: number = AUTO_SEND_MAX_ATTEMPTS,
  windowMs: number = AUTO_SEND_ATTEMPT_WINDOW_MS,
): boolean {
  const entry = attempts.get(sessionId);
  if (!entry || entry.messageId !== messageId || now - entry.firstAt > windowMs) {
    attempts.set(sessionId, { messageId, count: 1, firstAt: now });
    return true;
  }
  entry.count += 1;
  return entry.count <= max;
}

/**
 * Dispatches queued messages for sessions the user is NOT currently viewing.
 *
 * The composer persists each queued draft (text + send options snapshotted at
 * queue time) under `queued_message_<sessionId>`. When a session's run leaves
 * the processing map — its previous response completed — this hook sends that
 * session's queued message immediately instead of waiting for the user to
 * open the session again.
 *
 * 认领走 `claimQueuedMessage`(见 queueClaim.ts):同一个标签页内靠"清键"和输入框
 * 的 flush 互相避让,跨标签页靠 Web Locks + 盖戳回读互斥,免得两个标签页同时
 * 看到同一个会话跑完、把同一条排队消息各发一遍。
 */
export function useQueuedMessageAutoSend({
  processingSessions,
  activeSessionId,
  sendMessage,
  markSessionProcessing,
}: UseQueuedMessageAutoSendArgs) {
  const prevProcessingRef = useRef<ReadonlySet<string>>(new Set());
  const attemptsRef = useRef(new Map<string, { messageId: string | null; count: number; firstAt: number }>());

  useEffect(() => {
    const prev = prevProcessingRef.current;
    const current = new Set(processingSessions.keys());
    prevProcessingRef.current = current;

    for (const sessionId of prev) {
      if (current.has(sessionId) || sessionId === activeSessionId) {
        continue;
      }

      // 快速路径:没有排队记录就别去抢锁(绝大多数会话都走这条)。
      if (!readQueuedMessage(sessionId)) {
        continue;
      }

      void runExclusive(queueLockName(sessionId), () => {
        // 认领不到 = 键已经没了,或者别的标签页刚抢走。两种都不该再发一次。
        const queued = claimQueuedMessage(sessionId);
        if (!queued) {
          return;
        }

        /**
         * 带分叉点的不在这里发。
         *
         * 「编辑重跑」要另起一支(sessionId 为空、由投递路径新建会话),而这条路只会
         * 往存储键对应的原会话发 —— 服务端一看它有原生 id 就把 forkFrom 丢掉。
         * 留给 composer:用户打开这条会话时它会按"有 forkFrom 就新开一支"投递。
         */
        if (queued.forkFrom) {
          releaseQueuedMessage(sessionId);
          return;
        }

        if (!autoSendAttemptAllowed(attemptsRef.current, sessionId, Date.now(), queued.clientMessageId ?? null)) {
          console.warn(`[queue] 会话 ${sessionId} 的排队消息连续 ${AUTO_SEND_MAX_ATTEMPTS} 次没等到 ACK,放弃续发`);
          clearQueuedMessage(sessionId);
          attemptsRef.current.delete(sessionId);
          return;
        }

        /**
         * 这条路是用户没在看的那些会话的唯一投递者,所以:
         *
         * - 幂等键原样带上:服务端据此去重并回 `chat_ack`。没有幂等键时服务端不回 ACK,
         *   "发出去了"就只剩 `socket.send()` 没抛异常,而发送缓冲里的帧会在切网 / 休眠唤醒 /
         *   代理超时时随连接一起丢。
         * - 图片描述符原样带上。
         * - 记录留到 ACK 到达再清;没等到就靠 TTL 自然释放,下一次重投的是同一个幂等键,
         *   服务端认得出来,不会发两遍。
         */
        const sent = sendMessage({
          type: 'chat.send',
          sessionId,
          ...(queued.clientMessageId ? { clientMessageId: queued.clientMessageId } : {}),
          content: queued.content,
          options: {
            ...(queued.options ?? {}),
            images: Array.isArray(queued.images) ? queued.images : [],
            /**
             * 分叉点与隐藏上下文(盘上的顶层字段,见 `toStoredCommand`)和 composer 那条投递路一样带上。
             * 「让 Claude 建定时任务」的票据与接口说明全在 hiddenContext 里,丢了模型就只收到一句人话。
             * 带 forkFrom 的记录在上面已经留给 composer,所以走到这里时 forkFrom 总是空的。
             */
            ...(queued.forkFrom ? { forkFrom: queued.forkFrom } : {}),
            ...(queued.hiddenContext ? { hiddenContext: queued.hiddenContext } : {}),
          },
        });
        if (!sent) {
          // 没发出去就把戳摘掉,别让这条记录白白锁上一个 TTL。
          releaseQueuedMessage(sessionId);
          return;
        }

        // 没有幂等键的记录收不到 ACK,只能当场清掉,否则会一直重投。
        // 带键的交给 `chat_ack` 清,清理点在应用级的实时帧处理器里(useChatRealtimeHandlers)
        // 而不是 composer:composer 只存在于当前正看的会话上,这条路服务的正是后台会话。
        if (!queued.clientMessageId) clearQueuedMessage(sessionId);
        markSessionProcessing(sessionId, { statusText: null, canInterrupt: true });
      }).catch((error) => {
        console.error('排队消息发送失败:', error);
      });
    }
  }, [processingSessions, activeSessionId, sendMessage, markSessionProcessing]);
}
