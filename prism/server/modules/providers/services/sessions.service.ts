import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  NO_SUCH_USER_ID,
  auditLogDb,
  canViewerManageSession,
  canViewerSeeSession,
  projectsDb,
  sessionMessagesDb,
  sessionTrashDb,
  sessionsDb,
  type AuditEvent,
  type SessionTrashRow,
  type TrashDeletedVia,
  type VisibilityScope,
} from '@/modules/database/index.js';
import { isRootUser } from '@/shared/root-users.js';
import { createLogger } from '@/shared/logger.js';
import {
  chatRunRegistry,
  currentConversationHolder,
  hasPendingSendForSession,
  prepareSessionRemovedBroadcast,
  broadcastSessionRestored,
} from '@/modules/websocket/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import {
  cancelStrayCheck,
  moveTranscriptToTrash,
  purgeTrashFiles,
  restoreTranscriptFromTrash,
  scheduleStrayCheck,
  getTrashRetentionDays,
} from '@/modules/providers/services/session-trash.service.js';
import type {
  FetchHistoryOptions,
  FetchHistoryResult,
  LLMProvider,
  NormalizedMessage,
  Viewer,
} from '@/shared/types.js';
import { AppError, sliceTailPage } from '@/shared/utils.js';

const log = createLogger('providers');

/**
 * gk:删除路径上"谁在做"。`Viewer` 之外多带 ip / user-agent,只为审计。
 * 清扫器这类没有人的调用传 null。
 */
export type SessionActor = {
  userId: number | string | null;
  username: string | null;
  ip?: string | null;
  userAgent?: string | null;
};

/**
 * gk:删之前先收掉这条会话的常驻 runtime —— 由组合根注入(claude-sdk 不归这个模块管)。
 *
 * 返回 `released: false` 时删除**拒绝**:正跑着的进程留着,行和文件就不能动。
 * 没接线时视为"没有 runtime 要收"(单测、以及不带 SDK 的部署)。
 */
type RuntimeReleaser = (providerSessionId: string) => Promise<{ released: boolean; reason?: string }>;
let runtimeReleaser: RuntimeReleaser | null = null;
export function setSessionRuntimeReleaser(releaser: RuntimeReleaser | null): void {
  runtimeReleaser = releaser;
}

/** 审计 detail 的 JSON 形状 —— 前端 `AuditLogList` 按它渲染成人话。 */
export type SessionAuditDetail = {
  entry: TrashDeletedVia | 'restore' | 'purge';
  sessionId?: string;
  sessionName?: string | null;
  projectPath?: string | null;
  projectName?: string | null;
  lastActivity?: string | null;
  transcriptMoved?: boolean;
  transcriptRestored?: boolean;
  count?: number;
  names?: string[];
  reason?: string;
};

function actorFields(actor: SessionActor | null | undefined) {
  const userId = actor && actor.userId !== null && actor.userId !== undefined && Number.isFinite(Number(actor.userId))
    ? Number(actor.userId)
    : null;
  return {
    userId,
    username: actor?.username ?? null,
    ip: actor?.ip ?? null,
    userAgent: actor?.userAgent ?? null,
  };
}

function recordSessionAudit(
  event: AuditEvent,
  actor: SessionActor | null | undefined,
  detail: SessionAuditDetail,
  targetUserId: number | null,
  outcome: 'success' | 'failure' = 'success',
): void {
  auditLogDb.record({
    ...actorFields(actor),
    event,
    outcome,
    detail: JSON.stringify(detail),
    targetUserId,
  });
}

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
  /**
   * fj:上限改成保留**最新**的若干轮,与 `frames` 的尾部截断同向。
   *
   * 原来是 `turnCount < MAX_TURN_OUTPUT_ENTRIES` —— 消息从旧到新遍历,计数一旦
   * 到顶,后面所有轮都不再写入。方向和帧截断正好相反,于是长会话里"越老的回合
   * 越有产出卡,最近刚跑完的这几轮反而什么都没有",而 `:255` 的注释说的正是
   * 最新那一轮最要紧。(`dropPendingWrite` 还会 delete 键却不回退 `turnCount`,
   * 实际能挂上的轮数比上限更少。)
   *
   * 现在满了就淘汰最早的那个键(Map/对象的键序就是插入序),先进先出。
   */
  const flushTurn = () => {
    if (pendingAnchorId && pendingTurnFiles.length > 0) {
      turnOutputs[pendingAnchorId] = pendingTurnFiles;
      turnCount += 1;
      const keys = Object.keys(turnOutputs);
      if (keys.length > MAX_TURN_OUTPUT_ENTRIES) {
        delete turnOutputs[keys[0]];
      }
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

/** gk:最近删除列表里的一条(给前端)。 */
export type TrashedSessionListItem = {
  sessionId: string;
  provider: LLMProvider;
  sessionTitle: string;
  projectPath: string | null;
  projectDisplayName: string;
  projectExists: boolean;
  lastActivity: string | null;
  messageCount: number;
  deletedAt: string;
  deletedBy: string | null;
  deletedVia: string;
  transcriptKept: boolean;
  /** 保留期到点会被清扫的时刻(retentionDays = 0 时为 null:永不自动清)。 */
  purgeAt: string | null;
  canRestore: boolean;
};

/** root / 项目 owner / 删除者本人 可以恢复。 */
function canRestoreTrashed(row: SessionTrashRow, viewer: Viewer): boolean {
  if (isRootUser(viewer.username ?? undefined)) return true;
  if (viewer.userId === null || viewer.userId === undefined) return false;
  const viewerId = String(viewer.userId);
  if (row.deleted_by_user_id !== null && String(row.deleted_by_user_id) === viewerId) return true;
  const liveProject = row.project_path ? projectsDb.getProjectPath(row.project_path) : null;
  const owner = liveProject ? liveProject.owner_user_id : row.project_owner_user_id;
  return owner !== null && owner !== undefined && String(owner) === viewerId;
}

function toTrashedListItem(row: SessionTrashRow, viewer: Viewer, retentionDays: number): TrashedSessionListItem {
  const liveProject = row.project_path ? projectsDb.getProjectPath(row.project_path) : null;
  const deletedAtMs = Date.parse(row.deleted_at);
  const purgeAt = retentionDays > 0 && Number.isFinite(deletedAtMs)
    ? new Date(deletedAtMs + retentionDays * 24 * 60 * 60 * 1000).toISOString()
    : null;
  return {
    sessionId: row.session_id,
    provider: row.provider as LLMProvider,
    sessionTitle: row.custom_name?.trim() || row.session_id,
    projectPath: row.project_path,
    projectDisplayName: resolveProjectDisplayName(row.project_path, liveProject?.custom_project_name ?? row.project_display_name),
    projectExists: liveProject !== null,
    lastActivity: row.updated_at ?? row.created_at ?? null,
    messageCount: row.message_count,
    deletedAt: row.deleted_at,
    deletedBy: row.deleted_by_username,
    deletedVia: row.deleted_via,
    transcriptKept: row.trash_jsonl_path !== null,
    purgeAt,
    canRestore: canRestoreTrashed(row, viewer),
  };
}

/**
 * Application service for provider-backed session message operations.
 *
 * Callers pass a provider id and this service resolves the concrete provider
 * class, keeping normalization/history call sites decoupled from implementation
 * file layout.
 */
/**
 * F37:**页边界不许把一次工具调用和它的结果拆开** —— 往前挪,而不是往后丢。
 *
 * ## 事故
 *
 * 分页按原始事件切,而工具调用与它的结果是两条独立事件。边界正好落在中间时,
 * 这一页的第一条就是一个找不到 `tool_use` 的结果。前端为此专门写了"有 toolId
 * 却找不到调用就跳过渲染"的分支,于是那条结果**看不见**,上一页里对应的调用
 * 显示成"没有结果"。
 *
 * fj 的处理是**把那几条丢掉**(最多 8 条)。注释当时写的是"边界往前挪几条,
 * 把 tool_use 一起带进来",而代码做的是相反的事 —— 止血,不是修好。而且丢掉
 * 有一个不明显的代价:调用方按**服务端返回的条数**推进 offset,丢掉几条就意味着
 * 游标少走几格,下一页的窗口与这一页重叠,去重之后净增可能是 0 —— 上翻从此
 * 卡在同一个位置(fm 那轮在客户端把它识别成 `stalled` 并停下,但内容还是取不到)。
 *
 * ## 做法
 *
 * 往**更早**的方向扩边界,把缺的 `tool_use` 一起带进这一页。这对游标是自洽的:
 * `offset` 按返回条数推进,而窗口起点也相应前移,下一页正好接上,不重叠也不跳过。
 *
 * 上限 `MAX_GROUP_LOOKBACK`:一轮里调用与结果是紧邻的,挪太多等于把分页削掉。
 * 超过上限还配不上对(极少数畸形历史),退回"丢掉页首孤儿"的老行为 ——
 * 那时宁可少渲染几行,也不要把一整页拉成没有边界。
 */
const MAX_GROUP_LOOKBACK = 24;

/** 一条消息的 toolId(没有就是 null)。 */
function toolIdOf(message: NormalizedMessage): string | null {
  const id = (message as { toolId?: unknown }).toolId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * 这一页开头有几条 `tool_result` 是配不上对的 —— 需要从更早的行里补回多少条。
 *
 * `older` 是紧邻这一页、**更早**的那些行(oldest-first);返回要从 `older`
 * 末尾取几条拼到页首。取不到(超出上限 / older 不够)时返回 0,由调用方
 * 退回丢弃策略。
 */
export function lookbackForToolGroups(
  older: NormalizedMessage[],
  page: NormalizedMessage[],
): number {
  const missing = new Set<string>();
  for (const message of page) {
    if (message.kind !== 'tool_result') break;   // 只看页首连续那一段
    const toolId = toolIdOf(message);
    if (toolId) missing.add(toolId);
  }
  if (missing.size === 0) return 0;

  // 页内自己就有的调用不算缺(同一页里 result 在前、use 在后是不可能的,
  // 但历史里出现过乱序,判一次比假设便宜)。
  for (const message of page) {
    if (message.kind === 'tool_use') {
      const toolId = toolIdOf(message);
      if (toolId) missing.delete(toolId);
    }
  }
  if (missing.size === 0) return 0;

  for (let taken = 1; taken <= Math.min(older.length, MAX_GROUP_LOOKBACK); taken += 1) {
    const candidate = older[older.length - taken];
    if (candidate.kind === 'tool_use') {
      const toolId = toolIdOf(candidate);
      if (toolId) missing.delete(toolId);
    }
    if (missing.size === 0) return taken;
  }
  return 0;   // 上限内配不齐:调用方退回丢弃
}

function dropLeadingOrphanToolResults(messages: NormalizedMessage[]): NormalizedMessage[] {
  const toolUseIds = new Set(
    messages
      .filter((message) => message.kind === 'tool_use')
      .map((message) => toolIdOf(message))
      .filter((id): id is string => id !== null),
  );
  let start = 0;
  while (
    start < messages.length
    && start < MAX_GROUP_LOOKBACK
    && messages[start].kind === 'tool_result'
  ) {
    const toolId = toolIdOf(messages[start]);
    if (!toolId || toolUseIds.has(toolId)) break;
    start += 1;
  }
  return start === 0 ? messages : messages.slice(start);
}

export const sessionsService = {
  /**
   * 这个访问者可见的会话**分页**列表(外部 API `GET /api/agent/sessions` 用)。
   *
   * 放在这一层是因为 `visibilityScopeOf`(Viewer → SQL 可见范围)住在这里 ——
   * 路由层不该自己再拼一遍那条判据。仓库层只认 scope,不认 Viewer。
   *
   * 之前那条路由是 `getAllSessions()` 整表捞 + JS 侧逐行过滤,而过滤函数每行查库:
   * better-sqlite3 是同步的,4000 条会话就是 4000+ 次同步查询把**事件循环整个按住**
   * (实测 219ms,期间所有人的 WS 帧和请求全停)。下推之后 2.18ms。
   */
  listVisibleSessionsPage(
    viewer: Viewer,
    limit: number,
    offset: number,
    options: { includeArchived?: boolean } = {},
  ) {
    return sessionsDb.getVisibleSessionsPage(
      visibilityScopeOf(viewer),
      limit,
      offset,
      { archived: options.includeArchived ? 'include' : 'exclude' },
    );
  },

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
    /**
     * fj:「日志有行」不等于「日志是权威」。
     *
     * `trimSession` 会把超出 `PRISM_DISPLAY_LOG_MAX_PER_SESSION`(默认 2000)的
     * 最早那批**物理删掉**。此前这里只判 `loggedCount > 0`,于是长会话被裁之后
     * 仍然一律读日志 —— 早期几百上千条从界面永久消失,`total` 跟着变小,界面还
     * 显示"已加载全部"。磁盘上的 jsonl 一直都在,只是应用再也不看它。
     *
     * 现在裁剪会盖戳,盖过戳且**确实有 transcript 可回落**时就走 transcript。
     * 没有 transcript 的会话(纯新建、还没落盘)即使被裁也只能读日志 —— 那是
     * 它仅有的记录,读残缺的也好过读不到。
     */
    const loggedCount = sessionMessagesDb.countForSession(sessionId);
    const logIsAuthoritative = loggedCount > 0
      && !(sessionMessagesDb.isTrimmed(sessionId) && Boolean(session.provider_session_id));
    if (logIsAuthoritative) {
      const limit = options.limit ?? null;
      const offset = options.offset ?? 0;

      // dn-O1:带 limit 的分页请求(首屏 / 上翻 / 每轮 complete 的尾窗刷新,
      // 也就是**全部热路径**)改走 SQL 尾页,不再整段读出 + 全量 parse 再切。
      // 活跃回合里每个 durable 帧落库都会打穿指纹缓存,此前每轮刷新都是一次
      // 全量重读 —— 长会话(数千行)一轮省一次整段读盘。
      if (limit !== null) {
        /**
         * F37:**多取一段"更早的"用来补齐工具组**,再按边界切回去。
         *
         * 多取的那段只在页首缺 `tool_use` 时才用得上;用不上就原样丢掉,
         * 这一页仍然是干净的 `limit` 条。
         */
        const extended = sessionMessagesDb.listTailPage(sessionId, limit + MAX_GROUP_LOOKBACK, offset);
        const extraCount = Math.max(0, extended.messages.length - limit);
        const older = extended.messages.slice(0, extraCount);
        const natural = extended.messages.slice(extraCount);
        const lookback = lookbackForToolGroups(older, natural);
        const page = lookback > 0
          ? {
            messages: older.slice(older.length - lookback).concat(natural),
            total: extended.total,
            // 起点前移了 lookback 条,`hasMore` 要按新的起点算。
            hasMore: extended.total - offset - (natural.length + lookback) > 0,
          }
          : {
            messages: natural,
            total: extended.total,
            hasMore: extended.total - offset - natural.length > 0,
          };
        /**
         * fj:**页首不许是一条孤儿 `tool_result`。**
         *
         * 分页按原始事件切,而工具调用与它的结果是两条独立事件 —— 边界正好落在
         * 中间时,这一页的第一条就是一个找不到 `tool_use` 的结果。前端为此专门
         * 写了"有 toolId 却找不到调用就跳过渲染"的分支(`useChatMessages`),
         * 于是那条结果**看不见**,而对应的调用在上一页里显示成"没有结果" ——
         * 直到用户往上翻一页才自己拼回去。
         *
         * 边界往前挪几条,把 `tool_use` 一起带进来。上限 8 条:一轮里工具调用
         * 与结果是紧邻的,挪太多等于把分页的意义削掉。
         */
        // 补齐成功就不用再丢;上限内配不齐(极少数畸形历史)才退回丢弃。
        const trimmed = lookback > 0 ? page.messages : dropLeadingOrphanToolResults(page.messages);
        return {
          messages: trimmed.map((message) => ({ ...message, sessionId })),
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
   * row disappears from active lists but remains restorable.
   *
   * gk:**永久删除 = 进最近删除**。行、显示日志、transcript 都搬进回收站
   * (`PRISM_TRASH_RETENTION_DAYS`,默认 30 天后清扫),不再 DELETE / unlink;
   * 删之前先收掉常驻 runtime;删完写审计、给所有还看得见它的 socket 推 `session_removed`。
   * `deletedFromDisk` 仍然接受(`false` = transcript 留在原地不搬),默认搬。
   */
  async deleteOrArchiveSessionById(
    sessionId: string,
    options: {
      force?: boolean;
      deletedFromDisk?: boolean;
      /** gk:谁在删、从哪个入口 —— 只为审计与回收站里的"谁删的"。 */
      actor?: SessionActor | null;
      via?: TrashDeletedVia;
    } = {},
  ): Promise<{ sessionId: string; action: 'archived' | 'deleted'; deletedFromDisk: boolean }> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    const projectPath = session.project_path?.trim() ? session.project_path : null;
    const project = projectPath ? projectsDb.getProjectPath(projectPath) : null;
    const projectName = resolveProjectDisplayName(projectPath, project?.custom_project_name);
    const sessionName = session.custom_name?.trim() || null;
    const targetUserId = project?.owner_user_id ?? null;
    const via: TrashDeletedVia = options.via ?? 'session';

    if (!options.force) {
      sessionsDb.updateSessionIsArchived(sessionId, true);
      recordSessionAudit('session_archived', options.actor, {
        entry: via, sessionId, sessionName, projectPath, projectName, lastActivity: session.updated_at ?? null,
      }, targetUserId);
      return {
        sessionId,
        action: 'archived',
        deletedFromDisk: false,
      };
    }

    /**
     * fj:**跑着的会话不许硬删。**
     *
     * 此前删除与运行之间没有任何协调:行删掉了、transcript 也删了,而运行时
     * 还在往那份已经不存在的 jsonl 里追加,writer 还在往一个没有主的 session_id
     * 落显示日志(那张表刻意没建外键,所以孤儿行会一直留着)。收尾时
     * `completeRunIfCurrent` 又去更新一行不存在的记录。
     *
     * 明确拒绝、并告诉用户怎么办,比"删了但后台还在跑"好 —— 后者的现场
     * 极难解释:侧栏里没有这条会话,CPU 却在转,日志里还在刷它的输出。
     */
    if (chatRunRegistry.isProcessing(sessionId)) {
      throw new AppError(
        `会话 "${sessionId}" 正在跑一个回合 —— 先停止它再删除(否则后台仍会继续跑,而它已经没有归属了)。`,
        { code: 'SESSION_RUN_IN_PROGRESS', statusCode: 409 },
      );
    }

    /**
     * fl:**"在用"不只有"有 run 在跑"这一种。**
     *
     * fk 只挡住了 chat run,而另外两种同样会在删除之后继续往这条会话上写:
     *   - **终端接管中**:PTY 里跑着 `claude --resume`,行删了、transcript 也删了,
     *     它还在往一份不存在的文件里追加;
     *   - **有排队消息**:回合一结束就会被 drain 出去,给一条已经不存在的会话
     *     起新一轮。
     * 两种都明确拒绝并说清楚该先做什么 —— 比"删了但后台还在动"好解释得多。
     */
    const shellHolder = currentConversationHolder(sessionId);
    if (shellHolder) {
      const who = shellHolder.username ? `(${shellHolder.username})` : '';
      throw new AppError(
        `会话 "${sessionId}" 正在终端里被接管${who} —— 关掉那个终端再删除。`,
        { code: 'SESSION_HELD_BY_SHELL', statusCode: 409 },
      );
    }
    if (hasPendingSendForSession(sessionId)) {
      throw new AppError(
        `会话 "${sessionId}" 还有一条排队中的消息 —— 先撤销它再删除(否则它会给一条已经不存在的会话起新一轮)。`,
        { code: 'SESSION_HAS_QUEUED_MESSAGE', statusCode: 409 },
      );
    }

    /**
     * gk:**先收 runtime,再动行和文件。**
     *
     * 2026-09-14 的事故里,行和 transcript 删掉之后,这条会话空闲着的常驻 CLI 又活了
     * 半小时;被回收时它按老路径写了两行收尾记录,同名文件"复活"成一个空壳。
     * fj 那道门只挡"正在跑回合",挡不住"空闲但常驻"。收不掉(回合在飞)就拒绝。
     */
    if (runtimeReleaser && session.provider_session_id) {
      const release = await runtimeReleaser(session.provider_session_id);
      if (!release.released && release.reason === 'turn_in_flight') {
        throw new AppError(
          `会话 "${sessionId}" 的常驻进程正在跑一个回合 —— 先停止它再删除。`,
          { code: 'SESSION_RUN_IN_PROGRESS', statusCode: 409 },
        );
      }
      if (!release.released) {
        /**
         * **收不掉 ≠ 在跑。** `releaseClaudeSession` 在 dispose 本身抛错时
         * (传输已经关了之类)也返回 `released: false`,reason 是 `error`。
         * 上一版把这一类也当成"回合在飞"回 409,于是一个 dispose 坏掉的 runtime
         * 能让这条会话**永远删不掉**,而用户看到的是"它明明没在跑"。
         * 那个 runtime 已经坏了,拦着删除保护不了任何东西 —— 记一行往下走。
         */
        log.warn(
          `[sessions] 删除前收常驻进程没成功(reason=${release.reason ?? 'unknown'}),继续删除:${sessionId}`,
        );
      }
    }

    // 名单要在行删掉之前定(可见性判定靠 sessions 行);帧在删完之后发。
    const fireRemoved = prepareSessionRemovedBroadcast(sessionId);
    const actor = actorFields(options.actor);

    const moved = sessionTrashDb.moveToTrash({
      sessionId,
      deletedByUserId: actor.userId,
      deletedByUsername: actor.username,
      deletedVia: via,
      project: {
        projectId: project?.project_id ?? null,
        displayName: projectName,
        ownerUserId: project?.owner_user_id ?? null,
        visibility: project?.visibility ?? null,
      },
    });
    if (!moved.moved || !moved.row) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }
    sessionMessagesDb.invalidateCache(sessionId);

    let transcriptMoved = false;
    if (options.deletedFromDisk !== false && moved.row.jsonl_path) {
      const files = await moveTranscriptToTrash(moved.row);
      sessionTrashDb.recordFilePaths(sessionId, files);
      transcriptMoved = files.trashJsonlPath !== null;
      scheduleStrayCheck(moved.row, files);
    }

    recordSessionAudit('session_deleted', options.actor, {
      entry: via, sessionId, sessionName, projectPath, projectName,
      lastActivity: session.updated_at ?? null, transcriptMoved,
    }, targetUserId);
    log.info(
      `[sessions] 永久删除(进最近删除):${sessionId}「${sessionName ?? '未命名'}」`
      + ` 项目=${projectPath ?? '-'} 操作者=${actor.username ?? actor.userId ?? '系统'} 入口=${via}`
      + ` transcript=${transcriptMoved ? '已搬入回收站' : '未搬'}`,
    );
    fireRemoved({
      reason: via === 'project' ? 'project_deleted' : 'deleted',
      deletedBy: actor.username,
      sessionName,
      restorable: true,
    });

    return {
      sessionId,
      action: 'deleted',
      deletedFromDisk: transcriptMoved,
    };
  },

  /**
   * gk:这条会话是不是"正在用"(在跑回合 / 被终端接管 / 有排队消息)——
   * 与永久删除路径上那三道门同一口径;删项目前的整体预检用它。
   */
  isSessionInUse(sessionId: string): boolean {
    return chatRunRegistry.isProcessing(sessionId)
      || Boolean(currentConversationHolder(sessionId))
      || hasPendingSendForSession(sessionId);
  },

  /** gk:谁能永久删这条会话(root / 项目 owner)。判定在 database 模块,这里只是转出去。 */
  canViewerManageSession(sessionId: string, viewer: Viewer): boolean {
    return canViewerManageSession(sessionId, viewer);
  },

  /**
   * gk:永久删除的权限门。看得见但不能永久删 → 403 并说清楚该怎么办(归档);
   * 看不见 → 与 assertViewerCanSeeSession 同形的 404(不当存在性预言机)。
   */
  assertViewerMayPermanentlyDelete(sessionId: string, viewer: Viewer): void {
    this.assertViewerCanSeeSession(sessionId, viewer);
    if (!this.canViewerManageSession(sessionId, viewer)) {
      throw new AppError('只有项目负责人或管理员可以永久删除这条会话;你可以把它归档。', {
        code: 'SESSION_DELETE_FORBIDDEN',
        statusCode: 403,
      });
    }
  },

  /**
   * gk:最近删除的列表(分页,最近删的在前)。可见范围与活表同一条规则,
   * 项目行已经没了的按删除那一刻的快照判;删的人自己也看得到自己删的。
   * `canRestore` 按 root / 项目 owner / 删除者 三方给。
   */
  listTrashedSessions(
    viewer: Viewer,
    options: { limit?: number; offset?: number } = {},
  ): {
    sessions: TrashedSessionListItem[];
    total: number;
    hasMore: boolean;
    limit: number;
    offset: number;
    retentionDays: number;
  } {
    const limit = Math.min(
      Math.max(1, Number.isFinite(options.limit) ? Math.floor(Number(options.limit)) : DEFAULT_ARCHIVED_PAGE_SIZE),
      MAX_ARCHIVED_PAGE_SIZE,
    );
    const offset = Math.max(0, Number.isFinite(options.offset) ? Math.floor(Number(options.offset)) : 0);
    const page = sessionTrashDb.listPage(visibilityScopeOf(viewer), limit, offset);
    const retentionDays = getTrashRetentionDays();
    const sessions = page.rows.map((row) => toTrashedListItem(row, viewer, retentionDays));
    return {
      sessions,
      total: page.total,
      hasMore: offset + sessions.length < page.total,
      limit,
      offset,
      retentionDays,
    };
  },

  /**
   * gk:从最近删除里恢复。项目行没了就按快照建回来(owner 照旧);活表里已有同 id /
   * 同 provider id 的行时拒绝(409)。恢复后给侧栏推一条 `session_upserted`
   * (由 chatRunRegistry 那条现成的路)。
   */
  async restoreTrashedSession(
    sessionId: string,
    viewer: Viewer,
    actor?: SessionActor | null,
  ): Promise<{ sessionId: string; restored: true; transcriptRestored: boolean }> {
    const row = sessionTrashDb.get(sessionId);
    if (!row || !sessionTrashDb.isVisibleTo(sessionId, visibilityScopeOf(viewer))) {
      throw new AppError(`Session "${sessionId}" is not in the trash.`, {
        code: 'SESSION_NOT_IN_TRASH',
        statusCode: 404,
      });
    }
    if (!canRestoreTrashed(row, viewer)) {
      throw new AppError('只有项目负责人、管理员或删除它的人可以恢复这条会话。', {
        code: 'SESSION_RESTORE_FORBIDDEN',
        statusCode: 403,
      });
    }

    /**
     * 冲突先在动文件之前问一次(只读)。库里那一刀最终还是由 `restore()` 的事务
     * 判定,这里只是避免"文件搬回去了、行却恢复不了"。
     */
    if (sessionsDb.getSessionById(sessionId)) {
      throw new AppError('活跃列表里已经有一条同 id(或同 transcript)的会话,不能恢复到它上面。', {
        code: 'SESSION_RESTORE_CONFLICT',
        statusCode: 409,
      });
    }

    if (row.project_path) {
      // 项目行在删项目时一起没了:按删除那一刻的快照建回来,owner **和 visibility** 都不能丢 ——
      // owner 丢了就成了"无主"(非公共目录仅 root 可见);visibility 丢了则一个
      // `public` 项目会变回默认语义,原来看得见的人(以及共享对象)当场看不到这条恢复出来的会话。
      const existing = projectsDb.getProjectPath(row.project_path);
      if (!existing) {
        projectsDb.createProjectPath(
          row.project_path,
          row.project_display_name,
          row.project_owner_user_id,
          row.project_visibility === 'public' ? 'public' : null,
        );
      }
    }

    /**
     * **文件先搬回来,再动库。**
     *
     * 反过来的话(上一版):`restore()` 一提交,回收站行就没了,而 transcript 还在
     * `<trash>/…` 里 —— 这时若搬运失败(原目录被用户删了、只读盘),那份文件就
     * **再没有任何记录指向它**,连清扫器都找不到,而恢复出来的会话指着一个不存在的
     * 路径且接口回的是 `restored: true`。搬不动就当场失败,东西全留在回收站里可重试。
     */
    const { transcriptRestored, failed: transcriptFailed } = await restoreTranscriptFromTrash(row);
    if (transcriptFailed) {
      throw new AppError(
        '这条会话的 transcript 没能搬回原位置(目录可能已不存在或不可写)—— 会话仍在「最近删除」里,处理好之后可以再试。',
        { code: 'SESSION_RESTORE_FILE_FAILED', statusCode: 409 },
      );
    }

    const result = sessionTrashDb.restore(sessionId);
    if (!result.restored) {
      if (result.reason === 'conflict') {
        throw new AppError('活跃列表里已经有一条同 id(或同 transcript)的会话,不能恢复到它上面。', {
          code: 'SESSION_RESTORE_CONFLICT',
          statusCode: 409,
        });
      }
      throw new AppError(`Session "${sessionId}" is not in the trash.`, {
        code: 'SESSION_NOT_IN_TRASH',
        statusCode: 404,
      });
    }

    // 库里已经恢复了:那条还没跑的"空壳回查"不能再去动老路径上的文件。
    cancelStrayCheck(sessionId);
    sessionMessagesDb.invalidateCache(sessionId);

    recordSessionAudit('session_trash_restored', actor ?? viewer, {
      entry: 'restore',
      sessionId,
      sessionName: row.custom_name,
      projectPath: row.project_path,
      projectName: row.project_display_name,
      transcriptRestored,
    }, row.project_owner_user_id);
    log.info(`[sessions] 从最近删除恢复:${sessionId}「${row.custom_name ?? '未命名'}」 操作者=${viewer.username ?? viewer.userId ?? '-'}`);
    /**
     * 侧栏那一路(带 isArchived 闸门,归档会话不该弹回活跃列表)。
     */
    chatRunRegistry.announceSessionUpsert(sessionId).catch((error) => {
      log.warn('[sessions] 恢复后的侧栏广播失败:', (error as Error)?.message || error);
    });
    /**
     * gl:**撤掉「已被删除」态要走自己的帧。**
     *
     * gk 这里只发了上面那一条,而它对归档会话直接 return —— 于是恢复一条归档态的
     * 会话时前端一帧都收不到,页面永远停在「这条会话已被删除」,输入框回不来,
     * 只能刷新(2026-09-15 测试环境实测)。这一帧无条件发给所有看得见它的人。
     */
    try {
      broadcastSessionRestored(sessionId);
    } catch (error) {
      log.warn('[sessions] 恢复后的 session_restored 广播失败:', (error as Error)?.message || error);
    }

    return { sessionId, restored: true, transcriptRestored };
  },

  /** gk:root 立即清除一条(不等保留期)。 */
  async purgeTrashedSession(sessionId: string, actor: SessionActor): Promise<{ sessionId: string; purged: boolean }> {
    const row = sessionTrashDb.purge(sessionId);
    if (!row) {
      throw new AppError(`Session "${sessionId}" is not in the trash.`, {
        code: 'SESSION_NOT_IN_TRASH',
        statusCode: 404,
      });
    }
    await purgeTrashFiles(row);
    recordSessionAudit('session_trash_purged', actor, {
      entry: 'purge', sessionId, sessionName: row.custom_name, projectPath: row.project_path, projectName: row.project_display_name, count: 1,
    }, row.project_owner_user_id);
    return { sessionId, purged: true };
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
    options: { deletedFromDisk?: boolean; actor?: SessionActor | null } = {},
  ): Promise<{ requested: number; succeeded: string[]; skipped: string[]; failed: string[] }> {
    const succeeded: string[] = [];
    const skipped: string[] = [];
    const failed: string[] = [];
    const names: string[] = [];

    for (const sessionId of [...new Set(sessionIds)]) {
      if (!this.canViewerSeeSession(sessionId, viewer)) {
        skipped.push(sessionId);
        continue;
      }
      // gk:批量永久删除逐条过 owner / root 门 —— 看得见但不能永久删的静默跳过,计入 skipped。
      if (action === 'delete' && !this.canViewerManageSession(sessionId, viewer)) {
        skipped.push(sessionId);
        continue;
      }
      try {
        if (action === 'restore') {
          this.restoreSessionById(sessionId);
        } else {
          if (names.length < 10) {
            const name = sessionsDb.getSessionById(sessionId)?.custom_name?.trim();
            if (name) names.push(name);
          }
          await this.deleteOrArchiveSessionById(sessionId, {
            force: action === 'delete',
            deletedFromDisk: action === 'delete' ? options.deletedFromDisk ?? true : false,
            actor: options.actor ?? viewer,
            via: 'bulk',
          });
        }
        succeeded.push(sessionId);
      } catch {
        failed.push(sessionId);
      }
    }

    // gk:批量删除 / 归档另记一条汇总 —— 单条那些各自有记录,这条回答"一次操作动了几条"。
    if ((action === 'delete' || action === 'archive') && succeeded.length > 0) {
      recordSessionAudit(action === 'delete' ? 'sessions_bulk_deleted' : 'sessions_bulk_archived', options.actor ?? viewer, {
        entry: 'bulk', count: succeeded.length, names,
      }, null);
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
    options: { olderThanDays?: number; deletedFromDisk?: boolean; actor?: SessionActor | null } = {},
  ): Promise<{ deleted: number; failed: number; skipped: number }> {
    const cutoff = typeof options.olderThanDays === 'number' && options.olderThanDays > 0
      ? Date.now() - options.olderThanDays * 24 * 60 * 60 * 1000
      : null;

    let deleted = 0;
    let failed = 0;
    // gk:看得见但不是自己项目的(共享给我的)不能永久删 —— 跳过并计数。
    let skipped = 0;
    const names: string[] = [];
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
        if (!this.canViewerManageSession(row.session_id, viewer)) {
          skipped += 1;
          continue;
        }
        try {
          if (names.length < 10 && row.custom_name?.trim()) names.push(row.custom_name.trim());
          await this.deleteOrArchiveSessionById(row.session_id, {
            force: true,
            deletedFromDisk: options.deletedFromDisk ?? true,
            actor: options.actor ?? viewer,
            via: 'empty_archived',
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

    if (deleted > 0) {
      recordSessionAudit('archived_sessions_emptied', options.actor ?? viewer, {
        entry: 'empty_archived', count: deleted, names,
      }, null);
    }

    return { deleted, failed, skipped };
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
