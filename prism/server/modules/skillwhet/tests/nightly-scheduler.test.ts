import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, test } from 'vitest';

import { auditLogDb, closeConnection, initializeDatabase, skillWhetNightlyDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

import { classifyJob, NightlyScheduler, nightWindow } from '../services/nightly-scheduler.service.js';

/**
 * he:夜训调度器(《实施计划》第四期验收那一段逐条钉住):
 * 零纳入整夜无作业;新任务不够跳过;串行;时窗外不起;一晚预算用完排明晚;
 * 连续 3 晚无收益自动暂停;中断的下次续跑;同 skill 有手动作业在跑就让开。
 */
const previousDatabasePath = process.env.DATABASE_PATH;
let tempDir: string | null = null;

afterEach(async () => {
  closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

async function freshDb() {
  tempDir = await mkdtemp(path.join(tmpdir(), 'nightly-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');
  await initializeDatabase();
}

type Job = { id: string; kind: string; skill: string; state: string; origin: string; created_at: string; args: Record<string, unknown>; cost_usd?: number | null; improved?: boolean | null; stop_reason?: string | null; staging?: string | null };

class FakeServe {
  jobs: Job[] = [];
  newTasks: Record<string, number> = {};
  checkpoint: Record<string, { exists: boolean; matches?: boolean; round?: number }> = {};
  posted: Array<Record<string, unknown>> = [];
  sinceSeen: string[] = [];
  down = false;
  busy = new Set<string>();
  status: Record<string, { source: string; uploaded_by?: string; imported_at?: string } | null> = {};
  gate: Record<string, string> = {};
  /** hl:作业的 created_at 原来取真实时间,"一晚"按 2026-09-24 算的用例过了那天就红(日期依赖);给个可注入的钟 */
  now: (() => Date) | null = null;

  async request<T>(method: string, url: string, body?: unknown): Promise<T> {
    if (this.down) throw new AppError('down', { code: 'SKILLWHET_UNAVAILABLE', statusCode: 503 });
    if (method === 'GET' && url.startsWith('/jobs?')) return { jobs: this.jobs } as T;
    const one = url.match(/^\/jobs\/([^/?]+)$/);
    if (method === 'GET' && one) {
      const job = this.jobs.find((j) => j.id === decodeURIComponent(one[1]));
      if (!job) throw new AppError('no job', { code: 'SKILLWHET_JOB_NOT_FOUND', statusCode: 404 });
      return { job } as T;
    }
    const nt = url.match(/^\/tasks\/new\?skill=([^&]+)&since=(.*)$/);
    if (nt) {
      this.sinceSeen.push(decodeURIComponent(nt[2]));
      return { new_checkable: this.newTasks[decodeURIComponent(nt[1])] ?? 0 } as T;
    }
    const st = url.match(/^\/skills\/([^/]+)\/status$/);
    if (st) {
      const name = decodeURIComponent(st[1]);
      const row = name in this.status ? this.status[name] : { source: 'live', imported_at: '2026-09-01T00:00:00Z' };
      if (!row) throw new AppError('no copy', { code: 'SKILLWHET_NOT_MANAGED', statusCode: 404 });
      return row as T;
    }
    const gt = url.match(/^\/skills\/([^/]+)\/gate$/);
    if (gt) {
      const v = this.gate[decodeURIComponent(gt[1])];
      return (v ? { cached: true, results: [{ gate: 'G1.security', verdict: v }] } : { cached: false, results: [] }) as T;
    }
    const ck = url.match(/^\/skills\/([^/]+)\/checkpoint$/);
    if (ck) return (this.checkpoint[decodeURIComponent(ck[1])] ?? { exists: false }) as T;
    if (method === 'POST' && url === '/jobs') {
      const b = body as { skill: string; args: Record<string, unknown>; origin: string };
      if (this.busy.has(b.skill)) throw new AppError('dup', { code: 'SKILLWHET_JOB_DUPLICATE', statusCode: 409 });
      this.posted.push(b as unknown as Record<string, unknown>);
      const job: Job = { id: `job_20260924-0300${String(this.jobs.length).padStart(2, '0')}_abcd`, kind: 'train', skill: b.skill, state: 'queued', origin: b.origin, created_at: (this.now ?? (() => new Date()))().toISOString(), args: b.args };
      this.jobs.unshift(job);
      return { job, position: 0 } as T;
    }
    throw new Error(`unexpected ${method} ${url}`);
  }

  finish(skill: string, patch: Partial<Job>) {
    const job = this.jobs.find((j) => j.skill === skill && (j.state === 'queued' || j.state === 'running'));
    assert.ok(job, `no live job for ${skill}`);
    Object.assign(job, { state: 'done', improved: false, stop_reason: 'rounds', cost_usd: 0.1 }, patch);
  }
}

const at = (h: number, m = 0, day = 24) => () => new Date(2026, 8, day, h, m, 0, 0);
const enroll = (skill: string, extra: Partial<Parameters<typeof skillWhetNightlyDb.upsert>[1]> = {}) =>
  skillWhetNightlyDb.upsert(skill, { enrolled: true, windowStart: '02:00', windowEnd: '06:00', maxCostUsd: 1, rounds: 2, config: { runner: 'pytest' }, minNewTasks: 5, ...extra }, 1);

describe('nightWindow', () => {
  test('普通时窗与跨零点时窗;"一晚"= 中午到次日中午,记当天', () => {
    assert.deepEqual(nightWindow(new Date(2026, 8, 24, 3, 0), '02:00', '06:00'), { inWindow: true, night: '2026-09-23' });
    assert.equal(nightWindow(new Date(2026, 8, 24, 6, 0), '02:00', '06:00').inWindow, false);
    assert.equal(nightWindow(new Date(2026, 8, 24, 1, 59), '02:00', '06:00').inWindow, false);
    const late = nightWindow(new Date(2026, 8, 24, 23, 30), '22:00', '06:00');
    assert.equal(late.inWindow, true);
    assert.equal(late.night, '2026-09-24');
    const early = nightWindow(new Date(2026, 8, 25, 3, 0), '22:00', '06:00');
    assert.equal(early.inWindow, true);
    assert.equal(early.night, '2026-09-24', '凌晨 3 点属于前一天那一晚');
    assert.equal(nightWindow(new Date(2026, 8, 25, 1, 30), '01:00', '05:00').night, '2026-09-24', '不同时窗的 skill 同一晚');
  });
});

describe('classifyJob', () => {
  test('有改进 / 无改进 / 超预算 / 无信号 / 中断 / 失败', () => {
    const base = { id: 'j', kind: 'train', skill: 's', created_at: '' };
    assert.deepEqual([
      classifyJob({ ...base, state: 'done', improved: true, staging: 'x' }).result,
      classifyJob({ ...base, state: 'done', improved: false, stop_reason: 'rounds' }).result,
      classifyJob({ ...base, state: 'done', improved: false, stop_reason: 'budget' }).result,
      classifyJob({ ...base, state: 'done', improved: false, stop_reason: 'no_signal' }).result,
      classifyJob({ ...base, state: 'done', improved: false, stop_reason: 'backend_unavailable' }).result,
      classifyJob({ ...base, state: 'interrupted' }).result,
      classifyJob({ ...base, state: 'failed', error: 'boom' }).result,
    ], ['improved', 'unchanged', 'budget', 'no_candidate', 'error', 'interrupted', 'error']);
    assert.equal(classifyJob({ ...base, state: 'done', improved: false, stop_reason: 'rounds' }).noop, true);
    assert.equal(classifyJob({ ...base, state: 'interrupted' }).noop, false);
  });
});

describe('NightlyScheduler', () => {
  test('零纳入:整夜不起作业', async () => {
    await freshDb();
    skillWhetNightlyDb.upsert('a', { enrolled: false, windowStart: '02:00', windowEnd: '06:00', maxCostUsd: null, rounds: 2, config: {}, minNewTasks: 0 }, 1);
    const serve = new FakeServe();
    serve.newTasks.a = 50;
    const out = await new NightlyScheduler({ client: serve, now: at(3), logger: { log() {}, warn() {}, error() {} } }).tick();
    assert.equal(out.started, null);
    assert.equal(serve.posted.length, 0);
  });

  test('新任务不够:记 skipped_no_new_tasks,同一晚不再看;时窗外不起', async () => {
    await freshDb();
    enroll('a');
    const serve = new FakeServe();
    serve.newTasks.a = 3;
    const quiet = { log() {}, warn() {}, error() {} };
    assert.equal((await new NightlyScheduler({ client: serve, now: at(1), logger: quiet }).tick()).skipped.length, 0, '时窗外');
    const out = await new NightlyScheduler({ client: serve, now: at(3), logger: quiet }).tick();
    assert.deepEqual(out.skipped.map((x) => x.result), ['skipped_no_new_tasks']);
    const row = skillWhetNightlyDb.get('a');
    assert.equal(row?.last_night, '2026-09-23');
    assert.equal(row?.last_run_at, null, '跳过不算跑过,新任务仍从上次真跑算起');
    serve.newTasks.a = 10;
    assert.equal((await new NightlyScheduler({ client: serve, now: at(3, 5), logger: quiet }).tick()).started, null, '这一晚已处理');
    assert.equal(serve.posted.length, 0);
  });

  test('两个纳入:串行,先跑上次夜训更早的;第一个结束才起第二个;产物只到 staging', async () => {
    await freshDb();
    enroll('a');
    enroll('b');
    skillWhetNightlyDb.markStarted('a', '2026-09-20', 'job_old_a', '2026-09-20T02:00:00Z');
    skillWhetNightlyDb.markFinished('a', 'unchanged', null, false);
    const serve = new FakeServe();
    serve.newTasks = { a: 9, b: 9 };
    const quiet = { log() {}, warn() {}, error() {} };
    const s = new NightlyScheduler({ client: serve, now: at(3), logger: quiet });
    const first = await s.tick();
    assert.equal(first.started?.skill, 'b', '从没跑过的 b 排在前面');
    assert.equal(serve.posted[0].origin, 'nightly');
    assert.deepEqual((serve.posted[0].args as Record<string, unknown>).runner, 'pytest');
    assert.equal((serve.posted[0].args as Record<string, unknown>).max_cost_usd, 1);
    assert.ok(serve.sinceSeen.includes(''), 'b 从没跑过:所有可判分任务都算新');
    const wait = await s.tick();
    assert.equal(wait.started, null);
    assert.ok(wait.waitingFor);
    serve.finish('b', { improved: true, staging: '20260924-030500' });
    const second = await s.tick();
    assert.deepEqual(second.finalized.map((x) => x.result), ['improved']);
    assert.equal(second.started?.skill, 'a');
    assert.ok(serve.sinceSeen.includes('2026-09-20T02:00:00Z'), 'a 的新任务从上次夜训算起');
    assert.equal(skillWhetNightlyDb.get('b')?.last_result, 'improved');
    assert.equal(serve.posted.length, 2);
  });

  test('一晚合计预算:用完的排明晚', async () => {
    await freshDb();
    enroll('a', { maxCostUsd: 2 });
    const serve = new FakeServe();
    serve.newTasks.a = 9;
    serve.jobs.push({ id: 'job_x', kind: 'train', skill: 'z', state: 'done', origin: 'nightly', created_at: new Date(2026, 8, 24, 2, 10).toISOString(), args: {}, cost_usd: 4 });
    const out = await new NightlyScheduler({ client: serve, env: { PRISM_SKILLWHET_NIGHTLY_MAX_COST_USD: '5', PRISM_SKILLWHET_MAX_COST_USD: '2' }, now: at(3), logger: { log() {}, warn() {}, error() {} } }).tick();
    assert.deepEqual(out.skipped.map((x) => x.result), ['deferred_budget']);
    assert.equal(serve.posted.length, 0);
    // 第二晚:昨晚的花费不算
    const next = await new NightlyScheduler({ client: serve, env: { PRISM_SKILLWHET_NIGHTLY_MAX_COST_USD: '5', PRISM_SKILLWHET_MAX_COST_USD: '2' }, now: at(3, 0, 25), logger: { log() {}, warn() {}, error() {} } }).tick();
    assert.equal(next.started?.skill, 'a');
  });

  test('连续 3 晚无收益:自动移出夜训并审计', async () => {
    await freshDb();
    enroll('a', { minNewTasks: 0 });
    const serve = new FakeServe();
    const quiet = { log() {}, warn() {}, error() {} };
    for (const day of [24, 25, 26]) {
      const s = new NightlyScheduler({ client: serve, now: at(3, 0, day), logger: quiet });
      assert.equal((await s.tick()).started?.skill, 'a', `night ${day}`);
      serve.finish('a', { stop_reason: 'no_signal' });
      const done = await new NightlyScheduler({ client: serve, now: at(4, 0, day), logger: quiet }).tick();
      assert.equal(done.finalized[0].autopaused, day === 26);
    }
    const row = skillWhetNightlyDb.get('a');
    assert.equal(row?.enrolled, 0);
    assert.equal(row?.consecutive_noop, 3);
    assert.ok(row?.auto_paused_at);
    assert.ok(auditLogDb.list(20, 0, null).some((r) => r.event === 'skillwhet_nightly_autopause'));
    assert.equal((await new NightlyScheduler({ client: serve, now: at(3, 0, 27), logger: quiet }).tick()).started, null);
    // root 重新纳入:连续计数清零
    enroll('a', { minNewTasks: 0 });
    assert.equal(skillWhetNightlyDb.get('a')?.consecutive_noop, 0);
    assert.equal(skillWhetNightlyDb.get('a')?.auto_paused_at, null);
  });

  test('被中断的:同一晚还在时窗里就续跑(带 resume,不看新任务门槛);有手动作业在跑就让开', async () => {
    await freshDb();
    enroll('a');
    const serve = new FakeServe();
    serve.newTasks.a = 9;
    const quiet = { log() {}, warn() {}, error() {} };
    await new NightlyScheduler({ client: serve, now: at(2, 30), logger: quiet }).tick();
    serve.jobs[0].state = 'interrupted';
    serve.newTasks.a = 0;
    serve.checkpoint.a = { exists: true, matches: true, round: 1 };
    const out = await new NightlyScheduler({ client: serve, now: at(3), logger: quiet }).tick();
    assert.deepEqual(out.finalized.map((x) => x.result), ['interrupted']);
    assert.equal(out.started?.resume, true);
    assert.equal((serve.posted[1].args as Record<string, unknown>).resume, true);

    enroll('b', { minNewTasks: 0 });
    serve.finish('a', { improved: true });
    serve.busy.add('b');
    const busy = await new NightlyScheduler({ client: serve, now: at(3, 10), logger: quiet }).tick();
    assert.deepEqual(busy.skipped.map((x) => `${x.skill}:${x.result}`), ['b:skipped_busy']);
  });

  test('serve 不在:这一分钟什么都不记,下一分钟再来', async () => {
    await freshDb();
    enroll('a');
    const serve = new FakeServe();
    serve.down = true;
    await assert.rejects(new NightlyScheduler({ client: serve, now: at(3), logger: { log() {}, warn() {}, error() {} } }).tick());
    assert.equal(skillWhetNightlyDb.get('a')?.last_night, null);
  });

  test('一晚合计预算跨时窗:22:00–02:00 花掉的,01:00 开窗的也要算进去;时窗往后挪不会同一晚再跑', async () => {
    await freshDb();
    enroll('a', { windowStart: '22:00', windowEnd: '02:00', maxCostUsd: 2, minNewTasks: 0 });
    enroll('b', { windowStart: '01:00', windowEnd: '05:00', maxCostUsd: 2, minNewTasks: 0 });
    const serve = new FakeServe();
    const env = { PRISM_SKILLWHET_NIGHTLY_MAX_COST_USD: '3', PRISM_SKILLWHET_MAX_COST_USD: '2' };
    const quiet = { log() {}, warn() {}, error() {} };
    assert.equal((await new NightlyScheduler({ client: serve, env, now: at(22, 30, 24), logger: quiet }).tick()).started?.skill, 'a');
    serve.finish('a', { cost_usd: 1.5 });
    serve.jobs[0].created_at = new Date(2026, 8, 24, 22, 30).toISOString();
    const out = await new NightlyScheduler({ client: serve, env, now: at(1, 30, 25), logger: quiet }).tick();
    assert.deepEqual(out.skipped.map((x) => `${x.skill}:${x.result}`), ['b:deferred_budget']);
    // 把 a 的时窗挪到 03:00–05:00:同一晚(09-24),不再跑
    enroll('a', { windowStart: '03:00', windowEnd: '05:00', maxCostUsd: 2, minNewTasks: 0 });
    const again = await new NightlyScheduler({ client: serve, env, now: at(3, 30, 25), logger: quiet }).tick();
    assert.equal(again.started, null);
  });

  test('纳入的是那份副本:换过 / 没了 → 不跑并移出;上传来源 G1 不是 PASS → 不跑', async () => {
    await freshDb();
    skillWhetNightlyDb.upsert('a', { enrolled: true, windowStart: '02:00', windowEnd: '06:00', maxCostUsd: 1, rounds: 1, config: {}, minNewTasks: 0, copyId: 'upload|alice|2026-09-01T00:00:00Z' }, 1);
    skillWhetNightlyDb.upsert('b', { enrolled: true, windowStart: '02:00', windowEnd: '06:00', maxCostUsd: 1, rounds: 1, config: {}, minNewTasks: 0, copyId: 'upload|bob|2026-09-01T00:00:00Z' }, 1);
    skillWhetNightlyDb.upsert('c', { enrolled: true, windowStart: '02:00', windowEnd: '06:00', maxCostUsd: 1, rounds: 1, config: {}, minNewTasks: 0, copyId: 'live||x' }, 1);
    const serve = new FakeServe();
    serve.status.a = { source: 'upload', uploaded_by: 'mallory', imported_at: '2026-09-24T01:00:00Z' };
    serve.status.b = { source: 'upload', uploaded_by: 'bob', imported_at: '2026-09-01T00:00:00Z' };
    serve.gate.b = 'fail';
    serve.status.c = null;
    const out = await new NightlyScheduler({ client: serve, now: at(3), logger: { log() {}, warn() {}, error() {} } }).tick();
    assert.equal(out.started, null);
    assert.equal(serve.posted.length, 0);
    assert.equal(skillWhetNightlyDb.get('a')?.enrolled, 0, '副本换过');
    assert.equal(skillWhetNightlyDb.get('c')?.enrolled, 0, '副本没了');
    assert.equal(skillWhetNightlyDb.get('b')?.enrolled, 1, 'G1 没过只是这一晚不跑');
    assert.match(String(skillWhetNightlyDb.get('b')?.last_detail), /G1/);
    assert.ok(auditLogDb.list(20, 0, null).some((r) => r.event === 'skillwhet_nightly_unenroll'));
  });

  test('起了作业没来得及记账就重启:下一次把活着的夜训作业认领回计划,不会再起一个', async () => {
    await freshDb();
    enroll('a', { minNewTasks: 0 });
    const serve = new FakeServe();
    serve.jobs.push({ id: 'job_orphan', kind: 'train', skill: 'a', state: 'running', origin: 'nightly', created_at: new Date(2026, 8, 24, 2, 5).toISOString(), args: {} });
    const out = await new NightlyScheduler({ client: serve, now: at(3), logger: { log() {}, warn() {}, error() {} } }).tick();
    assert.equal(out.waitingFor, 'job_orphan');
    const row = skillWhetNightlyDb.get('a');
    assert.equal(row?.last_job_id, 'job_orphan');
    assert.equal(row?.last_result, 'running');
    assert.equal(row?.last_night, '2026-09-23');
    serve.jobs[0].state = 'done';
    const next = await new NightlyScheduler({ client: serve, now: at(3, 5), logger: { log() {}, warn() {}, error() {} } }).tick();
    assert.deepEqual(next.finalized.map((x) => x.result), ['unchanged']);
    assert.equal(next.started, null, '这一晚已跑过');
  });

  test('被打断的这一晚没续上(预算):仍记"被打断",下一晚接着续', async () => {
    await freshDb();
    enroll('a', { minNewTasks: 5, maxCostUsd: 2 });
    const serve = new FakeServe();
    serve.newTasks.a = 9;
    const env = { PRISM_SKILLWHET_NIGHTLY_MAX_COST_USD: '2', PRISM_SKILLWHET_MAX_COST_USD: '2' };
    const quiet = { log() {}, warn() {}, error() {} };
    serve.now = at(2, 30);
    await new NightlyScheduler({ client: serve, env, now: at(2, 30), logger: quiet }).tick();
    serve.jobs[0].state = 'interrupted';
    serve.jobs[0].cost_usd = 1;
    serve.checkpoint.a = { exists: true, matches: true, round: 1 };
    const out = await new NightlyScheduler({ client: serve, env, now: at(3), logger: quiet }).tick();
    assert.deepEqual(out.skipped.map((x) => x.result), ['deferred_budget']);
    assert.equal(skillWhetNightlyDb.get('a')?.last_result, 'interrupted');
    serve.newTasks.a = 0;
    const next = await new NightlyScheduler({ client: serve, env, now: at(3, 0, 25), logger: quiet }).tick();
    assert.equal(next.started?.resume, true);
  });
});
