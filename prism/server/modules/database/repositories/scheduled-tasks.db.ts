import { getConnection } from '@/modules/database/connection.js';

/**
 * 定时任务表(cj 轮,B 方案)。
 *
 * 频率用**预设枚举**而不是自由 cron:manual / hourly / daily / weekdays /
 * weekly / monthly,配 run_at_* 字段描述具体时刻 —— 覆盖截图里的全部选项,
 * 不引 cron 解析依赖;next_run_at 由 service 的纯函数推算,调度器只做
 * 「enabled 且 next_run_at <= now 且未在跑」的捞取。
 */
export type TaskFrequency = 'manual' | 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly';
export type TaskSessionMode = 'fixed' | 'new';

export interface ScheduledTaskRow {
  id: string;
  name: string;
  instructions: string;
  project_path: string;
  session_mode: TaskSessionMode;
  fixed_session_id: string | null;
  frequency: TaskFrequency;
  run_at_hour: number | null;
  run_at_minute: number | null;
  run_at_weekday: number | null;
  run_at_day: number | null;
  model: string | null;
  permission_mode: string;
  enabled: number;
  owner_user_id: number;
  created_at: string;
  next_run_at: string | null;
  last_run_at: string | null;
  last_run_status: string | null;
  last_run_detail: string | null;
  last_run_duration_ms: number | null;
  running: number;
}

export interface ScheduledTaskRunRow {
  id: number;
  task_id: string;
  trigger_kind: 'schedule' | 'manual';
  status: 'completed' | 'failed';
  started_at: string;
  finished_at: string;
  duration_ms: number;
  detail: string | null;
  session_id: string | null;
}

/**
 * 每个任务保留多少条运行记录。留一个上限是必须的 —— 每小时跑一次的任务
 * 一年就是 8760 行,而详情页永远只看最近几条。0 或负数视为"不清理"。
 */
export function taskRunHistoryLimit(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.PRISM_TASK_RUN_HISTORY ?? '', 10);
  if (!Number.isFinite(parsed)) return 50;
  return parsed;
}

export type ScheduledTaskInsert = Omit<ScheduledTaskRow,
  'created_at' | 'last_run_at' | 'last_run_status' | 'last_run_detail' | 'last_run_duration_ms' | 'running'>;

const COLUMNS = `id, name, instructions, project_path, session_mode, fixed_session_id,
  frequency, run_at_hour, run_at_minute, run_at_weekday, run_at_day, model,
  permission_mode, enabled, owner_user_id, created_at, next_run_at,
  last_run_at, last_run_status, last_run_detail, last_run_duration_ms, running`;

export const scheduledTasksDb = {
  insert(task: ScheduledTaskInsert): void {
    getConnection().prepare(`
      INSERT INTO scheduled_tasks
        (id, name, instructions, project_path, session_mode, fixed_session_id,
         frequency, run_at_hour, run_at_minute, run_at_weekday, run_at_day, model,
         permission_mode, enabled, owner_user_id, next_run_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id, task.name, task.instructions, task.project_path, task.session_mode,
      task.fixed_session_id, task.frequency, task.run_at_hour, task.run_at_minute,
      task.run_at_weekday, task.run_at_day, task.model, task.permission_mode,
      task.enabled, task.owner_user_id, task.next_run_at,
    );
  },

  update(id: string, patch: Partial<Omit<ScheduledTaskRow, 'id' | 'owner_user_id' | 'created_at'>>): boolean {
    const keys = Object.keys(patch);
    if (keys.length === 0) return false;
    const sets = keys.map((key) => `${key} = ?`).join(', ');
    const values = keys.map((key) => (patch as Record<string, unknown>)[key]);
    const info = getConnection().prepare(`UPDATE scheduled_tasks SET ${sets} WHERE id = ?`).run(...values, id);
    return info.changes > 0;
  },

  delete(id: string): boolean {
    const db = getConnection();
    // 运行记录跟着任务走。没开外键约束,所以显式删 —— 否则任务没了,
    // 它的运行记录还占着表,而且再也没有入口能看到。
    return db.transaction(() => {
      db.prepare('DELETE FROM scheduled_task_runs WHERE task_id = ?').run(id);
      return db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id).changes > 0;
    })();
  },

  getById(id: string): ScheduledTaskRow | undefined {
    return getConnection().prepare(`SELECT ${COLUMNS} FROM scheduled_tasks WHERE id = ?`).get(id) as ScheduledTaskRow | undefined;
  },

  listAll(): ScheduledTaskRow[] {
    return getConnection().prepare(`SELECT ${COLUMNS} FROM scheduled_tasks ORDER BY created_at DESC`).all() as ScheduledTaskRow[];
  },

  listByOwner(ownerUserId: number): ScheduledTaskRow[] {
    return getConnection().prepare(`SELECT ${COLUMNS} FROM scheduled_tasks WHERE owner_user_id = ? ORDER BY created_at DESC`).all(ownerUserId) as ScheduledTaskRow[];
  },

  /** 捞出到点该跑的任务(启用、时刻已到、没在跑)。 */
  listDue(nowIso: string): ScheduledTaskRow[] {
    return getConnection().prepare(`
      SELECT ${COLUMNS} FROM scheduled_tasks
      WHERE enabled = 1 AND running = 0 AND next_run_at IS NOT NULL AND next_run_at <= ?
    `).all(nowIso) as ScheduledTaskRow[];
  },

  /** 原子占位:running 0→1 成功才算认领,防调度器与「立即运行」双跑。 */
  claimRun(id: string): boolean {
    return getConnection().prepare('UPDATE scheduled_tasks SET running = 1 WHERE id = ? AND running = 0').run(id).changes > 0;
  },

  /**
   * 收尾:更新任务上的 last_run_* 摘要,并**追加一条运行记录**。
   *
   * 两件事放在一个事务里 —— 摘要和明细对不上的话,详情页顶部说成功、
   * 列表里最新一条说失败,没人知道该信哪个。
   */
  finishRun(id: string, result: {
    status: 'completed' | 'failed';
    detail: string | null;
    durationMs: number;
    nextRunAt: string | null;
    startedAt?: string | null;
    sessionId?: string | null;
    trigger?: 'schedule' | 'manual';
  }): void {
    const db = getConnection();
    db.transaction(() => {
      db.prepare(`
        UPDATE scheduled_tasks
        SET running = 0, last_run_at = datetime('now'), last_run_status = ?,
            last_run_detail = ?, last_run_duration_ms = ?, next_run_at = ?
        WHERE id = ?
      `).run(result.status, result.detail, result.durationMs, result.nextRunAt, id);

      db.prepare(`
        INSERT INTO scheduled_task_runs
          (task_id, trigger_kind, status, started_at, finished_at, duration_ms, detail, session_id)
        VALUES (?, ?, ?, COALESCE(?, datetime('now')), datetime('now'), ?, ?, ?)
      `).run(
        id,
        result.trigger ?? 'schedule',
        result.status,
        result.startedAt ?? null,
        result.durationMs,
        result.detail,
        result.sessionId ?? null
      );

      // 就地裁剪:按 id 倒序留最近 N 条。写入时顺手做,省一个后台清理器。
      const limit = taskRunHistoryLimit();
      if (limit > 0) {
        db.prepare(`
          DELETE FROM scheduled_task_runs
          WHERE task_id = ? AND id NOT IN (
            SELECT id FROM scheduled_task_runs WHERE task_id = ? ORDER BY id DESC LIMIT ?
          )
        `).run(id, id, limit);
      }
    })();
  },

  /** 某个任务的运行记录,最近的在前。 */
  listRuns(taskId: string, limit = 20, offset = 0): { rows: ScheduledTaskRunRow[]; total: number } {
    const db = getConnection();
    const total = (db.prepare('SELECT COUNT(*) AS c FROM scheduled_task_runs WHERE task_id = ?')
      .get(taskId) as { c: number }).c;
    const rows = db.prepare(`
      SELECT id, task_id, trigger_kind, status, started_at, finished_at, duration_ms, detail, session_id
      FROM scheduled_task_runs WHERE task_id = ? ORDER BY id DESC LIMIT ? OFFSET ?
    `).all(taskId, Math.max(1, Math.min(200, limit)), Math.max(0, offset)) as ScheduledTaskRunRow[];
    return { rows, total };
  },

  /** 启动兜底:上次进程死在 running=1 上的任务全部松开。 */
  releaseStaleRunning(): number {
    return getConnection().prepare('UPDATE scheduled_tasks SET running = 0 WHERE running = 1').run().changes;
  },
};
