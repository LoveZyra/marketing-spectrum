import { useCallback, useState } from 'react';

import type { CompactionActivity } from '../components/chat/utils/compactionProgress';

export interface SessionActivity {
  /** Provider-supplied status line; null renders the default activity label. */
  statusText: string | null;
  /** 状态类别。'compacting' 时指示器换成"正在压缩上下文"的样子。 */
  statusKind?: 'compacting' | null;
  /** 压缩实况(阶段 / 心跳 / pre-post token / 耗时)。见 compactionProgress。 */
  compaction?: CompactionActivity | null;
  canInterrupt: boolean;
  /**
   * When this request was first marked as processing (client clock). Drives
   * the elapsed-time display and the stale `chat_subscribed` idle-ack guard.
   */
  startedAt: number;
}

export type SessionActivityMap = ReadonlyMap<string, SessionActivity>;

export type SessionActivitySnapshot = {
  sessionId: string;
  statusText?: string | null;
  statusKind?: 'compacting' | null;
  compaction?: CompactionActivity | null;
  canInterrupt?: boolean;
  startedAt?: number;
};

export type MarkSessionProcessing = (
  sessionId?: string | null,
  activity?: {
    statusText?: string | null;
    statusKind?: 'compacting' | null;
    compaction?: CompactionActivity | null;
    canInterrupt?: boolean;
  },
) => void;

export type MarkSessionIdle = (
  sessionId?: string | null,
  opts?: { ifStartedBefore?: number },
) => void;

export type SyncProcessingSessions = (
  sessions: readonly SessionActivitySnapshot[],
) => void;

const LOCAL_ACTIVITY_GRACE_MS = 10_000;

/**
 * 压缩帧的等价判定。
 *
 * `beat` **必须**参与比较 —— 心跳的全部意义就是"又跳了一下",它是压缩帧里唯一
 * 会变的字段。漏掉它,连续两帧会被判等价、直接丢掉,界面就退化成一行不动的字,
 * 和卡死长得一模一样。
 */
const compactionsMatch = (
  left: CompactionActivity | null | undefined,
  right: CompactionActivity | null | undefined,
): boolean => {
  if (!left || !right) return !left && !right;
  return left.phase === right.phase
    && left.beat === right.beat
    && left.trigger === right.trigger
    && left.blocking === right.blocking
    && left.preTokens === right.preTokens
    && left.postTokens === right.postTokens
    && left.durationMs === right.durationMs
    && left.error === right.error;
};

const sessionActivityMapsMatch = (
  left: ReadonlyMap<string, SessionActivity>,
  right: ReadonlyMap<string, SessionActivity>,
): boolean => {
  if (left.size !== right.size) {
    return false;
  }

  for (const [sessionId, leftActivity] of left) {
    const rightActivity = right.get(sessionId);
    if (
      !rightActivity
      || leftActivity.statusText !== rightActivity.statusText
      || leftActivity.statusKind !== rightActivity.statusKind
      || !compactionsMatch(leftActivity.compaction, rightActivity.compaction)
      || leftActivity.canInterrupt !== rightActivity.canInterrupt
      || leftActivity.startedAt !== rightActivity.startedAt
    ) {
      return false;
    }
  }

  return true;
};

/**
 * Single source of truth for which sessions are actively processing a
 * request. Everything the chat UI shows (activity indicator, abort
 * availability, status text) is derived from this map; terminal events
 * (`complete`, abort, an authoritative idle subscribe ack) delete the entry
 * atomically. Session ids are always concrete (allocated before the first
 * send), so entries are keyed by real session ids only.
 */
export function useSessionProtection() {
  const [processingSessions, setProcessingSessions] = useState<Map<string, SessionActivity>>(
    new Map(),
  );

  const markSessionProcessing = useCallback<MarkSessionProcessing>((sessionId, activity) => {
    if (!sessionId) {
      return;
    }

    setProcessingSessions((prev) => {
      const existing = prev.get(sessionId);
      const next: SessionActivity = {
        statusText:
          activity?.statusText !== undefined ? activity.statusText : existing?.statusText ?? null,
        statusKind:
          activity?.statusKind !== undefined ? activity.statusKind : existing?.statusKind ?? null,
        compaction:
          activity?.compaction !== undefined ? activity.compaction : existing?.compaction ?? null,
        canInterrupt: activity?.canInterrupt ?? existing?.canInterrupt ?? true,
        startedAt: existing?.startedAt ?? Date.now(),
      };

      if (
        existing
        && existing.statusText === next.statusText
        && existing.statusKind === next.statusKind
        && compactionsMatch(existing.compaction, next.compaction)
        && existing.canInterrupt === next.canInterrupt
      ) {
        return prev;
      }

      const updated = new Map(prev);
      updated.set(sessionId, next);
      return updated;
    });
  }, []);

  const markSessionIdle = useCallback<MarkSessionIdle>((sessionId, opts) => {
    if (!sessionId) {
      return;
    }

    setProcessingSessions((prev) => {
      const existing = prev.get(sessionId);
      if (!existing) {
        return prev;
      }

      // Guard against stale `chat_subscribed` idle acks: if a new request
      // started after the subscribe was sent, the idle ack describes the
      // older request and must not clear the newer one.
      if (opts?.ifStartedBefore !== undefined && existing.startedAt >= opts.ifStartedBefore) {
        return prev;
      }

      const updated = new Map(prev);
      updated.delete(sessionId);
      return updated;
    });
  }, []);

  const syncProcessingSessions = useCallback<SyncProcessingSessions>((sessions) => {
    const now = Date.now();

    setProcessingSessions((prev) => {
      const incoming = new Map<string, SessionActivitySnapshot>();
      for (const session of sessions) {
        if (!session.sessionId) {
          continue;
        }
        incoming.set(session.sessionId, session);
      }

      const updated = new Map<string, SessionActivity>();

      for (const [sessionId, snapshot] of incoming) {
        const existing = prev.get(sessionId);
        const snapshotStartedAt =
          typeof snapshot.startedAt === 'number' && Number.isFinite(snapshot.startedAt) && snapshot.startedAt > 0
            ? snapshot.startedAt
            : undefined;

        updated.set(sessionId, {
          statusText:
            snapshot.statusText !== undefined ? snapshot.statusText : existing?.statusText ?? null,
          // statusKind 必须保留。轮询快照里没有这一项,而它整个不进对象的话就成了
          // undefined —— 于是每 5 秒把「正在压缩上下文」抹回普通转圈;更糟的是
          // 等价比较**把 statusKind 算在内**,所以每次轮询必然判不等、返回新 Map、
          // 触发一次顶层重渲染。
          statusKind: snapshot.statusKind ?? existing?.statusKind ?? null,
          // 同理:轮询快照里没有压缩实况,不带上就会把它抹掉。
          compaction: snapshot.compaction ?? existing?.compaction ?? null,
          canInterrupt: snapshot.canInterrupt ?? existing?.canInterrupt ?? true,
          startedAt: snapshotStartedAt ?? existing?.startedAt ?? now,
        });
      }

      for (const [sessionId, activity] of prev) {
        if (!incoming.has(sessionId) && now - activity.startedAt < LOCAL_ACTIVITY_GRACE_MS) {
          updated.set(sessionId, activity);
        }
      }

      return sessionActivityMapsMatch(prev, updated) ? prev : updated;
    });
  }, []);

  return {
    processingSessions,
    markSessionProcessing,
    markSessionIdle,
    syncProcessingSessions,
  };
}
