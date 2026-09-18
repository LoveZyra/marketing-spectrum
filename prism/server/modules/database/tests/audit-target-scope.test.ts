import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, test } from 'vitest';

import { auditLogDb, closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';

/**
 * gk:审计日志的"对我做的"那一支 + 删除类事件不被常规裁剪冲掉。
 *
 * 2026-09-14 的事故里,被删的人在审计页什么都看不到 —— 非 root 只看"自己做的"。
 * 现在 `target_user_id = 我` 的行也在范围内,但那些行的 ip / user_agent 是别人的,列表里抹掉。
 * 第三条钉裁剪:5000 条 ws_ticket_issued 之后,上个月那条 session_deleted 还在。
 */

const previousDatabasePath = process.env.DATABASE_PATH;
let tempDir: string | null = null;

afterEach(async () => {
  closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  if (tempDir) { await rm(tempDir, { recursive: true, force: true }); tempDir = null; }
});

async function fresh(): Promise<void> {
  tempDir = await mkdtemp(path.join(tmpdir(), 'audit-target-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');
  await initializeDatabase();
}

describe('审计:对我做的', () => {
  test('非 root 能看到 target_user_id = 我 的行,且那些行的 ip / ua 被抹掉;自己做的行保留 ip', async () => {
    await fresh();
    auditLogDb.record({ userId: 7, username: 'wjx', event: 'session_deleted', ip: '10.0.0.7', userAgent: 'ua-7', detail: '{"sessionId":"s1"}', targetUserId: 14 });
    auditLogDb.record({ userId: 14, username: 'owner', event: 'login', ip: '10.0.0.14', userAgent: 'ua-14' });
    auditLogDb.record({ userId: 7, username: 'wjx', event: 'login', ip: '10.0.0.7' });

    const mine = auditLogDb.list(50, 0, 14);
    assert.deepEqual(mine.map((row) => row.event).sort(), ['login', 'session_deleted']);
    const deletion = mine.find((row) => row.event === 'session_deleted')!;
    assert.equal(deletion.username, 'wjx', '谁删的要看得到');
    assert.equal(deletion.ip, null, '别人的 ip 不给');
    assert.equal(deletion.user_agent, null);
    const ownLogin = mine.find((row) => row.event === 'login')!;
    assert.equal(ownLogin.ip, '10.0.0.14', '自己的行保留 ip');
    assert.equal(auditLogDb.count(14), 2);

    // 与我无关的人(wjx 自己的 login)不在我的范围里
    assert.equal(mine.some((row) => row.event === 'login' && row.username === 'wjx'), false);
    // root 全量、不脱敏
    const all = auditLogDb.list(50, 0, null);
    assert.equal(all.length, 3);
    assert.equal(all.find((row) => row.event === 'session_deleted')?.ip, '10.0.0.7');
  });

  test('删除类事件不参与常规裁剪:5000 条票据之后 session_deleted 还在', async () => {
    await fresh();
    const conn = getConnection();
    auditLogDb.record({ userId: 7, username: 'wjx', event: 'session_deleted', detail: '{"sessionId":"s1"}', targetUserId: 14 });
    const insert = conn.prepare("INSERT INTO audit_log (user_id, username, event, outcome) VALUES (7, 'wjx', 'ws_ticket_issued', 'success')");
    const many = conn.transaction((n: number) => { for (let i = 0; i < n; i += 1) insert.run(); });
    many(5200);

    auditLogDb.trim();

    const events = conn.prepare('SELECT event, COUNT(*) AS n FROM audit_log GROUP BY event').all() as Array<{ event: string; n: number }>;
    const byEvent = Object.fromEntries(events.map((row) => [row.event, row.n]));
    assert.equal(byEvent.session_deleted, 1, '删除记录被常规裁剪冲掉了');
    assert.equal(byEvent.ws_ticket_issued, 5000, '常规事件仍只留最新 5000');
  });

  /**
   * 第二档也要真的裁 —— 不然"删除类不参与常规裁剪"就等于"删除类无上限",
   * 一张永远长大的表。这里把上限压到 5 条来验证那一刀确实落下,并且**留下的是最新的**。
   */
  test('删除类事件自己有上限:超过 PRISM_AUDIT_LOG_MAX_DURABLE_ROWS 的最旧那些被裁掉', async () => {
    const previousMax = process.env.PRISM_AUDIT_LOG_MAX_DURABLE_ROWS;
    process.env.PRISM_AUDIT_LOG_MAX_DURABLE_ROWS = '5';
    try {
      await fresh();
      const conn = getConnection();
      const insert = conn.prepare("INSERT INTO audit_log (user_id, username, event, outcome, detail) VALUES (7, 'wjx', 'session_deleted', 'success', ?)");
      const many = conn.transaction((n: number) => { for (let i = 0; i < n; i += 1) insert.run(`{"i":${i}}`); });
      many(9);

      auditLogDb.trim();

      const rows = conn.prepare("SELECT detail FROM audit_log WHERE event = 'session_deleted' ORDER BY id").all() as Array<{ detail: string }>;
      assert.equal(rows.length, 5, '删除类事件没有上限,表会无限长');
      assert.deepEqual(rows.map((row) => JSON.parse(row.detail).i), [4, 5, 6, 7, 8], '留下的应该是最新的那几条');
    } finally {
      if (previousMax === undefined) delete process.env.PRISM_AUDIT_LOG_MAX_DURABLE_ROWS;
      else process.env.PRISM_AUDIT_LOG_MAX_DURABLE_ROWS = previousMax;
    }
  });
});
