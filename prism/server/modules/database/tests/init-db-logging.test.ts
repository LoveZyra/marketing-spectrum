import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, test, vi } from 'vitest';

import { closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';
import { SCHEMA_FINGERPRINT_KEY, detectPendingMigration } from '@/modules/database/init-db.js';
import { setLogLevel } from '@/shared/logger.js';

/**
 * 数据库初始化写给运维看的日志:失败要走 error 级并带栈(运维常把档位调到 warn / error 降噪),
 * 迁移前备份的原因串只用运维看得懂的中性说明。
 */

const previousDatabasePath = process.env.DATABASE_PATH;
let tempDir: string | null = null;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'init-db-logging-'));
  closeConnection();
});

afterEach(async () => {
  vi.restoreAllMocks();
  setLogLevel(null);
  closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe('初始化失败的日志', () => {
  test('走 error 级(档位调到 error 也看得到),带上栈,并把错误抛给上层', async () => {
    // 库路径指向一个目录:打开时 SQLITE_CANTOPEN,落在 initializeDatabase 的 try 里。
    process.env.DATABASE_PATH = tempDir!;
    setLogLevel('error');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await assert.rejects(() => initializeDatabase(), /unable to open database file/);

    const failureLines = errorSpy.mock.calls.filter((args) => args.some((arg) => String(arg).includes('Database initialization failed')));
    assert.equal(failureLines.length, 1, '失败要以 error 级输出一行');
    const [line] = failureLines;
    assert.match(String(line[0]), /ERROR/);
    const stackCarrier = line.find((arg) => arg instanceof Error) as Error | undefined;
    assert.ok(stackCarrier, '要把 Error 本身交给 logger,控制台才会连栈一起打出来');
    assert.match(String(stackCarrier!.stack), /\n\s+at /, '栈要在');
    assert.equal(
      logSpy.mock.calls.filter((args) => args.some((arg) => String(arg).includes('Database initialization failed'))).length,
      0,
      '不该再走 info 级',
    );
  });
});

describe('迁移前备份的原因串', () => {
  test('库里没有指纹记录:中性说明,不带内部代号', async () => {
    process.env.DATABASE_PATH = path.join(tempDir!, 'auth.db');
    await initializeDatabase();
    getConnection().prepare('DELETE FROM app_config WHERE key = ?').run(SCHEMA_FINGERPRINT_KEY);

    const check = detectPendingMigration(getConnection());
    assert.equal(check.pending, true);
    assert.deepEqual(check.reasons, ['库里没有 schema 指纹记录(首次升级到带指纹的版本,或从旧备份恢复)']);
    assert.ok(!/\bhl\b/.test(check.reasons.join(';')));
  });
});
