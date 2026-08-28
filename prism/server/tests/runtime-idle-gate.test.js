import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { readMaintenanceWatchdogConfig, runtimeIsIdle } from '../claude-sdk.js';

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

  test('已丢弃的 runtime 不算闲', () => {
    assert.equal(runtimeIsIdle({ ...clean(), disposed: true }), false);
  });

  test('空值不算闲(别让调用方自己判 null)', () => {
    assert.equal(runtimeIsIdle(null), false);
    assert.equal(runtimeIsIdle(undefined), false);
  });
});

describe('维护回合的预算', () => {
  test('默认 idle 90s / 绝对上限 5 分钟', () => {
    const budget = readMaintenanceWatchdogConfig({});
    assert.equal(budget.idleMs, 90 * 1000, 'idle 要盖得住接近满窗时的首字延迟');
    assert.equal(budget.absoluteMs, 5 * 60 * 1000, '压缩跑过 5 分钟就不该再等了');
  });

  test('和用户回合的预算不是一套 —— 用户回合 idle 一小时、绝对上限默认关闭', () => {
    const budget = readMaintenanceWatchdogConfig({});
    assert.ok(budget.idleMs < 60 * 60 * 1000, '压缩不该按"跑一小时的 SQL"来容忍');
    assert.ok(budget.absoluteMs > 0, '维护回合必须有绝对上限,否则卡住没人管');
  });

  test('维护回合不留工具静默这一档 —— 它本就不该有工具在途', () => {
    assert.equal(readMaintenanceWatchdogConfig({}).toolSilenceMaxMs, 0);
  });

  test('可以用环境变量覆盖', () => {
    const budget = readMaintenanceWatchdogConfig({
      PRISM_COMPACT_IDLE_TIMEOUT_MS: '30000',
      PRISM_COMPACT_TIMEOUT_MS: '120000',
    });
    assert.equal(budget.idleMs, 30000);
    assert.equal(budget.absoluteMs, 120000);
  });

  test('填了废值回落到默认,而不是变成 0(0 等于把看门狗关了)', () => {
    const budget = readMaintenanceWatchdogConfig({
      PRISM_COMPACT_IDLE_TIMEOUT_MS: 'abc',
      PRISM_COMPACT_TIMEOUT_MS: '',
    });
    assert.equal(budget.idleMs, 90 * 1000);
    assert.equal(budget.absoluteMs, 5 * 60 * 1000);
  });
});
