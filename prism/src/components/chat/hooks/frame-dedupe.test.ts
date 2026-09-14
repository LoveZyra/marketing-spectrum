import { describe, expect, it } from 'vitest';

import { advancesReplayCursor, isDuplicateFrame } from './useChatRealtimeHandlers';

/**
 * F16:重复帧不再被处理第二遍。
 *
 * 重复不是异常路径:补发游标**故意**不为审批帧推进,于是重连后的补发窗口
 * 会盖住一批已经收到的帧;订阅重叠时更是整段重放。重复一帧 `stream_delta`
 * 就是把同一段正文再拼一次(累积器是追加语义),重复一帧工具事件就是
 * 屏幕上并排两份 —— 而这两种都要等服务端行落库才收得掉。
 */
describe('isDuplicateFrame', () => {
  it('没有水位(这一轮的第一帧)→ 不是重复', () => {
    expect(isDuplicateFrame(undefined, 'run-1', 0)).toBe(false);
  });

  it('seq 比水位大 → 新帧', () => {
    expect(isDuplicateFrame({ runId: 'run-1', seq: 10 }, 'run-1', 11)).toBe(false);
  });

  it('seq 等于水位 → 重复(补发窗口的边界就落在这里)', () => {
    expect(isDuplicateFrame({ runId: 'run-1', seq: 10 }, 'run-1', 10)).toBe(true);
  });

  it('seq 小于水位 → 重复', () => {
    expect(isDuplicateFrame({ runId: 'run-1', seq: 10 }, 'run-1', 3)).toBe(true);
  });

  it('换了一轮 → seq 从 0 重来,**一律不算重复**', () => {
    // 这一条是关键:seq 是每轮从 0 开始的。只按 seq 判会把新一轮的开头全丢掉。
    expect(isDuplicateFrame({ runId: 'run-1', seq: 40 }, 'run-2', 0)).toBe(false);
    expect(isDuplicateFrame({ runId: 'run-1', seq: 40 }, 'run-2', 20)).toBe(false);
  });

  it('水位属于某一轮、这一帧没有 runId → 不算重复', () => {
    expect(isDuplicateFrame({ runId: 'run-1', seq: 40 }, null, 5)).toBe(false);
  });
});

describe('判重只作用于会推进游标的帧', () => {
  it('审批帧不参与判重 —— 否则 dv 修过的那条又会回来', () => {
    // 审批帧占 seq 号但**故意**不推进补发游标,因此它们的 seq 天然落在水位之下。
    // 若按水位判重,切回会话时的审批请求会被整体丢掉,而那是一条永远回不来的请求。
    expect(advancesReplayCursor('permission_request')).toBe(false);
    expect(advancesReplayCursor('permission_cancelled')).toBe(false);
    expect(advancesReplayCursor('stream_delta')).toBe(true);
    expect(advancesReplayCursor('tool_use')).toBe(true);
  });
});

/**
 * 端到端形状:重连补发盖住已收到的一段。
 */
describe('重连补发的重叠段', () => {
  const applyAll = (frames: Array<{ kind: string; runId: string; seq: number }>) => {
    const watermark = new Map<string, { runId: string | null; seq: number }>();
    const applied: number[] = [];
    for (const f of frames) {
      const seen = watermark.get('s');
      const duplicate = advancesReplayCursor(f.kind) && isDuplicateFrame(seen, f.runId, f.seq);
      if (!seen || seen.runId !== f.runId || f.seq > seen.seq) {
        watermark.set('s', { runId: f.runId, seq: f.seq });
      }
      if (!duplicate) applied.push(f.seq);
    }
    return applied;
  };

  it('补发重叠的三帧只算一次', () => {
    const live = [0, 1, 2, 3, 4].map((seq) => ({ kind: 'stream_delta', runId: 'run-1', seq }));
    // 重连:服务端从 seq=2 起重放(游标没能推到 4)
    const replay = [2, 3, 4, 5].map((seq) => ({ kind: 'stream_delta', runId: 'run-1', seq }));

    expect(applyAll([...live, ...replay])).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('新一轮开始后照常从 0 收', () => {
    const first = [0, 1, 2].map((seq) => ({ kind: 'stream_delta', runId: 'run-1', seq }));
    const second = [0, 1].map((seq) => ({ kind: 'stream_delta', runId: 'run-2', seq }));
    expect(applyAll([...first, ...second])).toEqual([0, 1, 2, 0, 1]);
  });
});
