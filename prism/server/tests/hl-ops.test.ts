import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, test, vi } from 'vitest';

import {
  backupDatabase,
  backupDatabaseSync,
  backupDateOf,
  backupKeepDaysFromEnv,
  PRE_MIGRATION_KEEP,
  pruneBackups,
  resolveBackupDir,
} from '@/modules/database/connection.js';
import {
  closeConnection,
  getConnection,
  initializeDatabase,
  projectsDb,
  scheduledTasksDb,
  stopDatabaseBackups,
  userDb,
} from '@/modules/database/index.js';
import {
  SCHEMA_FINGERPRINT_KEY,
  computeSchemaFingerprint,
  detectPendingMigration,
} from '@/modules/database/init-db.js';
import { verifyWebSocketClient } from '@/modules/websocket/services/websocket-auth.service.js';
import {
  executeTask,
  runTaskNow,
  startTaskScheduler,
  stopTaskScheduler,
} from '@/modules/tasks/services/scheduled-tasks.service.js';
import { __resetTicketsForTest, consumeTicket, issueTicket } from '@/shared/ws-tickets.js';

import { createChildSupervisor } from '../services/child-supervisor.js';
import {
  jobsRetentionDaysFromEnv,
  pruneSkillWhetJobs,
} from '../services/skillwhet-service.js';
import { parseDotEnv, parseDotEnvValue } from '../utils/dotenv-parse.js';

/**
 * hl 切片 E(运维与依赖)的回归测试。
 *
 * 对应条目:静态 P1-13(崩溃自动拉起)、P1-14(备份挡不住迁移)、P2-24(.env 行内注释)、
 * P2-25(停机顺序)、P2-26/27(依赖)、P3「工程 / 死配置 / 测试空白」。
 * 关键几条对着 baseline-hk 反向验证过会红(见各 describe 的说明)。
 */

const repoRoot = path.resolve(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

async function withIsolatedDatabase(run: (dir: string) => void | Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'hl-ops-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  try {
    await run(dir);
  } finally {
    stopDatabaseBackups();
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

const withEnv = async (vars: Record<string, string | undefined>, run: () => void | Promise<void>) => {
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    before[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { await run(); } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
};

/* ── P2-24:.env 行内注释 ──────────────────────────────────────────── */

describe('hl 静态 P2-24:.env 行内注释与引号', () => {
  // baseline 的 load-env 只按 `=` 切开再 trim:A 的值是 "1   # 说明",`=== '1'` 永远为假。
  const FIXTURE = [
    'A=1   # 说明',
    'B="quoted # kept"  # 注释',
    "C='single'",
    'D=abc#def',
    'E=',
    'export F=exported # yes',
    'export\tK=tabbed',
    '# G=commented',
    'H = spaced ',
    'I="unterminated # x',
    'J=first',
    'J=last',
  ].join('\n');
  const EXPECTED: Record<string, string> = {
    A: '1', B: 'quoted # kept', C: 'single', D: 'abc#def', E: '', F: 'exported',
    H: 'spaced', I: '"unterminated', J: 'last', K: 'tabbed',
  };

  test('load-env 用的解析器:剥 ` #` 注释与配对引号,紧贴的 # 保留,后写覆盖先写', () => {
    assert.deepEqual(parseDotEnv(FIXTURE), EXPECTED);
    assert.equal(parseDotEnvValue('300000        # 默认 5min'), '300000');
  });

  test('prism.sh 的 read_env 与 load-env 口径一致(同一份夹具)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'hl-ops-env-'));
    try {
      fs.writeFileSync(path.join(dir, '.env'), `${FIXTURE}\n`);
      const script = read('prism.sh');
      const fn = script.slice(script.indexOf('read_env() {'), script.indexOf('\n}\n', script.indexOf('read_env() {')) + 3);
      for (const [key, value] of Object.entries(EXPECTED)) {
        if (value === '') continue; // read_env 对空值返回 fallback(那是它的约定)
        const env = { PATH: process.env.PATH ?? '' };
        const out = execFileSync('bash', ['-c', `${fn}\nAPP_DIR='${dir}'\nread_env ${key} FALLBACK`], { env, encoding: 'utf8' });
        assert.equal(out.replace(/\n$/, ''), value, `read_env ${key}`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('.env.example 不再有 `# KEY=值  # 说明` 的写法;死配置已删', () => {
    const text = read('.env.example');
    const inline = text.split('\n').filter((line) => /^#\s*[A-Z_][A-Z0-9_]*\s*=.*\s#/.test(line));
    assert.deepEqual(inline, []);
    for (const dead of ['PRISM_CREDENTIAL_HEADERS=', 'PRISM_DATA_DIR_EXPLICIT_GUARD=', 'PRISM_COMPACT_IDLE_TIMEOUT_MS=']) {
      assert.ok(!text.includes(dead), `${dead} 仍在 .env.example`);
    }
  });
});

/* ── P1-14:备份 ───────────────────────────────────────────────────── */

describe('hl 静态 P1-14:备份按日期保留、先 .tmp 再改名、迁移前同步备份', () => {
  const touch = (dir: string, name: string) => fs.writeFileSync(path.join(dir, name), 'x');

  test('pruneBackups:每天留最新一份、超期整天删、pre-migration 与别人的文件不动、旧 .tmp 清掉', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'hl-ops-prune-'));
    try {
      const now = new Date('2026-09-29T12:00:00.000Z');
      const names = [
        'auth-2026-09-29T01-00-00-000Z.db',
        'auth-2026-09-29T05-00-00-000Z.db',
        'auth-2026-09-29T09-00-00-000Z.db', // 今天最新
        'auth-2026-09-28T03-00-00-000Z.db',
        'auth-2026-09-28T23-00-00-000Z.db', // 昨天最新
        'auth-2026-09-09T10-00-00-000Z.db', // 20 天前
        'auth-2026-06-01T10-00-00-000Z-pre-migration.db', // 老,但是迁移前
        'manual-copy.db',
        'auth-2026-09-29T11-00-00-000Z.db.tmp', // 刚写的半截:留
        'auth-2026-09-20T11-00-00-000Z.db.tmp', // 陈旧半截:删
      ];
      for (const name of names) touch(dir, name);
      const old = new Date(now.getTime() - 3 * 3600_000);
      fs.utimesSync(path.join(dir, 'auth-2026-09-20T11-00-00-000Z.db.tmp'), old, old);
      fs.utimesSync(path.join(dir, 'auth-2026-09-29T11-00-00-000Z.db.tmp'), now, now);

      pruneBackups(dir, 'auth', 14, now);
      assert.deepEqual(fs.readdirSync(dir).sort(), [
        'auth-2026-06-01T10-00-00-000Z-pre-migration.db',
        'auth-2026-09-28T23-00-00-000Z.db',
        'auth-2026-09-29T09-00-00-000Z.db',
        'auth-2026-09-29T11-00-00-000Z.db.tmp',
        'manual-copy.db',
      ]);
      assert.equal(backupDateOf('auth-2026-09-28T23-00-00-000Z.db', 'auth'), '2026-09-28');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('backupDatabase:一天部署 8 次也挤不掉前几天的快照(baseline 只留 7 份会挤掉)', async () => {
    await withIsolatedDatabase(async (dir) => {
      await initializeDatabase();
      const backups = resolveBackupDir(path.join(dir, 'auth.db'));
      fs.mkdirSync(backups, { recursive: true });
      for (const day of ['2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28']) touch(backups, `auth-${day}T10-00-00-000Z.db`);
      for (let i = 0; i < 8; i += 1) {
        const at = new Date(`2026-09-29T0${i}:00:00.000Z`);
        const target = await backupDatabase({ keepDays: 14, now: () => at });
        assert.ok(target && fs.existsSync(target));
      }
      const left = fs.readdirSync(backups).sort();
      assert.deepEqual(left, [
        'auth-2026-09-25T10-00-00-000Z.db',
        'auth-2026-09-26T10-00-00-000Z.db',
        'auth-2026-09-27T10-00-00-000Z.db',
        'auth-2026-09-28T10-00-00-000Z.db',
        'auth-2026-09-29T07-00-00-000Z.db',
      ]);
      assert.ok(left.every((n) => !n.endsWith('.tmp')), '不该留下 .tmp');
    });
  });

  test('backupDatabase 失败时不留下顶着 .db 名字的半截文件', async () => {
    await withIsolatedDatabase(async (dir) => {
      await initializeDatabase();
      const at = new Date('2026-09-29T10:00:00.000Z');
      const backups = resolveBackupDir(path.join(dir, 'auth.db'));
      const target = path.join(backups, `auth-${at.toISOString().replace(/[:.]/g, '-')}.db`);
      // 让 .tmp 位置被一个非空目录占住:写入 / 删除都会失败
      fs.mkdirSync(`${target}.tmp`, { recursive: true });
      fs.writeFileSync(path.join(`${target}.tmp`, 'block'), 'x');
      const result = await backupDatabase({ now: () => at });
      assert.equal(result, null);
      assert.equal(fs.existsSync(target), false);
    });
  });

  test('backupKeepDaysFromEnv:KEEP_DAYS 优先,老名字 KEEP 仍认,默认 14;0 / 负数按默认(旧语义)', () => {
    assert.equal(backupKeepDaysFromEnv({}), 14);
    assert.equal(backupKeepDaysFromEnv({ PRISM_DB_BACKUP_KEEP: '7' }), 7);
    assert.equal(backupKeepDaysFromEnv({ PRISM_DB_BACKUP_KEEP: '7', PRISM_DB_BACKUP_KEEP_DAYS: '30' }), 30);
    // 旧实现 `parseInt(…) || 7`:KEEP=0 等于默认,不能变成"永不裁剪"
    assert.equal(backupKeepDaysFromEnv({ PRISM_DB_BACKUP_KEEP: '0' }), 14);
    assert.equal(backupKeepDaysFromEnv({ PRISM_DB_BACKUP_KEEP_DAYS: '-3' }), 14);
  });

  test('迁移前备份只留最近 5 份(每次 schema 变化都多一份,不能无限积)', async () => {
    await withIsolatedDatabase(async (dir) => {
      await initializeDatabase();
      const backups = resolveBackupDir(path.join(dir, 'auth.db'));
      fs.mkdirSync(backups, { recursive: true });
      for (let m = 1; m <= 7; m += 1) touch(backups, `auth-2026-0${m}-01T00-00-00-000Z-pre-migration.db`);
      touch(backups, 'auth-2025-01-01T00-00-00-000Z.db'); // 例行的,不归这条管
      const made = backupDatabaseSync({ label: 'pre-migration', now: () => new Date('2026-09-29T00:00:00.000Z') });
      assert.ok(made);
      const pre = fs.readdirSync(backups).filter((n) => n.endsWith('-pre-migration.db')).sort();
      assert.deepEqual(pre, [
        'auth-2026-04-01T00-00-00-000Z-pre-migration.db',
        'auth-2026-05-01T00-00-00-000Z-pre-migration.db',
        'auth-2026-06-01T00-00-00-000Z-pre-migration.db',
        'auth-2026-07-01T00-00-00-000Z-pre-migration.db',
        path.basename(made!),
      ]);
      assert.equal(PRE_MIGRATION_KEEP, 5);
      assert.ok(fs.existsSync(path.join(backups, 'auth-2025-01-01T00-00-00-000Z.db')));
    });
  });

  test('initializeDatabase:新库不备份;缺列 / 指纹变了 → 迁移前同步备份一份,且那份是迁移前的形状', async () => {
    await withIsolatedDatabase(async (dir) => {
      const backups = resolveBackupDir(path.join(dir, 'auth.db'));
      const preMigration = () => (fs.existsSync(backups) ? fs.readdirSync(backups) : []).filter((n) => n.endsWith('-pre-migration.db'));

      await initializeDatabase();
      assert.deepEqual(preMigration(), [], '全新库没东西可保护');
      const db = getConnection();
      assert.equal(
        (db.prepare('SELECT value FROM app_config WHERE key = ?').get(SCHEMA_FINGERPRINT_KEY) as { value: string }).value,
        computeSchemaFingerprint(),
      );

      // 第二次启动,schema 没变:不备份
      closeConnection();
      initializeDatabase(); // 刻意不 await:迁移必须在同步段里跑完(十几处调用方依赖这一点)
      assert.deepEqual(preMigration(), []);
      assert.equal(detectPendingMigration(getConnection()).pending, false);

      // 造一个"老库":删掉一列
      getConnection().exec('ALTER TABLE users DROP COLUMN attachment_quota_mb');
      const check = detectPendingMigration(getConnection());
      assert.equal(check.pending, true);
      assert.match(check.reasons.join(';'), /缺列/);

      closeConnection();
      initializeDatabase(); // 同步:返回时列已经补回
      const cols = (getConnection().prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).map((c) => c.name);
      assert.ok(cols.includes('attachment_quota_mb'), '迁移应当在同步段里补回列');
      const [snapshot] = preMigration();
      assert.ok(snapshot, '应当有一份迁移前备份');
      assert.equal(fs.existsSync(path.join(backups, `${snapshot}.tmp`)), false);

      // 那份备份是迁移**前**的形状(少那一列)
      const Database = (await import('better-sqlite3')).default;
      const copy = new Database(path.join(backups, snapshot), { readonly: true });
      try {
        const copyCols = (copy.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).map((c) => c.name);
        assert.ok(!copyCols.includes('attachment_quota_mb'));
      } finally {
        copy.close();
      }

      // 指纹被改(= 升级了 schema.ts)也算
      getConnection().prepare('UPDATE app_config SET value = ? WHERE key = ?').run('stale', SCHEMA_FINGERPRINT_KEY);
      assert.match(detectPendingMigration(getConnection()).reasons.join(';'), /指纹变了/);
    });
  });

  test('PRISM_DB_BACKUP=0 也关掉迁移前那份;backupDatabaseSync 直接可用', async () => {
    await withIsolatedDatabase(async (dir) => {
      await initializeDatabase();
      getConnection().prepare('DELETE FROM app_config WHERE key = ?').run(SCHEMA_FINGERPRINT_KEY);
      const backups = resolveBackupDir(path.join(dir, 'auth.db'));
      await withEnv({ PRISM_DB_BACKUP: '0' }, async () => {
        closeConnection();
        await initializeDatabase();
      });
      assert.equal(fs.existsSync(backups) ? fs.readdirSync(backups).length : 0, 0);
      const sync = backupDatabaseSync({ label: 'pre-migration' });
      assert.ok(sync && sync.endsWith('-pre-migration.db') && fs.existsSync(sync));
    });
  });
});

/* ── P1-13 / P2-25:进程级兜底与停机顺序(源码钉住) ─────────────────── */

describe('hl 静态 P1-13 / P2-25:进程兜底与停机顺序', () => {
  const index = read('server/index.js');

  test('unhandledRejection 只记日志不退出;uncaughtException 仍走 shutdown', () => {
    // baseline:process.on('unhandledRejection', fatal('unhandledRejection')) —— 整机退出
    assert.ok(!/process\.on\('unhandledRejection',\s*fatal\(/.test(index));
    const handler = index.slice(index.indexOf("process.on('unhandledRejection'"));
    const body = handler.slice(0, handler.indexOf('});'));
    assert.ok(!/shutdown|process\.exit/.test(body), 'unhandledRejection 不该触发退出');
    assert.ok(/process\.on\('uncaughtException',\s*fatal\('uncaughtException'\)\)/.test(index));
  });

  test('两个受管子进程并行停;硬退出窗口 ≥ 12s 且硬退出前也关库;prism.sh 等 ≥ 12s 再 kill -9', () => {
    const exitMs = Number(/const SHUTDOWN_HARD_EXIT_MS = ([\d_]+)/.exec(index)![1].replace(/_/g, ''));
    assert.ok(exitMs >= 12_000);
    const parallel = index.slice(index.indexOf("'child services stop'"), index.indexOf("'server marker removal'"));
    assert.match(parallel, /Promise\.allSettled\(\[/);
    assert.match(parallel, /ma service stop/);
    assert.match(parallel, /skillwhet service stop/);
    const hardExit = index.slice(index.indexOf('const hardExitTimer'), index.indexOf('hardExitTimer.unref()'));
    assert.match(hardExit, /closeConnection\(\)/);

    const sh = read('prism.sh');
    const stop = sh.slice(sh.indexOf('do_stop() {'), sh.indexOf('do_start() {'));
    const waitLoop = /for i in \$\(seq 1 (\d+)\); do\s+if ! service_alive[\s\S]*?sleep ([\d.]+)/.exec(stop);
    assert.ok(waitLoop, '找不到 TERM 后的等待循环');
    assert.ok(Number(waitLoop![1]) * Number(waitLoop![2]) >= 12, 'kill -9 之前至少等 12 秒');
  });

  test('prism.sh:不带参数不再默认 restart;健康检查走 /api/ready', () => {
    const sh = read('prism.sh');
    assert.ok(!sh.includes('case "${1:-restart}"'));
    assert.match(sh, /HEALTH_URL="http:\/\/\$\{HEALTH_HOST\}:\$\{PORT\}\/api\/ready"/);
    const res = spawnSync('bash', [path.join(repoRoot, 'prism.sh')], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
    assert.equal(res.status, 1);
    assert.match(res.stdout, /用法/);
  });
});

/* ── P1-13:守护循环端到端 ─────────────────────────────────────────── */

const freePort = () => new Promise<number>((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address() as net.AddressInfo;
    srv.close(() => resolve(port));
  });
});

const hasTools = ['setsid', 'curl'].every((tool) => spawnSync('bash', ['-c', `command -v ${tool}`]).status === 0);

describe.skipIf(!hasTools)('hl 静态 P1-13:prism.sh 守护循环(假服务,另起端口)', () => {
  test('kill -9 服务 → 退避后自动拉起;stop 之后不再拉起、端口释放;双启被拒', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'hl-ops-sup-'));
    const port = await freePort();
    const env = { PATH: process.env.PATH ?? '', HOME: dir, SERVER_PORT: String(port), HOST: '127.0.0.1' };
    const sh = (...args: string[]) => spawnSync('bash', [path.join(dir, 'prism.sh'), ...args], { cwd: dir, env, encoding: 'utf8', timeout: 60_000 });
    const readPid = (name: string) => {
      try { return Number(fs.readFileSync(path.join(dir, '.run', name), 'utf8').trim()) || null; } catch { return null; }
    };
    const ready = () => spawnSync('curl', ['-fsS', '-m', '2', `http://127.0.0.1:${port}/api/ready`]).status === 0;
    const waitFor = async (cond: () => boolean, ms: number) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) { if (cond()) return true; await new Promise((r) => setTimeout(r, 200)); }
      return false;
    };
    try {
      fs.copyFileSync(path.join(repoRoot, 'prism.sh'), path.join(dir, 'prism.sh'));
      await mkdir(path.join(dir, 'dist-server', 'server'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'dist-server', 'server', 'index.js'), `
        const http = require('http');
        const s = http.createServer((q, r) => { r.end(q.url === '/api/ready' ? '{"ready":true}' : 'x'); });
        s.listen(Number(process.env.SERVER_PORT), '127.0.0.1');
        process.on('SIGTERM', () => s.close(() => process.exit(0)));
      `);

      const start = sh('start');
      assert.equal(start.status, 0, start.stdout + start.stderr);
      assert.ok(ready());
      const sup = readPid('supervisor.pid');
      const first = readPid('service.pid');
      assert.ok(sup && first);

      assert.equal(sh('start').status, 1, '已在跑时必须拒绝双启');

      process.kill(first!, 'SIGKILL');
      const back = await waitFor(() => {
        const now = readPid('service.pid');
        return Boolean(now && now !== first && ready());
      }, 15_000);
      assert.ok(back, 'kill -9 之后应当被守护循环拉起');
      assert.equal(readPid('supervisor.pid'), sup, '守护循环本身没换');
      assert.match(sh('status').stdout, /已拉起 1 次/);
      assert.match(fs.readFileSync(path.join(dir, 'prism.log'), 'utf8'), /服务意外退出\(code=137/);

      const stop = sh('stop');
      assert.equal(stop.status, 0, stop.stdout + stop.stderr);
      assert.ok(await waitFor(() => !ready(), 5_000));
      await new Promise((r) => setTimeout(r, 2_500)); // 比 1s 的退避长:确认没有被再拉起
      assert.equal(ready(), false);
      assert.equal(fs.existsSync(path.join(dir, '.run', 'supervisor.pid')), false);
    } finally {
      spawnSync('bash', [path.join(dir, 'prism.sh'), 'stop'], { cwd: dir, env, timeout: 30_000 });
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

/* ── hl 复核:prism.sh 的三处修补(假应用目录,另起端口) ────────────────── */

type FakeApp = {
  dir: string;
  port: number;
  env: Record<string, string>;
  sh: (...args: string[]) => ReturnType<typeof spawnSync>;
  readPid: (name: string) => number | null;
  ready: () => boolean;
  cleanup: () => Promise<void>;
};

const waitUntil = async (cond: () => boolean, ms: number) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (cond()) return true; await new Promise((r) => setTimeout(r, 200)); }
  return cond();
};

const alive = (pid: number | null) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/** 假应用:dist-server/server/index.js 是个小 http 服务;可选延迟监听、可选拉一个子进程(模拟 serve)。 */
async function makeFakeApp(extraEnv: Record<string, string> = {}): Promise<FakeApp> {
  const dir = await mkdtemp(path.join(tmpdir(), 'hl-ops-app-'));
  const port = await freePort();
  const env = { PATH: process.env.PATH ?? '', HOME: dir, SERVER_PORT: String(port), HOST: '127.0.0.1', FAKE_DIR: dir, ...extraEnv };
  fs.copyFileSync(path.join(repoRoot, 'prism.sh'), path.join(dir, 'prism.sh'));
  await mkdir(path.join(dir, 'dist-server', 'server'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist-server', 'server', 'index.js'), `
    const http = require('http');
    const fs = require('fs');
    const path = require('path');
    if (process.env.FAKE_SPAWN_CHILD === '1') {
      const c = require('child_process').spawn('sleep', ['300'], { stdio: 'ignore' });
      fs.writeFileSync(path.join(process.env.FAKE_DIR, 'grandchild.pid'), String(c.pid));
    }
    const s = http.createServer((q, r) => { r.end(q.url === '/api/ready' ? '{"ready":true}' : 'x'); });
    setTimeout(() => s.listen(Number(process.env.SERVER_PORT), '127.0.0.1'), Number(process.env.FAKE_LISTEN_DELAY_MS || 0));
    process.on('SIGTERM', () => s.close(() => process.exit(0)));
  `);
  const sh = (...args: string[]) => spawnSync('bash', [path.join(dir, 'prism.sh'), ...args], { cwd: dir, env, encoding: 'utf8', timeout: 60_000 });
  return {
    dir, port, env, sh,
    readPid: (name) => {
      try { return Number(fs.readFileSync(path.join(dir, '.run', name), 'utf8').trim()) || null; } catch { return null; }
    },
    ready: () => spawnSync('curl', ['-fsS', '-m', '2', `http://127.0.0.1:${port}/api/ready`]).status === 0,
    cleanup: async () => {
      spawnSync('bash', [path.join(dir, 'prism.sh'), 'stop'], { cwd: dir, env, timeout: 30_000 });
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** 一个不含 setsid 的 PATH:把现有 PATH 各目录里的可执行文件(除 setsid)软链进来。 */
function pathWithoutSetsid(root: string): string {
  const bin = path.join(root, 'bin-nosetsid');
  fs.mkdirSync(bin, { recursive: true });
  const dirs = [path.dirname(process.execPath), ...(process.env.PATH ?? '').split(path.delimiter)];
  for (const d of dirs) {
    let names: string[] = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const name of names) {
      if (name === 'setsid') continue;
      const link = path.join(bin, name);
      const target = path.join(d, name);
      if (fs.existsSync(link)) continue;
      // 只收可执行的普通文件:PATH 里偶有同名目录 / 不可执行文件,先占了名字会让 `env` 之类变成 Permission denied
      try {
        if (!fs.statSync(target).isFile()) continue;
        fs.accessSync(target, fs.constants.X_OK);
        fs.symlinkSync(target, link);
      } catch { /* 跳过 */ }
    }
  }
  return bin;
}

describe.skipIf(!hasTools)('hl 复核:prism.sh 守护循环的三处修补', () => {
  test('P2:上一轮残留的重启计数 ≥3,start / restart 不再误报「服务反复退出」', async () => {
    const app = await makeFakeApp();
    try {
      fs.mkdirSync(path.join(app.dir, '.run'), { recursive: true });
      fs.writeFileSync(path.join(app.dir, '.run', 'restarts'), '7\n');
      const start = app.sh('start');
      assert.equal(start.status, 0, String(start.stdout) + String(start.stderr));
      assert.doesNotMatch(String(start.stdout), /反复退出/);
      fs.writeFileSync(path.join(app.dir, '.run', 'restarts'), '9\n'); // 模拟 stop 后残留
      const restart = app.sh('restart');
      assert.equal(restart.status, 0, String(restart.stdout) + String(restart.stderr));
      assert.match(String(app.sh('status').stdout), /已拉起 0 次/);
    } finally {
      await app.cleanup();
    }
  }, 60_000);

  test('P3:进程组号直接取 $child —— kill -9 服务后它拉起的子进程(模拟孤儿 serve)被收掉', async () => {
    const sh = read('prism.sh');
    assert.match(sh, /svc_pgid="\$child"/);
    assert.ok(!/ps -o pgid= -p "\$child"/.test(sh), '不要再用 ps 读服务的 pgid(可能早于 setsid 执行)');

    const app = await makeFakeApp({ FAKE_SPAWN_CHILD: '1' });
    try {
      assert.equal(app.sh('start').status, 0);
      const grandchild = Number(fs.readFileSync(path.join(app.dir, 'grandchild.pid'), 'utf8'));
      assert.ok(alive(grandchild));
      process.kill(app.readPid('service.pid')!, 'SIGKILL');
      assert.ok(await waitUntil(() => !alive(grandchild), 10_000), '服务被 kill -9 后,它的子进程应当被按进程组收掉');
    } finally {
      await app.cleanup();
    }
  }, 60_000);

  test('P3:没有 setsid 时,start 等就绪期间按 Ctrl-C 不会停掉服务', async () => {
    const app = await makeFakeApp({ FAKE_LISTEN_DELAY_MS: '2500' });
    try {
      const nosetsid = pathWithoutSetsid(app.dir);
      const env = { ...app.env, PATH: nosetsid };
      assert.notEqual(spawnSync('bash', ['-c', 'command -v setsid'], { env }).status, 0, '夹具里不该有 setsid');
      // 模拟终端:start 自成前台进程组,Ctrl-C = 给整个组发 SIGINT
      const { spawn } = await import('node:child_process');
      const starter = spawn('bash', [path.join(app.dir, 'prism.sh'), 'start'], { cwd: app.dir, env, detached: true, stdio: 'ignore' });
      assert.ok(await waitUntil(() => Boolean(app.readPid('service.pid')), 10_000));
      const svc = app.readPid('service.pid');
      const sup = app.readPid('supervisor.pid');
      process.kill(-starter.pid!, 'SIGINT');
      assert.ok(await waitUntil(() => app.ready(), 10_000), 'Ctrl-C 之后服务应当照常就绪');
      assert.equal(app.readPid('service.pid'), svc, '服务不该被 INT 收掉再拉起');
      assert.ok(alive(sup), '守护循环不该被 INT 带走');
      assert.equal(fs.readFileSync(path.join(app.dir, '.run', 'restarts'), 'utf8').trim(), '0');
      const stop = spawnSync('bash', [path.join(app.dir, 'prism.sh'), 'stop'], { cwd: app.dir, env, encoding: 'utf8', timeout: 30_000 });
      assert.equal(stop.status, 0, stop.stdout + stop.stderr);
      assert.ok(await waitUntil(() => !app.ready() && !alive(sup), 10_000));
    } finally {
      await app.cleanup();
    }
  }, 60_000);
});

describe('hl 复核:启动链各段互不连坐', () => {
  test('runStartupStep:同步抛 / 异步 reject 都接住并记日志,返回 false;成功返回 true', async () => {
    const { runStartupStep } = await import('../utils/startup-step.js');
    const errors: unknown[][] = [];
    const logger = { error: (...args: unknown[]) => { errors.push(args); } };
    assert.equal(await runStartupStep('a', () => { throw new Error('sync boom'); }, logger), false);
    assert.equal(await runStartupStep('b', () => Promise.reject(new Error('async boom')), logger), false);
    assert.equal(await runStartupStep('c', () => undefined, logger), true);
    assert.equal(errors.length, 2);
    assert.match(String(errors[1][0]), /b 失败/);
  });

  test('index.js:会话监听失败不拦住 ma / skillwhet / 夜训 / 作业清理', () => {
    const index = read('server/index.js');
    const listen = index.slice(index.indexOf('server.listen(SERVER_PORT'), index.indexOf("log.error('Failed to start server:'"));
    assert.ok(!/\n\s*await initializeSessionsWatcher\(\);/.test(listen), '会话监听不能是裸 await(reject 会断掉后面整条链)');
    for (const label of ['ma service start', 'skillwhet service start', 'skillwhet nightly start', 'skillwhet jobs pruner start', 'sessions watcher']) {
      assert.ok(listen.includes(`runStartupStep('${label}'`), label);
    }
  });
});

/* ── P3:公共监管代码 ─────────────────────────────────────────────── */

class FakeChild extends EventEmitter {
  pid: number;
  killed: string[] = [];
  exitOnTerm: boolean;
  constructor(pid: number, exitOnTerm = true) { super(); this.pid = pid; this.exitOnTerm = exitOnTerm; }
  kill(signal: string) {
    this.killed.push(signal);
    if (signal === 'SIGKILL' || this.exitOnTerm) setImmediate(() => this.emit('exit', null, signal));
    return true;
  }
}

describe('hl 静态 P3:child-supervisor(ma-service / skillwhet-service 共用)', () => {
  const quietLogger = { log: () => {}, warn: () => {}, error: () => {} };

  test('意外退出 → 退避重启;稳定跑起后 stop 走 SIGTERM', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const children: FakeChild[] = [];
      let clock = 0;
      const sup = createChildSupervisor({
        tag: '[t]', label: 'x', host: '127.0.0.1', port: 1,
        spawnChild: () => { const c = new FakeChild(100 + children.length); children.push(c); return c as never; },
        onSpawnError: () => 'err', infantExitMessage: 'infant',
        classifyExisting: () => null, isReady: (r: { alive: boolean }) => r.alive,
        readyMessage: () => 'ready', timeoutMessage: () => 'timeout',
      }, {
        logger: quietLogger, probe: async () => ({ alive: children.length > 0 }),
          // 让出一拍宏任务:假子进程的 exit 在 setImmediate 里发,stop() 的等待循环要能等到它
        sleep: (ms: number) => new Promise<void>((r) => setImmediate(r)).then(() => { clock += Math.max(ms, 100); }), now: () => clock,
      });
      assert.equal(await sup.start(), 'running');
      children[0].emit('exit', 1, null);
      await vi.advanceTimersByTimeAsync(1_000);
      assert.equal(children.length, 2, '1s 退避后应当重启一次');
      assert.equal(sup.pid, 101);
      await sup.stop();
      assert.deepEqual(children[1].killed, ['SIGTERM']);
      assert.equal(sup.state, 'stopped');
    } finally {
      vi.useRealTimers();
    }
  });

  test('退出码 2 且活不过 infantMs → 放弃(配置问题,重启无用);不肯退的子进程升级 SIGKILL', async () => {
    let clock = 0;
    const errors: string[] = [];
    const children: FakeChild[] = [];
    const sup = createChildSupervisor({
      tag: '[t]', label: 'x', host: '127.0.0.1', port: 1,
      spawnChild: () => { const c = new FakeChild(1, false); children.push(c); return c as never; },
      onSpawnError: () => 'err', infantExitMessage: 'infant-msg',
      classifyExisting: () => null, isReady: () => false,
      readyMessage: () => 'ready', timeoutMessage: () => 'timeout',
    }, {
      logger: { log: () => {}, warn: () => {}, error: (m: string) => errors.push(m) },
      probe: async () => ({ alive: false }),
      sleep: async () => { clock += 100; if (clock === 100) children[0].emit('exit', 2, null); },
      now: () => clock, healthWaitMs: 1_000, termGraceMs: 300,
    });
    assert.equal(await sup.start(), 'failed');
    assert.ok(errors.some((m) => m.includes('infant-msg')));
    assert.equal(children.length, 1);

    // 另起一个不肯退的:stop 在宽限后升级 SIGKILL
    clock = 0;
    const stubborn = new FakeChild(2, false);
    const sup2 = createChildSupervisor({
      tag: '[t]', label: 'x', host: '127.0.0.1', port: 1, spawnChild: () => stubborn as never,
      onSpawnError: () => '', infantExitMessage: '', classifyExisting: () => null,
      isReady: () => true, readyMessage: () => '', timeoutMessage: () => '',
    }, { logger: quietLogger, probe: async () => ({ alive: false }), sleep: async (ms: number) => { clock += ms; }, now: () => clock, termGraceMs: 300 });
    await sup2.start();
    await sup2.stop();
    assert.deepEqual(stubborn.killed, ['SIGTERM', 'SIGKILL']);
  });

  test('两份服务确实改用公共实现(重复代码不再回来)', () => {
    for (const file of ['server/services/ma-service.js', 'server/services/skillwhet-service.js']) {
      const src = read(file);
      assert.match(src, /createChildSupervisor\(/);
      assert.ok(!src.includes('function pipeLines('), `${file} 里又长出了自己的 pipeLines`);
    }
  });
});

/* ── P3:SkillWhet jobs/ 保留策略 ──────────────────────────────────── */

describe('hl 静态 P3:SkillWhet home 的 jobs/ 保留策略', () => {
  test('超过保留天数的已结束作业删掉;在跑 / 排队的不动;0 = 永不', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'hl-ops-sw-'));
    try {
      const now = Date.parse('2026-09-29T00:00:00Z');
      const day = 86_400_000;
      const mk = (id: string, state: Record<string, unknown> | null, mtimeDaysAgo?: number) => {
        const d = path.join(home, 'jobs', id);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'stdout.log'), 'log');
        if (state) fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify(state));
        if (mtimeDaysAgo !== undefined) { const t = new Date(now - mtimeDaysAgo * day); fs.utimesSync(d, t, t); }
      };
      mk('old-done', { state: 'succeeded', created_at: new Date(now - 120 * day).toISOString(), finished_at: new Date(now - 100 * day).toISOString() });
      mk('old-running', { state: 'running', created_at: new Date(now - 200 * day).toISOString() });
      mk('old-queued', { state: 'queued', created_at: new Date(now - 200 * day).toISOString() });
      mk('recent', { state: 'failed', finished_at: new Date(now - 10 * day).toISOString() });
      mk('no-state-old', null, 95);
      fs.mkdirSync(path.join(home, 'work', 'skill-a'), { recursive: true });

      const logger = { log: () => {}, warn: () => {}, error: () => {} };
      assert.deepEqual(pruneSkillWhetJobs(home, { retentionDays: 0, now: () => now, logger }).removed, []);
      const { removed } = pruneSkillWhetJobs(home, { retentionDays: 90, now: () => now, logger });
      assert.deepEqual(removed.sort(), ['no-state-old', 'old-done']);
      assert.deepEqual(fs.readdirSync(path.join(home, 'jobs')).sort(), ['old-queued', 'old-running', 'recent']);
      assert.ok(fs.existsSync(path.join(home, 'work', 'skill-a')), 'work/ 不归它管');

      assert.equal(jobsRetentionDaysFromEnv({}), 90);
      assert.equal(jobsRetentionDaysFromEnv({ PRISM_SKILLWHET_JOBS_RETENTION_DAYS: '0' }), 0);
      assert.equal(jobsRetentionDaysFromEnv({ PRISM_SKILLWHET_JOBS_RETENTION_DAYS: 'abc' }), 90);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

/* ── 测试空白:verifyWebSocketClient ──────────────────────────────── */

describe('hl 测试空白:WS 鉴权闸门 verifyWebSocketClient', () => {
  afterEach(() => __resetTicketsForTest());

  test('票据 / 重放 / token_version / JWT 头 / ?token= 开关 / 平台模式', async () => {
    await withIsolatedDatabase(async () => {
      await withEnv({ JWT_SECRET: 'hl-ops-test-secret', PRISM_ALLOW_QUERY_TOKEN: undefined }, async () => {
        await initializeDatabase();
        const alice = userDb.createUser('alice', 'hash');
        const aliceId = Number(alice.id);
        const { authenticateWebSocket, generateToken } = await import('../middleware/auth.js');
        const deps = { isPlatform: false, authenticateWebSocket, consumeTicket };
        const call = (url: string, headers: Record<string, string> = {}) => {
          const req = { url, headers } as unknown as { user?: { userId?: number; username?: string } };
          const ok = verifyWebSocketClient({ req, origin: '', secure: false } as never, deps as never);
          return { ok, user: req.user };
        };

        // 1. 票据:一次有效,重放拒绝
        const ticket = issueTicket(aliceId, userDb.getUserById(aliceId)!.token_version ?? 0);
        const first = call(`/ws?ticket=${ticket}`);
        assert.equal(first.ok, true);
        assert.equal(first.user?.username, 'alice');
        assert.equal(call(`/ws?ticket=${ticket}`).ok, false, '票据只能用一次');

        // 2. 票据签发后「退出所有设备」:token_version 变了 → 拒
        const stale = issueTicket(aliceId, userDb.getUserById(aliceId)!.token_version ?? 0);
        const jwtBefore = generateToken(userDb.getUserById(aliceId)!);
        assert.equal(call('/ws', { authorization: `Bearer ${jwtBefore}` }).ok, true, 'JWT 头是默认通道');
        userDb.bumpTokenVersion(aliceId);
        assert.equal(call(`/ws?ticket=${stale}`).ok, false, '旧 token_version 的票据必须失效');
        assert.equal(call('/ws', { authorization: `Bearer ${jwtBefore}` }).ok, false, '旧 token_version 的 JWT 必须失效');

        // 3. ?token= 只有显式开关才认
        const jwtNow = generateToken(userDb.getUserById(aliceId)!);
        assert.equal(call(`/ws?token=${jwtNow}`).ok, false);
        await withEnv({ PRISM_ALLOW_QUERY_TOKEN: '1' }, () => {
          assert.equal(call(`/ws?token=${jwtNow}`).ok, true);
        });

        // 4. 伪造 / 无凭据
        assert.equal(call('/ws?ticket=deadbeef').ok, false);
        assert.equal(call('/ws').ok, false);

        // 5. 平台模式:取依赖给的用户,不看凭据
        const platform = verifyWebSocketClient(
          { req: { url: '/ws', headers: {} }, origin: '', secure: false } as never,
          { isPlatform: true, authenticateWebSocket: () => ({ userId: 9, username: 'p' }) } as never,
        );
        assert.equal(platform, true);
      });
    });
  });
});

/* ── 测试空白:调度器主循环与并发 ─────────────────────────────────── */

describe('hl 测试空白:调度器主循环与 claimRun 并发', () => {
  test('claimRun 原子:同一任务只能认领一次;调度 + 立即运行并发只跑一次;主循环按拍捞到期任务', async () => {
    await withIsolatedDatabase(async (dir) => {
      await withEnv({ WORKSPACES_ROOT: dir, PRISM_ROOT_USERS: 'boss' }, async () => {
        await initializeDatabase();
        const owner = Number(userDb.createUser('alice', 'hash').id);
        const projectPath = path.join(dir, 'proj');
        await mkdir(projectPath, { recursive: true });
        projectsDb.createProjectPath(projectPath, null, owner);
        const insert = (id: string) => {
          scheduledTasksDb.insert({
            id, name: `task ${id}`, instructions: '回归', project_path: projectPath,
            session_mode: 'new', fixed_session_id: null, frequency: 'daily',
            run_at_hour: 9, run_at_minute: 0, run_at_weekday: null, run_at_day: null,
            model: 'no-such-model-hl-ops', permission_mode: 'default',
            enabled: 1, owner_user_id: owner, next_run_at: '2020-01-01 00:00:00',
          });
          return scheduledTasksDb.getById(id)!;
        };

        // 1. claimRun 本身
        insert('t-claim');
        assert.equal(scheduledTasksDb.claimRun('t-claim'), true);
        assert.equal(scheduledTasksDb.claimRun('t-claim'), false);
        // startTaskScheduler 会 releaseStaleRunning 把它松开、变成到期任务 —— 停用,免得干扰后面的计数
        getConnection().prepare("UPDATE scheduled_tasks SET enabled = 0 WHERE id = 't-claim'").run();

        // 2. 并发:第一次运行卡在模型调用上,期间再来调度 / 立即运行都不能开第二个
        let calls = 0;
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => { release = resolve; });
        startTaskScheduler(async () => {
          calls += 1;
          await gate;
          return { ok: true, exitCode: 0, aborted: false, error: null, sessionId: null };
        });
        const task = insert('t-race');
        const a = executeTask(task, 'schedule');
        const b = executeTask(task, 'manual');
        await new Promise((r) => setTimeout(r, 200));
        assert.deepEqual(runTaskNow('t-race'), { ok: false, error: 'already_running' });
        release();
        await Promise.all([a, b]);
        assert.equal(calls, 1, '只能跑一次');
        assert.equal(scheduledTasksDb.listRuns('t-race').total, 1);
        stopTaskScheduler();

        // 3. 主循环:30s 一拍,捞到期任务并执行;执行中下一拍不重复开跑
        vi.useFakeTimers({ toFake: ['setInterval'] });
        try {
          let loopCalls = 0;
          let loopRelease: () => void = () => {};
          const loopGate = new Promise<void>((resolve) => { loopRelease = resolve; });
          startTaskScheduler(async () => {
            loopCalls += 1;
            await loopGate;
            return { ok: true, exitCode: 0, aborted: false, error: null, sessionId: null };
          });
          insert('t-loop');
          await vi.advanceTimersByTimeAsync(30_000);
          const deadline = Date.now() + 5_000;
          while (loopCalls === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
          assert.equal(loopCalls, 1, '第一拍应当把到期任务跑起来');
          await vi.advanceTimersByTimeAsync(30_000);
          await new Promise((r) => setTimeout(r, 200));
          assert.equal(loopCalls, 1, '还在跑的任务下一拍不能再开一个');
          loopRelease();
          const done = Date.now() + 5_000;
          while (scheduledTasksDb.listRuns('t-loop').total === 0 && Date.now() < done) await new Promise((r) => setTimeout(r, 50));
          assert.equal(scheduledTasksDb.listRuns('t-loop').total, 1);
        } finally {
          stopTaskScheduler();
          vi.useRealTimers();
        }
      });
    });
  });
});

/* ── P2-26 / P2-27 / P3:依赖与构建卫生(源码钉住) ────────────────── */

describe('hl 静态 P2-26 / P2-27 / P3:依赖与构建卫生', () => {
  test('无人引用的开发依赖已删;sharp ≥ 0.35;claude-agent-sdk 不在这一轮升级', () => {
    const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    for (const name of ['release-it', '@release-it/conventional-changelog', 'auto-changelog', 'node-gyp']) {
      assert.equal(pkg.devDependencies[name], undefined, `${name} 应当删掉`);
    }
    assert.match(pkg.dependencies.sharp, /^\^0\.3[5-9]\./);
    assert.equal(pkg.dependencies['@anthropic-ai/claude-agent-sdk'], '^0.3.165');
  });

  test('tailwind blocklist 挡住 JS 取反被当成 important 变体', async () => {
    const config = (await import('../../tailwind.config.js')).default as { blocklist?: string[] };
    for (const name of ['!user', '!error', '!container', '!relative']) assert.ok(config.blocklist?.includes(name), name);
  });
});
