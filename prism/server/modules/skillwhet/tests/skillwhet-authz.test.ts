import assert from 'node:assert/strict';
import { existsSync as fsExists } from 'node:fs';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import http, { type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import express from 'express';
import type { RequestHandler } from 'express';
import { describe, test } from 'vitest';

import { auditLogDb, closeConnection, initializeDatabase, messageFeedbackDb, projectsDb, sessionsDb, userDb } from '@/modules/database/index.js';

import { SkillWhetClient } from '../services/skillwhet-client.js';
import { createSkillWhetRouter } from '../skillwhet.routes.js';

/**
 * gy:`/api/skillwhet/*` 的权限线,在**路由层**测(理由同 tasks-authz.test.ts:
 * 只测函数证明不了路由调没调它)。
 *
 * serve 那边用一个假的回环 HTTP 顶替:它记下收到的请求、按路由回固定 JSON。
 * 这样测的是 Prism 这一侧的判断 —— 谁被 403、转发时带没带口令、审计写没写。
 */
type TestUser = { id: number; username: string; isRoot?: boolean };

type FakeServe = { server: Server; port: number; calls: Array<{ method: string; url: string; token: string; body: unknown }>; state: { gate: Record<string, string>; drift: string[]; jobs: Array<Record<string, unknown>>; managed: Record<string, { imported_from?: string; [key: string]: unknown }>; checkpoint: Record<string, { exists: boolean; matches?: boolean; round?: number }> } };

async function startFakeServe(): Promise<FakeServe> {
  const calls: FakeServe['calls'] = [];
  const managed: Record<string, { name: string; source: string; uploaded_by: string; adopted?: boolean; latest_staging?: string; imported_from?: string; bootstrapped?: boolean }> = {
    'marketing-audit': { name: 'marketing-audit', source: 'live', uploaded_by: '', adopted: true, latest_staging: '20260923-100000', imported_from: '', bootstrapped: true },
    'period-report': { name: 'period-report', source: 'upload', uploaded_by: 'alice', adopted: true, latest_staging: '20260923-100001', bootstrapped: false },
  };
  // gz:体检缓存(G1)、作业表、漂移 —— 测试用例通过 `fake.state` 改
  const state = {
    gate: { 'marketing-audit': 'pass', 'period-report': 'pass' } as Record<string, string>,
    drift: [] as string[],
    jobs: [] as Array<Record<string, unknown>>,
    managed,
    checkpoint: {} as Record<string, { exists: boolean; matches?: boolean; round?: number }>,
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      const url = req.url ?? '';
      calls.push({ method: req.method ?? '', url, token: String(req.headers['x-skillwhet-token'] ?? ''), body });
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (url === '/healthz') return send(200, { ok: true, data: { python: '3.11.9', tools: { ruff: true, bandit: false, pyright: true, unshare: false, claude_cli: true } } });
      if (req.headers['x-skillwhet-token'] !== 'tok') return send(401, { ok: false, error: 'UNAUTHORIZED', message: 'bad token' });
      if (url === '/skills' && req.method === 'GET') return send(200, { ok: true, data: { skills: Object.values(managed) } });
      const m = url.match(/^\/skills\/([^/]+)\/status$/);
      if (m) {
        const item = managed[decodeURIComponent(m[1])];
        return item ? send(200, { ok: true, data: item }) : send(404, { ok: false, error: 'NOT_MANAGED', message: 'no such' });
      }
      if (url === '/skills/upload') return send(200, { ok: true, data: { imported: body, status: {} } });
      if (/^\/skills\/[^/]+\/(import|bootstrap)$/.test(url)) return send(200, { ok: true, data: { done: true } });
      if (/^\/skills\/[^/]+$/.test(url) && req.method === 'DELETE') return send(200, { ok: true, data: { removed: true } });
      if (url === '/tasks/validate') return send(200, { ok: true, data: { passed: 1, failed: 0, rows: [] } });
      if (url === '/tasks' && req.method === 'POST') return send(200, { ok: true, data: { added: 2, total: 2 } });
      if (url.startsWith('/tasks')) return send(200, { ok: true, data: { summary: [] } });
      const g = url.match(/^\/skills\/([^/]+)\/gate$/);
      if (g) {
        const verdict = state.gate[decodeURIComponent(g[1])];
        return send(200, { ok: true, data: verdict ? { cached: true, passed: verdict === 'pass', results: [{ gate: 'G0.parse', verdict: 'pass' }, { gate: 'G1.security', verdict }] } : { cached: false, results: [] } });
      }
      if (/^\/skills\/[^/]+\/drift$/.test(url)) return send(200, { ok: true, data: { drift: state.drift } });
      const ckm = url.match(/^\/skills\/([^/]+)\/checkpoint$/);
      if (ckm) return send(200, { ok: true, data: state.checkpoint[decodeURIComponent(ckm[1])] ?? { exists: false } });
      if (/^\/skills\/[^/]+\/rebase$/.test(url)) return send(200, { ok: true, data: { rebased: body } });
      const pubs = url.match(/^\/skills\/([^/]+)\/publishes$/);
      if (pubs) return send(200, { ok: true, data: { history: calls.filter((c) => c.url === `/skills/${pubs[1]}/rebase` && (c.body as { event?: string } | undefined)?.event).map((c) => ({ ...(c.body as object), at: '2026-09-24T00:00:00Z' })).reverse() } });
      if (url === '/tasks/derive') return send(200, { ok: true, data: { derived: 6, added: 6, total: 6 } });
      if (url === '/jobs' && req.method === 'POST') {
        const job = { id: `job_20260923-1000${String(state.jobs.length).padStart(2, '0')}_abcd`, kind: (body as { kind?: string }).kind ?? 'train', skill: (body as { skill: string }).skill, args: (body as { args: unknown }).args, tags: (body as { tags: string[] }).tags, state: 'queued', created_at: new Date().toISOString(), cost_usd: null };
        state.jobs.push(job);
        return send(200, { ok: true, data: { job, position: state.jobs.length - 1 } });
      }
      if (url.startsWith('/jobs?') || url === '/jobs') return send(200, { ok: true, data: { jobs: state.jobs } });
      const j = url.match(/^\/jobs\/([^/]+)(\/(progress|log|cancel|result|import))?(\?.*)?$/);
      if (j) {
        const job = state.jobs.find((x) => x.id === j[1]);
        if (!job) return send(404, { ok: false, error: 'JOB_NOT_FOUND', message: 'no job' });
        if (j[3] === 'result') return send(200, { ok: true, data: { kind: job.kind, skill: job.skill, result: { sessions: [], tasks: [] }, imported: null } });
        if (j[3] === 'import') return send(200, { ok: true, data: { added: 2, total: 9, batch: 'batch-x.json' } });
        if (j[3] === 'cancel') { job.state = 'cancelled'; return send(200, { ok: true, data: { job } }); }
        if (j[3] === 'progress') return send(200, { ok: true, data: { events: [], state: job.state, last_seq: 0 } });
        if (j[3] === 'log') return send(200, { ok: true, data: { log: 'baseline : 0.5' } });
        return send(200, { ok: true, data: { job } });
      }
      if (/^\/skills\/[^/]+\/staging$/.test(url)) return send(200, { ok: true, data: { staging: [{ id: '20260923-100000', accepted: true, adopted: false }] } });
      if (/^\/skills\/[^/]+\/staging\/[^/]+\/adopt$/.test(url)) return send(200, { ok: true, data: { adopted: true, written: ['SKILL.md'] } });
      if (/^\/skills\/[^/]+\/staging\/[^/]+\/export$/.test(url)) {
        res.writeHead(200, { 'content-type': 'application/gzip', 'content-disposition': 'attachment; filename="x.tar.gz"' });
        return res.end(Buffer.from([0x1f, 0x8b, 0x08, 0x00]));
      }
      if (/^\/skills\/[^/]+\/staging\/[^/]+$/.test(url)) return send(200, { ok: true, data: { id: '20260923-100000', manifest: {}, report: {}, diffs: [] } });
      return send(404, { ok: false, error: 'NOT_FOUND', message: url });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('no address');
  return { server, port: address.port, calls, state };
}

async function withServer(run: (ctx: { baseUrl: string; fake: FakeServe; liveRoot: string; home: string }) => Promise<void>): Promise<void> {
  const prevDb = process.env.DATABASE_PATH;
  const prevRoot = process.env.PRISM_ROOT_USERS;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'skillwhet-authz-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  process.env.PRISM_ROOT_USERS = 'boss';
  await initializeDatabase();
  const fake = await startFakeServe();
  let server: Server | null = null;
  try {
    const users: Record<string, TestUser> = {};
    for (const name of ['alice', 'bob', 'boss']) {
      users[name] = { id: Number(userDb.createUser(name, 'hash').id), username: name, isRoot: name === 'boss' };
    }
    const liveRoot = path.join(tempDirectory, 'skills');
    await mkdir(path.join(liveRoot, 'marketing-audit'), { recursive: true });
    await writeFile(path.join(liveRoot, 'marketing-audit', 'SKILL.md'), '---\nname: marketing-audit\n---\n');
    await mkdir(path.join(liveRoot, 'onesql'), { recursive: true });
    await writeFile(path.join(liveRoot, 'onesql', 'SKILL.md'), '---\nname: onesql\n---\n');

    const fakeAuth: RequestHandler = (req, res, next) => {
      const name = String(req.headers['x-test-user'] ?? '');
      if (!users[name]) { res.status(401).json({ error: 'nope' }); return; }
      (req as unknown as { user?: TestUser }).user = users[name];
      next();
    };
    const app = express();
    app.use('/api/skillwhet', createSkillWhetRouter({
      authenticateToken: fakeAuth,
      client: new SkillWhetClient({ baseUrl: `http://127.0.0.1:${fake.port}`, token: 'tok' }),
      config: { home: path.join(tempDirectory, 'home'), label: '127.0.0.1:x', generatedToken: false, autostart: true },
      liveSkillsRoot: liveRoot,
      env: { PRISM_SKILL_SURVEY_RATE: '0.5', PRISM_SKILL_SURVEY_COOLDOWN_MIN: '60', PRISM_SKILLWHET_MAX_COST_USD: '1.5', PRISM_SKILLWHET_USER_DAILY_MAX_COST_USD: '2' },
    }));
    app.use((err: Error & { statusCode?: number; code?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(err.statusCode ?? 500).json({ success: false, error: err.message, code: err.code });
    });
    server = app.listen(0);
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address !== 'object') throw new Error('no listen address');
    await run({ baseUrl: `http://127.0.0.1:${address.port}`, fake, liveRoot, home: path.join(tempDirectory, 'home') });
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    closeConnection();
    if (prevDb === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = prevDb;
    if (prevRoot === undefined) delete process.env.PRISM_ROOT_USERS; else process.env.PRISM_ROOT_USERS = prevRoot;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const call = async (baseUrl: string, asUser: string, method: string, url: string, body?: unknown) => {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-user': asUser },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: { error?: string; code?: string; success?: boolean; data?: Record<string, unknown> } = {};
  try { parsed = JSON.parse(text) as typeof parsed; } catch { /* 非 JSON */ }
  return { status: response.status, body: parsed };
};

describe('/api/skillwhet 权限线', () => {
  test('读:登录即可;未登录 401;体检九项与调查配置一起回', async () => {
    await withServer(async ({ baseUrl }) => {
      const status = await call(baseUrl, 'alice', 'GET', '/api/skillwhet/status');
      assert.equal(status.status, 200);
      const checks = status.body.data?.checks as Record<string, boolean>;
      assert.equal(checks.serveReachable, true);
      assert.equal(checks.bandit, false);
      assert.equal(checks.unshare, false);
      assert.equal((status.body.data?.survey as { rate: number }).rate, 0.5);
      assert.equal((await call(baseUrl, 'nobody', 'GET', '/api/skillwhet/status')).status, 401);
      const skills = await call(baseUrl, 'bob', 'GET', '/api/skillwhet/skills');
      assert.equal(skills.status, 200);
      assert.deepEqual(skills.body.data?.liveOnly, ['onesql'], '技能库里有、还没导入的要列出来');
      assert.equal((skills.body.data?.skills as Array<{ name: string; live_exists: boolean }>).find((s) => s.name === 'marketing-audit')?.live_exists, true);
      // 路径类信息只给 root:普通用户拿不到监听地址 / 工作根 / 技能库目录
      assert.equal(status.body.data?.home, undefined);
      assert.equal(status.body.data?.target, undefined);
      assert.equal(skills.body.data?.liveRoot, undefined);
      const rootStatus = await call(baseUrl, 'boss', 'GET', '/api/skillwhet/status');
      assert.equal(typeof rootStatus.body.data?.home, 'string');
      assert.equal(typeof (await call(baseUrl, 'boss', 'GET', '/api/skillwhet/skills')).body.data?.liveRoot, 'string');
    });
  });

  test('从技能库导入 / 任务入库 / 移除:技能库来源只有 root', async () => {
    await withServer(async ({ baseUrl, fake, liveRoot }) => {
      const denied = await call(baseUrl, 'alice', 'POST', '/api/skillwhet/skills/marketing-audit/import', {});
      assert.equal(denied.status, 403);
      assert.match(denied.body.error ?? '', /root/);
      const ok = await call(baseUrl, 'boss', 'POST', '/api/skillwhet/skills/marketing-audit/import', {});
      assert.equal(ok.status, 200);
      const forwarded = fake.calls.find((c) => c.url === '/skills/marketing-audit/import');
      assert.ok(forwarded, '应转发到 serve');
      assert.equal(forwarded!.token, 'tok', '转发要带口令');
      assert.equal((forwarded!.body as { live_dir: string }).live_dir, path.join(liveRoot, 'marketing-audit'));
      // 技能库里没有的名字:404,而且不打到 serve
      const missing = await call(baseUrl, 'boss', 'POST', '/api/skillwhet/skills/ghost/import', {});
      assert.equal(missing.status, 404);
      assert.ok(!fake.calls.some((c) => c.url === '/skills/ghost/import'));
      // 任务入库:alice 对技能库来源 403,root 200;alice 对自己上传的 200
      assert.equal((await call(baseUrl, 'alice', 'POST', '/api/skillwhet/tasks', { skill: 'marketing-audit', content: '[]' })).status, 403);
      assert.equal((await call(baseUrl, 'boss', 'POST', '/api/skillwhet/tasks', { skill: 'marketing-audit', content: '[]' })).status, 200);
      assert.equal((await call(baseUrl, 'alice', 'POST', '/api/skillwhet/tasks', { skill: 'period-report', content: '[]' })).status, 200);
      const tagged = fake.calls.filter((c) => c.url === '/tasks' && c.method === 'POST').pop();
      assert.ok((tagged!.body as { tags: string[] }).tags.some((t) => t.startsWith('user:')), '任务要打用户标');
      // 移除:bob 对 alice 上传的 403,alice 本人 200,root 对技能库来源 200,alice 对技能库来源 403
      assert.equal((await call(baseUrl, 'bob', 'DELETE', '/api/skillwhet/skills/period-report')).status, 403);
      assert.equal((await call(baseUrl, 'alice', 'DELETE', '/api/skillwhet/skills/period-report')).status, 200);
      assert.equal((await call(baseUrl, 'alice', 'DELETE', '/api/skillwhet/skills/marketing-audit')).status, 403);
      assert.equal((await call(baseUrl, 'boss', 'DELETE', '/api/skillwhet/skills/marketing-audit')).status, 200);
      // 校验不落盘:谁都能
      assert.equal((await call(baseUrl, 'bob', 'POST', '/api/skillwhet/tasks/validate', { skill: 'marketing-audit', content: '[]' })).status, 200);
    });
  });

  test('上传:登录即可;上传者写进转发体;坏名字 400', async () => {
    await withServer(async ({ baseUrl, fake }) => {
      const res = await call(baseUrl, 'bob', 'POST', '/api/skillwhet/skills/upload', { name: 'my-skill', files: [{ rel: 'SKILL.md', content: '---\nname: my-skill\n---\n' }] });
      assert.equal(res.status, 200);
      const forwarded = fake.calls.find((c) => c.url === '/skills/upload');
      assert.equal((forwarded!.body as { uploaded_by: string }).uploaded_by, 'bob');
      assert.equal((await call(baseUrl, 'bob', 'POST', '/api/skillwhet/skills/upload', { name: '../x', files: [] })).status, 400);
      assert.equal((await call(baseUrl, 'bob', 'POST', '/api/skillwhet/skills/upload', { name: 'ok', files: 'nope' })).status, 400);
    });
  });

  test('技能详情带反馈统计;serve 的错误原样映射成状态码', async () => {
    await withServer(async ({ baseUrl }) => {
      messageFeedbackDb.upsert({ sessionId: 's', projectId: 'p', messageId: 'm_text', userId: 1, source: 'survey', verdict: -1, status: 'answered', note: '少一列', skillHint: 'marketing-audit' });
      const detail = await call(baseUrl, 'alice', 'GET', '/api/skillwhet/skills/marketing-audit');
      assert.equal(detail.status, 200);
      assert.equal((detail.body.data?.feedback as { bad: number }).bad, 1);
      const missing = await call(baseUrl, 'alice', 'GET', '/api/skillwhet/skills/ghost');
      assert.equal(missing.status, 404);
      assert.equal(missing.body.code, 'SKILLWHET_NOT_MANAGED');
    });
  });

  test('serve 不在:503,不是 500', async () => {
    const prevDb = process.env.DATABASE_PATH;
    const tempDirectory = await mkdtemp(path.join(tmpdir(), 'skillwhet-down-'));
    closeConnection();
    process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
    await initializeDatabase();
    const user = { id: Number(userDb.createUser('alice', 'h').id), username: 'alice' };
    const app = express();
    app.use('/api/skillwhet', createSkillWhetRouter({
      authenticateToken: (req, _res, next) => { (req as unknown as { user?: TestUser }).user = user; next(); },
      client: new SkillWhetClient({ baseUrl: 'http://127.0.0.1:1', token: 'tok', timeoutMs: 500 }),
      config: { home: tempDirectory, label: '127.0.0.1:1', generatedToken: false, autostart: false },
      liveSkillsRoot: tempDirectory,
    }));
    app.use((err: Error & { statusCode?: number; code?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(err.statusCode ?? 500).json({ error: err.message, code: err.code });
    });
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address() as { port: number };
    try {
      const status = await call(`http://127.0.0.1:${address.port}`, 'alice', 'GET', '/api/skillwhet/status');
      assert.equal(status.status, 200, '体检本身不该炸');
      assert.equal((status.body.data?.checks as { serveReachable: boolean }).serveReachable, false);
      const skills = await call(`http://127.0.0.1:${address.port}`, 'alice', 'GET', '/api/skillwhet/skills');
      assert.equal(skills.status, 503);
      assert.equal(skills.body.code, 'SKILLWHET_UNAVAILABLE');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      closeConnection();
      if (prevDb === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = prevDb;
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});

describe('/api/skillwhet gz 权限线:训练 / 采纳 / 发布 / 收件箱', () => {
  test('起训练:上传者能起自己的,别人 403;技能库来源只 root;预算被钳;G1 未过非 root 被拦、root 越过带审计', async () => {
    await withServer(async ({ baseUrl, fake }) => {
      // alice 起自己上传的 skill:预算被钳到 .env 上限,backend 参数被剥掉
      const ok = await call(baseUrl, 'alice', 'POST', '/api/skillwhet/jobs', { skill: 'period-report', args: { rounds: 2, max_cost_usd: 99, workers: 8, fast_backend: 'mock' } });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      const forwarded = fake.calls.find((c) => c.url === '/jobs' && c.method === 'POST')!.body as { args: Record<string, unknown>; tags: string[] };
      assert.equal(forwarded.args.max_cost_usd, 1.5);
      assert.equal(forwarded.args.workers, 2);
      assert.equal(forwarded.args.fast_backend, undefined);
      // hf2:被钳的参数告诉页面,不再悄悄按上限跑
      assert.ok(((ok.body.data as { clamped: string[] }).clamped ?? []).some((c) => c.startsWith('max_cost_usd 99')));
      assert.ok(forwarded.tags.includes('user:' + String((ok.body.data as { job: { tags: string[] } }).job.tags.find((t) => t.startsWith('user:'))!.slice(5))));
      // bob 对 alice 的 skill → 403;alice 对技能库来源 → 403
      assert.equal((await call(baseUrl, 'bob', 'POST', '/api/skillwhet/jobs', { skill: 'period-report', args: {} })).status, 403);
      assert.equal((await call(baseUrl, 'alice', 'POST', '/api/skillwhet/jobs', { skill: 'marketing-audit', args: {} })).status, 403);
      // 每日额度:alice 已有一个在途 $1.5,再来一个 $1.5 > $2 → 429
      const over = await call(baseUrl, 'alice', 'POST', '/api/skillwhet/jobs', { skill: 'period-report', args: {} });
      assert.equal(over.status, 429, JSON.stringify(over.body));
      assert.equal(over.body.code, 'SKILLWHET_DAILY_BUDGET');
      // G1 FAIL:非 root 被拦;root 能起且审计带 g1_override
      fake.state.gate['period-report'] = 'fail';
      fake.state.jobs.length = 0;
      const blocked = await call(baseUrl, 'alice', 'POST', '/api/skillwhet/jobs', { skill: 'period-report', args: {} });
      assert.equal(blocked.status, 403);
      assert.equal(blocked.body.code, 'SKILLWHET_G1_REQUIRED');
      const rootRun = await call(baseUrl, 'boss', 'POST', '/api/skillwhet/jobs', { skill: 'period-report', args: { fast_backend: 'mock' } });
      assert.equal(rootRun.status, 200, JSON.stringify(rootRun.body));
      const events = auditLogDb.list(50, 0, null).filter((row) => row.event === 'skillwhet_job_start');
      assert.ok(events.some((e) => e.detail.includes('g1_override')), 'root 越过 G1 要写进审计');
      // hf2:root 可越过 .env 的单次上限(到硬上限 50),审计记 cost_override;超过硬上限仍被钳
      fake.state.jobs.length = 0;
      const big = await call(baseUrl, 'boss', 'POST', '/api/skillwhet/jobs', { skill: 'period-report', args: { max_cost_usd: 10, max_minutes: 600 } });
      assert.equal(big.status, 200, JSON.stringify(big.body));
      const bigArgs = (fake.calls.filter((c) => c.url === '/jobs' && c.method === 'POST').pop()!.body as { args: Record<string, unknown> }).args;
      assert.equal(bigArgs.max_cost_usd, 10);
      assert.equal(bigArgs.max_minutes, 600);
      assert.ok(auditLogDb.list(50, 0, null).some((e) => e.event === 'skillwhet_job_start' && e.detail.includes('cost_override')));
      fake.state.jobs.length = 0;
      await call(baseUrl, 'boss', 'POST', '/api/skillwhet/jobs', { skill: 'period-report', args: { max_cost_usd: 500 } });
      assert.equal((fake.calls.filter((c) => c.url === '/jobs' && c.method === 'POST').pop()!.body as { args: Record<string, unknown> }).args.max_cost_usd, 50);
      // 取消:发起人或 root;bob 不行
      const id = (rootRun.body.data as { job: { id: string } }).job.id;
      assert.equal((await call(baseUrl, 'bob', 'POST', `/api/skillwhet/jobs/${id}/cancel`, {})).status, 403);
      assert.equal((await call(baseUrl, 'boss', 'POST', `/api/skillwhet/jobs/${id}/cancel`, {})).status, 200);
      // 读:登录即可
      assert.equal((await call(baseUrl, 'bob', 'GET', `/api/skillwhet/jobs/${id}/progress?after=0`)).status, 200);
      assert.equal((await call(baseUrl, 'bob', 'GET', '/api/skillwhet/jobs/budget')).status, 200);
      assert.equal((await call(baseUrl, 'bob', 'GET', '/api/skillwhet/jobs/not-an-id')).status, 400);
    });
  });

  test('采纳按副本权限;导出登录即可;发布 / 回滚只 root,技能库被改过拒绝并列文件', async () => {
    await withServer(async ({ baseUrl, fake, liveRoot, home }) => {
      assert.equal((await call(baseUrl, 'bob', 'POST', '/api/skillwhet/skills/period-report/staging/20260923-100001/adopt', {})).status, 403);
      assert.equal((await call(baseUrl, 'alice', 'POST', '/api/skillwhet/skills/period-report/staging/20260923-100001/adopt', {})).status, 200);
      assert.equal((await call(baseUrl, 'alice', 'POST', '/api/skillwhet/skills/marketing-audit/staging/20260923-100000/adopt', {})).status, 403);
      // ha:force 与 skip_release 各自透传,不互相连带
      assert.equal((await call(baseUrl, 'alice', 'POST', '/api/skillwhet/skills/period-report/staging/20260923-100001/adopt', { skip_release: true })).status, 200);
      const adoptBody = fake.calls.filter((c) => /\/adopt$/.test(c.url)).at(-1)!.body as { force: boolean; skip_release: boolean };
      assert.deepEqual(adoptBody, { force: false, skip_release: true });
      // 任务原文(full=1)要带 skill、且只给能动这个 skill 的人
      assert.equal((await call(baseUrl, 'alice', 'GET', '/api/skillwhet/tasks?full=1')).status, 400);
      assert.equal((await call(baseUrl, 'bob', 'GET', '/api/skillwhet/tasks?skill=period-report&full=1')).status, 403);
      assert.equal((await call(baseUrl, 'alice', 'GET', '/api/skillwhet/tasks?skill=period-report&full=1')).status, 200);
      assert.equal((await call(baseUrl, 'bob', 'GET', '/api/skillwhet/tasks?skill=period-report')).status, 200, '摘要仍然所有人可看');
      const exp = await fetch(`${baseUrl}/api/skillwhet/skills/marketing-audit/staging/20260923-100000/export`, { headers: { 'x-test-user': 'bob' } });
      assert.equal(exp.status, 200);
      assert.equal(exp.headers.get('content-type'), 'application/gzip');
      // 发布:副本要真的存在于 home/work/<n>(带 .evo/baseline);alice 403
      const work = path.join(home, 'work', 'marketing-audit');
      await mkdir(path.join(work, '.evo', 'baseline'), { recursive: true });
      await mkdir(path.join(work, 'scripts'), { recursive: true });
      await writeFile(path.join(work, 'SKILL.md'), '---\nname: marketing-audit\n---\n# v2\n');
      await writeFile(path.join(work, 'scripts', 'a.py'), 'x = 2\n');
      await writeFile(path.join(work, '.evo', 'junk.txt'), 'never published');
      await writeFile(path.join(work, 'import.json'), '{"name":"marketing-audit"}');
      assert.equal((await call(baseUrl, 'alice', 'POST', '/api/skillwhet/skills/marketing-audit/publish', {})).status, 403);
      // gz 审计 #6:没有导入记录(或记录不指向技能库里的这个目录)→ 409,不整目录替换
      const noRecord = await call(baseUrl, 'boss', 'POST', '/api/skillwhet/skills/marketing-audit/publish', {});
      assert.equal(noRecord.status, 409);
      assert.equal(noRecord.body.code, 'SKILLWHET_NO_IMPORT_RECORD');
      fake.state.managed['marketing-audit'].imported_from = path.join(liveRoot, 'elsewhere');
      assert.equal((await call(baseUrl, 'boss', 'POST', '/api/skillwhet/skills/marketing-audit/publish', {})).status, 409);
      fake.state.managed['marketing-audit'].imported_from = path.join(liveRoot, 'marketing-audit');
      fake.state.drift = ['scripts/a.py'];
      const changed = await call(baseUrl, 'boss', 'POST', '/api/skillwhet/skills/marketing-audit/publish', {});
      assert.equal(changed.status, 409);
      assert.match(String(changed.body.error), /scripts\/a\.py/);
      fake.state.drift = [];
      const published = await call(baseUrl, 'boss', 'POST', '/api/skillwhet/skills/marketing-audit/publish', {});
      assert.equal(published.status, 200, JSON.stringify(published.body));
      const live = path.join(liveRoot, 'marketing-audit');
      assert.equal(await readFile(path.join(live, 'SKILL.md'), 'utf8'), '---\nname: marketing-audit\n---\n# v2\n');
      assert.equal(await readFile(path.join(live, 'scripts', 'a.py'), 'utf8'), 'x = 2\n');
      assert.equal(fsExists(path.join(live, '.evo')), false, '.evo 不进技能库');
      assert.equal(fsExists(path.join(live, 'import.json')), false, 'import.json(受管记录)不进技能库');
      const rollbackDir = path.join(home, 'rollback', 'marketing-audit');
      assert.equal((await readdir(rollbackDir)).length, 1, '旧版进 rollback');
      assert.ok(fake.calls.some((c) => /\/skills\/marketing-audit\/rebase$/.test(c.url)), '发布后让 serve 重新钉 sha');
      // 回滚
      const list = await call(baseUrl, 'bob', 'GET', '/api/skillwhet/skills/marketing-audit/rollbacks');
      const ts = (list.body.data as { rollbacks: Array<{ ts: string }> }).rollbacks[0].ts;
      assert.equal((await call(baseUrl, 'alice', 'POST', '/api/skillwhet/skills/marketing-audit/rollback', { to: ts })).status, 403);
      assert.equal((await call(baseUrl, 'boss', 'POST', '/api/skillwhet/skills/marketing-audit/rollback', { to: ts })).status, 200);
      assert.equal(await readFile(path.join(live, 'SKILL.md'), 'utf8'), '---\nname: marketing-audit\n---\n');
      // 发布为新技能:已存在 → 409;上传来源不存在 → 建出来
      assert.equal((await call(baseUrl, 'boss', 'POST', '/api/skillwhet/skills/marketing-audit/publish-as-new', {})).status, 409);
      const work2 = path.join(home, 'work', 'period-report');
      await mkdir(path.join(work2, '.evo', 'baseline'), { recursive: true });
      await writeFile(path.join(work2, 'SKILL.md'), '---\nname: period-report\n---\n');
      assert.equal((await call(baseUrl, 'boss', 'POST', '/api/skillwhet/skills/period-report/publish-as-new', {})).status, 200);
      assert.ok(fsExists(path.join(liveRoot, 'period-report', 'SKILL.md')));
      const audits = auditLogDb.list(50, 0, null).map((r) => r.event);
      assert.ok(audits.includes('skillwhet_publish') && audits.includes('skillwhet_rollback') && audits.includes('skillwhet_adopt'));
      // hd:发布 / 回滚都告诉 serve 记一笔(谁、哪份 staging);记录登录即可看,发起人只给 root
      const rebases = fake.calls.filter((c) => /\/skills\/marketing-audit\/rebase$/.test(c.url)).map((c) => c.body as { event?: string; by?: string; to?: string });
      assert.ok(rebases.some((b) => b.event === 'publish' && b.by === 'boss'), JSON.stringify(rebases));
      assert.ok(rebases.some((b) => b.event === 'rollback' && b.by === 'boss' && b.to === ts));
      const asRoot = await call(baseUrl, 'boss', 'GET', '/api/skillwhet/skills/marketing-audit/publishes');
      const rootRows = (asRoot.body.data as { history: Array<{ event: string; by: string | null }> }).history;
      assert.equal(rootRows[0].event, 'rollback');
      assert.equal(rootRows[0].by, 'boss');
      const asUser = await call(baseUrl, 'alice', 'GET', '/api/skillwhet/skills/marketing-audit/publishes');
      assert.equal(asUser.status, 200);
      assert.ok((asUser.body.data as { history: Array<{ by: string | null }> }).history.every((r) => r.by === null));
    });
  });

  test('反馈收件箱:root 才能看;入库回填 task_id,好评不进', async () => {
    await withServer(async ({ baseUrl, fake }) => {
      assert.equal((await call(baseUrl, 'alice', 'GET', '/api/skillwhet/feedback/inbox')).status, 403);
      const base = { sessionId: 'sess-x', projectId: '7', userId: 1, source: 'vote' as const, status: 'answered' as const, skillHint: 'marketing-audit' };
      const bad = messageFeedbackDb.upsert({ ...base, messageId: 'm1_text', verdict: -1, note: '少一列', expectedOutput: '小红书单列' });
      messageFeedbackDb.upsert({ ...base, messageId: 'm2_text', verdict: 1, note: '很好' });        // 好评不进
      messageFeedbackDb.upsert({ ...base, messageId: 'm3_text', verdict: 0, note: '一般般,少了渠道口径' });   // 只有待优化点 → rubric
      const inbox = await call(baseUrl, 'boss', 'GET', '/api/skillwhet/feedback/inbox?skill=marketing-audit');
      const rows = inbox.body.data?.inbox as Array<{ id: number; referenceKind: string }>;
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.map((r) => r.referenceKind).sort(), ['exact', 'rubric']);
      const accept = await call(baseUrl, 'boss', 'POST', '/api/skillwhet/feedback/inbox/accept', { ids: rows.map((r) => r.id) });
      assert.equal(accept.status, 200, JSON.stringify(accept.body));
      const sent = fake.calls.find((c) => c.url === '/tasks' && c.method === 'POST' && (c.body as { source?: string }).source === 'feedback')!.body as { records: Array<Record<string, unknown>> };
      assert.equal(sent.records.length, 2);
      assert.ok(sent.records.some((r) => r.expected_output === '小红书单列' && r.outcome === 'fail'));
      assert.ok(sent.records.some((r) => typeof r.rubric === 'string' && r.outcome === 'mixed'));
      assert.equal(messageFeedbackDb.get('m1_text', 1)?.task_id, `fb_${bad.id}`);
      assert.equal((await call(baseUrl, 'boss', 'GET', '/api/skillwhet/feedback/inbox?skill=marketing-audit')).body.data?.inbox.length, 0);
      // gz 审计 #2 / #8:skill_hint 像路径的行不转(serve 侧会把它当目录名);好评 / 已转过的 id 传进来也不标记
      const evil = messageFeedbackDb.upsert({ ...base, messageId: 'm4_text', verdict: -1, note: '这条的 skill_hint 是路径', skillHint: '../../.claude/skills/pdf' });
      const good = messageFeedbackDb.get('m2_text', 1)!;
      const before = fake.calls.length;
      const again = await call(baseUrl, 'boss', 'POST', '/api/skillwhet/feedback/inbox/accept', { ids: [evil.id, good.id, bad.id] });
      assert.equal(again.status, 200, JSON.stringify(again.body));
      assert.deepEqual(again.body.data?.accepted, []);
      assert.deepEqual((again.body.data?.skipped as Array<{ id: number; reason: string }>).map((r) => r.reason).sort(), ['already_task', 'bad_skill', 'not_inbox']);
      assert.equal(fake.calls.slice(before).filter((c) => c.url === '/tasks' && c.method === 'POST').length, 0, '没有一条到 serve');
      assert.equal(messageFeedbackDb.get('m4_text', 1)?.task_id ?? null, null);
      assert.equal(messageFeedbackDb.get('m2_text', 1)?.task_id ?? null, null);
    });
  });
});

describe('/api/skillwhet ha 权限线:从会话挖任务 / 反馈叠加层 / 留出集评估', () => {
  test('挖任务全链 root 才能做;白名单只含所选项目里看得见的 Claude 会话;叠加层按 provider 会话 id、对上原生 uuid、原文脱敏', async () => {
    await withServer(async ({ baseUrl, fake }) => {
      const boss = userDb.getUserByUsername('boss')!;
      const projA = path.join(tmpdir(), 'ha-proj-a');
      const projB = path.join(tmpdir(), 'ha-proj-b');
      projectsDb.createProjectPath(projA, null, Number(boss.id));
      projectsDb.createProjectPath(projB, null, Number(boss.id));
      sessionsDb.createAppSession('sess-a1', 'claude', projA, Number(boss.id));
      sessionsDb.createAppSession('sess-b1', 'claude', projB, Number(boss.id));
      // 白名单 / 叠加层按 transcript 文件名(= provider 会话 id)走,不是 app 会话 id
      assert.ok(sessionsDb.assignProviderSessionId('sess-a1', 'prov-a1'));
      assert.ok(sessionsDb.assignProviderSessionId('sess-b1', 'prov-b1'));
      sessionsDb.createAppSession('sess-c1', 'claude', projA, Number(boss.id));   // 没有 provider id:不可挖
      const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e';
      const base = { projectId: '7', userId: Number(boss.id), source: 'vote' as const, status: 'answered' as const, skillHint: 'marketing-audit' };
      messageFeedbackDb.upsert({ ...base, sessionId: 'sess-a1', messageId: `${uuid}_text`, verdict: -1, note: 'token=abcdefghijklmnop 这里算错了' });
      messageFeedbackDb.upsert({ ...base, sessionId: 'sess-a1', messageId: 'user_123', verdict: -1, note: '网关气泡,没有原生 uuid' });
      messageFeedbackDb.upsert({ ...base, sessionId: 'sess-b1', messageId: `${uuid.replace('0f8f', '1f8f')}_text`, verdict: 1, note: '好' });

      for (const [method, url, body] of [
        ['GET', '/api/skillwhet/harvest/projects', undefined],
        ['POST', '/api/skillwhet/harvest', { skill: 'marketing-audit', projects: [projA], dry_run: true }],
        ['GET', '/api/skillwhet/feedback/overlay?skill=marketing-audit', undefined],
      ] as const) {
        assert.equal((await call(baseUrl, 'alice', method, url, body)).status, 403, url);
      }
      const projects = await call(baseUrl, 'boss', 'GET', '/api/skillwhet/harvest/projects');
      assert.equal(projects.status, 200);
      assert.deepEqual((projects.body.data.projects as Array<{ path: string }>).map((p) => p.path).sort(), [projA, projB].sort());

      const started = await call(baseUrl, 'boss', 'POST', '/api/skillwhet/harvest', { skill: 'marketing-audit', projects: [projA], dry_run: true, since: '2020-01-01' });
      assert.equal(started.status, 200, JSON.stringify(started.body));
      const sent = fake.calls.filter((c) => c.url === '/jobs' && c.method === 'POST').at(-1)!.body as { kind: string; args: { sessions: string[]; feedback_overlay: Record<string, Array<{ message_uuid: string; note: string }>>; dry_run: boolean } };
      assert.equal(sent.kind, 'harvest');
      assert.deepEqual(sent.args.sessions, ['prov-a1'], '只有所选项目里、有 transcript 的会话');
      assert.equal(sent.args.dry_run, true);
      assert.deepEqual(Object.keys(sent.args.feedback_overlay), ['prov-a1']);
      assert.equal(sent.args.feedback_overlay['prov-a1'].length, 1, '网关气泡(没有原生 uuid)丢掉');
      assert.equal(sent.args.feedback_overlay['prov-a1'][0].message_uuid, uuid);
      assert.ok(!sent.args.feedback_overlay['prov-a1'][0].note.includes('abcdefghijklmnop'), '脱敏');
      assert.equal((await call(baseUrl, 'boss', 'POST', '/api/skillwhet/harvest', { skill: 'marketing-audit', projects: [] })).status, 400);
      assert.equal((await call(baseUrl, 'boss', 'POST', '/api/skillwhet/harvest', { skill: 'marketing-audit', projects: [projA], since: 'yesterday' })).status, 400);

      const jobId = (started.body.data.job as { id: string }).id;
      assert.equal((await call(baseUrl, 'alice', 'GET', `/api/skillwhet/jobs/${jobId}/result`)).status, 403, 'harvest 结果只给 root');
      assert.equal((await call(baseUrl, 'boss', 'GET', `/api/skillwhet/jobs/${jobId}/result`)).status, 200);
      assert.equal((await call(baseUrl, 'alice', 'POST', `/api/skillwhet/jobs/${jobId}/import`, {})).status, 403);
      const imported = await call(baseUrl, 'boss', 'POST', `/api/skillwhet/jobs/${jobId}/import`, { task_ids: ['h_1'] });
      assert.equal(imported.status, 200);
      const importBody = fake.calls.filter((c) => c.url === `/jobs/${jobId}/import`).at(-1)!.body as { task_ids: string[]; tags: string[] };
      assert.deepEqual(importBody.task_ids, ['h_1']);
      assert.deepEqual(importBody.tags, ['accepted_by:boss']);

      const overlay = await call(baseUrl, 'boss', 'GET', '/api/skillwhet/feedback/overlay?skill=marketing-audit');
      assert.equal(overlay.status, 200);
      assert.equal(overlay.body.data.rows, 2);
      const audits = auditLogDb.list(200).map((row) => row.event);
      assert.ok(audits.includes('skillwhet_harvest') && audits.includes('skillwhet_harvest_import'));
    });
  });

  test('留出集评估:权限同采纳;非 root 去掉后端字段、要 G1;runner 沿用产出那份 staging 的训练', async () => {
    await withServer(async ({ baseUrl, fake }) => {
      // 先起一个训练作业并假装它产出了 20260923-100001
      const trained = await call(baseUrl, 'alice', 'POST', '/api/skillwhet/jobs', { skill: 'period-report', args: { rounds: 1, runner: 'pytest', test_dir: 'tests/unit', fast_backend: 'mock' } });
      assert.equal(trained.status, 200, JSON.stringify(trained.body));
      fake.state.jobs[0].staging = '20260923-100001';
      fake.state.jobs[0].state = 'done';
      assert.equal((await call(baseUrl, 'bob', 'POST', '/api/skillwhet/skills/period-report/staging/20260923-100001/release-eval', {})).status, 403);
      assert.equal((await call(baseUrl, 'alice', 'POST', '/api/skillwhet/skills/period-report/staging/not-an-id/release-eval', {})).status, 400);
      const ok = await call(baseUrl, 'alice', 'POST', '/api/skillwhet/skills/period-report/staging/20260923-100001/release-eval', {});
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      const sent = fake.calls.filter((c) => c.url === '/jobs' && c.method === 'POST').at(-1)!.body as { kind: string; args: Record<string, unknown> };
      assert.equal(sent.kind, 'release_eval');
      assert.deepEqual(sent.args, { staging: '20260923-100001', runner: 'pytest', test_dir: 'tests/unit', workers: 2, max_minutes: 120 }, '后端字段一律去掉,其余沿用');
      fake.state.gate['period-report'] = 'fail';
      fake.state.jobs.length = 0;
      assert.equal((await call(baseUrl, 'alice', 'POST', '/api/skillwhet/skills/period-report/staging/20260923-100001/release-eval', {})).status, 403, 'G1 不过');
    });
  });
});

describe('/api/skillwhet he 权限线:夜训计划 / 从中断处续跑', () => {
  test('夜训:看登录即可(非 root 不给 updated_by);纳入 / 改设置只 root,参数校验,没 bootstrap 不许纳入,审计', async () => {
    await withServer(async ({ baseUrl }) => {
      const put = (who: string, skill: string, body: unknown) => call(baseUrl, who, 'PUT', `/api/skillwhet/nightly/${skill}`, body);
      assert.equal((await put('alice', 'marketing-audit', { enrolled: true })).status, 403);
      assert.equal((await put('boss', 'marketing-audit', { enrolled: true, window_start: '2:00' })).status, 400);
      assert.equal((await put('boss', 'marketing-audit', { enrolled: true, window_start: '03:00', window_end: '03:00' })).status, 400);
      assert.equal((await put('boss', 'marketing-audit', { enrolled: true, max_cost_usd: 150 })).status, 400, 'hi:夜训单次硬上限 100');
      assert.equal((await put('boss', 'marketing-audit', { enrolled: true, rounds: 21 })).status, 400, 'hi:轮数最多 20');
      assert.equal((await put('boss', 'marketing-audit', { enrolled: true, rounds: 0 })).status, 400);
      assert.equal((await put('boss', 'marketing-audit', { enrolled: true, config: { fast_backend: 'http://evil' , bogus: 1 } })).status, 400);
      assert.equal((await put('boss', 'marketing-audit', { enrolled: true, config: { slow_model: 'opus', eval_model: 'opus' } })).status, 400, '评估 ≠ 提议');
      const notBoot = await put('boss', 'period-report', { enrolled: true });
      assert.equal(notBoot.status, 409);
      const ok = await put('boss', 'marketing-audit', { enrolled: true, window_start: '22:00', window_end: '05:30', rounds: 3, max_cost_usd: 1, min_new_tasks: 4, config: { runner: 'agent', slow_model: 'sonnet', eval_model: 'opus' } });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      const plan = (ok.body.data as { plan: { enrolled: boolean; window_start: string; config: Record<string, unknown> } }).plan;
      assert.equal(plan.enrolled, true);
      assert.equal(plan.window_start, '22:00');
      assert.equal(plan.config.runner, 'agent');
      const big = await put('boss', 'marketing-audit', { enrolled: true, rounds: 20, max_cost_usd: 100 });
      assert.equal(big.status, 200, JSON.stringify(big.body));
      const bigPlan = (big.body.data as { plan: { rounds: number; max_cost_usd: number } }).plan;
      assert.equal(bigPlan.rounds, 20);
      assert.equal(bigPlan.max_cost_usd, 100, 'root 可越过 .env 单次上限 1.5,到夜训硬上限 100');
      const meta = (await call(baseUrl, 'alice', 'GET', '/api/skillwhet/nightly')).body.data as { nightlyMaxCostUsd: number; nightlyHardMaxCostUsd: number; nightlyMaxRounds: number };
      assert.equal(meta.nightlyMaxCostUsd, 100, '一晚合计默认 100');
      assert.equal(meta.nightlyHardMaxCostUsd, 100);
      assert.equal(meta.nightlyMaxRounds, 20);
      const asAlice = await call(baseUrl, 'alice', 'GET', '/api/skillwhet/nightly');
      assert.equal(asAlice.status, 200);
      const rows = (asAlice.body.data as { plans: Array<{ skill_name: string; updated_by: number | null }>; serverTime: { local: string } }).plans;
      assert.equal(rows[0].skill_name, 'marketing-audit');
      assert.equal(rows[0].updated_by, null);
      assert.match((asAlice.body.data as { serverTime: { local: string } }).serverTime.local, /^\d\d:\d\d$/);
      assert.equal((await put('boss', 'marketing-audit', { enrolled: false })).status, 200);
      const events = auditLogDb.list(50, 0, null).map((r) => r.event);
      assert.ok(events.includes('skillwhet_nightly_enroll') && events.includes('skillwhet_nightly_unenroll'));
    });
  });

  test('续跑:只有中断 / 失败 / 取消的训练;发起人或 root;没有对得上的 checkpoint 409;续跑带 resume', async () => {
    await withServer(async ({ baseUrl, fake }) => {
      const alice = await call(baseUrl, 'alice', 'POST', '/api/skillwhet/jobs', { skill: 'period-report', args: { rounds: 2 } });
      assert.equal(alice.status, 200, JSON.stringify(alice.body));
      const job = fake.state.jobs[fake.state.jobs.length - 1];
      const id = String(job.id);
      assert.equal((await call(baseUrl, 'alice', 'POST', `/api/skillwhet/jobs/${id}/resume`)).status, 409, '还在排队的不能续');
      job.state = 'interrupted';
      job.cost_usd = 0.2;              // serve 按已完成各轮的 round_end 记中断作业花了多少
      assert.equal((await call(baseUrl, 'bob', 'POST', `/api/skillwhet/jobs/${id}/resume`)).status, 403);
      const none = await call(baseUrl, 'alice', 'POST', `/api/skillwhet/jobs/${id}/resume`);
      assert.equal(none.status, 409);
      assert.equal(none.body.code, 'SKILLWHET_NO_CHECKPOINT');
      fake.state.checkpoint['period-report'] = { exists: true, matches: false, round: 1 };
      assert.match(String((await call(baseUrl, 'alice', 'POST', `/api/skillwhet/jobs/${id}/resume`)).body.error), /变了/);
      fake.state.checkpoint['period-report'] = { exists: true, matches: true, round: 1, saved_at: '2020-01-01T00:00:00Z' } as never;
      assert.match(String((await call(baseUrl, 'alice', 'POST', `/api/skillwhet/jobs/${id}/resume`)).body.error), /不是这次作业/);
      fake.state.checkpoint['period-report'] = { exists: true, matches: true, round: 1, saved_at: new Date().toISOString() } as never;
      const resumed = await call(baseUrl, 'alice', 'POST', `/api/skillwhet/jobs/${id}/resume`);
      assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
      const posted = fake.calls.filter((c) => c.method === 'POST' && c.url === '/jobs').pop()?.body as { args: Record<string, unknown>; tags: string[] };
      assert.equal(posted.args.resume, true);
      assert.equal(posted.args.rounds, 2);
      assert.ok(posted.tags.includes(`user:${String(job.tags && (job.tags as string[]).find((t) => t.startsWith('user:'))?.slice(5))}`));
      assert.ok(auditLogDb.list(20, 0, null).some((r) => r.event === 'skillwhet_job_start' && /resume_of=/.test(String(r.detail))));
      const ck = await call(baseUrl, 'bob', 'GET', '/api/skillwhet/skills/period-report/checkpoint');
      assert.equal(ck.status, 200);
    });
  });
});
