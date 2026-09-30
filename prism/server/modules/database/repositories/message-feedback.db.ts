import { getConnection } from '@/modules/database/connection.js';
import { nativeUuidFromMessageId } from '@/shared/fork-anchor.js';

/**
 * gy:用户对助手回答的反馈(👍/👎 与效果调查卡),技能优化的数据源。表结构与
 * 语义见 `schema.ts` 的 `MESSAGE_FEEDBACK_TABLE_SCHEMA_SQL`。
 *
 * 一人一条回答一行(UNIQUE(message_id, user_id)):改票 / 从调查卡改成 👎 都是 upsert,
 * 不留历史 —— 历史意见对训练没有价值,反而会把同一个人的两次意见算成两条证据。
 */
export type FeedbackSource = 'vote' | 'survey';
export type FeedbackStatus = 'answered' | 'dismissed';

export type MessageFeedbackRow = {
  id: number;
  session_id: string;
  project_id: string | null;
  message_id: string;
  message_uuid: string | null;
  user_id: number;
  source: FeedbackSource;
  verdict: number | null;
  status: FeedbackStatus;
  category: string | null;
  note: string | null;
  expected_output: string | null;
  skill_hint: string | null;
  task_id: string | null;
  created_at: string;
  updated_at: string;
};

export type UpsertFeedbackInput = {
  sessionId: string;
  projectId: string | null;
  messageId: string;
  userId: number;
  source: FeedbackSource;
  /** +1 好 / 0 一般 / -1 差;dismissed 时 null */
  verdict: number | null;
  status: FeedbackStatus;
  category?: string | null;
  note?: string | null;
  expectedOutput?: string | null;
  skillHint?: string | null;
};

export type SkillFeedbackStats = {
  skill: string;
  shown: number;        // 调查卡:answered + dismissed
  answered: number;     // 调查卡答复数
  votes: number;        // 👍/👎 数
  good: number;
  neutral: number;
  bad: number;
  projects: number;
  users: number;
  /** 最近的说明 / 待优化点(非空),最新在前 */
  recentNotes: Array<{ note: string; verdict: number | null; user_id: number; project_id: string | null; updated_at: string }>;
  /** ha(F3-02):按项目分组的答复(只算 answered);用于"某项目连续差、全局好"的提示 */
  byProject: Array<{ project_id: string | null; answered: number; good: number; neutral: number; bad: number }>;
};

const clip = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
};

export const messageFeedbackDb = {
  upsert(input: UpsertFeedbackInput): MessageFeedbackRow {
    const db = getConnection();
    const verdict = input.status === 'dismissed' ? null : input.verdict;
    db.prepare(`
      INSERT INTO message_feedback
        (session_id, project_id, message_id, message_uuid, user_id, source, verdict, status,
         category, note, expected_output, skill_hint, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(message_id, user_id) DO UPDATE SET
        source = excluded.source,
        verdict = excluded.verdict,
        status = excluded.status,
        category = excluded.category,
        note = excluded.note,
        expected_output = excluded.expected_output,
        skill_hint = COALESCE(excluded.skill_hint, message_feedback.skill_hint),
        project_id = COALESCE(excluded.project_id, message_feedback.project_id),
        -- hl(09-24 P2-21):唯一键是 (message_id, user_id),改票时 session_id 也跟着写 ——
        -- 同一个 messageId 换了会话(分叉 / 恢复)不能让一行永远挂在旧会话上。
        session_id = excluded.session_id,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      input.sessionId,
      input.projectId,
      input.messageId,
      nativeUuidFromMessageId(input.messageId),
      input.userId,
      input.source,
      verdict,
      input.status,
      clip(input.category, 64),
      clip(input.note, 2000),
      clip(input.expectedOutput, 8000),
      clip(input.skillHint, 128),
    );
    return messageFeedbackDb.get(input.messageId, input.userId)!;
  },

  get(messageId: string, userId: number): MessageFeedbackRow | null {
    const db = getConnection();
    return (db.prepare('SELECT * FROM message_feedback WHERE message_id = ? AND user_id = ?')
      .get(messageId, userId) as MessageFeedbackRow | undefined) ?? null;
  },

  remove(messageId: string, userId: number): boolean {
    const db = getConnection();
    return db.prepare('DELETE FROM message_feedback WHERE message_id = ? AND user_id = ?')
      .run(messageId, userId).changes > 0;
  },

  /** 一条会话里当前用户的全部反馈(前端据此点亮按钮、不再弹已答过的调查卡)。 */
  listForSessionAndUser(sessionId: string, userId: number): MessageFeedbackRow[] {
    const db = getConnection();
    return db.prepare('SELECT * FROM message_feedback WHERE session_id = ? AND user_id = ? ORDER BY id ASC')
      .all(sessionId, userId) as MessageFeedbackRow[];
  },

  /** 同一人对同一 skill 最近一次被问(答复或跳过)的时间 —— 调查卡冷却用。 */
  lastSurveyAt(userId: number, skillHint: string): string | null {
    const db = getConnection();
    const row = db.prepare(`
      SELECT updated_at FROM message_feedback
       WHERE user_id = ? AND skill_hint = ? AND source = 'survey'
       ORDER BY updated_at DESC LIMIT 1
    `).get(userId, skillHint) as { updated_at: string } | undefined;
    return row?.updated_at ?? null;
  },

  /** 按 skill 聚合:技能卡上的「弹出 / 答复 / 好·一般·差 / 来自 N 项目 M 人」。 */
  statsBySkill(skillHint: string, recentLimit = 20): SkillFeedbackStats {
    const db = getConnection();
    const agg = db.prepare(`
      SELECT
        SUM(CASE WHEN source = 'survey' THEN 1 ELSE 0 END) AS shown,
        SUM(CASE WHEN source = 'survey' AND status = 'answered' THEN 1 ELSE 0 END) AS answered,
        SUM(CASE WHEN source = 'vote' THEN 1 ELSE 0 END) AS votes,
        SUM(CASE WHEN status = 'answered' AND verdict = 1 THEN 1 ELSE 0 END) AS good,
        SUM(CASE WHEN status = 'answered' AND verdict = 0 THEN 1 ELSE 0 END) AS neutral,
        SUM(CASE WHEN status = 'answered' AND verdict = -1 THEN 1 ELSE 0 END) AS bad,
        COUNT(DISTINCT project_id) AS projects,
        COUNT(DISTINCT user_id) AS users
      FROM message_feedback WHERE skill_hint = ?
    `).get(skillHint) as Record<string, number | null>;
    const recent = db.prepare(`
      SELECT note, verdict, user_id, project_id, updated_at FROM message_feedback
       WHERE skill_hint = ? AND status = 'answered' AND note IS NOT NULL AND note != ''
       ORDER BY updated_at DESC, id DESC LIMIT ?
    `).all(skillHint, recentLimit) as SkillFeedbackStats['recentNotes'];
    const byProject = (db.prepare(`
      SELECT project_id, COUNT(*) AS answered,
             SUM(CASE WHEN verdict = 1 THEN 1 ELSE 0 END) AS good,
             SUM(CASE WHEN verdict = 0 THEN 1 ELSE 0 END) AS neutral,
             SUM(CASE WHEN verdict = -1 THEN 1 ELSE 0 END) AS bad
        FROM message_feedback
       WHERE skill_hint = ? AND status = 'answered' AND verdict IS NOT NULL
       GROUP BY project_id ORDER BY answered DESC LIMIT 50
    `).all(skillHint) as Array<Record<string, unknown>>).map((row) => ({
      project_id: (row.project_id as string | null) ?? null,
      answered: Number(row.answered ?? 0), good: Number(row.good ?? 0),
      neutral: Number(row.neutral ?? 0), bad: Number(row.bad ?? 0),
    }));
    return {
      skill: skillHint,
      shown: Number(agg.shown ?? 0),
      answered: Number(agg.answered ?? 0),
      votes: Number(agg.votes ?? 0),
      good: Number(agg.good ?? 0),
      neutral: Number(agg.neutral ?? 0),
      bad: Number(agg.bad ?? 0),
      projects: Number(agg.projects ?? 0),
      users: Number(agg.users ?? 0),
      recentNotes: recent,
      byProject,
    };
  },

  /**
   * ha(P3-01):反馈叠加层的原料 —— 某个 skill 的、答过且有判定的反馈(含好评:好评在 harvest
   * 里是 outcome=success 的证据),可选只要 `since` 之后的。按会话分组在路由层做。
   */
  overlayRows(skillHint: string, sinceIso: string | null, limit = 20_000): MessageFeedbackRow[] {
    const db = getConnection();
    const since = sinceIso ? 'AND updated_at >= ?' : '';
    return db.prepare(`
      SELECT * FROM message_feedback
       WHERE skill_hint = ? AND status = 'answered' AND verdict IS NOT NULL ${since}
       ORDER BY session_id, id LIMIT ?
    `).all(...(sinceIso ? [skillHint, sinceIso, limit] : [skillHint, limit])) as MessageFeedbackRow[];
  },

  /** 所有出现过的 skill 名(技能资产页对照用)。 */
  skillsWithFeedback(): string[] {
    const db = getConnection();
    return (db.prepare("SELECT DISTINCT skill_hint FROM message_feedback WHERE skill_hint IS NOT NULL AND skill_hint != '' ORDER BY skill_hint")
      .all() as Array<{ skill_hint: string }>).map((row) => row.skill_hint);
  },

  /**
   * gz:「来自反馈 · 待入库」—— 答过且带判据(期望结果或待优化点)、还没转成任务的反馈。
   * 好评不进训练(它们没有"要改什么");dismissed 不算答复。
   */
  inbox(skillHint: string | null, limit = 200): MessageFeedbackRow[] {
    const db = getConnection();
    const where = skillHint ? 'AND skill_hint = ?' : '';
    return db.prepare(`
      SELECT * FROM message_feedback
       WHERE status = 'answered' AND verdict IS NOT NULL AND verdict <= 0 AND task_id IS NULL
         AND ((expected_output IS NOT NULL AND expected_output != '') OR (note IS NOT NULL AND note != ''))
         AND skill_hint IS NOT NULL AND skill_hint != '' ${where}
       ORDER BY updated_at DESC, id DESC LIMIT ?
    `).all(...(skillHint ? [skillHint, limit] : [limit])) as MessageFeedbackRow[];
  },

  getByIds(ids: number[]): MessageFeedbackRow[] {
    if (ids.length === 0) return [];
    const db = getConnection();
    return db.prepare(`SELECT * FROM message_feedback WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as MessageFeedbackRow[];
  },

  /** 入库后回填 task_id,收件箱里就不再出现。 */
  markTask(id: number, taskId: string): void {
    const db = getConnection();
    db.prepare('UPDATE message_feedback SET task_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(taskId, id);
  },

  /** 会话彻底清扫时随行删除(进「最近删除」时不动 —— 恢复后反馈还在)。 */
  deleteForSession(sessionId: string): number {
    const db = getConnection();
    return db.prepare('DELETE FROM message_feedback WHERE session_id = ?').run(sessionId).changes;
  },
};
