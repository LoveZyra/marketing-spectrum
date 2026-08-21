import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, test } from 'vitest';

import {
  closeConnection,
  initializeDatabase,
  projectsDb,
  sessionMessagesDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';

/**
 * 一个**没有任何浏览器连着**就开跑的回合。
 *
 * 外部 API(`POST /api/agent` 的 async 模式)就是这个形状:先把会话 id 返回去,
 * 回合立刻在后台开跑,人还在拿着 id 拼链接 —— 这中间一个 socket 都没有。
 *
 * 原来 `ChatSessionWriter` 的构造函数无条件把 `options.connection` 塞进集合,
 * 传 null 进去等于给**每一条出站消息**埋一颗 `null.readyState` 的 TypeError。
 * 现在有值才加。
 *
 * 而"没人在看"绝不等于"这段可以丢":
 *  - 事件照样进补发缓冲,人点开链接后 `chat.subscribe` 能把前半段补回来;
 *  - 显示日志照样记(az 轮),所以刷新页面看到的是完整的一轮。
 */

type Frame = Record<string, unknown>;

class FakeSocket {
  readyState = 1;
  sent: Frame[] = [];
  send(payload: string): void { this.sent.push(JSON.parse(payload) as Frame); }
}

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'chat-headless-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const frame = (id: string, content: string) => ({
  id, kind: 'text', role: 'assistant', content,
  sessionId: 'PROVIDER-NATIVE', provider: 'claude',
  timestamp: '2026-08-20T11:00:00.000Z',
});

describe('无浏览器连接的回合(外部 API 触发)', () => {
  test('没人连着也能开跑、能写日志,人接上来之后补得回前半段', async () => {
    await withIsolatedDatabase(async () => {
      const owner = { id: Number(userDb.createUser('api-user', 'hash').id) };
      projectsDb.createProjectPath('/workspace/api', null, owner.id);
      sessionsDb.createAppSession('s-api', 'claude', '/workspace/api', owner.id);

      const run = chatRunRegistry.startRun({
        appSessionId: 's-api',
        provider: 'claude',
        providerSessionId: null,
        connection: null,
        userId: owner.id,
      });
      assert.ok(run, '没有连接也必须能开跑');

      // 一个订阅者都没有 —— 这两条只会进缓冲和日志,不该抛异常。
      run.writer.send(frame('m1', '第一句'));
      run.writer.send(frame('m2', '第二句'));

      assert.equal(sessionMessagesDb.countForSession('s-api'), 2, '没人看也要落显示日志');
      assert.equal(chatRunRegistry.replayEvents('s-api', 0).length, 2, '没人看也要进补发缓冲');

      // 人拿着链接点进来了。
      const socket = new FakeSocket();
      assert.equal(chatRunRegistry.attachConnection('s-api', socket as never), true);

      run.writer.send(frame('m3', '第三句'));
      assert.deepEqual(
        socket.sent.map((f) => f.content),
        ['第三句'],
        '接上之后的内容直接推给它',
      );

      // 前半段由补发游标补上,合起来是完整的一轮。
      assert.deepEqual(
        chatRunRegistry.replayEvents('s-api', 0).map((event) => event.content),
        ['第一句', '第二句', '第三句'],
      );
    });
  });

  test('会话 id 被换成应用侧 id —— provider 原生 id 不外泄', async () => {
    await withIsolatedDatabase(async () => {
      const owner = { id: Number(userDb.createUser('api-user2', 'hash').id) };
      projectsDb.createProjectPath('/workspace/api2', null, owner.id);
      sessionsDb.createAppSession('s-api2', 'claude', '/workspace/api2', owner.id);

      const run = chatRunRegistry.startRun({
        appSessionId: 's-api2', provider: 'claude', providerSessionId: null,
        connection: null, userId: owner.id,
      });
      assert.ok(run);
      run.writer.send(frame('m1', '你好'));

      const [logged] = sessionMessagesDb.listForSession('s-api2');
      assert.equal(logged.sessionId, 's-api2');
    });
  });
});
