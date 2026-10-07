import fs from 'node:fs/promises';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import type { RequestHandler } from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import {
  closeConnection, initializeDatabase, projectsDb, sessionMessagesDb, sessionsDb, userDb,
} from '@/modules/database/index.js';

import providerRouter from '../provider.routes.js';

/**
 * work-frames 的条件请求:前端回合结束、回滚后重取时带上次的 ETag,内容没变就回 304、不再下发整份帧。
 *
 * ETag 是整份响应体的摘要:skillSurveys 随反馈记录、个人开关变化,与显示日志无关,只认日志指纹会把
 * 变了的调查卡当成没变。浏览器给带 If-None-Match 的 fetch 自动补 `Cache-Control: no-cache`,
 * 这里不能因此放弃比对。
 */
type TestUser = { id: number; username: string };

const prevEnv = {
  db: process.env.DATABASE_PATH,
  root: process.env.PRISM_ROOT_USERS,
  rate: process.env.PRISM_SKILL_SURVEY_RATE,
  cd: process.env.PRISM_SKILL_SURVEY_COOLDOWN_MIN,
};
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
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'work-frames-etag-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  process.env.PRISM_ROOT_USERS = 'boss';
  process.env.PRISM_SKILL_SURVEY_RATE = '1';
  process.env.PRISM_SKILL_SURVEY_COOLDOWN_MIN = '60';
  await initializeDatabase();
  const users: Record<string, TestUser> = {};
  for (const name of ['alice', 'boss']) {
    users[name] = { id: Number(userDb.createUser(name, 'hash').id), username: name };
  }
  const projectPath = path.join(dir, 'proj');
  await fs.mkdir(projectPath, { recursive: true });
  projectsDb.createProjectPath(projectPath, null, users.alice.id);
  sessionsDb.createAppSession('sess-a', 'claude', projectPath, users.alice.id);

  const fakeAuth: RequestHandler = (req, res, next) => {
    const name = String(req.headers['x-test-user'] ?? '');
    if (!users[name]) { res.status(401).json({ error: 'nope' }); return; }
    (req as unknown as { user?: TestUser }).user = users[name];
    next();
  };
  const app = express();
  // 与 server/index.js 一致:/api 不用 Express 自动生成的 ETag,这里测的是路由自己算的那个。
  app.set('etag', false);
  app.use(express.json());
  app.use('/api/providers', fakeAuth, providerRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('no listen address');
  return { baseUrl: `http://127.0.0.1:${address.port}`, users };
}

const ANSWER = 'bbbbbbbb-0000-4000-8000-000000000001_text';

const getFrames = async (baseUrl: string, asUser: string, headers: Record<string, string> = {}) => {
  const response = await fetch(`${baseUrl}/api/providers/sessions/sess-a/work-frames`, {
    headers: { 'x-test-user': asUser, ...headers },
  });
  const text = await response.text();
  return { status: response.status, etag: response.headers.get('etag'), text };
};

describe('work-frames 的 ETag / 304', () => {
  it('内容没变回 304(带不带 no-cache、弱比较、列表都认);内容变了回 200 和新 ETag', async () => {
    const { baseUrl, users } = await setup();
    sessionMessagesDb.appendMany('sess-a', [
      { id: 'u1', sessionId: 'sess-a', timestamp: '2026-10-07T01:00:00.000Z', provider: 'claude', kind: 'text', role: 'user', content: '开工', senderUserId: users.alice.id, origin: 'web' },
      { id: 't1', sessionId: 'sess-a', timestamp: '2026-10-07T01:00:01.000Z', provider: 'claude', kind: 'tool_use', toolName: 'TaskCreate', toolId: 't1', toolInput: { subject: '甲' } },
      { id: 'r1', sessionId: 'sess-a', timestamp: '2026-10-07T01:00:02.000Z', provider: 'claude', kind: 'tool_result', toolId: 't1', content: 'Task #1 created successfully: 甲' },
    ] as never);

    const first = await getFrames(baseUrl, 'alice');
    expect(first.status).toBe(200);
    expect(first.etag).toMatch(/^"[^"]+"$/);
    const body = JSON.parse(first.text) as { data: { frames: unknown[]; userTurns: number } };
    expect(Object.keys(body.data).sort()).toEqual(['frames', 'revertedPaths', 'skillSurveys', 'truncated', 'turnOutputs', 'userTurns']);
    expect(body.data.frames).toHaveLength(1);
    expect(body.data.userTurns).toBe(1);

    const etag = first.etag!;
    for (const headers of [
      { 'If-None-Match': etag },
      // 浏览器对带 If-None-Match 的 fetch 自动补的两个头
      { 'If-None-Match': etag, 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
      { 'If-None-Match': `W/${etag}` },
      { 'If-None-Match': `"stale", ${etag}` },
    ]) {
      const again = await getFrames(baseUrl, 'alice', headers);
      expect(again.status, JSON.stringify(headers)).toBe(304);
      expect(again.text).toBe('');
      expect(again.etag).toBe(etag);
    }

    const stale = await getFrames(baseUrl, 'alice', { 'If-None-Match': '"stale"' });
    expect(stale.status).toBe(200);
    expect(stale.etag).toBe(etag);
    expect(stale.text).toBe(first.text);

    sessionMessagesDb.appendMany('sess-a', [
      { id: 't2', sessionId: 'sess-a', timestamp: '2026-10-07T01:00:03.000Z', provider: 'claude', kind: 'tool_use', toolName: 'TaskUpdate', toolId: 't2', toolInput: { taskId: '1', status: 'completed' } },
    ] as never);
    const changed = await getFrames(baseUrl, 'alice', { 'If-None-Match': etag });
    expect(changed.status).toBe(200);
    expect(changed.etag).not.toBe(etag);
    expect((JSON.parse(changed.text) as { data: { frames: unknown[] } }).data.frames).toHaveLength(2);
  });

  it('ETag 覆盖 skillSurveys:帧没变、调查卡变了(答过 / 换了看的人)也不回 304', async () => {
    const { baseUrl, users } = await setup();
    sessionMessagesDb.appendMany('sess-a', [
      { id: 'u1', sessionId: 'sess-a', timestamp: '2026-10-07T02:00:00.000Z', provider: 'claude', kind: 'text', role: 'user', content: '审计一下', senderUserId: users.alice.id, origin: 'web' },
      { id: 'sk1', sessionId: 'sess-a', timestamp: '2026-10-07T02:00:01.000Z', provider: 'claude', kind: 'tool_use', toolName: 'Skill', toolId: 'sk1', toolInput: { skill: 'marketing-audit' } },
      { id: ANSWER, sessionId: 'sess-a', timestamp: '2026-10-07T02:01:00.000Z', provider: 'claude', kind: 'text', role: 'assistant', content: '审计完了' },
    ] as never);

    const mine = await getFrames(baseUrl, 'alice');
    expect((JSON.parse(mine.text) as { data: { skillSurveys: unknown[] } }).data.skillSurveys).toHaveLength(1);

    // 旁观的人拿不到这张卡:内容不同,拿 alice 的 ETag 来问也是 200
    const boss = await getFrames(baseUrl, 'boss', { 'If-None-Match': mine.etag! });
    expect(boss.status).toBe(200);
    expect((JSON.parse(boss.text) as { data: { skillSurveys: unknown[] } }).data.skillSurveys).toEqual([]);

    const feedback = await fetch(`${baseUrl}/api/providers/sessions/sess-a/messages/${ANSWER}/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': 'alice' },
      body: JSON.stringify({ source: 'survey', verdict: 1, skillHint: 'marketing-audit' }),
    });
    expect(feedback.status).toBe(200);
    const answered = await getFrames(baseUrl, 'alice', { 'If-None-Match': mine.etag! });
    expect(answered.status).toBe(200);
    expect((JSON.parse(answered.text) as { data: { skillSurveys: unknown[] } }).data.skillSurveys).toEqual([]);
  });
});
