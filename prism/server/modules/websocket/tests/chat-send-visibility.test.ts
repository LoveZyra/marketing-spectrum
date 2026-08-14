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
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';

/**
 * `chat.send` 的归属校验。
 *
 * 这条守卫原先**漏掉了** —— `chat.abort`、`chat.subscribe`、
 * `chat.permission-response` 三处都过 `canViewerSeeSession`,唯独 `chat.send` 只查了
 * "会话存不存在"。而 send 恰恰是四条里影响最大的那条:
 *
 * 常驻 runtime 在 claude-sdk 里是**按 provider session id 建索引的,键里没有用户**,
 * `runtimeForSend` 每一轮都拿发送方的 `permissionMode` / `allowedTools` 覆盖 runtime
 * 上的,还会对活着的子进程调 `setPermissionMode`。所以少了这道门,任何已登录的
 * socket 只要拿得到一个会话 id,就能往别人的对话里写消息,并把自己的权限模式
 * (包括 `bypassPermissions`)按到别人的运行时上。
 *
 * 这里断言的是**副作用**而不是返回值:关键不在于回了什么错,而在于
 * **provider 运行时根本没有被拉起来**。只断言错误码的话,一个"先 spawn 再报错"
 * 的实现照样能过。
 */

type SentFrame = Record<string, unknown>;

type FakeSocket = {
  readyState: number;
  sent: SentFrame[];
  send(payload: string): void;
  on(event: string, handler: (raw: unknown) => unknown): void;
  emit(event: string, raw: unknown): Promise<void>;
};

function createFakeSocket(): FakeSocket {
  const handlers = new Map<string, (raw: unknown) => unknown>();
  return {
    readyState: 1, // WS_OPEN_STATE
    sent: [],
    send(payload: string) {
      this.sent.push(JSON.parse(payload) as SentFrame);
    },
    on(event: string, handler: (raw: unknown) => unknown) {
      handlers.set(event, handler);
    },
    async emit(event: string, raw: unknown) {
      const handler = handlers.get(event);
      if (handler) await handler(raw);
    },
  };
}

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousRootUsers = process.env.PRISM_ROOT_USERS;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'chat-send-visibility-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  process.env.PRISM_ROOT_USERS = 'boss';
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    if (previousRootUsers === undefined) delete process.env.PRISM_ROOT_USERS;
    else process.env.PRISM_ROOT_USERS = previousRootUsers;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** 把一个 socket 接上 chat 协议,并记录 provider 运行时被拉起了几次。 */
function connect(user: { id: number; username: string } | null) {
  const spawned: Array<{ command: string; sessionId: unknown }> = [];
  const ws = createFakeSocket();

  handleChatConnection(
    ws as never,
    { user: user ? { id: user.id, username: user.username } : undefined } as never,
    {
      spawnFns: {
        claude: async (command: string, options: Record<string, unknown>) => {
          spawned.push({ command, sessionId: options.sessionId });
        },
      },
      abortFns: { claude: () => true },
      getToolApprovalSessionId: () => null,
      resolveToolApproval: () => {},
      getPendingApprovalsForSession: () => [],
    } as never,
  );

  return { ws, spawned };
}

const send = (ws: FakeSocket, payload: Record<string, unknown>) =>
  ws.emit('message', JSON.stringify(payload));

const protocolErrors = (ws: FakeSocket) =>
  ws.sent.filter((frame) => frame.kind === 'protocol_error');

/**
 * run registry 是模块级单例,而每条用例都用同一个会话 id。这没问题:
 * `handleChatSend` 的 `finally` 里调 `completeRunIfCurrent`,而 `startRun` 只在
 * 上一个 run 还是 `running` 时才拒绝 —— 已完成的 run 不挡路。
 */
describe('chat.send 的归属校验', () => {
  test('别人的私有会话:运行时不能被拉起', async () => {
    await withIsolatedDatabase(async () => {
      const alice = { id: Number(userDb.createUser('alice', 'hash').id), username: 'alice' };
      const bob = { id: Number(userDb.createUser('bob', 'hash').id), username: 'bob' };
      projectsDb.createProjectPath('/workspace/alice', null, alice.id);
      sessionsDb.createAppSession('s-alice', 'claude', '/workspace/alice', alice.id);

      const { ws, spawned } = connect(bob);
      await send(ws, { type: 'chat.send', sessionId: 's-alice', content: 'hi' });

      assert.deepEqual(spawned, [], 'bob 不该能把 alice 的运行时拉起来');

      const errors = protocolErrors(ws);
      assert.equal(errors.length, 1);
      // 对外与"这个 id 不存在"同形 —— 不能变成一个"会话是否存在"的探针。
      assert.equal(errors[0].code, 'SESSION_NOT_FOUND');
    });
  });

  test('自己的会话:照常拉起', async () => {
    await withIsolatedDatabase(async () => {
      const alice = { id: Number(userDb.createUser('alice', 'hash').id), username: 'alice' };
      projectsDb.createProjectPath('/workspace/alice', null, alice.id);
      sessionsDb.createAppSession('s-alice', 'claude', '/workspace/alice', alice.id);

      const { ws, spawned } = connect(alice);
      await send(ws, { type: 'chat.send', sessionId: 's-alice', content: 'hi' });

      assert.equal(spawned.length, 1);
      assert.deepEqual(protocolErrors(ws), []);
    });
  });

  test('root 仍然能发进任何人的会话', async () => {
    await withIsolatedDatabase(async () => {
      const alice = { id: Number(userDb.createUser('alice', 'hash').id), username: 'alice' };
      const boss = { id: Number(userDb.createUser('boss', 'hash').id), username: 'boss' };
      projectsDb.createProjectPath('/workspace/alice', null, alice.id);
      sessionsDb.createAppSession('s-alice', 'claude', '/workspace/alice', alice.id);

      const { ws, spawned } = connect(boss);
      await send(ws, { type: 'chat.send', sessionId: 's-alice', content: 'hi' });

      assert.equal(spawned.length, 1, 'PRISM_ROOT_USERS 里的账号不该被这道门挡住');
    });
  });

  /**
   * `owner_user_id = NULL` 表示公开,是有意的设计(见 project-owner-backfill)。
   * 这道门守的是归属,不是"禁止协作" —— 公开项目仍然人人可发。钉住这一条,
   * 免得以后有人把守卫收紧成"只有 owner 能发"而悄悄改掉公开项目的语义。
   */
  test('公开项目(owner 为 NULL)对所有人仍然可发', async () => {
    await withIsolatedDatabase(async () => {
      const bob = { id: Number(userDb.createUser('bob', 'hash').id), username: 'bob' };
      projectsDb.createProjectPath('/workspace/shared', null, null);
      sessionsDb.createAppSession('s-shared', 'claude', '/workspace/shared', null);

      const { ws, spawned } = connect(bob);
      await send(ws, { type: 'chat.send', sessionId: 's-shared', content: 'hi' });

      assert.equal(spawned.length, 1);
    });
  });
});
