import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, describe, onTestFinished, test, vi } from 'vitest';

/**
 * 常驻路径的内部错误进聊天时:错误码 + 中文说明(说清楚该怎么办),英文原文只进服务端日志。
 *
 * 静默看门狗的阈值在模块加载时读环境变量,这里先把它调到 300ms 再加载 claude-sdk。
 * SDK 的 `query` 换成一个可以逐帧喂的假进程(同 runtime-send-guards.test.js 的写法,只留用得到的部分)。
 */

process.env.PRISM_TURN_IDLE_TIMEOUT_MS = '300';

const queries = [];

function createFakeQuery(prompt, options) {
  const buffered = [];
  const waiters = [];
  let ended = false;
  const fake = {
    options,
    sessionId: options.resume || `cccccccc-0000-4000-8000-${String(queries.length + 1).padStart(12, '0')}`,
    inputs: [],
    emit(frame) {
      const message = { session_id: fake.sessionId, ...frame };
      if (waiters.length) waiters.shift()({ value: message, done: false });
      else buffered.push(message);
    },
    end() {
      ended = true;
      while (waiters.length) waiters.shift()({ value: undefined, done: true });
    },
    onInput: null,
  };
  fake.onInput = (message) => {
    fake.emit({ type: 'assistant', message: { id: `msg_${fake.inputs.length}`, role: 'assistant', content: [{ type: 'text', text: 'ok' }] } });
    fake.emit({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, user_message_uuid: message.uuid });
  };
  (async () => {
    try {
      for await (const message of prompt) {
        fake.inputs.push(message);
        fake.onInput?.(message, fake);
      }
    } catch { /* 输入流关了 */ }
  })();
  fake.handle = {
    [Symbol.asyncIterator]() { return this; },
    next() {
      if (buffered.length) return Promise.resolve({ value: buffered.shift(), done: false });
      if (ended) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve) => waiters.push(resolve));
    },
    return() {
      ended = true;
      return Promise.resolve({ value: undefined, done: true });
    },
    interrupt: async () => ({}),
    close: () => { fake.end(); },
    setModel: async () => {},
    setPermissionMode: async () => {},
    applyFlagSettings: async () => {},
    getContextUsage: async () => null,
    supportedCommands: async () => [],
    stopTask: async () => {},
  };
  options.abortController?.signal.addEventListener('abort', () => fake.end(), { once: true });
  return fake;
}

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt, options }) => {
    const fake = createFakeQuery(prompt, options);
    queries.push(fake);
    return fake.handle;
  },
}));

const sdk = await import('../claude-sdk.js');
const { queryClaudeSDK, disposeAllRuntimes, getPersistentRuntime } = sdk;

const cwd = mkdtempSync(path.join(tmpdir(), 'prism-error-messages-'));
const { closeConnection, initializeDatabase } = await import('@/modules/database/index.js');
const previousDatabasePath = process.env.DATABASE_PATH;
const dbDir = mkdtempSync(path.join(tmpdir(), 'prism-error-messages-db-'));
closeConnection();
process.env.DATABASE_PATH = path.join(dbDir, 'auth.db');
await initializeDatabase();

afterEach(async () => {
  await disposeAllRuntimes();
});

afterAll(async () => {
  await disposeAllRuntimes();
  closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  delete process.env.PRISM_TURN_IDLE_TIMEOUT_MS;
  rmSync(dbDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

let sessionCounter = 0;
const nextSessionId = () => {
  sessionCounter += 1;
  return `dddddddd-0000-4000-8000-${String(sessionCounter).padStart(12, '0')}`;
};
const writer = () => {
  const frames = [];
  return { frames, userId: 1, send: (frame) => { frames.push(frame); }, setSessionId: () => {} };
};
const errorsOf = (frames) => frames.filter((frame) => frame?.kind === 'error').map((frame) => String(frame.content));
const send = async (sessionId, command = 'hi') => {
  const ws = writer();
  await queryClaudeSDK(command, { cwd, projectPath: cwd, runId: `app-${sessionId}`, permissionMode: 'default', sessionId }, ws);
  return ws.frames;
};
const queryFor = (sessionId) => [...queries].reverse().find((fake) => fake.sessionId === sessionId);
/** 聊天里的这句不能带英文的内部报错(允许 CLI 之类的短缩写)。 */
const assertChineseOnly = (text) => assert.doesNotMatch(text, /[A-Za-z]{8,}/, text);

describe('内部错误进聊天时是中文说明', () => {
  test('静默看门狗:回合太久没有输出 → 中文说明怎么办,英文原文只进日志', async () => {
    const sessionId = nextSessionId();
    assert.deepEqual(errorsOf(await send(sessionId)), []);
    const fake = queryFor(sessionId);
    // 这一轮 CLI 先吐一帧,然后再无动静
    fake.onInput = () => {
      fake.emit({ type: 'assistant', message: { id: 'msg_stall', role: 'assistant', content: [{ type: 'text', text: '想一想' }] } });
    };
    const spies = ['error', 'warn', 'info', 'log'].map((method) => vi.spyOn(console, method));
    let frames;
    try {
      frames = await send(sessionId);
    } finally {
      const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
      for (const spy of spies) spy.mockRestore();
      assert.match(logged, /produced no output/, '英文原文进了日志');
    }
    const errors = errorsOf(frames);
    assert.equal(errors.length, 1, JSON.stringify(frames));
    assert.match(errors[0], /没有任何输出/);
    assert.match(errors[0], /再发一条/);
    assertChineseOnly(errors[0]);
  });

  test('CLI 进程在回合中途退出 → 中文说明', async () => {
    const sessionId = nextSessionId();
    assert.deepEqual(errorsOf(await send(sessionId)), []);
    const fake = queryFor(sessionId);
    fake.onInput = () => {
      fake.emit({ type: 'assistant', message: { id: 'msg_crash', role: 'assistant', content: [{ type: 'text', text: '做到一半' }] } });
      setTimeout(() => fake.end(), 20);
    };
    const errors = errorsOf(await send(sessionId));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /意外退出/);
    assertChineseOnly(errors[0]);
  });

  test('上一轮还在跑时又发一条(等满上限仍没结束)→ 中文「稍等再发」', async () => {
    // 收尾等待默认 15 秒;调成 1 秒,第一条要跑 3 秒,第二条等满仍没结束
    sdk.setSendWaitForTest({ turnSettleMs: 1000, pollMs: 20 });
    onTestFinished(() => sdk.setSendWaitForTest());
    const sessionId = nextSessionId();
    assert.deepEqual(errorsOf(await send(sessionId)), []);
    const runtime = getPersistentRuntime(sessionId);
    const fake = queryFor(sessionId);
    // 第一条一直在跑(隔 100ms 吐一帧,静默看门狗不会到点)
    let ticker = null;
    fake.onInput = (message) => {
      let beats = 0;
      ticker = setInterval(() => {
        beats += 1;
        fake.emit({ type: 'assistant', message: { id: `msg_long_${beats}`, role: 'assistant', content: [{ type: 'text', text: '.' }] } });
        if (beats >= 30) {
          clearInterval(ticker);
          fake.emit({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, user_message_uuid: message.uuid });
        }
      }, 100);
    };
    const first = send(sessionId);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.ok(runtime.turn, '前提:第一条在跑');
    const second = await send(sessionId);
    const errors = errorsOf(second);
    assert.equal(errors.length, 1, JSON.stringify(second));
    assert.match(errors[0], /上一轮还没结束/);
    assertChineseOnly(errors[0]);
    await first;
  });
});
