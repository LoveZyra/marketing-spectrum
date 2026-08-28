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

        // The draft is only released once the frame is confirmed to have left the
        // client. Clearing first and discovering the socket was closed afterwards
        // would lose the message with nothing in the UI to show for it.
        const sent = sendMessage({
          type: 'chat.send',
          sessionId,
          content: queued.content,
          options: { ...(queued.options ?? {}), images: [] },
        });
        if (!sent) {
          // 没发出去就把戳摘掉,别让这条记录白白锁上一个 TTL。
          releaseQueuedMessage(sessionId);
          return;
        }

        clearQueuedMessage(sessionId);
        markSessionProcessing(sessionId, { statusText: null, canInterrupt: true });
      }).catch((error) => {
        console.error('排队消息发送失败:', error);
      });
    }
  }, [processingSessions, activeSessionId, sendMessage, markSessionProcessing]);
}
