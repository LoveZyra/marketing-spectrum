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

  /**
   * fl:语义从"按最后一次算"改成"**先到先得**"。
   *
   * 原来第二个人接管会盖掉第一个人的记录 —— 而两个 PTY 都还活着。
   * 后者先退出时把整把锁释放掉,前者仍连着,chat 于是判成"没人接管",
   * 开始与那个 PTY 双写同一份 transcript。fk 给释放加了令牌,只堵住了
   * "错误释放"那一半;这一半在接管这一侧。
   */
  test('fl:已被别人接管时不覆盖 —— 后来者拿不到令牌', () => {
    const first = claimForShell('s1', { userId: 7, username: 'bob' });
    assert.ok(first.token, '第一个接管的人应当拿到令牌');

    const second = claimForShell('s1', { userId: 8, username: 'carol' });
    assert.equal(second.token, undefined, '别人持有时不发令牌');
    assert.equal(second.username, 'bob', '报回来的是现有持有者');
    assert.equal(currentHolder('s1')?.username, 'bob', '持有者不变');

    // 拿不到令牌的那个人释放不掉别人的锁
    releaseShellClaim('s1', 'claim_bogus');
    assert.equal(currentHolder('s1')?.username, 'bob');

    releaseShellClaim('s1', first.token);
    assert.equal(currentHolder('s1'), null);
  });

  test('fl:同一个人重连沿用同一张令牌 —— 否则旧连接的退出会把新的释放掉', () => {
    const first = claimForShell('s2', { userId: 7, username: 'bob' });
    const again = claimForShell('s2', { userId: 7, username: 'bob' });
    assert.equal(again.token, first.token);
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
