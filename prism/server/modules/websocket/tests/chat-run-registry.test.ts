import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { test } from 'vitest';

import { closeConnection, initializeDatabase, sessionMessagesDb, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/shared/websocket-state.js';

/**
 * Minimal stand-in for a websocket connection: collects every JSON frame the
 * gateway writer forwards so assertions can inspect the outbound protocol.
 */
class FakeConnection {
  readyState = 1; // WS_OPEN_STATE
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'chat-run-registry-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('live events are remapped to the app session id and sequenced', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-1', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-1',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: 'user-1',
    });
    assert.ok(run);

    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'provider-id-9', content: 'hello' });
    run.writer.send({ kind: 'text', provider: 'claude', sessionId: 'provider-id-9', content: 'hello world' });

    assert.equal(connection.frames.length, 2);
    assert.equal(connection.frames[0]?.sessionId, 'app-run-1');
    assert.equal(connection.frames[0]?.seq, 1);
    assert.equal(connection.frames[1]?.sessionId, 'app-run-1');
    assert.equal(connection.frames[1]?.seq, 2);
  });
});

test('session_created is swallowed and persisted as the provider-id mapping', async () => {
  // 广播现在按项目可见性过滤。这条会话建在无主项目 /workspace/demo 下,而连接是
  // 匿名的(无 prismUserId)—— 新口径下匿名看不到非公共的无主项目。把
  // /workspace 声明成公共目录,让这条测试专注它本来要测的东西(session_created →
  // 映射持久化),而不是被可见性过滤挡在门外。
  const previousPublic = process.env.PRISM_PUBLIC_WORKSPACE;
  process.env.PRISM_PUBLIC_WORKSPACE = '/workspace';
  try {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-2', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    connectedClients.add(connection as never);
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-2',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);

    run.writer.send({
      kind: 'session_created',
      provider: 'claude',
      sessionId: 'native-7',
      newSessionId: 'native-7',
    });

    // The provider-native event itself is never forwarded...
    const sessionUpserts = connection.frames.filter((frame) => frame.kind === 'session_upserted');
    assert.equal(sessionUpserts.length, 1);
    assert.equal(sessionUpserts[0]?.sessionId, 'app-run-2');
    assert.equal(sessionUpserts[0]?.providerSessionId, 'native-7');
    // ...but the canonical mapping is recorded and persisted in the database.
    assert.equal(run.providerSessionId, 'native-7');
    assert.equal(sessionsDb.getSessionById('app-run-2')?.provider_session_id, 'native-7');
  });
  } finally {
    if (previousPublic === undefined) delete process.env.PRISM_PUBLIC_WORKSPACE;
    else process.env.PRISM_PUBLIC_WORKSPACE = previousPublic;
  }
});

test('complete marks the run finished and duplicate completes are dropped', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-3', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-3',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);

    run.writer.send({ kind: 'complete', provider: 'claude', sessionId: 'native-3', exitCode: 0 });
    // Late duplicate from a killed runtime's exit handler.
    run.writer.send({ kind: 'complete', provider: 'claude', sessionId: 'native-3', exitCode: 1 });

    const completes = connection.frames.filter((frame) => frame.kind === 'complete');
    assert.equal(completes.length, 1);
    assert.equal(completes[0]?.actualSessionId, 'app-run-3');
    assert.equal(chatRunRegistry.isProcessing('app-run-3'), false);

    // completeRun is also a no-op once the run already completed.
    chatRunRegistry.completeRun('app-run-3', { exitCode: 1 });
    assert.equal(connection.frames.filter((frame) => frame.kind === 'complete').length, 1);
  });
});

test('a finished run\'s safety net cannot complete the session\'s next run', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-9', 'claude', '/workspace/demo');
    const connection = new FakeConnection();

    const firstRun = chatRunRegistry.startRun({
      appSessionId: 'app-run-9',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(firstRun);
    firstRun.writer.send({ kind: 'complete', provider: 'claude', sessionId: 'native-9', exitCode: 0 });

    // A queued message starts the next run before the first run's runtime
    // promise settles (the chat handler's `finally` hasn't executed yet).
    const secondRun = chatRunRegistry.startRun({
      appSessionId: 'app-run-9',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(secondRun);

    // First run's safety net fires late: it must not touch the new run.
    chatRunRegistry.completeRunIfCurrent(firstRun, { exitCode: 1 });
    assert.equal(chatRunRegistry.isProcessing('app-run-9'), true);
    assert.equal(connection.frames.filter((frame) => frame.kind === 'complete').length, 1);

    // The second run's own safety net still works while it is current.
    chatRunRegistry.completeRunIfCurrent(secondRun, { exitCode: 1 });
    assert.equal(chatRunRegistry.isProcessing('app-run-9'), false);
    assert.equal(connection.frames.filter((frame) => frame.kind === 'complete').length, 2);
  });
});

test('listRunningRuns returns only currently running app sessions', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-7', 'claude', '/workspace/demo');
    sessionsDb.createAppSession('app-run-8', 'claude', '/workspace/demo');
    const connection = new FakeConnection();

    const completedRun = chatRunRegistry.startRun({
      appSessionId: 'app-run-7',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(completedRun);

    const runningRun = chatRunRegistry.startRun({
      appSessionId: 'app-run-8',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(runningRun);

    chatRunRegistry.completeRun('app-run-7', { exitCode: 0 });

    const runningSessions = chatRunRegistry.listRunningRuns();
    assert.deepEqual(runningSessions.map((session) => session.sessionId), ['app-run-8']);
    assert.equal(runningSessions[0]?.provider, 'claude');
  });
});

test('replayEvents returns only events after the requested seq', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-4', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-4',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);

    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'x', content: 'a' });
    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'x', content: 'b' });
    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'x', content: 'c' });

    const replayed = chatRunRegistry.replayEvents('app-run-4', 1);
    assert.deepEqual(replayed.map((event) => event.content), ['b', 'c']);
    assert.deepEqual(replayed.map((event) => event.seq), [2, 3]);
  });
});

/**
 * 订阅是加入,不是接管。
 *
 * 单持有者的话,同一个人开两个标签页,先开的那个从此收不到任何帧,一直转圈到刷新;
 * 公开项目里另一个人打开同一会话效果一样。审批帧走的也是这条路:被抢走后落在另一个浏览器上,
 * 那边若没在看这个会话还会再丢一次,两边都没人看见,原用户只等到 "Permission request timed out"。
 */
test('订阅是加入而不是接管:两个 socket 都继续收流', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-5', 'claude', '/workspace/demo');
    const firstConnection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-5',
      provider: 'claude',
      providerSessionId: null,
      connection: firstConnection,
      userId: null,
    });
    assert.ok(run);

    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'o', content: 'before' });

    const secondConnection = new FakeConnection();
    assert.equal(chatRunRegistry.attachConnection('app-run-5', secondConnection), true);
    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'o', content: 'after' });

    // 先来的那个仍然在收 —— 这一条就是回归本体。
    assert.deepEqual(firstConnection.frames.map((frame) => frame.content), ['before', 'after']);
    // 后来的从加入的那一刻开始收;它之前错过的由 replayEvents 补。
    assert.deepEqual(secondConnection.frames.map((frame) => frame.content), ['after']);
  });
});

test('断开的 socket 被摘掉,活着的不受影响', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-6', 'claude', '/workspace/demo');
    const staying = new FakeConnection();
    const leaving = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-6',
      provider: 'claude',
      providerSessionId: null,
      connection: staying,
      userId: null,
    });
    assert.ok(run);
    chatRunRegistry.attachConnection('app-run-6', leaving);
    assert.equal(run.writer.liveConnectionCount(), 2);

    chatRunRegistry.detachConnection(leaving);
    assert.equal(run.writer.liveConnectionCount(), 1);

    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'o', content: 'x' });
    assert.deepEqual(staying.frames.map((frame) => frame.content), ['x']);
    assert.deepEqual(leaving.frames, []);
  });
});

/**
 * 已关闭的 socket 在 `forward` 时被顺手回收 —— 刷新页面留下的旧连接没有人会来
 * 摘,靠这里兜底,否则 `liveConnectionCount()` 会一直虚高,而投递可达性判断读的
 * 就是它。
 */
test('已关闭的连接在下一次发送时被回收', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-7', 'claude', '/workspace/demo');
    const alive = new FakeConnection();
    const dead = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-7',
      provider: 'claude',
      providerSessionId: null,
      connection: alive,
      userId: null,
    });
    assert.ok(run);
    chatRunRegistry.attachConnection('app-run-7', dead);

    dead.readyState = 3; // CLOSED
    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'o', content: 'x' });

    assert.equal(run.writer.liveConnectionCount(), 1);
    assert.deepEqual(dead.frames, []);
    assert.deepEqual(alive.frames.map((frame) => frame.content), ['x']);
  });
});

test('startRun rejects a second concurrent run for the same session', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-6', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    const first = chatRunRegistry.startRun({
      appSessionId: 'app-run-6',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(first);

    const second = chatRunRegistry.startRun({
      appSessionId: 'app-run-6',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.equal(second, null);

    // After the run finishes a new one is allowed again.
    chatRunRegistry.completeRun('app-run-6', { exitCode: 0 });
    const third = chatRunRegistry.startRun({
      appSessionId: 'app-run-6',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(third);
  });
});

test('第二轮的补发不会被上一轮的游标滤掉(runId 判轮次)', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-5', 'claude', '/workspace/demo');
    const connection = new FakeConnection();

    // 第 1 轮:跑到 seq=3,客户端游标停在 3
    const first = chatRunRegistry.startRun({
      appSessionId: 'app-run-5', provider: 'claude', providerSessionId: null, connection, userId: null,
    });
    assert.ok(first);
    for (const c of ['a', 'b', 'c']) {
      first.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'x', content: c });
    }
    const firstRunId = chatRunRegistry.currentRunId('app-run-5');
    assert.ok(firstRunId);
    chatRunRegistry.completeRun('app-run-5', { exitCode: 0 });

    // 第 2 轮:seq 又从 0 开始
    const second = chatRunRegistry.startRun({
      appSessionId: 'app-run-5', provider: 'claude', providerSessionId: null, connection, userId: null,
    });
    assert.ok(second);
    for (const c of ['d', 'e'] ) {
      second.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'x', content: c });
    }
    const secondRunId = chatRunRegistry.currentRunId('app-run-5');
    assert.notEqual(secondRunId, firstRunId, '每轮必须是不同的 runId,否则这条判据形同虚设');

    // 带着上一轮的游标来重连:只按 seq 过滤的话,`seq > 3` 在第 2 轮一条都匹配不上,整轮内容丢失。
    const replayed = chatRunRegistry.replayEvents('app-run-5', 3, firstRunId);
    assert.deepEqual(replayed.map((e) => e.content), ['d', 'e'], '轮次不同就该从头补');

    // 同一轮的游标照旧只补更新的
    const sameRun = chatRunRegistry.replayEvents('app-run-5', 1, secondRunId);
    assert.deepEqual(sameRun.map((e) => e.content), ['e']);
  });
});

test('审批帧不进重放缓冲(否则刷新后已回答的框会重新弹出来)', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-6', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-6', provider: 'claude', providerSessionId: null, connection, userId: null,
    });
    assert.ok(run);

    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'x', content: 'a' });
    run.writer.send({ kind: 'permission_request', provider: 'claude', sessionId: 'x', requestId: 'r1', toolName: 'Bash' });
    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'x', content: 'b' });

    const replayed = chatRunRegistry.replayEvents('app-run-6', 0);
    assert.deepEqual(
      replayed.map((e) => e.kind),
      ['stream_delta', 'stream_delta'],
      '审批的权威来源是 chat_subscribed.pendingPermissions,重放里不该再有一份',
    );
  });
});

/**
 * 已完成的 run 不再转发迟到的内容帧。
 *
 * 中止会抢先发终止帧把 run 标成 completed,而被杀掉的运行时随后还会吐一阵在途的
 * tool_result / stream_delta。只丢重复的 `complete` 不够:其他 kind 照发照落库的话,
 * 前端已经停了转圈,正文却还在长。
 */
test('complete 之后的内容帧一律丢弃', async () => {
  const previousPublic = process.env.PRISM_PUBLIC_WORKSPACE;
  process.env.PRISM_PUBLIC_WORKSPACE = '/workspace';
  try {
    await withIsolatedDatabase(() => {
      sessionsDb.createAppSession('app-late', 'claude', '/workspace/demo');
      const connection = new FakeConnection();
      connectedClients.add(connection as never);
      const run = chatRunRegistry.startRun({
        appSessionId: 'app-late',
        provider: 'claude',
        providerSessionId: null,
        connection,
        userId: null,
      })!;

      run.writer.send({ kind: 'text', role: 'assistant', content: '正文', sessionId: 'app-late' } as never);
      const beforeComplete = connection.frames.length;

      chatRunRegistry.completeRunIfCurrent(run, { exitCode: 0, aborted: true });
      // 运行时随后吐的在途帧
      run.writer.send({ kind: 'tool_result', toolId: 't1', content: '迟到的结果', sessionId: 'app-late' } as never);
      run.writer.send({ kind: 'text', role: 'assistant', content: '停止之后还在长', sessionId: 'app-late' } as never);

      const afterFrames = connection.frames.slice(beforeComplete);
      const contentFrames = afterFrames.filter((frame) => frame.kind !== 'complete');
      assert.deepEqual(contentFrames, [], `complete 之后不该再有内容帧,实际:${JSON.stringify(contentFrames)}`);
      connectedClients.delete(connection as never);
    });
  } finally {
    if (previousPublic === undefined) delete process.env.PRISM_PUBLIC_WORKSPACE;
    else process.env.PRISM_PUBLIC_WORKSPACE = previousPublic;
  }
});

/**
 * 正常收尾之后的「本轮改动的文件」摘要必须还能发出去。
 *
 * completed 之后的转发闸是为了挡中止之后在途的正文帧,但 `queryClaudeSDK` 的结构是
 * "回合函数自己发 complete → 返回 → 外层才算 `changedFilesSince` 并发 `changed_files`",
 * 一律不转发的话,每个动过文件的正常回合那张卡都会被丢掉(工作面板事件、显示日志一并没有)。
 * 用 Bash / 脚本写文件时那张卡是唯一线索,补不回来。
 */
test('正常 complete 之后,changed_files 仍然送达;正文帧仍然被拒', async () => {
  const previousPublic = process.env.PRISM_PUBLIC_WORKSPACE;
  process.env.PRISM_PUBLIC_WORKSPACE = '/workspace';
  try {
    await withIsolatedDatabase(() => {
      sessionsDb.createAppSession('app-post', 'claude', '/workspace/demo');
      const connection = new FakeConnection();
      connectedClients.add(connection as never);
      const run = chatRunRegistry.startRun({
        appSessionId: 'app-post', provider: 'claude', providerSessionId: null,
        connection, userId: null,
      })!;

      // 正常收尾(不是中止)
      chatRunRegistry.completeRunIfCurrent(run, { exitCode: 0 });

      // 外层随后发的回合摘要 —— 必须放行
      run.writer.send({
        kind: 'changed_files', checkpointId: 'cp1', files: [{ path: '/w/a.ts', status: 'M' }],
        sessionId: 'app-post',
      } as never);
      // 上一个 epoch 的正文残余 —— 仍然要拒
      run.writer.send({ kind: 'text', role: 'assistant', content: '残余', sessionId: 'app-post' } as never);

      const kinds = connection.frames.map((frame) => frame.kind);
      assert.ok(kinds.includes('changed_files'), `changed_files 必须送达,实际:${JSON.stringify(kinds)}`);
      assert.ok(!kinds.includes('text'), 'complete 之后的正文帧仍然要拒');
      connectedClients.delete(connection as never);
    });
  } finally {
    if (previousPublic === undefined) delete process.env.PRISM_PUBLIC_WORKSPACE;
    else process.env.PRISM_PUBLIC_WORKSPACE = previousPublic;
  }
});

test('中止收尾之后,连 changed_files 也不收 —— 用户按了停止,后面的都不算数', async () => {
  const previousPublic = process.env.PRISM_PUBLIC_WORKSPACE;
  process.env.PRISM_PUBLIC_WORKSPACE = '/workspace';
  try {
    await withIsolatedDatabase(() => {
      sessionsDb.createAppSession('app-abort', 'claude', '/workspace/demo');
      const connection = new FakeConnection();
      connectedClients.add(connection as never);
      const run = chatRunRegistry.startRun({
        appSessionId: 'app-abort', provider: 'claude', providerSessionId: null,
        connection, userId: null,
      })!;

      chatRunRegistry.completeRunIfCurrent(run, { exitCode: 1, aborted: true });
      const before = connection.frames.length;
      run.writer.send({
        kind: 'changed_files', checkpointId: 'cp1', files: [{ path: '/w/a.ts', status: 'M' }],
        sessionId: 'app-abort',
      } as never);
      assert.equal(connection.frames.length, before, '中止之后一帧都不该再收');
      connectedClients.delete(connection as never);
    });
  } finally {
    if (previousPublic === undefined) delete process.env.PRISM_PUBLIC_WORKSPACE;
    else process.env.PRISM_PUBLIC_WORKSPACE = previousPublic;
  }
});

/**
 * 只广播不落库:网关已经自己把用户行写进显示日志,同一行再作为实时帧发出时不能再写一次。
 * 这里故意用一行"没落过库"的消息:走普通 `writer.send` 会在出站收口写进日志,这条路一行都不写。
 */
test('broadcastWithoutPersist:编号、进重放缓冲、发给订阅者,不写显示日志', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-live-only', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-live-only', provider: 'claude', providerSessionId: null,
      connection, userId: null,
    });
    assert.ok(run);

    const row = {
      id: 'user_live_1', sessionId: 'app-live-only', timestamp: '2026-10-07T00:00:00.000Z',
      provider: 'claude', kind: 'text', role: 'user', content: '提问', clientMessageId: 'cmid-x',
    } as const;
    assert.equal(chatRunRegistry.broadcastWithoutPersist('app-live-only', row), true);

    assert.equal(connection.frames.length, 1);
    assert.equal(connection.frames[0]?.id, 'user_live_1');
    assert.equal(connection.frames[0]?.seq, 1);
    assert.equal(connection.frames[0]?.runId, run.runId);
    assert.deepEqual(chatRunRegistry.replayEvents('app-live-only', 0).map((event) => event.id), ['user_live_1']);
    assert.equal(sessionMessagesDb.listForSession('app-live-only').length, 0, '这条路不落显示日志');

    // 对照:同一行走 writer.send 会落库(出站收口)
    run.writer.send({ ...row, id: 'user_live_2' });
    assert.deepEqual(sessionMessagesDb.listForSession('app-live-only').map((message) => message.id), ['user_live_2']);
  });
});

test('broadcastWithoutPersist:没有在跑的回合时什么都不做', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-live-idle', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    const row = {
      id: 'user_idle_1', sessionId: 'app-live-idle', timestamp: '2026-10-07T00:00:00.000Z',
      provider: 'claude', kind: 'text', role: 'user', content: '提问',
    } as const;
    assert.equal(chatRunRegistry.broadcastWithoutPersist('app-live-idle', row), false, '还没有回合');

    const run = chatRunRegistry.startRun({
      appSessionId: 'app-live-idle', provider: 'claude', providerSessionId: null,
      connection, userId: null,
    });
    assert.ok(run);
    chatRunRegistry.completeRunIfCurrent(run, { exitCode: 0 });
    const before = connection.frames.length;
    assert.equal(chatRunRegistry.broadcastWithoutPersist('app-live-idle', row), false, '回合已收尾');
    assert.equal(connection.frames.length, before);
    assert.equal(chatRunRegistry.replayEvents('app-live-idle', 0).some((event) => event.id === 'user_idle_1'), false);
  });
});
