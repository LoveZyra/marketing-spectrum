import { describe, expect, it } from 'vitest';

import { advancesReplayCursor } from './useChatRealtimeHandlers';

/**
 * dv:丢帧判定与补发游标是**两条水位**。
 *
 * 服务端给每一帧都分配 seq(含 permission),而补发游标故意不为审批帧推进 ——
 * 用同一个水位判丢帧的话,每弹一次审批就误判一次并触发全量 refresh。
 */
type Frame = { kind: string; seq: number; runId: string };

function simulate(frames: Frame[]) {
  const gapSeq = new Map<string, { runId: string; seq: number }>();
  const cursor = new Map<string, { runId: string; seq: number }>();
  let gapsDetected = 0;
  for (const frame of frames) {
    const seen = gapSeq.get('s');
    const sameSeenRun = seen && seen.runId === frame.runId;
    if (sameSeenRun && frame.seq > seen.seq + 1) gapsDetected += 1;
    if (!sameSeenRun || frame.seq > seen.seq) gapSeq.set('s', { runId: frame.runId, seq: frame.seq });

    if (advancesReplayCursor(frame.kind)) {
      const known = cursor.get('s');
      const sameRun = known && known.runId === frame.runId;
      if (!sameRun || frame.seq > known.seq) cursor.set('s', { runId: frame.runId, seq: frame.seq });
    }
  }
  return { gapsDetected, cursorSeq: cursor.get('s')?.seq ?? 0 };
}

describe('seq 空洞判定', () => {
  it('审批帧占号但不推游标 —— 不该被判成丢帧', () => {
    const result = simulate([
      { kind: 'text', seq: 1, runId: 'r1' },
      { kind: 'permission_request', seq: 2, runId: 'r1' },
      { kind: 'tool_use', seq: 3, runId: 'r1' },
    ]);
    // 修前:tool_use 的 seq 3 对上游标 1 → 误判丢帧
    expect(result.gapsDetected).toBe(0);
    // 补发游标仍然只停在最后一条**留下来的**帧上
    expect(result.cursorSeq).toBe(3);
  });

  it('真的跳号仍然判得出来', () => {
    expect(simulate([
      { kind: 'text', seq: 1, runId: 'r1' },
      { kind: 'text', seq: 5, runId: 'r1' },
    ]).gapsDetected).toBe(1);
  });

  it('换了一轮不算丢帧(seq 每轮从头数)', () => {
    expect(simulate([
      { kind: 'text', seq: 40, runId: 'r1' },
      { kind: 'text', seq: 1, runId: 'r2' },
    ]).gapsDetected).toBe(0);
  });
});
