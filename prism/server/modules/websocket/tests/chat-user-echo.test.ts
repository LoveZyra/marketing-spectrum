import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, test, vi } from 'vitest';

import {
  closeConnection,
  initializeDatabase,
  projectsDb,
  sessionMessagesDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import {
  handleChatConnection,
  handleMergedMessageEvent,
  resetMergedRowsForTest,
} from '@/modules/websocket/services/chat-websocket.service.js';
import { connectedClients } from '@/shared/websocket-state.js';

/**
 * 用户这条消息的回显与 `clientMessageId`。
 *
 * 用户行是入站的,由网关直接写显示日志;同一行还要作为这一轮的实时帧推给所有查看者
 * (编号、进重放缓冲),否则共享会话里别人、同一个人的第二个标签页整轮看不到提问。
 * 前端按 `clientMessageId` 把本地乐观回显和服务端这一行精确配对,所以日志行、实时帧、
 * `chat_queue_cancelled` 都要带上它。
 *
 * seed 用可控的替身:准备期被停止要卡在 seed 那段 await 里,seed 失败要能造出来。
 */
const seedControl = vi.hoisted(() => ({
  override: null as null | ((sessionId: string) => Promise<unknown>),
}));

vi.mock('@/modules/providers/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/providers/index.js')>();
  return {
    ...actual,
    seedDisplayLogFromTranscript: (sessionId: string) => (seedControl.override
      ? seedControl.override(sessionId)
      : actual.seedDisplayLogFromTranscript(sessionId)),
  };
});

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

  userFrames(): SentFrame[] {
    return this.sent.filter((frame) => frame.kind === 'text' && frame.role === 'user');
  }

  framesOfKind(kind: string): SentFrame[] {
    return this.sent.filter((frame) => frame.kind === kind);
  }
}

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'chat-user-echo-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

afterEach(() => {
  seedControl.override = null;
  resetMergedRowsForTest();
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** setImmediate + 已排队的 promise 都跑完(续发是异步接上的)。 */
const settle = async () => {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

type Writer = { send: (message: Record<string, unknown>) => void };

/**
 * 一组共用的依赖:每次 spawn 先发一帧助手正文,再卡住直到测试 `finishTurn()`。
 * 卡住才造得出"这一轮还在跑"(中途订阅、合流、排队都要它)。
 */
function createHarness(options: {
  merge?: (appSessionId: string, input: Record<string, unknown>) => Promise<{ merged: boolean; reason?: string; uuid?: string }>;
  prewarm?: (input: Record<string, unknown>) => Promise<unknown>;
  /** 换掉默认的 provider 行为(默认:发一帧助手正文,再卡住直到 finishTurn)。 */
  spawn?: (command: string, runtimeOptions: Record<string, unknown>, writer: Writer) => Promise<void>;
  /** provider 报的待批审批(默认没有)。 */
  pendingApprovals?: (sessionId: string) => unknown[];
  /** provider 的停止(默认:直接说停住了)。 */
  abort?: (providerSessionId: string, context: { runId?: string }) => boolean | Promise<boolean>;
} = {}) {
  const spawned: string[] = [];
  const releases: Array<() => void> = [];
  const deps = {
    spawnFns: {
      claude: async (command: string, runtimeOptions: Record<string, unknown>, writer: Writer) => {
        spawned.push(command);
        if (options.spawn) {
          await options.spawn(command, runtimeOptions, writer);
          return;
        }
        writer.send({ kind: 'text', role: 'assistant', provider: 'claude', sessionId: 'native', content: `回答:${command}` });
        await new Promise<void>((resolve) => { releases.push(resolve); });
      },
    },
    abortFns: { claude: options.abort ?? (() => true) },
    ...(options.merge ? { mergeFns: { claude: options.merge } } : {}),
    ...(options.prewarm ? { prewarmSession: options.prewarm } : {}),
    getToolApprovalSessionId: () => null,
    resolveToolApproval: () => {},
    getPendingApprovalsForSession: options.pendingApprovals ?? (() => []),
  };
  const connect = (user: { id: number; username: string }) => {
    const ws = new FakeSocket();
    handleChatConnection(ws as never, { user: { id: user.id, username: user.username } } as never, deps as never);
    return ws;
  };
  return {
    spawned,
    connect,
    finishTurn: () => { releases.shift()?.(); },
  };
}

const send = (ws: FakeSocket, payload: Record<string, unknown>) => ws.emit('message', JSON.stringify(payload));

/** 一个公共项目(属主 alice,所有登录用户可见)下的会话 —— 共享会话的最小样子。 */
function seedSharedSession(sessionId: string) {
  const alice = { id: Number(userDb.createUser('alice', 'hash').id), username: 'alice' };
  const bob = { id: Number(userDb.createUser('bob', 'hash').id), username: 'bob' };
  const carol = { id: Number(userDb.createUser('carol', 'hash').id), username: 'carol' };
  projectsDb.createProjectPath('/workspace/shared', null, alice.id, 'public');
  sessionsDb.createAppSession(sessionId, 'claude', '/workspace/shared', alice.id);
  return { alice, bob, carol };
}

const userRowsInLog = (sessionId: string) =>
  sessionMessagesDb.listForSession(sessionId).filter((row) => row.kind === 'text' && row.role === 'user');

describe('用户行:显示日志带 clientMessageId,同一行作为这一轮的实时帧', () => {
  test('正常发送:日志一行、帧带 seq / runId、先于助手帧、发给所有查看者、进重放缓冲', async () => {
    await withIsolatedDatabase(async () => {
      const { alice, bob, carol } = seedSharedSession('s-echo-1');
      const harness = createHarness();
      const bobWs = harness.connect(bob);
      await send(bobWs, { type: 'chat.subscribe', sessions: [{ sessionId: 's-echo-1', lastSeq: 0 }] });

      const aliceWs = harness.connect(alice);
      const sending = send(aliceWs, {
        type: 'chat.send', sessionId: 's-echo-1', content: '你好', clientMessageId: 'cmid-1',
      });
      await settle();
      assert.deepEqual(harness.spawned, ['你好']);

      const logged = userRowsInLog('s-echo-1');
      assert.equal(logged.length, 1, '显示日志里只有一行用户行');
      const row = logged[0];
      assert.equal(row.clientMessageId, 'cmid-1');
      assert.equal(typeof row.turnUuid, 'string');
      assert.equal(row.seq, undefined, '落库的是网关自己写的那一行,不是加了编号的实时帧');

      const echoed = aliceWs.userFrames();
      assert.equal(echoed.length, 1, '发起人也收到这一帧(前端按 clientMessageId 原位替换本地回显)');
      const frame = echoed[0];
      for (const key of ['id', 'timestamp', 'content', 'turnUuid', 'senderUserId', 'origin', 'clientMessageId']) {
        assert.deepEqual(frame[key], row[key], `实时帧的 ${key} 要与日志行一致`);
      }
      assert.equal(frame.sessionId, 's-echo-1');
      assert.equal(typeof frame.seq, 'number');
      assert.equal(frame.runId, chatRunRegistry.currentRunId('s-echo-1'));

      const assistantAt = aliceWs.sent.findIndex((item) => item.kind === 'text' && item.role === 'assistant');
      assert.ok(assistantAt > aliceWs.sent.indexOf(frame), '用户帧要在这一轮任何助手帧之前');
      assert.ok(Number(aliceWs.sent[assistantAt].seq) > Number(frame.seq));

      assert.deepEqual(bobWs.userFrames().map((item) => item.id), [row.id], '共享会话里另一个查看者也看得到提问');

      const replayed = chatRunRegistry.replayEvents('s-echo-1', 0).filter((event) => event.role === 'user');
      assert.deepEqual(replayed.map((event) => event.id), [row.id], '用户帧在重放缓冲里');

      // 中途打开这条会话的人靠重放补到提问
      const carolWs = harness.connect(carol);
      await send(carolWs, { type: 'chat.subscribe', sessions: [{ sessionId: 's-echo-1', lastSeq: 0 }] });
      assert.deepEqual(carolWs.userFrames().map((item) => item.id), [row.id]);

      harness.finishTurn();
      await sending;
      assert.equal(userRowsInLog('s-echo-1').length, 1, '回合跑完显示日志里仍只有一行');
    });
  });

  test('客户端没带 clientMessageId:日志行与实时帧都不写这个字段', async () => {
    await withIsolatedDatabase(async () => {
      const { alice } = seedSharedSession('s-echo-2');
      const harness = createHarness();
      const aliceWs = harness.connect(alice);
      const sending = send(aliceWs, { type: 'chat.send', sessionId: 's-echo-2', content: '没有幂等键' });
      await settle();

      const [row] = userRowsInLog('s-echo-2');
      assert.ok(row);
      assert.equal('clientMessageId' in row, false);
      const [frame] = aliceWs.userFrames();
      assert.ok(frame);
      assert.equal('clientMessageId' in frame, false);

      harness.finishTurn();
      await sending;
    });
  });

  test('seed 失败(本轮不落显示日志):日志里没有这一行,实时帧照发', async () => {
    await withIsolatedDatabase(async () => {
      const { alice, bob } = seedSharedSession('s-echo-3');
      seedControl.override = async () => ({ status: 'failed' });
      const harness = createHarness();
      const bobWs = harness.connect(bob);
      await send(bobWs, { type: 'chat.subscribe', sessions: [{ sessionId: 's-echo-3', lastSeq: 0 }] });
      const aliceWs = harness.connect(alice);

      const sending = send(aliceWs, {
        type: 'chat.send', sessionId: 's-echo-3', content: '老会话的提问', clientMessageId: 'cmid-3',
      });
      await settle();

      assert.equal(sessionMessagesDb.listForSession('s-echo-3').length, 0, 'seed 失败的那一轮一行都不写');
      const [frame] = aliceWs.userFrames();
      assert.ok(frame, '实时帧照样发');
      assert.equal(frame.clientMessageId, 'cmid-3');
      assert.equal(typeof frame.seq, 'number');
      assert.equal(bobWs.userFrames().length, 1);

      harness.finishTurn();
      await sending;
    });
  });

  test('合流插话:日志行带 interjection 与 clientMessageId,合流成功时作为当前这一轮的实时帧发出', async () => {
    await withIsolatedDatabase(async () => {
      const { alice, bob } = seedSharedSession('s-echo-4');
      const merges: string[] = [];
      const harness = createHarness({
        merge: async (_appSessionId, input) => {
          merges.push(String(input.command));
          return { merged: true, uuid: 'merged-uuid-1' };
        },
      });
      const bobWs = harness.connect(bob);
      await send(bobWs, { type: 'chat.subscribe', sessions: [{ sessionId: 's-echo-4', lastSeq: 0 }] });
      const aliceWs = harness.connect(alice);

      const first = send(aliceWs, { type: 'chat.send', sessionId: 's-echo-4', content: '第一句', clientMessageId: 'cmid-4a' });
      await settle();
      await send(aliceWs, { type: 'chat.send', sessionId: 's-echo-4', content: '插一句', clientMessageId: 'cmid-4b' });
      assert.deepEqual(merges, ['插一句']);

      const logged = userRowsInLog('s-echo-4');
      assert.equal(logged.length, 2, '合流只多写一行');
      const interjection = logged.find((row) => row.interjection === true);
      assert.ok(interjection);
      assert.equal(interjection.clientMessageId, 'cmid-4b');
      assert.equal(interjection.turnUuid, 'merged-uuid-1');

      const frame = aliceWs.userFrames().find((item) => item.clientMessageId === 'cmid-4b');
      assert.ok(frame, '插话也作为实时帧发出');
      assert.equal(frame.id, interjection.id);
      assert.equal(frame.interjection, true);
      assert.equal(typeof frame.seq, 'number');
      assert.equal(frame.runId, chatRunRegistry.currentRunId('s-echo-4'), '编进正在跑的这一轮');
      assert.ok(bobWs.userFrames().some((item) => item.id === interjection.id), '另一个查看者也看得到插话');
      assert.ok(
        chatRunRegistry.replayEvents('s-echo-4', 0).some((event) => event.id === interjection.id),
        '插话帧在重放缓冲里',
      );

      harness.finishTurn();
      await first;
      assert.equal(userRowsInLog('s-echo-4').length, 2);
    });
  });

  test('seed 失败时合流:没落库,但撤回广播仍按行 id 指认那条实时帧', async () => {
    await withIsolatedDatabase(async () => {
      const { alice, bob } = seedSharedSession('s-echo-5');
      seedControl.override = async () => ({ status: 'failed' });
      const harness = createHarness({ merge: async () => ({ merged: true, uuid: 'merged-uuid-5' }) });
      const bobWs = harness.connect(bob);
      await send(bobWs, { type: 'chat.subscribe', sessions: [{ sessionId: 's-echo-5', lastSeq: 0 }] });
      const aliceWs = harness.connect(alice);

      const first = send(aliceWs, { type: 'chat.send', sessionId: 's-echo-5', content: '第一句' });
      await settle();
      await send(aliceWs, { type: 'chat.send', sessionId: 's-echo-5', content: '插一句', clientMessageId: 'cmid-5' });
      assert.equal(sessionMessagesDb.listForSession('s-echo-5').length, 0);
      const frame = bobWs.userFrames().find((item) => item.clientMessageId === 'cmid-5');
      assert.ok(frame, '没落库也照样推给查看者');

      handleMergedMessageEvent({ type: 'withdrawn', appSessionId: 's-echo-5', uuids: ['merged-uuid-5'] });
      const [withdrawn] = bobWs.framesOfKind('chat_merged_withdrawn');
      assert.deepEqual(withdrawn?.messageIds, [frame.id], '查看者据行 id 把那条插话置灰');
      assert.deepEqual(withdrawn?.clientMessageIds, ['cmid-5']);

      harness.finishTurn();
      await first;
    });
  });
});

describe('chat_queue_cancelled 带 clientMessageId,正文只退给发起人', () => {
  test('排队那条被中止:每个查看者都拿到 clientMessageId,只有发起人拿到 content', async () => {
    await withIsolatedDatabase(async () => {
      const { alice, bob } = seedSharedSession('s-cancel-1');
      const harness = createHarness();
      const bobWs = harness.connect(bob);
      await send(bobWs, { type: 'chat.subscribe', sessions: [{ sessionId: 's-cancel-1', lastSeq: 0 }] });
      const aliceWs = harness.connect(alice);

      const first = send(aliceWs, { type: 'chat.send', sessionId: 's-cancel-1', content: 'A' });
      await settle();
      await send(aliceWs, { type: 'chat.send', sessionId: 's-cancel-1', content: '排队的 B', clientMessageId: 'cmid-q' });
      await send(bobWs, { type: 'chat.abort', sessionId: 's-cancel-1' });

      const [mine] = aliceWs.framesOfKind('chat_queue_cancelled');
      const [theirs] = bobWs.framesOfKind('chat_queue_cancelled');
      assert.equal(mine?.clientMessageId, 'cmid-q');
      assert.equal(mine?.content, '排队的 B');
      assert.equal(theirs?.clientMessageId, 'cmid-q');
      assert.equal('content' in (theirs ?? {}), false, '别人的输入框不该被灌进这段话');

      harness.finishTurn();
      await first;
      assert.deepEqual(harness.spawned, ['A']);
    });
  });

  test('准备期被别人停止:按查看者造帧,只有发起人拿到 content,都带 clientMessageId', async () => {
    await withIsolatedDatabase(async () => {
      const { alice, bob } = seedSharedSession('s-cancel-2');
      const seedGate = deferred<{ status: 'ready'; seeded: number }>();
      seedControl.override = () => seedGate.promise;
      const harness = createHarness();
      const bobWs = harness.connect(bob);
      await send(bobWs, { type: 'chat.subscribe', sessions: [{ sessionId: 's-cancel-2', lastSeq: 0 }] });
      const aliceWs = harness.connect(alice);

      // alice 这一条停在 seed 那段 await 里;bob 这时按了停止
      const sending = send(aliceWs, { type: 'chat.send', sessionId: 's-cancel-2', content: '还没发出去的话', clientMessageId: 'cmid-p' });
      await send(bobWs, { type: 'chat.abort', sessionId: 's-cancel-2' });
      assert.equal(bobWs.framesOfKind('protocol_error').length, 0, '准备中的这一条算"停住了",不报 NO_ACTIVE_RUN');
      seedGate.resolve({ status: 'ready', seeded: 0 });
      await sending;

      assert.deepEqual(harness.spawned, [], '被停止的这一条不再开跑');
      const [mine] = aliceWs.framesOfKind('chat_queue_cancelled');
      const [theirs] = bobWs.framesOfKind('chat_queue_cancelled');
      assert.equal(mine?.reason, 'aborted');
      assert.equal(mine?.content, '还没发出去的话');
      assert.equal(mine?.clientMessageId, 'cmid-p');
      assert.equal(theirs?.reason, 'aborted');
      assert.equal(theirs?.clientMessageId, 'cmid-p');
      assert.equal('content' in (theirs ?? {}), false, '共享会话里别人拿不到发起人的原文');
    });
  });

  test('派发中的那条被撤销:chat_queue_cancelled 同样带 clientMessageId', async () => {
    await withIsolatedDatabase(async () => {
      const { alice } = seedSharedSession('s-cancel-3');
      const harness = createHarness();
      const aliceWs = harness.connect(alice);

      const first = send(aliceWs, { type: 'chat.send', sessionId: 's-cancel-3', content: 'A' });
      await settle();
      await send(aliceWs, { type: 'chat.send', sessionId: 's-cancel-3', content: 'B', clientMessageId: 'cmid-d' });

      // 让续发停在 seed 里,再撤销 —— 这时它已不在排队表里,只剩派发令牌
      const seedGate = deferred<{ status: 'ready'; seeded: number }>();
      seedControl.override = () => seedGate.promise;
      harness.finishTurn();
      await first;
      await settle();
      await send(aliceWs, { type: 'chat.cancel-queued', sessionId: 's-cancel-3' });

      const cancelled = aliceWs.framesOfKind('chat_queue_cancelled');
      assert.equal(cancelled[0]?.reason, 'cancelled');
      assert.equal(cancelled[0]?.clientMessageId, 'cmid-d');

      seedGate.resolve({ status: 'ready', seeded: 0 });
      await settle();
      assert.deepEqual(harness.spawned, ['A'], '撤销之后不该再发出去');
      for (const frame of aliceWs.framesOfKind('chat_queue_cancelled')) {
        assert.equal(frame.clientMessageId, 'cmid-d');
      }
    });
  });
});

describe('续发的那条开跑之后,派发令牌就撤掉', () => {
  test('续发已经开跑时点「撤销排队」:回 NO_QUEUED_MESSAGE,不发说它没发出的 chat_queue_cancelled', async () => {
    await withIsolatedDatabase(async () => {
      const { alice, bob } = seedSharedSession('s-drained-1');
      const harness = createHarness();
      const bobWs = harness.connect(bob);
      await send(bobWs, { type: 'chat.subscribe', sessions: [{ sessionId: 's-drained-1', lastSeq: 0 }] });
      const aliceWs = harness.connect(alice);

      const first = send(aliceWs, { type: 'chat.send', sessionId: 's-drained-1', content: 'A', clientMessageId: 'cmid-a' });
      await settle();
      await send(aliceWs, { type: 'chat.send', sessionId: 's-drained-1', content: 'B', clientMessageId: 'cmid-b' });
      harness.finishTurn();
      await first;
      await settle();
      assert.deepEqual(harness.spawned, ['A', 'B'], '排队那条已经续发、开跑');
      assert.equal(bobWs.framesOfKind('chat_queue_flushed').length, 1);

      // 另一个标签页漏收了 flushed,还留着旧排队卡,这时点了撤销
      await send(bobWs, { type: 'chat.cancel-queued', sessionId: 's-drained-1' });
      assert.equal(aliceWs.framesOfKind('chat_queue_cancelled').length, 0, '不该说正在回答的这条没发出去');
      assert.equal(bobWs.framesOfKind('chat_queue_cancelled').length, 0);
      assert.equal(bobWs.framesOfKind('protocol_error').at(-1)?.code, 'NO_QUEUED_MESSAGE');
      assert.equal(chatRunRegistry.isProcessing('s-drained-1'), true, 'B 这一轮照常在跑');

      // 停止照常停的是 B 这一轮
      await send(bobWs, { type: 'chat.abort', sessionId: 's-drained-1' });
      assert.equal(chatRunRegistry.isProcessing('s-drained-1'), false);
      harness.finishTurn();
      await settle();
    });
  });
});

describe('没开跑就被拒的那一条:用户行标成撤回', () => {
  /** 照 claude-sdk 分发器的约定:先调 onTurnNotStarted,再发 error 与 complete。 */
  const refuseBeforeStart = async (_command: string, runtimeOptions: Record<string, unknown>, writer: Writer) => {
    const hook = runtimeOptions.onTurnNotStarted as ((notice: Record<string, unknown>) => void) | undefined;
    hook?.({ code: 'CLI_TURN_BUSY', message: '这一条没有发出' });
    writer.send({ kind: 'error', role: 'assistant', provider: 'claude', sessionId: 'native', content: '这一条没有发出' });
    writer.send({ kind: 'complete', provider: 'claude', sessionId: 'native', exitCode: 1 });
  };

  test('日志里那一行标 withdrawn;同一行带 withdrawn 再推一次(同 id、编号更大、在 error 之前、进重放缓冲)', async () => {
    await withIsolatedDatabase(async () => {
      const { alice, bob } = seedSharedSession('s-refused-1');
      const harness = createHarness({ spawn: refuseBeforeStart });
      const bobWs = harness.connect(bob);
      await send(bobWs, { type: 'chat.subscribe', sessions: [{ sessionId: 's-refused-1', lastSeq: 0 }] });
      const aliceWs = harness.connect(alice);
      await send(aliceWs, { type: 'chat.send', sessionId: 's-refused-1', content: '没送到的话', clientMessageId: 'cmid-r1' });
      await settle();

      const logged = userRowsInLog('s-refused-1');
      assert.equal(logged.length, 1, '没有多写一行');
      assert.equal(logged[0].withdrawn, true, '刷新后也是「已撤回」');
      assert.equal(logged[0].clientMessageId, 'cmid-r1');

      for (const ws of [aliceWs, bobWs]) {
        const frames = ws.userFrames();
        assert.equal(frames.length, 2, JSON.stringify(frames));
        assert.equal(frames[0].id, logged[0].id);
        assert.equal(frames[1].id, logged[0].id, '同 id,前端原位换掉');
        assert.equal('withdrawn' in frames[0], false);
        assert.equal(frames[1].withdrawn, true);
        assert.equal(frames[1].clientMessageId, 'cmid-r1');
        assert.ok(Number(frames[1].seq) > Number(frames[0].seq));
        const errorAt = ws.sent.findIndex((frame) => frame.kind === 'error');
        assert.ok(errorAt > ws.sent.indexOf(frames[1]), '撤回帧在 error 之前');
      }
      const replayed = chatRunRegistry.replayEvents('s-refused-1', 0).filter((event) => event.role === 'user');
      assert.deepEqual(replayed.map((event) => event.withdrawn === true), [false, true], '重放也能补到撤回的那一帧');
    });
  });

  test('seed 失败(本轮不落日志):不碰显示日志,撤回帧照推', async () => {
    await withIsolatedDatabase(async () => {
      const { alice } = seedSharedSession('s-refused-2');
      seedControl.override = async () => ({ status: 'failed' });
      const harness = createHarness({ spawn: refuseBeforeStart });
      const aliceWs = harness.connect(alice);
      await send(aliceWs, { type: 'chat.send', sessionId: 's-refused-2', content: '老会话里没送到的话', clientMessageId: 'cmid-r2' });
      await settle();

      assert.equal(sessionMessagesDb.listForSession('s-refused-2').length, 0);
      const frames = aliceWs.userFrames();
      assert.deepEqual(frames.map((frame) => frame.withdrawn === true), [false, true]);
    });
  });

  test('正常开跑的回合不标撤回', async () => {
    await withIsolatedDatabase(async () => {
      const { alice } = seedSharedSession('s-refused-3');
      const harness = createHarness();
      const aliceWs = harness.connect(alice);
      const sending = send(aliceWs, { type: 'chat.send', sessionId: 's-refused-3', content: '正常的话', clientMessageId: 'cmid-r3' });
      await settle();
      harness.finishTurn();
      await sending;
      assert.equal(userRowsInLog('s-refused-3')[0].withdrawn, undefined);
      assert.equal(aliceWs.userFrames().length, 1);
    });
  });
});

describe('还没开跑就被停止的那一条:用户行标成撤回', () => {
  /**
   * 照 claude-sdk 在等 runtime(上一轮收尾、CLI 自己那一轮)时的样子:输入还没推进去(不调 onTurnStarted),
   * 被停止之后才返回。`startNow` 为真时模拟已经推进去了。
   */
  function heldProvider({ startNow = false } = {}) {
    let release: (() => void) | null = null;
    const spawn = async (_command: string, runtimeOptions: Record<string, unknown>) => {
      if (startNow) (runtimeOptions.onTurnStarted as (() => void) | undefined)?.();
      await new Promise<void>((resolve) => { release = resolve; });
    };
    return { spawn, release: () => release?.() };
  }

  async function sendAndStop(sessionId: string, harness: ReturnType<typeof createHarness>, cmid: string) {
    const { alice, bob } = seedSharedSession(sessionId);
    const bobWs = harness.connect(bob);
    await send(bobWs, { type: 'chat.subscribe', sessions: [{ sessionId, lastSeq: 0 }] });
    const aliceWs = harness.connect(alice);
    const sending = send(aliceWs, { type: 'chat.send', sessionId, content: '还在等着的那句', clientMessageId: cmid });
    await settle();
    await send(bobWs, { type: 'chat.abort', sessionId });
    await sending;
    await settle();
    return { aliceWs, bobWs };
  }

  test('等着开跑时被停止:日志里那一行标 withdrawn,同 id 的撤回帧在 complete{aborted} 之前推给每个查看者', async () => {
    await withIsolatedDatabase(async () => {
      const provider = heldProvider();
      // 停止标记当场记下,provider 那边稍后才看到、退出(等待循环的下一次轮询)
      const harness = createHarness({ spawn: provider.spawn, abort: () => { setTimeout(() => provider.release(), 20); return true; } });
      const { aliceWs, bobWs } = await sendAndStop('s-stop-wait-1', harness, 'cmid-w1');

      const logged = userRowsInLog('s-stop-wait-1');
      assert.equal(logged.length, 1);
      assert.equal(logged[0].withdrawn, true, '刷新后也是「已撤回」');
      for (const ws of [aliceWs, bobWs]) {
        const frames = ws.userFrames();
        assert.equal(frames.length, 2, JSON.stringify(frames));
        assert.equal(frames[1].id, logged[0].id, '同 id,前端原位换掉');
        assert.equal(frames[1].withdrawn, true);
        assert.equal(frames[1].clientMessageId, 'cmid-w1');
        assert.ok(Number(frames[1].seq) > Number(frames[0].seq));
        const completeAt = ws.sent.findIndex((frame) => frame.kind === 'complete');
        assert.ok(completeAt > ws.sent.indexOf(frames[1]), '撤回帧在 complete 之前');
        assert.equal(ws.sent[completeAt].aborted, true);
      }
      assert.ok(
        chatRunRegistry.replayEvents('s-stop-wait-1', 0).some((event) => event.role === 'user' && event.withdrawn === true),
        '重放也补得到撤回帧',
      );
    });
  });

  test('provider 先于中止落定把这一轮关掉:撤回帧照样在那之前推出去', async () => {
    await withIsolatedDatabase(async () => {
      const provider = heldProvider();
      // provider 一看到停止就退出(这一轮由 chat.send 的兜底收尾),中止本身过一会儿才落定
      const harness = createHarness({
        spawn: provider.spawn,
        abort: () => {
          provider.release();
          return new Promise<boolean>((resolve) => { setTimeout(() => resolve(true), 50); });
        },
      });
      const { aliceWs } = await sendAndStop('s-stop-wait-2', harness, 'cmid-w2');
      await new Promise((resolve) => setTimeout(resolve, 80));

      assert.equal(userRowsInLog('s-stop-wait-2')[0].withdrawn, true);
      const frames = aliceWs.userFrames();
      assert.equal(frames.at(-1)?.withdrawn, true);
      const firstComplete = aliceWs.sent.findIndex((frame) => frame.kind === 'complete');
      assert.ok(firstComplete > aliceWs.sent.indexOf(frames.at(-1)!), '撤回帧在这一轮收尾之前');
    });
  });

  test('已经开跑之后被停止:那一行不动(那是打断这一轮,不是没发出)', async () => {
    await withIsolatedDatabase(async () => {
      const provider = heldProvider({ startNow: true });
      const harness = createHarness({ spawn: provider.spawn, abort: () => { setTimeout(() => provider.release(), 20); return true; } });
      const { aliceWs } = await sendAndStop('s-stop-wait-3', harness, 'cmid-w3');

      assert.equal(userRowsInLog('s-stop-wait-3')[0].withdrawn, undefined);
      assert.equal(aliceWs.userFrames().length, 1, '没有撤回帧');
    });
  });
});

describe('订阅时补发的审批卡', () => {
  test('provider 报的标记(suppressAlwaysAllow、background)原样带给前端', async () => {
    await withIsolatedDatabase(async () => {
      const { bob } = seedSharedSession('s-replay-approval');
      const harness = createHarness({
        pendingApprovals: (sessionId) => [{
          requestId: 'req-1', toolName: 'Bash', input: { command: 'ls' }, sessionId, background: true, suppressAlwaysAllow: true,
        }],
      });
      const bobWs = harness.connect(bob);
      await send(bobWs, { type: 'chat.subscribe', sessions: [{ sessionId: 's-replay-approval', lastSeq: 0 }] });
      const [subscribed] = bobWs.framesOfKind('chat_subscribed');
      const [card] = (subscribed?.pendingPermissions ?? []) as Array<Record<string, unknown>>;
      assert.equal(card?.requestId, 'req-1');
      assert.equal(card?.suppressAlwaysAllow, true);
      assert.equal(card?.background, true);
      assert.equal(card?.sessionId, 's-replay-approval');
    });
  });
});

describe('打开会话时的预热带上打开它的人', () => {
  test('单条订阅:预热按订阅人的身份与 app 会话 id 建 runtime', async () => {
    await withIsolatedDatabase(async () => {
      const { bob } = seedSharedSession('s-prewarm-1');
      sessionsDb.assignProviderSessionId('s-prewarm-1', 'native-prewarm-1');
      const prewarms: Array<Record<string, unknown>> = [];
      const harness = createHarness({
        prewarm: async (input) => {
          prewarms.push(input);
          return { warmed: true };
        },
      });
      const bobWs = harness.connect(bob);
      await send(bobWs, { type: 'chat.subscribe', sessions: [{ sessionId: 's-prewarm-1', lastSeq: 0 }] });

      assert.equal(prewarms.length, 1);
      assert.deepEqual(prewarms[0], {
        sessionId: 'native-prewarm-1',
        cwd: '/workspace/shared',
        runId: 's-prewarm-1',
        actorUserId: bob.id,
        actorUsername: 'bob',
        ownerUserId: bob.id,
      });
    });
  });
});
