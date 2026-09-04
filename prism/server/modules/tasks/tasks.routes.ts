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
} from '@/modules/database/index.js';
import { isRootUser } from '@/shared/root-users.js';
import { validateWorkspacePath } from '@/shared/utils.js';
import { computeNextRunAt, runTaskNow, toDbUtc } from '@/modules/tasks/services/scheduled-tasks.service.js';

/**
 * 定时任务 REST(cj 轮)。
 *
 * 可见性:任务只有**主人和 root** 能看/改/删 —— 它带着指令全文与目标项目,
 * 语义等同私人自动化,不做共享。
 *
 * 「让 Claude 创建」的通道:前端先 `POST /ticket` 领一张**一次性票据**
 * (绑定当前登录用户,30 分钟有效),作为隐藏上下文随消息带给会话里的 Claude,
 * `curl -H "X-Prism-Task-Ticket: …" POST /via-ticket` 落任务 —— 全程不暴露
 * 用户的登录 token,票据一次即焚、过期作废。
 */

type RequestUser = { id: number; username: string };

const readUser = (req: express.Request): RequestUser | null =>
  ((req as express.Request & { user?: RequestUser }).user) ?? null;

/**
 * 谁能碰这个任务 —— **看 / 改 / 删 / 立即运行是同一道判据**,不分读写。
 *
 * 判据就是项目可见性:**项目分享给谁,任务就跟着给谁,而且是全权**。
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
 * 收白名单是为了**健壮性**不是权限:以前任意字符串都会被原样塞进 SDK。
 */
const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto']);

/**
 * 任务的 `projectPath` 必须**既是合法工作区路径,又对这个人可见**。
 *
 * 在此之前这里只查了非空字符串 —— 项目路由和文件路由都走 `validateWorkspacePath`
 * (解符号链接、强制 WORKSPACES_ROOT 包含、挡系统目录),唯独任务这条没有。
 * 于是任何登录用户都能建一个 `projectPath: "/"` 的任务,到点以那个 cwd 跑 agent。
 *
 * 权限模式默认跳过确认、且可见者全权可改 —— 这条校验因此是**唯一的边界**,
 * 两道都必须过:路径合法(挡越界)+ 项目可见(挡越权)。
 */
async function checkProjectPath(projectPath: string, user: RequestUser): Promise<string | null> {
  const workspace = await validateWorkspacePath(projectPath);
  if (!workspace.valid) return workspace.error || '项目路径不合法';
  if (!canViewerSeeProjectPath({ userId: user.id, username: user.username }, projectPath)) {
    // 与"项目不存在"同形:不给一个"这个路径存不存在"的探针。
    return '项目不存在或你没有权限';
  }
  return null;
}

const FREQUENCIES: TaskFrequency[] = ['manual', 'hourly', 'daily', 'weekdays', 'weekly', 'monthly'];
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

function validateBody(body: TaskBody, partial: boolean): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
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
  if (body.runAtHour !== undefined) out.run_at_hour = readInt(body.runAtHour);
  if (body.runAtMinute !== undefined) out.run_at_minute = readInt(body.runAtMinute);
  if (body.runAtWeekday !== undefined) out.run_at_weekday = readInt(body.runAtWeekday);
  if (body.runAtDay !== undefined) out.run_at_day = readInt(body.runAtDay);
  if (body.model !== undefined) out.model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null;
  if (body.permissionMode !== undefined) {
    const mode = typeof body.permissionMode === 'string' && body.permissionMode.trim()
      ? body.permissionMode.trim() : 'bypassPermissions';
    if (!PERMISSION_MODES.has(mode)) return { ok: false, error: 'permissionMode 无效' };
    out.permission_mode = mode;
  }
  if (body.enabled !== undefined) out.enabled = body.enabled ? 1 : 0;
  return { ok: true, value: out };
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
 * 创建仍是一次即焚(usedTaskId 一旦落下,再拿它建第二个必拒);但条目保留到
 * 过期为止 —— TTL 内允许拿**同一张票**删除它自己刚建的那一个任务
 * (`DELETE /via-ticket/:id`)。这样会话里的 Claude 建错了能当场撤销,而票据
 * 的权限面永远不超过"这一次创建 + 撤销这一次创建"。
 *
 * `originSessionId` = 领票时用户所在的那条对话(cm 轮)。会话里的 Claude 只需
 * 写 `"sessionMode":"current"`,服务端就把任务绑到这条对话上 —— **不用让模型
 * 手抄 UUID**(抄错一位就悄悄新开了一个会话,正是用户踩到的坑)。
 */
const claudeTickets = new Map<string, {
  userId: number;
  expiresAt: number;
  originSessionId: string | null;
  usedTaskId?: string;
}>();
const TICKET_TTL_MS = 30 * 60 * 1000; // 让 Claude 创建是一场对话,聊满半小时也来得及建

function pruneTickets(): void {
  const now = Date.now();
  for (const [ticket, entry] of claudeTickets) {
    if (entry.expiresAt <= now) claudeTickets.delete(ticket);
  }
}

/**
 * fixedSessionId 必须是这个用户**看得见**的会话 —— 不验的话,拿到任意会话 id
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
   * Claude 直建通道 —— 放在 authenticateToken **之前**,自己验票。
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

    const body = { ...((req.body ?? {}) as TaskBody) };
    /**
     * `sessionMode: "current"` 是给会话里的 Claude 的**语法糖**:绑到领票时用户
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

    const parsed = validateBody(body, false);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    // 票据的权限面等同签发人 —— 项目路径走和登录路由完全一样的两道门。
    // 这条通道是给会话里的 Claude 用的,更不能比人工建任务松。
    const ticketUser = userDb.getUserById(entry.userId) ?? null;
    const pathError = await checkProjectPath(
      parsed.value.project_path as string,
      { id: entry.userId, username: ticketUser?.username ?? '' },
    );
    if (pathError) return res.status(400).json({ error: pathError });
    const fixedSessionId = parsed.value.fixed_session_id as string | null | undefined;
    if (fixedSessionId) {
      const sessionError = validateFixedSession(fixedSessionId, entry.userId, null);
      if (sessionError) return res.status(400).json({ error: sessionError });
    }
    const task = applyScheduleAndInsert(parsed.value, entry.userId);
    entry.usedTaskId = task.id; // 创建额度烧掉;条目留到过期,供撤销自己这单
    return res.status(201).json({ success: true, task: toWire(task) });
  });

  /** 同一张票据在 TTL 内可删除**它自己刚建的那一个**任务 —— 建错当场可撤。 */
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
    res.json({ success: true, tasks: rows.map(toWire) });
  });

  router.post('/', async (req, res) => {
    const user = readUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const parsed = validateBody((req.body ?? {}) as TaskBody, false);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const pathError = await checkProjectPath(parsed.value.project_path as string, user);
    if (pathError) return res.status(400).json({ error: pathError });
    const fixedSessionId = parsed.value.fixed_session_id as string | null | undefined;
    if (fixedSessionId) {
      const sessionError = validateFixedSession(fixedSessionId, user.id, user.username);
      if (sessionError) return res.status(400).json({ error: sessionError });
    }
    const task = applyScheduleAndInsert(parsed.value, user.id);
    res.status(201).json({ success: true, task: toWire(task) });
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
    claudeTickets.set(ticket, { userId: user.id, expiresAt: Date.now() + TICKET_TTL_MS, originSessionId });
    res.json({ success: true, ticket, expiresInMs: TICKET_TTL_MS, hasOriginSession: Boolean(originSessionId) });
  });

  router.get('/:id', (req, res) => {
    const user = readUser(req);
    const task = scheduledTasksDb.getById(req.params.id);
    if (!task || !canTouch(task, user)) return res.status(404).json({ error: 'Task not found' });
    res.json({ success: true, task: toWire(task) });
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
    const parsed = validateBody((req.body ?? {}) as TaskBody, true);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    // 改 projectPath 等于把任务搬到另一个项目 —— 必须重新过一次同样的两道门,
    // 否则"先建在可见项目、再改到别处"就是一条绕过。
    if (parsed.value.project_path !== undefined) {
      const pathError = await checkProjectPath(parsed.value.project_path as string, user!);
      if (pathError) return res.status(400).json({ error: pathError });
    }
    const fixedSessionId = parsed.value.fixed_session_id as string | null | undefined;
    if (fixedSessionId) {
      const sessionError = validateFixedSession(fixedSessionId, user!.id, user!.username);
      if (sessionError) return res.status(400).json({ error: sessionError });
    }

    scheduledTasksDb.update(task.id, parsed.value as Partial<ScheduledTaskRow>);
    // 频率/时刻/启停任何一项变了都重推下一次时刻
    const updated = scheduledTasksDb.getById(task.id)!;
    const next = updated.enabled ? computeNextRunAt(updated, new Date()) : null;
    scheduledTasksDb.update(task.id, { next_run_at: next ? toDbUtc(next) : null });
    res.json({ success: true, task: toWire(scheduledTasksDb.getById(task.id)!) });
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
   * 会话下拉的数据源:该项目下**这个用户看得见的**会话(名称+id),按最近
   * 活跃排序。不过滤可见性的话,任何登录用户都能枚举全站会话名。
   */
  router.get('/options/sessions', (req, res) => {
    const user = readUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const projectPath = String(req.query.projectPath ?? '');
    const viewer = { userId: user.id, username: user.username };
    const rows: Array<{ sessionId: string; name: string; projectPath: string | null }> = [];
    const all = sessionsDb.getAllSessions()
      .filter((row) => !projectPath || row.project_path === projectPath)
      .sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')));
    for (const row of all) {
      if (rows.length >= 100) break;
      if (!canViewerSeeSession(row.session_id, viewer)) continue;
      rows.push({ sessionId: row.session_id, name: row.custom_name || row.session_id.slice(0, 8), projectPath: row.project_path });
    }
    res.json({ success: true, sessions: rows });
  });

  return router;
}
