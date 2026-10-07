import { randomUUID } from 'node:crypto';
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
 * 删除路径上的操作者:在 `Viewer` 之外多带 ip / user-agent,只用于审计。
 * 清扫器等无人发起的调用传 null。
 */
export type SessionActor = {
  userId: number | string | null;
  username: string | null;
  ip?: string | null;
  userAgent?: string | null;
};

/**
 * 删除前先收掉这条会话的常驻 runtime,由组合根注入(claude-sdk 不归这个模块管)。
 *
 * 返回 `released: false` 且 reason 为 `turn_in_flight` / `background_tasks` 时拒绝删除:
 * 进程还在干活,行和文件就不能动;其他原因(如 dispose 出错)只记日志,照常删除。
 * 未注入时视为没有 runtime 要收(单测、不带 SDK 的部署)。
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
 * 右侧工作面板的数据帧(任务清单与产出文件的原料)。
 *
 * 必须从全量历史取(与 fetchHistory 同源:显示日志优先,老会话回落 transcript 回放):
 * 前端只加载尾部窗口,早前回合的 TodoWrite / TaskCreate / Write 不在窗口里,只靠窗口折叠,
 * 清单和产出会变少。服务端只发原料,折叠规则只在前端保留一份。
 *
 * 原料只带折叠会读的字段(见 `slimWorkFrame`):Write 的整份正文之类前端用不到的大字段不下发。
 */
export type SessionWorkFrame = {
  id?: string;
  timestamp?: string;
  /**
   * 'tool' = 工具调用帧(默认);'changed_file' = checkpoint 改动清单里的一个新增文件:
   * Bash / python 写盘没有 Write 帧,这是它们唯一的落库证据。
   * changed_file 帧的 toolInput 形如 { file_path: 绝对路径 }。
   */
  kind?: 'tool' | 'changed_file';
  toolName: string;
  /**
   * 下发时只含前端折叠会读的字段(见 `WORK_FRAME_INPUT_FIELDS`):Write 只有 file_path,TaskCreate 只有 subject,
   * TaskUpdate 只有 taskId / status / subject,TodoWrite 原样。
   */
  toolInput: unknown;
  /**
   * 工具结果;结果还没落地时为 null。下发时 TaskCreate 的原样,其余只留开头一段
   * (长度见 `MAX_FRAME_RESULT_CHARS`)。
   */
  resultContent: string | null;
  resultIsError: boolean;
  /**
   * 这一帧落在第几个用户回合(全量日志里从 1 数,插话不算新回合)。前端进度时间轴靠它区分
   * "这一轮的当前步"和此前被停下的回合遗留的 in_progress / pending:首屏只加载尾部窗口,
   * 常常看不到这一轮的那条用户消息,前端自己数不出回合号。
   */
  turn?: number;
  /** toolInput 删过字段(入参是解析不了的字符串时整个置 null)。 */
  inputTrimmed?: boolean;
  /** resultContent 只是开头一段。 */
  resultTrimmed?: boolean;
};

const WORK_TOOL_NAMES: ReadonlySet<string> = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'Write']);

/**
 * 各工具 toolInput 里前端会读的字段。
 *
 * 前端拿基线帧只做两件事(src/components/chat/utils 下的 taskChecklist 与 sessionOutputs):
 * 任务清单读 TaskCreate 的 subject、TaskUpdate 的 taskId / status / subject;产出表读 Write 的 file_path。
 * Write 的 content(整份文件)、Task* 的 description 等一概不读,却是载荷的大头。
 * 不在表里的工具原样下发:TodoWrite 的清单折叠要读整份 todos。
 */
const WORK_FRAME_INPUT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Write: ['file_path'],
  TaskCreate: ['subject'],
  TaskUpdate: ['taskId', 'status', 'subject'],
};

/**
 * 帧里 resultContent 的长度上限。
 *
 * 前端只解析 TaskCreate 的结果(任务号与任务名在 "Task #N created successfully: 任务名" 里),
 * 这一种原样下发:它只有一句话,长短跟着入参里的 subject 走,截了清单上的任务名就变了。
 * 其余工具前端只看结果在不在、是不是错误,只留开头一段:覆盖已有文件的 Write 结果里
 * 可能带着一段 `cat -n` 片段,原样下发白占载荷。
 */
export const MAX_FRAME_RESULT_CHARS = 200;

/** 结果要被前端整句解析的工具,结果不截。 */
const RESULT_PARSED_TOOLS: ReadonlySet<string> = new Set(['TaskCreate']);

function slimFrameInput(toolName: string, input: unknown): { value: unknown; trimmed: boolean } {
  const fields = WORK_FRAME_INPUT_FIELDS[toolName];
  if (!fields) return { value: input, trimmed: false };
  let source = input;
  if (typeof source === 'string') {
    // 前端对象和 JSON 串都认:解析得了就按对象收窄,解析不了前端同样读不出东西。
    try {
      source = JSON.parse(source);
    } catch {
      return { value: null, trimmed: true };
    }
  }
  if (source === null || source === undefined) return { value: null, trimmed: false };
  if (typeof source !== 'object' || Array.isArray(source)) return { value: null, trimmed: true };
  const picked: Record<string, unknown> = {};
  let trimmed = false;
  for (const [key, value] of Object.entries(source)) {
    if (fields.includes(key)) picked[key] = value;
    else trimmed = true;
  }
  return { value: picked, trimmed };
}

function previewResult(toolName: string, content: string | null): { value: string | null; trimmed: boolean } {
  if (content === null || RESULT_PARSED_TOOLS.has(toolName) || content.length <= MAX_FRAME_RESULT_CHARS) {
    return { value: content, trimmed: false };
  }
  // 切点落在代理对的前半个上就少切一位,不留半个字符。
  const code = content.charCodeAt(MAX_FRAME_RESULT_CHARS - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? MAX_FRAME_RESULT_CHARS - 1 : MAX_FRAME_RESULT_CHARS;
  return { value: content.slice(0, end), trimmed: true };
}

/** 下发前把一帧收成前端折叠真正要读的样子。 */
function slimWorkFrame(frame: SessionWorkFrame): SessionWorkFrame {
  const input = slimFrameInput(frame.toolName, frame.toolInput);
  const result = previewResult(frame.toolName, frame.resultContent);
  return {
    ...frame,
    toolInput: input.value,
    resultContent: result.value,
    ...(input.trimmed ? { inputTrimmed: true } : {}),
    ...(result.trimmed ? { resultTrimmed: true } : {}),
  };
}

/**
 * 一轮的产出,按回合归到那条助手回答上。
 *
 * 这是对话正文下面那张产出卡的唯一数据源,必须由服务端从全量显示日志算出,不能由前端
 * 从已加载的消息窗口现推:重进会话先渲染的是尾部窗口,起点常落在某一轮工具流中间,
 * 现推的结果会随历史陆续补齐而变。挂到回合上之后,卡片和消息一起到达,此后不再变化。
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
   * 按全量历史算,不受帧数截断影响(和 revertedPaths 同一个道理):截断丢的是
   * 载荷里的帧,不该让历史回合的产出卡跟着一起丢。
   */
  turnOutputs: Record<string, TurnOutputFile[]>;
  /** 全量日志里的用户回合数(插话不算)。前端把它接在回合基线末尾,窗口里看不到这一轮的用户消息时也能对上回合号。 */
  userTurns?: number;
  /**
   * 仍处于"已回滚"状态的绝对路径。files_reverted 之前的产出帧已经不在 `frames` 里,
   * 但前端窗口里的旧 Write 工具帧还会把文件加回来,前端要用这个集合做最终减法。
   * 回滚后又重写的文件会从集合里移除(按时序折叠)。
   */
  revertedPaths: string[];
  /** 帧数触顶,较早的帧没有随本次响应下发(前端据此提示,不假装全都在)。 */
  truncated?: boolean;
};

/**
 * 单次响应的帧数上限。
 *
 * 这个接口在会话切换和每个回合结束时都会被拉一次,而工作面板没有任何清理机制
 * (不过期、不分页),长会话(几百次 Write + 几百个 Task 事件)的帧数只增不减。
 * 每帧只带折叠要读的字段(见 `slimWorkFrame`),再给条数封顶,整份载荷就有上界。
 *
 * 截断保留尾部:清单的当前状态、最近的产出都在尾部。revertedPaths 与 turnOutputs 按全量算好,
 * "某文件已被回滚"这条结论不会因截断而丢失。
 */
export const MAX_WORK_FRAMES = 1500;

/** 回合产出映射的条数上限:只是路径,比帧轻得多,但也不能无限增长。 */
export const MAX_TURN_OUTPUT_ENTRIES = 500;

/**
 * 单轮的文件条数上限。
 *
 * 一轮批量任务写出几百个文件是会发生的;卡片到几十行就已经读不动,再多只是撑大载荷。
 * 超出的部分不进卡片,仍在右侧会话级产出表里可以翻到。
 */
export const MAX_FILES_PER_TURN = 50;

function toolInputFilePath(toolInput: unknown): string | null {
  const input = toolInput as { file_path?: unknown } | null | undefined;
  return typeof input?.file_path === 'string' ? input.file_path : null;
}

/** files_reverted 行列出的文件,拼成绝对路径(cwd 去掉末尾的分隔符;没有 cwd 时原样用)。 */
function revertedPathsOf(message: NormalizedMessage): string[] {
  const cwd = typeof message.cwd === 'string' && message.cwd ? message.cwd.replace(/[\\/]+$/, '') : '';
  const paths = Array.isArray(message.paths) ? message.paths : [];
  const absolutes: string[] = [];
  for (const entry of paths) {
    if (typeof entry !== 'string' || !entry.trim()) continue;
    absolutes.push(cwd ? `${cwd}/${entry.trim()}` : entry.trim());
  }
  return absolutes;
}

/**
 * changed_files 行里算作产出的文件,带 git 相对路径与用 cwd 拼好的绝对路径。
 * 只算新增:修改 / 删除既有文件不是"产出了一个文件"。
 */
function addedFilesOf(message: NormalizedMessage): Array<{ relPath: string; absolute: string }> {
  const cwd = typeof message.cwd === 'string' && message.cwd ? message.cwd : '';
  const files = Array.isArray(message.files) ? message.files : [];
  const added: Array<{ relPath: string; absolute: string }> = [];
  for (const entry of files) {
    const file = entry as { path?: unknown; status?: unknown; untracked?: unknown };
    const relPath = typeof file.path === 'string' ? file.path.trim() : '';
    if (!relPath) continue;
    if (file.status !== 'added' && !file.untracked) continue;
    added.push({ relPath, absolute: cwd ? `${cwd.replace(/[\\/]+$/, '')}/${relPath}` : relPath });
  }
  return added;
}

type PairedResult = { content?: string; isError?: boolean } | undefined;

/**
 * 从尾部倒着收工作面板帧,最多 `MAX_WORK_FRAMES` 个。
 *
 * 结果与"正着收齐所有帧、遇到 files_reverted 删掉此前同一文件的帧、最后切尾部"逐帧相同,
 * 但手里最多只有上限那么多帧,不先全攒再切。倒着走时,走过的 files_reverted 都在当前这条消息
 * 之后:路径在里面的帧最终会被删掉,直接不收。窗口满了以后又遇到一个留得下来的帧,说明更早
 * 还有帧没下发,就是截断。回合号从全量的用户回合数往回减。
 */
function collectTailFrames(
  messages: readonly NormalizedMessage[],
  pairedResultOf: (message: NormalizedMessage) => PairedResult,
  userTurns: number,
): { frames: SessionWorkFrame[]; truncated: boolean } {
  const tail: SessionWorkFrame[] = [];
  const revertedLater = new Set<string>();
  let turn = userTurns;
  /** 收进这一帧(最终会被回滚删掉的不收);窗口已满、收不下时返回 false。 */
  const keep = (frame: SessionWorkFrame): boolean => {
    const filePath = toolInputFilePath(frame.toolInput);
    if (filePath !== null && revertedLater.has(filePath)) return true;
    if (tail.length >= MAX_WORK_FRAMES) return false;
    tail.push(frame);
    return true;
  };

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.kind === 'files_reverted') {
      for (const absolute of revertedPathsOf(message)) revertedLater.add(absolute);
      continue;
    }
    if (message.kind === 'text') {
      // 这条用户消息之前的帧属于上一个回合;插话不开新回合。
      if (message.role === 'user' && !(message as { interjection?: boolean }).interjection) turn -= 1;
      continue;
    }
    const turnField = turn > 0 ? { turn } : {};
    if (message.kind === 'changed_files') {
      const added = addedFilesOf(message);
      for (let at = added.length - 1; at >= 0; at -= 1) {
        const kept = keep({
          id: typeof message.id === 'string' ? `${message.id}::${added[at].relPath}` : undefined,
          timestamp: typeof message.timestamp === 'string' ? message.timestamp : undefined,
          kind: 'changed_file',
          toolName: 'Write',
          toolInput: { file_path: added[at].absolute },
          resultContent: 'checkpoint',
          resultIsError: false,
          ...turnField,
        });
        if (!kept) return { frames: tail.reverse(), truncated: true };
      }
      continue;
    }
    if (message.kind !== 'tool_use') continue;
    const toolName = typeof message.toolName === 'string' ? message.toolName : '';
    if (!WORK_TOOL_NAMES.has(toolName)) continue;
    const paired = pairedResultOf(message);
    const kept = keep({
      id: typeof message.id === 'string' ? message.id : undefined,
      timestamp: typeof message.timestamp === 'string' ? message.timestamp : undefined,
      toolName,
      toolInput: message.toolInput ?? null,
      resultContent: typeof paired?.content === 'string' ? paired.content : null,
      resultIsError: Boolean(paired?.isError),
      ...turnField,
    });
    if (!kept) return { frames: tail.reverse(), truncated: true };
  }
  return { frames: tail.reverse(), truncated: false };
}

/**
 * `collectWorkFrames`(纯函数)从一段 NormalizedMessage 历史里收集工作面板帧。
 * tool_result 是独立行,按 toolId 配对;子代理的 child 行同样在历史里,一并收
 * (子代理写的文件、立的任务也是这个会话的工作)。
 * changed_files 行展开为逐文件的 changed_file 帧:git 相对路径用帧上的 cwd 拼成绝对路径,
 * 与 Write 帧同构,可跨通路去重。
 *
 * 走两遍:正着走一遍算回合产出、仍处于已回滚状态的路径和用户回合数,这几样按全量算,
 * 不受帧数上限影响;帧由 `collectTailFrames` 倒着只收下发的那一段,收完再收窄字段。
 */
export function collectWorkFrames(messages: readonly NormalizedMessage[]): CollectedWorkFrames {
  const resultByToolId = new Map<string, { content?: string; isError?: boolean }>();
  for (const message of messages) {
    if (message.kind === 'tool_result' && message.toolId) {
      resultByToolId.set(message.toolId, { content: message.content, isError: message.isError });
    }
  }
  const pairedResultOf = (message: NormalizedMessage): PairedResult => message.toolResult
    ?? (message.toolId ? resultByToolId.get(message.toolId) : undefined);

  const reverted = new Set<string>();
  /**
   * 回合归属:写入帧先攒着,到这一轮结束(下一条用户消息,或日志走完)才整批挂到
   * 该轮最后一条助手正文上。
   *
   * 不能遇到助手正文就挂:长任务里模型会在工具之间说过渡性的话("任务 32 完成。任务 33:"),
   * 这些正文同样是 `kind:'text' role:'assistant'`,而前端会把它们吸进活动时间轴当 narration
   * 行渲染(见 toolGrouping 的 isAbsorbableNarration),挂在上面的卡片谁也看不见。
   * 前端的判据是"收尾的最终回答后面没有活动,保持大正文排版",对应的锚点就是
   * 这一轮最后一条助手正文:记住它,到边界再结算。
   */
  const turnOutputs: Record<string, TurnOutputFile[]> = {};
  let pendingTurnFiles: TurnOutputFile[] = [];
  /** 本轮至今最后一条有内容的助手正文的消息 id —— 结算时挂它。 */
  let pendingAnchorId = '';
  /** 用户回合计数(见 SessionWorkFrame.turn)。 */
  let userTurn = 0;
  /**
   * 回合产出超过 `MAX_TURN_OUTPUT_ENTRIES` 时淘汰最早的键(对象的键序就是插入序),
   * 保留最新的若干轮,与帧的尾部截断同向:最近跑完的那几轮最要紧。
   */
  const flushTurn = () => {
    if (pendingAnchorId && pendingTurnFiles.length > 0) {
      turnOutputs[pendingAnchorId] = pendingTurnFiles;
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
      // 此前这些文件的产出帧由 collectTailFrames 按时序删掉;之后的重写会重新入列。
      for (const absolute of revertedPathsOf(message)) {
        reverted.add(absolute);
        dropPendingWrite(absolute);
      }
      continue;
    }

    if (message.kind === 'changed_files') {
      for (const { absolute } of addedFilesOf(message)) {
        noteFileFrame(absolute);
        // Bash / python 写盘没有 Write 帧,checkpoint 的改动清单是它们唯一的证据;
        // 行数无从得知(这里只有路径),界面上就不显示写入量。
        notePendingWrite(absolute, null);
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
        if (!(message as { interjection?: boolean }).interjection) userTurn += 1;
      }
      continue;
    }

    // 结果已落地且没报错的 Write 才算写出了文件。
    if (message.kind !== 'tool_use' || message.toolName !== 'Write') continue;
    const paired = pairedResultOf(message);
    if (typeof paired?.content !== 'string' || paired.isError) continue;
    const written = toolInputFilePath(message.toolInput);
    noteFileFrame(written);
    notePendingWrite(written, (message.toolInput as { content?: unknown } | null | undefined)?.content);
  }
  // 日志走完 = 最后一轮的边界。刚跑完的这一轮全靠这一句才有卡片。
  flushTurn();

  const tail = collectTailFrames(messages, pairedResultOf, userTurn);
  const frames = tail.frames.map(slimWorkFrame);
  if (tail.truncated) {
    return { frames, revertedPaths: [...reverted], turnOutputs, truncated: true, userTurns: userTurn };
  }
  return { frames, revertedPaths: [...reverted], turnOutputs, userTurns: userTurn };
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

/** 归档会话列表分页的默认 / 最大页大小。 */
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

/** 最近删除列表里的一条(给前端)。 */
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
 * 页边界不许把一次工具调用和它的结果拆开:缺 `tool_use` 时往更早的方向扩边界,而不是丢掉页首的结果。
 *
 * 分页按原始事件切,而调用与结果是两条独立事件。边界落在中间时,页首就是一条找不到
 * `tool_use` 的结果:前端会跳过渲染它,上一页里对应的调用则显示成"没有结果"。
 * 丢掉页首孤儿也有代价:调用方按服务端返回的条数推进 offset,少返回几条,下一页就与这一页
 * 重叠,去重后净增可能为 0,上翻卡在原地。往前扩边界对游标是自洽的:窗口起点随之前移,
 * 下一页正好接上,不重叠也不跳过。
 *
 * 上限 `MAX_GROUP_LOOKBACK`:一轮里调用与结果是紧邻的,挪太多等于取消分页。上限内仍配不上对
 * (极少数畸形历史)时才退回丢弃页首孤儿,宁可少渲染几行,也不把一整页拉成没有边界。
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
 * `older` 是紧邻这一页、更早的那些行(oldest-first);返回要从 `older`
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

/**
 * Application service for provider-backed session message operations.
 *
 * Callers pass a provider id and this service resolves the concrete provider
 * class, keeping normalization/history call sites decoupled from implementation
 * file layout.
 */
export const sessionsService = {
  /**
   * 这个访问者可见的会话分页列表(外部 API `GET /api/agent/sessions` 用)。
   *
   * 放在这一层是因为 `visibilityScopeOf`(Viewer → SQL 可见范围)在这里,路由层不该
   * 再拼一遍那条判据;仓库层只认 scope,不认 Viewer。可见性过滤必须下推到 SQL:
   * better-sqlite3 是同步的,整表捞出再在 JS 侧逐行查库过滤,几千条会话就会把事件循环
   * 按住几百毫秒,期间所有人的 WS 帧和请求全停。
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

  /**
   * Returns the provider runs that are currently processing (keyed by app-facing
   * session id), limited to sessions this viewer can see.
   *
   * This is intentionally status-only: callers that only need sidebar activity
   * indicators should not attach to chat streams or request replayed messages.
   */
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
    // 新建的会话立即推给能看见它的人,不等第一条消息落 jsonl 后由 watcher 推。
    void chatRunRegistry.announceSessionUpsert(sessionId).catch(() => { /* 推送失败不影响建会话 */ });

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
     * 优先读自己的显示日志,读不到才回落到 transcript 回放。
     *
     * transcript 是模型的记忆,不是对话记录 —— 里面混着子代理 sidechain、
     * `isMeta` 行、技能正文注入、压缩摘要。拿它当显示模型,CLI 每加一种内部行
     * 界面就漏一次。日志这条路径直接把推给前端的那条消息原样还回去,
     * 中间没有任何再解析、再判定的环节,那一类问题结构上不会出现。
     *
     * 回落是必须的:这张表建立之前就有的会话,日志里一行都没有。
     * 这类会话继续走 transcript(带着 `transcript-provenance` 的出处判定),
     * 有日志的会话从第一条消息起就走日志。
     */
    /**
     * 「日志有行」不等于「日志是权威」。
     *
     * `trimSession` 会把超出 `PRISM_DISPLAY_LOG_MAX_PER_SESSION`(默认 2000)的最早那批物理删掉。
     * 被裁过的日志若仍当权威,早期消息会从界面永久消失,`total` 跟着变小,界面还显示"已加载全部"。
     * 所以裁剪会盖戳:盖过戳且确实有 transcript 可回落时走 transcript。没有 transcript 的会话
     * (新建、尚未落盘)即使被裁也只能读日志,那是它仅有的记录,读残缺的也好过读不到。
     */
    const loggedCount = sessionMessagesDb.countForSession(sessionId);
    const logIsAuthoritative = loggedCount > 0
      && !(sessionMessagesDb.isTrimmed(sessionId) && Boolean(session.provider_session_id));
    if (logIsAuthoritative) {
      const limit = options.limit ?? null;
      const offset = options.offset ?? 0;

      // 带 limit 的分页请求(首屏 / 上翻 / 每轮 complete 的尾窗刷新,即全部热路径)走 SQL 尾页,
      // 不整段读出、全量 parse 后再切:活跃回合里每个 durable 帧落库都会打穿指纹缓存,
      // 长会话(数千行)每轮刷新都会变成一次整段读盘。
      if (limit !== null) {
        /**
         * 多取一段"更早的"用来补齐工具组,再按边界切回去。
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
   * 工作面板帧:全量历史(与 fetchHistory 同源:显示日志优先,老会话回落 transcript 回放)
   * 经 collectWorkFrames 收集。前端在会话切换、回合结束、回滚 / 还原之后各拉一次;
   * 全量 parse 有指纹缓存,日志没变时直接命中,这里重建出的缓存之后的尾页请求也能复用。
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
   * 永久删除即移入最近删除:行、显示日志、transcript 都搬进回收站(`PRISM_TRASH_RETENTION_DAYS`,
   * 默认 30 天后清扫),不直接 DELETE / unlink。删除前先收掉常驻 runtime;删完写审计,
   * 并给所有还看得见它的 socket 推 `session_removed`。`deletedFromDisk: false` 时 transcript
   * 留在原地不搬,默认搬。
   */
  async deleteOrArchiveSessionById(
    sessionId: string,
    options: {
      force?: boolean;
      deletedFromDisk?: boolean;
      /** 谁在删、从哪个入口:只用于审计与回收站里的"谁删的"。 */
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
     * 正在跑回合的会话不许永久删除。
     *
     * 删除与运行之间没有别的协调:行和 transcript 移走后,运行时仍会往已不存在的 jsonl 里追加,
     * writer 仍会往无主的 session_id 落显示日志(那张表刻意没建外键,孤儿行会一直留着),
     * 收尾时 `completeRunIfCurrent` 还会去更新一行不存在的记录。明确拒绝并告诉用户先停止,
     * 比"侧栏里没有这条会话,后台却还在跑"好解释得多。
     */
    if (chatRunRegistry.isProcessing(sessionId)) {
      throw new AppError(
        `会话 "${sessionId}" 正在跑一个回合 —— 先停止它再删除(否则后台仍会继续跑,而它已经没有归属了)。`,
        { code: 'SESSION_RUN_IN_PROGRESS', statusCode: 409 },
      );
    }

    /**
     * "在用"不只有"有回合在跑"一种,下面两种同样会在删除之后继续往这条会话上写:
     *   - 终端接管中:PTY 里跑着 `claude --resume`,还会往已不存在的文件里追加;
     *   - 有排队消息:回合一结束就会被 drain 出去,给已不存在的会话起新一轮。
     * 两种都明确拒绝,并说清楚该先做什么。
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
     * 先收 runtime,再动行和文件。
     *
     * 空闲但常驻的 CLI 不算"正在跑回合",上面几道门挡不住它;不先收掉,它被回收时会按原路径
     * 写收尾记录,把搬走的 transcript"复活"成一个空壳。回合在飞或还有后台任务时收不掉,拒绝删除。
     */
    if (runtimeReleaser && session.provider_session_id) {
      const release = await runtimeReleaser(session.provider_session_id);
      if (!release.released && release.reason === 'turn_in_flight') {
        throw new AppError(
          `会话 "${sessionId}" 的常驻进程正在跑一个回合 —— 先停止它再删除。`,
          { code: 'SESSION_RUN_IN_PROGRESS', statusCode: 409 },
        );
      }
      if (!release.released && release.reason === 'background_tasks') {
        // 没有回合、只是后台任务在跑:"停止"停不掉它们,要在后台任务条上逐个停。
        throw new AppError(
          `会话 "${sessionId}" 还有后台任务在跑 —— 先在对话里的后台任务条上停掉它们(或等它们跑完)再删除。`,
          { code: 'SESSION_RUN_IN_PROGRESS', statusCode: 409 },
        );
      }
      if (!release.released) {
        /**
         * 收不掉不等于在跑。`releaseClaudeSession` 在 dispose 本身抛错时(如传输已关闭)也返回
         * `released: false`,reason 为 `error`。这种 runtime 已经坏了,拦着删除保护不了什么,
         * 只会让这条会话永远删不掉;记一行日志,继续删除。
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
   * 这条会话是否正在用(在跑回合 / 被终端接管 / 有排队消息),与永久删除路径上那三道门
   * 同一口径;删项目前的整体预检用它。
   */
  isSessionInUse(sessionId: string): boolean {
    return chatRunRegistry.isProcessing(sessionId)
      || Boolean(currentConversationHolder(sessionId))
      || hasPendingSendForSession(sessionId);
  },

  /**
   * 谁能永久删除、归档、还原这条会话:root、项目 owner、会话发起人。
   * 判定在 database 模块,这里只是转出去。
   */
  canViewerManageSession(sessionId: string, viewer: Viewer): boolean {
    return canViewerManageSession(sessionId, viewer);
  },

  /**
   * 永久删除的权限门。看得见但无权永久删除 → 403,并说明谁可以删;
   * 看不见 → 与 assertViewerCanSeeSession 同形的 404(不当存在性预言机)。
   */
  assertViewerMayPermanentlyDelete(sessionId: string, viewer: Viewer): void {
    this.assertViewerCanSeeSession(sessionId, viewer);
    if (!this.canViewerManageSession(sessionId, viewer)) {
      throw new AppError('只有会话发起人、项目负责人或管理员可以永久删除这条会话。', {
        code: 'SESSION_DELETE_FORBIDDEN',
        statusCode: 403,
      });
    }
  },

  /**
   * 归档 / 还原的权限门,与永久删除同一条判定。
   *
   * `sessions.isArchived` 是全局的一列,归档等于让所有人当场看不见,所以不能"看得见就能归档",
   * 否则共享项目里的协作者能把 owner 的会话整条收起来。403 的文案与永久删除分开写,
   * 用户才知道自己被挡的是哪一件事。
   */
  assertViewerMayArchiveOrRestore(sessionId: string, viewer: Viewer, action: 'archive' | 'restore'): void {
    this.assertViewerCanSeeSession(sessionId, viewer);
    if (!this.canViewerManageSession(sessionId, viewer)) {
      throw new AppError(
        action === 'archive'
          ? '只有会话发起人、项目负责人或管理员可以归档这条会话。'
          : '只有会话发起人、项目负责人或管理员可以还原这条会话。',
        { code: action === 'archive' ? 'SESSION_ARCHIVE_FORBIDDEN' : 'SESSION_RESTORE_FORBIDDEN', statusCode: 403 },
      );
    }
  },

  /**
   * 最近删除的列表(分页,最近删的在前)。可见范围与活表同一条规则,项目行已经没了的
   * 按删除那一刻的快照判;删除者自己也看得到自己删的。`canRestore` 给 root / 项目 owner / 删除者。
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
   * 从最近删除里恢复(root / 项目 owner / 删除者可恢复,其余 403)。项目行没了就按快照建回来
   * (owner 不变);活表里已有同 id / 同 provider id 的行时拒绝(409)。恢复后经 chatRunRegistry
   * 给侧栏推 `session_upserted`,另推 `session_restored` 撤掉前端的「已被删除」态。
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
      // 项目行在删项目时一起没了:按删除那一刻的快照建回来,owner 和 visibility 都不能丢 ——
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
     * 文件先搬回来,再动库。
     *
     * 反过来的话,`restore()` 一提交回收站行就没了,这时若 transcript 搬运失败(原目录被删、只读盘),
     * 那份文件再没有任何记录指向它,连清扫器都找不到,而恢复出来的会话指着一个不存在的路径。
     * 搬不动就当场失败,东西全留在回收站里可以重试。
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
     * 撤掉「已被删除」态要走自己的帧。
     *
     * 上面侧栏那一路广播对归档会话直接 return,只靠它的话,恢复一条归档态的会话时前端收不到
     * 任何帧,页面停在「这条会话已被删除」、输入框回不来。这一帧无条件发给所有看得见它的人。
     */
    try {
      broadcastSessionRestored(sessionId);
    } catch (error) {
      log.warn('[sessions] 恢复后的 session_restored 广播失败:', (error as Error)?.message || error);
    }

    return { sessionId, restored: true, transcriptRestored };
  },

  /** root 立即清除一条(不等保留期)。 */
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
    // 还原后回到活跃列表,别人的标签页也要看到。
    void chatRunRegistry.announceSessionUpsert(sessionId).catch(() => { /* 推送失败不影响还原 */ });
    return { sessionId, isArchived: false };
  },

  /**
   * 批量归档 / 恢复 / 删除会话。
   *
   * 归档里攒了几百条时一条条点是纯体力活;但"全选删除"如果不逐条鉴权,就是一把
   * 能扫掉别人会话的扫帚。所以逐条过 `canViewerSeeSession`(再过管理权限门),
   * 看不见或无权操作的既不动也不报错(报错等于告诉调用方那个 id 存在),只计入 skipped。
   *
   * 一条失败不中断其余:批量操作最糟的结果是"删了一半然后抛异常",调用方既不知道
   * 删了哪些,也不知道该不该重试。逐条 catch,最后给一份账。
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
      // 批量永久删除 / 归档 / 还原都逐条过管理权限门(发起人 / owner / root),与单条入口不分叉;
      // 看得见但无权操作的静默跳过,计入 skipped。
      if (!this.canViewerManageSession(sessionId, viewer)) {
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

    // 批量删除 / 归档另记一条汇总:单条各自有记录,这条回答"一次操作动了几条"。
    if ((action === 'delete' || action === 'archive') && succeeded.length > 0) {
      recordSessionAudit(action === 'delete' ? 'sessions_bulk_deleted' : 'sessions_bulk_archived', options.actor ?? viewer, {
        entry: 'bulk', count: succeeded.length, names,
      }, null);
    }

    return { requested: sessionIds.length, succeeded, skipped, failed };
  },

  /**
   * 清空归档:永久删除当前访问者看得见的所有归档会话(进最近删除,保留期内可恢复)。
   *
   * `olderThanDays` 可选:只清超过这个天数的,给"保留最近一周"这种用法。
   * 按页边取边删(而不是一次全捞),归档几千条时也不会把整张表读进内存。
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
    // 看得见但无权永久删除的(共享给我、又不是我发起的)跳过并计数。
    let skipped = 0;
    const names: string[] = [];
    /**
     * 游标按"这一页留下了几条"前进,不能恒取 offset 0、遇到没有目标的页就收工。
     *
     * 删掉的条目会让后面的往前挪,所以删成功的部分不推进游标(下一轮读到的就是新补上来的);
     * 没删的(不够旧、或删失败)留在原位,必须跨过去。否则带 `olderThanDays` 时,只要最新那一页
     * 全是近期的就会直接收工,真正够旧的一条都清不到;少量删不动的条目也会把游标永远钉在原地。
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
    // 改名不碰 jsonl,watcher 不会推;这里主动推一帧 session_upserted。
    void chatRunRegistry.announceSessionUpsert(sessionId).catch(() => { /* 推送失败不影响改名 */ });
    return { sessionId, summary };
  },
};
