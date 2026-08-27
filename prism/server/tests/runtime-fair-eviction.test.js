import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { orderRuntimesForEviction } from '../claude-sdk.js';

/**
 * F6:常驻池名额满了该淘汰谁。
 *
 * 原来是全局 LRU —— 合理但不公平:一个人开二十个会话就能把池子占满,之后每个
 * 新会话都去挤**别人**那条最久没用的。别人每轮重建 runtime(多一次冷启动),
 * 占了十九个的那位一点代价都没有。
 *
 * 现在先按"谁占得最多"排,再按 LRU。代价落在造成拥挤的人身上。
 */
const runtime = (key, ownerUserId, lastUsed, turn = null) => ({ key, ownerUserId, lastUsed, turn });

describe('orderRuntimesForEviction', () => {
  test('占得最多的那个人先掉,即使他那条比别人的更新', () => {
    const ordered = orderRuntimesForEviction([
      runtime('hog-1', 7, 5_000),
      runtime('hog-2', 7, 6_000),
      runtime('hog-3', 7, 7_000),
      runtime('quiet', 9, 1_000), // 全局 LRU 会先杀这条 —— 而它的主人只占了一个
    ], 'none');

    assert.equal(ordered[0].ownerUserId, 7, '应该先动占三个的那位');
    assert.equal(ordered[0].key, 'hog-1', '同一个人里挑最久没用的');
    assert.equal(ordered.at(-1).key, 'quiet', '只占一个的应该排在最后');
  });

  test('占用相同时退化成 LRU', () => {
    const ordered = orderRuntimesForEviction([
      runtime('a', 1, 9_000),
      runtime('b', 2, 2_000),
      runtime('c', 3, 5_000),
    ], 'none');

    assert.deepEqual(ordered.map((entry) => entry.key), ['b', 'c', 'a']);
  });

  test('在跑的不进候选,但**算**占用 —— 否则跑满的人反而免疫', () => {
    const ordered = orderRuntimesForEviction([
      runtime('busy-1', 7, 1_000, { live: true }),
      runtime('busy-2', 7, 1_100, { live: true }),
      runtime('idle-hog', 7, 8_000),
      runtime('idle-other', 9, 2_000),
    ], 'none');

    assert.ok(!ordered.some((entry) => entry.turn), '在跑的不能被淘汰');
    assert.equal(ordered[0].key, 'idle-hog', '占三个(含两个在跑)的人先掉');
    assert.equal(ordered.length, 2);
  });

  test('exceptKey 永远不在候选里 —— 不能把自己挤掉', () => {
    const ordered = orderRuntimesForEviction([
      runtime('mine', 7, 1_000),
      runtime('other', 7, 2_000),
    ], 'mine');

    assert.deepEqual(ordered.map((entry) => entry.key), ['other']);
  });

  test('无主 runtime(内部调用/未登录)自成一档,不与登录用户混算', () => {
    const ordered = orderRuntimesForEviction([
      runtime('anon-1', null, 5_000),
      runtime('anon-2', null, 6_000),
      runtime('user', 7, 1_000),
    ], 'none');

    assert.equal(ordered[0].key, 'anon-1', '无主那档占了两个,先掉它最久没用的');
    assert.equal(ordered.at(-1).key, 'user');
  });
});
