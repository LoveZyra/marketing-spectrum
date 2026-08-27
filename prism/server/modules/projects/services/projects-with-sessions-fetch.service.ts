import fs from 'node:fs/promises';
import path from 'node:path';

import { projectsDb, scanStateDb, sessionsDb } from '@/modules/database/index.js';
import { sessionSynchronizerService } from '@/modules/providers/index.js';
import { WS_OPEN_STATE, connectedClients } from '@/modules/websocket/index.js';
import { canViewerSeeProject, isPublicWorkspacePath } from '@/shared/project-visibility.js';
import type { RealtimeClientConnection } from '@/shared/types.js';
import { AppError, normalizeProjectPath } from '@/shared/utils.js';

type SessionSummary = {
  id: string;
  provider: string;
  summary: string;
  messageCount: number;
  lastActivity: string;
};

type SessionRepositoryRow = {
  provider: string;
  session_id: string;
  custom_name?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
};

export type ProjectListItem = {
  projectId: string;
  path: string;
  displayName: string;
  fullPath: string;
  isStarred: boolean;
  /**
   * Owning account id. `null` = unclaimed —— 只有 root 看得到,除非它落在
   * PRISM_PUBLIC_WORKSPACE 之下(那时才对所有人可见)。
   */
  ownerUserId: number | null;
  /**
   * 真正"对所有人可见"才为 true:显式 visibility='public'(创建时选的),
   * 或无主 **且** 在公共目录下。前端据此打"公共"徽标。
   */
  isPublic: boolean;
  /** 这个项目是被「指定用户」授权给当前 viewer 的 —— 前端打"共享"徽标。 */
  sharedWithViewer: boolean;
  /**
   * 授权名单人数。owner 和 root 不是接收方,`sharedWithViewer` 恒 false,
   * 没有这个数字他们就看不出一个项目共享过 —— 前端据此打"已共享·N"徽标。
   */
  sharedUserCount: number;
  sessions: SessionSummary[];
  sessionMeta: {
    hasMore: boolean;
    total: number;
  };
};

export type ArchivedProjectListItem = ProjectListItem & {
  isArchived: true;
};

type ProgressUpdate = {
  phase: 'loading' | 'complete';
  current: number;
  total: number;
  currentProject?: string;
};

type GetProjectsWithSessionsOptions = {
  skipSynchronization?: boolean;
  sessionsLimit?: number;
  sessionsOffset?: number;
  /**
   * Scope the list to one account (its own projects plus public ones).
   * `null`/omitted returns everything — that is what root sees.
   */
  visibleTo?: number | null;
  /**
   * 收藏视角:调用者本人的用户 id。与 visibleTo 是两码事 —— root 的
   * visibleTo 是 null(看所有项目),但收藏必须只算 root 自己那份。
   * null/omitted(平台模式)回退老的全局 isStarred 列。
   */
  starsFor?: number | null;
};

type SessionPaginationOptions = {
  limit?: number;
  offset?: number;
};

type ProjectSessionsPageResult = {
  sessions: SessionSummary[];
  total: number;
  hasMore: boolean;
};

export type ProjectSessionsPageApiView = {
  projectId: string;
  sessions: SessionSummary[];
  sessionMeta: {
    hasMore: boolean;
    total: number;
  };
};

const DEFAULT_PROJECT_SESSIONS_PAGE_SIZE = 20;
const MAX_PROJECT_SESSIONS_PAGE_SIZE = 200;

/**
 * Generate better display name from path.
 */
/**
 * `package.json` 里的 name,按 mtime+size 缓存。
 *
 * 项目列表接口会对**每个项目**调一次 generateDisplayName,即 N 次磁盘 IO;
 * 会话监视器每次构建 `session_upserted` 广播也调一次(运行中大约每 2–3 秒一回)。
 * 而 package.json 的 name 基本不变。缓存 null 表示"读过,没有可用的 name",
 * 免得对没有 package.json 的项目反复 ENOENT。
 */
const packageNameCache = new Map<string, { fingerprint: string; name: string | null }>();

async function readPackageNameCached(packageJsonPath: string): Promise<string | null> {
  let fingerprint = 'missing';
  try {
    const stats = await fs.stat(packageJsonPath);
    fingerprint = `${stats.mtimeMs}:${stats.size}`;
  } catch {
    // 不存在:下面缓存 null。
  }

  const cached = packageNameCache.get(packageJsonPath);
  if (cached && cached.fingerprint === fingerprint) {
    return cached.name;
  }

  let name: string | null = null;
  if (fingerprint !== 'missing') {
    try {
      const packageData = await fs.readFile(packageJsonPath, 'utf8');
      const parsed = JSON.parse(packageData) as { name?: string };
      name = typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name : null;
    } catch {
      name = null;
    }
  }

  packageNameCache.set(packageJsonPath, { fingerprint, name });
  return name;
}

export async function generateDisplayName(projectName: string, actualProjectDir: string | null = null): Promise<string> {
  // Use actual project directory if provided, otherwise decode from project name.
  const projectPath = actualProjectDir || projectName.replace(/-/g, '/');

  // Try to read package.json from the project path.
  try {
    const packageJsonPath = path.join(projectPath, 'package.json');
    const cachedName = await readPackageNameCached(packageJsonPath);
    if (cachedName) {
      return cachedName;
    }
    const packageData = await fs.readFile(packageJsonPath, 'utf8');
    const packageJson = JSON.parse(packageData) as { name?: string };

    // Return the name from package.json if it exists.
    if (packageJson.name) {
      return packageJson.name;
    }
  } catch {
    // Fall back to path-based naming if package.json doesn't exist or can't be read.
  }

  // If it starts with /, it's an absolute path.
  if (projectPath.startsWith('/')) {
    const parts = projectPath.split('/').filter(Boolean);
    // Return only the last folder name.
    return parts[parts.length - 1] || projectPath;
  }

  return projectPath;
}

function normalizeSessionPagination(options: SessionPaginationOptions = {}): { limit: number; offset: number } {
  const rawLimit = Number.isFinite(options.limit) ? Math.floor(Number(options.limit)) : DEFAULT_PROJECT_SESSIONS_PAGE_SIZE;
  const rawOffset = Number.isFinite(options.offset) ? Math.floor(Number(options.offset)) : 0;

  return {
    limit: Math.min(Math.max(1, rawLimit), MAX_PROJECT_SESSIONS_PAGE_SIZE),
    offset: Math.max(0, rawOffset),
  };
}

function mapSessionRowToSummary(row: SessionRepositoryRow): SessionSummary {
  return {
    id: row.session_id,
    provider: row.provider,
    summary: row.custom_name || '',
    messageCount: 0,
    lastActivity: row.updated_at ?? row.created_at ?? new Date().toISOString(),
  };
}

function readProjectSessionsIncludingArchived(projectPath: string): ProjectSessionsPageResult {
  const rows = sessionsDb.getSessionsByProjectPathIncludingArchived(projectPath) as SessionRepositoryRow[];

  return {
    sessions: rows.map(mapSessionRowToSummary),
    total: rows.length,
    hasMore: false,
  };
}

/**
 * Reads one paginated project session slice from the DB and groups rows by provider.
 */
function readProjectSessionsPageByPath(
  projectPath: string,
  options: SessionPaginationOptions = {},
): ProjectSessionsPageResult {
  const pagination = normalizeSessionPagination(options);
  const rows = sessionsDb.getSessionsByProjectPathPage(
    projectPath,
    pagination.limit,
    pagination.offset,
  ) as SessionRepositoryRow[];
  const total = sessionsDb.countSessionsByProjectPath(projectPath);

  return {
    sessions: rows.map(mapSessionRowToSummary),
    total,
    hasMore: pagination.offset + rows.length < total,
  };
}

// Broadcast progress to all connected WebSocket clients.
// Uses the unified `kind` envelope like every other websocket frame.
/**
 * Loading progress for the project list.
 *
 * `currentProject` is a real filesystem path, so this is scoped to the account
 * whose request triggered the scan rather than broadcast: otherwise everyone
 * watching sees the paths of projects they are not allowed to list. `visibleTo`
 * null means the caller was root (or had no user context), and the progress
 * goes only to sockets that are also root.
 */
function broadcastProgress(progress: ProgressUpdate, visibleTo: number | null) {
  const message = JSON.stringify({
    kind: 'loading_progress',
    ...progress,
  });

  connectedClients.forEach((client: RealtimeClientConnection) => {
    if (client.readyState !== WS_OPEN_STATE) return;
    // ownerUserId = visibleTo reuses the one visibility rule: a scan scoped to
    // one account reaches that account (and root); an unscoped scan reaches
    // only root.
    if (!canViewerSeeProject({
      ownerUserId: visibleTo,
      viewerUserId: client.prismUserId,
      viewerUsername: client.prismUsername,
    })) return;

    client.send(message);
  });
}

/**
 * 项目列表请求前的会话同步 —— 带节流。
 *
 * 原来每次 `/api/projects` 都无条件 `synchronizeSessions()`,而那是对整个
 * `~/.claude/projects` 的递归 readdir + 逐 jsonl 串行 stat,量级是**全体用户**的
 * 会话文件数,不是当前调用者的。而原生 watcher 一直在实时把库刷新,所以两次扫描
 * 之间的那次全量走盘几乎全是冗余。节流窗口内跳过,把新鲜度交给 watcher。
 *
 * 首次(getLastScannedAt 为 null)或距上次扫描超过窗口才真扫。
 */
const SYNC_THROTTLE_MS = 10_000;

async function maybeSynchronizeSessions(): Promise<void> {
  const last = scanStateDb.getLastScannedAt();
  if (last && Date.now() - last.getTime() < SYNC_THROTTLE_MS) {
    return; // watcher 已经在维护库,窗口内不重复全量走盘
  }
  await sessionSynchronizerService.synchronizeSessions();
}

/**
 * Reads all projects from DB and returns normalized session summaries.
 */
export async function getProjectsWithSessions(
  options: GetProjectsWithSessionsOptions = {}
): Promise<ProjectListItem[]> {
  if (!options.skipSynchronization) {
    await maybeSynchronizeSessions();
  }

  const projectRows = projectsDb.getProjectPaths(options.visibleTo ?? null) as Array<{
    project_id: string;
    project_path: string;
    custom_project_name?: string | null;
    isStarred?: number;
    owner_user_id?: number | null;
    visibility?: string | null;
  }>;
  const totalProjects = projectRows.length;
  const projects: ProjectListItem[] = [];
  let processedProjects = 0;

  // 一次取全调用者的收藏集合,循环里 O(1) 判定。
  const starredSet = options.starsFor != null
    ? new Set(projectsDb.getStarredProjectIdsForUser(options.starsFor))
    : null;

  /*
   * E7:项目列表原来每个项目三次查询(首页会话 / 会话计数 / 授权名单),
   * 30 个项目就是 90 次 prepare+执行 —— 典型 N+1,而且全在**首屏那次请求**里。
   * 这里先批量取三份,循环里只做内存查表:
   *   - 会话首页:窗口函数一次取每个项目的前 N 条(仅 offset=0,即列表的默认
   *     形态;翻页仍走单项目分页,不为少见路径把 SQL 复杂化);
   *   - 会话计数:一次 GROUP BY;
   *   - 授权名单:一次 IN。
   * 三次固定查询取代 3N 次。
   */
  const pagination = normalizeSessionPagination({
    limit: options.sessionsLimit,
    offset: options.sessionsOffset,
  });
  const canBatchSessions = pagination.offset === 0 && projectRows.length > 0;
  const projectPaths = projectRows.map((row) => row.project_path);
  const batchedSessions = canBatchSessions
    ? sessionsDb.getFirstSessionsForProjectPaths(projectPaths, pagination.limit)
    : null;
  const batchedCounts = projectRows.length > 0
    ? sessionsDb.countSessionsByProjectPaths(projectPaths)
    : new Map<string, number>();
  const batchedShares = projectRows.length > 0
    ? projectsDb.getSharedUserIdsForProjects(projectRows.map((row) => row.project_id))
    : new Map<string, number[]>();

  for (const row of projectRows) {
    processedProjects += 1;

    const projectId = row.project_id;
    const projectPath = row.project_path;

    broadcastProgress({
      phase: 'loading',
      current: processedProjects,
      total: totalProjects,
      currentProject: projectPath,
    }, options.visibleTo ?? null);

    const displayName =
      row.custom_project_name && row.custom_project_name.trim().length > 0
        ? row.custom_project_name
        : await generateDisplayName(path.basename(projectPath) || projectPath, projectPath);

    const sessionsPage = batchedSessions
      ? (() => {
        const rows = batchedSessions.get(normalizeProjectPath(projectPath)) ?? [];
        const total = batchedCounts.get(normalizeProjectPath(projectPath)) ?? rows.length;
        return {
          sessions: rows.map(mapSessionRowToSummary),
          total,
          hasMore: rows.length < total,
        };
      })()
      : readProjectSessionsPageByPath(projectPath, {
        limit: options.sessionsLimit,
        offset: options.sessionsOffset,
      });

    // 授权名单来自上面那次批量 IN 查询,喂两个字段(是否授权给我 + 人数)。
    const sharedUserIds = batchedShares.get(row.project_id) ?? [];

    projects.push({
      projectId,
      path: projectPath,
      displayName,
      fullPath: projectPath,
      isStarred: starredSet ? starredSet.has(projectId) : Boolean(row.isStarred),
      ownerUserId: row.owner_user_id ?? null,
      // 公共 = 创建时显式选的 public,或(存量语义)无主且在公共目录下。
      isPublic: row.visibility === 'public'
        || ((row.owner_user_id ?? null) === null && isPublicWorkspacePath(projectPath)),
      // 这个项目是被指定授权给当前 viewer 的(非本人、非公共,靠 project_shares 可见)。
      sharedWithViewer: options.visibleTo != null
        && (row.owner_user_id ?? null) !== options.visibleTo
        && sharedUserIds.includes(options.visibleTo),
      sharedUserCount: sharedUserIds.length,
      sessions: sessionsPage.sessions,
      sessionMeta: {
        hasMore: sessionsPage.hasMore,
        total: sessionsPage.total,
      },
    });
  }

  broadcastProgress({
    phase: 'complete',
    current: totalProjects,
    total: totalProjects,
  }, options.visibleTo ?? null);

  return projects;
}

/**
 * Reads archived projects from DB and includes every session row for each
 * project path, because an archived workspace should surface all preserved
 * conversation history in the archive view regardless of each session's flag.
 */
export async function getArchivedProjectsWithSessions(
  options: Pick<GetProjectsWithSessionsOptions, 'skipSynchronization' | 'visibleTo' | 'starsFor'> = {},
): Promise<ArchivedProjectListItem[]> {
  if (!options.skipSynchronization) {
    await maybeSynchronizeSessions();
  }

  const projectRows = projectsDb.getArchivedProjectPaths(options.visibleTo ?? null) as Array<{
    project_id: string;
    project_path: string;
    custom_project_name?: string | null;
    isStarred?: number;
    owner_user_id?: number | null;
    visibility?: string | null;
  }>;

  const archivedProjects: ArchivedProjectListItem[] = [];

  const starredSet = options.starsFor != null
    ? new Set(projectsDb.getStarredProjectIdsForUser(options.starsFor))
    : null;

  for (const row of projectRows) {
    const displayName =
      row.custom_project_name && row.custom_project_name.trim().length > 0
        ? row.custom_project_name
        : await generateDisplayName(path.basename(row.project_path) || row.project_path, row.project_path);

    const sessionsPage = readProjectSessionsIncludingArchived(row.project_path);
    const sharedUserIds = projectsDb.getProjectSharedUserIds(row.project_id);

    archivedProjects.push({
      projectId: row.project_id,
      path: row.project_path,
      displayName,
      fullPath: row.project_path,
      isStarred: starredSet ? starredSet.has(row.project_id) : Boolean(row.isStarred),
      ownerUserId: row.owner_user_id ?? null,
      isPublic: row.visibility === 'public'
        || ((row.owner_user_id ?? null) === null && isPublicWorkspacePath(row.project_path)),
      sharedWithViewer: options.visibleTo != null
        && (row.owner_user_id ?? null) !== options.visibleTo
        && sharedUserIds.includes(options.visibleTo),
      sharedUserCount: sharedUserIds.length,
      isArchived: true,
      sessions: sessionsPage.sessions,
      sessionMeta: {
        hasMore: sessionsPage.hasMore,
        total: sessionsPage.total,
      },
    });
  }

  return archivedProjects;
}

/**
 * Loads one paginated session slice for a specific project id.
 */
export async function getProjectSessionsPage(
  projectId: string,
  options: SessionPaginationOptions = {},
): Promise<ProjectSessionsPageApiView> {
  const projectRow = projectsDb.getProjectById(projectId);
  if (!projectRow) {
    throw new AppError(`Project "${projectId}" was not found.`, {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }

  const sessionsPage = readProjectSessionsPageByPath(projectRow.project_path, options);
  return {
    projectId: projectRow.project_id,
    sessions: sessionsPage.sessions,
    sessionMeta: {
      hasMore: sessionsPage.hasMore,
      total: sessionsPage.total,
    },
  };
}
