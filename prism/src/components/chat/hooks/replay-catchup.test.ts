import { describe, expect, it } from 'vitest';

import { needsReplayCatchUp } from './useChatRealtimeHandlers';

/**
 * F17:冷订阅也要判"回放够不够把这一轮补齐"。
 *
 * 服务端的重放从缓冲现有的第一条开始发,而缓冲会按条数/字节被裁。
 * fj 那版判据要求"游标属于同一轮"—— 也就是**必须已经收过这一轮的帧**,
 * 于是两种最常见的冷情况整个漏掉:回合在别的标签页/定时任务里起的(没有游标)、
 * 上一轮看完了新一轮在我们没看时起的(游标属于上一轮)。
 * 那两种情况下我们对这一轮一帧都没有,缓冲若已裁掉开头就永远补不回来。
 */
describe('needsReplayCatchUp', () => {
  it('没在跑 → 不补(空闲会话没有回放可言)', () => {
    expect(needsReplayCatchUp(false, 20, undefined, 'run-1')).toBe(false);
  });

  it('服务端没报缓冲位置 → 不猜', () => {
    expect(needsReplayCatchUp(true, null, undefined, 'run-1')).toBe(false);
  });

  describe('有游标、同一轮(fj 已经覆盖的情形)', () => {
    it('缓冲接得上游标 → 不补', () => {
      expect(needsReplayCatchUp(true, 11, { runId: 'run-1', seq: 10 }, 'run-1')).toBe(false);
      // 重叠也接得上
      expect(needsReplayCatchUp(true, 5, { runId: 'run-1', seq: 10 }, 'run-1')).toBe(false);
    });

    it('缓冲的第一条比游标还靠后 → 中间那段没了,补', () => {
      expect(needsReplayCatchUp(true, 12, { runId: 'run-1', seq: 10 }, 'run-1')).toBe(true);
    });
  });

  describe('冷订阅:压根没有游标', () => {
    it('缓冲还留着这一轮的第一帧 → 回放能补齐,不用拉', () => {
      expect(needsReplayCatchUp(true, 0, undefined, 'run-1')).toBe(false);
    });

    it('缓冲已经裁掉开头 → **补**(fj 那版在这里什么都不做)', () => {
      expect(needsReplayCatchUp(true, 1, undefined, 'run-1')).toBe(true);
      expect(needsReplayCatchUp(true, 300, undefined, 'run-1')).toBe(true);
    });
  });

  describe('冷订阅:游标属于上一轮', () => {
    it('新一轮的缓冲从头开始 → 不用拉', () => {
      expect(needsReplayCatchUp(true, 0, { runId: 'run-1', seq: 400 }, 'run-2')).toBe(false);
    });

    it('新一轮的开头已经被裁掉 → **补**', () => {
      // 旧游标的 seq(400)完全不能用来判新一轮 —— 按它算会以为"早就覆盖过了"。
      expect(needsReplayCatchUp(true, 30, { runId: 'run-1', seq: 400 }, 'run-2')).toBe(true);
    });
  });

  it('ack 没带 runId 而游标有 → 当作不同轮处理(宁可多拉一次)', () => {
    expect(needsReplayCatchUp(true, 30, { runId: 'run-1', seq: 400 }, null)).toBe(true);
  });
});
