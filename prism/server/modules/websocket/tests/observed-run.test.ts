import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeConnection, initializeDatabase, sessionMessagesDb, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import {
  noteMergedSend,
  observeOrphanFrames,
  observedRunStats,
  OBSERVED_IDLE_MS,
  resetObservedRunsForTest,
} from '@/modules/websocket/services/observed-run.service.js';
import { connectedClients } from '@/shared/websocket-state.js';
import { createNormalizedMessage } from '@/shared/utils.js';

/**
 * gb:**观测回合 —— 接住 CLI 自己发起的那一轮。**
 *
 * 病根:后台子代理完成通知、会话内定时任务触发时,那一轮是 CLI 自己发起的,
 * `runtime.turn` 是 null,读循环在 `if (!turn) continue` 处把**整轮**丢掉:
 * 不广播(当场看不到)、不落显示日志(刷新也看不到,而且 seed 只在日志为空时
 * 抄一次,永不补抄)。
 *
 * 这一份跑的是**真实链路**:真的建库、真的开 run、真的过 writer,最后**去库里
 * 查那几行在不在** —— 而不是断言"我调用了 send"。上一轮的教训就是判据写对了、
 * 数据到不了它。
 */
let tempDirectory: string;
let previousDatabasePath: string | undefined;

const textRow = (content: string) => createNormalizedMessage({
  sessionId: 'provider-sid',
  provider: 'claude',
  kind: 'text',
  role: 'assistant',
  content,
} as Parameters<typeof createNormalizedMessage>[0]);

const taskRow = (summary: string) => createNormalizedMessage({
  id: 'task_abc_completed',
  sessionId: 'provider-sid',
  provider: 'claude',
  kind: 'task_notification',
  status: 'completed',
  summary,
  content: summary,
} as Parameters<typeof createNormalizedMessage>[0]);

const observe = (sessionId: string, messages: ReturnType<typeof textRow>[], turnEnded = false) =>
  observeOrphanFrames({
    appSessionId: sessionId,
    providerSessionId: 'provider-sid',
    userId: 1,
    provider: 'claude',
    messages,
    trigger: 'task-notification',
    turnEnded,
  });

const logRows = (sessionId: string) => sessionMessagesDb.listForSession(sessionId);

beforeEach(async () => {
  previousDatabasePath = process.env.DATABASE_PATH;
  tempDirectory = await mkdtemp(path.join(tmpdir(), 'observed-run-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  resetObservedRunsForTest();
  chatRunRegistry.clearAll();
});

afterEach(async () => {
  resetObservedRunsForTest();
  connectedClients.clear();
  chatRunRegistry.clearAll();
  closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  await rm(tempDirectory, { recursive: true, force: true });
});

describe('观测回合', () => {
  it('无主帧**真的落进了显示日志** —— 这就是"刷新也看不到"那一半', () => {
    sessionsDb.createAppSession('s-obs', 'claude', path.join(tempDirectory, 'proj'), 1);
    expect(logRows('s-obs')).toHaveLength(0);

    expect(observe('s-obs', [taskRow('✅ 后台任务完成 · 子 agent 1/3'), textRow('📬 子 agent 1/3 完成')])).toBe(true);

    const rows = logRows('s-obs');
    expect(rows.map((row) => row.kind)).toEqual(['task_notification', 'text']);
    // 落库时会话 id 必须换成 **app 会话 id**,不是 provider 原生 id
    expect(rows.every((row) => row.sessionId === 's-obs')).toBe(true);
  });

  it('开的是**观测**回合,而且 result 到达就收尾', () => {
    sessionsDb.createAppSession('s-end', 'claude', path.join(tempDirectory, 'proj'), 1);
    observe('s-end', [textRow('📬 完成')]);
    expect(chatRunRegistry.getRun('s-end')?.observed).toBe(true);
    expect(chatRunRegistry.isProcessing('s-end')).toBe(true);

    observe('s-end', [textRow('收尾')], true);
    expect(chatRunRegistry.isProcessing('s-end')).toBe(false);
  });

  it('**不阻塞用户发送**:真回合来了,观测回合让位(这是 Cowork 的那条契约)', () => {
    sessionsDb.createAppSession('s-preempt', 'claude', path.join(tempDirectory, 'proj'), 1);
    observe('s-preempt', [textRow('📬 完成')]);
    expect(chatRunRegistry.getRun('s-preempt')?.observed).toBe(true);

    const real = chatRunRegistry.startRun({
      appSessionId: 's-preempt',
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId: 1,
    });
    // 关键:**不是 null** —— 用户没有被顶成"已排队"
    expect(real).not.toBeNull();
    expect(real?.observed).toBe(false);
    expect(chatRunRegistry.getRun('s-preempt')).toBe(real);
  });

  /**
   * gh:**真回合在跑时,无主帧交给它的 writer,不能扔。**
   *
   * gb 在这里直接 `return false`。可"用户的 run 已登记、`runtime.turn` 还没赋值"
   * 这段窗口(checkpoint / 模型解析 / runtimeForSend 的 await)里,CLI 自己那轮
   * 的每一帧都会走到这里 —— 扔掉 = 界面与显示日志里永远没有这一段。
   * 交给用户那个 run 的 writer:同一条会话,照样落库、照样推给正在看的人。
   */
  it('真回合在跑时:帧交给它的 writer 落库,不扔;也不另开观测回合', () => {
    sessionsDb.createAppSession('s-busy', 'claude', path.join(tempDirectory, 'proj'), 1);
    chatRunRegistry.startRun({
      appSessionId: 's-busy', provider: 'claude', providerSessionId: null, connection: null, userId: 1,
    });
    expect(observe('s-busy', [textRow('抢占窗口里的一句')])).toBe(true);
    expect(chatRunRegistry.getRun('s-busy')?.observed).toBe(false);
    const rows = logRows('s-busy');
    expect(rows.some((row) => String(row.content ?? '').includes('抢占窗口里的一句'))).toBe(true);
  });

  it('gh:观测回合被「停止」标成完成后,下一批帧不扔 —— 重新接住', () => {
    sessionsDb.createAppSession('s-stop', 'claude', path.join(tempDirectory, 'proj'), 1);
    expect(observe('s-stop', [textRow('第一批')])).toBe(true);
    const first = chatRunRegistry.getRun('s-stop')!;
    // websocket 层的中止处理:把观测回合标成完成(CLI 其实还在跑)
    chatRunRegistry.completeRunIfCurrent(first, { exitCode: 1, aborted: true });
    expect(observe('s-stop', [textRow('第二批')])).toBe(true);
    const rows = logRows('s-stop');
    expect(rows.some((row) => String(row.content ?? '').includes('第二批'))).toBe(true);
    expect(chatRunRegistry.getRun('s-stop')?.observed).toBe(true);
  });

  /**
   * gh:**工具还在跑就不按静默收尾。**
   *
   * 60 秒静默看门狗是按"模型在想"设计的;一条跑 90 秒的后台命令没有任何帧,
   * 到点就被判成失败(complete exitCode:1)。上游每一批带着 toolsInFlight,
   * 到点只续不杀;心跳(空批)也能续期。
   */
  it('gh:toolsInFlight 时静默到点只续期,不收尾;工具跑完之后再到点才收', () => {
    vi.useFakeTimers();
    try {
      sessionsDb.createAppSession('s-slow', 'claude', path.join(tempDirectory, 'proj'), 1);
      expect(observeOrphanFrames({
        appSessionId: 's-slow', providerSessionId: 'p', userId: 1, provider: 'claude',
        messages: [textRow('开始跑测试')], trigger: 'unknown', turnEnded: false, toolsInFlight: true,
      })).toBe(true);
      vi.advanceTimersByTime(OBSERVED_IDLE_MS + 1);
      expect(chatRunRegistry.getRun('s-slow')?.status).toBe('running');
      expect(observedRunStats().open).toBe(1);
      // 心跳(空批)把"工具跑完了"带过来
      expect(observeOrphanFrames({
        appSessionId: 's-slow', providerSessionId: 'p', userId: 1, provider: 'claude',
        messages: [], trigger: 'unknown', turnEnded: false, toolsInFlight: false,
      })).toBe(true);
      vi.advanceTimersByTime(OBSERVED_IDLE_MS + 1);
      expect(chatRunRegistry.getRun('s-slow')?.status).not.toBe('running');
      expect(observedRunStats().open).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gh:被换掉之后只剩一个空 result → 清账,不凭空再开一段', () => {
    sessionsDb.createAppSession('s-stop2', 'claude', path.join(tempDirectory, 'proj'), 1);
    expect(observe('s-stop2', [textRow('第一批')])).toBe(true);
    chatRunRegistry.completeRunIfCurrent(chatRunRegistry.getRun('s-stop2')!, { exitCode: 1, aborted: true });
    expect(observe('s-stop2', [], true)).toBe(false);
    expect(observedRunStats().open).toBe(0);
  });

  it('会话行不存在就不接 —— 落库要以那一行为准', () => {
    expect(observe('s-ghost', [textRow('x')])).toBe(false);
    expect(chatRunRegistry.getRun('s-ghost')).toBeUndefined();
  });

  it('只有 result、没有内容 → 不凭空开一段', () => {
    sessionsDb.createAppSession('s-empty', 'claude', path.join(tempDirectory, 'proj'), 1);
    expect(observe('s-empty', [], true)).toBe(false);
    expect(logRows('s-empty')).toHaveLength(0);
  });

  /**
   * ge:**观测回合不再盖任何来源标记。**
   *
   * gb 会在开头落一枚「📬 这一轮由 Claude Code 自己发起」。实机看下来那是在
   * 一条本该连贯的时间轴里插了一句旁白 —— 要的是"一根轴串下来"。
   * 信息没丢:后台任务的终态已经归到它自己那一行上了。
   */
  it('接住的那一批**原样落库**,一行旁白都不加', () => {
    sessionsDb.createAppSession('s-bare', 'claude', path.join(tempDirectory, 'proj'), 1);
    observe('s-bare', [textRow('刚才两个定时任务都准时触发了')]);
    const rows = logRows('s-bare');
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('text');
  });

  it('带任务通知行的那一批也一样,不多不少', () => {
    sessionsDb.createAppSession('s-marker', 'claude', path.join(tempDirectory, 'proj'), 1);
    observe('s-marker', [taskRow('✅ 后台任务完成 · 结果在这儿'), textRow('接着说')]);
    const rows = logRows('s-marker');
    expect(rows.map((row) => row.kind)).toEqual(['task_notification', 'text']);
  });

  it('统计跟着走 —— 与"无主帧丢弃计数"配对看', () => {
    sessionsDb.createAppSession('s-stat', 'claude', path.join(tempDirectory, 'proj'), 1);
    expect(observedRunStats().opened).toBe(0);
    observe('s-stat', [textRow('x')]);
    expect(observedRunStats()).toEqual({ open: 1, opened: 1 });
    observe('s-stat', [textRow('y')], true);
    expect(observedRunStats()).toEqual({ open: 0, opened: 1 });
  });
});

/**
 * gc:**合流进来的那条用户消息,它的回复不是"CLI 自己发起的"。**
 *
 * 合流之后模型的回复有两种落法:被 CLI 当场并进这一轮(走 `runtime.turn`,
 * 与观测回合无关),或者等到回合边界才投递 —— 后者对 Prism 来说就是一轮无主帧。
 * 那一轮会被观测回合接住,但它**是用户发起的**:再盖一枚
 * 「📬 这一轮由 Claude Code 自己发起」就是睁眼说瞎话,用户的气泡就在上面几行。
 */
describe('合流之后的那一轮', () => {
  it('合流之后的那一轮照常接住,内容原样落库', () => {
    sessionsDb.createAppSession('s-merged', 'claude', path.join(tempDirectory, 'proj'), 1);
    noteMergedSend('s-merged');

    observe('s-merged', [textRow('好的,配置也改完了')]);

    const rows = logRows('s-merged');
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('text');
  });

  it('那一笔记账只用一次,不会挂到下一轮头上', () => {
    sessionsDb.createAppSession('s-once', 'claude', path.join(tempDirectory, 'proj'), 1);
    noteMergedSend('s-once');
    observe('s-once', [textRow('第一轮:用户合流进来的')], true);
    observe('s-once', [textRow('第二轮:后台任务触发的')], true);
    expect(logRows('s-once').map((row) => row.kind)).toEqual(['text', 'text']);
  });
});
