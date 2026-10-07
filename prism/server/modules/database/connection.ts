/**
 * Database connection management.
 *
 * Owns the single SQLite connection used across all repositories: path
 * resolution, directory creation, connection pragmas, eager app_config
 * bootstrap (so the auth middleware can read the JWT secret before the full
 * schema is applied), and database backups.
 *
 * Consumers should never create their own Database instance — they use
 * `getConnection()` to obtain the shared singleton.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import Database from 'better-sqlite3';

import { APP_CONFIG_TABLE_SCHEMA_SQL } from '@/modules/database/schema.js';
import { createLogger } from '@/shared/logger.js';
const log = createLogger('db');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the database file path.
 *
 * Priority:
 *   1. DATABASE_PATH environment variable (set by server/load-env.js: the .env value, or
 *      auth.db in the data dir — PRISM_DATA_DIR, default ~/.prism)
 *   2. In-tree fallback: database/auth.db, with database/ a sibling of server/
 */
function resolveDatabasePath(): string {
    // load-env.js 总会设 DATABASE_PATH;落到兜底路径的只有直接 import 本模块、又没设 DATABASE_PATH 的测试。
    return process.env.DATABASE_PATH || resolveInTreeDatabasePath();
}

/**
 * DATABASE_PATH 没设时的落点:源码布局下是仓库根的 database/auth.db,编译布局下是
 * dist-server/database/auth.db(每次构建都会随 dist-server 一起清掉)。只给测试用,不能当真库。
 */
function resolveInTreeDatabasePath(): string {
  const serverParentDir = path.resolve(__dirname, '..', '..', '..');
  return path.join(serverParentDir, 'database', 'auth.db');
}

// ---------------------------------------------------------------------------
// Directory helpers
// ---------------------------------------------------------------------------

function ensureDatabaseDirectory(dbPath: string): void {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    log.info('Created database directory:', dir);
  }
}

// ---------------------------------------------------------------------------
// Singleton connection
// ---------------------------------------------------------------------------

let instance: Database.Database | null = null;

/**
 * Returns the shared database connection, creating it on first call.
 *
 * The first invocation:
 *   1. Resolves the target database path
 *   2. Ensures the parent directory exists
 *   3. Opens the SQLite connection and applies the pragmas
 *   4. Eagerly creates the app_config table (auth reads JWT secret at import time)
 */
export function getConnection(): Database.Database {
  if (instance) return instance;

  const dbPath = resolveDatabasePath();

  ensureDatabaseDirectory(dbPath);

  instance = new Database(dbPath);
  applyPragmas(instance);

  // app_config must exist immediately — the auth middleware reads
  // the JWT secret at module-load time, before initializeDatabase() runs.
  instance.exec(APP_CONFIG_TABLE_SCHEMA_SQL);

  return instance;
}

// ---------------------------------------------------------------------------
// Durability & concurrency
// ---------------------------------------------------------------------------

/**
 * Connection-level pragmas, applied once per process.
 *
 * WAL matters here specifically: the sessions watcher, the chat WebSocket
 * handlers, and HTTP request handlers all write through this one connection
 * while long reads (session history scans) are in flight. Under the default
 * rollback journal those readers block writers and vice versa, which surfaces
 * as intermittent SQLITE_BUSY during large project scans.
 *
 * `busy_timeout` covers the remaining contention window instead of failing
 * the query immediately. `foreign_keys` is off by default in SQLite and must
 * be set per connection — without it the ON DELETE CASCADE clauses declared
 * throughout schema.ts are silently inert.
 */
function applyPragmas(db: Database.Database): void {
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    // NORMAL is the recommended pairing with WAL: durable across process
    // crashes, only at risk on OS/power loss, and avoids an fsync per commit.
    db.pragma('synchronous = NORMAL');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('Could not apply database pragmas', { error: message });
  }
}

/**
 * 增量备份每批拷多少页。
 *
 * 100 页 × 4KB ≈ 400KB —— 单批的耗时远小于一帧预算,而批数够少,不至于让
 * 回调本身成为开销。调大它会让备份更快但更"顿",调小反之。
 */
const BACKUP_PAGES_PER_STEP = 100;

/** 迁移前备份的文件名后缀。带这个后缀的不按日期裁剪,只留最近 PRE_MIGRATION_KEEP 份。 */
export const PRE_MIGRATION_SUFFIX = '-pre-migration';

/** 例行备份默认保留的天数。 */
export const DEFAULT_BACKUP_KEEP_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

export type BackupOptions = {
  /** 例行备份按日期保留几天(每天只留最新一份)。默认 14;<= 0 表示不裁剪。 */
  keepDays?: number;
  /** 'pre-migration':文件名带 `-pre-migration` 后缀,不参与按日期裁剪(只按份数留最近几份)。 */
  label?: 'pre-migration';
  /** 注入时钟,给测试用。 */
  now?: () => Date;
};

/**
 * 迁移前备份保留最近几份。
 *
 * 它们不参与按日期裁剪(迁移事故可能几周后才被发现),但也不能无限留:指纹对 schema.ts 的
 * 任何改动都敏感,每次带 schema 改动的发版都会多一份整库副本。5 份覆盖最近五次这样的升级;
 * 写死而不做成配置,要更多的人手工 cp 到别的名字即可(不会被删)。
 */
export const PRE_MIGRATION_KEEP = 5;

/**
 * 从环境变量读例行备份的保留天数。
 * `PRISM_DB_BACKUP_KEEP_DAYS` 优先;也认旧名 `PRISM_DB_BACKUP_KEEP`(原义是份数,
 * 一天一份时与天数相等),按天数解释,已有的 .env 不用改。
 *
 * 0、负数、认不出的值都按默认:旧名下 `PRISM_DB_BACKUP_KEEP=0` 的含义是"用默认值",
 * 不能变成"永不裁剪"把盘写满。想关掉备份用 `PRISM_DB_BACKUP=0`。
 */
export function backupKeepDaysFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  for (const key of ['PRISM_DB_BACKUP_KEEP_DAYS', 'PRISM_DB_BACKUP_KEEP']) {
    const raw = env[key];
    if (raw === undefined || raw.trim() === '') continue;
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_BACKUP_KEEP_DAYS;
}

/** 备份目录:数据库旁边的 backups/。 */
export function resolveBackupDir(dbPath: string = resolveDatabasePath()): string {
  return path.join(path.dirname(dbPath), 'backups');
}

/**
 * 把数据库完整拷一份到旁边的 backups/ 目录,然后裁剪旧的。
 *
 * 用 `db.backup()` 而不是 `VACUUM INTO`,也不是直接拷文件:
 *
 * - 直接 cp 一个 WAL 模式的库,没带上 -wal 那份就是旧的。
 * - `VACUUM INTO` 是 better-sqlite3 的同步 API,整份库拷完之前事件循环一步都走不了:
 *   百 MB 级的库就要停顿数百毫秒,1GB 是秒级 —— 期间所有人的 WebSocket 帧、
 *   HTTP 请求、定时任务一起停摆,而这只是一次例行备份。
 * - `db.backup()` 是增量的:每次 `progress` 回调返回下一批要拷的页数,
 *   两批之间事件循环能喘气。100 页一批,在 4KB 页大小下约 400KB —— 单批远小于
 *   一帧的预算,拷 1GB 也不会让任何一次请求明显变慢。
 *
 * 代价是 `backup()` 不做碎片整理(VACUUM 会),所以备份文件可能比源库略大。
 * 对一份备份来说这不重要 —— 它是拿来恢复的,不是拿来省空间的。
 *
 * 另外:
 *   1. 先写 `.tmp` 再 rename:半截文件不会顶着 `.db` 的名字混进备份,既不占裁剪名额,
 *      也不会被当成一份好备份拿去恢复;
 *   2. `label: 'pre-migration'` 的备份带后缀、不按日期裁剪(只留最近 PRE_MIGRATION_KEEP 份);
 *   3. 例行备份按日期裁剪(见 pruneBackups)。
 *
 * 调用方:init-db 的例行备份定时器。迁移前那份要求同步,走 backupDatabaseSync。
 */
export async function backupDatabase(options: BackupOptions | number = {}): Promise<string | null> {
  // 也接受一个数字,按 keepDays 解释。
  const opts: BackupOptions = typeof options === 'number' ? { keepDays: options } : options;
  const keepDays = opts.keepDays ?? DEFAULT_BACKUP_KEEP_DAYS;
  const now = opts.now ?? (() => new Date());

  const dbPath = resolveDatabasePath();
  if (!fs.existsSync(dbPath)) return null;

  const backupDir = resolveBackupDir(dbPath);
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const stamp = now().toISOString().replace(/[:.]/g, '-');
  const baseName = path.basename(dbPath, path.extname(dbPath));
  const suffix = opts.label === 'pre-migration' ? PRE_MIGRATION_SUFFIX : '';
  const target = path.join(backupDir, `${baseName}-${stamp}${suffix}.db`);
  const tmp = `${target}.tmp`;

  try {
    const db = getConnection();
    // 同一秒重试是空操作(目标文件已存在)。
    if (fs.existsSync(target)) return target;
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);

    await db.backup(tmp, {
      progress: ({ remainingPages }) => (remainingPages > 0 ? BACKUP_PAGES_PER_STEP : 0),
    });
    fs.renameSync(tmp, target);
    if (opts.label === 'pre-migration') prunePreMigrationBackups(backupDir, baseName);
    else pruneBackups(backupDir, baseName, keepDays, now());
    return target;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Database backup failed', { error: message });
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* 半截文件删不掉也不影响主流程 */ }
    return null;
  }
}

/**
 * 同步备份,只给"迁移前"那一份用(裁剪也只按迁移前备份的规则做)。
 *
 * 不复用上面的增量 `db.backup()`:它是异步的,而 `initializeDatabase` 从开头到迁移跑完
 * 都是同步的 —— 不少测试与启动路径依赖"调用返回时表已经是新形状"。在迁移前插一个 await,
 * 这些调用方就会在迁移跑完之前读表。
 *
 * 用 `VACUUM INTO`:同步、自带一致性(读事务里拷),产出的是整理过的完整副本。它会阻塞
 * 事件循环 —— 但此刻服务还没开始监听,没有请求在等,而迁移本来就必须等它写完。
 * 同样先写 `.tmp` 再 rename。
 */
export function backupDatabaseSync(options: Pick<BackupOptions, 'label' | 'now'> = {}): string | null {
  const now = options.now ?? (() => new Date());
  const dbPath = resolveDatabasePath();
  if (!fs.existsSync(dbPath)) return null;

  const backupDir = resolveBackupDir(dbPath);
  const stamp = now().toISOString().replace(/[:.]/g, '-');
  const baseName = path.basename(dbPath, path.extname(dbPath));
  const suffix = options.label === 'pre-migration' ? PRE_MIGRATION_SUFFIX : '';
  const target = path.join(backupDir, `${baseName}-${stamp}${suffix}.db`);
  const tmp = `${target}.tmp`;

  try {
    fs.mkdirSync(backupDir, { recursive: true });
    if (fs.existsSync(target)) return target;
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    getConnection().prepare('VACUUM INTO ?').run(tmp);
    fs.renameSync(tmp, target);
    prunePreMigrationBackups(backupDir, baseName);
    return target;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Database backup failed', { error: message });
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* 半截文件删不掉也不影响主流程 */ }
    return null;
  }
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 备份文件名 → 它的日期(YYYY-MM-DD,取自文件名里的 ISO 时间戳);认不出返回 null。 */
export function backupDateOf(fileName: string, baseName: string): string | null {
  const match = new RegExp(`^${escapeRegExp(baseName)}-(\\d{4}-\\d{2}-\\d{2})T`).exec(fileName);
  return match ? match[1] : null;
}

/** 迁移前备份只留最近 `keep` 份(见 PRE_MIGRATION_KEEP)。 */
export function prunePreMigrationBackups(backupDir: string, baseName: string, keep = PRE_MIGRATION_KEEP): string[] {
  const removed: string[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(backupDir);
  } catch {
    return removed;
  }
  const stale = names
    .filter((name) => name.startsWith(`${baseName}-`) && name.endsWith(`${PRE_MIGRATION_SUFFIX}.db`))
    .filter((name) => backupDateOf(name, baseName) !== null)
    .sort()
    .reverse()
    .slice(Math.max(keep, 1));
  for (const name of stale) {
    try {
      fs.unlinkSync(path.join(backupDir, name));
      removed.push(name);
    } catch { /* 删不掉不影响主流程 */ }
  }
  return removed;
}

/**
 * 裁剪例行备份 —— 按日期,不按份数:每次重启都会备份,按份数留的话,
 * 一天部署几次就会把前几天的快照全挤掉。规则:
 *   · 带 `-pre-migration` 后缀的不在这里删,由 prunePreMigrationBackups 只留最近 PRE_MIGRATION_KEEP 份;
 *   · 其余按文件名里的日期分组,每天只留最新一份;
 *   · 日期早于 `keepDays` 天前的整天删掉。`keepDays <= 0` 表示不裁剪(下面的 .tmp 清理照做);
 *   · 顺带清掉超过 1 小时的 `.tmp` 半截文件(上一个进程写到一半被杀)。
 *
 * 只认自己的命名(`<base>-<ISO 时间戳>[-pre-migration].db`),别的文件一概不碰 ——
 * 运维手工 cp 到这个目录里的备份不该被程序删掉。
 */
export function pruneBackups(backupDir: string, baseName: string, keepDays: number, now: Date = new Date()): string[] {
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(backupDir);
  } catch {
    return removed;
  }

  const unlink = (name: string) => {
    try {
      fs.unlinkSync(path.join(backupDir, name));
      removed.push(name);
    } catch {
      // A backup we cannot remove is not worth failing the run over.
    }
  };

  // 半截文件:超过 1 小时的 .tmp 一定不是正在写的那份。
  for (const name of entries) {
    if (!name.startsWith(`${baseName}-`) || !name.endsWith('.db.tmp')) continue;
    try {
      const ageMs = now.getTime() - fs.statSync(path.join(backupDir, name)).mtimeMs;
      if (ageMs > 60 * 60 * 1000) unlink(name);
    } catch { /* 已经没了 */ }
  }

  if (!(keepDays > 0)) return removed;

  const routine = entries
    .filter((name) => name.startsWith(`${baseName}-`) && name.endsWith('.db') && !name.endsWith(`${PRE_MIGRATION_SUFFIX}.db`))
    .filter((name) => backupDateOf(name, baseName) !== null)
    .sort()
    .reverse(); // 时间戳可排序:新的在前

  const cutoff = new Date(now.getTime() - keepDays * DAY_MS).toISOString().slice(0, 10);
  const seenDays = new Set<string>();
  for (const name of routine) {
    const day = backupDateOf(name, baseName)!;
    if (day < cutoff) { unlink(name); continue; }
    if (seenDays.has(day)) { unlink(name); continue; }
    seenDays.add(day);
  }
  return removed;
}

/**
 * Returns the resolved database file path without opening a connection.
 * Useful for diagnostics and CLI status commands.
 */
export function getDatabasePath(): string {
  return resolveDatabasePath();
}

/**
 * Closes the database connection and clears the singleton.
 * Primarily used for graceful shutdown or testing.
 */
export function closeConnection(): void {
  if (instance) {
    instance.close();
    instance = null;
    log.info('Database connection closed');
  }
}
