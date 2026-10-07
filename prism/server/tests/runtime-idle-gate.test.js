import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { readCompactionIdleTimeout, runtimeIsIdle } from '../claude-sdk.js';

/**
 * "忙不忙"以 CLI 的在途工具为准;压缩阶段另有静默上限。
 *
 * 真正决定会话闲不闲的是 CLI 子进程,而不是 Prism 自己的 `runtime.turn`:回合被中止 / 超时收掉后,
 * 它起的 Bash 可能还在跑。两者一分叉,Prism 推进 stdin 的消息就会排在工具后面,既看不见也取消不掉。
 * 所以 idle 的定义必须把在途工具算进去,而且这个判据要是全链路唯一的一份。
 */
describe('runtimeIsIdle', () => {
  const clean = () => ({ turn: null, disposed: false, pendingToolUses: new Set() });

  test('没有回合、没有在途工具 = 闲', () => {
    assert.equal(runtimeIsIdle(clean()), true);
  });

  test('有回合 = 忙', () => {
    assert.equal(runtimeIsIdle({ ...clean(), turn: {} }), false);
  });

  test('回合没了但工具还在途 = 仍然忙', () => {
    const runtime = { ...clean(), pendingToolUses: new Set(['toolu_01']) };
    assert.equal(runtime.turn, null, '前提:Prism 这边确实已经没有回合了');
    assert.equal(runtimeIsIdle(runtime), false, '但 CLI 还在跑那条 Bash,不能往它嘴里塞消息');
  });

  test('工具回来了就重新变闲 —— 集合活在 runtime 上,所以清得掉', () => {
    const runtime = { ...clean(), pendingToolUses: new Set(['toolu_01']) };
    runtime.pendingToolUses.delete('toolu_01');
    assert.equal(runtimeIsIdle(runtime), true);
  });

  test('CLI 自己发起的一轮开着(orphanTurnOpen)= 忙', () => {
    assert.equal(runtimeIsIdle({ ...clean(), orphanTurnOpen: true }), false);
    assert.equal(runtimeIsIdle({ ...clean(), orphanTurnOpen: false }), true);
  });

  test('已丢弃的 runtime 不算闲', () => {
    assert.equal(runtimeIsIdle({ ...clean(), disposed: true }), false);
  });

  test('空值不算闲(别让调用方自己判 null)', () => {
    assert.equal(runtimeIsIdle(null), false);
    assert.equal(runtimeIsIdle(undefined), false);
  });
});

describe('压缩阶段的静默上限', () => {
  test('默认 15 分钟 —— 远小于用户回合的一小时 idle(压缩期间无保活帧,太小会死循环)', () => {
    const ms = readCompactionIdleTimeout({});
    assert.equal(ms, 15 * 60 * 1000);
    assert.ok(ms < 60 * 60 * 1000, '压缩不该按"跑一小时的 SQL"来容忍');
  });

  test('可以用环境变量覆盖;0 = 关闭', () => {
    assert.equal(readCompactionIdleTimeout({ PRISM_COMPACT_TIMEOUT_MS: '120000' }), 120000);
    assert.equal(readCompactionIdleTimeout({ PRISM_COMPACT_TIMEOUT_MS: '0' }), 0);
  });

  test('填了废值回落到默认,而不是变成 0(0 等于把上限关了)', () => {
    assert.equal(readCompactionIdleTimeout({ PRISM_COMPACT_TIMEOUT_MS: 'abc' }), 15 * 60 * 1000);
    assert.equal(readCompactionIdleTimeout({ PRISM_COMPACT_TIMEOUT_MS: '' }), 15 * 60 * 1000);
  });

  test('gt 之后没有独立的维护回合:旧的 readMaintenanceWatchdogConfig 已删', async () => {
    const mod = await import('../claude-sdk.js');
    assert.equal(typeof mod.readMaintenanceWatchdogConfig, 'undefined');
  });
});

describe('空闲回收器的判据', () => {
  test('被某次发送领走、还没开跑(claimedAt 未过期)的不回收;预占过期后照常回收', async () => {
    const { runtimeReapable } = await import('../claude-sdk.js');
    assert.equal(typeof runtimeReapable, 'function');
    const now = Date.now();
    const idle = () => ({ turn: null, disposed: false, pendingToolUses: new Set(), lastUsed: now - 31 * 60 * 1000 });
    assert.equal(runtimeReapable(idle(), now), true, '空闲超过 30 分钟:回收');
    assert.equal(runtimeReapable({ ...idle(), claimedAt: now - 1000 }, now), false, '刚被领走:不回收');
    assert.equal(runtimeReapable({ ...idle(), claimedAt: now - 31_000 }, now), true, '预占过期:照常回收');
    assert.equal(runtimeReapable({ ...idle(), lastUsed: now - 60_000 }, now), false, '没闲够:不回收');
    // 僵尸兜底(24 小时没动静)同样认预占
    const zombie = { ...idle(), orphanTurnOpen: true, lastUsed: now - 25 * 60 * 60 * 1000 };
    assert.equal(runtimeReapable(zombie, now), true);
    assert.equal(runtimeReapable({ ...zombie, claimedAt: now - 1000 }, now), false);
  });
});
