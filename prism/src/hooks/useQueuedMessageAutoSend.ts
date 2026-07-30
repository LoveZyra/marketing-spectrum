import { useEffect, useRef } from 'react';

import { clearQueuedMessage, readQueuedMessage } from '../components/chat/utils/chatStorage';

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
 * open the session again. Removing the storage key before sending is the
 * claim that keeps the composer's own flush from double-sending.
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

      const queued = readQueuedMessage(sessionId);
      if (!queued) {
        continue;
      }

      // The draft is only released once the frame is confirmed to have left the
      // client. Clearing first and discovering the socket was closed afterwards
      // would lose the message with nothing in the UI to show for it — and
      // nothing between these two statements can yield, so there is no window
      // for the composer's own flush to double-send.
      const sent = sendMessage({
        type: 'chat.send',
        sessionId,
        content: queued.content,
        options: { ...(queued.options ?? {}), images: [] },
      });
      if (!sent) {
        continue;
      }

      clearQueuedMessage(sessionId);
      markSessionProcessing(sessionId, { statusText: null, canInterrupt: true });
    }
  }, [processingSessions, activeSessionId, sendMessage, markSessionProcessing]);
}
