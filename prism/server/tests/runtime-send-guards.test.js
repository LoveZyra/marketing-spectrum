import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, describe, test, vi } from 'vitest';

/**
 * 常驻 runtime 在「发送 / 停止 / 进程退出」这些边界上的行为。
 *
 * SDK 的 `query` 换成一个可以逐帧喂的假进程:测试决定 CLI 什么时候吐哪一帧、控制请求多久回、
 * 进程什么时候自己退出。不起子进程、不花钱。
 */

const queries = [];

/** 一个假的常驻 CLI:帧由测试喂进去,用户输入默认按「回一句 + result」作答。 */
function createFakeQuery(prompt, options) {
  const buffered = [];
  const waiters = [];
  let ended = false;
  const fake = {
    options,
    sessionId: options.resume || `aaaaaaaa-0000-4000-8000-${String(queries.length + 1).padStart(12, '0')}`,
    inputs: [],
    closed: false,
    interrupts: 0,
    setModelCalls: [],
    setModelImpl: null,
    getContextUsageImpl: null,
    aborted: false,
    /** 收到用户输入时怎么答;null = 不答(由测试自己喂帧) */
    onInput: null,
    emit(frame) {
      const message = { session_id: fake.sessionId, ...frame };
      if (waiters.length) waiters.shift()({ value: message, done: false });
      else buffered.push(message);
    },
    end() {
      ended = true;
      while (waiters.length) waiters.shift()({ value: undefined, done: true });
    },
    /** 还没被读循环取走的帧数 */
    backlog: () => buffered.length,
  };
  let replies = 0;
  fake.onInput = (message) => {
    replies += 1;
    fake.emit({ type: 'assistant', message: { id: `msg_${fake.sessionId}_${replies}`, role: 'assistant', content: [{ type: 'text', text: 'ok' }] } });
    fake.emit({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, user_message_uuid: message.uuid });
  };
  (async () => {
    try {
      for await (const message of prompt) {
        fake.inputs.push(message);
        fake.onInput?.(message, fake);
      }
    } catch { /* 输入流关了 */ }
  })();
  fake.handle = {
    [Symbol.asyncIterator]() { return this; },
    next() {
      if (buffered.length) return Promise.resolve({ value: buffered.shift(), done: false });
      if (ended) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve) => waiters.push(resolve));
    },
    return() {
      ended = true;
      return Promise.resolve({ value: undefined, done: true });
    },
    interrupt: async () => { fake.interrupts += 1; return {}; },
    close: () => { fake.closed = true; fake.end(); },
    setModel: async (model) => {
      fake.setModelCalls.push(model);
      if (fake.setModelImpl) return fake.setModelImpl(model);
      return undefined;
    },
    setPermissionMode: async () => {},
    applyFlagSettings: async () => {},
    getContextUsage: async () => (fake.getContextUsageImpl ? fake.getContextUsageImpl() : null),
    supportedCommands: async () => [],
    stopTask: async () => {},
  };
  // 与真进程一样:abortController 一 abort,进程就没了
  options.abortController?.signal.addEventListener('abort', () => { fake.aborted = true; fake.end(); }, { once: true });
  return fake;
}

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt, options }) => {
    const fake = createFakeQuery(prompt, options);
    queries.push(fake);
    return fake.handle;
  },
}));

const sdk = await import('../claude-sdk.js');
const { queryClaudeSDK, disposeAllRuntimes, getPersistentRuntime } = sdk;

const cwd = mkdtempSync(path.join(tmpdir(), 'prism-send-guards-'));

// 每一轮都要解析网关与 key(读库),给一份迁移过的临时库
const { closeConnection, initializeDatabase, usageRecordsDb } = await import('@/modules/database/index.js');
const previousDatabasePath = process.env.DATABASE_PATH;
const dbDir = mkdtempSync(path.join(tmpdir(), 'prism-send-guards-db-'));
closeConnection();
process.env.DATABASE_PATH = path.join(dbDir, 'auth.db');
await initializeDatabase();

afterEach(async () => {
  await disposeAllRuntimes();
});

afterAll(async () => {
  await disposeAllRuntimes();
  closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  rmSync(dbDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

let sessionCounter = 0;
const nextSessionId = () => {
  sessionCounter += 1;
  return `bbbbbbbb-0000-4000-8000-${String(sessionCounter).padStart(12, '0')}`;
};

function writer() {
  const frames = [];
  return { frames, userId: 1, send: (frame) => { frames.push(frame); }, setSessionId: () => {} };
}

const errorsOf = (frames) => frames.filter((frame) => frame?.kind === 'error').map((frame) => String(frame.content));
const completesOf = (frames) => frames.filter((frame) => frame?.kind === 'complete');

async function send(sessionId, extra = {}, command = 'hi') {
  const ws = writer();
  await queryClaudeSDK(command, {
    cwd, projectPath: cwd, runId: `app-${sessionId}`, permissionMode: 'default', sessionId, ...extra,
  }, ws);
  return ws.frames;
}

async function waitFor(predicate, label = 'condition', timeoutMs = 2000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 等读循环把已经喂进去的帧都处理完(取走之后的处理是同步的,再让一拍就够)。 */
async function drain(fake) {
  await waitFor(() => fake.backlog() === 0, '帧被读循环取走');
  await new Promise((resolve) => setTimeout(resolve, 10));
}

const queryFor = (sessionId) => [...queries].reverse().find((fake) => fake.sessionId === sessionId);

/** 让 CLI 自己起一轮(后台任务回报),并在这一轮里调一条主线程工具。 */
async function startCliOwnTurnWithTool(fake, runtime, toolUseId) {
  fake.emit({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '<task-notification>后台子代理完成</task-notification>' }] } });
  fake.emit({ type: 'assistant', message: { id: `msg_${toolUseId}`, role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Read', input: { file_path: '/tmp/x' } }] } });
  await waitFor(() => runtime.pendingToolUses.has(toolUseId) && runtime.orphanTurnOpen, 'CLI 自己那一轮的工具在途');
}

/**
 * 发一条,带上 onTurnStarted / onTurnNotStarted 两个钩子。
 * started = 「已开跑」被调了几次;notices = 「没开跑就被拒」的每一次,记下那一刻已经发出的 error / complete 帧数。
 */
async function sendWithNotice(sessionId, extra = {}, command = 'hi') {
  const ws = writer();
  const notices = [];
  let started = 0;
  await queryClaudeSDK(command, {
    cwd, projectPath: cwd, runId: `app-${sessionId}`, permissionMode: 'default', sessionId, ...extra,
    onTurnStarted: () => { started += 1; },
    onTurnNotStarted: (notice) => notices.push({
      ...notice,
      errorsBefore: errorsOf(ws.frames).length,
      completesBefore: completesOf(ws.frames).length,
    }),
  }, ws);
  return { frames: ws.frames, notices, started };
}

/** 把 CLI 自己那一轮收掉:工具结果回来,再出 result。 */
function finishCliOwnTurn(fake, toolUseId) {
  fake.emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'x' }] } });
  fake.emit({ type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 2 });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('CLI 自己那一轮正在跑主线程工具时用户发消息', () => {
  afterEach(() => {
    sdk.setSendWaitForTest();
  });

  test('等那一轮跑完再发:不重建、不杀进程、不报错,消息在那一轮收尾之后才推给 CLI', async () => {
    sdk.setSendWaitForTest({ pollMs: 20 });
    const sessionId = nextSessionId();
    assert.deepEqual(errorsOf(await send(sessionId)), []);
    const runtime = getPersistentRuntime(sessionId);
    const fake = queryFor(sessionId);
    assert.ok(runtime && fake);
    await startCliOwnTurnWithTool(fake, runtime, 'toolu_cli_read');
    const before = queries.length;
    const inputsBefore = fake.inputs.length;
    const answer = fake.onInput;
    let orphanOpenAtPush = null;
    fake.onInput = (message, self) => {
      orphanOpenAtPush = runtime.orphanTurnOpen;
      answer(message, self);
    };

    const stampBefore = runtime.claimedAt;
    const sending = sendWithNotice(sessionId);
    // 按条件等,不按固定时长:机器忙的时候发送走进等待、轮询续期都可能慢过一两百毫秒
    await waitFor(() => runtime.claimedAt && runtime.claimedAt !== stampBefore, '发送走进等待、盖上预占标记', 5000);
    // 预占标记每轮询一次续一次(值严格递增):等得再久也不会过期,被别的对话的名额淘汰或空闲回收挑中
    const stampEarly = runtime.claimedAt;
    await waitFor(() => runtime.claimedAt > stampEarly, '等的时候预占标记续期', 5000);
    const stampLater = runtime.claimedAt;
    assert.ok(stampLater > stampEarly, `等的时候标记在往前走(${stampEarly} → ${stampLater})`);
    assert.equal(fake.inputs.length, inputsBefore, '轮询过至少一次、那一轮还在跑:这一条还在等,没有推给 CLI');

    finishCliOwnTurn(fake, 'toolu_cli_read');
    const { frames, notices, started } = await sending;
    assert.deepEqual(errorsOf(frames), []);
    assert.equal(completesOf(frames).at(-1)?.exitCode, 0);
    assert.deepEqual(notices, []);
    assert.equal(started, 1, '推进去的那一刻告诉了调用方');
    assert.equal(fake.inputs.length, inputsBefore + 1, '推给了同一个 CLI');
    assert.equal(orphanOpenAtPush, false, '在 CLI 那一轮收尾之后才推');
    assert.equal(queries.length, before, '没有重建,也没有一次性回退');
    assert.equal(fake.closed, false);
    assert.equal(runtime.disposed, false);
    assert.equal(getPersistentRuntime(sessionId), runtime);
  });

  test('等的时候按了停止:不再等,也不开跑;CLI 自己那一轮一并打断(不杀进程,后台任务照跑)', async () => {
    sdk.setSendWaitForTest({ pollMs: 20 });
    const sessionId = nextSessionId();
    assert.deepEqual(errorsOf(await send(sessionId)), []);
    const runtime = getPersistentRuntime(sessionId);
    const fake = queryFor(sessionId);
    // 进程里还有一个后台任务在跑:停止不能把它一起停掉
    fake.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'bg-keep', task_type: 'local_bash', description: 'dev server' }] });
    await waitFor(() => runtime.liveBackgroundTasks?.size === 1, '后台任务登记');
    const stoppedTasks = [];
    runtime.query.stopTask = async (taskId) => { stoppedTasks.push(taskId); };
    await startCliOwnTurnWithTool(fake, runtime, 'toolu_cli_stop');
    const inputsBefore = fake.inputs.length;

    const sending = sendWithNotice(sessionId);
    await sleep(100);
    assert.equal(await sdk.abortClaudeSDKRun(`app-${sessionId}`), true);
    const stoppedAt = Date.now();
    const { frames, notices, started } = await sending;
    assert.ok(Date.now() - stoppedAt < 1000, '停止之后立刻不再等');
    assert.deepEqual(errorsOf(frames), []);
    assert.equal(completesOf(frames).length, 0, '停止的 complete 由中止处理器发');
    assert.deepEqual(notices, [], '按停止不算被拒');
    assert.equal(started, 0, '没开跑:调用方据此把那一行标成撤回');
    assert.equal(fake.inputs.length, inputsBefore, '这一条没有推给 CLI');
    await waitFor(() => fake.interrupts === 1, 'CLI 自己那一轮被打断');
    await waitFor(() => !runtime.orphanTurnOpen, '那一轮算关上了');
    assert.equal(fake.interrupts, 1, '只打断一次');
    assert.equal(fake.closed, false, '不杀进程');
    assert.equal(fake.aborted, false);
    assert.equal(runtime.disposed, false);
    assert.equal(runtime.liveBackgroundTasks.size, 1, '后台任务还在');
    assert.deepEqual(stoppedTasks, [], '没有去停后台任务');
    assert.equal(runtime.claimedAt ?? null, null, '预占标记撤掉');

    // 那一轮收尾之后照常能发
    finishCliOwnTurn(fake, 'toolu_cli_stop');
    await waitFor(() => runtime.pendingToolUses.size === 0, 'CLI 那一轮的工具结果回来');
    assert.deepEqual(errorsOf(await send(sessionId)), []);
    assert.equal(fake.inputs.length, inputsBefore + 1);
  });

  test('等的时候按了停止(没有后台任务):打断之后那一轮先"关上"、工具结果还没回来,这一条也不会被当成残留去重建进程', async () => {
    sdk.setSendWaitForTest({ pollMs: 20 });
    const sessionId = nextSessionId();
    assert.deepEqual(errorsOf(await send(sessionId)), []);
    const runtime = getPersistentRuntime(sessionId);
    const fake = queryFor(sessionId);
    await startCliOwnTurnWithTool(fake, runtime, 'toolu_cli_stop2');
    const before = queries.length;

    const sending = sendWithNotice(sessionId);
    await sleep(60);
    assert.equal(await sdk.abortClaudeSDKRun(`app-${sessionId}`), true);
    const { frames, started } = await sending;
    assert.deepEqual(errorsOf(frames), []);
    assert.equal(started, 0);
    assert.equal(queries.length, before, '没有起新进程');
    assert.equal(fake.closed, false, '老进程没被关掉');
    assert.equal(runtime.disposed, false);
    assert.equal(getPersistentRuntime(sessionId), runtime);
  });

  test('还没走到等待就被停止(CLI 那一轮有工具在途,打断之后工具结果还没回来):不当成残留去重建进程', async () => {
    sdk.setSendWaitForTest({ pollMs: 20 });
    const sessionId = nextSessionId();
    assert.deepEqual(errorsOf(await send(sessionId)), []);
    const runtime = getPersistentRuntime(sessionId);
    const fake = queryFor(sessionId);
    await startCliOwnTurnWithTool(fake, runtime, 'toolu_stop_early');
    const before = queries.length;
    const ws = writer();
    let started = 0;
    const sending = queryClaudeSDK('hi', {
      cwd, projectPath: cwd, runId: `app-${sessionId}`, permissionMode: 'default', sessionId,
      onTurnStarted: () => { started += 1; },
    }, ws);
    // 这一条还停在 runtimeForSend 之前的 await 里(检查点、解析模型)时按停止:
    // 打断回执先到,那一轮先算关上,工具结果(假 CLI 不回)还没回来
    assert.equal(await sdk.abortClaudeSDKRun(`app-${sessionId}`), true);
    await sending;
    assert.equal(started, 0, '没开跑');
    assert.deepEqual(errorsOf(ws.frames), []);
    assert.equal(fake.interrupts, 1, 'CLI 那一轮照样被打断');
    assert.equal(queries.length, before, '被停止的这一条不起新进程');
    assert.equal(fake.closed, false, '老进程不被关掉');
    assert.equal(runtime.disposed, false);
    assert.equal(getPersistentRuntime(sessionId), runtime);
  });

  test('等满上限那一轮还在跑:拒这一条(中文说明、不重建),拒之前先告诉调用方', async () => {
    sdk.setSendWaitForTest({ orphanTurnMs: 200, pollMs: 20 });
    const sessionId = nextSessionId();
    assert.deepEqual(errorsOf(await send(sessionId)), []);
    const runtime = getPersistentRuntime(sessionId);
    const fake = queryFor(sessionId);
    await startCliOwnTurnWithTool(fake, runtime, 'toolu_cli_long');
    const before = queries.length;
    const inputsBefore = fake.inputs.length;

    const { frames, notices } = await sendWithNotice(sessionId);
    assert.equal(queries.length, before, '没有起新进程(没有重建,也没有一次性回退)');
    assert.equal(fake.closed, false, '老进程没被关掉');
    assert.equal(runtime.disposed, false);
    assert.equal(fake.inputs.length, inputsBefore);
    const errors = errorsOf(frames);
    assert.equal(errors.length, 1, JSON.stringify(frames));
    assert.match(errors[0], /后台任务的回报/);
    assert.doesNotMatch(errors[0], /[A-Za-z]{12,}/, '不带英文内部报错');
    assert.equal(completesOf(frames).at(-1)?.exitCode, 1);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].code, 'CLI_TURN_BUSY');
    assert.equal(notices[0].errorsBefore, 0, '先告诉调用方,再发 error');
    assert.equal(notices[0].completesBefore, 0, '这一轮还没收尾');
    assert.equal(runtime.claimedAt ?? null, null, '被拒的这一条不留预占标记');
  });

  test('等的时候进程没了:按新建走(resume 同一段对话),这一条照常发出', async () => {
    sdk.setSendWaitForTest({ pollMs: 20 });
    const sessionId = nextSessionId();
    assert.deepEqual(errorsOf(await send(sessionId)), []);
    const runtime = getPersistentRuntime(sessionId);
    const fake = queryFor(sessionId);
    await startCliOwnTurnWithTool(fake, runtime, 'toolu_cli_crash');
    const before = queries.length;

    const sending = send(sessionId);
    await sleep(100);
    fake.end(); // 进程自己退出
    assert.deepEqual(errorsOf(await sending), []);
    assert.equal(runtime.disposed, true);
    assert.equal(queries.length, before + 1, '起了一个新进程');
    assert.equal(queries.at(-1).options.resume, sessionId);
    assert.equal(queries.at(-1).inputs.length, 1, '这一条推给了新进程');
  });

  test('/loop 等 CLI 自己那一轮时按了停止:第 1 轮不开跑', async () => {
    sdk.setSendWaitForTest({ pollMs: 20 });
    const sessionId = nextSessionId();
    assert.deepEqual(errorsOf(await send(sessionId)), []);
    const runtime = getPersistentRuntime(sessionId);
    const fake = queryFor(sessionId);
    await startCliOwnTurnWithTool(fake, runtime, 'toolu_cli_loop');
    const inputsBefore = fake.inputs.length;

    const sending = sendWithNotice(sessionId, {}, '/loop 修好它');
    await sleep(100);
    assert.equal(await sdk.abortClaudeSDKRun(`app-${sessionId}`), true);
    const { frames, started } = await sending;
    assert.equal(fake.inputs.length, inputsBefore, '第 1 轮没有推给 CLI');
    assert.equal(started, 0);
    assert.deepEqual(errorsOf(frames), []);
    assert.equal(completesOf(frames).length, 0, JSON.stringify(frames));
    await waitFor(() => fake.interrupts === 1, 'CLI 自己那一轮被打断');
    assert.equal(fake.closed, false);
    assert.equal(runtime.claimedAt ?? null, null);
  });

  test('真正的残留在途工具(没有回合、CLI 也没在跑自己的一轮)且后台任务在跑 → 拒(RUNTIME_REBUILD_BLOCKED 那句),不重建', async () => {
    const sessionId = nextSessionId();
    assert.deepEqual(errorsOf(await send(sessionId)), []);
    const runtime = getPersistentRuntime(sessionId);
    const fake = queryFor(sessionId);
    fake.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'bg-1', task_type: 'local_agent', description: '后台子代理' }] });
    await startCliOwnTurnWithTool(fake, runtime, 'toolu_stuck');
    // 那一轮收了尾,工具却没回来(残留)
    fake.emit({ type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 1 });
    await waitFor(() => !runtime.orphanTurnOpen, 'CLI 那一轮收尾');
    assert.equal(runtime.pendingToolUses.size, 1);
    assert.equal(runtime.liveBackgroundTasks.size, 1);

    const before = queries.length;
    const errors = errorsOf(await send(sessionId));
    assert.equal(queries.length, before, '后台任务在跑:不重建');
    assert.equal(fake.closed, false);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /后台任务在跑/);
  });

  test('真正的残留在途工具、没有后台任务 → 照旧重建(resume 同一段对话)', async () => {
    const sessionId = nextSessionId();
    assert.deepEqual(errorsOf(await send(sessionId)), []);
    const runtime = getPersistentRuntime(sessionId);
    const fake = queryFor(sessionId);
    await startCliOwnTurnWithTool(fake, runtime, 'toolu_stuck2');
    fake.emit({ type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 1 });
    await waitFor(() => !runtime.orphanTurnOpen, 'CLI 那一轮收尾');

    const before = queries.length;
    assert.deepEqual(errorsOf(await send(sessionId)), []);
    assert.equal(queries.length, before + 1, '重建了一个新进程');
    assert.equal(fake.closed, true);
    assert.equal(queries.at(-1).options.resume, sessionId);
  });

  test('CLI 自己那一轮长时间一帧都没有(进程卡死)→ 按残留处理,重建自救', async () => {
    const sessionId = nextSessionId();
    assert.deepEqual(errorsOf(await send(sessionId)), []);
    const runtime = getPersistentRuntime(sessionId);
    const fake = queryFor(sessionId);
    await startCliOwnTurnWithTool(fake, runtime, 'toolu_hung');
    // 最后一帧是很久以前的事了(工具在跑时 CLI 每 30 秒有一次心跳)
    runtime.lastUsed = Date.now() - 60 * 60 * 1000;

    const before = queries.length;
    assert.deepEqual(errorsOf(await send(sessionId)), []);
    assert.equal(queries.length, before + 1);
    assert.equal(fake.closed, true);
  });
});

describe('上一轮还在收尾时发下一条', () => {
  afterEach(() => {
    sdk.setSendWaitForTest();
  });

  /** 起一个先不答的用户回合 A(模拟「按了停止、CLI 还在收尾」),返回它的 promise 与收尾函数。 */
  async function startUnansweredTurn(sessionId) {
    const runtime = getPersistentRuntime(sessionId);
    const fake = queryFor(sessionId);
    const answer = fake.onInput;
    fake.onInput = null;
    const first = send(sessionId, {}, 'A');
    await waitFor(() => Boolean(runtime.turn), 'A 开跑');
    await waitFor(() => fake.inputs.length > 0 && fake.inputs.at(-1).message?.content?.[0]?.text === 'A', 'A 推给了 CLI');
    fake.onInput = answer;
    const finish = () => {
      const uuid = fake.inputs.find((input) => input.message?.content?.[0]?.text === 'A').uuid;
      fake.emit({ type: 'assistant', message: { id: `msg_settle_${uuid}`, role: 'assistant', content: [{ type: 'text', text: 'A 收尾' }] } });
      fake.emit({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, user_message_uuid: uuid });
    };
    return { runtime, fake, first, finish };
  }

  test('上一轮两秒多才收尾:这一条等它收尾后照常发出,不报「上一轮还没结束」', async () => {
    const sessionId = nextSessionId();
    assert.deepEqual(errorsOf(await send(sessionId)), []);
    const { fake, first, finish } = await startUnansweredTurn(sessionId);
    const inputsBefore = fake.inputs.length;

    const second = sendWithNotice(sessionId, {}, 'B');
    await sleep(2500);
    assert.equal(fake.inputs.length, inputsBefore, 'B 还在等上一轮收尾');
    finish();
    assert.deepEqual(errorsOf(await first), []);
    const { frames, notices } = await second;
    assert.deepEqual(errorsOf(frames), []);
    assert.deepEqual(notices, []);
    assert.equal(fake.inputs.length, inputsBefore + 1, 'B 推给了 CLI');
    assert.equal(fake.inputs.at(-1).message.content[0].text, 'B');
  });

  test('上一轮迟迟不收尾(等满上限):拒这一条(TURN_BUSY),拒之前先告诉调用方', async () => {
    sdk.setSendWaitForTest({ turnSettleMs: 200, pollMs: 20 });
    const sessionId = nextSessionId();
    assert.deepEqual(errorsOf(await send(sessionId)), []);
    const { runtime, fake, first, finish } = await startUnansweredTurn(sessionId);
    const inputsBefore = fake.inputs.length;

    const { frames, notices } = await sendWithNotice(sessionId, {}, 'B');
    const errors = errorsOf(frames);
    assert.equal(errors.length, 1, JSON.stringify(frames));
    assert.match(errors[0], /上一轮还没结束/);
    assert.equal(completesOf(frames).at(-1)?.exitCode, 1);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].code, 'TURN_BUSY');
    assert.equal(notices[0].errorsBefore, 0);
    assert.equal(fake.inputs.length, inputsBefore, 'B 没有推给 CLI');
    assert.equal(runtime.claimedAt ?? null, null);

    finish();
    assert.deepEqual(errorsOf(await first), [], 'A 照常收尾');
  });

  test('上一轮被停止、还在收尾时来的插话不合流进那一轮(turn-stopping),退回排队', async () => {
    const sessionId = nextSessionId();
    assert.deepEqual(errorsOf(await send(sessionId)), []);
    const { runtime, fake, first, finish } = await startUnansweredTurn(sessionId);
    const appSessionId = `app-${sessionId}`;
    assert.equal(sdk.mergeRefusalReason(runtime, 'B'), null, '前提:停止之前这一轮可以合流');

    assert.equal(await sdk.abortClaudeSDKRun(appSessionId), true);
    assert.equal(runtime.turn?.stopping, true, '停止时在那一轮上记了一笔(那一轮还在收尾)');
    const merged = await sdk.mergeUserMessage(appSessionId, { command: 'B', providerSessionId: sessionId });
    assert.equal(merged.merged, false);
    assert.equal(merged.reason, 'turn-stopping');
    assert.equal(fake.inputs.some((input) => input.message?.content?.[0]?.text === 'B'), false, 'B 没有推进 CLI');

    finish();
    await first;
  });

  test('按会话停止(abortClaudeSDKSession)同样在那一轮上记 stopping', async () => {
    const sessionId = nextSessionId();
    assert.deepEqual(errorsOf(await send(sessionId)), []);
    const { runtime, first, finish } = await startUnansweredTurn(sessionId);
    assert.equal(await sdk.abortClaudeSDKSession(sessionId, { runId: `app-${sessionId}` }), true);
    assert.equal(runtime.turn?.stopping, true);
    assert.equal(sdk.mergeRefusalReason(runtime, 'B'), 'turn-stopping');
    finish();
    await first;
  });

  test('等上一轮收尾时按了停止:不再等,也不开跑', async () => {
    sdk.setSendWaitForTest({ pollMs: 20 });
    const sessionId = nextSessionId();
    assert.deepEqual(errorsOf(await send(sessionId)), []);
    const { runtime, fake, first, finish } = await startUnansweredTurn(sessionId);
    const inputsBefore = fake.inputs.length;

    const second = sendWithNotice(sessionId, {}, 'B');
    await sleep(100);
    // runId 相同,停的是后登记的 B(A 的登记已被 B 顶掉)
    assert.equal(await sdk.abortClaudeSDKRun(`app-${sessionId}`), true);
    const stoppedAt = Date.now();
    const { frames, notices, started } = await second;
    assert.ok(Date.now() - stoppedAt < 1000, `停止之后 ${Date.now() - stoppedAt}ms 才结束,没有立刻不再等`);
    assert.deepEqual(errorsOf(frames), []);
    assert.equal(completesOf(frames).length, 0);
    assert.deepEqual(notices, []);
    assert.equal(started, 0, 'B 没开跑');
    assert.equal(fake.inputs.length, inputsBefore, 'B 没有推给 CLI');
    // A 那一轮是用户回合(不是 CLI 自己那一轮):B 的停止不去打断它
    assert.equal(fake.interrupts, 0, 'A 那一轮没被这次停止打断');

    finish();
    assert.deepEqual(errorsOf(await first), []);
    assert.equal(runtime.claimedAt ?? null, null);
  });
});

describe('回合真正开跑之前被拒 / 回退本身失败', () => {
  test('runtimeForSend 之后、push 之前 CLI 自己那一轮开始跑工具:按「稍后再发」报中文,不进一次性回退,预占标记撤掉', async () => {
    const sessionId = nextSessionId();
    assert.deepEqual(errorsOf(await send(sessionId)), []);
    const runtime = getPersistentRuntime(sessionId);
    const fake = queryFor(sessionId);
    // 切模型的那 10 秒里,CLI 自己起了一轮并开始跑工具
    fake.setModelImpl = async () => {
      await startCliOwnTurnWithTool(fake, runtime, 'toolu_race');
    };
    const before = queries.length;
    const { frames, notices } = await sendWithNotice(sessionId, { model: 'sonnet' });
    assert.equal(queries.length, before, '没有一次性回退,也没有重建');
    assert.equal(fake.closed, false);
    const errors = errorsOf(frames);
    assert.equal(errors.length, 1, JSON.stringify(frames));
    assert.match(errors[0], /后台任务的回报/);
    assert.equal(completesOf(frames).at(-1)?.exitCode, 1);
    assert.equal(runtime.claimedAt ?? null, null, '没开跑的这一条不留预占标记');
    assert.equal(notices.length, 1, '告诉了调用方这一条没开跑');
    assert.equal(notices[0].code, 'CLI_TURN_BUSY');
    assert.equal(notices[0].errorsBefore, 0);
  });

  test('一次性回退自己失败(runtime 有后台任务,不能 resume)→ 给用户一条错误 + complete,不是静默', async () => {
    const sessionId = nextSessionId();
    assert.deepEqual(errorsOf(await send(sessionId)), []);
    const runtime = getPersistentRuntime(sessionId);
    const fake = queryFor(sessionId);
    fake.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'bg-2', task_type: 'local_bash', description: 'dev server' }] });
    await waitFor(() => runtime.liveBackgroundTasks?.size === 1, '后台任务登记');
    // 切模型期间输入流被关掉:push 抛一个不带标记的错 → 分发器走一次性回退 → 回退撞上 prismRuntimeBusy
    fake.setModelImpl = async () => { runtime.input.close(); };
    let frames;
    await assert.doesNotReject(async () => { frames = await send(sessionId, { model: 'sonnet' }); });
    const errors = errorsOf(frames);
    assert.equal(errors.length, 1, JSON.stringify(frames));
    assert.match(errors[0], /后台任务/);
    assert.equal(completesOf(frames).at(-1)?.exitCode, 1);
  });

  test('开跑前被停止:不跑这一轮,预占标记撤掉', async () => {
    const sessionId = nextSessionId();
    assert.deepEqual(errorsOf(await send(sessionId)), []);
    const runtime = getPersistentRuntime(sessionId);
    const fake = queryFor(sessionId);
    const inputsBefore = fake.inputs.length;
    fake.setModelImpl = async () => { await sdk.abortClaudeSDKRun(`app-${sessionId}`); };
    const frames = await send(sessionId, { model: 'sonnet' });
    assert.deepEqual(errorsOf(frames), []);
    assert.equal(fake.inputs.length, inputsBefore, '这一条没有推给 CLI');
    assert.equal(runtime.claimedAt ?? null, null);
  });
});

describe('CLI 自己发起的回合也入账', () => {
  const rowsFor = (appSessionId) => usageRecordsDb.list(500, 0).filter((row) => row.session_id === appSessionId);

  test('后台任务回报那一轮(没有用户回合):按 result 的用量记一条 source=background,记在 app 会话名下', async () => {
    const sessionId = nextSessionId();
    assert.deepEqual(errorsOf(await send(sessionId)), []);
    const runtime = getPersistentRuntime(sessionId);
    const fake = queryFor(sessionId);
    const appSessionId = `app-${sessionId}`;
    const before = rowsFor(appSessionId).length;

    fake.emit({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '<task-notification>完成</task-notification>' }] } });
    fake.emit({ type: 'assistant', message: { id: 'msg_bg_1', role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: '后台任务跑完了' }], usage: { input_tokens: 3, output_tokens: 1 } } });
    fake.emit({
      type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0.5,
      usage: { input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 9000, cache_creation_input_tokens: 10 },
    });
    await drain(fake);
    assert.equal(runtime.orphanTurnOpen, false);

    const rows = rowsFor(appSessionId);
    assert.equal(rows.length, before + 1, JSON.stringify(rows));
    const row = rows[0];
    assert.equal(row.source, 'background');
    assert.equal(row.input_tokens, 120);
    assert.equal(row.output_tokens, 40);
    assert.equal(row.cache_read_tokens, 9000);
    assert.equal(row.cache_creation_tokens, 10);
    assert.equal(row.model, 'claude-test');
  });

  test('CLI 自己那一轮的 result 在用户回合里到达(外来 result):那一轮照样记 background,用户回合另记 chat', async () => {
    const sessionId = nextSessionId();
    assert.deepEqual(errorsOf(await send(sessionId)), []);
    const runtime = getPersistentRuntime(sessionId);
    const fake = queryFor(sessionId);
    const appSessionId = `app-${sessionId}`;
    const before = rowsFor(appSessionId).length;
    // CLI 自己那一轮开着(还没出 result)
    fake.emit({ type: 'user', uuid: 'notif-1', message: { role: 'user', content: [{ type: 'text', text: '<task-notification>完成</task-notification>' }] } });
    fake.emit({ type: 'assistant', message: { id: 'msg_own_1', role: 'assistant', content: [{ type: 'text', text: '在看结果' }] } });
    await drain(fake);
    assert.equal(runtime.orphanTurnOpen, true);
    // 用户这时发了一条:CLI 先收掉自己那一轮(result 只带它自己的 uuid),再答用户
    fake.onInput = (message) => {
      fake.emit({ type: 'result', subtype: 'success', is_error: false, result: 'own', num_turns: 1, user_message_uuid: 'notif-1', total_cost_usd: 0.2, usage: { input_tokens: 50, output_tokens: 5 } });
      fake.emit({ type: 'assistant', message: { id: 'msg_user_1', role: 'assistant', content: [{ type: 'text', text: '答你' }] } });
      fake.emit({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, user_message_uuid: message.uuid, total_cost_usd: 0.3, usage: { input_tokens: 70, output_tokens: 7 } });
    };
    assert.deepEqual(errorsOf(await send(sessionId)), []);
    const rows = rowsFor(appSessionId).slice(0, rowsFor(appSessionId).length - before);
    assert.deepEqual(rows.map((row) => [row.source, row.input_tokens]).sort(), [['background', 50], ['chat', 70]]);
  });

  test('多个后台任务完成时的空 result(没有任何 token)不单记一行', async () => {
    const sessionId = nextSessionId();
    assert.deepEqual(errorsOf(await send(sessionId)), []);
    const runtime = getPersistentRuntime(sessionId);
    const fake = queryFor(sessionId);
    const appSessionId = `app-${sessionId}`;
    const before = rowsFor(appSessionId).length;
    fake.emit({ type: 'result', subtype: 'success', is_error: false, result: '', num_turns: 0, total_cost_usd: 0.01 });
    await drain(fake);
    assert.equal(runtime.orphanTurnOpen, false);
    assert.equal(rowsFor(appSessionId).length, before);
  });
});

describe('回合间隙按停止不碰整个 CLI', () => {
  test('/loop 两轮之间跑验证命令时按停止:只停验证命令,常驻 CLI(连同后台任务)不动', async () => {
    const sessionId = nextSessionId();
    assert.deepEqual(errorsOf(await send(sessionId)), []);
    const runtime = getPersistentRuntime(sessionId);
    const fake = queryFor(sessionId);
    const ws = writer();
    const baseSend = ws.send;
    let stopRequested = null;
    ws.send = (frame) => {
      baseSend(frame);
      if (!stopRequested && frame?.kind === 'status' && /运行验证/.test(String(frame.text))) {
        stopRequested = new Promise((resolve) => setTimeout(() => resolve(sdk.abortClaudeSDKRun(`app-${sessionId}`)), 150));
      }
    };
    const started = Date.now();
    await queryClaudeSDK('/loop 修好它 --rounds 2 --test "sleep 20"', {
      cwd, projectPath: cwd, runId: `app-${sessionId}`, permissionMode: 'default', sessionId,
    }, ws);
    assert.equal(await stopRequested, true);
    assert.ok(Date.now() - started < 10_000, '验证命令被停下了,没有跑满');
    assert.equal(runtime.abortController.signal.aborted, false, '常驻 CLI 的中止手柄没被碰');
    assert.equal(fake.aborted, false);
    assert.equal(runtime.disposed, false);
    assert.equal(getPersistentRuntime(sessionId), runtime);
  });

  test('回合已出 result、complete 还没发时按停止:不杀 CLI,下一条照常发出(不被残留的中止标记吞掉)', async () => {
    const sessionId = nextSessionId();
    assert.deepEqual(errorsOf(await send(sessionId)), []);
    const runtime = getPersistentRuntime(sessionId);
    const fake = queryFor(sessionId);
    let stopped = false;
    // 回合结束后读用量的那几秒里按停止
    fake.getContextUsageImpl = async () => {
      if (!stopped && !runtime.turn) {
        stopped = true;
        await sdk.abortClaudeSDKRun(`app-${sessionId}`);
      }
      return null;
    };
    await send(sessionId);
    assert.equal(stopped, true);
    assert.equal(runtime.abortController.signal.aborted, false);
    assert.equal(runtime.disposed, false);
    fake.getContextUsageImpl = null;
    const inputsBefore = fake.inputs.length;
    assert.deepEqual(errorsOf(await send(sessionId)), []);
    assert.equal(fake.inputs.length, inputsBefore + 1, '下一条推给了 CLI');
  });
});

describe('/loop', () => {
  test('第 1 轮推进 CLI 时告诉调用方已开跑(恰好一次;之后按停止,chat 层不会把这一行标成撤回)', async () => {
    const sessionId = nextSessionId();
    assert.deepEqual(errorsOf(await send(sessionId)), []);
    const fake = queryFor(sessionId);
    const inputsBefore = fake.inputs.length;
    // 没有验证命令:只跑 1 轮
    const { frames, started, notices } = await sendWithNotice(sessionId, {}, '/loop 修好它');
    assert.equal(fake.inputs.length, inputsBefore + 1, '第 1 轮推给了 CLI');
    assert.equal(started, 1);
    assert.deepEqual(notices, []);
    assert.deepEqual(errorsOf(frames), []);
    assert.equal(completesOf(frames).at(-1)?.exitCode, 0);
  });

  test('启动阶段(等 runtime、切模型)按了停止:第 1 轮不开跑', async () => {
    const sessionId = nextSessionId();
    assert.deepEqual(errorsOf(await send(sessionId)), []);
    const runtime = getPersistentRuntime(sessionId);
    const fake = queryFor(sessionId);
    const inputsBefore = fake.inputs.length;
    fake.setModelImpl = async () => { await sdk.abortClaudeSDKRun(`app-${sessionId}`); };
    const frames = await send(sessionId, { model: 'sonnet' }, '/loop 修好它');
    assert.equal(fake.inputs.length, inputsBefore, '第 1 轮没有推给 CLI');
    assert.deepEqual(errorsOf(frames), []);
    // 中止处理器负责 complete,这里不再补一条
    assert.equal(completesOf(frames).length, 0, JSON.stringify(frames));
    assert.equal(runtime.claimedAt ?? null, null);
    assert.equal(runtime.disposed, false, '没开跑就停,不必动进程');
  });

  test('还没有 runtime 时按了停止(新会话第一条就是 /loop):按停止收尾,不报「Agent Loop 失败」', async () => {
    const runId = `app-${nextSessionId()}`;
    const before = queries.length;
    const ws = writer();
    const notices = [];
    let started = 0;
    const sending = queryClaudeSDK('/loop 修好它', {
      cwd, projectPath: cwd, runId, permissionMode: 'default',
      onTurnStarted: () => { started += 1; },
      onTurnNotStarted: (notice) => notices.push(notice),
    }, ws);
    // 停止落在 runtimeForSend 之前(检查点、解析模型那几段 await),这时这段对话还没有 runtime
    assert.equal(await sdk.abortClaudeSDKRun(runId), true);
    await sending;
    assert.deepEqual(errorsOf(ws.frames), [], '已经按了停止,不再报错');
    // 中止处理器负责 complete,这里不再补一条
    assert.equal(completesOf(ws.frames).length, 0, JSON.stringify(ws.frames));
    assert.equal(started, 0, '第 1 轮没开跑');
    assert.deepEqual(notices, []);
    assert.equal(ws.frames.some((frame) => frame?.kind === 'status' && /^Loop 1\//.test(String(frame.text))), false);
    assert.ok(queries.slice(before).every((fake) => fake.inputs.length === 0), '没有推给任何 CLI');
  });

  test('某一轮没跑起来(runPersistentTurn 抛错)且没有验证命令:收尾码是 1,不报成功', async () => {
    const sessionId = nextSessionId();
    assert.deepEqual(errorsOf(await send(sessionId)), []);
    const runtime = getPersistentRuntime(sessionId);
    const fake = queryFor(sessionId);
    // 切模型期间 CLI 自己那一轮开始跑工具 → 第 1 轮的 runPersistentTurn 被拒
    fake.setModelImpl = async () => { await startCliOwnTurnWithTool(fake, runtime, 'toolu_loop_race'); };
    const { frames, notices } = await sendWithNotice(sessionId, { model: 'sonnet' }, '/loop 修好它');
    const completes = completesOf(frames);
    assert.equal(completes.length, 1, JSON.stringify(frames));
    assert.equal(completes[0].exitCode, 1, '执行失败不能报成功');
    const notes = frames.filter((frame) => frame?.kind === 'text').map((frame) => String(frame.content));
    assert.ok(notes.some((note) => /第 1 轮执行失败/.test(note) && /后台任务的回报/.test(note)), JSON.stringify(notes));
    assert.equal(runtime.claimedAt ?? null, null, '一轮都没开跑:预占标记撤掉');
    assert.equal(notices.length, 1, '第 1 轮没开跑:告诉了调用方');
    assert.equal(notices[0].code, 'CLI_TURN_BUSY');
    assert.equal(notices[0].completesBefore, 0);
  });
});

describe('CLI 进程自己退出', () => {
  test('两轮之间进程退出:与 dispose 同样善后 —— 通知组合根(观测回合收尾)、清掉待批审批;只做一次', async () => {
    const seen = [];
    sdk.setRuntimeDisposedHook((appSessionId) => seen.push(appSessionId));
    try {
      const sessionId = nextSessionId();
      assert.deepEqual(errorsOf(await send(sessionId)), []);
      const runtime = getPersistentRuntime(sessionId);
      const fake = queryFor(sessionId);
      const appSessionId = `app-${sessionId}`;
      // 一张还没人答的待批卡(比如 CLI 自己那一轮的主线程审批)
      const pending = sdk.waitForToolApproval('req-self-exit-1', {
        timeoutMs: 0,
        metadata: { _appSessionId: appSessionId, _sessionId: sessionId, _toolName: 'Bash', _input: {} },
      });
      assert.equal(sdk.getPendingApprovalsForSession(appSessionId).length, 1);

      fake.end(); // 进程自己退出(崩溃 / OOM)
      await waitFor(() => runtime.disposed, 'runtime 收尾');
      assert.deepEqual(seen, [appSessionId], '通知了组合根');
      assert.deepEqual(await pending, { cancelled: true }, '待批卡被撤掉');
      assert.equal(sdk.getPendingApprovalsForSession(appSessionId).length, 0);
      assert.equal(getPersistentRuntime(sessionId), null);

      await disposeAllRuntimes();
      assert.deepEqual(seen, [appSessionId], '不重复善后');
    } finally {
      sdk.setRuntimeDisposedHook(null);
    }
  });
});

describe('迟到的 tool_result', () => {
  test('回合收掉之后那条工具才跑完:runtime 重新算闲,终端接管 / 一次性调用不再被一直拒', async () => {
    const sessionId = nextSessionId();
    assert.deepEqual(errorsOf(await send(sessionId)), []);
    const runtime = getPersistentRuntime(sessionId);
    const fake = queryFor(sessionId);
    // 回合带着在途工具被收掉之后的样子:没有回合,工具还挂着
    runtime.pendingToolUses.add('toolu_late_1');
    fake.emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_late_1', content: 'done' }] } });
    await drain(fake);
    assert.equal(runtime.pendingToolUses.size, 0);
    assert.equal(runtime.orphanTurnOpen, false, '没有开出一轮永远等不到 result 的「CLI 自己那一轮」');
    assert.equal(sdk.runtimeIsIdle(runtime), true);
    const released = await sdk.releaseClaudeSession(sessionId);
    assert.deepEqual(released, { released: true, reason: 'disposed' });
  });
});

describe('「允许并记住」', () => {
  /** 在没有用户回合时触发一次审批(后台审批那条路),答复由 decide 给出;返回审批结果。 */
  async function approveOnce(fake, toolName, input, decision, requests = []) {
    sdk.setBackgroundApprovalWriterFactory(() => ({
      send: (frame) => { if (frame?.kind === 'permission_request') requests.push(frame); },
    }));
    try {
      const pending = fake.options.canUseTool(toolName, input, { signal: new AbortController().signal, agentID: 'agent-1' });
      await waitFor(() => requests.length === 1, '审批请求发出');
      sdk.resolveToolApproval(requests[0].requestId, decision);
      return await pending;
    } finally {
      sdk.setBackgroundApprovalWriterFactory(null);
    }
  }

  test('客户端给的条目与这次请求的工具对不上:只放行这一次,不进 runtime 的放行清单', async () => {
    const sessionId = nextSessionId();
    assert.deepEqual(errorsOf(await send(sessionId)), []);
    const runtime = getPersistentRuntime(sessionId);
    const fake = queryFor(sessionId);
    const outcome = await approveOnce(fake, 'Bash', { command: 'npm test' }, { allow: true, rememberEntry: 'Bash' });
    assert.equal(outcome.behavior, 'allow');
    assert.equal(runtime.settings.allowedTools.includes('Bash'), false);
    // 对得上的那一条照常记下
    const again = await approveOnce(fake, 'Bash', { command: 'npm test' }, { allow: true, rememberEntry: 'Bash(npm:*)' });
    assert.equal(again.behavior, 'allow');
    assert.equal(runtime.settings.allowedTools.includes('Bash(npm:*)'), true);
  });

  /** 发起一次后台审批先不答:返回发出的那一帧、补发列表里对应的那一条,以及答复函数。 */
  async function requestPending(fake, appSessionId, toolName, input) {
    const requests = [];
    sdk.setBackgroundApprovalWriterFactory(() => ({
      send: (frame) => { if (frame?.kind === 'permission_request') requests.push(frame); },
    }));
    const pending = fake.options.canUseTool(toolName, input, { signal: new AbortController().signal, agentID: 'agent-1' });
    await waitFor(() => requests.length === 1, '审批请求发出');
    const replayed = sdk.getPendingApprovalsForSession(appSessionId).find((entry) => entry.requestId === requests[0].requestId);
    const answer = async (decision) => {
      sdk.resolveToolApproval(requests[0].requestId, decision);
      try {
        return await pending;
      } finally {
        sdk.setBackgroundApprovalWriterFactory(null);
      }
    };
    return { request: requests[0], replayed, answer };
  }

  test('不在免确认名单里的人:刷新后补发的审批卡同样不出「允许并记住」,也照样标着后台任务请求', async () => {
    const previous = process.env.PRISM_ALLOW_BYPASS_USERS;
    process.env.PRISM_ALLOW_BYPASS_USERS = 'someone-else';
    try {
      const sessionId = nextSessionId();
      assert.deepEqual(errorsOf(await send(sessionId)), []);
      const { request, replayed, answer } = await requestPending(queryFor(sessionId), `app-${sessionId}`, 'Read', { file_path: '/x' });
      assert.equal(request.suppressAlwaysAllow, true);
      assert.ok(replayed, '在补发列表里');
      assert.equal(replayed.suppressAlwaysAllow, true, '补发的卡片与实时那一帧一致');
      assert.equal(replayed.background, true);
      assert.equal((await answer({ allow: false })).behavior, 'deny');
    } finally {
      if (previous === undefined) delete process.env.PRISM_ALLOW_BYPASS_USERS;
      else process.env.PRISM_ALLOW_BYPASS_USERS = previous;
    }
  });

  test('记得下放行项的人:补发的卡片不带 suppressAlwaysAllow', async () => {
    const sessionId = nextSessionId();
    assert.deepEqual(errorsOf(await send(sessionId)), []);
    const { request, replayed, answer } = await requestPending(queryFor(sessionId), `app-${sessionId}`, 'Read', { file_path: '/y' });
    assert.equal('suppressAlwaysAllow' in request, false);
    assert.equal('suppressAlwaysAllow' in replayed, false);
    assert.equal(replayed.background, true);
    assert.equal((await answer({ allow: false })).behavior, 'deny');
  });

  test('发这一轮的人不在免确认名单里:审批卡不出「允许并记住」,答复里带了也只放行这一次', async () => {
    const previous = process.env.PRISM_ALLOW_BYPASS_USERS;
    process.env.PRISM_ALLOW_BYPASS_USERS = 'someone-else';
    try {
      const sessionId = nextSessionId();
      assert.deepEqual(errorsOf(await send(sessionId)), []);
      const runtime = getPersistentRuntime(sessionId);
      const fake = queryFor(sessionId);
      const requests = [];
      const outcome = await approveOnce(fake, 'Read', { file_path: '/x' }, { allow: true, rememberEntry: 'Read' }, requests);
      assert.equal(outcome.behavior, 'allow');
      assert.equal(requests[0].suppressAlwaysAllow, true);
      assert.equal(runtime.settings.allowedTools.includes('Read'), false);
    } finally {
      if (previous === undefined) delete process.env.PRISM_ALLOW_BYPASS_USERS;
      else process.env.PRISM_ALLOW_BYPASS_USERS = previous;
    }
  });
});
