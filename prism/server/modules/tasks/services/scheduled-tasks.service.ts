import crypto from 'node:crypto';

import {
  userDb as usersDb,
  canViewerSeeProjectPath,
  projectsDb,
  scheduledTasksDb,
  sessionsDb,
  sessionMessagesDb,
  type ScheduledTaskRow,
  type TaskFrequency,
} from '@/modules/database/index.js';
import { assertViewerMayCreateSessionAt, claudeModelCatalog, modelViewerFor, modelsDefinitionFor, providerModelsService, seedDisplayLogFromTranscript } from '@/modules/providers/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { generateMessageId } from '@/shared/utils.js';
import { createLogger } from '@/shared/logger.js';
const log = createLogger('tasks');

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
/** ho(ho-4):定时任务遇到要审批的工具调用 —— `deny`(默认,立刻拒)/ `wait`(等人在网页上批,最长 1 小时)。 */
export function readTaskApprovalPolicy(env: NodeJS.ProcessEnv = process.env): 'deny' | 'wait' {
  return String(env.PRISM_TASK_APPROVAL ?? '').trim().toLowerCase() === 'wait' ? 'wait' : 'deny';
}

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

/**
 * hl(动态 P1-1):一次性回合的返回值(见 claude-sdk `oneShotOutcome`)。
 * 老的 `undefined` 也接受 —— 单测里注入的假 SDK、以及万一某条路径没返回,
 * 都按"没报失败"处理,但真正的失败一定带 `ok:false`。
 */
export type OneShotOutcome = {
  ok: boolean;
  exitCode: 0 | 1;
  aborted: boolean;
  error: string | null;
  sessionId: string | null;
};
type QueryClaudeSDK = (message: string, options: Record<string, unknown>, writer: unknown) => Promise<OneShotOutcome | undefined | unknown>;

/** 把 queryClaudeSDK 的返回值读成明确的三态:成功 / 失败(原因)/ 被中止。 */
export function readOneShotOutcome(value: unknown): { ok: true } | { ok: false; aborted: boolean; rejected: boolean; error: string } {
  if (!value || typeof value !== 'object') return { ok: true };
  const outcome = value as Partial<OneShotOutcome> & { rejected?: boolean };
  if (outcome.ok === true || (outcome.ok === undefined && outcome.exitCode !== 1)) return { ok: true };
  return {
    ok: false,
    aborted: Boolean(outcome.aborted),
    // hq:闸口 / 网关拒绝(模型不许用、没有 key、网关停用)—— 重试也是同一个结果
    rejected: Boolean(outcome.rejected),
    error: outcome.error || (outcome.aborted ? '回合被中止' : '回合失败'),
  };
}
/**
 * 中止一条回合。与 `queryClaudeSDK` 一样由 composition root 注入 ——
 * 这个模块不能直接 import claude-sdk(eslint 的模块边界不让,而且会形成环)。
 */
type AbortClaudeRun = (runId: string) => Promise<unknown> | unknown;

let queryClaudeSDKRef: QueryClaudeSDK | null = null;
let abortClaudeRunRef: AbortClaudeRun | null = null;
/** 回合结束后放行这条会话上排队的网页消息。同样由 composition root 注入。 */
let drainPendingSendRef: ((sessionId: string) => void) | null = null;
/**
 * 任务失败时发通知。同样由 composition root 注入 —— tasks 不直接引 notifications
 * (模块边界),而且这样测试里也能塞个假的。
 */
let notifyTaskFailedRef:
  | ((input: { userId: number | null; sessionId: string | null; taskName: string; error: string }) => void)
  | null = null;
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
  /**
   * hl(09-24 P2-4):"明天同一时刻"用日历日推,不用 `+24h`。
   *
   * 夏令时切换那天一天不是 24 小时:回拨日(America/New_York 11 月)`+24h` 落在
   * 同一日历日的 23:xx,`setHours` 再把它拉回**今天**的时刻 → 结果 ≤ from,
   * 每天任务在那天要么多跑一次、要么跳过一天。`setDate(getDate()+1)` 让 JS
   * 按本地日历进位,时刻由 `setHours` 钉住。生产是 Asia/Shanghai 不受影响,
   * 但这是正确性,不是时区偏好。
   */
  const nextCalendarDay = (base: Date) => {
    const d = new Date(base);
    d.setDate(d.getDate() + 1);
    return atTime(d);
  };

  if (frequency === 'daily') {
    let next = atTime(from);
    if (next <= from) next = nextCalendarDay(from);
    return next;
  }

  if (frequency === 'weekdays') {
    let next = atTime(from);
    // 已过今天时刻则从明天起找;周六(6)/周日(0)跳过
    if (next <= from) next = nextCalendarDay(from);
    for (let i = 0; i < 7; i += 1) {
      const day = next.getDay();
      if (day !== 0 && day !== 6) return next;
      next = nextCalendarDay(next);
    }
    return next;
  }

  if (frequency === 'weekly') {
    const targetWeekday = task.run_at_weekday ?? 1; // 默认周一
    let next = atTime(from);
    for (let i = 0; i < 8; i += 1) {
      if (next.getDay() === targetWeekday && next > from) return next;
      next = nextCalendarDay(next);
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

/**
 * hl(09-24 P2-12):服务器时区的自述,随任务列表 / 任务响应下发。
 *
 * `computeNextRunAt` 按**服务器本地时区**算,而表单和「下一次」原来按浏览器时区
 * 显示、给 Claude 的隐藏上下文还写着"服务器与用户同一时区" —— Docker 默认 UTC 时
 * 差 8 小时,用户填 10:00 看到"下一次 18:00"。前端拿这份去格式化和标注。
 * 与 skillwhet 夜训的 `serverTime` 同形,多一个 `now`(ISO)供前端算相对时间。
 */
export function serverTimeInfo(now: Date = new Date()): { tz: string; offsetMin: number; local: string; now: string } {
  let tz = 'UTC';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { /* 极少数运行时没有 ICU */ }
  return {
    tz,
    offsetMin: -now.getTimezoneOffset(),
    local: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    now: now.toISOString(),
  };
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

/**
 * hl(09-24 P1-9 / 动态已知):跑之前先确认**项目还在、没归档、主人还看得见**。
 *
 * 此前任务找不到会话就 `createAppSession` → `createProjectPath`,把已删项目以新
 * project_id 重建出来(属主是任务主人,原共享 / 公开设置全丢);已归档的项目照跑。
 * 这里一律不建项目:返回原因,调用方记一次 failed(不重试 —— 项目回来之前重试
 * 只会刷出三条一模一样的失败)。导出供单测。
 */
export async function explainProjectUnavailable(task: Pick<ScheduledTaskRow, 'project_path' | 'owner_user_id'>): Promise<string | null> {
  const owner = task.owner_user_id != null ? usersDb.getUserById(task.owner_user_id) : null;
  if (!owner) return '任务主人账号不存在,任务跳过';
  const viewer = { userId: owner.id, username: owner.username };
  const project = projectsDb.getProjectPath(task.project_path);
  if (!project) {
    /**
     * 没有项目行:要么项目被删了(hl 起删项目会连带删任务,所以正常不会走到这),
     * 要么任务建在一条"还没被扫描进 projects 表"的路径上(建任务时允许:公共目录 /
     * root)。用与建任务**同一道门**判:目录还在且主人现在仍可在那里开会话就放行
     * (跑起来会照旧登记项目,属主是任务主人);过不了门就是删了 / 越界了,跳过。
     */
    try {
      await assertViewerMayCreateSessionAt(viewer, task.project_path);
      return null;
    } catch {
      return `项目 ${task.project_path} 已删除或不可访问,任务跳过`;
    }
  }
  if (project.isArchived) return `项目 ${task.project_path} 已归档,任务跳过`;
  if (!canViewerSeeProjectPath(viewer, task.project_path)) {
    return `任务主人(${owner.username})已无权访问项目 ${task.project_path},任务跳过`;
  }
  return null;
}

/** 失败但**不该**触发 5 分钟重试的那一类(项目不在了、用户按了停止)。 */
class TaskSkippedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskSkippedError';
  }
}

/** 导出供单测(hl-tasks.test):调度 / 手动两种触发都从这里进。 */
export async function executeTask(task: ScheduledTaskRow, trigger: 'schedule' | 'manual'): Promise<void> {
  if (!queryClaudeSDKRef) return;
  if (!scheduledTasksDb.claimRun(task.id)) return; // 已在跑

  const startedAt = Date.now();
  const startedAtIso = toDbUtc(new Date(startedAt));
  let status: 'completed' | 'failed' = 'completed';
  let detail: string | null = null;
  let sessionId: string | null = null;
  /** 跳过类失败(项目不在 / 被中止)不进入重试;真失败才重试。 */
  let retryable = true;
  /**
   * hn(B2):任务里存的模型已经不在目录里 / 下架了 → 这一次按默认模型跑,运行记录里写明。
   * 不直接失败:定时任务是无人值守的,因为管理员下架了一个模型就让它连续失败、停手,代价不对。
   */
  // hq:按任务的主人判(「可用人员」/ 私有模型,别名也算);回落也在他看得见、有 key 的里面挑。
  // 复审(二轮 P2-5):这几步要读库 —— 出错不能让任务卡在"运行中"(还在 claimRun 之后、try 之外),兜住按原模型跑
  const ownerViewer = modelViewerFor(task.owner_user_id ?? null);
  let modelFallbackNote: string | null = null;
  /** 复审(四轮):连回落都用不了时的原因 —— 在 try 里按 TaskSkippedError 跳过(不重试)。 */
  let unusableModelReason: string | null = null;
  let effectiveModel: string | undefined = task.model || undefined;
  try {
    // 复审(三轮 P2-4):没写模型的任务跑 default 别名 —— 它映射到的模型也可能限了人,同样要判、同样回落
    if (!(await claudeModelCatalog.isUsable(task.model || null, ownerViewer))) {
      // "默认模型" = 新会话默认用的那个(目录 is_default → 推荐 → 别名 default),与对话里一致;
      // hq(复审 P2-7):按主人挑,而且要挑他**有 key** 的(modelsDefinitionFor 的 DEFAULT 已经避开不可用的)
      const fallback = modelsDefinitionFor(ownerViewer).DEFAULT;
      // 复审(四轮 P3-4):回落到的仍是这个用不了的模型(主人一个目录模型都看不见、default 别名又限了人)
      // —— 不写"按默认模型运行",直接跳过并说清楚(否则记录说按默认跑、实际被闸口拒)
      if (fallback === (task.model || 'default') || !(await claudeModelCatalog.isUsable(fallback, ownerViewer))) {
        unusableModelReason = `模型「${task.model || 'default'}」主人用不了(不在模型目录里、已下架,或不在它的可用人员里),也没有他能用的默认模型 —— 到任务里另选一个模型`;
      } else {
        // 先算出回落、再记说明 —— 算的时候出错就不记"按默认模型运行"(那样记录与实际不符)
        effectiveModel = fallback;
        modelFallbackNote = `模型「${task.model || 'default'}」已不在模型目录里(或已下架,或主人不在它的可用人员里),这一次按默认模型「${fallback}」运行`;
      }
    }
  } catch (error) {
    log.warn(`[Tasks] 「${task.name}」:查模型能不能用时出错,按任务里的模型跑(回合本身还会再判一次):`, error);
  }
  if (modelFallbackNote) log.warn(`[Tasks] 「${task.name}」:${modelFallbackNote}`);

  try {
    const unavailable = await explainProjectUnavailable(task);
    if (unavailable) throw new TaskSkippedError(unavailable);
    if (unusableModelReason) throw new TaskSkippedError(unusableModelReason);

    sessionId = resolveTargetSessionId(task);
    /*
     * hn(复审 P2-3):固定会话上 /models 留下的覆盖**优先于**任务自己的模型(resolveResumeModel)。
     * 那个模型被下架了 → 闸口拒绝,原来会每 5 分钟重试一次、一直失败。改为不重试的跳过,并说清楚去哪改。
     */
    const sessionOverride = await providerModelsService.getChangedActiveModel('claude', sessionId).catch(() => null);
    if (sessionOverride?.changed && sessionOverride.model && !(await claudeModelCatalog.isUsable(sessionOverride.model, ownerViewer))) {
      throw new TaskSkippedError(`这条会话在 /models 里切到的模型「${sessionOverride.model}」任务主人用不了(已下架,或不在它的可用人员里)—— 到会话里另选一个模型后再跑`);
    }
    const session = sessionsDb.getSessionById(sessionId);
    const providerSessionId = session?.provider_session_id ?? null;

    /**
     * hl(动态 P2-1):**回执之前先把显示日志抄齐。**
     *
     * 终端接管释放会 `deleteForSession` 清掉这条会话的显示日志;之后任务写的
     * 用户指令行与 ⏰ / ✅ 回执全被 `session-messages.db` 的守门拒掉("日志空着
     * 而 transcript 存在"),会话页什么都看不到,直到有人手动发一条触发重抄。
     * 这里走与 `chat.send` **同一条** seed 路径(并发去重、失败可区分),不另写一套。
     * 抄失败就当没抄:这一轮的落库会被守门拒绝,下一轮再抄 —— 和 chat 的语义一致。
     */
    const seed = await seedDisplayLogFromTranscript(sessionId);
    if (seed.status === 'failed') {
      log.warn(`[Tasks] 「${task.name}」会话 ${sessionId} 的显示日志重抄失败,本轮回执可能不落库`);
    }

    const run = chatRunRegistry.startRun({
      appSessionId: sessionId,
      provider: 'claude',
      providerSessionId,
      connection: null,
      userId: task.owner_user_id,
    });
    if (!run) {
      // ga:`startRun` 拒绝的原因有两种(在跑的回合 / 终端接管着),原来这里
      // 一律写成前者 —— 一个开着的终端会连发三条内容错误的失败告警,而真正
      // 该做的事是去关那个终端。原因交给 registry 说(见 explainRunRefusal)。
      throw new Error(`${chatRunRegistry.explainRunRefusal(sessionId).message},本次跳过`);
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
      // hl 复核(动态 P2-6 同源):记下发起人 = 任务主人。会话的归档 / 删除按"第一条
      // 用户消息的 senderUserId"认发起人,缺了它,协作者自己的任务建出的会话他本人
      // 动不了。只影响会话归属判定,不改 canTouch / 以谁的身份跑。
      senderUserId: task.owner_user_id ?? undefined,
      // gy:定时任务的回合没有人在屏幕前 —— 效果调查卡按 origin 跳过它。
      origin: 'scheduled',
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
      model: effectiveModel,
      permissionMode: task.permission_mode || 'bypassPermissions',
      // 任务是"以主人的身份"跑的,bypass 白名单要认的就是这个人。
      // 定时任务默认档位正好是 bypassPermissions,所以这条尤其要带上。
      actorUsername: task.owner_user_id != null
        ? usersDb.getUserById(task.owner_user_id)?.username ?? null
        : null,
      // hq:网关 key、「可用人员」、私有模型都按任务的主人
      actorUserId: task.owner_user_id ?? null,
      // fg:这笔账记在「定时任务」名下。无人值守跑出来的钱和人点出来的钱,
      // 在"这个月花哪了"里是完全不同的两件事 —— 前者能靠改调度频率降,
      // 后者只能靠改用法。混在一起就两个都看不出来。
      usageSource: 'task',
      /**
       * ho(ho-4):定时任务是无人值守的 —— 要问人的工具调用默认**立刻拒**(模型据此换路、运行记录里看得到),
       * 不再挂到 1 小时审批上限。真要有人守着批:`PRISM_TASK_APPROVAL=wait` 回到原来的"等人批"。
       */
      unattended: readTaskApprovalPolicy() === 'deny',
      oneShot: true,
    }, run.writer);
    const settledRun = runPromise.then(
      (value) => {
        // hl(动态 P1-1):兜底的终止帧按真实成败给 exitCode(正常情况下 SDK 自己
        // 已经发过 complete,registry 只收一个)。
        chatRunRegistry.completeRunIfCurrent(run, { exitCode: readOneShotOutcome(value).ok ? 0 : 1 });
        return value;
      },
      (error) => {
        chatRunRegistry.completeRunIfCurrent(run, { exitCode: 1 });
        throw error;
      },
    ).finally(() => {
      // 回合结束要把这条会话上排队的网页消息放出去 —— 用户在任务跑着的时候发的那条
      // 会进 pendingSends,没人来接就得躺满 30 分钟 TTL。外部 API 那条路(routes/agent.js)
      // 在 dv 轮补过同样的一句,定时任务这条同类路径漏了。
      if (sessionId) drainPendingSendRef?.(sessionId);
    });

    try {
      const outcome = readOneShotOutcome(await promiseWithTimeout(settledRun, TASK_RUN_TIMEOUT_MS));
      /**
       * hl(动态 P1-1):**SDK 说失败就是失败。**
       *
       * 此前 promise 一 resolve 就记 completed —— 模型名不存在、网关 400、超出轮次
       * 上限,运行记录里全是「成功」,会话里 error 帧后面紧跟「✅ 执行完成」;
       * 5 分钟重试、连续 3 次停手、失败通知从没生效过。
       * 被用户按停止中止的那次也记 failed,但不重试(人正看着,重跑由他决定)。
       */
      if (!outcome.ok) {
        // hq(复审 P2-7):没有 key / 网关停用 / 模型不许用 —— 5 分钟后再跑也一样,不重试(运行记录里写着原因)
        if (outcome.aborted || outcome.rejected) throw new TaskSkippedError(outcome.error);
        throw new Error(outcome.error);
      }
    } catch (error) {
      if (error instanceof TaskRunTimeoutError) {
        /**
         * **先真的把回合掐掉,再放开调度位。**
         *
         * 原来这里只做了下面那两件"记账"的事:给浏览器补一个终止帧、把注册表这一轮标
         * completed。底下那个 CLI 子进程**还活着、还在往 transcript 追加**。而
         * `finishRun` 随后把 `running` 置 0,下一拍 `listDue` 立刻又能捞到这个任务
         * (`claimRun` 也不再被挡,旧 run 已 completed),于是第二个 `queryClaudeSDK`
         * 带着**同一个 providerSessionId** 起来。
         *
         * 两条历史交错写进同一份 `.jsonl` —— 正是 claude-sdk 里那段 `dv:` 注释描述的
         * "谁也修不回来"的状态。session_mode 为 fixed(路由的默认值)时必然如此。
         *
         * 中止本身可能失败(子进程已经僵死),所以 catch 住只记日志:**放开调度位这件事
         * 不能被它挡住**,否则任务会永远卡在 running。
         */
        try {
          if (sessionId) await abortClaudeRunRef?.(sessionId);
        } catch (abortError) {
          log.warn(
            `[Tasks] 「${task.name}」超时后中止回合失败(子进程可能已僵死):`,
            abortError instanceof Error ? abortError.message : abortError,
          );
        }
        // 悬死的回合可能还开着流 —— 给订阅的浏览器一个终止帧,别让它们转圈到天明。
        chatRunRegistry.completeRunIfCurrent(run, { exitCode: 1, aborted: true });
      }
      throw error;
    }
  } catch (error) {
    status = 'failed';
    detail = error instanceof Error ? error.message : String(error);
    if (error instanceof TaskSkippedError) retryable = false;
    log.error(`[Tasks] 「${task.name}」(${trigger}) 执行失败:`, detail);
    /**
     * 失败要有人知道。
     *
     * **无人值守正是定时任务存在的理由** —— 而在此之前失败只进 console 和运行记录表,
     * 也就是说周一早六点的批量回归连炸三次,团队十点打开页面才发现。
     *
     * 通知是尽力而为的旁路:不 await、不抛。投递失败绝不能反过来影响
     * "这一轮到底算成功还是失败"的记账,那才是调用方关心的事。
     */
    try {
      notifyTaskFailedRef?.({
        userId: task.owner_user_id ?? null,
        sessionId,
        taskName: task.name,
        error: detail,
      });
    } catch (notifyError) {
      log.warn('[Tasks] 失败通知发不出去(不影响任务记账):', notifyError);
    }
  }

  const durationMs = Date.now() - startedAt;
  if (modelFallbackNote) {
    detail = detail ? `${modelFallbackNote};${detail}` : modelFallbackNote;
  }
  if (sessionId) {
    const seconds = Math.round(durationMs / 1000);
    appendReceipt(
      sessionId, status, task,
      status === 'completed' ? `耗时 ${seconds}s${modelFallbackNote ? ` · ${modelFallbackNote}` : ''}` : detail ?? undefined,
    );
  }

  /**
   * hl(09-24 P2-10):**收尾按库里最新的任务算,不用起跑时那份快照。**
   *
   * 运行期间用户可能改了频率 / 时刻 / 启停(PATCH 会重推 next_run_at),原来这里
   * 拿闭包里的旧 `task` 重算并写回 —— 改成 manual 的任务会被写回一个 next_run_at,
   * 下一拍就自动跑一次;改了时刻的任务下一次仍按旧时刻。任务在这段时间被删了
   * (删项目连带删任务)就什么都不写。
   */
  const latest = scheduledTasksDb.getById(task.id);
  if (!latest) {
    log.info(`[Tasks] 「${task.name}」运行期间已被删除,不再写运行记录`);
    return;
  }

  // 下一次时刻从"这次结束"起算 —— 手动触发也顺带校准
  const next = computeNextRunAt(latest, new Date());
  let nextRunAt = latest.enabled && next ? toDbUtc(next) : latest.enabled ? null : latest.next_run_at;

  // dm:调度触发的失败,5 分钟后自动重试一次;连续失败 3 次就停手等正常周期。
  // 手动触发不重试 —— 人正看着,重跑该由他自己决定。
  // hl:跳过类失败(项目不在 / 被中止)也不重试(见 TaskSkippedError)。
  if (status === 'failed' && retryable && trigger === 'schedule' && latest.enabled && next) {
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

export function startTaskScheduler(
  queryClaudeSDK: QueryClaudeSDK,
  deps: {
    abortClaudeRun?: AbortClaudeRun;
    drainPendingSend?: (sessionId: string) => void;
    notifyTaskFailed?: (input: {
      userId: number | null; sessionId: string | null; taskName: string; error: string;
    }) => void;
  } = {},
): void {
  queryClaudeSDKRef = queryClaudeSDK;
  abortClaudeRunRef = deps.abortClaudeRun ?? null;
  drainPendingSendRef = deps.drainPendingSend ?? null;
  notifyTaskFailedRef = deps.notifyTaskFailed ?? null;
  const released = scheduledTasksDb.releaseStaleRunning();
  if (released > 0) log.info(`[Tasks] 松开 ${released} 个上次进程遗留的 running 标记`);

  timer = setInterval(() => {
    try {
      const due = scheduledTasksDb.listDue(nowDbUtc());
      for (const task of due) {
        // executeTask 的 finishRun / listRuns / claimRun 都在它自己的 try 之外,
        // 任何一处抛(库被重入、磁盘错误)就是一个没人接的 rejection —— 在
        // Node 22 下等于整机退出。这里必须自己接住。
        void executeTask(task, 'schedule').catch((error) => {
          log.error(`[Tasks] 任务 ${task.id} 调度执行抛错:`, error);
        });
      }
    } catch (error) {
      log.error('[Tasks] 调度 tick 失败:', error);
    }
  }, TICK_MS);
  log.info('[Tasks] 定时任务调度器已启动(30s 一拍)');
}

export function stopTaskScheduler(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

/** 「立即运行」入口(REST 调):不等 tick,直接执行。 */
export function runTaskNow(taskId: string): { ok: boolean; error?: string } {
  const task = scheduledTasksDb.getById(taskId);
  if (!task) return { ok: false, error: 'not_found' };
  if (task.running) return { ok: false, error: 'already_running' };
  void executeTask(task, 'manual').catch((error) => {
    log.error(`[Tasks] 任务 ${taskId} 手动执行抛错:`, error);
  });
  return { ok: true };
}
