import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, describe, test, vi } from 'vitest';

/**
 * 刷新 / 重连后补发的审批卡(`chat_subscribed.pendingPermissions`)要与实时那一帧长得一样。
 *
 * 配了 PRISM_ALLOW_BYPASS_USERS 时,名单外的人点「允许并记住」只会放行一次,所以实时帧带
 * `suppressAlwaysAllow` 让前端不出那个按钮;补发的那张也得带,否则刷新之后按钮又回来了。
 * 这里走一次性路径(外部 API、定时任务、回退都用它),SDK 的 `query` 换成按脚本吐帧的假的。
 */

let scripted = () => { throw new Error('unscripted'); };

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args) => scripted(...args),
}));

const { queryClaudeSDK, getPendingApprovalsForSession, resolveToolApproval } = await import('../claude-sdk.js');

// 每一轮都要解析网关与 key(读库),给一份迁移过的临时库
const { closeConnection, initializeDatabase } = await import('@/modules/database/index.js');
const previousDatabasePath = process.env.DATABASE_PATH;
const previousAllowlist = process.env.PRISM_ALLOW_BYPASS_USERS;
const dbDir = mkdtempSync(path.join(tmpdir(), 'approval-replay-db-'));
const cwd = mkdtempSync(path.join(tmpdir(), 'approval-replay-'));
closeConnection();
process.env.DATABASE_PATH = path.join(dbDir, 'auth.db');
await initializeDatabase();

afterEach(() => {
  if (previousAllowlist === undefined) delete process.env.PRISM_ALLOW_BYPASS_USERS;
  else process.env.PRISM_ALLOW_BYPASS_USERS = previousAllowlist;
});

afterAll(() => {
  closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  rmSync(dbDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

const SESSION_ID = '11111111-2222-4333-8444-666666666666';

async function waitFor(predicate, label, timeoutMs = 2000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * 跑一次一次性回合,回合中途要一次 Bash 审批;趁它挂着时记下实时帧与补发列表里的那一条,再拒掉。
 * 返回 { live, replayed }。
 */
async function captureApproval(actorUsername) {
  const frames = [];
  const ws = { frames, userId: 1, send: (frame) => { frames.push(frame); }, setSessionId: () => {} };
  const runId = `app-replay-${actorUsername}`;
  let captured = null;
  scripted = ({ options }) => ({
    async *[Symbol.asyncIterator]() {
      yield { type: 'system', subtype: 'init', session_id: SESSION_ID };
      const pending = options.canUseTool('Bash', { command: 'npm test' }, { signal: new AbortController().signal });
      await waitFor(() => frames.some((frame) => frame?.kind === 'permission_request'), '审批请求发出');
      const live = frames.find((frame) => frame?.kind === 'permission_request');
      const replayed = getPendingApprovalsForSession(runId).find((entry) => entry.requestId === live.requestId);
      captured = { live, replayed };
      resolveToolApproval(live.requestId, { allow: false });
      await pending;
      yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: SESSION_ID };
    },
    interrupt: async () => {},
    close: () => {},
  });
  await queryClaudeSDK('hi', {
    cwd, projectPath: cwd, runId, permissionMode: 'default', oneShot: true, actorUsername,
  }, ws);
  assert.ok(captured, '回合中途要过一次审批');
  return captured;
}

describe('一次性路径:补发的审批卡带着实时帧上的 suppressAlwaysAllow', () => {
  test('名单外的人:实时帧与补发都带', async () => {
    process.env.PRISM_ALLOW_BYPASS_USERS = 'insider';
    const { live, replayed } = await captureApproval('outsider');
    assert.equal(live.suppressAlwaysAllow, true);
    assert.ok(replayed, '在补发列表里');
    assert.equal(replayed.suppressAlwaysAllow, true);
  });

  test('名单里的人:两边都不带', async () => {
    process.env.PRISM_ALLOW_BYPASS_USERS = 'insider';
    const { live, replayed } = await captureApproval('insider');
    assert.equal('suppressAlwaysAllow' in live, false);
    assert.ok(replayed);
    assert.equal('suppressAlwaysAllow' in replayed, false);
  });
});
