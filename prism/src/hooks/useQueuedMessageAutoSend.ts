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
 * Dispatches queued messages for sessions the user is NOT currently viewing.
 *
 * The composer persists each queued draft (text + send options snapshotted at
 * queue time) under `queued_message_<sessionId>`. When a session's run leaves
 * the processing map — its previous response completed — this hook sends that
 * session's queued message immediately instead of waiting for the user to
 * open the session again.
 *
 * 认领走 `claimQueuedMessage`(见 queueClaim.ts):同一个标签页内靠"清键"和输入框
 * 的 flush 互相避让,**跨标签页**靠 Web Locks + 盖戳回读互斥,免得两个标签页同时
 * 看到同一个会话跑完、把同一条排队消息各发一遍。
 */
export function useQueuedMessageAutoSend({
  processingSessions,
  activeSessionId,
  sendMessage,
  markSessionProcessing,
}: UseQueuedMessageAutoSendArgs) {
  const prevProcessingRef = useRef<ReadonlySet<string>>(new Set());

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
         * fz:**带上幂等键,带上图片,而且不再"发完就删"。**
         *
         * 这条路是**用户没在看的那些会话**的唯一投递者,也就是本地队列存在的
         * 理由。它此前:
         *
         * 1. 不带 `clientMessageId` —— 服务端对没有幂等键的一律放行、
         *    **也不回 ACK**。于是"发出去了"的判据退回到 F09 之前那一个:
         *    `socket.send()` 没抛异常。写进发送缓冲就算数,而缓冲里的帧在
         *    切网 / 休眠唤醒 / 代理超时时会连着连接一起没。
         * 2. `images: []` 写死 —— 带图的排队消息一律当纯文本发出去。
         * 3. 发完立刻 `clearQueuedMessage` —— 底稿当场撕掉,第 1 条一旦落空,
         *    消息和记录一起消失,界面上还留着一个"在跑"的转圈。
         *
         * 现在:幂等键原样带上(服务端据此去重、并回 `chat_ack`),图片描述符
         * 原样带上,**记录留到 ACK 到达再清** —— 没等到就靠 TTL 自然释放,
         * 下一次还能重投,重投的是同一个幂等键,服务端认得出来不会发两遍。
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
             * ga:**分叉点与隐藏上下文也要带上。**
             *
             * 它们在盘上是顶层字段(`toStoredCommand`),fz 修好了"读回来别削掉"
             * 还专门写了测试断言它们能穿过 localStorage —— **穿过来了,却没人用**。
             * composer 自己那条投递路是带的,这条后台路漏了,又是"同一件事只写在
             * 一部分入口上"。
             *
             * 漏掉的后果:排队中的「编辑重跑」切走再回来会变成**在当前对话末尾
             * 接着说**(不分叉,带着全部旧上下文);而「让 Claude 建定时任务」
             * 的票据与接口说明全在 hiddenContext 里,丢了模型就只收到一句人话。
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

        // 没有幂等键的老记录收不到 ACK —— 它只能沿用旧行为当场清掉,
        // 否则会一直重投。带键的那些交给 `chat_ack` 清 —— 注意那个清理点在
        // **应用级**的实时帧处理器里(useChatRealtimeHandlers),不是 composer:
        // composer 只存在于当前正看的那条会话上,而这条路服务的正是后台会话。
        if (!queued.clientMessageId) clearQueuedMessage(sessionId);
        markSessionProcessing(sessionId, { statusText: null, canInterrupt: true });
      }).catch((error) => {
        console.error('排队消息发送失败:', error);
      });
    }
  }, [processingSessions, activeSessionId, sendMessage, markSessionProcessing]);
}
