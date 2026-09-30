import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../../../utils/api';

/**
 * gy:当前会话里**我**对各条回答的反馈(👍/👎 与效果调查卡)。
 *
 * 一人一条回答一份意见;服务端 upsert。这里只维护一张 message_id → 行 的表,
 * 点亮按钮、让答过的调查卡不再出现都靠它。会话切换整表重拉。
 */
export type FeedbackVerdict = 1 | 0 | -1;
export type FeedbackCategory = 'wrong_result' | 'not_as_asked' | 'wrong_tool' | 'too_slow' | 'other';

export type MessageFeedbackRow = {
  message_id: string;
  source: 'vote' | 'survey';
  verdict: FeedbackVerdict | null;
  status: 'answered' | 'dismissed';
  category: string | null;
  note: string | null;
  expected_output: string | null;
  skill_hint: string | null;
};

export type FeedbackPayload = {
  source: 'vote' | 'survey';
  status?: 'answered' | 'dismissed';
  verdict?: FeedbackVerdict;
  category?: FeedbackCategory | null;
  note?: string | null;
  expectedOutput?: string | null;
  skillHint?: string | null;
};

export type MessageFeedbackState = {
  byMessageId: ReadonlyMap<string, MessageFeedbackRow>;
  submit: (messageId: string, payload: FeedbackPayload) => Promise<MessageFeedbackRow | null>;
  remove: (messageId: string) => Promise<void>;
};

const EMPTY: ReadonlyMap<string, MessageFeedbackRow> = new Map();

export function useMessageFeedback(sessionId: string | null): MessageFeedbackState {
  const [byMessageId, setByMessageId] = useState<ReadonlyMap<string, MessageFeedbackRow>>(EMPTY);
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;

  useEffect(() => {
    setByMessageId(EMPTY);
    if (!sessionId) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await api.sessionFeedback.list(sessionId);
        if (!response.ok) return;
        const body = (await response.json().catch(() => null)) as { data?: { feedback?: MessageFeedbackRow[] } } | null;
        const rows = body?.data?.feedback;
        if (cancelled || !Array.isArray(rows) || sessionRef.current !== sessionId) return;
        setByMessageId(new Map(rows.map((row) => [row.message_id, row])));
      } catch { /* 拉不到就当没投过 —— 按钮不点亮,调查卡照常 */ }
    })();
    return () => { cancelled = true; };
  }, [sessionId]);

  const submit = useCallback(async (messageId: string, payload: FeedbackPayload) => {
    const target = sessionRef.current;
    if (!target) return null;
    const response = await api.sessionFeedback.set(target, messageId, payload);
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error || `HTTP ${response.status}`);
    }
    const body = (await response.json().catch(() => null)) as { data?: { feedback?: MessageFeedbackRow } } | null;
    const row = body?.data?.feedback ?? null;
    if (row && sessionRef.current === target) {
      setByMessageId((prev) => {
        const next = new Map(prev);
        next.set(messageId, row);
        return next;
      });
    }
    return row;
  }, []);

  const remove = useCallback(async (messageId: string) => {
    const target = sessionRef.current;
    if (!target) return;
    await api.sessionFeedback.remove(target, messageId);
    if (sessionRef.current === target) {
      setByMessageId((prev) => {
        if (!prev.has(messageId)) return prev;
        const next = new Map(prev);
        next.delete(messageId);
        return next;
      });
    }
  }, []);

  return { byMessageId, submit, remove };
}
