import assert from 'node:assert/strict';

import { afterEach, describe, test } from 'vitest';

import {
  CLOCK_SAMPLE_WINDOW_MS,
  addClockSample,
  estimateClockOffset,
  hasServerClockSample,
  observeServerTime,
  resetServerClockForTest,
  serverNow,
} from './serverClock';
import { computeMerged, streamCommitTimestamp } from './useSessionStore';
import type { NormalizedMessage } from './useSessionStore';

/**
 * 前端自己造的行(本地回声、流式收尾的正文)按服务器时钟打戳。
 *
 * 实时帧带服务器时间,这些行要和它们按时间戳混排。浏览器表快 / 慢的时候直接用浏览器时间,
 * 本轮提问会排到本轮工具行下面(快)或插进上一轮中间(慢)。
 */
const at = (iso: string) => Date.parse(iso);

afterEach(() => resetServerClockForTest());

describe('偏差估计', () => {
  test('没有样本时按 0 算(与不校正一样)', () => {
    assert.equal(estimateClockOffset([], at('2026-10-07T10:00:00.000Z')), 0);
    assert.equal(serverNow(1000), 1000);
  });

  test('取时间窗内的最大值:传输耗时只会让样本偏小', () => {
    const now = at('2026-10-07T10:00:10.000Z');
    const samples = [
      { offsetMs: -60_300, at: now - 5_000 },
      { offsetMs: -60_050, at: now - 3_000 },
      { offsetMs: -61_000, at: now - 1_000 },
    ];
    assert.equal(estimateClockOffset(samples, now), -60_050);
  });

  test('时间窗外的旧样本不算(浏览器时钟被调过之后要跟得上)', () => {
    const now = at('2026-10-07T10:30:00.000Z');
    const samples = [
      { offsetMs: 5_000, at: now - CLOCK_SAMPLE_WINDOW_MS - 1 },
      { offsetMs: -200, at: now - 1_000 },
    ];
    assert.equal(estimateClockOffset(samples, now), -200);
  });

  test('样本条数有上限,旧的先丢', () => {
    let samples: ReturnType<typeof addClockSample> = [];
    const base = at('2026-10-07T10:00:00.000Z');
    for (let i = 0; i < 100; i += 1) samples = addClockSample(samples, { offsetMs: i, at: base + i }, base + i);
    assert.ok(samples.length <= 32);
    assert.equal(samples[samples.length - 1].offsetMs, 99);
  });

  test('observeServerTime 解析不了的时间戳直接忽略', () => {
    observeServerTime('not-a-date', 1000);
    observeServerTime(undefined, 1000);
    assert.equal(serverNow(2000), 2000);
    assert.equal(hasServerClockSample(2000), false);
  });

  test('hasServerClockSample:有过样本就算,窗外的也算(估计会沿用;回声据此决定要不要标 clockUnsynced)', () => {
    const now = at('2026-10-07T10:00:00.000Z');
    assert.equal(hasServerClockSample(now), false);
    observeServerTime('2026-10-07T09:59:00.000Z', now);
    assert.equal(hasServerClockSample(now + 1_000), true);
    assert.equal(hasServerClockSample(now + CLOCK_SAMPLE_WINDOW_MS + 1), true);
  });

  test('窗内没有新样本时沿用最后一次的估计,不归零(长回合里隔一阵子再插话)', () => {
    const sampledAt = at('2026-10-07T10:00:00.000Z');
    // 浏览器表快 60 秒:服务器 09:59:00 发的帧,浏览器在自己的 10:00:00 收到
    observeServerTime('2026-10-07T09:59:00.000Z', sampledAt);
    const twentyMinutesLater = sampledAt + 20 * 60 * 1000;
    assert.equal(serverNow(twentyMinutesLater), twentyMinutesLater - 60_000);
    assert.equal(estimateClockOffset([{ offsetMs: -60_000, at: sampledAt }], twentyMinutesLater), -60_000);
  });

  test('沿用的是最后一个样本当时的估计(那一刻窗内的最大值),不是更早的旧值', () => {
    const t0 = at('2026-10-07T10:00:00.000Z');
    const samples = [
      { offsetMs: 9_000, at: t0 - CLOCK_SAMPLE_WINDOW_MS - 60_000 }, // 早于最后一个样本一个窗以上,不算
      { offsetMs: -60_400, at: t0 - 2_000 },
      { offsetMs: -60_050, at: t0 },
    ];
    assert.equal(estimateClockOffset(samples, t0 + 30 * 60 * 1000), -60_050);
  });
});

describe('浏览器时钟比服务器快 60 秒', () => {
  const row = (id: string, kind: string, role: string | undefined, timestamp: string, extra: Partial<NormalizedMessage> = {}) =>
    ({ id, sessionId: 's1', provider: 'claude', kind, role, content: id, timestamp, ...extra }) as NormalizedMessage;

  test('按服务器时钟打戳的本地回声排在本轮工具行前面', () => {
    // 上一条 chat_ack:服务器 10:00:20 发出,浏览器在它自己的 10:01:20 收到
    observeServerTime('2026-10-07T10:00:20.000Z', at('2026-10-07T10:01:20.000Z'));
    // 真实发送时刻 = 服务器 10:00:30,浏览器表此刻是 10:01:30
    const echoTimestamp = new Date(serverNow(at('2026-10-07T10:01:30.000Z'))).toISOString();
    assert.equal(echoTimestamp, '2026-10-07T10:00:30.000Z');

    const server = [
      row('srv_u0', 'text', 'user', '2026-10-07T10:00:00.000Z'),
      row('srv_a0', 'text', 'assistant', '2026-10-07T10:00:10.000Z'),
    ];
    const realtime = [
      row('local_u1', 'text', 'user', echoTimestamp, { clientMessageId: 'cmid-1' }),
      row('rt_tool', 'tool_use', 'assistant', '2026-10-07T10:00:35.000Z', { toolId: 't1' }),
      row('rt_res', 'tool_result', undefined, '2026-10-07T10:00:40.000Z', { toolId: 't1' }),
    ];
    assert.deepEqual(
      computeMerged(server, realtime).map((m) => m.id),
      ['srv_u0', 'srv_a0', 'local_u1', 'rt_tool', 'rt_res'],
    );
  });

  test('流式收尾的正文优先用触发它的那一帧上的服务器时间', () => {
    assert.equal(
      streamCommitTimestamp('2026-10-07T10:00:41.000Z', at('2026-10-07T10:01:41.500Z')),
      '2026-10-07T10:00:41.000Z',
    );
  });

  test('帧上没有时间时退回"浏览器时间 + 偏差"', () => {
    observeServerTime('2026-10-07T10:00:20.000Z', at('2026-10-07T10:01:20.000Z'));
    assert.equal(
      streamCommitTimestamp(undefined, at('2026-10-07T10:01:41.000Z')),
      '2026-10-07T10:00:41.000Z',
    );
  });
});
