import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, test } from 'vitest';

import { closeConnection, getConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';

/**
 * `sessions.archived_at` 与归档保留期的判据。
 *
 * 保留期从「归档时间」与「最后活动时间」中较晚的那个起算:刚归档的旧会话也至少留满保留期
 * (用户常常是先归档、留个后悔期),归档前还在聊的会话按最后活动算。只按最后活动算的话,
 * 把一批两个月没动过的会话归档,下一轮清扫(启动时或 6 小时内)就全进了「最近删除」。
 */

const previousDatabasePath = process.env.DATABASE_PATH;
let tempDir: string | null = null;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'session-archived-at-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');
  await initializeDatabase();
});

afterEach(async () => {
  closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

/** SQLite `CURRENT_TIMESTAMP` 同形的 N 天前。 */
const daysAgo = (days: number): string =>
  new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
const cutoffDaysAgo = (days: number): string => new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();

const archivedAt = (sessionId: string): string | null => (getConnection()
  .prepare('SELECT archived_at FROM sessions WHERE session_id = ?')
  .get(sessionId) as { archived_at: string | null }).archived_at;

const columnsOfSessions = (): string[] => (getConnection()
  .prepare('PRAGMA table_info(sessions)')
  .all() as Array<{ name: string }>).map((column) => column.name);

/** 归档一条会话,再把归档时间 / 最后活动时间改到指定的过去。 */
function seedArchived(sessionId: string, times: { archived: string | null; updated: string }): void {
  sessionsDb.createSession(sessionId, 'claude', '/workspace/demo', sessionId);
  sessionsDb.updateSessionIsArchived(sessionId, true);
  getConnection()
    .prepare('UPDATE sessions SET archived_at = ?, updated_at = ? WHERE session_id = ?')
    .run(times.archived, times.updated, sessionId);
}

describe('archived_at 列与迁移', () => {
  test('新库建表就带 archived_at', () => {
    assert.ok(columnsOfSessions().includes('archived_at'));
  });

  test('老库升级:补上列,已归档的老行回填为 updated_at,未归档的留 NULL', async () => {
    sessionsDb.createSession('old-archived', 'claude', '/workspace/demo', '归档了');
    sessionsDb.createSession('old-live', 'claude', '/workspace/demo', '还在用');
    // 造出升级前的样子:没有 archived_at 这一列,归档只记在 isArchived 上
    const db = getConnection();
    db.exec('ALTER TABLE sessions DROP COLUMN archived_at');
    db.prepare("UPDATE sessions SET isArchived = 1, updated_at = '2026-05-01 08:00:00' WHERE session_id = 'old-archived'").run();
    db.prepare("UPDATE sessions SET updated_at = '2026-05-02 08:00:00' WHERE session_id = 'old-live'").run();
    assert.ok(!columnsOfSessions().includes('archived_at'));

    closeConnection();
    await initializeDatabase();

    assert.ok(columnsOfSessions().includes('archived_at'));
    assert.equal(archivedAt('old-archived'), '2026-05-01 08:00:00');
    assert.equal(archivedAt('old-live'), null);

    // 再启动一次:幂等,不再回填、不报错
    getConnection().prepare("UPDATE sessions SET archived_at = '2026-06-01 00:00:00' WHERE session_id = 'old-archived'").run();
    closeConnection();
    await initializeDatabase();
    assert.equal(archivedAt('old-archived'), '2026-06-01 00:00:00');
  });
});

describe('归档 / 解档写 archived_at', () => {
  test('归档时写入当前时间;重复归档不刷新;解档置 NULL', () => {
    sessionsDb.createSession('s1', 'claude', '/workspace/demo', 's1');
    assert.equal(archivedAt('s1'), null);

    sessionsDb.updateSessionIsArchived('s1', true);
    const first = archivedAt('s1');
    assert.ok(first, '归档没写时间');
    assert.ok(Math.abs(Date.parse(`${first!.replace(' ', 'T')}Z`) - Date.now()) < 60_000, `归档时间不是现在:${first}`);

    getConnection().prepare("UPDATE sessions SET archived_at = '2026-01-01 00:00:00' WHERE session_id = 's1'").run();
    sessionsDb.updateSessionIsArchived('s1', true);
    assert.equal(archivedAt('s1'), '2026-01-01 00:00:00', '已归档的再归档一次,归档时间不该被刷新');

    sessionsDb.updateSessionIsArchived('s1', false);
    assert.equal(archivedAt('s1'), null);
    assert.equal(sessionsDb.getSessionById('s1')?.isArchived, 0);
  });
});

describe('过期判据:max(归档时间, 最后活动时间)', () => {
  test('刚归档的旧会话不过期;归档与最后活动都早于保留期才过期', () => {
    seedArchived('just-archived-old', { archived: daysAgo(0), updated: daysAgo(90) });
    seedArchived('archived-long-ago', { archived: daysAgo(40), updated: daysAgo(90) });
    seedArchived('active-after-archive', { archived: daysAgo(40), updated: daysAgo(5) });
    seedArchived('legacy-null', { archived: null, updated: daysAgo(90) });
    seedArchived('recent', { archived: daysAgo(2), updated: daysAgo(3) });
    sessionsDb.createSession('live-old', 'claude', '/workspace/demo', 'live-old');
    getConnection().prepare('UPDATE sessions SET updated_at = ? WHERE session_id = ?').run(daysAgo(200), 'live-old');

    const expired = sessionsDb.getExpiredArchivedSessions(cutoffDaysAgo(30), 50);
    assert.deepEqual([...expired].sort(), ['archived-long-ago', 'legacy-null']);
  });

  test('最旧的在前(按两者中较晚的那个排);limit 生效', () => {
    seedArchived('a', { archived: daysAgo(50), updated: daysAgo(100) });
    seedArchived('b', { archived: daysAgo(80), updated: daysAgo(60) });
    seedArchived('c', { archived: daysAgo(70), updated: daysAgo(90) });

    assert.deepEqual(sessionsDb.getExpiredArchivedSessions(cutoffDaysAgo(30), 50), ['c', 'b', 'a']);
    assert.deepEqual(sessionsDb.getExpiredArchivedSessions(cutoffDaysAgo(30), 2), ['c', 'b']);
  });

  test('ISO 格式的 updated_at 与 SQLite 格式的 archived_at 按时间比,不按字符串比', () => {
    // 同一天:按字符串比,'T' 比空格大,ISO 那个总会被当成较晚的
    const day = daysAgo(40).slice(0, 10);
    sessionsDb.createSession('mixed', 'claude', '/workspace/demo', 'mixed', `${day}T01:00:00.000Z`, `${day}T01:00:00.000Z`);
    sessionsDb.updateSessionIsArchived('mixed', true);
    getConnection().prepare('UPDATE sessions SET archived_at = ? WHERE session_id = ?').run(`${day} 23:00:00`, 'mixed');

    const cutoff = new Date(`${day}T12:00:00.000Z`).toISOString();
    assert.deepEqual(sessionsDb.getExpiredArchivedSessions(cutoff, 10), [], '23:00 归档的不该算在 12:00 之前');
  });
});
