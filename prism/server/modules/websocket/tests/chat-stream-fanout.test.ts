import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, test } from 'vitest';

import {
  closeConnection,
  initializeDatabase,
  projectsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

/**
 * 别人订阅一条正在跑的会话,不能把回答从提问者那里劫走。
 *
 * 用户报的现象:**root 打开了别人的会话,那个用户再提问时,回答出现在 root 的
 * 页面上,提问者自己的页面上什么都没有。**
 *
 * 链路是这样的(全部确认过,不是推测):
 *
 *  1. root 打开会话 X。
 *  2. 该用户往 X 发消息 → `startRun` 建的 writer 指向他自己的 socket。
 *  3. 运行时把内容写进 transcript 文件 → 服务端广播 `session_upserted`。
 *  4. root 的 `useProjectsState` 收到后调 `setSelectedProject`,而
 *     `upsertSessionIntoProject` 返回的是**新对象**;
 *     `useChatSessionState` 那个 effect 的依赖里有 `selectedProject`,
 *     于是**重新跑一遍,发出 `chat.subscribe`**。
 *  5. 服务端见 `isProcessing` 为真 → `attachConnection`。原来那是
 *     `run.writer.updateWebSocket(rootSocket)` —— **一次单持有者赋值**,
 *     流从此归 root。
 *
 * 所以它不是偶发,是**只要 root 开着那个会话就必然发生**,而且发生在回答中途。
 * 同一个人开两个标签页、公开项目里换成任意另一个用户,都是同一条链路。
 *
 * 现在 `attachConnection` 是加入集合而不是替换,这条用例钉的就是这一点。
 */

type SentFrame = Record<string, unknown>;

class FakeSocket {
  readyState = 1; // WS_OPEN_STATE
  sent: SentFrame[] = [];
  private handlers = new Map<string, (raw: unknown) => unknown>();

  send(payload: string): void {
    this.sent.push(JSON.parse(payload) as SentFrame);
  }

  on(event: string, handler: (raw: unknown) => unknown): void {
    this.handlers.set(event, handler);
  }

  async emit(event: string, raw: unknown): Promise<void> {
    const handler = this.handlers.get(event);
    if (handler) await handler(raw);
  }

  /** 只看内容帧,把 chat_subscribed 之类的网关事件滤掉。 */
  contents(): unknown[] {
    return this.sent.filter((frame) => frame.kind === 'stream_delta').map((frame) => frame.content);
  }
}

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousRootUsers = process.env.PRISM_ROOT_USERS;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'chat-fanout-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  process.env.PRISM_ROOT_USERS = 'boss';
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    if (previousRootUsers === undefined) delete process.env.PRISM_ROOT_USERS;
    else process.env.PRISM_ROOT_USERS = previousRootUsers;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

describe('运行中的会话被别人订阅', () => {
  test('root 中途订阅,回答仍然发给提问者(并且 root 也能看到)', async () => {
    await withIsolatedDatabase(async () => {
      const alice = { id: Number(userDb.createUser('alice', 'hash').id), username: 'alice' };
      userDb.createUser('boss', 'hash'); // PRISM_ROOT_USERS=boss
      projectsDb.createProjectPath('/workspace/alice', null, alice.id);
      sessionsDb.createAppSession('s-alice', 'claude', '/workspace/alice', alice.id);

      // 让 spawnFn 在两帧之间停住,好在"回答进行中"这个时刻插入 root 的订阅。
      let releaseMidRun: () => void = () => {};
      const midRun = new Promise<void>((resolve) => { releaseMidRun = resolve; });
      let runStarted: () => void = () => {};
      const started = new Promise<void>((resolve) => { runStarted = resolve; });

      const deps = {
        spawnFns: {
          claude: async (_command: string, _options: unknown, writer: {
            send: (message: Record<string, unknown>) => void;
          }) => {
            writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 's-alice', content: '第一段' });
            runStarted();
            await midRun;
            writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 's-alice', content: '第二段' });
          },
        },
        abortFns: { claude: () => true },
        getToolApprovalSessionId: () => null,
        resolveToolApproval: () => {},
        getPendingApprovalsForSession: () => [],
      };

      const connect = (user: { id: number; username: string }) => {
        const ws = new FakeSocket();
        handleChatConnection(
          ws as never,
          { user: { id: user.id, username: user.username } } as never,
          deps as never,
        );
        return ws;
      };

      const aliceSocket = connect(alice);
      const rootSocket = connect({ id: 2, username: 'boss' });

      // alice 提问(不 await —— spawnFn 会停在中间)
      const sending = aliceSocket.emit(
        'message',
        JSON.stringify({ type: 'chat.send', sessionId: 's-alice', content: '你好' }),
      );
      await started;

      // 回答进行到一半时,root 订阅同一条会话 —— 就是用户报的那个场景。
      await rootSocket.emit(
        'message',
        JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: 's-alice', lastSeq: 0 }] }),
      );

      releaseMidRun();
      await sending;

      // 回归本体:提问者必须两段都收到。修复前她只会收到「第一段」。
      assert.deepEqual(
        aliceSocket.contents(),
        ['第一段', '第二段'],
        'root 订阅之后,回答不能停止发给提问者',
      );

      // root 有权看这条会话,所以也收得到 —— 这是围观,不是劫走。
      //
      // 它连**加入之前**的那一段也拿到了:订阅带的 `lastSeq` 是 0,而这条 run
      // 还在跑,所以服务端在回执之后把缓冲区里的事件补了一遍(`replayEvents`)。
      // 这正是想要的 —— 中途打开一条正在跑的会话,应该看到完整的回答,而不是
      // 从你点开的那一秒开始的半截。
      assert.deepEqual(rootSocket.contents(), ['第一段', '第二段']);
      // 它确实拿到了订阅回执(证明订阅走通了,而不是被静默拒绝)。
      assert.ok(rootSocket.sent.some((frame) => frame.kind === 'chat_subscribed'));
    });
  });

  test('无权查看的用户订阅不上,自然也收不到流', async () => {
    await withIsolatedDatabase(async () => {
      const alice = { id: Number(userDb.createUser('alice', 'hash').id), username: 'alice' };
      const bob = { id: Number(userDb.createUser('bob', 'hash').id), username: 'bob' };
      projectsDb.createProjectPath('/workspace/alice', null, alice.id);
      sessionsDb.createAppSession('s-alice', 'claude', '/workspace/alice', alice.id);

      let releaseMidRun: () => void = () => {};
      const midRun = new Promise<void>((resolve) => { releaseMidRun = resolve; });
      let runStarted: () => void = () => {};
      const started = new Promise<void>((resolve) => { runStarted = resolve; });

      const deps = {
        spawnFns: {
          claude: async (_c: string, _o: unknown, writer: { send: (m: Record<string, unknown>) => void }) => {
            writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 's-alice', content: 'a' });
            runStarted();
            await midRun;
            writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 's-alice', content: 'b' });
          },
        },
        abortFns: { claude: () => true },
        getToolApprovalSessionId: () => null,
        resolveToolApproval: () => {},
        getPendingApprovalsForSession: () => [],
      };

      const connect = (user: { id: number; username: string }) => {
        const ws = new FakeSocket();
        handleChatConnection(ws as never, { user } as never, deps as never);
        return ws;
      };

      const aliceSocket = connect(alice);
      const bobSocket = connect(bob);

      const sending = aliceSocket.emit(
        'message',
        JSON.stringify({ type: 'chat.send', sessionId: 's-alice', content: '你好' }),
      );
      await started;

      await bobSocket.emit(
        'message',
        JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: 's-alice', lastSeq: 0 }] }),
      );

      releaseMidRun();
      await sending;

      assert.deepEqual(aliceSocket.contents(), ['a', 'b']);
      assert.deepEqual(bobSocket.contents(), [], 'bob 看不到这条会话,不该收到任何内容');
      // 不可见的订阅目标是静默跳过的(不回错误,免得变成"这个 id 存不存在"的探针)。
      assert.deepEqual(bobSocket.sent, []);
    });
  });
});
