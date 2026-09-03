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

/**
 * dq:右侧工作面板的数据帧(任务清单 + 产出文件的原料)。
 *
 * 面板此前只从**前端已加载的消息窗口**(首屏尾 20 条)折叠,长会话一刷新,
 * 早前回合的 TodoWrite/TaskCreate/Write 全部不在窗口里 —— 清单与产出凭空
 * 变少。这里从**全量历史**(显示日志优先,老会话回落 transcript 回放,与
 * fetchHistory 同源)把相关工具帧滤出来发给前端;折叠逻辑留在前端一份,
 * 服务端只发原料,不复制规则。
 */
export type SessionWorkFrame = {
  id?: string;
  timestamp?: string;
  /**
   * 'tool' = 工具调用帧(默认);'changed_file' = checkpoint 改动清单里的
   * 一个新增文件(dr) —— Bash/python 写盘没有 Write 帧,这是它们唯一的
   * 落库证据。changed_file 帧的 toolInput 形如 { file_path: 绝对路径 }。
   */
  kind?: 'tool' | 'changed_file';
  toolName: string;
  toolInput: unknown;
  resultContent: string | null;
  resultIsError: boolean;
};

const WORK_TOOL_NAMES: ReadonlySet<string> = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'Write']);

/**
 * 纯函数:从一段 NormalizedMessage 历史里收集工作面板帧。
 * tool_result 是独立行(按 toolId 配对;子代理的 child 行同样在历史里,
 * 一并收 —— 子代理写的文件、立的任务也是这个会话的工作)。
 * changed_files 行(dr 起落库)展开为逐文件的 changed_file 帧:git 相对
 * 路径用帧上的 cwd 拼成绝对路径,与 Write 帧同构、可跨通路去重。
 */
/**
 * ej:**一轮的产出**,按回合归到那条助手回答上。
 *
 * 这是"对话正文下面那张产出卡"的**唯一数据源**。它必须由服务端从**全量显示
 * 日志**算出来,而不能由前端从"当前加载到的消息窗口"现推 —— 重进会话先渲染的
 * 是尾部窗口,窗口起点常落在某一轮工具流中间,前端推出来的结果会随着历史陆续
 * 补齐而变(用户实测:先「产出 2」,过一会儿变「产出 5」;加了截断保护之后变成
 * 先没有、过一会儿才出现)。挂到回合上之后,卡片和消息一起到达、此后不再变。
 */
export type TurnOutputFile = {
  /** 绝对路径 */
  path: string;
  /** 写入行数;算不出来时为 null(界面就不显示这一项) */
  addedLines: number | null;
};

export type CollectedWorkFrames = {
  frames: SessionWorkFrame[];
  /**
   * 助手回答的消息 id → 这一轮写出来的文件。
   *
   * **在帧数截断之前**按全量算好(和 revertedPaths 同一个道理):截断丢的是
   * 载荷里的帧,不该让历史回合的产出卡跟着一起丢。
   */
  turnOutputs: Record<string, TurnOutputFile[]>;
  /**
   * dt:至今仍处于"已回滚"状态的**绝对路径** —— files_reverted 落库后,
   * 之前的产出帧已在本函数内删除,但前端窗口里的旧 Write 工具帧还会把
   * 文件加回来,前端要拿这个集合做最终减法;回滚后重写的文件会从集合里
   * 移除(时序折叠)。
   */
  revertedPaths: string[];
  /** dw:帧数触顶、较早的帧未随本次响应下发(前端据此提示,别装作全都在)。 */
  truncated?: boolean;
};

/**
 * dw:单次响应的帧数上限。
 *
 * 这个接口原本无条件回**整个会话**的工作帧:会话切换一次、每个回合结束再
 * 一次,长会话(几百次 Write + 几百个 Task 事件)每次都要把全量 toolInput
 * 重新序列化下发。工作面板本身没有任何清理机制(不按时间过期、不分页),
 * 所以载荷只会一直涨。
 *
 * 截断保留**尾部**:清单的当前状态、最近的产出都在尾部,越新越要紧。
 * revertedPaths 在截断**之前**按全量算好,所以"某文件已被回滚"这条结论
 * 不会因为截断而丢失。
 */
export const MAX_WORK_FRAMES = 1500;

/** ej:回合产出映射的条数上限 —— 只是路径,比帧轻得多,但也不该无限涨。 */
export const MAX_TURN_OUTPUT_ENTRIES = 500;

/**
 * ek:**单轮**的文件条数上限。
 *
 * 一轮批量任务写出几百个文件是真会发生的(用户那条会话一次三十几个)。卡片本身
 * 到几十行就已经读不动了,再多只是把载荷撑大。超出的部分不进卡片 —— 它们仍在
 * 右侧会话级产出表里,那张表本来就是用来翻的。
 */
export const MAX_FILES_PER_TURN = 50;

function frameFilePath(frame: SessionWorkFrame): string | null {
  const input = frame.toolInput as { file_path?: unknown } | null | undefined;
  return typeof input?.file_path === 'string' ? input.file_path : null;
}

export function collectWorkFrames(messages: readonly NormalizedMessage[]): CollectedWorkFrames {
  const resultByToolId = new Map<string, { content?: string; isError?: boolean }>();
  for (const message of messages) {
    if (message.kind === 'tool_result' && message.toolId) {
      resultByToolId.set(message.toolId, { content: message.content, isError: message.isError });
    }
  }

  const frames: SessionWorkFrame[] = [];
  const reverted = new Set<string>();
  /**
   * 回合归属:写入帧先攒着,**攒到这一轮结束**(下一条用户消息,或日志走完)
   * 才整批挂到该轮**最后一条助手正文**上。
   *
   * ek 修:ej 的写法是"遇到助手正文就挂上去、清空",在真实会话里是错的 ——
   * 一轮长任务里模型会在工具之间不停说话("任务 32 完成。任务 33:"),那些
   * 过渡性正文同样是 `kind:'text' role:'assistant'`,于是产出被挂到了**中间那句**
   * 上;而中间正文在前端会被吸进活动时间轴当 narration 行渲染(见
   * toolGrouping 的 isAbsorbableNarration),根本不是那条独立的回答 —— 卡片就
   * 谁也看不见,只能等前端从窗口现推的兜底路径慢慢补出来(用户实测:"最开始
   * 没有产出文件,要过很久才有")。
   *
   * 前端的判据是"收尾的最终回答后面没有活动,永远保持大正文排版",所以这里
   * 对应的锚点就是**这一轮最后一条助手正文**:记住它,到边界再结算。
   */
  const turnOutputs: Record<string, TurnOutputFile[]> = {};
  let pendingTurnFiles: TurnOutputFile[] = [];
  /** 本轮至今最后一条**有内容的助手正文**的消息 id —— 结算时挂它。 */
  let pendingAnchorId = '';
  let turnCount = 0;
  const flushTurn = () => {
    if (pendingAnchorId && pendingTurnFiles.length > 0 && turnCount < MAX_TURN_OUTPUT_ENTRIES) {
      turnOutputs[pendingAnchorId] = pendingTurnFiles;
      turnCount += 1;
    }
    pendingTurnFiles = [];
    pendingAnchorId = '';
  };
  const notePendingWrite = (absolutePath: string | null, content: unknown) => {
    if (!absolutePath) return;
    if (pendingTurnFiles.length >= MAX_FILES_PER_TURN) return;
    if (pendingTurnFiles.some((file) => file.path === absolutePath)) return;
    const text = typeof content === 'string' ? content : null;
    pendingTurnFiles.push({ path: absolutePath, addedLines: text ? text.split('\n').length : null });
  };
  const dropPendingWrite = (absolutePath: string) => {
    pendingTurnFiles = pendingTurnFiles.filter((file) => file.path !== absolutePath);
    for (const key of Object.keys(turnOutputs)) {
      const kept = turnOutputs[key].filter((file) => file.path !== absolutePath);
      if (kept.length === 0) delete turnOutputs[key];
      else turnOutputs[key] = kept;
    }
  };
  const noteFileFrame = (absolutePath: string | null) => {
    // 回滚后又重新写出来 → 撤销"已回滚"标记,产出恢复。
    if (absolutePath) reverted.delete(absolutePath);
  };

  for (const message of messages) {
    if (message.kind === 'files_reverted') {
      const cwd = typeof message.cwd === 'string' && message.cwd ? message.cwd.replace(/[\\/]+$/, '') : '';
      const paths = Array.isArray(message.paths) ? message.paths : [];
      for (const entry of paths) {
        if (typeof entry !== 'string' || !entry.trim()) continue;
        const absolute = cwd ? `${cwd}/${entry.trim()}` : entry.trim();
        reverted.add(absolute);
        dropPendingWrite(absolute);
        // 时序:删掉此前收集的该文件产出帧;之后的重写会重新入列。
        for (let index = frames.length - 1; index >= 0; index -= 1) {
          if (frameFilePath(frames[index]) === absolute) frames.splice(index, 1);
        }
      }
      continue;
    }

    if (message.kind === 'changed_files') {
      const cwd = typeof message.cwd === 'string' && message.cwd ? message.cwd : '';
      const files = Array.isArray(message.files) ? message.files : [];
      for (const entry of files) {
        const file = entry as { path?: unknown; status?: unknown; untracked?: unknown };
        const relPath = typeof file.path === 'string' ? file.path.trim() : '';
        if (!relPath) continue;
        // 只算新增:修改/删除既有文件不是"产出了一个文件"。
        if (file.status !== 'added' && !file.untracked) continue;
        const absolute = cwd ? `${cwd.replace(/[\\/]+$/, '')}/${relPath}` : relPath;
        noteFileFrame(absolute);
        // Bash / python 写盘没有 Write 帧,checkpoint 的改动清单是它们唯一的证据;
        // 行数无从得知(这里只有路径),界面上就不显示写入量。
        notePendingWrite(absolute, null);
        frames.push({
          id: typeof message.id === 'string' ? `${message.id}::${relPath}` : undefined,
          timestamp: typeof message.timestamp === 'string' ? message.timestamp : undefined,
          kind: 'changed_file',
          toolName: 'Write',
          toolInput: { file_path: absolute },
          resultContent: 'checkpoint',
          resultIsError: false,
        });
      }
      continue;
    }

    // 回合边界。助手正文 = 更新锚点(只记住,不结算 —— 后面可能还有正文);
    // 用户发言 = 上一轮到此为止,先结算再开新一轮。没有锚点的那些产出就不出卡片
    // (它们仍在会话级产出表里,只是没有"这一轮"的落点)。
    if (message.kind === 'text') {
      const messageId = typeof message.id === 'string' ? message.id : '';
      const hasContent = typeof message.content === 'string' && message.content.trim().length > 0;
      if (message.role === 'assistant' && hasContent) {
        if (messageId) pendingAnchorId = messageId;
      } else if (message.role === 'user') {
        flushTurn();
      }
      continue;
    }

    if (message.kind !== 'tool_use') continue;
    const toolName = typeof message.toolName === 'string' ? message.toolName : '';
    if (!WORK_TOOL_NAMES.has(toolName)) continue;
    const paired = message.toolResult
      ?? (message.toolId ? resultByToolId.get(message.toolId) : undefined);
    const frame: SessionWorkFrame = {
      id: typeof message.id === 'string' ? message.id : undefined,
      timestamp: typeof message.timestamp === 'string' ? message.timestamp : undefined,
      toolName,
      toolInput: message.toolInput ?? null,
      resultContent: typeof paired?.content === 'string' ? paired.content : null,
      resultIsError: Boolean(paired?.isError),
    };
    if (toolName === 'Write' && frame.resultContent !== null && !frame.resultIsError) {
      const written = frameFilePath(frame);
      noteFileFrame(written);
      const input = message.toolInput as { content?: unknown } | null | undefined;
      notePendingWrite(written, input?.content);
    }
    frames.push(frame);
  }
  // 日志走完 = 最后一轮的边界。刚跑完的这一轮全靠这一句才有卡片。
  flushTurn();

  if (frames.length > MAX_WORK_FRAMES) {
    return { frames: frames.slice(-MAX_WORK_FRAMES), revertedPaths: [...reverted], turnOutputs, truncated: true };
  }
  return { frames, revertedPaths: [...reverted], turnOutputs };
}

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
      const limit = options.limit ?? null;
      const offset = options.offset ?? 0;

      // dn-O1:带 limit 的分页请求(首屏 / 上翻 / 每轮 complete 的尾窗刷新,
      // 也就是**全部热路径**)改走 SQL 尾页,不再整段读出 + 全量 parse 再切。
      // 活跃回合里每个 durable 帧落库都会打穿指纹缓存,此前每轮刷新都是一次
      // 全量重读 —— 长会话(数千行)一轮省一次整段读盘。
      if (limit !== null) {
        const page = sessionMessagesDb.listTailPage(sessionId, limit, offset);
        return {
          messages: page.messages.map((message) => ({ ...message, sessionId })),
          total: page.total,
          hasMore: page.hasMore,
          offset,
          limit,
        };
      }

      // limit=null 的全量路径(搜索定位 / 加载全部)保持原样,继续吃指纹缓存。
      const logged = sessionMessagesDb.listForSession(sessionId);
      const { page, hasMore } = sliceTailPage(logged, null, offset);
      return {
        messages: page.map((message) => ({ ...message, sessionId })),
        total: logged.length,
        hasMore,
        offset,
        limit,
      };
    }

    // App-created sessions that never produced a provider transcript yet
    // (e.g. first message still streaming) simply have no history.
    if (!session.provider_session_id) {
      // (fetchWorkFrames 也依赖本方法的这条空历史路径。)
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
   * dq:工作面板帧 —— 全量历史(与 fetchHistory 同源:显示日志优先、老会话
   * transcript 回放)滤出 TodoWrite/TaskCreate/TaskUpdate/Write 的 tool_use
   * 行并配好结果。只在会话切换与回合结束各拉一次;全量 parse 有指纹缓存,
   * 空闲期命中,回合结束与尾窗刷新共享同一次重建。
   */
  async fetchWorkFrames(sessionId: string): Promise<CollectedWorkFrames> {
    const { messages } = await sessionsService.fetchHistory(sessionId, { limit: null, offset: 0 });
    return collectWorkFrames(messages);
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
    /**
     * dv:游标按"这一页留下了几条"前进,而不是恒取 offset 0 + 空页即收工。
     *
     * 删掉的条目会让后面的往前挪,所以删成功的那部分不推进游标(下一轮读到的
     * 就是新补上来的);**没删的**(不够旧、或删失败)则留在原位,必须跳过去,
     * 否则:① 带 `olderThanDays` 时,只要最新那一页archived 全是近期的,
     * `targets.length === 0` 就直接 break,后面真正够旧的一条都清不到 ——
     * 清理静默地什么也没做;② 少量删不动的条目会把游标永远钉在原地。
     */
    let offset = 0;
    for (;;) {
      const page = sessionsDb.getArchivedSessionsPage(
        visibilityScopeOf(viewer), MAX_ARCHIVED_PAGE_SIZE, offset,
      );
      if (page.rows.length === 0) break;

      const targets = page.rows.filter((row) => {
        if (cutoff === null) return true;
        const stamp = Date.parse(row.updated_at ?? row.created_at ?? '');
        return Number.isFinite(stamp) && stamp < cutoff;
      });

      let deletedThisPage = 0;
      for (const row of targets) {
        try {
          await this.deleteOrArchiveSessionById(row.session_id, {
            force: true,
            deletedFromDisk: options.deletedFromDisk ?? true,
          });
          deleted += 1;
          deletedThisPage += 1;
        } catch {
          failed += 1;
        }
      }

      // 这一页留下来的条数 = 读到的 - 删掉的;游标跨过它们继续往后。
      offset += page.rows.length - deletedThisPage;
      // 整页读满且一条没删 → 继续翻;不满一页且没删 → 到底了。
      if (deletedThisPage === 0 && page.rows.length < MAX_ARCHIVED_PAGE_SIZE) break;
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
