import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, describe, test, vi } from 'vitest';

/**
 * runtimeForSend 的串行范围:同一段对话的发送仍然一条一条来;不同对话互不等待
 * (一个人在慢网关上切模型,不能把所有人的发送都卡住);池子的名额计算与淘汰仍然全局串行。
 *
 * 名额上限在模块加载时读环境变量,这里先调成 3 再加载 claude-sdk。SDK 的 `query` 换成可控的假进程。
 */

process.env.PRISM_MAX_RUNTIMES = '3';

const queries = [];

function createFakeQuery(prompt, options) {
  const buffered = [];
  const waiters = [];
  let ended = false;
  const fake = {
    options,
    sessionId: options.resume || `eeeeeeee-0000-4000-8000-${String(queries.length + 1).padStart(12, '0')}`,
    inputs: [],
    setModelCalls: [],
    setModelImpl: null,
    emit(frame) {
      const message = { session_id: fake.sessionId, ...frame };
      if (waiters.length) waiters.shift()({ value: message, done: false });
      else buffered.push(message);
    },
    end() {
      ended = true;
      while (waiters.length) waiters.shift()({ value: undefined, done: true });
    },
  };
  if (typeof prompt === 'string') {
    // 一次性路径:答一句就结束
    fake.oneShot = true;
    fake.inputs.push(prompt);
    fake.emit({ type: 'assistant', message: { id: `msg_${fake.sessionId}_oneshot`, role: 'assistant', content: [{ type: 'text', text: 'ok' }] } });
    fake.emit({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1 });
    fake.end();
  } else {
    (async () => {
      try {
        for await (const message of prompt) {
          fake.inputs.push(message);
          fake.emit({ type: 'assistant', message: { id: `msg_${fake.sessionId}_${fake.inputs.length}`, role: 'assistant', content: [{ type: 'text', text: 'ok' }] } });
          fake.emit({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, user_message_uuid: message.uuid });
        }
      } catch { /* 输入流关了 */ }
    })();
  }
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
    setModel: async (model) => {
      fake.setModelCalls.push(model);
      if (fake.setModelImpl) return fake.setModelImpl(model);
      return undefined;
    },
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
const { queryClaudeSDK, disposeAllRuntimes, getPersistentRuntime, getRuntimePoolStats } = sdk;

const cwd = mkdtempSync(path.join(tmpdir(), 'prism-session-lock-'));
const { closeConnection, initializeDatabase } = await import('@/modules/database/index.js');
const previousDatabasePath = process.env.DATABASE_PATH;
const dbDir = mkdtempSync(path.join(tmpdir(), 'prism-session-lock-db-'));
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
  delete process.env.PRISM_MAX_RUNTIMES;
  rmSync(dbDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

let sessionCounter = 0;
const nextSessionId = () => {
  sessionCounter += 1;
  return `ffffffff-0000-4000-8000-${String(sessionCounter).padStart(12, '0')}`;
};
const writer = () => {
  const frames = [];
  return { frames, userId: 1, send: (frame) => { frames.push(frame); }, setSessionId: () => {} };
};
const errorsOf = (frames) => frames.filter((frame) => frame?.kind === 'error').map((frame) => String(frame.content));
const send = async (sessionId, extra = {}) => {
  const ws = writer();
  await queryClaudeSDK('hi', { cwd, projectPath: cwd, runId: `app-${sessionId}`, permissionMode: 'default', sessionId, ...extra }, ws);
  return ws.frames;
};
const queryFor = (sessionId) => [...queries].reverse().find((fake) => fake.sessionId === sessionId);
async function waitFor(predicate, label, timeoutMs = 3000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('runtimeForSend 的串行范围', () => {
  test('A 会话切模型卡在网关上,B 会话照常发送,不排在 A 后面', async () => {
    const sessionA = nextSessionId();
    const sessionB = nextSessionId();
    assert.deepEqual(errorsOf(await send(sessionA)), []);
    assert.deepEqual(errorsOf(await send(sessionB)), []);
    const fakeA = queryFor(sessionA);
    let releaseA;
    fakeA.setModelImpl = () => new Promise((resolve) => { releaseA = resolve; });

    let aDone = false;
    const sendA = send(sessionA, { model: 'sonnet' }).then((frames) => { aDone = true; return frames; });
    await waitFor(() => fakeA.setModelCalls.length === 1, 'A 开始切模型');

    const started = Date.now();
    assert.deepEqual(errorsOf(await send(sessionB)), []);
    assert.ok(Date.now() - started < 2000, `B 用了 ${Date.now() - started}ms`);
    assert.equal(aDone, false, 'A 还卡在切模型上');

    releaseA();
    assert.deepEqual(errorsOf(await sendA), []);
    assert.equal(getPersistentRuntime(sessionA).currentModel, 'sonnet');
  });

  test('同一段对话的两次发送仍然串行:第二条等第一条把切模型做完才开始', async () => {
    const sessionId = nextSessionId();
    assert.deepEqual(errorsOf(await send(sessionId)), []);
    const fake = queryFor(sessionId);
    let inFlight = 0;
    let maxInFlight = 0;
    const releases = [];
    fake.setModelImpl = () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((resolve) => releases.push(() => { inFlight -= 1; resolve(); }));
    };

    const first = send(sessionId, { model: 'sonnet' });
    await waitFor(() => fake.setModelCalls.length === 1, '第一条开始切模型');
    const second = send(sessionId, { model: 'opus' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(fake.setModelCalls.length, 1, '第二条没有并发进来');

    releases.shift()();
    await waitFor(() => fake.setModelCalls.length === 2, '第二条接着切模型');
    releases.shift()();
    assert.deepEqual(errorsOf(await first), []);
    assert.deepEqual(errorsOf(await second), []);
    assert.deepEqual(fake.setModelCalls, ['sonnet', 'opus']);
    assert.equal(maxInFlight, 1);
    assert.equal(fake.inputs.length, 3, '两条都推给了同一个 CLI');
  });

  test('A 正在切模型(锁里拿着 runtime)时池子满了、别的对话要起进程:名额淘汰不挑 A', async () => {
    const sessionA = nextSessionId();
    const sessionB = nextSessionId();
    const sessionC = nextSessionId();
    for (const sessionId of [sessionA, sessionB, sessionC]) assert.deepEqual(errorsOf(await send(sessionId)), []);
    const runtimeA = getPersistentRuntime(sessionA);
    // A 是最久没用的那个:不领走的话名额淘汰第一个挑它
    runtimeA.lastUsed = 1;
    const fakeA = queryFor(sessionA);
    let releaseA;
    fakeA.setModelImpl = () => new Promise((resolve) => { releaseA = resolve; });
    const sendA = send(sessionA, { model: 'sonnet' });
    await waitFor(() => fakeA.setModelCalls.length === 1, 'A 开始切模型');

    assert.deepEqual(errorsOf(await send(nextSessionId())), []);
    assert.equal(runtimeA.disposed, false, 'A 没被挤掉');
    releaseA();
    assert.deepEqual(errorsOf(await sendA), []);
    assert.equal(getPersistentRuntime(sessionA), runtimeA);
    assert.equal(fakeA.inputs.length, 2, 'A 这一条在原来的进程上跑了');
  });

  test('多段新对话同时起 runtime:名额计算仍然全局串行,池子不超上限', async () => {
    // 先占满(上限 3)
    for (let index = 0; index < 3; index += 1) {
      assert.deepEqual(errorsOf(await send(nextSessionId())), []);
    }
    assert.equal(getRuntimePoolStats().size, 3);
    let maxSize = 0;
    const sampler = setInterval(() => { maxSize = Math.max(maxSize, getRuntimePoolStats().size); }, 1);
    try {
      // 四段新对话同时来:挤掉三个空闲的;第四个没有可挤的(另外三个正在起、已被领走),按名额已满走一次性回退
      const results = await Promise.all([0, 1, 2, 3].map(() => send(nextSessionId())));
      for (const frames of results) assert.deepEqual(errorsOf(frames), []);
    } finally {
      clearInterval(sampler);
    }
    maxSize = Math.max(maxSize, getRuntimePoolStats().size);
    assert.ok(maxSize <= 3, `池子最多到过 ${maxSize} 个`);
  });
});
