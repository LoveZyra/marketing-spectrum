import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, test } from 'vitest';

import { closeConnection, initializeDatabase, sessionMessagesDb } from '@/modules/database/index.js';
import {
  claimForShell,
  currentHolder,
  releaseShellClaim,
  resetConversationOwnership,
} from '@/modules/websocket/services/conversation-ownership.service.js';

afterEach(() => resetConversationOwnership());

/**
 * 整个文件都跑在一份临时库上。
 *
 * `releaseShellClaim` 现在会顺手清掉这段对话的显示日志 —— 也就是说这个模块
 * **会碰数据库**。不先把 `DATABASE_PATH` 指到临时目录,连接层会回落到
 * 安装目录里的 `server/database/auth.db`,测试就开始往真库里写了。
 */
let previousDatabasePath: string | undefined;
let tempDirectory: string;

beforeAll(async () => {
  previousDatabasePath = process.env.DATABASE_PATH;
  tempDirectory = await mkdtemp(path.join(tmpdir(), 'ownership-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
});

afterAll(async () => {
  closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  await rm(tempDirectory, { recursive: true, force: true });
});

describe('对话所有权(chat / 终端互斥)', () => {
  test('默认没有登记 —— chat 可用,不需要先"认领"', () => {
    // 常见路径(只用 chat)必须零登记:否则一旦漏了释放,chat 会被自己锁死。
    assert.equal(currentHolder('s1'), null);
  });

  test('终端接管后登记持有者,带上是谁 —— chat 那边要能说清楚"被谁占着"', () => {
    claimForShell('s1', { userId: 7, username: 'bob' });

    const holder = currentHolder('s1');
    assert.equal(holder?.panel, 'shell');
    assert.equal(holder?.username, 'bob');
    assert.equal(holder?.userId, 7);
    assert.ok(holder?.since);
  });

  test('只影响被接管的那个会话', () => {
    claimForShell('s1', { userId: 7, username: 'bob' });
    assert.equal(currentHolder('s2'), null);
  });

  test('释放之后 chat 立刻可用', () => {
    claimForShell('s1', { userId: 7, username: 'bob' });
    releaseShellClaim('s1');
    assert.equal(currentHolder('s1'), null);
  });

  test('释放一个没登记的会话不报错 —— PTY 退出路径不该因为这个抛异常', () => {
    assert.doesNotThrow(() => releaseShellClaim('never-claimed'));
  });

  test('重复接管按最后一次算,不会留下两个持有者', () => {
    claimForShell('s1', { userId: 7, username: 'bob' });
    claimForShell('s1', { userId: 8, username: 'carol' });
    assert.equal(currentHolder('s1')?.username, 'carol');

    releaseShellClaim('s1');
    assert.equal(currentHolder('s1'), null);
  });

  test('没有用户信息时也能登记 —— 平台模式下拿不到用户名,不能因此拒绝接管', () => {
    claimForShell('s1', {});
    const holder = currentHolder('s1');
    assert.equal(holder?.panel, 'shell');
    assert.equal(holder?.username, null);
  });
});

test('终端释放时把显示日志一并丢掉 —— 缺了中间一截的日志比没有更糟', () => {
  sessionMessagesDb.append('s-shell', {
    id: 'm1', sessionId: 's-shell', kind: 'text', role: 'assistant',
    content: '终端接管之前说的', timestamp: '2026-08-20T10:00:00.000Z', provider: 'claude',
  } as never);
  assert.equal(sessionMessagesDb.countForSession('s-shell'), 1);

  claimForShell('s-shell', { userId: 1, username: 'demo' });
  releaseShellClaim('s-shell');

  assert.equal(sessionMessagesDb.countForSession('s-shell'), 0);
});
