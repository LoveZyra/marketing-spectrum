import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * fy(F14):**老库补列这条路要真的走一遍。**
 *
 * `INIT_SCHEMA_SQL` 里的 `CREATE TABLE IF NOT EXISTS` 对已有的库是空操作 ——
 * 新列只能靠迁移补。这里的做法是:先正常建库,再把新列 `DROP` 掉造出"老形状",
 * 灌两行历史,然后重跑一次初始化,验证:
 *
 * 1. 列补回来了;
 * 2. **既有的行一条不少、内容不动**(可空加列,不重建表 —— 所以不需要备份);
 * 3. 补完之后新写进去的 assistant 行能算出锚点,后面的用户消息就能分叉。
 */
let tempDir: string;
let db: typeof import('@/modules/database/index.js');

const UUID = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
const SESSION = 'S_migrate';

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-fork-migrate-'));
  process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');
  db = await import('@/modules/database/index.js');
  db.initializeDatabase();
});

afterAll(() => {
  try { db?.closeConnection?.(); } catch { /* ignore */ }
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('provider_assistant_uuid 迁移', () => {
  it('老库补列,历史行原样保留,新行能算出锚点', () => {
    const connection = db.getConnection();

    // 会话行必须在 —— 否则启动时的孤儿清扫会把显示日志一起收走(既有行为)。
    connection.prepare('INSERT OR IGNORE INTO sessions (session_id, provider) VALUES (?, ?)').run(SESSION, 'claude');

    // 造"老形状":把新列 DROP 掉,再按老 schema 灌两行历史。
    connection.exec('ALTER TABLE session_display_messages DROP COLUMN provider_assistant_uuid');
    const legacyInsert = connection.prepare(`
      INSERT INTO session_display_messages (session_id, message_id, kind, timestamp, payload)
      VALUES (?, ?, ?, ?, ?)
    `);
    legacyInsert.run(SESSION, 'user_old', 'text', '2026-01-01T00:00:00.000Z',
      JSON.stringify({ id: 'user_old', kind: 'text', role: 'user' }));
    legacyInsert.run(SESSION, `${UUID}_text`, 'text', '2026-01-01T00:00:01.000Z',
      JSON.stringify({ id: `${UUID}_text`, kind: 'text', role: 'assistant' }));

    expect(
      (connection.prepare('PRAGMA table_info(session_display_messages)').all() as Array<{ name: string }>)
        .map((column) => column.name),
    ).not.toContain('provider_assistant_uuid');

    // 再启动一次 —— 迁移应当把列补回来。
    db.initializeDatabase();
    const migrated = db.getConnection();

    expect(
      (migrated.prepare('PRAGMA table_info(session_display_messages)').all() as Array<{ name: string }>)
        .map((column) => column.name),
    ).toContain('provider_assistant_uuid');

    // 历史行一条不少,新列是 NULL(端点对它们退回扫 jsonl 的老路)
    const rows = migrated
      .prepare('SELECT message_id, payload, provider_assistant_uuid FROM session_display_messages WHERE session_id = ? ORDER BY id')
      .all(SESSION) as Array<{ message_id: string; payload: string; provider_assistant_uuid: string | null }>;
    expect(rows.map((r) => r.message_id)).toEqual(['user_old', `${UUID}_text`]);
    expect(rows.every((r) => r.provider_assistant_uuid === null)).toBe(true);
    expect(JSON.parse(rows[1].payload).role).toBe('assistant');

    // 老行没有锚点:`null` = 有这一行但它之前没有带锚点的回答
    expect(db.sessionMessagesDb.forkAnchorFor(SESSION, `${UUID}_text`)).toBeNull();

    // 补完之后新写的 assistant 行有锚点,后面的用户消息就能分叉了
    db.sessionMessagesDb.append(SESSION, {
      id: `${UUID}_new`, sessionId: SESSION, kind: 'text', role: 'assistant',
      content: '新回答', timestamp: '2026-01-01T00:00:02.000Z', provider: 'claude',
    } as never);
    db.sessionMessagesDb.append(SESSION, {
      id: 'user_new', sessionId: SESSION, kind: 'text', role: 'user',
      content: '新问题', timestamp: '2026-01-01T00:00:03.000Z', provider: 'claude',
    } as never);
    expect(db.sessionMessagesDb.forkAnchorFor(SESSION, 'user_new')).toBe(UUID);
  });
});
