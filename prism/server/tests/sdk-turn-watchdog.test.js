import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { collectToolUseDelta, readTurnWatchdogConfig } from '../claude-sdk.js';

/**
 * 回合看门狗的两条规则(2026-08-19 根治"长 SQL 被 60 分钟绝对墙钟误杀"):
 * 1. 静默看门狗默认 60 分钟、可关;绝对上限默认关、老配置照旧生效;
 * 2. 在途工具跟踪:tool_use 记开始、tool_result 记结束 —— 工具执行期间的
 *    流上静默不判死。
 */

describe('readTurnWatchdogConfig', () => {
  test('默认:idle 60 分钟,绝对上限关,工具在途硬顶 24 小时', () => {
    assert.deepEqual(readTurnWatchdogConfig({}), {
      idleMs: 60 * 60 * 1000,
      absoluteMs: 0,
      toolSilenceMaxMs: 24 * 60 * 60 * 1000,
    });
  });

  test('工具在途硬顶可调可关', () => {
    assert.equal(readTurnWatchdogConfig({ PRISM_TURN_TOOL_SILENCE_MAX_MS: '3600000' }).toolSilenceMaxMs, 3600000);
    assert.equal(readTurnWatchdogConfig({ PRISM_TURN_TOOL_SILENCE_MAX_MS: '0' }).toolSilenceMaxMs, 0);
  });

  test('老部署配的 PRISM_TURN_TIMEOUT_MS 继续作为绝对上限生效', () => {
    const config = readTurnWatchdogConfig({ PRISM_TURN_TIMEOUT_MS: '10800000' });
    assert.equal(config.absoluteMs, 10800000);
    assert.equal(config.idleMs, 60 * 60 * 1000);
  });

  test('idle 可调可关;非法值回默认', () => {
    assert.equal(readTurnWatchdogConfig({ PRISM_TURN_IDLE_TIMEOUT_MS: '60000' }).idleMs, 60000);
    assert.equal(readTurnWatchdogConfig({ PRISM_TURN_IDLE_TIMEOUT_MS: '0' }).idleMs, 0);
    assert.equal(readTurnWatchdogConfig({ PRISM_TURN_IDLE_TIMEOUT_MS: 'abc' }).idleMs, 60 * 60 * 1000);
    assert.equal(readTurnWatchdogConfig({ PRISM_TURN_TIMEOUT_MS: '-5' }).absoluteMs, 0);
  });
});

describe('collectToolUseDelta', () => {
  test('assistant 的 tool_use 记开始,user 的 tool_result 记结束', () => {
    const start = collectToolUseDelta({
      type: 'assistant',
      message: { role: 'assistant', content: [
        { type: 'text', text: '跑一下' },
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
      ] },
    });
    assert.deepEqual(start, { adds: ['toolu_1'], removes: [] });

    const end = collectToolUseDelta({
      type: 'user',
      message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' },
      ] },
    });
    assert.deepEqual(end, { adds: [], removes: ['toolu_1'] });
  });

  test('字符串 content / 无 message / 残缺条目都安全返回空', () => {
    assert.deepEqual(collectToolUseDelta({ message: { content: 'hi' } }), { adds: [], removes: [] });
    assert.deepEqual(collectToolUseDelta({ type: 'result' }), { adds: [], removes: [] });
    assert.deepEqual(
      collectToolUseDelta({ message: { content: [{ type: 'tool_use' }, null, { type: 'tool_result' }] } }),
      { adds: [], removes: [] },
    );
  });
});
