import crypto from 'node:crypto';

import {
  scheduledTasksDb,
  sessionsDb,
  sessionMessagesDb,
  type ScheduledTaskRow,
  type TaskFrequency,
} from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { generateMessageId } from '@/shared/utils.js';

/**
 * 定时任务调度与执行(cj 轮,B 方案)。
 *
 * 设计要点:
 * - **预设频率**推 next_run_at(服务器本地时区,和截图 "Weekdays at 15:30"
 *   同语义),不引 cron 依赖;manual 任务 next_run_at 恒为 null,只能手动跑;
 * - 调度器 30s 一拍,捞 `enabled && next_run_at <= now && !running`;
 *   `claimRun` 原子占位,与「立即运行」互不双跑;进程崩死留下的 running=1
 *   由启动时 releaseStaleRunning 松开;
 * - **执行链与网页聊天同一条 run 通道**:startRun → 用户指令行落显示日志 →
 *   queryClaudeSDK(oneShot)→ writer 出站帧照常落库/推流 —— 打开目标会话的
 *   浏览器实时看到流式过程,离线回来看历史;
 * - 开始/结束各落一条 task_notification 回执行(前端已有渲染),失败带原因。
 */

const TICK_MS = 30_000;

/**
 * dm:单次运行的硬上限。回合自己有 PRISM_TURN_TIMEOUT 看门狗,但那条路径若
 * 因任何原因没走到(promise 悬死),`running=1` 会一直占着,任务从此不再触发,
 * 直到进程重启 —— 这里是调度层自己的保险丝。超时后:记一次失败、放行调度、
 * 给正在看的浏览器补一个终止帧;后台那个悬死的回合交给它自己的看门狗收尸。
 * PRISM_TASK_RUN_TIMEOUT_MS 覆盖,0 关闭,默认 2 小时。
 */
const TASK_RUN_TIMEOUT_MS = (() => {
  const parsed = parseInt(process.env.PRISM_TASK_RUN_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2 * 3600_000;
})();

/** dm:失败后多久自动重试一次。 */
const TASK_RETRY_DELAY_MS = 5 * 60_000;
/** 连续失败到这个次数就停手,等下一个正常周期 —— 坏配置不该被无限重试放大。 */
export const TASK_RETRY_MAX_CONSECUTIVE_FAILURES = 3;

export class TaskRunTimeoutError extends Error {
  constructor(ms: number) {
    super(`任务运行超过 ${Math.round(ms / 60_000)} 分钟未结束,已按超时处理`);
    this.name = 'TaskRunTimeoutError';
  }
}

/** 带上限的等待。ms=0 表示不设限。导出供单测。 */
export function promiseWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (!ms) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TaskRunTimeoutError(ms)), ms);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/**
 * dm:这次(调度触发的)失败之后,要不要把下一次拉近到"5 分钟后重试"。
 * 纯函数:`recentStatuses` 最近在前、**含本次**。连续失败 ≥ 上限,或正常
 * 周期本来就更近,都不重试。
 */
export function computeRetryAt(recentStatuses: string[], now: Date, regularNext: Date | null): Date | null {
  let consecutive = 0;
  for (const status of recentStatuses) {
    if (status === 'failed') consecutive += 1;
    else break;
  }
  if (consecutive === 0 || consecutive >= TASK_RETRY_MAX_CONSECUTIVE_FAILURES) return null;
  const retryAt = new Date(now.getTime() + TASK_RETRY_DELAY_MS);
  if (regularNext && regularNext <= retryAt) return null;
  return retryAt;
}

type QueryClaudeSDK = (message: string, options: Record<string, unknown>, writer: unknown) => Promise<unknown>;

let queryClaudeSDKRef: QueryClaudeSDK | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

/* ── next_run_at 纯函数 ─────────────────────────────────────────────── */

type FrequencyFields = Pick<ScheduledTaskRow, 'frequency' | 'run_at_hour' | 'run_at_minute' | 'run_at_weekday' | 'run_at_day'>;

/**
 * 从 `from` 起算下一次运行时刻(服务器本地时区)。manual 返回 null。
 * 导出供单测:全部用注入的 from,不摸真实时钟。
 */
export function computeNextRunAt(task: FrequencyFields, from: Date): Date | null {
  const frequency = task.frequency as TaskFrequency;
  if (frequency === 'manual') return null;

  const hour = task.run_at_hour ?? 9;
  const minute = task.run_at_minute ?? 0;

  if (frequency === 'hourly') {
    const next = new Date(from);
    next.setMinutes(minute, 0, 0);
    if (next <= from) next.setHours(next.getHours() + 1);
    return next;
  }

  const atTime = (base: Date) => {
    const d = new Date(base);
    d.setHours(hour, minute, 0, 0);
    return d;
  };

  if (frequency === 'daily') {
    let next = atTime(from);
    if (next <= from) { next = atTime(new Date(from.getTime() + 24 * 3600_000)); }
    return next;
  }

  if (frequency === 'weekdays') {
    let next = atTime(from);
    // 已过今天时刻则从明天起找;周六(6)/周日(0)跳过
    if (next <= from) next = atTime(new Date(from.getTime() + 24 * 3600_000));
    for (let i = 0; i < 7; i += 1) {
      const day = next.getDay();
      if (day !== 0 && day !== 6) return next;
      next = atTime(new Date(next.getTime() + 24 * 3600_000));
    }
    return next;
  }

  if (frequency === 'weekly') {
    const targetWeekday = task.run_at_weekday ?? 1; // 默认周一
    let next = atTime(from);
    for (let i = 0; i < 8; i += 1) {
      if (next.getDay() === targetWeekday && next > from) return next;
      next = atTime(new Date(next.getTime() + 24 * 3600_000));
    }
    return next;
  }

  // monthly:每月 d 号(1–28,避免大小月纠缠)
  const targetDay = Math.min(Math.max(task.run_at_day ?? 1, 1), 28);
  const candidate = new Date(from.getFullYear(), from.getMonth(), targetDay, hour, minute, 0, 0);
  if (candidate > from) return candidate;
  return new Date(from.getFullYear(), from.getMonth() + 1, targetDay, hour, minute, 0, 0);
}

/** Date → 与 SQLite datetime('now') 同形的 UTC "YYYY-MM-DD HH:MM:SS"。 */
export function toDbUtc(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function nowDbUtc(): string {
  return toDbUtc(new Date());
}

/* ── 回执行 ────────────────────────────────────────────────────────── */

function appendReceipt(sessionId: string, status: 'started' | 'completed' | 'failed', task: ScheduledTaskRow, detail?: string): void {
  const summary = status === 'started'
    ? `⏰ 定时任务「${task.name}」开始执行`
    : status === 'completed'
      ? `✅ 定时任务「${task.name}」执行完成${detail ? ` · ${detail}` : ''}`
      : `⚠️ 定时任务「${task.name}」执行失败${detail ? `:${detail}` : ''}`;
  sessionMessagesDb.append(sessionId, {
    id: generateMessageId('task'),
    sessionId,
    timestamp: new Date().toISOString(),
    provider: 'claude',
    kind: 'task_notification',
    status: status === 'failed' ? 'failed' : 'completed',
    summary,
    content: summary,
  } as Parameters<typeof sessionMessagesDb.append>[1]);
}

/* ── 执行 ─────────────────────────────────────────────────────────── */

function resolveTargetSessionId(task: ScheduledTaskRow): string {
  if (task.session_mode === 'fixed' && task.fixed_session_id) {
    const existing = sessionsDb.getSessionById(task.fixed_session_id);
    if (existing) return task.fixed_session_id;
  }
  // 每次新建,或固定会话已被删:开一个新会话,名字带任务名与日期,归属任务主人
  const sessionId = crypto.randomUUID();
  sessionsDb.createAppSession(sessionId, 'claude', task.project_path, task.owner_user_id);
  const stamp = new Date();
  const name = `${task.name} · ${stamp.getMonth() + 1}/${stamp.getDate()}`;
  try { sessionsDb.updateSessionCustomName(sessionId, name); } catch { /* 名字是锦上添花 */ }
  if (task.session_mode === 'fixed') {
    scheduledTasksDb.update(task.id, { fixed_session_id: sessionId });
  }
  return sessionId;
}

async function executeTask(task: ScheduledTaskRow, trigger: 'schedule' | 'manual'): Promise<void> {
  if (!queryClaudeSDKRef) return;
  if (!scheduledTasksDb.claimRun(task.id)) return; // 已在跑

  const startedAt = Date.now();
  const startedAtIso = toDbUtc(new Date(startedAt));
  let status: 'completed' | 'failed' = 'completed';
  let detail: string | null = null;
  let sessionId: string | null = null;

  try {
    sessionId = resolveTargetSessionId(task);
    const session = sessionsDb.getSessionById(sessionId);
    const providerSessionId = session?.provider_session_id ?? null;

    const run = chatRunRegistry.startRun({
      appSessionId: sessionId,
      provider: 'claude',
      providerSessionId,
      connection: null,
      userId: task.owner_user_id,
    });
    if (!run) {
      throw new Error('目标会话正有回合在跑,本次跳过');
    }

    // 用户指令行 + 开始回执(ch 轮建立的显示日志规范)
    sessionMessagesDb.append(sessionId, {
      id: generateMessageId('user'),
      sessionId,
      timestamp: new Date().toISOString(),
      provider: 'claude',
      kind: 'text',
      role: 'user',
      content: task.instructions,
    } as Parameters<typeof sessionMessagesDb.append>[1]);
    appendReceipt(sessionId, 'started', task);

    // 收尾挂在**真实的** run promise 上:正常/晚到的结束都会经过它;
    // 超时路径另行给浏览器补终止帧(见 catch),真回合晚到的 complete 会被
    // registry 的"只收一个 complete"去重。
    const runPromise = queryClaudeSDKRef(task.instructions, {
      projectPath: task.project_path,
      cwd: task.project_path,
      sessionId: providerSessionId ?? undefined,
      resume: Boolean(providerSessionId),
      newSessionId: providerSessionId ? undefined : sessionId,
      runId: sessionId,
      model: task.model || undefined,
      permissionMode: task.permission_mode || 'bypassPermissions',
      oneShot: true,
    }, run.writer).finally(() => {
      chatRunRegistry.completeRunIfCurrent(run, { exitCode: 0 });
    });

    try {
      await promiseWithTimeout(runPromise, TASK_RUN_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof TaskRunTimeoutError) {
        // 悬死的回合可能还开着流 —— 给订阅的浏览器一个终止帧,别让它们转圈到天明。
        chatRunRegistry.completeRunIfCurrent(run, { exitCode: 1, aborted: true });
      }
      throw error;
    }
  } catch (error) {
    status = 'failed';
    detail = error instanceof Error ? error.message : String(error);
    console.error(`[Tasks] 「${task.name}」(${trigger}) 执行失败:`, detail);
  }

  const durationMs = Date.now() - startedAt;
  if (sessionId) {
    const seconds = Math.round(durationMs / 1000);
    appendReceipt(sessionId, status, task, status === 'completed' ? `耗时 ${seconds}s` : detail ?? undefined);
  }

  // 下一次时刻从"这次结束"起算 —— 手动触发也顺带校准
  const next = computeNextRunAt(task, new Date());
  let nextRunAt = task.enabled && next ? toDbUtc(next) : task.enabled ? null : task.next_run_at;

  // dm:调度触发的失败,5 分钟后自动重试一次;连续失败 3 次就停手等正常周期。
  // 手动触发不重试 —— 人正看着,重跑该由他自己决定。
  if (status === 'failed' && trigger === 'schedule' && task.enabled && next) {
    const previousStatuses = scheduledTasksDb
      .listRuns(task.id, TASK_RETRY_MAX_CONSECUTIVE_FAILURES)
      .rows.map((row) => row.status);
    const retryAt = computeRetryAt(['failed', ...previousStatuses], new Date(), next);
    if (retryAt) {
      nextRunAt = toDbUtc(retryAt);
      detail = `${detail ?? '执行失败'}(${Math.round(TASK_RETRY_DELAY_MS / 60_000)} 分钟后自动重试)`;
    }
  }

  scheduledTasksDb.finishRun(task.id, {
    status,
    detail,
    durationMs,
    nextRunAt,
    // 运行记录要能回答"哪次、跑了多久、失败原因、产出落在哪个会话"。
    // sessionId 在「每次新建会话」模式下每次都不同,记下来才点得回去。
    startedAt: startedAtIso,
    sessionId,
    trigger,
  });
}

/* ── 调度器 ───────────────────────────────────────────────────────── */

export function startTaskScheduler(queryClaudeSDK: QueryClaudeSDK): void {
  queryClaudeSDKRef = queryClaudeSDK;
  const released = scheduledTasksDb.releaseStaleRunning();
  if (released > 0) console.log(`[Tasks] 松开 ${released} 个上次进程遗留的 running 标记`);

  timer = setInterval(() => {
    try {
      const due = scheduledTasksDb.listDue(nowDbUtc());
      for (const task of due) {
        void executeTask(task, 'schedule');
      }
    } catch (error) {
      console.error('[Tasks] 调度 tick 失败:', error);
    }
  }, TICK_MS);
  console.log('[Tasks] 定时任务调度器已启动(30s 一拍)');
}

export function stopTaskScheduler(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

/** 「立即运行」入口(REST 调):不等 tick,直接执行。 */
export function runTaskNow(taskId: string): { ok: boolean; error?: string } {
  const task = scheduledTasksDb.getById(taskId);
  if (!task) return { ok: false, error: 'not_found' };
  if (task.running) return { ok: false, error: 'already_running' };
  void executeTask(task, 'manual');
  return { ok: true };
}
