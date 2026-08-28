import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { classifyCompactError, isCompactCommand } from '../claude-sdk.js';

/**
 * 用户手打的 `/compact` 不走 `/api/commands/execute` —— 前端把 CLI 自带的斜杠
 * 命令当提示词直接发出去,所以它就是一个普通回合。认出它是为了两件事:
 * 进度条按回车就点亮(不用干等 CLI 的 status 帧),以及 trigger 标成 manual。
 */
describe('isCompactCommand', () => {
  test('认出用户手打的 /compact', () => {
    assert.equal(isCompactCommand('/compact'), true);
    assert.equal(isCompactCommand('  /compact'), true);
    assert.equal(isCompactCommand('/compact 只保留结论'), true);
  });

  test('不误伤别的斜杠命令和普通消息', () => {
    assert.equal(isCompactCommand('/compactify'), false);
    assert.equal(isCompactCommand('/clear'), false);
    assert.equal(isCompactCommand('帮我 /compact 一下'), false);
    assert.equal(isCompactCommand(''), false);
    assert.equal(isCompactCommand(null), false);
    assert.equal(isCompactCommand(undefined), false);
  });
});

/**
 * CLI 报的 `compact_result: 'failed'` 不全是失败 —— 它自己就把「对话太短」和
 * 「用户中止」排除在错误通知之外。照搬这条规则,否则一次无害的空操作会显示成
 * 「压缩失败,下一轮将带着未压缩的上下文继续」,看起来像出了事。
 */
describe('classifyCompactError', () => {
  test('对话太短 = 空操作,不是失败', () => {
    assert.equal(classifyCompactError(new Error('Not enough messages to compact.')), 'noop');
    assert.equal(classifyCompactError('Not enough messages to compact.'), 'noop');
  });

  test('用户中止 = 取消,不是失败', () => {
    assert.equal(classifyCompactError(new Error('API Error: Request was aborted.')), 'aborted');
    assert.equal(classifyCompactError(new Error('Compaction canceled.')), 'aborted');
  });

  test('别的才是真失败', () => {
    assert.equal(
      classifyCompactError(new Error('Compaction interrupted \u00b7 This may be due to network issues')),
      'failed',
    );
    assert.equal(classifyCompactError(new Error('turn exceeded the absolute cap of 3s')), 'failed');
    assert.equal(classifyCompactError(null), 'failed');
    assert.equal(classifyCompactError(undefined), 'failed');
  });
});
