import type { TFunction } from 'i18next';

import type { LLMProvider, Project, ProjectSession } from '../../../types/app';
import type { ProjectSortOrder, SettingsProject, SessionViewModel, SessionWithProvider } from '../types/types';

export const readProjectSortOrder = (): ProjectSortOrder => {
  try {
    const rawSettings = localStorage.getItem('claude-settings');
    if (!rawSettings) {
      return 'name';
    }

    const settings = JSON.parse(rawSettings) as { projectSortOrder?: ProjectSortOrder };
    return settings.projectSortOrder === 'date' ? 'date' : 'name';
  } catch {
    return 'name';
  }
};

const LEGACY_STARRED_PROJECTS_STORAGE_KEY = 'starredProjects';

/**
 * Reads legacy project stars from localStorage (used only for one-time migration to backend).
 */
export const readLegacyStarredProjectIds = (): string[] => {
  try {
    const saved = localStorage.getItem(LEGACY_STARRED_PROJECTS_STORAGE_KEY);
    if (!saved) {
      return [];
    }

    const parsed = JSON.parse(saved) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((value) => String(value).trim())
      .filter((value) => value.length > 0);
  } catch {
    return [];
  }
};

/**
 * Clears the legacy localStorage stars key after migration to backend completes.
 */
export const clearLegacyStarredProjectIds = () => {
  try {
    localStorage.removeItem(LEGACY_STARRED_PROJECTS_STORAGE_KEY);
  } catch {
    // Keep UI responsive even if storage is unavailable.
  }
};

const getCreatedTimestamp = (session: SessionWithProvider): string => {
  return String(session.createdAt || session.created_at || '');
};

const getUpdatedTimestamp = (session: SessionWithProvider): string => {
  return String(session.lastActivity || '');
};

const getSessionProvider = (session: ProjectSession): LLMProvider => {
  const provider = session.__provider ?? session.provider;
  return typeof provider === 'string' && provider.trim()
    ? provider as LLMProvider
    : 'claude';
};

export const getSessionDate = (session: SessionWithProvider): Date => {
  return new Date(getUpdatedTimestamp(session) || getCreatedTimestamp(session) || 0);
};

export const getSessionName = (session: SessionWithProvider, t: TFunction): string => {
  return session.summary || session.name || t('projects.newSession');
};

export const getSessionTime = (session: SessionWithProvider): string => {
  return getUpdatedTimestamp(session) || getCreatedTimestamp(session);
};

export const createSessionViewModel = (
  session: SessionWithProvider,
  currentTime: Date,
  t: TFunction,
): SessionViewModel => {
  const sessionDate = getSessionDate(session);
  const diffInMinutes = Math.floor((currentTime.getTime() - sessionDate.getTime()) / (1000 * 60));

  return {
    isActive: diffInMinutes < 10,
    sessionName: getSessionName(session, t),
    sessionTime: getSessionTime(session),
    messageCount: Number(session.messageCount || 0),
  };
};

/**
 * 按 project 对象身份缓存派生结果。
 *
 * ## 为什么必须缓存
 *
 * `getAllSessions` 每次都**整份拷贝 + 排序**一个项目的会话,而它被调用的次数远超
 * "每个项目一次":`getProjectLastActivity` 在 `sortProjects` 的**比较器里面**调,
 * 一次排序就是 O(n log n) 次。实测 200 个项目 × 30 会话,一次排序调 1388 次,
 * **单次渲染 45ms**;500 × 40 是 174ms。而侧栏在搜索框每敲一个字都要重渲染 ——
 * 也就是每敲一个字卡 45ms 到 174ms。
 *
 * ## 为什么 WeakMap 键在 project 对象上是对的
 *
 * `useProjectsState` 那一层是**严格不可变**的:`upsertSessionIntoProject` 要么
 * 造一个新的 `Project` 返回,要么原样返回旧对象(没变化时)。所以:
 *
 * - 数据变了 → 新对象 → 缓存自然落空 → 重算(正确);
 * - 数据没变 → 同一个对象 → 命中缓存(这正是我们要的);
 * - 项目从列表里消失 → 没人引用那个对象 → WeakMap 自己放掉(不漏内存)。
 *
 * 换句话说**失效逻辑不是我写的,是对象身份自带的** —— 这比手写一个"什么时候该清缓存"
 * 的判断可靠得多,后者迟早会漏掉一个更新路径。
 *
 * ⚠️ 代价:返回的数组现在是**共享的**。所有调用点必须只读(当前 10 处调用全是
 * `.some` / `.length` / `.find` / `.map`,已逐个核对过)。谁要就地 sort/push 它,
 * 就会污染别人看到的那一份 —— 要改先 `[...sessions]`。
 */
const sessionsCache = new WeakMap<Project, SessionWithProvider[]>();
const lastActivityCache = new WeakMap<Project, Date>();

export const getAllSessions = (project: Project): SessionWithProvider[] => {
  const cached = sessionsCache.get(project);
  if (cached !== undefined) {
    return cached;
  }

  const computed = (project.sessions || []).map((session) => ({
    ...session,
    __provider: getSessionProvider(session),
  })).sort(
    (a, b) => getSessionDate(b).getTime() - getSessionDate(a).getTime(),
  );
  sessionsCache.set(project, computed);
  return computed;
};

export const getProjectLastActivity = (project: Project): Date => {
  const cached = lastActivityCache.get(project);
  if (cached !== undefined) {
    return cached;
  }

  const sessions = getAllSessions(project);
  // 会话已经按时间倒序排好了,取第一条即可 —— 原来这里还要再 reduce 一遍全表,
  // 而它本身就在排序比较器里被反复调用。
  const latest = sessions.length === 0 ? new Date(0) : getSessionDate(sessions[0]);
  lastActivityCache.set(project, latest);
  return latest;
};

export const sortProjects = (
  projects: Project[],
  projectSortOrder: ProjectSortOrder,
): Project[] => {
  const byName = [...projects];

  byName.sort((projectA, projectB) => {
    // Star order now comes from backend `projects.isStarred`.
    const aStarred = Boolean(projectA.isStarred);
    const bStarred = Boolean(projectB.isStarred);

    if (aStarred && !bStarred) {
      return -1;
    }

    if (!aStarred && bStarred) {
      return 1;
    }

    if (projectSortOrder === 'date') {
      return getProjectLastActivity(projectB).getTime() - getProjectLastActivity(projectA).getTime();
    }

    return (projectA.displayName || projectA.projectId).localeCompare(projectB.displayName || projectB.projectId);
  });

  return byName;
};

export const filterProjects = (projects: Project[], searchFilter: string): Project[] => {
  const normalizedSearch = searchFilter.trim().toLowerCase();
  if (!normalizedSearch) {
    return projects;
  }

  return projects.filter((project) => {
    const displayName = (project.displayName || project.projectId).toLowerCase();
    // `project.path`/`fullPath` is the most useful search target now that the
    // folder-derived name is gone; fall back to displayName above.
    const searchPath = (project.path || project.fullPath || '').toLowerCase();
    return displayName.includes(normalizedSearch) || searchPath.includes(normalizedSearch);
  });
};

export const normalizeProjectForSettings = (project: Project): SettingsProject => {
  const fallbackPath =
    typeof project.fullPath === 'string' && project.fullPath.length > 0
      ? project.fullPath
      : typeof project.path === 'string'
        ? project.path
        : '';

  // Legacy SettingsProject still expects a `name` field; use the projectId so
  // downstream consumers that rely on a stable identifier continue to work.
  return {
    name: project.projectId,
    displayName:
      typeof project.displayName === 'string' && project.displayName.trim().length > 0
        ? project.displayName
        : project.projectId,
    fullPath: fallbackPath,
    path:
      typeof project.path === 'string' && project.path.length > 0
        ? project.path
        : fallbackPath,
  };
};
