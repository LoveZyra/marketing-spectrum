import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { test } from 'vitest';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sessions-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('session archive queries hide archived rows from active project views', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('session-active', 'claude', '/workspace/demo-project', 'Active Session');
    sessionsDb.createSession('session-archived', 'claude', '/workspace/demo-project', 'Archived Session');
    sessionsDb.updateSessionIsArchived('session-archived', true);

    const activeSessions = sessionsDb.getAllSessions();
    const archivedSessions = sessionsDb.getArchivedSessions();
    const activeProjectSessions = sessionsDb.getSessionsByProjectPath('/workspace/demo-project');
    const allProjectSessions = sessionsDb.getSessionsByProjectPathIncludingArchived('/workspace/demo-project');

    assert.deepEqual(activeSessions.map((session) => session.session_id), ['session-active']);
    assert.deepEqual(archivedSessions.map((session) => session.session_id), ['session-archived']);
    assert.deepEqual(activeProjectSessions.map((session) => session.session_id), ['session-active']);
    assert.deepEqual(
      allProjectSessions.map((session) => session.session_id).sort(),
      ['session-active', 'session-archived'],
    );
    assert.equal(sessionsDb.countSessionsByProjectPath('/workspace/demo-project'), 1);
  });
});

/**
 * fj:磁盘同步**不再**把归档会话拉回活跃列表。
 *
 * 这条用例原来断言的是相反的行为(同步即解档)。那个行为看着合理,实际后果是
 * 归档形同虚设:
 *   1. 归档面板里的会话可以直接点开,而打开任意会话 400ms 后会 prewarm、
 *      prewarm 跑 `claude --resume` —— 它会碰一下 JSONL 的 mtime 却不追加消息
 *      → chokidar `change` → `createSession` → **会话自己跑回了活跃列表**;
 *   2. 归档一条正在流式输出的会话,transcript 持续追加,3 秒内必然被重新索引解档。
 * 用户反复归档也没用,而且回收站里会莫名少一条。
 *
 * 解档现在必须显式调 `updateSessionIsArchived(id, false)`。
 */
test('createSession 不解档 —— 归档是人的决定,不该被一次磁盘同步推翻', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('session-reused', 'claude', '/workspace/demo-project', 'First Name');
    sessionsDb.updateSessionIsArchived('session-reused', true);

    // 同步照旧更新其它字段(名字、路径、时间戳),但不碰归档位
    sessionsDb.createSession('session-reused', 'claude', '/workspace/demo-project', 'Updated Name');

    const stillArchived = sessionsDb.getSessionById('session-reused');
    assert.equal(stillArchived?.isArchived, 1, '一次磁盘同步不该把它拉回活跃列表');
    assert.equal(stillArchived?.custom_name, 'Updated Name', '其它字段照旧同步');
    assert.equal(sessionsDb.getAllSessions().length, 0);
    assert.equal(sessionsDb.getArchivedSessions().length, 1);

    // 显式复活仍然有效
    sessionsDb.updateSessionIsArchived('session-reused', false);
    assert.equal(sessionsDb.getAllSessions().length, 1);
  });
});

test('repository reads normalize SQLite UTC timestamps to ISO strings', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('session-timezone', 'claude', '/workspace/demo-project');

    const row = sessionsDb.getSessionById('session-timezone');
    assert.ok(row?.created_at.endsWith('Z'));
    assert.ok(row?.updated_at.endsWith('Z'));
    assert.match(row?.created_at ?? '', /^\d{4}-\d{2}-\d{2}T/);
    assert.match(row?.updated_at ?? '', /^\d{4}-\d{2}-\d{2}T/);
  });
});

test('setSessionCustomNameIfEmpty names unnamed sessions once and never overwrites', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('session-unnamed', 'claude', '/workspace/demo-project');
    sessionsDb.setSessionCustomNameIfEmpty('session-unnamed', 'echo-probe:你好');
    assert.equal(sessionsDb.getSessionById('session-unnamed')?.custom_name, 'echo-probe:你好');

    // 已有名字(哪怕就是它自己落的)不再覆盖 —— 用户改名永远优先。
    sessionsDb.setSessionCustomNameIfEmpty('session-unnamed', '别的名字');
    assert.equal(sessionsDb.getSessionById('session-unnamed')?.custom_name, 'echo-probe:你好');

    sessionsDb.createSession('session-named', 'claude', '/workspace/demo-project', '人工命名');
    sessionsDb.setSessionCustomNameIfEmpty('session-named', '不该生效');
    assert.equal(sessionsDb.getSessionById('session-named')?.custom_name, '人工命名');
  });
});
