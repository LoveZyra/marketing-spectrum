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
    return getConnection().prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id).changes > 0;
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

  finishRun(id: string, result: { status: string; detail: string | null; durationMs: number; nextRunAt: string | null }): void {
    getConnection().prepare(`
      UPDATE scheduled_tasks
      SET running = 0, last_run_at = datetime('now'), last_run_status = ?,
          last_run_detail = ?, last_run_duration_ms = ?, next_run_at = ?
      WHERE id = ?
    `).run(result.status, result.detail, result.durationMs, result.nextRunAt, id);
  },

  /** 启动兜底:上次进程死在 running=1 上的任务全部松开。 */
  releaseStaleRunning(): number {
    return getConnection().prepare('UPDATE scheduled_tasks SET running = 0 WHERE running = 1').run().changes;
  },
};
