import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, test, vi } from 'vitest';

/**
 * 外部 Agent API 写进显示日志的用户行,同时作为这一轮的实时帧推给正在看这段会话的人
 * (同步、异步两条路)。
 *
 * 钉的是行为:订阅者第一帧编号的帧就是这条用户行(带 seq / runId,origin 为 api),显示日志里用户行只有一行。
 * 有人把 `broadcastWithoutPersist` 挪到 `startRun` 之前(那时没有在跑的回合,什么都不发),或换成
 * `run.writer.send`(出站收口会再落一行),这里都会红。
 *
 * 真的 express 路由、真的库与 chat 网关;只有 claude-sdk 换成假的(不起 CLI)。
 */

vi.mock('../../claude-sdk.js', () => ({
  queryClaudeSDK: async (command, options, writer) => {
    const sessionId = options.newSessionId ?? options.sessionId ?? null;
    writer.send({ kind: 'text', role: 'assistant', provider: 'claude', sessionId, content: `回答:${command}` });
    writer.send({ kind: 'complete', provider: 'claude', sessionId, exitCode: 0 });
    return { ok: true, exitCode: 0, aborted: false, error: null, sessionId };
  },
  abortClaudeSDKSession: async () => false,
}));

// 工作区根在模块加载时读(shared/utils 的 WORKSPACES_ROOT),要在 import 之前定好
const tempDirectory = await mkdtemp(path.join(tmpdir(), 'agent-user-row-'));
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
const { default: agentRouter } = await import('../agent.js');

closeConnection();
await initializeDatabase();

class FakeSocket {
  readyState = 1;
  sent = [];
  handlers = new Map();
  send(payload) { this.sent.push(JSON.parse(payload)); }
  on(event, handler) { this.handlers.set(event, handler); }
  async emit(event, raw) { await this.handlers.get(event)?.(raw); }
}

const chatDeps = {
  spawnFns: { claude: async () => {} },
  abortFns: { claude: () => true },
  getToolApprovalSessionId: () => null,
  resolveToolApproval: () => {},
  getPendingApprovalsForSession: () => [],
};

let server;
let baseUrl;
let apiKey;
let user;
let projectPath;

beforeAll(async () => {
  user = { id: Number(userDb.createUser('apiuser', 'hash', 'approved').id), username: 'apiuser' };
  apiKey = apiKeysDb.createApiKey(user.id, 'test').apiKey;
  projectPath = path.join(tempDirectory, 'proj');
  await mkdir(projectPath, { recursive: true });
  projectsDb.createProjectPath(projectPath, null, user.id);

  const app = express();
  app.use(express.json());
  app.use('/api/agent', agentRouter);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server?.close(resolve));
  chatRunRegistry.clearAll();
  closeConnection();
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(tempDirectory, { recursive: true, force: true });
});

/** 领一个号(还没跑过的会话),用 API 的主人身份订阅它。 */
async function claimAndSubscribe(sessionId) {
  sessionsDb.createAppSession(sessionId, 'claude', projectPath, user.id);
  const ws = new FakeSocket();
  handleChatConnection(ws, { user: { id: user.id, username: user.username } }, chatDeps);
  await ws.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId, lastSeq: 0 }] }));
  assert.ok(ws.sent.some((frame) => frame.kind === 'chat_subscribed' && frame.sessionId === sessionId), '订阅上了');
  return ws;
}

async function postAgent(body) {
  const response = await fetch(`${baseUrl}/api/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function waitFor(predicate, label, timeoutMs = 3000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const userRowsInLog = (sessionId) =>
  sessionMessagesDb.listForSession(sessionId).filter((row) => row.kind === 'text' && row.role === 'user');

/** 订阅者收到的这一轮的帧(带 seq 的),按 seq 排。 */
const runFrames = (ws, sessionId) => ws.sent
  .filter((frame) => frame.sessionId === sessionId && typeof frame.seq === 'number')
  .sort((a, b) => a.seq - b.seq);

function assertUserFrameFirst(ws, sessionId, message) {
  const frames = runFrames(ws, sessionId);
  assert.ok(frames.length > 0, JSON.stringify(ws.sent));
  const [first] = frames;
  assert.equal(first.kind, 'text');
  assert.equal(first.role, 'user', '这一轮的第一帧就是用户行');
  assert.equal(first.content, message);
  assert.equal(first.origin, 'api');
  assert.equal(first.senderUserId, user.id);
  assert.equal(first.seq, 1);
  assert.equal(typeof first.runId, 'string');
  assert.equal(frames.filter((frame) => frame.role === 'user').length, 1, '用户帧只推一次');

  const logged = userRowsInLog(sessionId);
  assert.equal(logged.length, 1, '显示日志里用户行只有一行');
  assert.equal(logged[0].id, first.id, '实时帧就是落库的那一行');
  assert.equal(logged[0].seq, undefined, '落库的是网关自己写的那一行,不是加了编号的实时帧');
  return first;
}

describe('外部 Agent API 的用户行实时帧', () => {
  test('同步(非流式):订阅者先收到用户帧,显示日志里只有一行', async () => {
    const sessionId = '0a0a0a0a-0000-4000-8000-000000000001';
    const ws = await claimAndSubscribe(sessionId);
    const { status, body } = await postAgent({ projectPath, message: '同步跑一下', sessionId, stream: false });
    assert.equal(status, 200, JSON.stringify(body));

    const first = assertUserFrameFirst(ws, sessionId, '同步跑一下');
    const complete = runFrames(ws, sessionId).find((frame) => frame.kind === 'complete');
    assert.ok(complete, '同步回合收尾时订阅者收到 complete');
    assert.equal(complete.runId, first.runId);
  });

  test('异步:订阅者先收到用户帧,之后才是这一轮的输出;显示日志里只有一行', async () => {
    const sessionId = '0a0a0a0a-0000-4000-8000-000000000002';
    const ws = await claimAndSubscribe(sessionId);
    const { status, body } = await postAgent({ projectPath, message: '异步跑一下', sessionId, async: true });
    assert.equal(status, 202, JSON.stringify(body));
    await waitFor(() => runFrames(ws, sessionId).some((frame) => frame.kind === 'complete'), '异步回合收尾');

    const first = assertUserFrameFirst(ws, sessionId, '异步跑一下');
    const answer = runFrames(ws, sessionId).find((frame) => frame.role === 'assistant');
    assert.ok(answer, '这一轮的输出照常推给订阅者');
    assert.ok(answer.seq > first.seq);
    assert.equal(answer.runId, first.runId);
  });
});
