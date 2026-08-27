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
 * F7:回合内排队。
 *
 * 之前 `chat.send` 撞上在跑的回合就直接 `RUN_IN_PROGRESS` 打回去,那条消息就没了。
 * 前端确实有自己的排队(存在浏览器 localStorage 里),但它盖不住两种情况:
 * 判定竞态(前端以为空闲、服务端还在跑)与关掉标签页。服务端收下一条,回合结束
 * 自动续发。
 *
 * 这里断言的是**副作用**:第二条消息最终有没有真的被送进运行时,以及它是
 * **在第一条结束之后**才进去的。只断言回了什么帧,一个"回帧但从不续发"的实现
 * 照样能过。
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
    readyState: 1,
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
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'chat-send-queue-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/**
 * 一个可以人为"卡住"的运行时:spawn 之后一直不返回,直到测试调用 release()。
 * 这样才能造出"上一轮还在跑"这个前提。
 */
function connect(user: { id: number; username: string }) {
  const spawned: string[] = [];
  let release: (() => void) | null = null;
  const ws = createFakeSocket();

  handleChatConnection(
    ws as never,
    { user: { id: user.id, username: user.username } } as never,
    {
      spawnFns: {
        claude: (command: string) => {
          spawned.push(command);
          return new Promise<void>((resolve) => { release = resolve; });
        },
      },
      abortFns: { claude: () => true },
      getToolApprovalSessionId: () => null,
      resolveToolApproval: () => {},
      getPendingApprovalsForSession: () => [],
    } as never,
  );

  return {
    ws,
    spawned,
    finishCurrentTurn: () => { release?.(); release = null; },
  };
}

const send = (ws: FakeSocket, payload: Record<string, unknown>) =>
  ws.emit('message', JSON.stringify(payload));

const framesOfKind = (ws: FakeSocket, kind: string) => ws.sent.filter((frame) => frame.kind === kind);

/** setImmediate + 已排队的 promise 都跑完。续发是异步接上的。 */
const settle = async () => {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

async function seedSession(sessionId: string) {
  const alice = { id: Number(userDb.createUser('alice', 'hash').id), username: 'alice' };
  projectsDb.createProjectPath('/workspace/alice', null, alice.id);
  sessionsDb.createAppSession(sessionId, 'claude', '/workspace/alice', alice.id);
  return alice;
}

describe('chat.send 回合内排队', () => {
  test('撞上在跑的回合 → 收下并回 chat_queued,回合结束后自动续发', async () => {
    await withIsolatedDatabase(async () => {
      const alice = await seedSession('s-queue-1');
      const { ws, spawned, finishCurrentTurn } = connect(alice);

      void send(ws, { type: 'chat.send', sessionId: 's-queue-1', content: '第一条' });
      await settle();
      assert.deepEqual(spawned, ['第一条'], '第一条应该立刻开跑');

      await send(ws, { type: 'chat.send', sessionId: 's-queue-1', content: '第二条' });
      assert.deepEqual(spawned, ['第一条'], '第二条不能插队进运行时');
      const queued = framesOfKind(ws, 'chat_queued');
      assert.equal(queued.length, 1, '应该回一帧 chat_queued');
      assert.equal(queued[0].preview, '第二条');
      assert.equal(framesOfKind(ws, 'protocol_error').length, 0, '不该再打回协议错误');

      finishCurrentTurn();
      await settle();
      assert.deepEqual(spawned, ['第一条', '第二条'], '第一条结束后第二条要自动接上');
      assert.equal(framesOfKind(ws, 'chat_queue_flushed').length, 1);

      finishCurrentTurn();
      await settle();
    });
  });

  test('只收一条:第三条明确拒绝,而不是悄悄替换掉排队那条', async () => {
    await withIsolatedDatabase(async () => {
      const alice = await seedSession('s-queue-2');
      const { ws, spawned, finishCurrentTurn } = connect(alice);

      void send(ws, { type: 'chat.send', sessionId: 's-queue-2', content: 'A' });
      await settle();
      await send(ws, { type: 'chat.send', sessionId: 's-queue-2', content: 'B' });
      await send(ws, { type: 'chat.send', sessionId: 's-queue-2', content: 'C' });

      const errors = framesOfKind(ws, 'protocol_error');
      assert.equal(errors.length, 1);
      assert.equal(errors[0].code, 'QUEUE_FULL');

      finishCurrentTurn();
      await settle();
      assert.deepEqual(spawned, ['A', 'B'], 'C 不该顶替 B —— 排队的仍是先到的那条');

      finishCurrentTurn();
      await settle();
    });
  });

  test('撤销:排队那条不再发,并广播 chat_queue_cancelled', async () => {
    await withIsolatedDatabase(async () => {
      const alice = await seedSession('s-queue-3');
      const { ws, spawned, finishCurrentTurn } = connect(alice);

      void send(ws, { type: 'chat.send', sessionId: 's-queue-3', content: 'A' });
      await settle();
      await send(ws, { type: 'chat.send', sessionId: 's-queue-3', content: 'B' });
      await send(ws, { type: 'chat.cancel-queued', sessionId: 's-queue-3' });

      const cancelled = framesOfKind(ws, 'chat_queue_cancelled');
      assert.equal(cancelled.length, 1);
      assert.equal(cancelled[0].reason, 'cancelled');

      finishCurrentTurn();
      await settle();
      assert.deepEqual(spawned, ['A'], '撤销之后不该再发出去');
    });
  });

  test('中止会把排队那条一起带走 —— "停"就是停,不是"停这条跑下一条"', async () => {
    await withIsolatedDatabase(async () => {
      const alice = await seedSession('s-queue-4');
      const { ws, spawned, finishCurrentTurn } = connect(alice);

      void send(ws, { type: 'chat.send', sessionId: 's-queue-4', content: 'A' });
      await settle();
      await send(ws, { type: 'chat.send', sessionId: 's-queue-4', content: 'B' });
      await send(ws, { type: 'chat.abort', sessionId: 's-queue-4' });

      const cancelled = framesOfKind(ws, 'chat_queue_cancelled');
      assert.equal(cancelled.length, 1);
      assert.equal(cancelled[0].reason, 'aborted', '要说清是被中止带走的,否则消息像是凭空消失');

      finishCurrentTurn();
      await settle();
      assert.deepEqual(spawned, ['A']);
    });
  });

  test('subscribe 报出排队状态 —— 刷新页面后"有一条在等"不能只活在原标签页里', async () => {
    await withIsolatedDatabase(async () => {
      const alice = await seedSession('s-queue-5');
      const { ws, finishCurrentTurn } = connect(alice);

      void send(ws, { type: 'chat.send', sessionId: 's-queue-5', content: 'A' });
      await settle();
      await send(ws, { type: 'chat.send', sessionId: 's-queue-5', content: '排队的那条' });
      await send(ws, { type: 'chat.subscribe', sessions: [{ sessionId: 's-queue-5', lastSeq: 0 }] });

      const acks = framesOfKind(ws, 'chat_subscribed');
      const queued = acks.at(-1)?.queued as { preview?: string } | null;
      assert.ok(queued, 'ack 里应该带着排队状态');
      assert.equal(queued?.preview, '排队的那条');

      await send(ws, { type: 'chat.cancel-queued', sessionId: 's-queue-5' });
      finishCurrentTurn();
      await settle();
    });
  });
});
