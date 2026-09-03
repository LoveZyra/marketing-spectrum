import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test, vi } from 'vitest';


import { closeConnection, initializeDatabase, sessionMessagesDb, sessionsDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { seedDisplayLogFromTranscript } from '@/modules/providers/services/display-log-seed.service.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'display-log-seed-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    vi.restoreAllMocks();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const transcript = (ids: string[]) => ids.map((id, index) => ({
  id,
  sessionId: 'provider-native',
  kind: 'text',
  role: index % 2 === 0 ? 'user' : 'assistant',
  content: `第 ${index + 1} 条`,
  timestamp: `2026-08-20T10:0${index}:00.000Z`,
  provider: 'claude',
}));

function stubTranscript(messages: unknown[]) {
  const fetchHistory = vi.fn(async () => ({
    messages, total: messages.length, hasMore: false, offset: 0, limit: null,
  }));
  vi.spyOn(providerRegistry, 'resolveProvider').mockReturnValue(
    { sessions: { fetchHistory } } as never,
  );
  return fetchHistory;
}

test('老会话第一次再开口:整段历史抄进日志,顺序不变', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('s-old', 'claude', '/workspace/demo');
    const fetchHistory = stubTranscript(transcript(['a', 'b', 'c']));

    assert.deepEqual(await seedDisplayLogFromTranscript('s-old'), { status: 'ready', seeded: 3 });
    expect(fetchHistory).toHaveBeenCalledTimes(1);
    assert.deepEqual(
      sessionMessagesDb.listForSession('s-old').map((m) => m.content),
      ['第 1 条', '第 2 条', '第 3 条'],
    );
  });
});

test('抄过一次就不再读 transcript —— 之后这个会话永久归日志管', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('s-twice', 'claude', '/workspace/demo');
    const fetchHistory = stubTranscript(transcript(['a', 'b']));

    assert.deepEqual(await seedDisplayLogFromTranscript('s-twice'), { status: 'ready', seeded: 2 });
    assert.deepEqual(await seedDisplayLogFromTranscript('s-twice'), { status: 'ready', seeded: 0 });
    expect(fetchHistory).toHaveBeenCalledTimes(1);
    assert.equal(sessionMessagesDb.countForSession('s-twice'), 2);
  });
});

test('还没有 transcript 的新会话不抄 —— 它从第一条消息起天然就是日志', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('s-fresh', 'claude', '/workspace/demo');
    const fetchHistory = stubTranscript(transcript(['a']));

    assert.deepEqual(await seedDisplayLogFromTranscript('s-fresh'), { status: 'ready', seeded: 0 });
    expect(fetchHistory).not.toHaveBeenCalled();
  });
});

test('transcript 读不动也不能挡住发送', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('s-broken', 'claude', '/workspace/demo');
    vi.spyOn(providerRegistry, 'resolveProvider').mockReturnValue(
      { sessions: { fetchHistory: async () => { throw new Error('transcript 损坏'); } } } as never,
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    // du:读不动现在报 failed —— 调用方据此**跳过本轮落库**,日志维持空、
    // 会话继续走 transcript,历史不会因为多写了一行而整段消失。
    assert.deepEqual(await seedDisplayLogFromTranscript('s-broken'), { status: 'failed' });
    assert.equal(sessionMessagesDb.countForSession('s-broken'), 0);
  });
});

test('du:有历史但一条都没抄进去 → failed(不敢把空日志当权威)', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('s-empty-seed', 'claude', '/workspace/demo');
    sessionsDb.assignProviderSessionId('s-empty-seed', 'prov-empty-seed');
    // transcript 有内容,但全是不落库的 kind(白名单之外)→ appendMany 落 0 条。
    stubTranscript([
      { id: 'x1', kind: 'status', provider: 'claude', timestamp: '2026-08-20T10:00:00.000Z' },
      { id: 'x2', kind: 'complete', provider: 'claude', timestamp: '2026-08-20T10:01:00.000Z' },
    ]);
    assert.deepEqual(await seedDisplayLogFromTranscript('s-empty-seed'), { status: 'failed' });
    assert.equal(sessionMessagesDb.countForSession('s-empty-seed'), 0);
  });
});
