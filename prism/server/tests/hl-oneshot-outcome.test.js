import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, test, vi } from 'vitest';

/**
 * hl(动态 P1-1):一次性路径 `queryClaudeSDK({ oneShot: true })` 必须把成败**返回**
 * 给调用方 —— 定时任务与外部 Agent API 拿的是 promise,不是 writer 上的帧。
 *
 * baseline-hk:三种情形返回值都是 `undefined`,调用方一律记 completed。
 * SDK 的 `query` 用 vi.mock 换成假的,不起子进程、不花钱。
 */

let scripted = () => { throw new Error('unscripted'); };

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args) => scripted(...args),
}));

const { queryClaudeSDK, describeOneShotResultError } = await import('../claude-sdk.js');

const cwd = mkdtemptSafe();
function mkdtemptSafe() {
  return mkdtempSync(path.join(tmpdir(), 'hl-oneshot-'));
}

function fakeWriter() {
  const frames = [];
  return {
    frames,
    userId: 1,
    send: (frame) => { frames.push(frame); },
    setSessionId: () => {},
  };
}

/** 模拟 SDK 的 async iterable。 */
function stream(messages) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const m of messages) yield m;
    },
    interrupt: async () => {},
    close: () => {},
  };
}

const baseOptions = () => ({
  cwd,
  projectPath: cwd,
  newSessionId: '11111111-2222-4333-8444-555555555555',
  runId: 'run-hl-oneshot',
  permissionMode: 'default',
  oneShot: true,
  usageSource: 'task',
});

describe('describeOneShotResultError', () => {
  test('success 帧 → null;is_error / 非 success subtype → 原因', () => {
    assert.equal(describeOneShotResultError({ type: 'result', subtype: 'success', is_error: false }), null);
    assert.equal(describeOneShotResultError({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 400 model not found' }), 'API Error: 400 model not found');
    assert.equal(describeOneShotResultError({ type: 'result', subtype: 'error_max_turns' }), 'error_max_turns');
    assert.equal(describeOneShotResultError({ type: 'result', subtype: 'error_during_execution', errors: ['a', 'b'] }), 'a; b');
  });
});

describe('queryClaudeSDK 一次性路径的返回值', () => {
  test('result 帧 is_error → { ok:false, exitCode:1, error }', async () => {
    scripted = () => stream([
      { type: 'system', subtype: 'init', session_id: '11111111-2222-4333-8444-555555555555' },
      { type: 'result', subtype: 'success', is_error: true, result: 'API Error: 400 no such model', session_id: '11111111-2222-4333-8444-555555555555' },
    ]);
    const ws = fakeWriter();
    const outcome = await queryClaudeSDK('hi', baseOptions(), ws);
    assert.ok(outcome, 'baseline 这里是 undefined');
    assert.equal(outcome.ok, false);
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.aborted, false);
    assert.match(outcome.error, /no such model/);
    const complete = ws.frames.find((f) => f?.kind === 'complete' || f?.type === 'complete');
    assert.ok(complete, '终止帧照发');
  });

  test('SDK / CLI 抛错 → { ok:false, error } 且不 reject', async () => {
    scripted = () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: '11111111-2222-4333-8444-555555555555' };
        throw new Error('Claude Code process exited with code 1');
      },
      interrupt: async () => {},
      close: () => {},
    });
    const ws = fakeWriter();
    const outcome = await queryClaudeSDK('hi', baseOptions(), ws);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.exitCode, 1);
    assert.match(outcome.error, /exited with code 1/);
    assert.ok(ws.frames.some((f) => f?.kind === 'error'), 'writer 上的 error 帧仍然要有');
  });

  test('正常 result → { ok:true, exitCode:0 }', async () => {
    scripted = () => stream([
      { type: 'system', subtype: 'init', session_id: '11111111-2222-4333-8444-555555555555' },
      { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: '11111111-2222-4333-8444-555555555555' },
    ]);
    const outcome = await queryClaudeSDK('hi', baseOptions(), fakeWriter());
    assert.equal(outcome.ok, true);
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.error, null);
  });
});
