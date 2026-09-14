import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { claimForShell, releaseShellClaim } from '@/modules/websocket/services/conversation-ownership.service.js';
import { connectedClients } from '@/shared/websocket-state.js';

/**
 * ga:**`startRun` 返回 null 有两种原因,调用方必须分得清。**
 *
 * fz 在 `startRun` 里加了"终端接管着就不许开跑"(在此之前定时任务和外部 API
 * 会在终端接管期间照样起一个 CLI resume 同一份 transcript)。可三个非网页调用点
 * 的文案还是老那一种:定时任务抛 `目标会话正有回合在跑,本次跳过`、外部 API 回
 * `already has a run in progress`。于是**一个开着的终端会让定时任务在 15 分钟里
 * 连发三条内容错误的失败告警**(5 分钟一次、共 3 次),而真正该做的事是去把那个
 * 终端关掉 —— 告警里一个字都没提。
 *
 * 打印室门上两种情况都让你进不去(里面有人在印 / 维修师傅反锁了),自动播报
 * 却只会说"里面有人正在印,请稍后"。
 *
 * 这条测试跑的是**真实链路**:真的建会话、真的 startRun 占位、真的 claimForShell
 * 接管,然后问 `explainRunRefusal`。
 */
let tempDirectory: string;
let previousDatabasePath: string | undefined;

const startRunFor = (sessionId: string) => chatRunRegistry.startRun({
  appSessionId: sessionId,
  provider: 'claude',
  providerSessionId: null,
  connection: null,
  userId: 1,
});

beforeEach(async () => {
  previousDatabasePath = process.env.DATABASE_PATH;
  tempDirectory = await mkdtemp(path.join(tmpdir(), 'run-refusal-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
});

afterEach(async () => {
  connectedClients.clear();
  chatRunRegistry.clearAll();
  closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  await rm(tempDirectory, { recursive: true, force: true });
});

describe('explainRunRefusal', () => {
  it('已经有回合在跑 → BUSY', () => {
    sessionsDb.createAppSession('s-busy', 'claude', path.join(tempDirectory, 'proj'), 1);
    expect(startRunFor('s-busy')).not.toBeNull();

    expect(startRunFor('s-busy')).toBeNull();
    const refusal = chatRunRegistry.explainRunRefusal('s-busy');
    expect(refusal.code).toBe('BUSY');
    expect(refusal.message).toContain('正有回合在跑');
  });

  it('终端接管着 → HELD_BY_SHELL,而且说得出是谁', () => {
    sessionsDb.createAppSession('s-held', 'claude', path.join(tempDirectory, 'proj'), 1);
    const holder = claimForShell('s-held', { userId: 7, username: '小王' });
    try {
      // 这就是 fz 加的那道门 —— 它确实挡住了,但原来说不出为什么。
      expect(startRunFor('s-held')).toBeNull();
      const refusal = chatRunRegistry.explainRunRefusal('s-held');
      expect(refusal.code).toBe('HELD_BY_SHELL');
      expect(refusal.holder).toBe('小王');
      expect(refusal.message).toContain('终端接管');
      // 关键:**不能**再说成"有回合在跑" —— 那句话会让人去等,而该做的是关终端。
      expect(refusal.message).not.toContain('正有回合在跑');
    } finally {
      releaseShellClaim('s-held', holder.token);
    }
  });

  it('两种原因同时成立时,判据顺序与 startRun 完全一致(先在跑的回合)', () => {
    sessionsDb.createAppSession('s-both', 'claude', path.join(tempDirectory, 'proj'), 1);
    expect(startRunFor('s-both')).not.toBeNull();
    const holder = claimForShell('s-both', { userId: 7, username: '小王' });
    try {
      expect(chatRunRegistry.explainRunRefusal('s-both').code).toBe('BUSY');
    } finally {
      releaseShellClaim('s-both', holder.token);
    }
  });

  it('其实没有任何理由拒绝时给一个中性答案,不硬说成某一种', () => {
    sessionsDb.createAppSession('s-free', 'claude', path.join(tempDirectory, 'proj'), 1);
    expect(chatRunRegistry.explainRunRefusal('s-free').code).toBe('UNKNOWN');
  });
});

/**
 * 上面证明了"问得出原因",下面证明**三个调用点真的在问**。
 * (它们各自要真 HTTP / 真调度器才跑得起来,这里读源码钉住接线。)
 */
describe('三个非网页调用点都改用了这个原因', () => {
  const read = (relative: string) =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

  it('定时任务不再写死"目标会话正有回合在跑"', () => {
    const source = read('../../tasks/services/scheduled-tasks.service.ts');
    expect(source).toMatch(/chatRunRegistry\.explainRunRefusal\(sessionId\)\.message/);
    expect(source).not.toMatch(/new Error\('目标会话正有回合在跑,本次跳过'\)/);
  });

  it('外部 Agent API 的同步与异步两条路都区分了终端接管', () => {
    const source = read('../../../routes/agent.js');
    const uses = source.match(/chatRunRegistry\.explainRunRefusal\(appSessionId\)/g) ?? [];
    expect(uses.length).toBe(2);
    const held = source.match(/is held by an interactive terminal/g) ?? [];
    expect(held.length).toBe(2);
  });
});
