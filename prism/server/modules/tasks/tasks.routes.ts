import crypto from 'node:crypto';

import express, { type RequestHandler, type Router } from 'express';

import {
  canViewerSeeProjectPath,
  canViewerSeeSession,
  scheduledTasksDb,
  sessionsDb,
  userDb,
  type ScheduledTaskRow,
  type TaskFrequency,
  type TaskSessionMode,
  type VisibilityScope,
} from '@/modules/database/index.js';
import { isRootUser } from '@/shared/root-users.js';
import { assertViewerMayCreateSessionAt, claudeModelCatalog, modelViewerFor, type ModelViewer } from '@/modules/providers/index.js';
import { computeNextRunAt, runTaskNow, serverTimeInfo, toDbUtc } from '@/modules/tasks/services/scheduled-tasks.service.js';

/**
 * 定时任务 REST。
 *
 * 可见性见 `canTouch`:主人、root,以及看得见任务所在项目的人;看 / 改 / 删 / 立即运行
 * 是同一道判据。
 *
 * 「让 Claude 创建」的通道:前端先 `POST /ticket` 领一张票据(绑定当前登录用户,30 分钟有效),
 * 作为隐藏上下文随消息带给会话里的 Claude,由它 `curl -H "X-Prism-Task-Ticket: …" POST /via-ticket`
 * 落任务。全程不暴露用户的登录 token;一张票只能建一个任务(有效期内可撤销它自己建的那个),
 * 过期作废。
 */

type RequestUser = { id: number; username: string };

const readUser = (req: express.Request): RequestUser | null =>
  ((req as express.Request & { user?: RequestUser }).user) ?? null;

/**
 * 谁能碰这个任务 —— 看 / 改 / 删 / 立即运行是同一道判据,不分读写。
 *
 * 判据就是项目可见性:项目分享给谁,任务就跟着给谁,而且是全权。
 * 会话已经是这么做的(`canViewerSeeSession` 原样转发 `canViewerSeeProject`),
 * 任务再造一套就是第三套语义,三套之间的组合会产生说不清的情形 ——
 * 比如"任务分享给了 B,但 B 看不见任务的项目",那 B 点「立即运行」跑在哪?
 *
 * `owner_user_id === user.id` 这一支不能省:任务可能跑在一个还没被扫描进
 * projects 表的路径上,那时项目判定命不中,但主人自己总该碰得到。
 */
const canTouch = (task: ScheduledTaskRow, user: RequestUser | null): boolean => {
  if (!user) return false;
  if (isRootUser(user.username)) return true;
  if (task.owner_user_id === user.id) return true;
  return canViewerSeeProjectPath({ userId: user.id, username: user.username }, task.project_path);
};

/**
 * 任务允许的权限档。
 *
 * 默认仍是 `bypassPermissions`(无人值守任务弹权限框等于永远卡住)。
 * 收白名单是为了健壮性,不是权限:不认识的字符串不能原样塞进 SDK。
 */
const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto']);

/**
 * 任务的 `projectPath` 必须既是合法工作区路径,又对这个人可见。
 *
 * 权限模式默认跳过确认、且可见者全权可改,这条校验因此是唯一的边界。判据直接用会话路由
 * 那份 `assertViewerMayCreateSessionAt`,不在这里另写一份:两份必然漂移,漂出来的缝就是
 * 权限洞,例如同一个已登记项目开得了会话、却建不了定时任务(那份对已登记项目跳过工作区重验),
 * 或把 `validateWorkspacePath` 的原始错误串回显给客户端,让任意登录用户读到服务端配置的工作区根。
 *
 * 返回 null = 通过,字符串 = 拒绝原因;拒绝时一律是同形文案,不回显服务端配置。
 */
async function checkProjectPath(projectPath: string, user: RequestUser): Promise<string | null> {
  try {
    await assertViewerMayCreateSessionAt({ userId: user.id, username: user.username }, projectPath);
    return null;
  } catch (error) {
    // service 抛的是 AppError(404「项目不存在或你没有权限」/ 400「projectPath is required」)。
    // 这里不透传 statusCode:任务路由的三个调用点历史上一律回 400,改状态码会动到
    // 前端的错误分支,而这一轮只想修判据,不想动协议。
    return error instanceof Error ? error.message : '项目不存在或你没有权限';
  }
}

const FREQUENCIES: TaskFrequency[] = ['manual', 'hourly', 'daily', 'weekdays', 'weekly', 'monthly'];
/** 执行指令的字节上限。 */
export const INSTRUCTIONS_MAX_BYTES = 64 * 1024;
const SESSION_MODES: TaskSessionMode[] = ['fixed', 'new'];

type TaskBody = {
  name?: unknown; instructions?: unknown; projectPath?: unknown;
  sessionMode?: unknown; fixedSessionId?: unknown;
  frequency?: unknown; runAtHour?: unknown; runAtMinute?: unknown;
  runAtWeekday?: unknown; runAtDay?: unknown;
  model?: unknown; permissionMode?: unknown; enabled?: unknown;
};

const readInt = (value: unknown): number | null => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) ? parsed : null;
};

/** `viewer` 是任务的主人:模型按他的「可用人员」与私有模型判。 */
function validateBody(body: TaskBody, partial: boolean, viewer?: ModelViewer | null): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const out: Record<string, unknown> = {};
  const name = typeof body.name === 'string' ? body.name.trim() : undefined;
  const instructions = typeof body.instructions === 'string' ? body.instructions.trim() : undefined;
  const projectPath = typeof body.projectPath === 'string' ? body.projectPath.trim() : undefined;

  if (!partial || body.name !== undefined) {
    if (!name) return { ok: false, error: '任务名称不能为空' };
    out.name = name;
  }
  if (!partial || body.instructions !== undefined) {
    if (!instructions) return { ok: false, error: '执行指令不能为空' };
    // 指令本身要有上限:via-ticket 的 256KB 解析上限会被先跑、且更大的全局解析器架空;
    // 而指令每次运行都整段发给模型,几百 KB 只会白花钱。
    if (Buffer.byteLength(instructions, 'utf8') > INSTRUCTIONS_MAX_BYTES) {
      return { ok: false, error: `执行指令过长(上限 ${Math.round(INSTRUCTIONS_MAX_BYTES / 1024)}KB)` };
    }
    out.instructions = instructions;
  }
  if (!partial || body.projectPath !== undefined) {
    if (!projectPath) return { ok: false, error: '必须选择项目' };
    out.project_path = projectPath;
  }
  if (body.sessionMode !== undefined || !partial) {
    const mode = (body.sessionMode ?? 'fixed') as TaskSessionMode;
    if (!SESSION_MODES.includes(mode)) return { ok: false, error: 'sessionMode 无效' };
    out.session_mode = mode;
  }
  if (body.fixedSessionId !== undefined) {
    out.fixed_session_id = typeof body.fixedSessionId === 'string' && body.fixedSessionId.trim()
      ? body.fixedSessionId.trim() : null;
  }
  if (body.frequency !== undefined || !partial) {
    const frequency = (body.frequency ?? 'manual') as TaskFrequency;
    if (!FREQUENCIES.includes(frequency)) return { ok: false, error: 'frequency 无效' };
    out.frequency = frequency;
  }
  /**
   * 时 / 分 / 星期 / 日按范围校验,越界 400。
   *
   * UI 走 NumberInput 夹在范围里,但 via-ticket(Claude 手写 JSON)与 API 直调
   * 可以传 `hour=99`(卡片显示「每天 99:00」,`setHours(99)` 推到 4 天后)、
   * `weekday=7`、`minute=-5`。`null`(清空)仍允许,由 computeNextRunAt 取默认。
   */
  const rangeCheck = (key: 'runAtHour' | 'runAtMinute' | 'runAtWeekday' | 'runAtDay', column: string, min: number, max: number, label: string) => {
    if (body[key] === undefined) return null;
    if (body[key] === null || body[key] === '') { out[column] = null; return null; }
    const value = readInt(body[key]);
    if (value === null || value < min || value > max) return `${label}必须是 ${min}–${max} 的整数`;
    out[column] = value;
    return null;
  };
  const rangeError = rangeCheck('runAtHour', 'run_at_hour', 0, 23, 'runAtHour(小时)')
    ?? rangeCheck('runAtMinute', 'run_at_minute', 0, 59, 'runAtMinute(分钟)')
    ?? rangeCheck('runAtWeekday', 'run_at_weekday', 0, 6, 'runAtWeekday(0=周日…6=周六)')
    ?? rangeCheck('runAtDay', 'run_at_day', 1, 28, 'runAtDay(每月几号)');
  if (rangeError) return { ok: false, error: rangeError };
  if (body.model !== undefined) out.model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null;
  /*
   * 模型要在目录里(上架的)或是别名组:POST / PATCH / via-ticket(Claude 在对话里建任务)
   * 三处共用这里。已存着的下架模型不影响旧任务的读取;运行时由调度器按默认模型回落并写进运行记录。
   */
  if (typeof out.model === 'string' && !claudeModelCatalog.isAllowed(out.model, viewer)) {
    return { ok: false, error: `模型「${out.model}」不在模型目录里(或已下架,或你不在它的可用人员里)` };
  }
  if (body.permissionMode !== undefined) {
    const mode = typeof body.permissionMode === 'string' && body.permissionMode.trim()
      ? body.permissionMode.trim() : 'bypassPermissions';
    if (!PERMISSION_MODES.has(mode)) return { ok: false, error: 'permissionMode 无效' };
    out.permission_mode = mode;
  }
  if (body.enabled !== undefined) out.enabled = body.enabled ? 1 : 0;
  // `sessionMode:"new"` 与 `fixedSessionId` 同时给是自相矛盾的:收下的话,库里会留着一个
  // 永远用不上的会话 id,详情页还会把它当"固定会话"显示。
  if (out.session_mode === 'new' && typeof out.fixed_session_id === 'string' && out.fixed_session_id) {
    return { ok: false, error: 'sessionMode 为 "new" 时不能同时指定 fixedSessionId' };
  }
  return { ok: true, value: out };
}

/**
 * 固定会话必须属于任务的项目。
 *
 * 前端切项目时不清 `fixedSessionId`;服务端不校验的话,任务会 resume 一段挂在别的项目上的
 * 对话,cwd 却是任务项目:每次都按错误的目录跑,或者干脆失败并重试。
 * 建 / 改 / via-ticket 三条入口共用;`projectPath` 取"这次请求里的,没有就取任务上的"。
 */
function validateFixedSessionProject(sessionId: string, projectPath: string): string | null {
  const session = sessionsDb.getSessionById(sessionId);
  if (!session) return '固定会话不存在或无权访问';
  const sessionProject = (session.project_path ?? '').trim();
  if (sessionProject && sessionProject !== projectPath.trim()) {
    return '固定会话不属于这个项目:换一个该项目下的会话,或改成「自动新建并固定」';
  }
  return null;
}

function toWire(task: ScheduledTaskRow) {
  return {
    id: task.id,
    name: task.name,
    instructions: task.instructions,
    projectPath: task.project_path,
    sessionMode: task.session_mode,
    fixedSessionId: task.fixed_session_id,
    frequency: task.frequency,
    runAtHour: task.run_at_hour,
    runAtMinute: task.run_at_minute,
    runAtWeekday: task.run_at_weekday,
    runAtDay: task.run_at_day,
    model: task.model,
    permissionMode: task.permission_mode,
    enabled: Boolean(task.enabled),
    running: Boolean(task.running),
    createdAt: task.created_at,
    nextRunAt: task.next_run_at,
    lastRunAt: task.last_run_at,
    lastRunStatus: task.last_run_status,
    lastRunDetail: task.last_run_detail,
    lastRunDurationMs: task.last_run_duration_ms,
    sessionPath: task.fixed_session_id ? `/session/${task.fixed_session_id}` : null,
  };
}

/**
 * 一次性票据:ticket → { userId, expiresAt, originSessionId, usedTaskId }。
 *
 * 创建一次即焚(usedTaskId 一旦落下,再拿它建第二个必拒);但条目保留到
 * 过期为止 —— TTL 内允许拿同一张票删除它自己刚建的那一个任务
 * (`DELETE /via-ticket/:id`)。这样会话里的 Claude 建错了能当场撤销,而票据
 * 的权限面永远不超过"这一次创建 + 撤销这一次创建"。
 *
 * `originSessionId` = 领票时用户所在的那条对话。会话里的 Claude 只需
 * 写 `"sessionMode":"current"`,服务端就把任务绑到这条对话上,不用让模型
 * 手抄 UUID(抄错一位就会悄悄新开一个会话)。
 */
const claudeTickets = new Map<string, {
  userId: number;
  /** 签票时的 token_version,建任务时比对。 */
  tokenVersion?: number | null;
  expiresAt: number;
  originSessionId: string | null;
  usedTaskId?: string;
  /** 有一个请求正拿这张票建任务(已过同步检查、还没落库)。 */
  claiming?: boolean;
}>();
const TICKET_TTL_MS = 30 * 60 * 1000; // 让 Claude 创建是一场对话,聊满半小时也来得及建

function pruneTickets(): void {
  const now = Date.now();
  for (const [ticket, entry] of claudeTickets) {
    if (entry.expiresAt <= now) claudeTickets.delete(ticket);
  }
}

/**
 * fixedSessionId 必须是这个用户看得见的会话 —— 不验的话,拿到任意会话 id
 * 就能把定时任务的输出(连带用户行)写进别人的对话里。
 * 返回错误文案;null = 通过。
 */
function validateFixedSession(sessionId: string, userId: number, username: string | null): string | null {
  const resolvedUsername = username ?? userDb.getUserById(userId)?.username ?? '';
  if (!canViewerSeeSession(sessionId, { userId, username: resolvedUsername })) {
    return '固定会话不存在或无权访问';
  }
  return null;
}

function applyScheduleAndInsert(value: Record<string, unknown>, ownerUserId: number) {
  const id = `task_${crypto.randomUUID()}`;
  const draft = {
    id,
    name: String(value.name),
    instructions: String(value.instructions),
    project_path: String(value.project_path),
    session_mode: (value.session_mode as TaskSessionMode) ?? 'fixed',
    fixed_session_id: (value.fixed_session_id as string | null) ?? null,
    frequency: (value.frequency as TaskFrequency) ?? 'manual',
    run_at_hour: (value.run_at_hour as number | null) ?? null,
    run_at_minute: (value.run_at_minute as number | null) ?? null,
    run_at_weekday: (value.run_at_weekday as number | null) ?? null,
    run_at_day: (value.run_at_day as number | null) ?? null,
    model: (value.model as string | null) ?? null,
    permission_mode: (value.permission_mode as string) ?? 'bypassPermissions',
    enabled: (value.enabled as number | undefined) ?? 1,
    owner_user_id: ownerUserId,
    next_run_at: null as string | null,
  };
  const next = computeNextRunAt(draft as unknown as ScheduledTaskRow, new Date());
  draft.next_run_at = draft.enabled && next ? toDbUtc(next) : null;
  scheduledTasksDb.insert(draft);
  return scheduledTasksDb.getById(id)!;
}

export function createTasksRouter(dependencies: { authenticateToken: RequestHandler }): Router {
  const router = express.Router();

  /**
   * Claude 直建通道 —— 放在 authenticateToken 之前,自己验票。
   * 票据由已登录用户签发,权限面等同其本人。
   */
  router.post('/via-ticket', express.json({ limit: '256kb' }), async (req, res) => {
    pruneTickets();
    const ticket = String(req.headers['x-prism-task-ticket'] ?? '');
    const entry = ticket ? claudeTickets.get(ticket) : undefined;
    if (!entry || entry.expiresAt <= Date.now()) {
      return res.status(401).json({ error: '票据无效或已过期,请回到定时任务页重新发起「让 Claude 创建」' });
    }
    if (entry.usedTaskId) {
      return res.status(401).json({ error: '这张票据已经建过任务了(一张票只许建一次);要再建请让用户重新发起「让 Claude 创建」' });
    }
    if (entry.claiming) {
      return res.status(409).json({ error: '这张票据正在建任务(同一张票的上一个请求还没返回);一张票只许建一次,请以那个请求的结果为准' });
    }

    const body = { ...((req.body ?? {}) as TaskBody) };
    /**
     * `sessionMode: "current"` 是给会话里的 Claude 的语法糖:绑到领票时用户
     * 所在的那条对话。展开成标准的 fixed + fixed_session_id,DB 里不留新枚举。
     * 没有来源会话(比如从任务页直接领的票)就退回"新开专属会话并固定"。
     */
    if (body.sessionMode === 'current') {
      if (!entry.originSessionId) {
        return res.status(400).json({
          error: '这张票据没有关联的对话,不能用 sessionMode:"current";请改用 "fixed"(新开专属会话)或 "new"(每次新建)',
        });
      }
      body.sessionMode = 'fixed';
      body.fixedSessionId = entry.originSessionId;
    }

    const parsed = validateBody(body, false, modelViewerFor(entry.userId));
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    // 票据的权限面等同签发人,项目路径走和登录路由完全一样的两道门;这条通道是给会话里的
    // Claude 用的,更不能比人工建任务松。签票的人现在还得能用:否则停用 / 驳回 / 退出所有设备之后,
    // 30 分钟内这张票仍能建出一个以他名义、按 bypass 跑的定时任务。
    const ticketUser = userDb.getUsableUser(entry.userId, entry.tokenVersion ?? null) ?? null;
    if (!ticketUser) {
      claudeTickets.delete(ticket);
      return res.status(401).json({ error: '票据已失效(签发人的登录状态已变化),请回到定时任务页重新发起「让 Claude 创建」' });
    }
    // 第一个 await 之前同步占位:路径校验可能让出事件循环(未登记的路径要查文件系统),
    // 同一张票的并发请求会在上面的 `claiming` 检查处被挡下。校验没过就放开占位,票据还能再用。
    entry.claiming = true;
    try {
      const pathError = await checkProjectPath(
        parsed.value.project_path as string,
        { id: entry.userId, username: ticketUser?.username ?? '' },
      );
      if (pathError) return res.status(400).json({ error: pathError });
      const fixedSessionId = parsed.value.fixed_session_id as string | null | undefined;
      if (fixedSessionId) {
        const sessionError = validateFixedSession(fixedSessionId, entry.userId, null)
          ?? validateFixedSessionProject(fixedSessionId, parsed.value.project_path as string);
        if (sessionError) return res.status(400).json({ error: sessionError });
      }
      const task = applyScheduleAndInsert(parsed.value, entry.userId);
      entry.usedTaskId = task.id; // 创建额度烧掉;条目留到过期,供撤销自己这单
      return res.status(201).json({ success: true, task: toWire(task), serverTime: serverTimeInfo() });
    } finally {
      entry.claiming = false;
    }
  });

  /** 同一张票据在 TTL 内可删除它自己刚建的那一个任务 —— 建错当场可撤。 */
  router.delete('/via-ticket/:id', (req, res) => {
    pruneTickets();
    const ticket = String(req.headers['x-prism-task-ticket'] ?? '');
    const entry = ticket ? claudeTickets.get(ticket) : undefined;
    if (!entry || entry.expiresAt <= Date.now()) {
      return res.status(401).json({ error: '票据无效或已过期' });
    }
    if (!entry.usedTaskId || entry.usedTaskId !== req.params.id) {
      return res.status(403).json({ error: '这张票据只能删除它自己创建的那个任务' });
    }
    const task = scheduledTasksDb.getById(entry.usedTaskId);
    if (task && task.owner_user_id === entry.userId) {
      scheduledTasksDb.delete(task.id);
    }
    return res.json({ success: true });
  });

  router.use(dependencies.authenticateToken);

  router.get('/', (req, res) => {
    const user = readUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    // 自己建的 ∪ 跑在自己能看见的项目上的(root 全看)。
    const rows = isRootUser(user.username) ? scheduledTasksDb.listAll() : scheduledTasksDb.listVisibleTo(user.id);
    // 带上服务器时区,前端按它显示「下一次」与表单时刻。
    res.json({ success: true, tasks: rows.map(toWire), serverTime: serverTimeInfo() });
  });

  router.post('/', async (req, res) => {
    const user = readUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const parsed = validateBody((req.body ?? {}) as TaskBody, false, modelViewerFor(user.id, user.username));
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const pathError = await checkProjectPath(parsed.value.project_path as string, user);
    if (pathError) return res.status(400).json({ error: pathError });
    const fixedSessionId = parsed.value.fixed_session_id as string | null | undefined;
    if (fixedSessionId) {
      const sessionError = validateFixedSession(fixedSessionId, user.id, user.username)
        ?? validateFixedSessionProject(fixedSessionId, parsed.value.project_path as string);
      if (sessionError) return res.status(400).json({ error: sessionError });
    }
    const task = applyScheduleAndInsert(parsed.value, user.id);
    res.status(201).json({ success: true, task: toWire(task), serverTime: serverTimeInfo() });
  });

  /**
   * 给「让 Claude 创建」签发一次性票据。
   * `originSessionId`(可选)= 发起时用户所在的对话,校验可见后随票记下,
   * 供 `sessionMode: "current"` 使用。
   */
  router.post('/ticket', (req, res) => {
    const user = readUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    pruneTickets();

    const requested = typeof (req.body as { originSessionId?: unknown } | undefined)?.originSessionId === 'string'
      ? String((req.body as { originSessionId?: string }).originSessionId).trim()
      : '';
    // 只认这个用户看得见的会话;看不见就当没传(退回"新开专属会话"那条路)。
    const originSessionId = requested && !validateFixedSession(requested, user.id, user.username)
      ? requested
      : null;

    const ticket = `tt_${crypto.randomBytes(24).toString('hex')}`;
    const tokenVersion = (req as { user?: { token_version?: number | null } }).user?.token_version ?? 0;
    claudeTickets.set(ticket, { userId: user.id, tokenVersion, expiresAt: Date.now() + TICKET_TTL_MS, originSessionId });
    res.json({ success: true, ticket, expiresInMs: TICKET_TTL_MS, hasOriginSession: Boolean(originSessionId) });
  });

  router.get('/:id', (req, res) => {
    const user = readUser(req);
    const task = scheduledTasksDb.getById(req.params.id);
    if (!task || !canTouch(task, user)) return res.status(404).json({ error: 'Task not found' });
    res.json({ success: true, task: toWire(task), serverTime: serverTimeInfo() });
  });

  /** 运行记录。分页,默认最近 20 条 —— 详情页只铺前几条,展开再往下翻。 */
  router.get('/:id/runs', (req, res) => {
    const user = readUser(req);
    const task = scheduledTasksDb.getById(req.params.id);
    if (!task || !canTouch(task, user)) return res.status(404).json({ error: 'Task not found' });
    const limit = Number.parseInt(String(req.query.limit ?? ''), 10);
    const offset = Number.parseInt(String(req.query.offset ?? ''), 10);
    const { rows, total } = scheduledTasksDb.listRuns(
      task.id,
      Number.isFinite(limit) ? limit : 20,
      Number.isFinite(offset) ? offset : 0
    );
    res.json({
      success: true,
      total,
      runs: rows.map((row) => ({
        id: row.id,
        trigger: row.trigger_kind,
        status: row.status,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        durationMs: row.duration_ms,
        detail: row.detail,
        sessionId: row.session_id,
      })),
    });
  });

  router.patch('/:id', async (req, res) => {
    const user = readUser(req);
    const task = scheduledTasksDb.getById(req.params.id);
    if (!task || !canTouch(task, user)) return res.status(404).json({ error: 'Task not found' });
    // 模型按任务的主人判(root 改别人的任务时也一样:跑的时候用的是主人的身份与 key)。
    const parsed = validateBody((req.body ?? {}) as TaskBody, true, modelViewerFor(task.owner_user_id ?? null));
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    // 改 projectPath 等于把任务搬到另一个项目 —— 必须重新过一次同样的两道门,
    // 否则"先建在可见项目、再改到别处"就是一条绕过。
    if (parsed.value.project_path !== undefined) {
      const pathError = await checkProjectPath(parsed.value.project_path as string, user!);
      if (pathError) return res.status(400).json({ error: pathError });
    }
    const fixedSessionId = parsed.value.fixed_session_id as string | null | undefined;
    // 改 projectPath 但没换会话:原来的固定会话也要对得上新项目。只在改完仍是固定会话模式时才算数:
    // 「每次新建」下调度器不读库里的固定会话,拿它校验会误报「不属于这个项目」。
    const effectiveProjectPath = (parsed.value.project_path as string | undefined) ?? task.project_path;
    const effectiveSessionMode = (parsed.value.session_mode as TaskSessionMode | undefined) ?? task.session_mode;
    const inheritedFixedSessionId = parsed.value.project_path !== undefined
      && parsed.value.fixed_session_id === undefined
      && effectiveSessionMode === 'fixed'
      ? task.fixed_session_id
      : null;
    const effectiveFixedSessionId = fixedSessionId ?? inheritedFixedSessionId;
    if (fixedSessionId) {
      const sessionError = validateFixedSession(fixedSessionId, user!.id, user!.username);
      if (sessionError) return res.status(400).json({ error: sessionError });
    }
    if (effectiveFixedSessionId) {
      const projectError = validateFixedSessionProject(effectiveFixedSessionId, effectiveProjectPath);
      if (projectError) return res.status(400).json({ error: projectError });
    }
    // 部分更新只把 sessionMode 改成 "new" 时,清掉库里留着的固定会话 id,不留下"new + 固定会话"的矛盾组合。
    if (parsed.value.session_mode === 'new' && parsed.value.fixed_session_id === undefined && task.fixed_session_id) {
      parsed.value.fixed_session_id = null;
    }

    scheduledTasksDb.update(task.id, parsed.value as Partial<ScheduledTaskRow>);
    // 频率/时刻/启停任何一项变了都重推下一次时刻
    const updated = scheduledTasksDb.getById(task.id)!;
    const next = updated.enabled ? computeNextRunAt(updated, new Date()) : null;
    scheduledTasksDb.update(task.id, { next_run_at: next ? toDbUtc(next) : null });
    res.json({ success: true, task: toWire(scheduledTasksDb.getById(task.id)!), serverTime: serverTimeInfo() });
  });

  router.delete('/:id', (req, res) => {
    const user = readUser(req);
    const task = scheduledTasksDb.getById(req.params.id);
    if (!task || !canTouch(task, user)) return res.status(404).json({ error: 'Task not found' });
    scheduledTasksDb.delete(task.id);
    res.json({ success: true });
  });

  router.post('/:id/run', (req, res) => {
    const user = readUser(req);
    const task = scheduledTasksDb.getById(req.params.id);
    if (!task || !canTouch(task, user)) return res.status(404).json({ error: 'Task not found' });
    const result = runTaskNow(task.id);
    if (!result.ok) {
      return res.status(result.error === 'already_running' ? 409 : 404).json({ error: result.error });
    }
    res.json({ success: true, sessionPath: task.fixed_session_id ? `/session/${task.fixed_session_id}` : null });
  });

  /**
   * 会话下拉的数据源:该项目下这个用户看得见的会话(名称+id),按最近
   * 活跃排序,最多 100 条。不过滤可见性的话,任何登录用户都能枚举全站会话名。
   *
   * 可见性与项目过滤都在 SQL 里做(`getVisibleSessionsPage`):整表取回再逐行
   * `canViewerSeeSession` 的话,每行都要同步查库,会话一多就把事件循环按住。
   */
  router.get('/options/sessions', (req, res) => {
    const user = readUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const projectPath = String(req.query.projectPath ?? '');
    const scope: VisibilityScope = isRootUser(user.username) ? { kind: 'all' } : { kind: 'user', userId: user.id };
    const { rows } = sessionsDb.getVisibleSessionsPage(scope, 100, 0, { archived: 'exclude', projectPath });
    res.json({
      success: true,
      sessions: rows.map((row) => ({
        sessionId: row.session_id,
        name: row.custom_name || row.session_id.slice(0, 8),
        projectPath: row.project_path,
      })),
    });
  });

  return router;
}
