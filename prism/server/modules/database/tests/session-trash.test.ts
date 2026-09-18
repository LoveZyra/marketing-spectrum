import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * gk:最近删除(会话回收站)的仓库层。
 *
 * 钉三件事:搬进去之后活表里**一行都不剩**、回收站里**一行不少**;搬回来之后
 * 显示日志的 id 与顺序**逐字相同**;可见范围与活表同一条规则(项目 owner 看得见、
 * 陌生人看不见、删的人自己看得见)。改回原来的 DELETE 路径,第一条就红。
 */
let tempDir: string;
let db: typeof import('@/modules/database/index.js');

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-trash-db-'));
  process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');
  db = await import('@/modules/database/index.js');
  db.initializeDatabase();
});

afterAll(() => {
  try { db?.closeConnection?.(); } catch { /* ignore */ }
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  const conn = db.getConnection();
  for (const table of ['session_trash_messages', 'session_trash', 'session_display_messages', 'session_display_log_state', 'sessions', 'project_shares', 'projects']) {
    conn.prepare(`DELETE FROM ${table}`).run();
  }
});

const ensureProject = (projectPath: string, ownerUserId: number | null, visibility: string | null = null) => {
  db.getConnection()
    .prepare('INSERT OR IGNORE INTO projects (project_id, project_path, owner_user_id, visibility) VALUES (?, ?, ?, ?)')
    .run(`pid:${projectPath}`, projectPath, ownerUserId, visibility);
};

const insertSession = (sessionId: string, projectPath: string, providerId: string | null, name: string | null) => {
  db.getConnection()
    .prepare('INSERT INTO sessions (session_id, provider, provider_session_id, project_path, jsonl_path, custom_name) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sessionId, 'claude', providerId, projectPath, providerId ? `/t/${providerId}.jsonl` : null, name);
};

const insertMessages = (sessionId: string, count: number) => {
  const stmt = db.getConnection().prepare(
    'INSERT INTO session_display_messages (session_id, message_id, kind, timestamp, payload, provider_assistant_uuid) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (let index = 0; index < count; index += 1) {
    stmt.run(sessionId, `m${index}`, index % 2 === 0 ? 'text' : 'tool_use', `2026-09-14T10:00:0${index}Z`, JSON.stringify({ n: index }), index === 1 ? 'uuid-1' : null);
  }
};

const liveMessages = (sessionId: string) => db.getConnection()
  .prepare('SELECT id, message_id, kind, provider_assistant_uuid FROM session_display_messages WHERE session_id = ? ORDER BY id')
  .all(sessionId) as Array<{ id: number; message_id: string; kind: string; provider_assistant_uuid: string | null }>;

const move = (sessionId: string, by: { id: number | null; name: string | null } = { id: 7, name: 'wjx' }) =>
  db.sessionTrashDb.moveToTrash({
    sessionId,
    deletedByUserId: by.id,
    deletedByUsername: by.name,
    deletedVia: 'session',
    project: { projectId: 'pid:/p/a', displayName: 'A', ownerUserId: 14, visibility: null },
  });

describe('session_trash:搬进 / 搬回', () => {
  it('搬进去之后活表一行不剩、回收站里行 + 显示日志 + 裁剪标记全在', () => {
    ensureProject('/p/a', 14);
    insertSession('s1', '/p/a', 'p1', '胡萍');
    insertMessages('s1', 4);
    db.getConnection().prepare('INSERT INTO session_display_log_state (session_id, trimmed) VALUES (?, 1)').run('s1');

    const result = move('s1');
    expect(result.moved).toBe(true);
    expect(result.row?.message_count).toBe(4);
    expect(result.row?.display_log_trimmed).toBe(1);
    expect(result.row?.deleted_by_username).toBe('wjx');
    expect(result.row?.project_owner_user_id).toBe(14);

    expect(db.sessionsDb.getSessionById('s1')).toBeNull();
    expect(liveMessages('s1')).toEqual([]);
    expect(db.getConnection().prepare('SELECT COUNT(*) AS n FROM session_display_log_state WHERE session_id = ?').get('s1')).toEqual({ n: 0 });
    expect(db.getConnection().prepare('SELECT COUNT(*) AS n FROM session_trash_messages WHERE session_id = ?').get('s1')).toEqual({ n: 4 });
  });

  it('活表里没有这一行时什么都不动', () => {
    expect(move('ghost')).toEqual({ moved: false, row: null });
    expect(db.sessionTrashDb.count()).toBe(0);
  });

  it('搬回来之后显示日志的 id、顺序、分叉锚点与删除前逐字相同', () => {
    ensureProject('/p/a', 14);
    insertSession('s1', '/p/a', 'p1', '胡萍');
    insertMessages('s1', 3);
    // 中间再给别的会话写几行,确保 AUTOINCREMENT 往前走了
    insertSession('other', '/p/a', 'p9', null);
    const before = liveMessages('s1');
    move('s1');
    insertMessages('other', 5);

    const restored = db.sessionTrashDb.restore('s1');
    expect(restored.restored).toBe(true);
    expect(liveMessages('s1')).toEqual(before);
    expect(db.sessionsDb.getSessionById('s1')?.custom_name).toBe('胡萍');
    expect(db.sessionsDb.getSessionById('s1')?.provider_session_id).toBe('p1');
    expect(db.sessionTrashDb.get('s1')).toBeNull();
    expect(db.getConnection().prepare('SELECT COUNT(*) AS n FROM session_trash_messages WHERE session_id = ?').get('s1')).toEqual({ n: 0 });
  });

  it('活表里已有同 provider id 的行时拒绝恢复(不把两段对话缝在一起)', () => {
    ensureProject('/p/a', 14);
    insertSession('s1', '/p/a', 'p1', null);
    move('s1');
    insertSession('s2', '/p/a', 'p1', null);
    const result = db.sessionTrashDb.restore('s1');
    expect(result.restored).toBe(false);
    expect(result.reason).toBe('conflict');
    expect(db.sessionTrashDb.get('s1')).not.toBeNull();
  });

  it('hasProviderSessionId:按 provider id 或 app id 都能查到', () => {
    ensureProject('/p/a', 14);
    insertSession('s1', '/p/a', 'p1', null);
    move('s1');
    expect(db.sessionTrashDb.hasProviderSessionId('p1')).toBe(true);
    expect(db.sessionTrashDb.hasProviderSessionId('s1')).toBe(true);
    expect(db.sessionTrashDb.hasProviderSessionId('nope')).toBe(false);
  });

  it('listExpired 只给超过 cutoff 的;purge 之后行与日志都没了', () => {
    ensureProject('/p/a', 14);
    insertSession('old', '/p/a', 'p1', null);
    insertSession('fresh', '/p/a', 'p2', null);
    insertMessages('old', 2);
    move('old');
    move('fresh');
    db.getConnection().prepare("UPDATE session_trash SET deleted_at = '2026-01-01 00:00:00' WHERE session_id = 'old'").run();

    const expired = db.sessionTrashDb.listExpired(new Date(Date.now() - 24 * 3600 * 1000).toISOString(), 10);
    expect(expired.map((row) => row.session_id)).toEqual(['old']);

    const purged = db.sessionTrashDb.purge('old');
    expect(purged?.session_id).toBe('old');
    expect(db.sessionTrashDb.get('old')).toBeNull();
    expect(db.getConnection().prepare('SELECT COUNT(*) AS n FROM session_trash_messages WHERE session_id = ?').get('old')).toEqual({ n: 0 });
    expect(db.sessionTrashDb.get('fresh')).not.toBeNull();
  });
});

describe('session_trash:可见范围', () => {
  it('root 看全部;项目 owner 看得到;共享给的用户看得到;陌生人看不到;删的人自己看得到', () => {
    ensureProject('/p/a', 14);
    ensureProject('/p/b', 99);
    db.getConnection().prepare('INSERT INTO project_shares (project_id, user_id) VALUES (?, ?)').run('pid:/p/a', 21);
    insertSession('a1', '/p/a', 'p1', null);
    insertSession('b1', '/p/b', 'p2', null);
    move('a1', { id: 7, name: 'wjx' });
    db.sessionTrashDb.moveToTrash({
      sessionId: 'b1', deletedByUserId: 99, deletedByUsername: 'owner-b', deletedVia: 'session',
      project: { projectId: 'pid:/p/b', displayName: 'B', ownerUserId: 99, visibility: null },
    });

    const ids = (scope: Parameters<typeof db.sessionTrashDb.listPage>[0]) =>
      db.sessionTrashDb.listPage(scope, 50, 0).rows.map((row) => row.session_id).sort();

    expect(ids({ kind: 'all' })).toEqual(['a1', 'b1']);
    expect(ids({ kind: 'user', userId: 14 })).toEqual(['a1']);
    expect(ids({ kind: 'user', userId: 21 })).toEqual(['a1']);
    expect(ids({ kind: 'user', userId: 7 })).toEqual(['a1']);
    expect(ids({ kind: 'user', userId: 555 })).toEqual([]);
    expect(db.sessionTrashDb.isVisibleTo('b1', { kind: 'user', userId: 14 })).toBe(false);
    expect(db.sessionTrashDb.isVisibleTo('b1', { kind: 'user', userId: 99 })).toBe(true);
  });

  it('项目行已经没了(删项目)时按删除那一刻的 owner 快照判', () => {
    ensureProject('/p/gone', 14);
    insertSession('g1', '/p/gone', 'p1', null);
    db.sessionTrashDb.moveToTrash({
      sessionId: 'g1', deletedByUserId: 14, deletedByUsername: 'owner', deletedVia: 'project',
      project: { projectId: 'pid:/p/gone', displayName: 'Gone', ownerUserId: 14, visibility: null },
    });
    db.getConnection().prepare('DELETE FROM projects WHERE project_path = ?').run('/p/gone');

    expect(db.sessionTrashDb.listPage({ kind: 'user', userId: 14 }, 50, 0).rows.map((row) => row.session_id)).toEqual(['g1']);
    expect(db.sessionTrashDb.listPage({ kind: 'user', userId: 15 }, 50, 0).rows).toEqual([]);
  });
});
