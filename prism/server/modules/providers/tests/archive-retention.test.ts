import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, test } from 'vitest';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  findExpiredArchivedSessions,
  getArchiveRetentionDays,
  sweepExpiredArchives,
} from '@/modules/providers/index.js';

/**
 * F8:归档保留期清扫。
 *
 * 归档是软删除:行还在,随时能恢复。代价是**它永远不会自己消失** —— 一年下来
 * 回收站里几千条,而没有任何人会去手动清。
 *
 * 但永久删除不可逆,所以默认必须是**关**的:不能因为升级了一版就悄悄开始删
 * 用户的东西。第一条钉的就是这个。
 */
const previousDatabasePath = process.env.DATABASE_PATH;
const previousRetention = process.env.PRISM_ARCHIVE_RETENTION_DAYS;
let tempDir: string | null = null;

afterEach(async () => {
  closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  if (previousRetention === undefined) delete process.env.PRISM_ARCHIVE_RETENTION_DAYS;
  else process.env.PRISM_ARCHIVE_RETENTION_DAYS = previousRetention;
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

async function freshDb(): Promise<void> {
  tempDir = await mkdtemp(path.join(tmpdir(), 'archive-retention-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');
  await initializeDatabase();
}

const daysAgo = (days: number): string => {
  const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return date.toISOString().replace('T', ' ').slice(0, 19);
};

function seedArchived(sessionId: string, updatedDaysAgo: number): void {
  sessionsDb.createSession(sessionId, 'claude', '/w', sessionId);
  sessionsDb.updateSessionIsArchived(sessionId, true);
  // updated_at 由调用方随后改成过去的时间 —— 清扫按**更新时间**算,不是创建时间:
  // 一段两年前开始、上周还在聊的会话不该因为"创建得早"被清掉。
  void updatedDaysAgo;
}

describe('归档保留期', () => {
  test('默认关闭 —— 没配就一条都不清', async () => {
    delete process.env.PRISM_ARCHIVE_RETENTION_DAYS;
    await freshDb();
    assert.equal(getArchiveRetentionDays(), 0);
    assert.deepEqual(findExpiredArchivedSessions(getArchiveRetentionDays()), []);

    process.env.PRISM_ARCHIVE_RETENTION_DAYS = '0';
    assert.equal(getArchiveRetentionDays(), 0, '显式 0 也是关');
  });

  test('非法值当作关,不是当作 1 天', async () => {
    await freshDb();
    for (const value of ['abc', '-5', '']) {
      process.env.PRISM_ARCHIVE_RETENTION_DAYS = value;
      assert.equal(getArchiveRetentionDays(), 0, `"${value}" 应该被当成关闭`);
    }
  });

  test('只清超期的,按更新时间算', async () => {
    process.env.PRISM_ARCHIVE_RETENTION_DAYS = '30';
    await freshDb();

    const { getConnection } = await import('@/modules/database/index.js');
    seedArchived('s-old', 90);
    seedArchived('s-fresh', 3);
    seedArchived('s-active', 0);
    // 活跃(未归档)那条不该被碰
    sessionsDb.createSession('s-live', 'claude', '/w', 's-live');

    const db = getConnection();
    db.prepare('UPDATE sessions SET updated_at = ? WHERE session_id = ?').run(daysAgo(90), 's-old');
    db.prepare('UPDATE sessions SET updated_at = ? WHERE session_id = ?').run(daysAgo(3), 's-fresh');

    assert.deepEqual(findExpiredArchivedSessions(30), ['s-old']);

    const deleted: string[] = [];
    const removed = await sweepExpiredArchives({
      deleteSession: async (sessionId) => { deleted.push(sessionId); sessionsDb.deleteSessionById(sessionId); },
    });
    assert.equal(removed, 1);
    assert.deepEqual(deleted, ['s-old']);
    assert.ok(sessionsDb.getSessionById('s-fresh'), '未超期的归档必须留着');
    assert.ok(sessionsDb.getSessionById('s-live'), '活跃会话一概不碰');
  });

  test('关闭时 sweep 直接返回 0,连查询都不发', async () => {
    delete process.env.PRISM_ARCHIVE_RETENTION_DAYS;
    await freshDb();
    seedArchived('s-old', 900);

    let called = 0;
    const removed = await sweepExpiredArchives({ deleteSession: async () => { called += 1; } });
    assert.equal(removed, 0);
    assert.equal(called, 0);
  });
});
