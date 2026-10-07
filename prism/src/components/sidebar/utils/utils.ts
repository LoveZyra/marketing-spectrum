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
 * 必须缓存:`getAllSessions` 要把一个项目的会话整份拷贝 + 排序,而 `getProjectLastActivity`
 * 在 `sortProjects` 的比较器里面调,一次排序就是 O(n log n) 次。200 个项目 × 30 会话时
 * 不缓存单次渲染约 45ms,而侧栏在搜索框每敲一个字都要重渲染。
 *
 * 键在 project 对象上是对的:`useProjectsState` 那一层严格不可变,`upsertSessionIntoProject`
 * 要么返回新的 `Project`,要么原样返回旧对象。于是数据变了 → 新对象 → 缓存落空重算;
 * 没变 → 命中;项目从列表消失 → WeakMap 自己放掉。失效由对象身份保证,
 * 比手写"什么时候该清缓存"可靠,后者迟早会漏掉一个更新路径。
 *
 * 代价:返回的数组是共享的,调用点必须只读(只用 `.some` / `.length` / `.find` / `.map` 之类)。
 * 要就地 sort / push 先 `[...sessions]`,否则会污染别人看到的那一份。
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
  // 会话已按时间倒序排好,取第一条即可。这个函数在排序比较器里被反复调用,
  // 不要再对全表 reduce 一遍。
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
