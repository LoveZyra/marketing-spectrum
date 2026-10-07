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
 * 归档保留期清扫。
 *
 * 归档是软删除:行还在,随时能恢复,但也永远不会自己消失 —— 一年下来能攒几千条,
 * 没有人会去手动清。
 *
 * 清扫会把到期的归档永久删除(先进最近删除,保留期过后彻底清掉),所以默认必须是
 * 关的,由运维显式打开。第一条钉的就是这个。
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
  // 归档时间与最后活动时间由调用方随后改成过去 —— 清扫按两者中较晚的那个算,不看创建时间:
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

  test('只清超期的:按归档时间与最后活动时间中较晚的那个算', async () => {
    process.env.PRISM_ARCHIVE_RETENTION_DAYS = '30';
    await freshDb();

    const { getConnection } = await import('@/modules/database/index.js');
    seedArchived('s-old', 90);
    seedArchived('s-fresh', 3);
    seedArchived('s-active', 0);
    // 刚归档的旧会话:最后活动在 90 天前,但归档才刚发生
    seedArchived('s-just-archived', 90);
    // 活跃(未归档)那条不该被碰
    sessionsDb.createSession('s-live', 'claude', '/w', 's-live');

    const db = getConnection();
    const backdate = db.prepare('UPDATE sessions SET updated_at = ?, archived_at = ? WHERE session_id = ?');
    backdate.run(daysAgo(90), daysAgo(90), 's-old');
    backdate.run(daysAgo(3), daysAgo(3), 's-fresh');
    db.prepare('UPDATE sessions SET updated_at = ? WHERE session_id = ?').run(daysAgo(90), 's-just-archived');

    assert.deepEqual(findExpiredArchivedSessions(30), ['s-old']);

    const deleted: string[] = [];
    const removed = await sweepExpiredArchives({
      deleteSession: async (sessionId) => { deleted.push(sessionId); sessionsDb.deleteSessionById(sessionId); },
    });
    assert.equal(removed, 1);
    assert.deepEqual(deleted, ['s-old']);
    assert.ok(sessionsDb.getSessionById('s-fresh'), '未超期的归档必须留着');
    assert.ok(sessionsDb.getSessionById('s-just-archived'), '刚归档的旧会话至少留满保留期');
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

/**
 * 保留期清扫必须够得到最旧的那些。
 *
 * 归档列表按 `updated_at DESC` 排序(最新在前),超期的恰恰排在最后。若取一页回来再按 cutoff
 * 过滤,归档数超过一页(SWEEP_BATCH = 200)且最新一页都在保留期内时一条都删不到,日志里也没有
 * 任何提示(`removed > 0` 才打日志)。这里造 250 条新数据占满第一页,钉住这个分支。
 */
describe('保留期清扫的取数方向', () => {
  test('归档超过一页时,仍然挑得出最旧的那些超期会话', async () => {
    process.env.PRISM_ARCHIVE_RETENTION_DAYS = '30';
    await freshDb();
    const { getConnection } = await import('@/modules/database/index.js');
    const db = getConnection();

    // 250 条"新"的(1 天前)—— 它们会占满按 DESC 排序的第一页
    for (let index = 0; index < 250; index += 1) {
      seedArchived(`fresh-${index}`, 1);
      db.prepare('UPDATE sessions SET updated_at = ?, archived_at = ? WHERE session_id = ?').run(daysAgo(1), daysAgo(1), `fresh-${index}`);
    }
    // 3 条"旧"的(90 天前)—— 排在整张表最后
    for (let index = 0; index < 3; index += 1) {
      seedArchived(`stale-${index}`, 90);
      db.prepare('UPDATE sessions SET updated_at = ?, archived_at = ? WHERE session_id = ?').run(daysAgo(90), daysAgo(90), `stale-${index}`);
    }

    const expired = findExpiredArchivedSessions(30);
    for (let index = 0; index < 3; index += 1) {
      assert.ok(expired.includes(`stale-${index}`), `最旧的 stale-${index} 必须被挑出来`);
    }
    assert.ok(!expired.some((id) => id.startsWith('fresh-')), '保留期内的不该被挑出来');
  });
});
