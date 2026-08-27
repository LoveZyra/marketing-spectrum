import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { NO_SUCH_USER_ID, canViewerSeeSession, projectsDb, sessionMessagesDb, sessionsDb, type VisibilityScope } from '@/modules/database/index.js';
import { isRootUser } from '@/shared/root-users.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type {
  FetchHistoryOptions,
  FetchHistoryResult,
  LLMProvider,
  NormalizedMessage,
  Viewer,
} from '@/shared/types.js';
import { AppError, sliceTailPage } from '@/shared/utils.js';

type CreateAppSessionResult = {
  sessionId: string;
  provider: LLMProvider;
  projectPath: string;
};

type ArchivedSessionListItem = {
  sessionId: string;
  provider: LLMProvider;
  projectId: string | null;
  projectPath: string | null;
  projectDisplayName: string;
  sessionTitle: string;
  createdAt: string | null;
  updatedAt: string | null;
  lastActivity: string | null;
  isProjectArchived: boolean;
};

/** 归档会话列表的默认/最大页大小(E10:原来是一次性全量返回)。 */
const DEFAULT_ARCHIVED_PAGE_SIZE = 200;
const MAX_ARCHIVED_PAGE_SIZE = 500;

/**
 * Viewer → SQL 可见范围。
 *
 * root 不过滤(与项目列表 `visibilityScopeFor` 同口径);拿不到数字 id 的访问者
 * 落到 `NO_SUCH_USER_ID`,判定结果与 JS 侧对 `viewerUserId: null` 完全一致
 * (只看得到显式 public 与公共目录下的无主项目)。
 */
function visibilityScopeOf(viewer: Viewer): VisibilityScope {
  if (isRootUser(viewer.username ?? undefined)) return { kind: 'all' };
  const userId = Number(viewer.userId);
  return { kind: 'user', userId: Number.isFinite(userId) ? userId : NO_SUCH_USER_ID };
}

/**
 * Removes one file if it exists.
 */
async function removeFileIfExists(filePath: string): Promise<boolean> {
  try {
    await fsp.unlink(filePath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/**
 * Archive rows need a stable project label even when the owning project is not
 * part of the active sidebar payload. This lightweight resolver keeps the
 * archive API self-contained while still matching the project's stored display
 * name when one exists.
 */
function resolveProjectDisplayName(
  projectPath: string | null,
  customProjectName: string | null | undefined,
): string {
  const trimmedCustomName = typeof customProjectName === 'string' ? customProjectName.trim() : '';
  if (trimmedCustomName.length > 0) {
    return trimmedCustomName;
  }

  if (!projectPath) {
    return 'Unknown Project';
  }

  return path.basename(projectPath) || projectPath;
}

/**
 * Application service for provider-backed session message operations.
 *
 * Callers pass a provider id and this service resolves the concrete provider
 * class, keeping normalization/history call sites decoupled from implementation
 * file layout.
 */
export const sessionsService = {
  /**
   * Lists provider ids that can load session history and normalize live messages.
   */
  listProviderIds(): LLMProvider[] {
    return providerRegistry.listProviders().map((provider) => provider.id);
  },

  /**
   * Returns app-facing ids for provider runs that are currently processing.
   *
   * This is intentionally status-only: callers that only need sidebar activity
   * indicators should not attach to chat streams or request replayed messages.
   */
  /**
   * 谁能看到这条会话。判定实现在 database 模块,这里只是转出去 —— providers 与
   * websocket 两侧必须用同一份,不能各写一份。
   */
  canViewerSeeSession(sessionId: string, viewer: Viewer): boolean {
    return canViewerSeeSession(sessionId, viewer);
  },

  /**
   * `canViewerSeeSession` 的抛异常版本,给路由用。
   *
   * 统一 404 而不是 403:403 等于确认 "这个 id 是存在的,只是不给你",
   * 对一个可以逐个试的 id 空间来说那是免费的存在性预言机。
   */
  assertViewerCanSeeSession(sessionId: string, viewer: Viewer): void {
    if (!this.canViewerSeeSession(sessionId, viewer)) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }
  },

  listRunningSessions(viewer: Viewer): Array<{
    sessionId: string;
    provider: LLMProvider;
    startedAt: number;
    lastSeq: number;
  }> {
    // 在飞的回合数被 MAX_RUNTIMES 封顶,不分页 —— 前端拿这份去同步"哪些会话正在
    // 跑",少一条就是一个转不动的加载圈。可见性仍逐条判定,但先按 root 短路,
    // 免掉 root 那边每条三次查询。
    const runs = chatRunRegistry.listRunningRuns();
    if (isRootUser(viewer.username ?? undefined)) return runs;
    return runs.filter((run) => this.canViewerSeeSession(run.sessionId, viewer));
  },

  /**
   * Normalizes one provider-native event into frontend session message events.
   */
  normalizeMessage(
    providerName: string,
    raw: unknown,
    sessionId: string | null,
  ): NormalizedMessage[] {
    return providerRegistry.resolveProvider(providerName).sessions.normalizeMessage(raw, sessionId);
  },

  /**
   * Allocates a stable app-facing session id before any provider run happens.
   *
   * This is the entry point of the session gateway: the frontend calls this
   * (via `POST /api/providers/sessions`) when the user starts a brand-new
   * chat, navigates to the returned id immediately, and the id never changes
   * for the lifetime of the conversation. The provider-native id is mapped to
   * this row later, when the provider runtime announces it mid-run.
   */
  createAppSession(
    provider: LLMProvider,
    projectPath: string,
    ownerUserId: number | null = null,
  ): CreateAppSessionResult {
    const normalizedProjectPath = projectPath.trim();
    if (!normalizedProjectPath) {
      throw new AppError('projectPath is required.', {
        code: 'PROJECT_PATH_REQUIRED',
        statusCode: 400,
      });
    }

    const sessionId = randomUUID();
    sessionsDb.createAppSession(sessionId, provider, normalizedProjectPath, ownerUserId);

    return {
      sessionId,
      provider,
      projectPath: normalizedProjectPath,
    };
  },

  /**
   * Fetches persisted history by app session id.
   *
   * Provider and provider-specific lookup hints are resolved from the indexed
   * session metadata in the database. The provider adapter receives the
   * provider-native session id (the one written into transcripts on disk),
   * and every returned message is remapped back to the app session id so
   * provider ids never reach the frontend.
   */
  async fetchHistory(
    sessionId: string,
    options: Pick<FetchHistoryOptions, 'limit' | 'offset'> = {},
  ): Promise<FetchHistoryResult> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    /**
     * 优先读**自己的显示日志**,读不到才回落到 transcript 回放。
     *
     * transcript 是**模型的记忆**,不是对话记录 —— 里面混着子代理 sidechain、
     * `isMeta` 行、技能正文注入、压缩摘要。拿它当显示模型,CLI 每加一种内部行
     * 界面就漏一次。日志这条路径直接把当初推给前端的那条消息原样还回去,
     * 中间**没有任何再解析、再判定的环节**,那一类问题结构上不会再出现。
     *
     * 回落是必须的:这张表是这一轮才有的,之前的会话一行都没有。
     * 老会话继续走 transcript(带着 `transcript-provenance` 的出处判定),
     * 新会话从第一条消息起就走日志。
     */
    const loggedCount = sessionMessagesDb.countForSession(sessionId);
    if (loggedCount > 0) {
      const logged = sessionMessagesDb.listForSession(sessionId);
      const { page, hasMore } = sliceTailPage(logged, options.limit ?? null, options.offset ?? 0);
      return {
        messages: page.map((message) => ({ ...message, sessionId })),
        total: logged.length,
        hasMore,
        offset: options.offset ?? 0,
        limit: options.limit ?? null,
      };
    }

    // App-created sessions that never produced a provider transcript yet
    // (e.g. first message still streaming) simply have no history.
    if (!session.provider_session_id) {
      return {
        messages: [],
        total: 0,
        hasMore: false,
        offset: options.offset ?? 0,
        limit: options.limit ?? null,
      };
    }

    const provider = session.provider as LLMProvider;
    const result = await providerRegistry.resolveProvider(provider).sessions.fetchHistory(sessionId, {
      limit: options.limit ?? null,
      offset: options.offset ?? 0,
      projectPath: session.project_path ?? '',
      providerSessionId: session.provider_session_id,
    });

    return {
      ...result,
      messages: result.messages.map((message) => ({
        ...message,
        sessionId,
      })),
    };
  },



  /**
   * Returns archived sessions with enough project metadata for the sidebar to
   * group, filter, open, and restore them without a per-row follow-up query.
   */
  listArchivedSessions(
    viewer: Viewer,
    options: { limit?: number; offset?: number } = {},
  ): { sessions: ArchivedSessionListItem[]; total: number; hasMore: boolean; limit: number; offset: number } {
    const limit = Math.min(
      Math.max(1, Number.isFinite(options.limit) ? Math.floor(Number(options.limit)) : DEFAULT_ARCHIVED_PAGE_SIZE),
      MAX_ARCHIVED_PAGE_SIZE,
    );
    const offset = Math.max(0, Number.isFinite(options.offset) ? Math.floor(Number(options.offset)) : 0);

    const page = sessionsDb.getArchivedSessionsPage(visibilityScopeOf(viewer), limit, offset);
    const archivedSessions = page.rows;
    const projectCache = new Map<string, ReturnType<typeof projectsDb.getProjectPath>>();

    const sessions = archivedSessions.map((session) => {
      const projectPath = session.project_path?.trim() ? session.project_path : null;
      let project = null;

      if (projectPath) {
        if (!projectCache.has(projectPath)) {
          projectCache.set(projectPath, projectsDb.getProjectPath(projectPath));
        }
        project = projectCache.get(projectPath) ?? null;
      }

      return {
        sessionId: session.session_id,
        provider: session.provider as LLMProvider,
        projectId: project?.project_id ?? null,
        projectPath,
        projectDisplayName: resolveProjectDisplayName(projectPath, project?.custom_project_name),
        sessionTitle: session.custom_name?.trim() || session.session_id,
        createdAt: session.created_at ?? null,
        updatedAt: session.updated_at ?? null,
        lastActivity: session.updated_at ?? session.created_at ?? null,
        isProjectArchived: Boolean(project?.isArchived),
      };
    });

    return {
      sessions,
      total: page.total,
      hasMore: offset + sessions.length < page.total,
      limit,
      offset,
    };
  },

  /**
   * Archives or permanently deletes one persisted session row by id.
   *
   * Soft-delete mirrors the project behavior by toggling `isArchived` so the
   * row disappears from active lists but remains restorable. Force-delete
   * optionally removes the transcript file before deleting the database row.
   */
  async deleteOrArchiveSessionById(
    sessionId: string,
    options: {
      force?: boolean;
      deletedFromDisk?: boolean;
    } = {},
  ): Promise<{ sessionId: string; action: 'archived' | 'deleted'; deletedFromDisk: boolean }> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    if (!options.force) {
      sessionsDb.updateSessionIsArchived(sessionId, true);
      return {
        sessionId,
        action: 'archived',
        deletedFromDisk: false,
      };
    }

    let removedFromDisk = false;
    if (options.deletedFromDisk && session.jsonl_path) {
      removedFromDisk = await removeFileIfExists(session.jsonl_path);
    }

    const deleted = sessionsDb.deleteSessionById(sessionId);
    if (!deleted) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    return {
      sessionId,
      action: 'deleted',
      deletedFromDisk: removedFromDisk,
    };
  },

  /**
   * Restores one archived session back into the active sidebar lists.
   */
  restoreSessionById(sessionId: string): { sessionId: string; isArchived: false } {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    sessionsDb.updateSessionIsArchived(sessionId, false);
    return { sessionId, isArchived: false };
  },

  /**
   * F8:批量归档 / 恢复 / 删除会话。
   *
   * 回收站里攒了几百条时,一条条点是纯粹的体力活;而"全选删除"如果做成一个不
   * 逐条鉴权的接口,就等于给了一把能扫掉别人会话的扫帚。所以这里**逐条**过
   * `canViewerSeeSession`,看不见的既不动也不报错(报错等于告诉调用方那个 id
   * 存在),只在结果里计数。
   *
   * 一条失败不中断其余:批量操作里最糟的结果是"删了一半然后抛异常",调用方
   * 既不知道删了哪些,也不知道该不该重试。逐条 catch,最后给一份账。
   */
  async bulkSessionAction(
    sessionIds: string[],
    action: 'archive' | 'restore' | 'delete',
    viewer: Viewer,
    options: { deletedFromDisk?: boolean } = {},
  ): Promise<{ requested: number; succeeded: string[]; skipped: string[]; failed: string[] }> {
    const succeeded: string[] = [];
    const skipped: string[] = [];
    const failed: string[] = [];

    for (const sessionId of [...new Set(sessionIds)]) {
      if (!this.canViewerSeeSession(sessionId, viewer)) {
        skipped.push(sessionId);
        continue;
      }
      try {
        if (action === 'restore') {
          this.restoreSessionById(sessionId);
        } else {
          await this.deleteOrArchiveSessionById(sessionId, {
            force: action === 'delete',
            deletedFromDisk: action === 'delete' ? options.deletedFromDisk ?? true : false,
          });
        }
        succeeded.push(sessionId);
      } catch {
        failed.push(sessionId);
      }
    }

    return { requested: sessionIds.length, succeeded, skipped, failed };
  },

  /**
   * F8:清空回收站 —— 永久删除**当前访问者看得见的**所有归档会话。
   *
   * `olderThanDays` 可选:只清超过这个天数的,给"保留最近一周"这种用法。
   * 分页取完再删(而不是一次全捞),归档几千条时不会把整张表读进内存。
   */
  async emptyArchivedSessions(
    viewer: Viewer,
    options: { olderThanDays?: number; deletedFromDisk?: boolean } = {},
  ): Promise<{ deleted: number; failed: number }> {
    const cutoff = typeof options.olderThanDays === 'number' && options.olderThanDays > 0
      ? Date.now() - options.olderThanDays * 24 * 60 * 60 * 1000
      : null;

    let deleted = 0;
    let failed = 0;
    // 每轮都从 offset 0 取:删掉一批之后后面的会往前挪,固定翻页反而会跳过条目。
    for (;;) {
      const page = sessionsDb.getArchivedSessionsPage(visibilityScopeOf(viewer), MAX_ARCHIVED_PAGE_SIZE, 0);
      const targets = page.rows.filter((row) => {
        if (cutoff === null) return true;
        const stamp = Date.parse(row.updated_at ?? row.created_at ?? '');
        return Number.isFinite(stamp) && stamp < cutoff;
      });
      if (targets.length === 0) break;

      let progressed = false;
      for (const row of targets) {
        try {
          await this.deleteOrArchiveSessionById(row.session_id, {
            force: true,
            deletedFromDisk: options.deletedFromDisk ?? true,
          });
          deleted += 1;
          progressed = true;
        } catch {
          failed += 1;
        }
      }
      // 一整页全失败就停,别转圈:再来一次拿到的还是同一批。
      if (!progressed) break;
    }

    return { deleted, failed };
  },

  /**
   * Renames one session by id without requiring the caller to pass provider.
   */
  renameSessionById(sessionId: string, summary: string): { sessionId: string; summary: string } {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    sessionsDb.updateSessionCustomName(sessionId, summary);
    return { sessionId, summary };
  },
};
