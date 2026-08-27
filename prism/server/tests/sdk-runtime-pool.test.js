import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { getRuntimePoolStats, setRuntimeEvictionNotifier } from '../claude-sdk.js';

/**
 * G1:常驻池的可观测面(F6 管理面读的就是它)与被挤掉时的通知钩子(F14)。
 *
 * 池子本身要起真的 Claude 子进程,单测里碰不了;但**读它的那两个出口**是纯粹的
 * 形状与接线问题,而形状错了管理面就会显示假数字,钩子错了就没人知道自己的
 * 会话被回收过。
 */
describe('getRuntimePoolStats', () => {
  test('空池给出的是一份完整可读的形状,而不是半个对象', () => {
    const stats = getRuntimePoolStats();

    assert.equal(typeof stats.max, 'number');
    assert.ok(stats.max > 0, 'max 必须是真实上限,不能是 0(界面会显示 0/0)');
    assert.equal(stats.size, 0);
    assert.equal(stats.busy, 0);
    assert.equal(stats.idle, 0);
    assert.equal(typeof stats.idleReapMs, 'number');
    assert.deepEqual(stats.byOwner, []);
  });

  test('size = busy + idle —— 面板上这三个数必须自洽', () => {
    const stats = getRuntimePoolStats();
    assert.equal(stats.size, stats.busy + stats.idle);
  });

  test('溢出槽的形状齐全(active 与 max 都在)', () => {
    const { oneShotOverflow } = getRuntimePoolStats();
    assert.equal(typeof oneShotOverflow.active, 'number');
    assert.equal(typeof oneShotOverflow.max, 'number');
    assert.ok(oneShotOverflow.active <= oneShotOverflow.max || oneShotOverflow.max === 0);
  });
});

describe('setRuntimeEvictionNotifier', () => {
  test('接受函数,也接受 null(注销);传别的东西当作注销而不是崩', () => {
    assert.doesNotThrow(() => setRuntimeEvictionNotifier(() => {}));
    assert.doesNotThrow(() => setRuntimeEvictionNotifier(null));
    assert.doesNotThrow(() => setRuntimeEvictionNotifier('not a function'));
    assert.doesNotThrow(() => setRuntimeEvictionNotifier(undefined));
  });
});
