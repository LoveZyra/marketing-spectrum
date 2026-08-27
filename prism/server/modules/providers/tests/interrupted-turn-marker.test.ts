import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, test } from 'vitest';

import { closeConnection, initializeDatabase, sessionMessagesDb, sessionsDb } from '@/modules/database/index.js';
import {
  INTERRUPTED_TURN_NOTICE,
  findInterruptedSessions,
  markInterruptedTurnsOnStartup,
} from '@/modules/providers/index.js';

/**
 * F14:进程重启后给「回合跑到一半被打断」的会话补一条标记。
 *
 * 中断在库里的样子是:显示日志的**最后一条是用户消息**,后面什么都没有。正常
 * 结束的回合最后一定是助手的文本或工具结果。之前这种会话打开后是静默的 ——
 * 用户看到自己那句话孤零零挂着,不知道发生过什么,也不知道该重发。
 *
 * 判定安全的前提是"启动那一刻没有任何回合在跑",所以这件事只能在启动时做;
 * 这里钉的是判据本身与幂等性。
 */
const previousDatabasePath = process.env.DATABASE_PATH;
let tempDir: string | null = null;

afterEach(async () => {
  closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

async function freshDb(): Promise<void> {
  tempDir = await mkdtemp(path.join(tmpdir(), 'interrupted-turn-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');
  await initializeDatabase();
}

const userMessage = (sessionId: string, id: string, content: string) =>
  sessionMessagesDb.append(sessionId, {
    id, sessionId, timestamp: new Date().toISOString(),
    provider: 'claude', kind: 'text', role: 'user', content,
  } as Parameters<typeof sessionMessagesDb.append>[1]);

const assistantMessage = (sessionId: string, id: string, content: string) =>
  sessionMessagesDb.append(sessionId, {
    id, sessionId, timestamp: new Date().toISOString(),
    provider: 'claude', kind: 'text', role: 'assistant', content,
  } as Parameters<typeof sessionMessagesDb.append>[1]);

describe('被打断的回合标记', () => {
  test('只认"最后一条是用户消息"的会话', async () => {
    await freshDb();
    sessionsDb.createAppSession('s-done', 'claude', '/w', 1);
    sessionsDb.createAppSession('s-cut', 'claude', '/w', 1);
    sessionsDb.createAppSession('s-empty', 'claude', '/w', 1);

    userMessage('s-done', 'd1', '问题');
    assistantMessage('s-done', 'd2', '回答');
    userMessage('s-cut', 'c1', '问题');
    // s-empty 一条日志都没有 —— 从没跑过,不算被打断

    assert.deepEqual(findInterruptedSessions(), ['s-cut']);
  });

  test('补完之后最后一条不再是用户消息,所以第二次启动不重复补(幂等)', async () => {
    await freshDb();
    sessionsDb.createAppSession('s-cut', 'claude', '/w', 1);
    userMessage('s-cut', 'c1', '问题');

    assert.equal(markInterruptedTurnsOnStartup(), 1);
    assert.deepEqual(findInterruptedSessions(), [], '补完就不该再被判为被打断');
    assert.equal(markInterruptedTurnsOnStartup(), 0, '第二次启动不重复补');

    const messages = sessionMessagesDb.listForSession('s-cut');
    assert.equal(messages.length, 2);
    assert.equal(messages[1].kind, 'error');
    assert.equal(messages[1].content, INTERRUPTED_TURN_NOTICE);
  });

  test('用户消息之后再来一条助手消息(补标记之前就恢复了)不受影响', async () => {
    await freshDb();
    sessionsDb.createAppSession('s-ok', 'claude', '/w', 1);
    userMessage('s-ok', 'u1', '第一问');
    assistantMessage('s-ok', 'a1', '第一答');
    userMessage('s-ok', 'u2', '第二问');
    assistantMessage('s-ok', 'a2', '第二答');

    assert.equal(markInterruptedTurnsOnStartup(), 0);
    assert.equal(sessionMessagesDb.listForSession('s-ok').length, 4, '不该往正常会话里塞东西');
  });

  test('多条会话各自判定,互不影响', async () => {
    await freshDb();
    for (const id of ['a', 'b', 'c']) sessionsDb.createAppSession(`s-${id}`, 'claude', '/w', 1);
    userMessage('s-a', 'a1', 'x');
    userMessage('s-b', 'b1', 'x');
    assistantMessage('s-b', 'b2', 'y');
    userMessage('s-c', 'c1', 'x');

    assert.equal(markInterruptedTurnsOnStartup(), 2);
    assert.equal(sessionMessagesDb.listForSession('s-b').length, 2, 'b 正常结束,不该被补');
  });
});
