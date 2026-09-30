import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import http, { type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import express, { type RequestHandler } from 'express';
import { describe, test } from 'vitest';

import { closeConnection, initializeDatabase, skillWhetNightlyDb, userDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

import { NightlyScheduler } from '../services/nightly-scheduler.service.js';
import { redactSecrets } from '../services/redact.js';
import { SkillWhetClient, translateServeError } from '../services/skillwhet-client.js';
import { createSkillWhetRouter } from '../skillwhet.routes.js';

/**
 * hl 修复轮(2026-09-29)—— 切片 C(技能优化模块,Prism 侧):
 *   静态 P2-22 副本内部读接口加归属;静态 P1-10 非 root 模型白名单(含 target_model);
 *   静态 P2-23 排队中取消不占额度;动态 P2-15 夜训 skipped_busy / G1 未过不记整晚;
 *   动态 P2-18 / 静态 P3 脱敏与 SkillWhet 对齐;动态 P3 serve 英文错误映射成中文;续跑后再续跑的提示。
 * 与 skillwhet-authz.test.ts 同一套路:假 serve 顶替,测的是 Prism 这一侧的判断。
 */
type TestUser = { id: number; username: string; isRoot?: boolean };

type Fake = { server: Server; port: number; calls: Array<{ method: string; url: string; body: unknown }>; jobs: Array<Record<string, unknown>>; g1: { verdict: string; detail?: Record<string, unknown> } };

async function startFakeServe(): Promise<Fake> {
  const calls: Fake['calls'] = [];
  const jobs: Fake['jobs'] = [];
  const lastGate = { passed: false, stopped_at: '', results: [{ gate: 'G4.unit', verdict: 'fail', findings: [{ rule: 'pytest-crashed', message: 'SECRET-TEST-OUTPUT' }], detail: { rc: 2 } }] };
  const managed: Record<string, Record<string, unknown>> = {
    'lib-skill': { name: 'lib-skill', source: 'live', uploaded_by: '', bootstrapped: true, imported_from: '/x', last_gate: lastGate },
    'alice-skill': { name: 'alice-skill', source: 'upload', uploaded_by: 'alice', bootstrapped: true, last_gate: lastGate },
  };
  const g1: Fake['g1'] = { verdict: 'pass' };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      const url = req.url ?? '';
      calls.push({ method: req.method ?? '', url, body });
      const send = (status: number, payload: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
      const st = url.match(/^\/skills\/([^/]+)\/status$/);
      if (st) { const item = managed[decodeURIComponent(st[1])]; return item ? send(200, { ok: true, data: item }) : send(404, { ok: false, error: 'NOT_MANAGED', message: `no managed copy of '${st[1]}'` }); }
      const sub = url.match(/^\/skills\/([^/]+)\/(gate|facts|contract|wiki|provenance|ledger|drift|checkpoint)$/);
      if (url === '/skills' && req.method === 'GET') return send(200, { ok: true, data: { skills: Object.values(managed) } });
      if (/^\/skills\/[^/]+\/staging\/[^/]+$/.test(url)) return send(200, { ok: true, data: { id: 's', diffs: [{ rel: 'a.py', diff: 'SECRET' }] } });
      if (/^\/skills\/[^/]+\/staging\/[^/]+\/export$/.test(url)) { res.writeHead(200, { 'content-type': 'application/gzip' }); return res.end(Buffer.from([1])); }
      const lg = url.match(/^\/jobs\/([^/]+)\/log/);
      if (lg) return send(200, { ok: true, data: { log: 'SECRET-TEST-OUTPUT' } });
      if (sub) {
        if (sub[2] === 'gate') return send(200, { ok: true, data: { cached: true, passed: g1.verdict === 'pass', results: [{ gate: 'G1.security', verdict: g1.verdict, detail: g1.detail ?? {} }] } });
        if (sub[2] === 'checkpoint') return send(200, { ok: true, data: { exists: false } });
        return send(200, { ok: true, data: { sub: sub[2] } });
      }
      if (url === '/jobs' && req.method === 'POST') {
        const job = { id: `job_20260929-1000${String(jobs.length).padStart(2, '0')}_abcd`, kind: 'train', skill: body.skill, args: body.args, tags: body.tags, state: 'queued', created_at: new Date().toISOString(), cost_usd: null };
        jobs.push(job);
        return send(200, { ok: true, data: { job, position: 0 } });
      }
      if (url.startsWith('/jobs?') || url === '/jobs') return send(200, { ok: true, data: { jobs } });
      const j = url.match(/^\/jobs\/([^/]+)$/);
      if (j) { const job = jobs.find((x) => x.id === j[1]); return job ? send(200, { ok: true, data: { job } }) : send(404, { ok: false, error: 'JOB_NOT_FOUND', message: 'no job' }); }
      if (url === '/skills/upload') return send(409, { ok: false, error: 'NAME_MISMATCH', message: "SKILL.md declares name 'foo' but the folder is 'bar'" });
      return send(404, { ok: false, error: 'NOT_FOUND', message: url });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('no address');
  return { server, port: address.port, calls, jobs, g1 };
}

async function withServer(run: (ctx: { baseUrl: string; fake: Fake }) => Promise<void>, env: Record<string, string> = {}): Promise<void> {
  const prevDb = process.env.DATABASE_PATH;
  const prevRoot = process.env.PRISM_ROOT_USERS;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'skillwhet-hl-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  process.env.PRISM_ROOT_USERS = 'boss';
  await initializeDatabase();
  const fake = await startFakeServe();
  let server: Server | null = null;
  try {
    const users: Record<string, TestUser> = {};
    for (const name of ['alice', 'bob', 'boss']) users[name] = { id: Number(userDb.createUser(name, 'hash').id), username: name, isRoot: name === 'boss' };
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
      config: { home: path.join(tempDirectory, 'home'), label: 'x', generatedToken: false, autostart: true },
      liveSkillsRoot: path.join(tempDirectory, 'skills'),
      env: { PRISM_SKILLWHET_MAX_COST_USD: '1', PRISM_SKILLWHET_USER_DAILY_MAX_COST_USD: '2', ...env },
    }));
    app.use((err: Error & { statusCode?: number; code?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(err.statusCode ?? 500).json({ success: false, error: err.message, code: err.code });
    });
    server = app.listen(0);
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address !== 'object') throw new Error('no listen address');
    await run({ baseUrl: `http://127.0.0.1:${address.port}`, fake });
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
  const response = await fetch(`${baseUrl}${url}`, { method, headers: { 'content-type': 'application/json', 'x-test-user': asUser }, body: body === undefined ? undefined : JSON.stringify(body) });
  let parsed: { error?: string; code?: string; data?: Record<string, unknown> } = {};
  try { parsed = JSON.parse(await response.text()) as typeof parsed; } catch { /* 非 JSON */ }
  return { status: response.status, body: parsed };
};

describe('hl · 技能优化(Prism 侧)', () => {
  test('复核 P2-5:上传来源的体检细节 / staging 详情 / 导出 / 作业日志,非本人非 root 收口', async () => {
    await withServer(async ({ baseUrl, fake }) => {
      const list = await call(baseUrl, 'bob', 'GET', '/api/skillwhet/skills');
      const skills = list.body.data?.skills as Array<{ name: string; last_gate: { results: Array<{ findings: unknown[]; detail?: unknown }> } }>;
      const alices = skills.find((x) => x.name === 'alice-skill')!;
      assert.deepEqual(alices.last_gate.results[0].findings, []);
      assert.equal(alices.last_gate.results[0].detail, undefined);
      assert.ok(!JSON.stringify(list.body).includes('SECRET-TEST-OUTPUT') || JSON.stringify(skills.find((x) => x.name === 'lib-skill')).includes('SECRET'),
        '只有技能库来源的细节还在');
      assert.ok(!JSON.stringify(alices).includes('SECRET'));
      const one = await call(baseUrl, 'bob', 'GET', '/api/skillwhet/skills/alice-skill');
      assert.ok(!JSON.stringify(one.body).includes('SECRET'));
      assert.ok(JSON.stringify((await call(baseUrl, 'alice', 'GET', '/api/skillwhet/skills/alice-skill')).body).includes('SECRET'), '本人看得到');
      assert.ok(JSON.stringify((await call(baseUrl, 'boss', 'GET', '/api/skillwhet/skills/alice-skill')).body).includes('SECRET'), 'root 看得到');
      assert.equal((await call(baseUrl, 'bob', 'GET', '/api/skillwhet/skills/alice-skill/staging/20260923-100000')).status, 403);
      assert.equal((await call(baseUrl, 'bob', 'GET', '/api/skillwhet/skills/alice-skill/staging/20260923-100000/export')).status, 403);
      assert.equal((await call(baseUrl, 'alice', 'GET', '/api/skillwhet/skills/alice-skill/staging/20260923-100000')).status, 200);
      assert.equal((await call(baseUrl, 'bob', 'GET', '/api/skillwhet/skills/lib-skill/staging/20260923-100000')).status, 200);
      await call(baseUrl, 'alice', 'POST', '/api/skillwhet/jobs', { skill: 'alice-skill', args: {} });
      const jobId = String(fake.jobs[0].id);
      assert.equal((await call(baseUrl, 'bob', 'GET', `/api/skillwhet/jobs/${jobId}/log`)).status, 403);
      assert.equal((await call(baseUrl, 'alice', 'GET', `/api/skillwhet/jobs/${jobId}/log`)).status, 200);
      assert.equal((await call(baseUrl, 'boss', 'GET', `/api/skillwhet/jobs/${jobId}/log`)).status, 200);
    });
  });

  test('复核 P2-4:G1 因服务器缺 bandit 而 SKIP —— 报错写清缺什么、怎么装', async () => {
    await withServer(async ({ baseUrl, fake }) => {
      fake.g1.verdict = 'skip';
      fake.g1.detail = { missing_tools: ['bandit'] };
      const r = await call(baseUrl, 'alice', 'POST', '/api/skillwhet/jobs', { skill: 'alice-skill', args: {} });
      assert.equal(r.status, 403);
      assert.equal(r.body.code, 'SKILLWHET_G1_REQUIRED');
      assert.match(String(r.body.error), /缺 bandit/);
      assert.match(String(r.body.error), /pip install bandit/);
      fake.g1.detail = {};
      assert.match(String((await call(baseUrl, 'alice', 'POST', '/api/skillwhet/jobs', { skill: 'alice-skill', args: {} })).body.error), /G1 安全门是 SKIP/);
    });
  });

  test('静态 P2-22:上传来源的副本内部只给上传者本人或 root;技能库来源登录即可', async () => {
    await withServer(async ({ baseUrl }) => {
      for (const sub of ['gate', 'facts', 'contract', 'wiki', 'provenance', 'ledger', 'drift']) {
        assert.equal((await call(baseUrl, 'bob', 'GET', `/api/skillwhet/skills/alice-skill/${sub}`)).status, 403, sub);
        assert.equal((await call(baseUrl, 'alice', 'GET', `/api/skillwhet/skills/alice-skill/${sub}`)).status, 200, sub);
        assert.equal((await call(baseUrl, 'boss', 'GET', `/api/skillwhet/skills/alice-skill/${sub}`)).status, 200, sub);
        assert.equal((await call(baseUrl, 'bob', 'GET', `/api/skillwhet/skills/lib-skill/${sub}`)).status, 200, sub);
      }
    });
  });

  test('静态 P1-10:非 root 的 target_model(与另三个模型)走白名单;root 不受限', async () => {
    await withServer(async ({ baseUrl, fake }) => {
      const bad = await call(baseUrl, 'alice', 'POST', '/api/skillwhet/jobs', { skill: 'alice-skill', args: { runner: 'agent', target_model: 'claude-opus-4-1-20250805' } });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.code, 'SKILLWHET_MODEL_NOT_ALLOWED');
      assert.equal(fake.jobs.length, 0);
      const ok = await call(baseUrl, 'alice', 'POST', '/api/skillwhet/jobs', { skill: 'alice-skill', args: { runner: 'agent', target_model: 'sonnet', fast_model: 'haiku' } });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      const root = await call(baseUrl, 'boss', 'POST', '/api/skillwhet/jobs', { skill: 'lib-skill', args: { target_model: 'claude-opus-4-1-20250805' } });
      assert.equal(root.status, 200);
      assert.equal((fake.jobs[1].args as Record<string, unknown>).target_model, 'claude-opus-4-1-20250805');
    }, { PRISM_SKILLWHET_MODEL_ALLOWLIST: 'haiku, sonnet' });
  });

  test('静态 P2-23:排队中就取消的作业不占当日额度;跑过的没算出费用仍按上限保守计', async () => {
    await withServer(async ({ baseUrl, fake }) => {
      const first = await call(baseUrl, 'alice', 'POST', '/api/skillwhet/jobs', { skill: 'alice-skill', args: { max_cost_usd: 1 } });
      assert.equal(first.status, 200);
      fake.jobs[0].state = 'cancelled';           // 从未 started_at:0
      const budget = await call(baseUrl, 'alice', 'GET', '/api/skillwhet/jobs/budget');
      assert.equal(budget.body.data?.spentToday, 0);
      fake.jobs[0].started_at = new Date().toISOString();
      assert.equal((await call(baseUrl, 'alice', 'GET', '/api/skillwhet/jobs/budget')).body.data?.spentToday, 1);
      // 按日期过滤的列表(serve 0.5.2 的 ?since=)
      assert.ok(fake.calls.some((c) => c.url.startsWith('/jobs?limit=1000&since=')));
    });
  });

  test('动态 P3:这次作业已被续跑过 → 说「checkpoint 已被续跑作业使用」而不是「一轮都没跑完」', async () => {
    await withServer(async ({ baseUrl, fake }) => {
      await call(baseUrl, 'boss', 'POST', '/api/skillwhet/jobs', { skill: 'lib-skill', args: { rounds: 2 } });
      fake.jobs[0].state = 'interrupted';
      fake.jobs.push({ id: 'job_20260929-110000_bbbb', kind: 'train', skill: 'lib-skill', args: { rounds: 2, resume: true }, tags: ['user:1', `resume_of:${fake.jobs[0].id}`], state: 'done', created_at: new Date().toISOString() });
      const again = await call(baseUrl, 'boss', 'POST', `/api/skillwhet/jobs/${fake.jobs[0].id}/resume`);
      assert.equal(again.status, 409);
      assert.equal(again.body.code, 'SKILLWHET_CHECKPOINT_CONSUMED');
      assert.match(String(again.body.error), /job_20260929-110000_bbbb/);
    });
  });

  test('动态 P3:serve 的英文错误在 Prism 层映射成中文,原话留在 details', async () => {
    await withServer(async ({ baseUrl }) => {
      const r = await call(baseUrl, 'alice', 'POST', '/api/skillwhet/skills/upload', { name: 'bar', files: [{ rel: 'SKILL.md', content_b64: 'LS0t' }] });
      assert.equal(r.status, 409);
      assert.equal(r.body.code, 'SKILLWHET_NAME_MISMATCH');
      assert.equal(r.body.error, 'SKILL.md 里声明的名字是「foo」,与技能名「bar」不一致');
    });
    assert.equal(translateServeError('ALREADY_ADOPTED', 'staging x is already adopted'), '这份 staging 已经采纳过了,没有可比的');
    assert.equal(translateServeError('TEST_CONSUMED', 'x'), '这份 staging 的留出集评估已经做过一次(留出集只能看一次)');
    assert.equal(translateServeError('NO_TESTS', "'s' has no tests/unit/"), '副本里没有 tests/unit/,派生不出任务');
    assert.equal(translateServeError('NO_TESTS', 'no tests collected under tests/holdout/'), 'tests/holdout/ 下没有收集到测试,派生不出任务');
    assert.match(translateServeError('RECORD_TAMPERED', 'x'), /受管记录没通过校验/);
    assert.equal(translateServeError('JOB_ACTIVE', 'x', { job_id: 'job_1', state: 'running' }), '这个 skill 有作业在跑(job_1),先取消或等它结束');
    assert.equal(translateServeError('SOMETHING_NEW', 'raw text'), 'raw text');
  });

  test('动态 P2-18 / 静态 P3:redact.ts 与 harvest.redact 对齐', () => {
    for (const [text, gone] of [
      ['postgres://alice:hunter2@db.local/x', 'hunter2'], ['password=ab12', 'ab12'], ['密码:abcd', 'abcd'],
      ['数据库密码 = Passw0rd', 'Passw0rd'], ['{"密码": "abcd1234"}', 'abcd1234'], ['ticket: tk_9f8e7d6c', 'tk_9f8e7d6c'],
      ['{"api_key": "abcdef"}', 'abcdef'],
    ]) {
      const out = redactSecrets(text);
      assert.ok(!out.includes(gone) && out.includes('REDACTED'), `${text} → ${out}`);
    }
    assert.equal(redactSecrets('the password is fine'), 'the password is fine');
    // 复核 P3:数字与枚举值不是密钥;口令类的键取值是数字仍脱敏
    for (const keep of ['max_tokens: 4096', 'credential_type: oauth', '{"max_tokens": "4096"}']) assert.equal(redactSecrets(keep), keep);
    for (const gone of ['password: 1234', '密码: 123456']) assert.ok(redactSecrets(gone).includes('REDACTED'), gone);
  });
});

// ── 动态 P2-15:夜训 skipped_busy / G1 未过不记整晚 ────────────────────────────

type NJob = { id: string; kind: string; skill: string; state: string; origin: string; created_at: string; args: Record<string, unknown>; cost_usd?: number | null };

class NightlyFake {
  jobs: NJob[] = [];
  busy = new Set<string>();
  gate: Record<string, string> = {};
  status: Record<string, { source: string; uploaded_by?: string; imported_at?: string }> = {};
  posted = 0;
  async request<T>(method: string, url: string, body?: unknown): Promise<T> {
    if (method === 'GET' && url.startsWith('/jobs?')) return { jobs: this.jobs } as T;
    const one = url.match(/^\/jobs\/([^/?]+)$/);
    if (one) { const job = this.jobs.find((j) => j.id === decodeURIComponent(one[1])); if (!job) throw new AppError('no', { code: 'X', statusCode: 404 }); return { job } as T; }
    if (url.startsWith('/tasks/new?')) return { new_checkable: 99 } as T;
    const st = url.match(/^\/skills\/([^/]+)\/status$/);
    if (st) return (this.status[decodeURIComponent(st[1])] ?? { source: 'live', imported_at: '2026-09-01T00:00:00Z' }) as T;
    const gt = url.match(/^\/skills\/([^/]+)\/gate$/);
    if (gt) { const v = this.gate[decodeURIComponent(gt[1])]; return (v ? { cached: true, results: [{ gate: 'G1.security', verdict: v }] } : { cached: false, results: [] }) as T; }
    if (url.endsWith('/checkpoint')) return { exists: false } as T;
    if (method === 'POST' && url === '/jobs') {
      const b = body as { skill: string; args: Record<string, unknown>; origin: string };
      this.posted += 1;
      if (this.busy.has(b.skill)) throw new AppError('dup', { code: 'SKILLWHET_JOB_DUPLICATE', statusCode: 409 });
      const job: NJob = { id: `job_20260929-0300${String(this.jobs.length).padStart(2, '0')}_abcd`, kind: 'train', skill: b.skill, state: 'queued', origin: b.origin, created_at: new Date().toISOString(), args: b.args };
      this.jobs.push(job);
      return { job } as T;
    }
    throw new AppError(`unhandled ${method} ${url}`, { code: 'X', statusCode: 500 });
  }
}

const at = (h: number, m = 0) => () => new Date(2026, 8, 24, h, m, 0, 0);
const quiet = { log() {}, warn() {}, error() {} };

async function freshNightlyDb(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'nightly-hl-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  await initializeDatabase();
  return dir;
}

describe('hl · 夜训不把「此刻不能跑」记成整晚', () => {
  test('skipped_busy:手动作业占着时不写 last_night,每分钟重试且不重复落库;作业让开后同一晚就起', async () => {
    const dir = await freshNightlyDb();
    try {
      skillWhetNightlyDb.upsert('a', { enrolled: true, windowStart: '02:00', windowEnd: '06:00', maxCostUsd: null, rounds: 1, config: {}, minNewTasks: 0 }, 1);
      const serve = new NightlyFake();
      serve.busy.add('a');
      const first = await new NightlyScheduler({ client: serve, now: at(3), logger: quiet }).tick();
      assert.deepEqual(first.skipped.map((x) => x.result), ['skipped_busy']);
      let row = skillWhetNightlyDb.get('a');
      assert.equal(row?.last_night, null, '不记整晚');
      assert.equal(row?.last_result, 'skipped_busy');
      const updatedAt = row?.updated_at;
      const second = await new NightlyScheduler({ client: serve, now: at(3, 1), logger: quiet }).tick();
      assert.deepEqual(second.skipped.map((x) => x.result), ['skipped_busy'], '下一分钟仍在试');
      assert.equal(skillWhetNightlyDb.get('a')?.updated_at, updatedAt, '结果没变就不再写库');
      serve.busy.delete('a');
      const third = await new NightlyScheduler({ client: serve, now: at(3, 2), logger: quiet }).tick();
      assert.equal(third.started?.skill, 'a');
      row = skillWhetNightlyDb.get('a');
      assert.equal(row?.last_result, 'running');
      assert.equal(row?.last_night, '2026-09-23');
    } finally {
      closeConnection();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('上传来源 G1 未过:不记整晚;当晚体检修好就起', async () => {
    const dir = await freshNightlyDb();
    try {
      skillWhetNightlyDb.upsert('u', { enrolled: true, windowStart: '02:00', windowEnd: '06:00', maxCostUsd: null, rounds: 1, config: {}, minNewTasks: 0, copyId: 'upload|alice|2026-09-01T00:00:00Z' }, 1);
      const serve = new NightlyFake();
      serve.status.u = { source: 'upload', uploaded_by: 'alice', imported_at: '2026-09-01T00:00:00Z' };
      serve.gate.u = 'fail';
      const first = await new NightlyScheduler({ client: serve, now: at(3), logger: quiet }).tick();
      assert.deepEqual(first.skipped.map((x) => x.result), ['error']);
      assert.equal(skillWhetNightlyDb.get('u')?.last_night, null);
      assert.equal(skillWhetNightlyDb.get('u')?.enrolled, 1, 'G1 未过不移出,只是不跑');
      serve.gate.u = 'pass';
      const second = await new NightlyScheduler({ client: serve, now: at(3, 5), logger: quiet }).tick();
      assert.equal(second.started?.skill, 'u');
    } finally {
      closeConnection();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
