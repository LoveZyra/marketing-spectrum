import { describe, expect, it } from 'vitest';

import { dailyCost } from './nightly';
import type { Job } from './types';

/** he:总览的每日费用 —— 按作业创建日(本地时间)累加,只算训练;没作业的日子也占一格。 */
const job = (created: Date, extra: Partial<Job> = {}): Job => ({
  id: 'j', kind: 'train', skill: 's', args: {}, tags: [], state: 'done', created_at: created.toISOString(), ...extra,
});

describe('dailyCost', () => {
  it('14 格、按天累加、夜训单独计数、非训练作业不算', () => {
    const now = new Date(2026, 8, 24, 12, 0);
    const rows = dailyCost([
      job(new Date(2026, 8, 24, 3, 0), { cost_usd: 0.1, origin: 'nightly' }),
      job(new Date(2026, 8, 24, 9, 0), { cost_usd: 0.25 }),
      job(new Date(2026, 8, 20, 9, 0), { cost_usd: null }),
      job(new Date(2026, 8, 24, 9, 0), { kind: 'harvest', cost_usd: 5 }),
      job(new Date(2026, 7, 1, 9, 0), { cost_usd: 9 }),
    ], now);
    expect(rows).toHaveLength(14);
    expect(rows[13]).toMatchObject({ day: '2026-09-24', runs: 2, nightly: 1 });
    expect(rows[13].cost).toBeCloseTo(0.35);
    expect(rows[9]).toMatchObject({ day: '2026-09-20', runs: 1, cost: 0 });
    expect(rows[0].day).toBe('2026-09-11');
  });
});
