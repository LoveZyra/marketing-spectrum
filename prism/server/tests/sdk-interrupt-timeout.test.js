import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { interruptWithTimeout } from '../claude-sdk.js';

// 测试用短超时:核心行为(竞速 + 迟到 reject 吞掉)与生产的 5s 默认一致,
// 只是不必真等 5s。生产默认值另有其人(INTERRUPT_TIMEOUT_MS)保证。
const TEST_TIMEOUT_MS = 200;

/**
 * B4 回归:interrupt() 加超时竞速。
 *
 * "停止"按钮最常按在子进程僵死时,而那正是 interrupt()(与子进程的协商)永不
 * 返回的场景。旧代码直接 await,处理器挂死、终止帧发不出。interruptWithTimeout
 * 到点即放弃,交由调用方升级到硬撕(abortController)。
 */
describe('interruptWithTimeout', () => {
  test('interrupt 及时返回 → 正常 resolve,不触发超时', async () => {
    let called = 0;
    const queryLike = { interrupt: () => { called += 1; return Promise.resolve(); } };
    await interruptWithTimeout(queryLike, 'fast', TEST_TIMEOUT_MS);
    assert.equal(called, 1);
  });

  test('interrupt 永挂 → 在超时上限附近抛出(升级信号)', async () => {
    // interrupt 永不 settle:模拟僵死子进程。
    const queryLike = { interrupt: () => new Promise(() => {}) };
    const start = Date.now();
    await assert.rejects(
      () => interruptWithTimeout(queryLike, 'hung', TEST_TIMEOUT_MS),
      /timed out/,
    );
    const elapsed = Date.now() - start;
    // 必须等到了超时,又远小于"永远"。
    assert.ok(elapsed >= TEST_TIMEOUT_MS - 50, `elapsed=${elapsed} 不该早于超时`);
    assert.ok(elapsed < TEST_TIMEOUT_MS + 2000, `elapsed=${elapsed} 明显超出超时窗口`);
  });

  test('interrupt 迟到的 reject 不外泄为 unhandledRejection', async () => {
    let rejectLate;
    const queryLike = { interrupt: () => new Promise((_resolve, reject) => { rejectLate = reject; }) };

    let unhandled = null;
    const onUnhandled = (reason) => { unhandled = reason; };
    process.on('unhandledRejection', onUnhandled);
    try {
      await assert.rejects(() => interruptWithTimeout(queryLike, 'late-reject', TEST_TIMEOUT_MS), /timed out/);
      // 超时之后原 promise 才姗姗来迟地失败 —— 必须已被内部 catch 接住。
      rejectLate(new Error('late interrupt failure'));
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(unhandled, null, '迟到的 reject 变成了 unhandledRejection');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
