import { describe, expect, test } from 'vitest';

import {
  COMPACTION_SLOW_FALLBACK_MS,
  COMPACTION_STALL_MS,
  beatIsStale,
  compactionTone,
  formatDuration,
  formatTokens,
  freedRatio,
  isCompactionActivity,
  isTerminalCompactionPhase,
  runningLongerThanUsual,
  type CompactionActivity,
} from './compactionProgress';

const running: CompactionActivity = { phase: 'running', trigger: 'maintenance', blocking: false };

describe('isCompactionActivity', () => {
  test('认三个阶段', () => {
    expect(isCompactionActivity({ phase: 'running' })).toBe(true);
    expect(isCompactionActivity({ phase: 'done' })).toBe(true);
    expect(isCompactionActivity({ phase: 'failed' })).toBe(true);
  });

  test('认 skipped(对话太短 / 用户中止)', () => {
    expect(isCompactionActivity({ phase: 'skipped' })).toBe(true);
  });

  test('别的一律不认(压缩结束后的普通状态帧不能被当成压缩)', () => {
    expect(isCompactionActivity(null)).toBe(false);
    expect(isCompactionActivity(undefined)).toBe(false);
    expect(isCompactionActivity({ phase: 'queued' })).toBe(false);
    expect(isCompactionActivity('running')).toBe(false);
  });
});

describe('freedRatio', () => {
  test('218K → 46K 释放 79%', () => {
    expect(Math.round((freedRatio(218_000, 46_000) as number) * 100)).toBe(79);
  });

  test('CLI 没给全就不显示 —— 宁可不说,不编', () => {
    expect(freedRatio(218_000, null)).toBeNull();
    expect(freedRatio(null, 46_000)).toBeNull();
    expect(freedRatio(undefined, undefined)).toBeNull();
  });

  test('压完反而更大 / 没变:不报一个负数或 0%', () => {
    expect(freedRatio(1000, 1200)).toBeNull();
    expect(freedRatio(1000, 1000)).toBeNull();
  });
});

describe('runningLongerThanUsual', () => {
  test('有上次耗时:超过 1.5 倍才算久', () => {
    expect(runningLongerThanUsual(50_000, 40_000)).toBe(false);
    expect(runningLongerThanUsual(70_000, 40_000)).toBe(true);
  });

  test('上次特别快时不会一开始就报警(至少 30 秒的地板)', () => {
    expect(runningLongerThanUsual(10_000, 2_000)).toBe(false);
    expect(runningLongerThanUsual(31_000, 2_000)).toBe(true);
  });

  test('没有参照就用绝对阈值', () => {
    expect(runningLongerThanUsual(COMPACTION_SLOW_FALLBACK_MS - 1, null)).toBe(false);
    expect(runningLongerThanUsual(COMPACTION_SLOW_FALLBACK_MS + 1, null)).toBe(true);
  });

  test('还没开始计时不算久', () => {
    expect(runningLongerThanUsual(0, 1_000)).toBe(false);
  });
});

describe('beatIsStale', () => {
  test('心跳停了超过阈值 = CLI 哑火', () => {
    expect(beatIsStale(1_000, 1_000 + COMPACTION_STALL_MS)).toBe(true);
    expect(beatIsStale(1_000, 1_000 + COMPACTION_STALL_MS - 1)).toBe(false);
  });

  test('还没收到过心跳时不判失联(刚开始压,CLI 还没吐东西)', () => {
    expect(beatIsStale(0, 999_999)).toBe(false);
  });
});

describe('compactionTone', () => {
  test('正常跑着', () => {
    expect(compactionTone(running, 5_000, 10_000, 12_000)).toBe('running');
  });

  test('比平常久', () => {
    expect(compactionTone({ ...running, lastDurationMs: 20_000 }, 90_000, 12_000, 12_500)).toBe('slow');
  });

  test('心跳停了优先于"比平常久" —— 失联是更强的事实', () => {
    const tone = compactionTone({ ...running, lastDurationMs: 20_000 }, 90_000, 1_000, 1_000 + COMPACTION_STALL_MS);
    expect(tone).toBe('stalled');
  });

  test('阈值跟着服务端给的看门狗预算走,不用本地兜底值', () => {
    const slowCli = { ...running, stallAfterMs: 120_000 };
    // 本地兜底是 45s;服务端说 120s,那么 60s 没心跳还不算失联。
    expect(compactionTone(slowCli, 60_000, 1_000, 61_000)).toBe('running');
    expect(compactionTone(slowCli, 60_000, 1_000, 121_001)).toBe('stalled');
  });

  test('结束态不再看心跳', () => {
    expect(compactionTone({ ...running, phase: 'done' }, 90_000, 0, 0)).toBe('done');
    expect(compactionTone({ ...running, phase: 'failed' }, 90_000, 0, 0)).toBe('failed');
  });

  test('skipped 独立成一态 —— 不能落到 failed 上', () => {
    const skipped = { ...running, phase: 'skipped' as const, skipReason: 'too-short' as const };
    expect(compactionTone(skipped, 0, 0, 0)).toBe('skipped');
  });
});

describe('formatTokens / formatDuration', () => {
  test('token 计数与用量芯片同一套口径', () => {
    expect(formatTokens(218_000)).toBe('218K');
    expect(formatTokens(46_000)).toBe('46K');
    expect(formatTokens(1_200)).toBe('1.2K');
    expect(formatTokens(1_400_000)).toBe('1.4M');
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(null)).toBe('0');
  });

  test('耗时', () => {
    expect(formatDuration(38_000)).toBe('38s');
    expect(formatDuration(134_000)).toBe('2m14s');
    expect(formatDuration(null)).toBe('');
  });

  test('不足一秒不显示 —— 空操作后面挂个「0s」是纯噪声', () => {
    expect(formatDuration(0)).toBe('');
    expect(formatDuration(120)).toBe('');
    expect(formatDuration(1_000)).toBe('1s');
  });
});

/**
 * 终态需要自己会过期:CLI 原生压缩是压完**继续答这一轮**的,那条路上活动状态
 * 一直活着、没有任何帧会来覆盖它 —— 不给终态上计时器,结果行就会一路挂在
 * 正式回答下面直到回合结束。
 */
describe('isTerminalCompactionPhase', () => {
  test('三种终态都算', () => {
    expect(isTerminalCompactionPhase('done')).toBe(true);
    expect(isTerminalCompactionPhase('failed')).toBe(true);
    expect(isTerminalCompactionPhase('skipped')).toBe(true);
  });

  test('running 和缺席不算', () => {
    expect(isTerminalCompactionPhase('running')).toBe(false);
    expect(isTerminalCompactionPhase(null)).toBe(false);
    expect(isTerminalCompactionPhase(undefined)).toBe(false);
  });
});
