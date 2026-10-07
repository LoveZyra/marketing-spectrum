import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, test, vi } from 'vitest';

/**
 * 端到端:网页发的这一条还在等(CLI 自己那一轮在跑主线程工具,或上一轮还没收尾),没开跑就被停止。
 *
 * 真的 chat 网关、真的 claude-sdk、真的库与 /api/agent 路由;只把 SDK 的 `query` 换成可逐帧喂的假 CLI。
 * 钉住两层之间的约定:claude-sdk 没把输入推进 CLI 就不调 `onTurnStarted`,停止标记在第一个 await 之前记下;
 * chat 层据此在收尾之前把那一行标成撤回、推同 id 的撤回帧。网页的停止(chat.abort)与外部 API 的停止接口都走这一套。
 */

const queries = [];

/** 下一个起的假 CLI 在收到任何输入之前先交给它改(比如不作答);用一次就清掉。 */
let setUpNextQuery = null;

/**
 * 假的常驻 CLI:帧由测试喂;用户输入默认按「回一句 + result」作答,`onInput = null` 时不答。
 * `interruptGate` 是一个 promise 时,中断回执等它 resolve 才回(模拟 CLI 迟迟不回执)。
 */
function createFakeQuery(prompt, options) {
  const buffered = [];
  const waiters = [];
  let ended = false;
  const fake = {
    options,
    sessionId: options.resume || crypto.randomUUID(),
    inputs: [],
    interrupts: 0,
    closed: false,
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
  let replies = 0;
  fake.onInput = (message) => {
    replies += 1;
    fake.emit({ type: 'assistant', message: { id: `msg_${fake.sessionId}_${replies}`, role: 'assistant', content: [{ type: 'text', text: 'ok' }] } });
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
    interrupt: async () => {
      fake.interrupts += 1;
      if (fake.interruptGate) await fake.interruptGate;
      return {};
    },
    close: () => { fake.closed = true; fake.end(); },
    setModel: async () => {},
    setPermissionMode: async () => {},
    applyFlagSettings: async () => {},
    getContextUsage: async () => null,
    supportedCommands: async () => [],
    stopTask: async () => {},
  };
  options.abortController?.signal.addEventListener('abort', () => { fake.end(); }, { once: true });
  return fake;
}

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt, options }) => {
    const fake = createFakeQuery(prompt, options);
    queries.push(fake);
    const setUp = setUpNextQuery;
    setUpNextQuery = null;
    setUp?.(fake);
    return fake.handle;
  },
}));

// 工作区根在模块加载时读(shared/utils 的 WORKSPACES_ROOT),要在 import 之前定好
const tempDirectory = await mkdtemp(path.join(tmpdir(), 'stop-before-start-'));
const previousEnv = {
  DATABASE_PATH: process.env.DATABASE_PATH,
  WORKSPACES_ROOT: process.env.WORKSPACES_ROOT,
};
process.env.WORKSPACES_ROOT = tempDirectory;
process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');

const express = (await import('express')).default;
const {
  apiKeysDb, closeConnection, initializeDatabase, projectsDb, sessionMessagesDb, sessionsDb, userDb,
} = await import('@/modules/database/index.js');
const { chatRunRegistry } = await import('@/modules/websocket/services/chat-run-registry.service.js');
const { handleChatConnection } = await import('@/modules/websocket/services/chat-websocket.service.js');
const sdk = await import('../claude-sdk.js');
const { default: agentRouter } = await import('../routes/agent.js');

closeConnection();
await initializeDatabase();

/** 与组合根(server/index.js)同样的接法。 */
const chatDeps = {
  spawnFns: { claude: sdk.queryClaudeSDK },
  abortFns: { claude: sdk.abortClaudeSDKSession },
  getToolApprovalSessionId: sdk.getToolApprovalSessionId,
  resolveToolApproval: sdk.resolveToolApproval,
  getPendingApprovalsForSession: sdk.getPendingApprovalsForSession,
};

class FakeSocket {
  readyState = 1;
  sent = [];
  handlers = new Map();
  send(payload) { this.sent.push(JSON.parse(payload)); }
  on(event, handler) { this.handlers.set(event, handler); }
  async emit(event, raw) { await this.handlers.get(event)?.(raw); }
}

let server;
let baseUrl;
let apiKey;
/** 另一个用户的 key:看不到 stopper 项目里的会话。 */
let outsiderApiKey;
let user;
let projectPath;

beforeAll(async () => {
  user = { id: Number(userDb.createUser('stopper', 'hash', 'approved').id), username: 'stopper' };
  apiKey = apiKeysDb.createApiKey(user.id, 'test').apiKey;
  const outsider = userDb.createUser('outsider', 'hash', 'approved');
  outsiderApiKey = apiKeysDb.createApiKey(Number(outsider.id), 'test').apiKey;
  projectPath = path.join(tempDirectory, 'proj');
  await mkdir(projectPath, { recursive: true });
  projectsDb.createProjectPath(projectPath, null, user.id);
  const app = express();
  app.use(express.json());
  app.use('/api/agent', agentRouter);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  setUpNextQuery = null;
  sdk.setSendWaitForTest();
  await sdk.disposeAllRuntimes();
});

afterAll(async () => {
  await new Promise((resolve) => server?.close(resolve));
  await sdk.disposeAllRuntimes();
  chatRunRegistry.clearAll();
  closeConnection();
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(tempDirectory, { recursive: true, force: true });
});

async function waitFor(predicate, label, timeoutMs = 3000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const emit = (ws, payload) => ws.emit('message', JSON.stringify(payload));
const userRows = (sessionId) =>
  sessionMessagesDb.listForSession(sessionId).filter((row) => row.kind === 'text' && row.role === 'user');
const framesOf = (ws, clientMessageId) => ws.sent.filter((frame) => frame.role === 'user' && frame.clientMessageId === clientMessageId);

/**
 * 建一段会话,用第一句起好常驻 runtime,再让 CLI 自己起一轮、跑一条主线程工具(工具结果不回)。
 * 返回网页订阅者、runtime、假 CLI。
 */
async function sessionWithCliOwnTurn() {
  const sessionId = crypto.randomUUID();
  sessionsDb.createAppSession(sessionId, 'claude', projectPath, user.id);
  const ws = new FakeSocket();
  handleChatConnection(ws, { user }, chatDeps);
  await emit(ws, { type: 'chat.subscribe', sessions: [{ sessionId, lastSeq: 0 }] });
  await emit(ws, { type: 'chat.send', sessionId, content: '第一句', clientMessageId: 'cmid-first' });
  const providerSessionId = sessionsDb.getSessionById(sessionId)?.provider_session_id;
  assert.ok(providerSessionId, '第一句跑完,会话记下了 provider 会话 id');
  const runtime = sdk.getPersistentRuntime(providerSessionId);
  const fake = [...queries].reverse().find((candidate) => candidate.sessionId === providerSessionId);
  assert.ok(runtime && fake);

  fake.emit({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '<task-notification>后台子代理完成</task-notification>' }] } });
  fake.emit({ type: 'assistant', message: { id: 'msg_cli_own', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_cli_own', name: 'Read', input: { file_path: '/tmp/x' } }] } });
  await waitFor(() => runtime.orphanTurnOpen && runtime.pendingToolUses.has('toolu_cli_own'), 'CLI 自己那一轮的工具在途');
  return { sessionId, ws, runtime, fake };
}

/**
 * 发一条,等它登记成一轮、用户行推出来(它此时在 runtimeForSend 里等 CLI 那一轮)。
 * 发送的 promise 包在对象里交回:async 函数直接 return 一个 promise 会跟着它一起等。
 */
async function sendWaiting(ws, sessionId, clientMessageId) {
  const sending = emit(ws, { type: 'chat.send', sessionId, content: '等着的那句', clientMessageId });
  await waitFor(() => framesOf(ws, clientMessageId).length === 1, '用户行推了出来');
  await new Promise((resolve) => setTimeout(resolve, 60));
  return { sending };
}

/**
 * 这一轮被停止之后,网页那边该看到的:那一行撤回、同 id 撤回帧在 complete{aborted} 之前;CLI 那一轮被打断、进程没动。
 * 交回这一轮的 complete 帧。
 */
async function assertWithdrawnAndCliTurnStopped({ ws, sessionId, runtime, fake, clientMessageId }) {
  const rows = userRows(sessionId);
  const row = rows.find((candidate) => candidate.clientMessageId === clientMessageId);
  assert.ok(row, `库里有这一行:${JSON.stringify(rows)}`);
  assert.equal(row.withdrawn, true, '库里那一行标了撤回');
  const first = rows.find((candidate) => candidate.clientMessageId === 'cmid-first');
  assert.ok(first, '前一句也在库里');
  assert.equal(first.withdrawn, undefined, '前一句不受影响');

  const frames = framesOf(ws, clientMessageId);
  assert.equal(frames.length, 2, JSON.stringify(frames));
  assert.equal(frames[1].id, row.id);
  assert.equal(frames[1].withdrawn, true);
  const complete = ws.sent.find((frame) => frame.kind === 'complete' && frame.runId === frames[1].runId);
  assert.ok(complete, '这一轮收尾了');
  assert.equal(complete.aborted, true);
  assert.ok(ws.sent.indexOf(complete) > ws.sent.indexOf(frames[1]), '撤回帧在 complete 之前');

  await waitFor(() => fake.interrupts === 1, 'CLI 自己那一轮被打断');
  assert.equal(fake.inputs.some((input) => input.message?.content?.[0]?.text === '等着的那句'), false, '这一条没有推给 CLI');
  assert.equal(fake.closed, false, '进程没被关掉');
  assert.equal(runtime.disposed, false);
  return complete;
}

const abortViaApi = (sessionId, key) => fetch(`${baseUrl}/api/agent/sessions/${sessionId}/abort`, {
  method: 'POST',
  headers: { 'X-API-Key': key },
});

describe('没开跑就被停止:端到端', () => {
  test('网页 chat.abort:那一行撤回,CLI 自己那一轮被打断', async () => {
    sdk.setSendWaitForTest({ pollMs: 20 });
    const { sessionId, ws, runtime, fake } = await sessionWithCliOwnTurn();
    const { sending } = await sendWaiting(ws, sessionId, 'cmid-wait-web');
    assert.equal(fake.interrupts, 0, '停止之前没有打断');

    await emit(ws, { type: 'chat.abort', sessionId });
    await sending;
    await assertWithdrawnAndCliTurnStopped({ ws, sessionId, runtime, fake, clientMessageId: 'cmid-wait-web' });
  });

  test('外部 API 的停止接口:同样撤回、同样打断', async () => {
    sdk.setSendWaitForTest({ pollMs: 20 });
    const { sessionId, ws, runtime, fake } = await sessionWithCliOwnTurn();
    const { sending } = await sendWaiting(ws, sessionId, 'cmid-wait-api');
    assert.equal(fake.interrupts, 0, '停止之前没有打断');

    const response = await abortViaApi(sessionId, apiKey);
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.deepEqual(body, { success: true, aborted: true, sessionId }, '中止送达了,响应里如实报 aborted');
    await sending;
    const complete = await assertWithdrawnAndCliTurnStopped({ ws, sessionId, runtime, fake, clientMessageId: 'cmid-wait-api' });
    assert.equal(complete.exitCode, 0, '中止送达了,收尾码 0');
  });

  test('外部 API 的停止接口:看不到这段会话的 key 停不了(404),等着的那一条不撤回、照常开跑', async () => {
    sdk.setSendWaitForTest({ pollMs: 20 });
    const { sessionId, ws, runtime, fake } = await sessionWithCliOwnTurn();
    const { sending } = await sendWaiting(ws, sessionId, 'cmid-wait-outsider');

    const response = await abortViaApi(sessionId, outsiderApiKey);
    const body = await response.json();
    assert.equal(response.status, 404, JSON.stringify(body));
    assert.equal(body.code, 'SESSION_NOT_FOUND', '与会话不存在同一个答复');
    const row = () => userRows(sessionId).find((candidate) => candidate.clientMessageId === 'cmid-wait-outsider');
    assert.ok(row(), '库里有这一行');
    assert.equal(row().withdrawn, undefined, '那一行没有被撤回');
    assert.equal(framesOf(ws, 'cmid-wait-outsider').length, 1, '没有撤回帧');
    assert.equal(fake.interrupts, 0, 'CLI 自己那一轮没被打断');
    assert.equal(chatRunRegistry.getRun(sessionId)?.status, 'running', '这一轮还在跑');

    // CLI 那一轮跑完,等着的那一条照常推进去
    fake.emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_cli_own', content: 'x' }] } });
    fake.emit({ type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 2 });
    await sending;
    assert.ok(fake.inputs.some((input) => input.message?.content?.[0]?.text === '等着的那句'), '这一条推给了 CLI');
    assert.equal(row().withdrawn, undefined);
    assert.equal(runtime.disposed, false);
  });

  test('外部 API 的停止接口:中止迟迟不落定、这一轮先被自己的收尾关掉,那一行照样撤回(撤回在等中止之前)', async () => {
    sdk.setSendWaitForTest({ pollMs: 20, turnSettleMs: 5000 });
    const sessionId = crypto.randomUUID();
    sessionsDb.createAppSession(sessionId, 'claude', projectPath, user.id);
    const ws = new FakeSocket();
    handleChatConnection(ws, { user }, chatDeps);
    await emit(ws, { type: 'chat.subscribe', sessions: [{ sessionId, lastSeq: 0 }] });

    // 新会话第一句:CLI 收到之后一帧都不出,provider 会话 id 还不知道
    let fake = null;
    setUpNextQuery = (created) => { fake = created; created.onInput = null; };
    const first = emit(ws, { type: 'chat.send', sessionId, content: '第一句', clientMessageId: 'cmid-first' });
    await waitFor(() => fake?.inputs.length === 1, '第一句推给了 CLI');
    // 网页按停止:只能按 runId 中止,这条路不摘活跃会话的登记
    await emit(ws, { type: 'chat.abort', sessionId });
    // 被打断的那一轮这时才出第一帧:会话 id 落库、登记进活跃会话;result 不来,这一轮一直没收尾
    fake.emit({ type: 'assistant', message: { id: 'msg_first', role: 'assistant', content: [{ type: 'text', text: '…' }] } });
    await waitFor(() => sessionsDb.getSessionById(sessionId)?.provider_session_id === fake.sessionId, 'provider 会话 id 落库');

    // 紧接着发的这一条在等上一轮收尾
    const { sending } = await sendWaiting(ws, sessionId, 'cmid-wait-slow');
    const [echo] = framesOf(ws, 'cmid-wait-slow');
    const completeOfThisRun = () => ws.sent.find((frame) => frame.kind === 'complete' && frame.runId === echo.runId);
    // 再停:按 provider 会话 id 找到那段会话,中断回执被扣住,中止一直落不定
    let releaseInterrupt;
    fake.interruptGate = new Promise((resolve) => { releaseInterrupt = resolve; });
    const responding = abortViaApi(sessionId, apiKey);
    // 这一条看到停止标记自己退出,chat 层的兜底把这一轮先关掉
    await waitFor(() => completeOfThisRun(), '这一轮在中止落定之前先收尾');
    await sending;
    const row = userRows(sessionId).find((candidate) => candidate.clientMessageId === 'cmid-wait-slow');
    assert.ok(row, '库里有这一行');
    assert.equal(row.withdrawn, true, '中止还没落定,那一行已经标了撤回');
    const frames = framesOf(ws, 'cmid-wait-slow');
    assert.equal(frames.length, 2, JSON.stringify(frames));
    assert.equal(frames[1].id, row.id);
    assert.equal(frames[1].withdrawn, true);
    assert.ok(ws.sent.indexOf(frames[1]) < ws.sent.indexOf(completeOfThisRun()), '撤回帧在这一轮收尾之前');

    releaseInterrupt();
    const response = await responding;
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.deepEqual(body, { success: true, aborted: true, sessionId });
    assert.equal(fake.inputs.length, 1, '这一条没有推给 CLI');

    // 收掉被打断的第一轮
    fake.interruptGate = null;
    fake.emit({ type: 'result', subtype: 'success', is_error: false, result: 'stopped', num_turns: 1, user_message_uuid: fake.inputs[0].uuid });
    await first;
  });

  test('对照:已经开跑之后停止,那一行不动(那是打断这一轮)', async () => {
    const sessionId = crypto.randomUUID();
    sessionsDb.createAppSession(sessionId, 'claude', projectPath, user.id);
    const ws = new FakeSocket();
    handleChatConnection(ws, { user }, chatDeps);
    await emit(ws, { type: 'chat.subscribe', sessions: [{ sessionId, lastSeq: 0 }] });
    await emit(ws, { type: 'chat.send', sessionId, content: '第一句', clientMessageId: 'cmid-first' });
    const providerSessionId = sessionsDb.getSessionById(sessionId)?.provider_session_id;
    const fake = [...queries].reverse().find((candidate) => candidate.sessionId === providerSessionId);
    fake.onInput = null; // 这一条推进去之后先不答

    const sending = emit(ws, { type: 'chat.send', sessionId, content: '跑着的那句', clientMessageId: 'cmid-running' });
    await waitFor(() => fake.inputs.some((input) => input.message?.content?.[0]?.text === '跑着的那句'), '这一条推给了 CLI');
    await emit(ws, { type: 'chat.abort', sessionId });
    const pushed = fake.inputs.find((input) => input.message?.content?.[0]?.text === '跑着的那句');
    fake.emit({ type: 'result', subtype: 'success', is_error: false, result: 'stopped', num_turns: 1, user_message_uuid: pushed.uuid });
    await sending;

    const row = userRows(sessionId).find((candidate) => candidate.clientMessageId === 'cmid-running');
    assert.ok(row, '库里有这一行');
    assert.equal(row.withdrawn, undefined, '那一行不标撤回');
    assert.equal(framesOf(ws, 'cmid-running').length, 1, '没有撤回帧');
    assert.equal(fake.interrupts, 1, '打断的是这一轮');
  });
});
