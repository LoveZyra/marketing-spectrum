import type { Project, ProjectSession } from '../../../types/app';

/**
 * ef:首页空态的「最近会话」—— 跨项目按最后活动时间取前 N 条。
 *
 * 只读 `projects[].sessions`(侧栏已经拉下来的那一份),不另发请求;
 * 项目列表没加载完时就是空数组,首页照常渲染,不出现"加载中"。
 */
export type RecentSessionEntry = {
  id: string;
  title: string;
  projectId: string;
  projectName: string;
  /** ISO 时间串;缺失时为空串(排最后)。 */
  time: string;
  timestamp: number;
  /**
   * 行首状态点(设计稿):`running` 实心 = 这会儿在跑,`approval` 空心 = 等授权。
   * 判据由调用方给(正在跑的会话集合 / 等审批的集合),这里只负责标注。
   */
  status: 'running' | 'approval' | null;
};

const sessionTimestamp = (session: ProjectSession): { time: string; timestamp: number } => {
  const raw = String(session.lastActivity || session.updated_at || session.createdAt || session.created_at || '');
  const timestamp = raw ? new Date(raw).getTime() : Number.NaN;
  return { time: Number.isNaN(timestamp) ? '' : raw, timestamp: Number.isNaN(timestamp) ? 0 : timestamp };
};

export function buildRecentSessions(
  projects: readonly Project[] | null | undefined,
  limit = 3,
  fallbackTitle = '新会话',
  marks: { running?: ReadonlySet<string> | ReadonlyMap<string, unknown>; awaitingApproval?: ReadonlySet<string> } = {},
): RecentSessionEntry[] {
  if (!projects || projects.length === 0 || limit <= 0) return [];
  const entries: RecentSessionEntry[] = [];
  for (const project of projects) {
    for (const session of project.sessions ?? []) {
      if (!session || !session.id) continue;
      const { time, timestamp } = sessionTimestamp(session);
      const id = String(session.id);
      entries.push({
        id,
        title: String(session.summary || session.name || fallbackTitle),
        projectId: project.projectId,
        projectName: project.displayName,
        time,
        timestamp,
        status: marks.awaitingApproval?.has(id)
          ? 'approval'
          : marks.running?.has(id)
            ? 'running'
            : null,
      });
    }
  }
  entries.sort((a, b) => b.timestamp - a.timestamp);
  return entries.slice(0, limit);
}

/** 按当前小时给问候语的 i18n key:早上 / 中午 / 下午 / 晚上。 */
export function greetingKey(hour: number): 'morning' | 'noon' | 'afternoon' | 'evening' {
  if (hour >= 5 && hour < 11) return 'morning';
  if (hour >= 11 && hour < 13) return 'noon';
  if (hour >= 13 && hour < 18) return 'afternoon';
  return 'evening';
}
