import { describe, expect, it } from 'vitest';

import type { ProgressEvent } from '../lib/types';
import { currentActivity, groupEvents } from '../lib/process-events';

/** 优化过程的分组:step 与它里面的任务 / 候选收成一行,汇总事件一条一行。 */
let seq = 0;
const ev = (kind: string, extra: Record<string, unknown> = {}): ProgressEvent => ({ seq: ++seq, ts: '2026-09-24T00:00:00Z', kind, ...extra } as ProgressEvent);

describe('groupEvents', () => {
  it('step 收拢任务与候选,汇总事件单独成行', () => {
    seq = 0;
    const events = [
      ev('round_start', { round: 1 }),
      ev('step', { step: 'rollout', round: 1, n: 2, why: 'measure' }),
      ev('task', { step: 'rollout', i: 1, n: 2, task: 'a::t1', passed: true }),
      ev('task', { step: 'rollout', i: 2, n: 2, task: 'a::t2', passed: false, why: 'ZeroDivisionError' }),
      ev('step_end', { step: 'rollout', secs: 1.2, llm_calls: 0, cost_usd: 0 }),
      ev('step', { step: 'fast_loop', round: 1 }),
      ev('proposing', { code_defects: 1, k: 2 }),
      ev('candidate', { i: 1, n: 2, viable: false, stage: 'G4' }),
      ev('candidate', { i: 2, n: 2, viable: true }),
      ev('selected', { origin: 'code' }),
      ev('step_end', { step: 'fast_loop', secs: 30 }),
      ev('gate', { round: 1, accepted: true }),
    ];
    const items = groupEvents(events);
    expect(items.map((x) => (x.kind === 'event' ? x.e.kind : `step:${String(x.start.step)}`))).toEqual(['round_start', 'step:rollout', 'step:fast_loop', 'gate']);
    const rollout = items[1];
    const fast = items[2];
    if (rollout.kind !== 'step' || fast.kind !== 'step') throw new Error('expected steps');
    expect(rollout.tasks).toHaveLength(2);
    expect(rollout.end?.secs).toBe(1.2);
    expect(fast.notes.map((x) => x.kind)).toEqual(['proposing', 'candidate', 'candidate', 'selected']);
  });

  it('嵌套 step 挂在外层下面,它的任务不丢', () => {
    seq = 0;
    const items = groupEvents([
      ev('step', { step: 'slow_loop', round: 1 }),
      ev('step', { step: 'rollout', why: 'after_doc', n: 1 }),
      ev('task', { passed: true, task: 'x' }),
      ev('step_end', { step: 'rollout', secs: 2 }),
      ev('step_end', { step: 'slow_loop', secs: 9 }),
    ]);
    expect(items).toHaveLength(1);
    const g = items[0];
    if (g.kind !== 'step') throw new Error('expected step');
    expect(g.children).toHaveLength(1);
    expect(g.children[0].tasks).toHaveLength(1);
    expect(g.end?.secs).toBe(9);
  });
});

describe('currentActivity', () => {
  it('给出最里层还没收尾的 step、做到第几条、外层是谁', () => {
    seq = 0;
    const events = [
      ev('step', { step: 'baseline', n: 3 }),
      ev('step_end', { step: 'baseline' }),
      ev('step', { step: 'slow_loop' }),
      ev('step', { step: 'rollout', n: 5 }),
      ev('task', { passed: true, task: 'a' }),
      ev('task', { passed: false, task: 'b', why: 'boom' }),
    ];
    const cur = currentActivity(events);
    expect(cur?.step.step).toBe('rollout');
    expect(cur?.done).toBe(2);
    expect(cur?.last?.task).toBe('b');
    expect(cur?.parent?.step).toBe('slow_loop');
  });

  it('全部收尾时没有进行中的步骤', () => {
    seq = 0;
    expect(currentActivity([ev('step', { step: 'staging' }), ev('step_end', { step: 'staging' })])).toBeNull();
  });
});
