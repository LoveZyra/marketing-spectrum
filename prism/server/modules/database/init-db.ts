import crypto from 'crypto';

import type { Database } from 'better-sqlite3';

import { backupDatabase, backupDatabaseSync, backupKeepDaysFromEnv, getConnection } from "@/modules/database/connection.js";
import { REQUIRED_COLUMNS, findMissingColumns, runMigrations } from "@/modules/database/migrations.js";
import { credentialsDb } from "@/modules/database/repositories/credentials.js";
import { INDEX_SCHEMA_SQL, INIT_SCHEMA_SQL, RETIRED_INDEXES } from "@/modules/database/schema.js";
import { createLogger } from "@/shared/logger.js";
const log = createLogger("db");

const DAY_MS = 24 * 60 * 60 * 1000;

let backupTimer: NodeJS.Timeout | null = null;
// 首跑是个独立的一次性定时器(启动后约 60s 触发)。它必须也被 stop 清掉:
// 若恰在这 60s 窗口内 shutdown,首跑的 backupDatabase 会经 getConnection() 把
// 刚 close 掉的库重新打开 —— 正是 stopDatabaseBackups 想防的那件事。
let initialBackupTimer: NodeJS.Timeout | null = null;

/**
 * Starts the rolling database backup.
 *
 * Runs once shortly after boot and then daily. Disabled with PRISM_DB_BACKUP=0;
 * retention is PRISM_DB_BACKUP_KEEP_DAYS (default 14 days, one per day — see
 * pruneBackups in connection.ts) and the interval is PRISM_DB_BACKUP_INTERVAL_MS.
 *
 * The timer is unref'd so it never holds the process open during shutdown.
 */
export const startDatabaseBackups = (): void => {
    if (process.env.PRISM_DB_BACKUP === '0') return;
    if (backupTimer) return;

    const keepDays = backupKeepDaysFromEnv();
    const intervalMs =
        Number.parseInt(process.env.PRISM_DB_BACKUP_INTERVAL_MS ?? '', 10) || DAY_MS;

    // Delay the first run so it never competes with startup work (schema,
    // migrations, project scan) for the same write lock.
    initialBackupTimer = setTimeout(() => {
        initialBackupTimer = null;
        // backupDatabase 是异步的增量备份(见 connection.ts),悬空的 promise 必须接住 ——
        // 未处理的 rejection 会让整个进程退出。
        void backupDatabase({ keepDays }).catch((error) => log.error('Database backup failed', error));
    }, 60_000);
    initialBackupTimer.unref();

    backupTimer = setInterval(() => {
        void backupDatabase({ keepDays }).catch((error) => log.error('Database backup failed', error));
    }, intervalMs);
    backupTimer.unref();
};

/** Stops the backup timers. Used by the shutdown path and by tests. */
export const stopDatabaseBackups = (): void => {
    if (initialBackupTimer) {
        clearTimeout(initialBackupTimer);
        initialBackupTimer = null;
    }
    if (backupTimer) {
        clearInterval(backupTimer);
        backupTimer = null;
    }
};

/* ── schema 指纹 ───────────────────────────────────────────────────────── */

/** app_config 里存指纹的键。 */
export const SCHEMA_FINGERPRINT_KEY = 'schema_fingerprint';

/**
 * 当前代码期望的 schema 指纹:建表 SQL + 索引 SQL + 退役索引 + 必需列清单的 sha256。
 *
 * 这个仓库的迁移全是幂等的"缺什么补什么",没有版本号 —— 跑迁移之前无从直接知道
 * "这次启动会不会动表"。指纹是最便宜的替代:schema.ts 里的 SQL 或 REQUIRED_COLUMNS
 * 一改,指纹就变,启动时与库里存的那份不同即视为"有待跑迁移"。会有误报(SQL 里改一行
 * 注释也算),代价只是多备份一份 —— 比漏报便宜得多。
 */
export const computeSchemaFingerprint = (): string =>
    crypto.createHash('sha256')
        .update(INIT_SCHEMA_SQL)
        .update('\n--index--\n')
        .update(INDEX_SCHEMA_SQL)
        .update('\n--retired--\n')
        .update(JSON.stringify(RETIRED_INDEXES))
        .update('\n--columns--\n')
        .update(JSON.stringify(REQUIRED_COLUMNS))
        .digest('hex');

const readStoredFingerprint = (db: Database): string | null => {
    try {
        const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(SCHEMA_FINGERPRINT_KEY) as
            | { value: string }
            | undefined;
        return row?.value ?? null;
    } catch {
        return null;
    }
};

const writeStoredFingerprint = (db: Database, fingerprint: string): void => {
    db.prepare(
        'INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(SCHEMA_FINGERPRINT_KEY, fingerprint);
};

const tableExists = (db: Database, name: string): boolean =>
    Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

/** INIT_SCHEMA_SQL 里声明的全部表名。 */
const declaredTables = (): string[] =>
    [...INIT_SCHEMA_SQL.matchAll(/CREATE TABLE IF NOT EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);

export type PendingMigrationCheck = {
    pending: boolean;
    /** 为什么判定要迁移;不迁时为空。 */
    reasons: string[];
    /** 这是不是一个还没有 users 表的全新库 —— 全新库没有什么可保护的,不备份。 */
    fresh: boolean;
};

/**
 * 这次启动会不会动表?三个判据任一命中就算:指纹不同(或没存过)、缺表、缺列。
 * 全新库(没有 users 表)一律不算 —— 没东西可备份。
 */
export const detectPendingMigration = (db: Database, fingerprint = computeSchemaFingerprint()): PendingMigrationCheck => {
    if (!tableExists(db, 'users')) return { pending: false, reasons: [], fresh: true };
    const reasons: string[] = [];

    const stored = readStoredFingerprint(db);
    if (stored === null) reasons.push('库里没有 schema 指纹记录(首次升级到带指纹的版本,或从旧备份恢复)');
    else if (stored !== fingerprint) reasons.push(`schema 指纹变了(${stored.slice(0, 12)} → ${fingerprint.slice(0, 12)})`);

    const missingTables = declaredTables().filter((name) => !tableExists(db, name));
    if (missingTables.length > 0) reasons.push(`缺表:${missingTables.join(', ')}`);

    const missingColumns = Object.entries(findMissingColumns(db)).map(([table, cols]) => `${table}(${cols.join(', ')})`);
    if (missingColumns.length > 0) reasons.push(`缺列:${missingColumns.join('; ')}`);

    return { pending: reasons.length > 0, reasons, fresh: false };
};

/**
 * 迁移前备份。
 *
 * 例行备份的首跑在启动 60 秒后,那时迁移早已跑完;所以有待跑迁移时,要在迁移之前先同步备份
 * 一份(带 `-pre-migration` 后缀,不按日期裁剪,只留最近 PRE_MIGRATION_KEEP 份)。
 * 备份失败不阻止启动,但会打 error 日志。
 *
 * PRISM_DB_BACKUP=0 也关掉这一份 —— 那是"这台机器不要程序备份"的明确意思。
 *
 * 必须同步(backupDatabaseSync):initializeDatabase 从开头到迁移跑完都要保持同步,理由见那里。
 */
export const backupBeforeMigration = (db: Database, fingerprint = computeSchemaFingerprint()): string | null => {
    if (process.env.PRISM_DB_BACKUP === '0') return null;
    const check = detectPendingMigration(db, fingerprint);
    if (!check.pending) return null;
    log.info(`有待跑的迁移,先备份:${check.reasons.join(';')}`);
    const target = backupDatabaseSync({ label: 'pre-migration' });
    if (target) log.info('迁移前备份已写入', { path: target });
    else log.error('迁移前备份失败 —— 继续启动,但这次迁移没有兜底,请立刻手工备份 auth.db');
    return target;
};

/**
 * 历史明文凭据就地加密(见 `credentialsDb.encryptLegacyPlaintext`)。
 *
 * 放在迁移之后、而不是 runMigrations 里:它要用应用层的密钥(PRISM_ENCRYPTION_KEY 或 app_config),
 * 与凭据读写同一条取钥路径;而且失败不该挡启动 —— runMigrations 出错会让服务起不来,
 * 这一步出错时明文行照样读得出,记一条 error,下次启动再试。每次启动都跑,没有明文行时只是一次空查询。
 */
const encryptLegacyCredentials = (): void => {
    try {
        credentialsDb.encryptLegacyPlaintext();
    } catch (err) {
        log.error('历史明文凭据加密失败,这些行保持明文(仍可读),下次启动重试', {
            error: err instanceof Error ? err.message : String(err),
        });
    }
};

// Backs up if migrations are pending, applies schema + migrations, records the
// schema fingerprint, then starts the rolling backups.
export const initializeDatabase = async () => {
    try {
        const db = getConnection();
        const fingerprint = computeSchemaFingerprint();
        // 全程同步:返回之前迁移一定跑完(不少调用方不 await,依赖这一点)。
        backupBeforeMigration(db, fingerprint);
        db.exec(INIT_SCHEMA_SQL);
        log.info('Database schema applied');
        runMigrations(db);
        encryptLegacyCredentials();
        writeStoredFingerprint(db, fingerprint);
        startDatabaseBackups();
    } catch (err) {
        // 整个 Error 交给 logger,控制台连栈一起打出来:迁移失败时栈比 message 有用。
        log.error('Database initialization failed', err);
        throw err;
    }
};
