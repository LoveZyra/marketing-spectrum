import { describe, test, expect } from 'vitest';

import { computeNextRunAt, toDbUtc } from '@/modules/tasks/services/scheduled-tasks.service.js';

/**
 * cj 回归:定时任务的下一次运行时刻(预设频率,本地时区,注入 from 不摸真钟)。
 */
const fields = (over: Partial<Parameters<typeof computeNextRunAt>[0]>) => ({
  frequency: 'daily' as const,
  run_at_hour: 9,
  run_at_minute: 0,
  run_at_weekday: null,
  run_at_day: null,
  ...over,
});

describe('computeNextRunAt', () => {
  test('manual 永不排程', () => {
    expect(computeNextRunAt(fields({ frequency: 'manual' }), new Date())).toBeNull();
  });

  test('daily:今天时刻未到 → 今天;已过 → 明天', () => {
    const morning = new Date(2026, 7, 26, 8, 0, 0); // 本地 8/26 08:00
    const next1 = computeNextRunAt(fields({}), morning)!;
    expect([next1.getDate(), next1.getHours()]).toEqual([26, 9]);

    const evening = new Date(2026, 7, 26, 10, 0, 0);
    const next2 = computeNextRunAt(fields({}), evening)!;
    expect([next2.getDate(), next2.getHours()]).toEqual([27, 9]);
  });

  test('hourly:下一个整点分钟', () => {
    const at = new Date(2026, 7, 26, 8, 45, 0);
    const next = computeNextRunAt(fields({ frequency: 'hourly', run_at_minute: 30 }), at)!;
    expect([next.getHours(), next.getMinutes()]).toEqual([9, 30]);
  });

  test('weekdays:周五晚 → 下周一', () => {
    // 2026-08-28 是周五
    const fridayNight = new Date(2026, 7, 28, 20, 0, 0);
    const next = computeNextRunAt(fields({ frequency: 'weekdays', run_at_hour: 15, run_at_minute: 30 }), fridayNight)!;
    expect(next.getDay()).toBe(1); // 周一
    expect(next.getDate()).toBe(31);
    expect([next.getHours(), next.getMinutes()]).toEqual([15, 30]);
  });

  test('weekly:指定周三', () => {
    const tuesday = new Date(2026, 7, 25, 12, 0, 0); // 8/25 周二
    const next = computeNextRunAt(fields({ frequency: 'weekly', run_at_weekday: 3 }), tuesday)!;
    expect(next.getDay()).toBe(3);
    expect(next.getDate()).toBe(26);
  });

  test('monthly:本月已过 → 下月同号', () => {
    const late = new Date(2026, 7, 26, 12, 0, 0);
    const next = computeNextRunAt(fields({ frequency: 'monthly', run_at_day: 15 }), late)!;
    expect([next.getMonth(), next.getDate()]).toEqual([8, 15]); // 9/15
  });

  test('toDbUtc 与 sqlite datetime 同形', () => {
    expect(toDbUtc(new Date(Date.UTC(2026, 7, 26, 3, 4, 5)))).toBe('2026-08-26 03:04:05');
  });
});
