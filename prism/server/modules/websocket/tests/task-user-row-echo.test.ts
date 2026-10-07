import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, test } from 'vitest';

import {
  closeConnection,
  initializeDatabase,
  projectsDb,
  scheduledTasksDb,
  sessionMessagesDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { runTaskNow, startTaskScheduler, stopTaskScheduler } from '@/modules/tasks/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';

/**
 * 定时任务写进显示日志的指令行,同时作为这一轮的实时帧推给正在看这段会话的人。
 *
 * 钉的是行为:订阅者第一帧编号的帧就是这条用户行(带 seq / runId,origin 为 scheduled),显示日志里用户行只有一行。
 * 有人把 `broadcastWithoutPersist` 挪到 `startRun` 之前(那时没有在跑的回合,什么都不发),这里会红。
 */

type Frame = Record<string, unknown>;

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

class FakeSocket {
  readyState = 1;
  sent: Frame[] = [];
  private handlers = new Map<string, (raw: unknown) => unknown>();
  send(payload: string): void { this.sent.push(JSON.parse(payload) as Frame); }
  on(event: string, handler: (raw: unknown) => unknown): void { this.handlers.set(event, handler); }
  async emit(event: string, raw: unknown): Promise<void> { await this.handlers.get(event)?.(raw); }
}

const chatDeps = {
  spawnFns: { claude: async () => {} },
  abortFns: { claude: () => true },
  getToolApprovalSessionId: () => null,
  resolveToolApproval: () => {},
  getPendingApprovalsForSession: () => [],
};

async function withEnv(runTest: (tempDirectory: string) => Promise<void>): Promise<void> {
  const keys = ['DATABASE_PATH', 'WORKSPACES_ROOT', 'PRISM_APPROVAL_REQUIRED'] as const;
  const prev = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'task-user-row-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  process.env.WORKSPACES_ROOT = tempDirectory;
  process.env.PRISM_APPROVAL_REQUIRED = '0';
  await initializeDatabase();
  // 假的回合:往这一轮的 writer 吐一句回答,再收尾
  startTaskScheduler(async (command, options, writer) => {
    const sessionId = (options as { newSessionId?: string; sessionId?: string }).newSessionId ?? null;
    writer.send({ kind: 'text', role: 'assistant', provider: 'claude', sessionId, content: `回答:${command}` });
    writer.send({ kind: 'complete', provider: 'claude', sessionId, exitCode: 0 });
    return { ok: true, exitCode: 0, aborted: false, error: null, sessionId };
  });
  try {
    await runTest(tempDirectory);
  } finally {
    stopTaskScheduler();
    chatRunRegistry.clearAll();
    closeConnection();
    for (const key of keys) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

describe('定时任务的用户行实时帧', () => {
  test('订阅者先收到任务的指令行(origin=scheduled),之后才是这一轮的输出;显示日志里只有一行', async () => {
    await withEnv(async (tempDirectory) => {
      const owner = { id: Number(userDb.createUser('tasker', 'hash', 'approved').id), username: 'tasker' };
      const projectPath = path.join(tempDirectory, 'proj');
      await mkdir(projectPath, { recursive: true });
      projectsDb.createProjectPath(projectPath, null, owner.id);
      const sessionId = '0b0b0b0b-0000-4000-8000-000000000001';
      sessionsDb.createAppSession(sessionId, 'claude', projectPath, owner.id);
      scheduledTasksDb.insert({
        id: 't-echo',
        name: '回归',
        instructions: '跑一遍回归',
        project_path: projectPath,
        session_mode: 'fixed',
        fixed_session_id: sessionId,
        frequency: 'manual',
        run_at_hour: null, run_at_minute: null, run_at_weekday: null, run_at_day: null,
        model: null, permission_mode: 'bypassPermissions',
        enabled: 1, owner_user_id: owner.id,
        next_run_at: null,
      });

      const ws = new FakeSocket();
      handleChatConnection(ws as never, { user: owner } as never, chatDeps as never);
      await ws.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId, lastSeq: 0 }] }));

      assert.deepEqual(runTaskNow('t-echo'), { ok: true });
      await waitFor(() => scheduledTasksDb.getById('t-echo')?.last_run_status === 'completed', '任务跑完');

      const frames = ws.sent
        .filter((frame) => frame.sessionId === sessionId && typeof frame.seq === 'number')
        .sort((a, b) => Number(a.seq) - Number(b.seq));
      const [first] = frames;
      assert.ok(first, JSON.stringify(ws.sent));
      assert.equal(first.kind, 'text');
      assert.equal(first.role, 'user', '这一轮的第一帧就是任务的指令行');
      assert.equal(first.content, '跑一遍回归');
      assert.equal(first.origin, 'scheduled');
      assert.equal(first.senderUserId, owner.id);
      assert.equal(first.seq, 1);
      assert.equal(typeof first.runId, 'string');
      assert.equal(frames.filter((frame) => frame.role === 'user').length, 1, '用户帧只推一次');
      const answer = frames.find((frame) => frame.role === 'assistant');
      assert.ok(answer && Number(answer.seq) > Number(first.seq));
      assert.equal(answer?.runId, first.runId);

      const logged = sessionMessagesDb.listForSession(sessionId).filter((row) => row.kind === 'text' && row.role === 'user');
      assert.equal(logged.length, 1, '显示日志里用户行只有一行');
      assert.equal(logged[0].id, first.id, '实时帧就是落库的那一行');
    });
  });
});
