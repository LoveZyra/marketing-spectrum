import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { readCompactionIdleTimeout, runtimeIsIdle } from '../claude-sdk.js';

/**
 * db:"忙不忙"以 CLI 的在途工具为准,以及维护回合的独立预算。
 *
 * 事故:界面显示"正在压缩"转了二十分钟,任务却还在跑,而且按不停。根因是
 * Prism 用自己的 `runtime.turn` 判断会话闲不闲,而真正决定的是 CLI 子进程 ——
 * 回合被中止/超时收掉后,它起的 Bash 还在跑。两者一分叉,Prism 就把 /compact
 * 推进一个还在忙的 CLI 的 stdin,那条消息排在工具后面,既看不见也取消不掉。
 *
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

  test('**回合没了但工具还在途 = 仍然忙** —— 这条就是事故的根因', () => {
    const runtime = { ...clean(), pendingToolUses: new Set(['toolu_01']) };
    assert.equal(runtime.turn, null, '前提:Prism 这边确实已经没有回合了');
    assert.equal(runtimeIsIdle(runtime), false, '但 CLI 还在跑那条 Bash,不能往它嘴里塞消息');
  });

  test('工具回来了就重新变闲 —— 集合活在 runtime 上,所以清得掉', () => {
    const runtime = { ...clean(), pendingToolUses: new Set(['toolu_01']) };
    runtime.pendingToolUses.delete('toolu_01');
    assert.equal(runtimeIsIdle(runtime), true);
  });

  test('hl(09-24 P2-18):CLI 自己发起的一轮开着(orphanTurnOpen)= 忙', () => {
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

describe('压缩阶段的静默上限(hl 09-24 P2-19)', () => {
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
