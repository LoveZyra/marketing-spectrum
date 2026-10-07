import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, test, vi } from 'vitest';

/**
 * 一次性路径 `queryClaudeSDK({ oneShot: true })` 必须把成败返回给调用方:定时任务与外部 Agent API
 * 拿的是 promise,不是 writer 上的帧。返回 `undefined` 时调用方只能一律记成 completed。
 *
 * SDK 的 `query` 用 vi.mock 换成假的,不起子进程、不花钱。
 */

let scripted = () => { throw new Error('unscripted'); };

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args) => scripted(...args),
}));

/**
 * 读图那一步(buildClaudeUserContent)可以挂起:测试给 `imageReadGate` 一个 promise 时,读图停在它上面,
 * 放开后直接返回一段文字内容(不真去读盘)。不设时照原样。
 */
let imageReadGate = null;
let imageReadsStarted = 0;
vi.mock('../shared/image-attachments.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    buildClaudeUserContent: async (command, ...rest) => {
      if (!imageReadGate) return actual.buildClaudeUserContent(command, ...rest);
      imageReadsStarted += 1;
      await imageReadGate;
      return [{ type: 'text', text: command }];
    },
  };
});

const { queryClaudeSDK, describeOneShotResultError, abortClaudeSDKRun } = await import('../claude-sdk.js');

/*
 * 每一轮都要解析网关与 key(resolveTurnGateway 读 gateway_user_keys)。不指定库就会落到仓库里那份
 * 没跑过迁移的 auth.db 上(no such table),回合直接失败,所以给一份迁移过的临时库。
 */
const { closeConnection, initializeDatabase } = await import('@/modules/database/index.js');
const previousDatabasePath = process.env.DATABASE_PATH;
const dbDir = mkdtempSync(path.join(tmpdir(), 'hl-oneshot-db-'));
closeConnection();
process.env.DATABASE_PATH = path.join(dbDir, 'auth.db');
await initializeDatabase();
afterAll(() => {
  closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  rmSync(dbDir, { recursive: true, force: true });
});

const cwd = mkdtemptSafe();
function mkdtemptSafe() {
  return mkdtempSync(path.join(tmpdir(), 'hl-oneshot-'));
}

function fakeWriter() {
  const frames = [];
  return {
    frames,
    userId: 1,
    send: (frame) => { frames.push(frame); },
    setSessionId: () => {},
  };
}

/** 模拟 SDK 的 async iterable。 */
function stream(messages) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const m of messages) yield m;
    },
    interrupt: async () => {},
    close: () => {},
  };
}

const baseOptions = () => ({
  cwd,
  projectPath: cwd,
  newSessionId: '11111111-2222-4333-8444-555555555555',
  runId: 'run-hl-oneshot',
  permissionMode: 'default',
  oneShot: true,
  usageSource: 'task',
});

describe('describeOneShotResultError', () => {
  test('success 帧 → null;is_error / 非 success subtype → 原因', () => {
    assert.equal(describeOneShotResultError({ type: 'result', subtype: 'success', is_error: false }), null);
    assert.equal(describeOneShotResultError({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 400 model not found' }), 'API Error: 400 model not found');
    assert.equal(describeOneShotResultError({ type: 'result', subtype: 'error_max_turns' }), 'error_max_turns');
    assert.equal(describeOneShotResultError({ type: 'result', subtype: 'error_during_execution', errors: ['a', 'b'] }), 'a; b');
  });
});

describe('queryClaudeSDK 一次性路径的返回值', () => {
  test('result 帧 is_error → { ok:false, exitCode:1, error }', async () => {
    scripted = () => stream([
      { type: 'system', subtype: 'init', session_id: '11111111-2222-4333-8444-555555555555' },
      { type: 'result', subtype: 'success', is_error: true, result: 'API Error: 400 no such model', session_id: '11111111-2222-4333-8444-555555555555' },
    ]);
    const ws = fakeWriter();
    const outcome = await queryClaudeSDK('hi', baseOptions(), ws);
    assert.ok(outcome, 'baseline 这里是 undefined');
    assert.equal(outcome.ok, false);
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.aborted, false);
    assert.match(outcome.error, /no such model/);
    const complete = ws.frames.find((f) => f?.kind === 'complete' || f?.type === 'complete');
    assert.ok(complete, '终止帧照发');
  });

  test('SDK / CLI 抛错 → { ok:false, error } 且不 reject', async () => {
    scripted = () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: '11111111-2222-4333-8444-555555555555' };
        throw new Error('Claude Code process exited with code 1');
      },
      interrupt: async () => {},
      close: () => {},
    });
    const ws = fakeWriter();
    const outcome = await queryClaudeSDK('hi', baseOptions(), ws);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.exitCode, 1);
    assert.match(outcome.error, /exited with code 1/);
    assert.ok(ws.frames.some((f) => f?.kind === 'error'), 'writer 上的 error 帧仍然要有');
  });

  test('正常 result → { ok:true, exitCode:0 }', async () => {
    scripted = () => stream([
      { type: 'system', subtype: 'init', session_id: '11111111-2222-4333-8444-555555555555' },
      { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: '11111111-2222-4333-8444-555555555555' },
    ]);
    const outcome = await queryClaudeSDK('hi', baseOptions(), fakeWriter());
    assert.equal(outcome.ok, true);
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.error, null);
  });
});

/**
 * 一次性路径同样要告诉调用方「这一条开跑了」(chat 层据此判断停止时那一行要不要标撤回):
 * 起 query 的那一刻调 onTurnStarted;起 query 之前就被停止的,不调,也不起子进程。
 */
describe('一次性路径的「已开跑」钩子', () => {
  test('起了 query 就调一次 onTurnStarted', async () => {
    let queried = 0;
    scripted = () => {
      queried += 1;
      return stream([
        { type: 'system', subtype: 'init', session_id: '11111111-2222-4333-8444-555555555555' },
        { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: '11111111-2222-4333-8444-555555555555' },
      ]);
    };
    let started = 0;
    const outcome = await queryClaudeSDK('hi', { ...baseOptions(), onTurnStarted: () => { started += 1; } }, fakeWriter());
    assert.equal(outcome.ok, true);
    assert.equal(queried, 1);
    assert.equal(started, 1);
  });

  test('起 query 之前就被停止:不起子进程,也不调 onTurnStarted', async () => {
    let queried = 0;
    scripted = () => {
      queried += 1;
      return stream([]);
    };
    let started = 0;
    const options = { ...baseOptions(), runId: 'run-hl-oneshot-stopped', onTurnStarted: () => { started += 1; } };
    const running = queryClaudeSDK('hi', options, fakeWriter());
    // 同步登记了 runId;准备那几段 await 还没走完,这时按停止
    assert.equal(await abortClaudeSDKRun(options.runId), true);
    const outcome = await running;
    assert.equal(outcome.aborted, true);
    assert.equal(queried, 0, '没起子进程');
    assert.equal(started, 0);
  });
});

describe('一次性路径:读图那段 await 里按的停止', () => {
  test('带图的发送,停止落在读盘期间:不起子进程,也不调 onTurnStarted', async () => {
    let queried = 0;
    scripted = () => {
      queried += 1;
      return stream([]);
    };
    let releaseRead = () => {};
    imageReadGate = new Promise((resolve) => { releaseRead = resolve; });
    imageReadsStarted = 0;
    let started = 0;
    const options = {
      ...baseOptions(),
      runId: 'run-hl-oneshot-image-stop',
      images: ['/tmp/prism-oneshot-shot.png'],
      onTurnStarted: () => { started += 1; },
    };
    try {
      const running = queryClaudeSDK('看看这张图', options, fakeWriter());
      const startedAt = Date.now();
      while (imageReadsStarted === 0) {
        if (Date.now() - startedAt > 2000) throw new Error('timed out waiting for the image read');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      // 读盘挂着的时候按停止,然后放开读盘
      assert.equal(await abortClaudeSDKRun(options.runId), true);
      releaseRead();
      const outcome = await running;
      assert.equal(outcome.aborted, true);
      assert.equal(queried, 0, '读盘之后看到停止标记,不起子进程');
      assert.equal(started, 0);
    } finally {
      imageReadGate = null;
      releaseRead();
    }
  });
});
