import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import type { RequestHandler } from 'express';
import { afterEach, describe, test } from 'vitest';

import {
  auditLogDb, closeConnection, initializeDatabase, projectsDb, sessionMessagesDb, sessionsDb, uiSettingsDb, userDb,
} from '@/modules/database/index.js';

import providerRouter from '../provider.routes.js';

/**
 * 反馈路由与 work-frames 里的 `skillSurveys`:在路由层测可见性与三道闸。
 *
 * 会话可见性是唯一的门:看得见就能投,看不见一律 404(与 usage-visibility 同一策略:
 * 用文案 / 状态码区分"被门挡下"与"过门后的失败")。
 */
type TestUser = { id: number; username: string; isRoot?: boolean };

const prevEnv = { db: process.env.DATABASE_PATH, root: process.env.PRISM_ROOT_USERS, rate: process.env.PRISM_SKILL_SURVEY_RATE, cd: process.env.PRISM_SKILL_SURVEY_COOLDOWN_MIN };
let server: Server | null = null;
let dir: string | null = null;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  closeConnection();
  for (const [key, value] of [
    ['DATABASE_PATH', prevEnv.db], ['PRISM_ROOT_USERS', prevEnv.root],
    ['PRISM_SKILL_SURVEY_RATE', prevEnv.rate], ['PRISM_SKILL_SURVEY_COOLDOWN_MIN', prevEnv.cd],
  ] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  if (dir) { await fs.rm(dir, { recursive: true, force: true }); dir = null; }
});

async function setup() {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'feedback-routes-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  process.env.PRISM_ROOT_USERS = 'boss';
  process.env.PRISM_SKILL_SURVEY_RATE = '1';
  process.env.PRISM_SKILL_SURVEY_COOLDOWN_MIN = '60';
  await initializeDatabase();
  const users: Record<string, TestUser> = {};
  for (const name of ['alice', 'bob', 'boss']) {
    users[name] = { id: Number(userDb.createUser(name, 'hash').id), username: name, isRoot: name === 'boss' };
  }
  const alicePath = path.join(dir, 'alice-proj');
  await fs.mkdir(alicePath, { recursive: true });
  projectsDb.createProjectPath(alicePath, null, users.alice.id);
  sessionsDb.createAppSession('sess-a', 'claude', alicePath, users.alice.id);

  const fakeAuth: RequestHandler = (req, res, next) => {
    const name = String(req.headers['x-test-user'] ?? '');
    if (!users[name]) { res.status(401).json({ error: 'nope' }); return; }
    (req as unknown as { user?: TestUser }).user = users[name];
    next();
  };
  const app = express();
  app.use(express.json());
  app.use('/api/providers', fakeAuth, providerRouter);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = (error as { statusCode?: number })?.statusCode ?? 500;
    res.status(status).json({ error: (error as Error)?.message ?? 'error', code: (error as { code?: string })?.code });
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('no listen address');
  return { baseUrl: `http://127.0.0.1:${address.port}`, users, alicePath };
}

const call = async (baseUrl: string, asUser: string, method: string, url: string, body?: unknown) => {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-user': asUser },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: { error?: string; code?: string; data?: Record<string, unknown> } = {};
  try { parsed = JSON.parse(text) as typeof parsed; } catch { /* 非 JSON */ }
  return { status: response.status, body: parsed };
};

const ANSWER = 'aaaaaaaa-0000-4000-8000-000000000001_text';

const seedTurn = (sessionId: string, senderUserId: number, origin: 'web' | 'scheduled' = 'web') => {
  sessionMessagesDb.appendMany(sessionId, [
    { id: 'user_1', sessionId, timestamp: '2026-09-23T02:00:00.000Z', provider: 'claude', kind: 'text', role: 'user', content: '按等长日窗比较', senderUserId, origin },
    { id: 'tool_1', sessionId, timestamp: '2026-09-23T02:00:01.000Z', provider: 'claude', kind: 'tool_use', toolName: 'Skill', toolInput: { skill: 'marketing-audit' }, toolId: 'tool_1' },
    { id: ANSWER, sessionId, timestamp: '2026-09-23T02:01:00.000Z', provider: 'claude', kind: 'text', role: 'assistant', content: '环比 +7.9%' },
  ] as never);
};

describe('反馈路由', () => {
  test('看得见就能投,改票 upsert,看不见 404,坏 verdict 400,写审计', async () => {
    const { baseUrl, users } = await setup();
    seedTurn('sess-a', users.alice.id);
    const first = await call(baseUrl, 'alice', 'POST', `/api/providers/sessions/sess-a/messages/${ANSWER}/feedback`,
      { verdict: -1, category: 'wrong_result', note: '少一列', expectedOutput: '小红书单列', skillHint: 'marketing-audit' });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal((first.body.data?.feedback as { verdict: number }).verdict, -1);
    const second = await call(baseUrl, 'alice', 'POST', `/api/providers/sessions/sess-a/messages/${ANSWER}/feedback`, { verdict: 1 });
    assert.equal((second.body.data?.feedback as { id: number }).id, (first.body.data?.feedback as { id: number }).id, '改票不开新行');
    const listed = await call(baseUrl, 'alice', 'GET', '/api/providers/sessions/sess-a/feedback');
    assert.equal((listed.body.data?.feedback as unknown[]).length, 1);
    // bob 看不见 alice 的私有项目 → 404(不是 403:不给存在性探针)
    const denied = await call(baseUrl, 'bob', 'POST', `/api/providers/sessions/sess-a/messages/${ANSWER}/feedback`, { verdict: 1 });
    assert.equal(denied.status, 404);
    assert.equal((await call(baseUrl, 'bob', 'GET', '/api/providers/sessions/sess-a/feedback')).status, 404);
    // root 看得见
    assert.equal((await call(baseUrl, 'boss', 'POST', `/api/providers/sessions/sess-a/messages/${ANSWER}/feedback`, { verdict: 0, source: 'survey' })).status, 200);
    // 坏 verdict
    assert.equal((await call(baseUrl, 'alice', 'POST', `/api/providers/sessions/sess-a/messages/${ANSWER}/feedback`, { verdict: 5 })).status, 400);
    // 跳过:不需要 verdict
    assert.equal((await call(baseUrl, 'alice', 'POST', `/api/providers/sessions/sess-a/messages/${ANSWER}/feedback`, { source: 'survey', status: 'dismissed' })).status, 200);
    // 删除自己的
    assert.equal((await call(baseUrl, 'alice', 'DELETE', `/api/providers/sessions/sess-a/messages/${ANSWER}/feedback`)).body.data?.removed, true);
    const events = auditLogDb.list(50, 0, null).filter((row) => row.event === 'message_feedback');
    assert.ok(events.length >= 3, '每次反馈都写审计');
  });

  test('work-frames 的 skillSurveys:只给发起人、答过不再弹、关掉不弹、定时任务不弹', async () => {
    const { baseUrl, users } = await setup();
    seedTurn('sess-a', users.alice.id);
    const mine = await call(baseUrl, 'alice', 'GET', '/api/providers/sessions/sess-a/work-frames');
    assert.equal(mine.status, 200);
    assert.deepEqual(
      (mine.body.data?.skillSurveys as Array<{ messageId: string; skill: string }>).map((x) => [x.messageId, x.skill]),
      [[ANSWER, 'marketing-audit']],
    );
    // 旁观者(root 看得见,但不是发起人):不弹
    const boss = await call(baseUrl, 'boss', 'GET', '/api/providers/sessions/sess-a/work-frames');
    assert.deepEqual(boss.body.data?.skillSurveys, []);
    // 十次一致
    for (let i = 0; i < 10; i += 1) {
      const again = await call(baseUrl, 'alice', 'GET', '/api/providers/sessions/sess-a/work-frames');
      assert.equal((again.body.data?.skillSurveys as unknown[]).length, 1);
    }
    // 答过 → 不再弹
    await call(baseUrl, 'alice', 'POST', `/api/providers/sessions/sess-a/messages/${ANSWER}/feedback`, { source: 'survey', verdict: 1, skillHint: 'marketing-audit' });
    assert.deepEqual((await call(baseUrl, 'alice', 'GET', '/api/providers/sessions/sess-a/work-frames')).body.data?.skillSurveys, []);
    // 关掉开关 → 不弹(另一条会话,避免上面那条已答过)
    sessionsDb.createAppSession('sess-b', 'claude', path.join(dir!, 'alice-proj'), users.alice.id);
    seedTurn('sess-b', users.alice.id);
    assert.equal(((await call(baseUrl, 'alice', 'GET', '/api/providers/sessions/sess-b/work-frames')).body.data?.skillSurveys as unknown[]).length, 1);
    uiSettingsDb.put(users.alice.id, { values: { uiPreferences: JSON.stringify({ skillSurveyEnabled: false }) }, updatedAt: 'x' }, null);
    assert.deepEqual((await call(baseUrl, 'alice', 'GET', '/api/providers/sessions/sess-b/work-frames')).body.data?.skillSurveys, []);
    uiSettingsDb.put(users.alice.id, {}, null);
    // 定时任务的回合 → 不弹
    sessionsDb.createAppSession('sess-c', 'claude', path.join(dir!, 'alice-proj'), users.alice.id);
    seedTurn('sess-c', users.alice.id, 'scheduled');
    assert.deepEqual((await call(baseUrl, 'alice', 'GET', '/api/providers/sessions/sess-c/work-frames')).body.data?.skillSurveys, []);
  });
});
