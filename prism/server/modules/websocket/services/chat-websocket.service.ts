import crypto from 'node:crypto';
import path from 'node:path';

import type { WebSocket } from 'ws';

import { attachmentsDb, canViewerSeeSession, sessionMessagesDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { chatRunRegistry, setRunStartedHook} from '@/modules/websocket/services/chat-run-registry.service.js';
import { claudeModelCatalog, modelViewerFor, seedDisplayLogFromTranscript } from '@/modules/providers/index.js';
import { connectedClients, WS_OPEN_STATE } from '@/shared/websocket-state.js';
import { currentHolder } from '@/modules/websocket/services/conversation-ownership.service.js';
import { ATTACHMENT_DIR_NAME } from '@/shared/attachment-storage.js';
import { getGlobalImageAssetsDir, normalizeImageDescriptors } from '@/shared/image-attachments.js';
import { readSocketViewer } from '@/shared/project-visibility.js';
import type {
  AnyRecord,
  AuthenticatedWebSocketRequest,
  LLMProvider,
  NormalizedMessage,
} from '@/shared/types.js';
import { generateMessageId, parseIncomingJsonObject } from '@/shared/utils.js';
import { createLogger } from '@/shared/logger.js';

import { forgetSend, registerSend } from './chat-send-dedupe.js';
const log = createLogger('ws-chat');

/**
 * 无主附件(台账里查不到的老文件)要不要拒。
 *
 * 默认放行 —— 直接拒会让老会话的编辑重跑 / 排队重放连自己的图都发不出去。
 * 设了 PRISM_STRICT_ATTACHMENT_OWNER 的环境按"没有归属证明就不给用"办。
 */
function strictAttachmentOwner(): boolean {
  const raw = process.env.PRISM_STRICT_ATTACHMENT_OWNER;
  return raw === '1' || raw === 'true';
}

/**
 * Trust boundary for client-supplied image attachments: chat.send options come
 * straight from the browser, and the provider runtimes read the referenced
 * files off disk (Claude base64-encodes them into the prompt). Only images
 * that live directly inside an allowed root (the global upload store
 * `~/.prism/assets`, where POST /api/assets/images puts them, plus `extraRoots`)
 * or that the attachment ledger ties to this session are allowed through —
 * anything else (absolute paths elsewhere, traversal, subdirectories) is dropped.
 *
 * Exported for tests; `assetsRootOverride` exists only for them.
 */
export function filterImagesToUploadStore(
  images: unknown,
  assetsRootOverride?: string,
  /**
   * 额外允许的根目录:会话所属项目的 `attachments/`。
   *
   * 聊天图片按会话所属项目落到 `<项目>/attachments/`(配额、清理都按项目走),
   * 全局 `~/.prism/assets` 只在拿不到项目时兜底。只认全局目录的话,项目会话里发的图
   * 会全部被丢掉:runtime 收不到图,用户行落库也没有 images。项目目录本来就是这个会话
   * 有权读的,放行它的直接子文件与放行全局目录安全水位相同;仍然只认直接子文件,
   * 不认子目录与路径穿越。
   */
  extraRoots: readonly string[] = [],
  /**
   * 台账兜底:路径不在任何允许的根下,但附件台账说它就是这条会话上传的,照样放行。
   *
   * 这道门比的是 `sessions.project_path`,而落盘目录只在上传时带了会话才按会话的项目走,
   * 否则取前端传的 projectId(侧栏选中的项目)。两者对不齐时(root 看别人的会话时尤其容易),
   * 图片会在这里被静默丢掉:页面上显示得好好的(前端按侧栏 projectId 走 files/content
   * 取原图),模型却一张都收不到。
   *
   * 台账是服务端在落盘那一刻记的(user_id / session_id / abs_path),不是客户端说的,
   * 所以拿它当判据比路径形状更硬:落错目录的文件挪不回去,但归属有据可查。
   */
  ledgerOwner?: (absPath: string) => { userId: number | null; sessionId: string | null } | undefined,
  sessionId?: string | null,
  /**
   * 发起这一轮的人是谁。
   *
   * 全局图库(`~/.prism/assets`)是所有用户共用的一个目录。只判"在不在这个目录里"的话,
   * 知道别人的文件名(路径会出现在导出、日志、截图里)就能把别人的图塞进自己的对话发给模型。
   * 项目内的 `attachments/` 不在此列:那道门前面已经过了会话可见性。
   *
   * 传了 userId 才启用归属校验;不传(测试、外部调用)不查归属。
   */
  actorUserId?: number | null,
): AnyRecord[] {
  const roots = [assetsRootOverride ?? getGlobalImageAssetsDir(), ...extraRoots]
    .filter((root): root is string => typeof root === 'string' && root.length > 0)
    .map((root) => path.resolve(root));

  const isDirectChildOf = (root: string, candidate: string): boolean => {
    // Relative paths are anchored in the root; absolute ones must already be in it.
    const resolved = path.resolve(root, candidate);
    const relative = path.relative(root, resolved);
    return (
      relative.length > 0 &&
      !relative.startsWith('..') &&
      !path.isAbsolute(relative) &&
      !relative.includes(path.sep) &&
      !relative.includes('/')
    );
  };

  /**
   * 放行时顺手把路径定成绝对路径。
   *
   * 这道门用 assets 根 / 项目 attachments 根解析裸文件名,而运行时
   * (`resolveImageAbsolutePath`)对相对路径按 cwd 解析,两个根不同:裸文件名在这里判过,
   * 到运行时可能指向另一个目录、文件不存在,模型看不到图,日志里也没有任何提示。
   * 判过之后就钉成绝对路径,后面不再有第二次解析。
   */
  const globalRoot = path.resolve(assetsRootOverride ?? getGlobalImageAssetsDir());

  return normalizeImageDescriptors(images).flatMap((descriptor) => {
    const matchedRoot = roots.find((root) => isDirectChildOf(root, descriptor.path));
    if (matchedRoot) {
      const resolved = path.resolve(matchedRoot, descriptor.path);

      /**
       * 共用目录里的图要查归属。
       *
       * 只对全局图库查 —— 它是所有用户共用的一个目录。项目内的 `attachments/`
       * 不查:走到这里说明会话可见性已经过了,那个项目本来就读得到。
       *
       * 台账里没有记录的老文件默认放行并单独记一行日志:直接拒绝会让老会话的
       * 编辑重跑 / 排队重放连自己的图都发不出去。想收紧的环境把
       * `PRISM_STRICT_ATTACHMENT_OWNER=1` 打开,无主文件一律拒。
       */
      if (ledgerOwner && actorUserId !== null && actorUserId !== undefined && isDirectChildOf(globalRoot, descriptor.path)) {
        const owner = ledgerOwner(resolved);
        if (!owner) {
          if (strictAttachmentOwner()) {
            log.warn(`[Chat] Dropping unledgered image under strict owner policy: ${resolved}`);
            return [];
          }
          log.info(`[Chat] Image has no ledger row (pre-ledger upload), allowing: ${resolved}`);
        } else if (owner.userId !== null && owner.userId !== actorUserId) {
          // 台账明确说它是别人的 —— 无论如何都不放行。
          log.warn(
            `[Chat] Dropping image owned by another user: ${resolved} `
            + `(owner=${owner.userId}, actor=${actorUserId})`,
          );
          return [];
        }
      }

      return [{ ...descriptor, path: resolved }];
    }

    // 台账兜底:绝对路径 + 台账里记着它属于这条会话,才认。
    if (ledgerOwner && sessionId && path.isAbsolute(descriptor.path)) {
      const resolved = path.resolve(descriptor.path);
      const owner = ledgerOwner(resolved);
      // 与上面全局库那条分支同口径:台账记着它属于这条会话,且是发送者自己传的。
      if (owner && owner.sessionId === sessionId && (actorUserId === null || actorUserId === undefined || String(owner.userId) === String(actorUserId))) {
        log.info(`[Chat] Image accepted by attachment ledger (outside configured roots): ${resolved}`);
        return [{ ...descriptor, path: resolved }];
      }
    }

    log.warn(
      `[Chat] Dropping image outside the upload store: ${descriptor.path} `
      + `(roots=${roots.join(',')}; ledger=${ledgerOwner && sessionId ? 'checked' : 'skipped'})`,
    );
    return [];
  });
}

/**
 * One provider runtime entry point. All five runtimes share this signature,
 * which lets the chat handler dispatch through a provider-keyed map instead
 * of provider-specific branches.
 */
type ProviderSpawnFn = (
  command: string,
  options: AnyRecord,
  writer: unknown
) => Promise<unknown>;

type ChatWebSocketDependencies = {
  /** Provider runtimes keyed by provider id. */
  spawnFns: Record<LLMProvider, ProviderSpawnFn>;
  /**
   * Abort functions keyed by provider id. They are addressed with the
   * provider-native session id (that is how runtimes key their process maps).
   * The Claude abort is async; the rest are sync — both shapes are accepted.
   *
   * The optional context carries the gateway runId (the app session id, the
   * same value chat.send passes as options.runId). Claude uses it to abort a
   * run whose provider-native id has not been captured yet — the whole first
   * turn of a brand-new conversation; providers that don't support it simply
   * ignore the extra argument.
   */
  abortFns: Record<
    LLMProvider,
    (providerSessionId: string, context?: { runId?: string }) => boolean | Promise<boolean>
  >;
  /** 撤回一条合流进 CLI 队列的消息(还在队列里才撤得到)。 */
  cancelMergedFns?: Partial<Record<
    LLMProvider,
    (appSessionId: string, uuid: string) => Promise<{ cancelled: boolean; reason?: string }>
  >>;
  /**
   * 合流:会话忙着时,把用户这条话直接推进 provider 的命令队列,
   * 而不是攒在 `pendingSends` 里等这一轮跑完。
   *
   * 可选注入:没接线、或这一次不成立(带了图片;provider 侧没有常驻 runtime、没有用户回合在跑、
   * 发送者或权限档位与 runtime 不一致等)时照旧走排队;合流是增强,不替代排队。
   */
  mergeFns?: Partial<Record<
    LLMProvider,
    (
      appSessionId: string,
      options: {
        command: string;
        providerSessionId?: string | null;
        /** 发送者身份与这次的运行时选项:provider 侧据此核对"同一个人、同一个档位"。 */
        actorUsername?: string | null;
        ownerUserId?: number | null;
        runtimeOptions?: AnyRecord;
      },
    ) => Promise<{ merged: boolean; reason?: string; uuid?: string }>
  >>;
  /**
   * 预先拉起一段对话的常驻运行时(可选注入)。
   *
   * 打开旧对话到发出第一条消息之间通常有几秒到十几秒空档(用户在读上文、在打字),
   * 冷启动放进这个空档,用户按回车后就不用再等。失败一律吞掉:预热只是优化,
   * 失败了只是回到冷启动的速度。
   *
   * `runId` 是 app 会话 id(按它查这条会话选过的模型),`actorUserId` / `actorUsername` /
   * `ownerUserId` 是打开这段对话的人:网关与 key、「可用人员」按他解析,runtime 也记在他名下。
   */
  prewarmSession?: (options: {
    sessionId: string;
    cwd?: string;
    runId?: string;
    actorUserId?: number | null;
    actorUsername?: string | null;
    ownerUserId?: number | null;
  }) => Promise<unknown>;
  /**
   * 反查一个待批准请求挂在哪个 provider 会话上,给鉴权用 —— 这条消息只带
   * requestId,没有它就无法判断调用方有没有资格替这个会话作决定。
   */
  getToolApprovalSessionId: (requestId: string) => string | null;
  resolveToolApproval: (
    requestId: string,
    payload: {
      allow: boolean;
      updatedInput?: unknown;
      message?: string;
      rememberEntry?: unknown;
    }
  ) => void;
  /**
   * Claude-only today: pending tool approvals included in `chat_subscribed`.
   *
   * 接受 app 会话 id 或 provider 原生 id,两者都能命中。用 app id 调是关键 ——
   * provider 原生 id 在一轮对话开局是 null,用它查会漏掉整个第一轮的待批请求。
   */
  getPendingApprovalsForSession: (sessionId: string) => unknown[];
};

/**
 * Extracts the authenticated request user id in the formats currently produced
 * by platform and OSS auth code paths.
 */
function readRequestUserId(
  request: AuthenticatedWebSocketRequest | undefined
): string | number | null {
  const user = request?.user;
  if (!user) {
    return null;
  }

  if (typeof user.id === 'string' || typeof user.id === 'number') {
    return user.id;
  }

  if (typeof user.userId === 'string' || typeof user.userId === 'number') {
    return user.userId;
  }

  return null;
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WS_OPEN_STATE) {
    ws.send(JSON.stringify(payload));
  }
}

/**
 * 收下这一条的回执。
 *
 * `accepted` = 已经登记成回合、收进排队或合流进 CLI 队列;`duplicate` = 同一个
 * 幂等键之前收过,这次什么都没做。两者对前端是同一个意思:服务端有了,别再发。
 * 分开写只是为了排查时能看出来是哪一种。
 *
 * 没有 `clientMessageId` 的请求不回 ACK —— 前端无从对账。
 */
function sendSendAck(
  ws: WebSocket,
  sessionId: string,
  clientMessageId: string | null,
  status: 'accepted' | 'duplicate',
  /** 非空表示这条已合流进 CLI 队列:前端据此给气泡挂「撤回」(带着 uuid 发 chat.cancel-queued)。 */
  mergedUuid: string | null = null,
): void {
  if (!clientMessageId) return;
  sendJson(ws, {
    kind: 'chat_ack',
    sessionId,
    clientMessageId,
    status,
    ...(mergedUuid ? { merged: true, mergedUuid } : {}),
    timestamp: new Date().toISOString(),
  });
}

/**
 * 合流消息 uuid → 落库的那一行 / 乐观气泡。只在"还撤得回"的那段时间里有用:
 * 送达(`delivered`)或撤回(`withdrawn`)后就删;进程没了,claude-sdk 也会按撤回报来(releaseRuntimeSideState)。
 *
 * 不按时间过期,只按条数封顶(插入顺序,先删最老的):插话用 'next' 要等到下一个主线程工具间隙才送达,
 * 前台子代理一跑可能超过半小时,按时间过期会让「撤回」误答"已送达"、停止时也标不上"已撤回"。
 */
type MergedRow = { sessionId: string; rowId: string | null; clientMessageId: string | null };
const mergedRows = new Map<string, MergedRow>();
const MERGED_ROWS_MAX = 500;

function rememberMergedRow(uuid: string, row: MergedRow): void {
  mergedRows.set(uuid, { ...row });
  for (const key of mergedRows.keys()) {
    if (mergedRows.size <= MERGED_ROWS_MAX) break;
    mergedRows.delete(key);
  }
}

/**
 * claude-sdk 报来的合流消息去向(组合根接线 setMergedMessageHook)。
 *
 * - `withdrawn`:没执行就撤掉了(停止时 CLI 撤的,或用户点了撤回)。落库那一行标 `withdrawn`(刷新后仍置灰),
 *   广播 `chat_merged_withdrawn` 让在线端把气泡置灰、收起撤回;
 * - `delivered`:已经被模型读进某一轮,撤不回了,广播 `chat_merged_delivered`,前端收起「撤回」。
 */
export function handleMergedMessageEvent(event: { type: 'withdrawn' | 'delivered'; appSessionId: string; uuids: string[]; reason?: string | null }): void {
  if (!event || !Array.isArray(event.uuids) || event.uuids.length === 0) return;
  const rows = event.uuids
    .map((uuid) => ({ uuid, row: mergedRows.get(uuid) ?? null }))
    .filter((entry) => entry.row && entry.row.sessionId === event.appSessionId);
  for (const { uuid } of rows) mergedRows.delete(uuid);
  if (event.type === 'withdrawn') {
    for (const { row } of rows) {
      if (row?.rowId) sessionMessagesDb.markWithdrawn(event.appSessionId, row.rowId);
    }
  }
  broadcastToSessionViewers(event.appSessionId, {
    kind: event.type === 'withdrawn' ? 'chat_merged_withdrawn' : 'chat_merged_delivered',
    sessionId: event.appSessionId,
    mergedUuids: event.uuids,
    clientMessageIds: rows.map(({ row }) => row?.clientMessageId).filter(Boolean),
    messageIds: rows.map(({ row }) => row?.rowId).filter(Boolean),
    ...(event.reason ? { reason: event.reason } : {}),
    timestamp: new Date().toISOString(),
  });
}

/** 测试用。 */
export function resetMergedRowsForTest(): void {
  mergedRows.clear();
}

/**
 * Reports a protocol-level failure to the requesting client.
 *
 * Protocol errors deliberately use their own `kind` (instead of the provider
 * `error` message kind) so the frontend can distinguish "your request was
 * invalid" from "the model run produced an error" without inspecting text.
 */
function sendProtocolError(
  ws: WebSocket,
  code: string,
  error: string,
  sessionId?: string,
  /**
   * 这条错在回哪种请求。同一个 code 在不同请求上意义不同(`SESSION_NOT_FOUND`
   * 在 chat.send 上表示会话已经没了,在 permission-response 上表示没有这条待批),
   * 客户端只对 `chat.send` 那一种切「会话已被删除」态。
   */
  request?: 'chat.send' | 'chat.abort' | 'chat.subscribe' | 'permission-response' | 'chat.cancel-queued',
  /** 附带字段(撤回插话失败时带上 mergedUuid,前端据此收起那一条的「撤回」)。 */
  extra?: Record<string, unknown>,
): void {
  sendJson(ws, {
    kind: 'protocol_error',
    code,
    error,
    sessionId: sessionId ?? null,
    ...(request ? { request } : {}),
    ...(extra ?? {}),
    timestamp: new Date().toISOString(),
  });
}

/**
 * 一条会话最多收一条「排队中」的消息。
 *
 * 前端也有自己的排队(存在浏览器 localStorage 里),但它盖不住两种情况:
 *
 *   1. 判定竞态:前端以为空闲、服务端还在跑(上一轮刚结束的帧还在路上、
 *      或者另一台设备刚发过一条)。这时前端照常发,服务端若直接拒,那条消息就没了。
 *   2. 关掉标签页:前端的队列在 localStorage 里,页面一关就没人替它发。
 *
 * 所以服务端收下这一条,回合结束后自动续发。只收一条:排两条以上就等于允许
 * 用户把一串指令扔进黑盒,中间那条的结果他根本没看到就发了下一条 ——
 * 那不是排队,是盲发。第二条明确拒绝,并告诉他已经有一条在等。
 *
 * 撤销:`chat.cancel-queued`。
 */
type PendingSend = {
  ws: WebSocket;
  userId: string | number | null;
  data: AnyRecord;
  enqueuedAt: number;
  /** 预览文案,给"已排队"提示用;不参与发送。 */
  preview: string;
};

const pendingSends = new Map<string, PendingSend>();

/**
 * 客户端 options 白名单:只有这几个键能进运行时。
 *
 * 必须是白名单,不能是"删掉危险键"的黑名单:运行时能读的键有二十来个(`ownerUserId` /
 * `usageSource` / `resumeSessionId` / `runId` / `imageRoots` / `oneShot` / `newSessionId`…),
 * 新加一个键黑名单不会跟着改,漏一个就是越权。例如 `{ oneShot: true, newSessionId: "<别人的会话 id>" }`:
 * 一次性路径把 newSessionId 直接钉成 SDK 的 transcript id(`claude-sdk.js` 的 `mapCliOptionsToSDK`,
 * 优先级高于 resume),回灌给网关后 `assignProviderSessionId` 会删掉撞号的那条别人的会话行,
 * 并把它的 transcript 并进攻击者那行(会话 id 就在地址栏里,不是密钥)。
 * 白名单漏加只会让一个新功能不生效,看得见,不会打开新洞。
 *
 * 名单就是前端 `buildSendOptions` 真正会发的那几项。`images` / `forkFrom` / `hiddenContext` /
 * `projectPath` 不在这里:它们各有专门的校验分支(重新落盘校验 / 归属校验 / 剥离 / 数据库优先),
 * 走白名单反而会绕过那些分支。
 */
const CLIENT_RUNTIME_OPTION_KEYS = [
  'model',
  'effort',
  'permissionMode',
  'toolsSettings',
  'skipPermissions',
  'sessionSummary',
] as const;

export function pickClientRuntimeOptions(clientOptions: AnyRecord): AnyRecord {
  const picked: AnyRecord = {};
  for (const key of CLIENT_RUNTIME_OPTION_KEYS) {
    if (clientOptions[key] !== undefined) picked[key] = clientOptions[key];
  }
  return picked;
}

/**
 * 这条会话有没有排队中(含正在派发)的消息,删除会话前要看它:
 * 排队的那条会在回合结束后被 drain 出去,给一条已删除的会话起新一轮。
 */
export function hasPendingSendForSession(appSessionId: string): boolean {
  return pendingSends.has(appSessionId) || drainingSends.has(appSessionId);
}

/**
 * 排队消息的定时清扫。
 *
 * TTL 不能只在 `scheduleDrainPendingSend` 里检查:那个函数只在某一轮结束或有人 subscribe
 * 这条会话时才被调用。排了消息之后既没有新回合、也没人再打开的会话,其 `PendingSend`
 * (含最大 4 MiB 的 `data` 和一个已关闭 socket 的引用)会一直留在内存里。
 *
 * `unref()`:清扫不该把进程钉在事件循环上。
 */
const PENDING_SEND_SWEEP_MS = 5 * 60_000;
const pendingSendSweeper = setInterval(() => {
  const now = Date.now();
  for (const [sessionId, pending] of pendingSends) {
    if (now - pending.enqueuedAt > PENDING_SEND_TTL_MS) {
      dropPendingSend(sessionId, 'expired');
    }
  }
}, PENDING_SEND_SWEEP_MS);
pendingSendSweeper.unref?.();

/**
 * 已认领、正在派发中的续发。
 *
 * `scheduleDrainPendingSend` 先把消息从 pendingSends 里摘掉(认领,防重发),再走
 * `handleChatSend`,后者在 `startRun` 之前还有几段 await(抄历史、图片上传等)。这段窗口里
 * 回合还没登记、排队也已不在表里,用户按停止时两头都找不到可撤的东西,消息照样发出去。
 * 派发期间在这里留一个可取消的令牌,中止路径据此把它拦下。
 *
 * 令牌带着那条消息的 `clientMessageId`:撤销时发的 `chat_queue_cancelled` 要带上它,
 * 前端据此认出是哪一条本地回显没发出去。
 */
type PreparingToken = { cancelled: boolean; clientMessageId?: string | null };
const drainingSends = new Map<string, PreparingToken>();

type ChatRunHandle = NonNullable<ReturnType<typeof chatRunRegistry.startRun>>;

/**
 * 用户这一条还没推进 provider 的那几轮:run → 落库的那一行,以及这一轮落没落显示日志。
 *
 * 发送时登记,provider 推进输入的那一刻(`onTurnStarted`)撤掉。停止落在这段时间里(在等上一轮收尾、等 CLI
 * 自己那一轮跑完,或还在准备),这一条就不会再开跑,那一行要如实标成撤回,见 handleChatAbort。
 */
const unstartedUserTurns = new WeakMap<ChatRunHandle, { row: NormalizedMessage; persisted: boolean }>();

/**
 * 没开跑就作废的那一条:显示日志里那一行标 withdrawn,同一行带上 `withdrawn` 经这一轮再推一次,在线的人按同 id
 * 原位换成「已撤回,模型没有执行」。推的是这一轮自己的 writer,这一轮收尾之后就推不出去,所以要在收尾之前调。
 *
 * 这一轮的用户回合已经开跑、或这一轮不是 chat 网关发起的,什么都不做。停止的各个入口都调它:网页的 chat.abort、
 * 外部 API 的停止接口(routes/agent.js),都在发起中止之后、收尾之前。
 */
export function withdrawUnstartedUserTurn(run: ChatRunHandle): void {
  const pending = unstartedUserTurns.get(run);
  if (!pending) return;
  unstartedUserTurns.delete(run);
  if (pending.persisted) sessionMessagesDb.markWithdrawn(run.appSessionId, String(pending.row.id));
  run.writer.sendWithoutPersist({ ...pending.row, withdrawn: true });
}

/** `chat.send` 带的幂等键;没带(或不是非空字符串)为 null。 */
function clientMessageIdOf(data: AnyRecord | null | undefined): string | null {
  const value = data?.clientMessageId;
  return typeof value === 'string' && value ? value : null;
}

/**
 * 谁正在看哪条会话(chat.subscribe 登记,socket 关闭时摘掉)。
 *
 * 与 `broadcastToSessionViewers` 不同:那个按"能不能看见"过滤(权限),这个是
 * "此刻真的开着这条会话"(意愿)。推流集合跟后者走,按权限推会把整段助手输出
 * 发给共享项目里所有没在看的人。
 *
 * 用途:新一轮开跑时,把这些 socket 一并接进推流集合,空闲时订阅过的其他标签页才收得到这一轮。
 */
const sessionViewers = new Map<string, Set<WebSocket>>();

function rememberSessionViewer(sessionId: string, ws: WebSocket): void {
  let viewers = sessionViewers.get(sessionId);
  if (!viewers) {
    viewers = new Set();
    sessionViewers.set(sessionId, viewers);
  }
  viewers.add(ws);
}

function forgetViewerEverywhere(ws: WebSocket): void {
  for (const [sessionId, viewers] of sessionViewers) {
    if (viewers.delete(ws) && viewers.size === 0) sessionViewers.delete(sessionId);
  }
}

/**
 * 把所有正在看这条会话的 socket 接进这一轮的推流集合。
 *
 * 每一轮都重判可见性:项目改私有 / 共享被撤销后,只在 `chat.subscribe` 时判过的 socket
 * 不能继续收后续回合的帧(工具结果正文、文件内容、审批请求)。`broadcastToSessionViewers`
 * 每帧重判,两条推流路径口径必须一致。判不过的直接从 viewers 摘掉,不再接流。
 */
function attachSessionViewers(sessionId: string): void {
  const viewers = sessionViewers.get(sessionId);
  if (!viewers) return;
  for (const viewer of viewers) {
    if (viewer.readyState !== WS_OPEN_STATE) {
      viewers.delete(viewer);
      continue;
    }
    if (!canViewerSeeSession(sessionId, readSocketViewer(viewer))) {
      viewers.delete(viewer);
      continue;
    }
    chatRunRegistry.attachConnection(sessionId, viewer);
  }
  if (viewers.size === 0) sessionViewers.delete(sessionId);
}

/**
 * 注册到回合注册表:四个 `startRun` 调用点(网页聊天、定时任务、外部 API 同步/异步)
 * 都走这一步,任何来源起的回合都会推给已经开着这条会话的浏览器。
 */
setRunStartedHook(attachSessionViewers);

/** 排队消息的存活上限。超时的不再发 —— 半小时前那句话的语境早就不在了。 */
const PENDING_SEND_TTL_MS = 30 * 60 * 1000;

/**
 * 把一帧发给所有能看到这条会话的在线 socket。
 *
 * 排队状态不是私事:同一个人开两个标签页、或者共享项目里的另一位,都该看到
 * "有一条在等"。只回给发起方会让另一个标签页在回合结束后突然冒出一条不知
 * 哪来的消息。
 */
function broadcastToSessionViewers(sessionId: string, payload: unknown): void {
  const frame = JSON.stringify(payload);
  for (const client of connectedClients) {
    try {
      const socket = client as unknown as WebSocket;
      if (socket.readyState !== WS_OPEN_STATE) continue;
      if (!canViewerSeeSession(sessionId, readSocketViewer(socket))) continue;
      socket.send(frame);
    } catch {
      // 单个 socket 出错不影响其余
    }
  }
}

/**
 * 按查看者分别造帧的广播:排队消息的正文只给排它的人,别人拿到脱敏版。
 * `chat_queued` 的 preview 与 `chat_queue_cancelled` 退回的 content 都走这条。
 */
function broadcastToSessionViewersPerViewer(
  sessionId: string,
  build: (viewer: { userId?: string | number | null } | null) => unknown,
): void {
  for (const client of connectedClients) {
    try {
      const socket = client as unknown as WebSocket;
      if (socket.readyState !== WS_OPEN_STATE) continue;
      const viewer = readSocketViewer(socket);
      if (!canViewerSeeSession(sessionId, viewer)) continue;
      socket.send(JSON.stringify(build(viewer)));
    } catch {
      // 单个 socket 出错不影响其余
    }
  }
}

/** 这条排队消息是不是这个查看者自己排的。 */
function isPendingOwner(pending: { userId: string | number | null | undefined }, viewer: { userId?: string | number | null } | null): boolean {
  return String(pending.userId ?? '') === String(viewer?.userId ?? '');
}

/**
 * 后台子代理要审批、而此刻没有用户回合时,审批卡送到哪。
 * 开着观测回合(CLI 自己那一轮)就用它的 writer(与那一轮的帧同一条流);否则广播给能看这段对话的人。
 * 没人在线也照样登记(claude-sdk 那边挂着等),刷新 / 重连时由 `chat.subscribe` 的 pendingPermissions 补上。
 */
export function backgroundApprovalWriter(appSessionId: string): { send: (message: unknown) => void; sendAndCountDelivered: (message: unknown) => number } {
  const deliver = (message: unknown): number => {
    const run = chatRunRegistry.getRun(appSessionId);
    if (run && run.status === 'running' && typeof (run.writer as { sendAndCountDelivered?: unknown }).sendAndCountDelivered === 'function') {
      return (run.writer as unknown as { sendAndCountDelivered: (m: unknown) => number }).sendAndCountDelivered(message);
    }
    let delivered = 0;
    const frame = JSON.stringify(message);
    for (const client of connectedClients) {
      try {
        const socket = client as unknown as WebSocket;
        if (socket.readyState !== WS_OPEN_STATE) continue;
        if (!canViewerSeeSession(appSessionId, readSocketViewer(socket))) continue;
        socket.send(frame);
        delivered += 1;
      } catch {
        // 单个 socket 出错不影响其余
      }
    }
    return delivered;
  };
  return { send: (message) => { deliver(message); }, sendAndCountDelivered: deliver };
}

/**
 * 后台任务条。claude-sdk 每收到一次 `background_tasks_changed`(全量表)就报过来,
 * 这里记下最新一份并推给正在看这段对话的人;`chat.subscribe`(刷新 / 重连)时补发一次。
 */
type BackgroundTaskEntry = { taskId: string; taskType: string; description: string };
const latestBackgroundTasks = new Map<string, BackgroundTaskEntry[]>();

export function broadcastBackgroundTasks(payload: { appSessionId: string; tasks: BackgroundTaskEntry[]; reason?: string }): void {
  if (!payload?.appSessionId) return;
  const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
  if (tasks.length > 0) latestBackgroundTasks.set(payload.appSessionId, tasks);
  else latestBackgroundTasks.delete(payload.appSessionId);
  broadcastToSessionViewers(payload.appSessionId, backgroundTasksFrame(payload.appSessionId, tasks));
}

function backgroundTasksFrame(sessionId: string, tasks: BackgroundTaskEntry[]) {
  return { kind: 'background_tasks', sessionId, tasks, timestamp: new Date().toISOString() };
}

/**
 * 某段对话的常驻进程被名额挤掉了,告诉正在看它的人一声。
 *
 * 被挤掉本身是正常且必要的(池子有上限),但它是静默的:那段对话的下一条消息要
 * 重建进程并 resume,会慢几秒。这条帧让界面能给一句可解释的提示。用 `status`
 * 类型是因为它就是状态,不是错误 —— 什么都没坏,也不需要用户处理。
 */
export function broadcastRuntimeEvicted(payload: { sessionId: string; reason: string }): void {
  if (!payload?.sessionId) return;
  broadcastToSessionViewers(payload.sessionId, {
    kind: 'status',
    sessionId: payload.sessionId,
    status: 'runtime_evicted',
    reason: payload.reason,
    content: '这段对话的常驻进程因为名额被回收了 —— 下一条消息会重新拉起它,可能稍慢几秒。',
    timestamp: new Date().toISOString(),
  });
}

/**
 * 会话被永久删除,通知所有还看得到它的人。
 *
 * 两段式:删除前先定下"现在谁看得见这条会话"的名单(判定要靠 sessions 行,行一删就判不出来),
 * 行删掉之后再发帧。这样客户端收到帧时服务端状态已经一致,它随后刷侧栏还是重发,
 * 拿到的都是"已经没了"。
 */
export function prepareSessionRemovedBroadcast(sessionId: string): (payload: {
  reason: 'deleted' | 'project_deleted';
  deletedBy?: string | null;
  sessionName?: string | null;
  restorable?: boolean;
}) => number {
  const recipients: WebSocket[] = [];
  for (const client of connectedClients) {
    try {
      const socket = client as unknown as WebSocket;
      if (socket.readyState !== WS_OPEN_STATE) continue;
      if (!canViewerSeeSession(sessionId, readSocketViewer(socket))) continue;
      recipients.push(socket);
    } catch {
      // 单个 socket 出错不影响其余
    }
  }
  return (payload) => {
    const frame = JSON.stringify({
      kind: 'session_removed',
      sessionId,
      reason: payload.reason,
      deletedBy: payload.deletedBy ?? null,
      sessionName: payload.sessionName ?? null,
      restorable: payload.restorable !== false,
      timestamp: new Date().toISOString(),
    });
    let sent = 0;
    for (const socket of recipients) {
      try {
        if (socket.readyState !== WS_OPEN_STATE) continue;
        socket.send(frame);
        sent += 1;
      } catch {
        // 单个 socket 出错不影响其余
      }
    }
    return sent;
  };
}

/**
 * 会话从最近删除里恢复了:给所有现在看得见它的 socket 推一帧。
 *
 * 与 `prepareSessionRemovedBroadcast` 的区别在于名单什么时候定:删除要在动行之前收名单
 * (行没了就判不出可见性),恢复时行已经回来了,当场收即可。
 *
 * 不复用 `announceSessionUpsert`:那条路有 `if (row.isArchived) return` 的闸门(侧栏不该让
 * 归档会话弹回活跃列表),而恢复一条归档态的会话同样要通知前端撤掉「已被删除」态,
 * 否则页面会一直卡在删除态。
 */
export function broadcastSessionRestored(sessionId: string): number {
  const frame = JSON.stringify({
    kind: 'session_restored',
    sessionId,
    timestamp: new Date().toISOString(),
  });
  let sent = 0;
  for (const client of connectedClients) {
    try {
      const socket = client as unknown as WebSocket;
      if (socket.readyState !== WS_OPEN_STATE) continue;
      if (!canViewerSeeSession(sessionId, readSocketViewer(socket))) continue;
      socket.send(frame);
      sent += 1;
    } catch {
      // 单个 socket 出错不影响其余
    }
  }
  return sent;
}

function queuedFrame(sessionId: string, pending: PendingSend, viewer: { userId?: string | number | null } | null = null) {
  const own = isPendingOwner(pending, viewer);
  return {
    kind: 'chat_queued',
    sessionId,
    // 正文预览只给排它的人;别人拿到空串 + redacted 标记(客户端据此显示占位,而不是把空串当"没正文")
    preview: own ? pending.preview : '',
    redacted: !own,
    enqueuedAt: new Date(pending.enqueuedAt).toISOString(),
    timestamp: new Date().toISOString(),
  };
}

/**
 * 丢弃一条排队消息并广播。`reason` 会显示给用户 —— "被撤销"和"因为你中止了
 * 回合"是两回事,不说清楚就变成消息凭空消失。
 */
function dropPendingSend(sessionId: string, reason: 'cancelled' | 'aborted' | 'expired' | 'undeliverable'): boolean {
  const pending = pendingSends.get(sessionId);
  if (!pendingSends.delete(sessionId)) return false;
  // 被中止带走的那条要把正文一起还回去,前端会把它退回输入框。
  //
  // 「停止」是刹车,不该顺手替用户开跑下一段;但也不能吞掉他打过的字,
  // "排一条纠正再按停止"正是引导 agent 最顺手的操作。所以正文原样退回,发不发交给用户。
  // 撤销(cancelled)是用户自己删的,不退;过期(expired)的语境早已不在,也不退,只留一句说明;
  // `undeliverable`(续发没能成立)同样退正文:用户没做错什么,那段话不能凭空消失。
  const content = (reason === 'aborted' || reason === 'undeliverable')
    && typeof pending?.data?.content === 'string'
    ? pending.data.content
    : null;
  const clientMessageId = clientMessageIdOf(pending?.data);
  // 退回的正文只退给排它的人:共享会话里别人的输入框不该被灌进这段话。
  // clientMessageId 人人都带:前端只在本标签页确实发过这一条时才回填、才把那条本地回显标成未发送。
  broadcastToSessionViewersPerViewer(sessionId, (viewer) => ({
    kind: 'chat_queue_cancelled',
    sessionId,
    reason,
    ...(clientMessageId ? { clientMessageId } : {}),
    ...(content && pending && isPendingOwner(pending, viewer) ? { content } : {}),
    timestamp: new Date().toISOString(),
  }));
  return true;
}

function readRequiredSessionId(data: AnyRecord): string | null {
  const sessionId = typeof data.sessionId === 'string' ? data.sessionId.trim() : '';
  return sessionId.length > 0 ? sessionId : null;
}

/**
 * 编辑重跑的父会话必须过归属校验。
 *
 * `forkFrom.providerSessionId` 会直接变成 SDK 的 `resume`,即把那条会话的 transcript
 * 当成本轮上下文加载进来,不能原样信任客户端。能不能真的读到别人的对话还取决于 CLI
 * 解析 `--resume` 时找不找得到跨项目的 transcript,但这不是省掉校验的理由。
 *
 * 校验不过就丢弃 `forkFrom`(降级成一条普通新会话)并回一条协议错误,而不是整轮拒绝:
 * 用户看得懂"分叉没成立",一轮对话凭空失败则看不懂。
 */
function resolveAuthorizedFork(
  forkFrom: AnyRecord | undefined,
  viewer: { userId: number | null; username: string | null },
  ws: WebSocket,
): AnyRecord | undefined {
  if (!forkFrom || typeof forkFrom !== 'object') return undefined;

  const parentProviderId = typeof forkFrom.providerSessionId === 'string'
    ? forkFrom.providerSessionId
    : '';
  if (!parentProviderId) return undefined;

  const parent = sessionsDb.getSessionByProviderSessionId(parentProviderId);
  if (!parent?.session_id || !canViewerSeeSession(parent.session_id, viewer)) {
    sendProtocolError(
      ws,
      'FORK_PARENT_NOT_FOUND',
      '找不到可以分叉的父会话(或你没有权限看它)—— 这一轮按新会话发送。',
    );
    return undefined;
  }
  return forkFrom;
}

/**
 * Handles `chat.send`: resolves the session row (provider, project path, and
 * provider-native id all come from the database — never from the client),
 * registers the run, and dispatches to the provider runtime.
 */
async function handleChatSend(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies,
  /**
   * 续发派发令牌:中止路径可以在 startRun 之前把这一条拦下来。
   * `onAccepted` 在 run 真的登记之后回调,续发据此才广播 `chat_queue_flushed`
   * (先无条件广播的话,任何一条早退分支都会让排队卡消失而消息没发出去)。
   */
  drainToken?: PreparingToken & { onAccepted?: () => void },
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.send requires a sessionId.');
    return;
  }

  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    // 这句是给日志 / 开发者看的;客户端按 code + request 切成「这条会话已被删除」态,不原样显示它。
    sendProtocolError(
      ws,
      'SESSION_NOT_FOUND',
      `Session "${sessionId}" was not found. Create it via POST /api/providers/sessions first.`,
      sessionId,
      'chat.send',
    );
    return;
  }

  /**
   * 授权身份取自 `userId`(发送方),不是 `ws`(回话用的那个 socket)。
   *
   * 两者平时相等,唯独排队消息续发时不等:入队 socket 已关闭时,`scheduleDrainPendingSend`
   * 会从 `sessionViewers` 里挑一个还活着的别人的 socket 当回话对象。若拿它当身份,
   * A 在共享会话里排了消息、随后访问被撤销,续发会按仍在看的 B 的身份通过校验,A 的消息照样执行。
   *
   * `ws` 只是回话通道(协议错误发给它),不是身份来源。
   */
  const authUserId = typeof userId === 'number' || typeof userId === 'string' ? Number(userId) : null;
  /**
   * 用户名要一起带上 —— root 是按 用户名(`PRISM_ROOT_USERS`)认的,
   * 只给 userId 会让 root 也被这道门挡住。
   *
   * 这次查询本来在下面为 `actorUsername` 做,提到这里一次查询两处用。
   */
  const authUsername = authUserId !== null ? userDb.getUserById(authUserId)?.username ?? null : null;
  const authViewer = { userId: authUserId, username: authUsername };

  // send 同样要过可见性门(abort / subscribe / permission-response 都有),而且是四条里影响最大的。
  //
  // 常驻 runtime 按 provider session id 建索引,键里没有用户(claude-sdk.js 的 `claudeRuntimes`);
  // `runtimeForSend` 每次都拿发送方的 permissionMode / allowedTools 覆盖 runtime 上的,还会对
  // 活着的子进程调 `setPermissionMode`。少了这道门,任何已登录的 socket 只要拿到会话 id,
  // 就能往别人的对话里发消息,顺带把自己的权限模式(包括 bypassPermissions)按到别人的运行时上。
  if (!canViewerSeeSession(sessionId, authViewer)) {
    sendProtocolError(ws, 'SESSION_NOT_FOUND', `Session "${sessionId}" was not found.`, sessionId, 'chat.send');
    return;
  }

  /**
   * 幂等门。
   *
   * 放在可见性检查之后 —— 否则任何已登录 socket 都能拿它探"这个会话 id
   * 存不存在、这条消息发过没有"。
   *
   * 同一个 `clientMessageId` 第二次到达时:只回 ACK,不执行。
   * 前端据此把 outbox 那条标成 acked、清掉排队记录,不会再重投。
   */
  const clientMessageId = typeof data.clientMessageId === 'string' ? data.clientMessageId : null;
  /**
   * 续发不过幂等门。
   *
   * 排队那一条在收下时已经登记过它的键了(见下面 `pendingSends` 那支),
   * 而续发是服务端拿着同一份 data 重新进这个函数 —— 按键判重会把它当成
   * 重复的客户端重发,于是排队的消息永远发不出去。
   *
   * `drainToken` 只有续发路径会传,拿它区分"客户端又发了一次"和
   * "服务端在续发自己已经收下的那一条"。
   */
  const isDrainReentry = Boolean(drainToken);
  if (!isDrainReentry && !registerSend(sessionId, clientMessageId)) {
    log.info(`[chat] duplicate send ignored for session ${sessionId} (clientMessageId=${clientMessageId})`);
    sendSendAck(ws, sessionId, clientMessageId, 'duplicate');
    return;
  }
  /**
   * 没回 ACK 的早退必须把幂等键退回去。
   *
   * 键在这里就登记了,而下面每条早退分支都不回 ACK(终端接管、provider 不支持、模型不可用、
   * 准备期被停止、抄历史之后的两道复检、分叉目标已有历史、排队位已满)。按"收到 ACK 才算发出去"
   * 的契约客户端会重投;键不退回,重投就撞上去重、拿到假的 `duplicate` ACK,这条消息既没执行
   * 也没有痕迹。详见 chat-send-dedupe.ts 里 `forgetSend` 的说明。
   */
  const releaseSendKey = () => forgetSend(sessionId, clientMessageId);

  // 终端接管着这段对话时,chat 不能再往里写:那会变成两个进程追加同一份
  // transcript,谁也看不见谁。明确拒绝并说清楚怎么拿回来,比默默双写好。
  const holder = currentHolder(sessionId);
  if (holder) {
    const who = holder.username ? `(${holder.username})` : '';
    sendProtocolError(
      ws,
      'SESSION_HELD_BY_SHELL',
      `这段对话正在终端里被接管${who}。关掉那个终端后即可在这里继续 —— 两边同时写会互相覆盖。`,
      sessionId
    );
    releaseSendKey();
    return;
  }

  const provider = session.provider as LLMProvider;
  const spawnFn = dependencies.spawnFns[provider];
  if (!spawnFn) {
    sendProtocolError(ws, 'UNSUPPORTED_PROVIDER', `Provider "${provider}" is not available.`, sessionId);
    releaseSendKey();
    return;
  }

  /**
   * 模型前置检查:客户端带来的模型不在目录里 / 已下架就当场回一条协议错误,
   * 而不是起一轮再在运行时里失败。真正的闸口在 claude-sdk 的四条 SDK 路径上
   * (`active-model` 覆盖会绕过这里,那边再判一次)。放在抄显示日志之前:老会话抄一次能到秒级,拒了就不必抄。
   */
  const requestedModel = (data.options as AnyRecord | undefined)?.model;
  if (typeof requestedModel === 'string' && !claudeModelCatalog.isAllowed(requestedModel, modelViewerFor(authUserId, authUsername))) {
    sendProtocolError(
      ws,
      'MODEL_NOT_ALLOWED',
      `模型「${requestedModel}」不在模型目录里(或已下架,或你不在它的可用人员里)—— 这一条没有发出去。请在 /models 里另选一个。`,
      sessionId,
    );
    releaseSendKey();
    return;
  }

  /**
   * 回合开始之前,先确保这个会话的显示日志是完整的。
   *
   * 老会话(这一轮之前建的)日志里一行都没有,而这次回合会往里写。写完之后
   * `fetchHistory` 就会改从日志读 —— 如果不先把已有历史抄进去,刷新页面时
   * 之前的对话会整段消失。抄一次就够,之后这个会话永久归日志管。
   *
   * 放在 `startRun` 之前:抄的是"这次发送之前"的历史,顺序天然对得上,
   * 也不会和本回合正在写入的新消息抢同一批 id。
   */
  // 抄写结果要看。失败(读不动 transcript / 整批没落成)时本轮整轮不落日志:
  // 落哪怕一行,fetchHistory 就改判日志为权威,老会话几百条历史立刻从界面消失且不可恢复。
  // 这一轮继续走 transcript,下轮再抄一次。
  /**
   * 直接发送的准备期也要能被停止。
   *
   * 普通 `chat.send` 在这段 await(老会话读整份 transcript,能到秒级)里既没有 run、也没有
   * 排队记录;不在 `drainingSends` 登记的话,`chat.abort` 三个分支全落空、回 `NO_ACTIVE_RUN`,
   * seed 返回之后这一轮照常起跑。
   *
   * 与续发共用同一张令牌表:调用方传进来的(续发)优先,没有就自己登记一张。
   */
  const preparingToken: PreparingToken = drainToken ?? { cancelled: false, clientMessageId };
  const ownsPreparingToken = !drainToken;
  if (ownsPreparingToken) drainingSends.set(sessionId, preparingToken);
  let seedOutcome;
  try {
    seedOutcome = await seedDisplayLogFromTranscript(sessionId);
  } finally {
    if (ownsPreparingToken && drainingSends.get(sessionId) === preparingToken) {
      drainingSends.delete(sessionId);
    }
  }
  const persistDisplayLog = seedOutcome.status === 'ready';
  if (!persistDisplayLog) {
    log.warn(
      `[display-log] seed failed for session ${sessionId}; skipping display-log writes this turn to keep history intact.`,
    );
  }

  // 抄历史那几段 await 期间用户按了停止:这一条作废,不再开回合。
  //
  // 用 `chat_queue_cancelled` + reason:'aborted' + content,复用前端已接好的那条路:清掉排队
  // 指示器、正文退回输入框(见 useChatRealtimeHandlers 的 chat_queue_cancelled 分支)。
  // 不另造新的 kind:前端不认识的 kind 会让指示器一直挂着,还会作为未知行混进消息列表。
  //
  // 按查看者分别造帧:正文只退给发起这一条的人(与 dropPendingSend 同一判据,比 userId)。
  // 停止可能是共享会话里别人按的,整包广播会把发起人还没发出去的话灌进别人的输入框。
  if (preparingToken.cancelled) {
    const droppedContent = typeof data.content === 'string' ? data.content : null;
    broadcastToSessionViewersPerViewer(sessionId, (viewer) => ({
      kind: 'chat_queue_cancelled',
      sessionId,
      reason: 'aborted',
      ...(clientMessageId ? { clientMessageId } : {}),
      ...(droppedContent && isPendingOwner({ userId }, viewer) ? { content: droppedContent } : {}),
      timestamp: new Date().toISOString(),
    }));
    releaseSendKey();
    return;
  }

  /**
   * seed 那段 await 之后,可见性与终端接管要再判一次(停止已由上面的 `preparingToken.cancelled` 判过)。
   *
   * 前面那两道检查发生在 `await seedDisplayLogFromTranscript` 之前,而那一步要读整份 transcript,
   * 老会话能到秒级。这段窗口里可能:
   *   - 共享被撤销:一条本不该发的消息照样发进去;
   *   - 终端刚接管这段对话:chat 和 PTY 同时写同一份 transcript(所有权登记要消掉的正是这种双写)。
   */
  if (!canViewerSeeSession(sessionId, authViewer)) {
    sendProtocolError(ws, 'SESSION_NOT_FOUND', `Session "${sessionId}" was not found.`, sessionId, 'chat.send');
    releaseSendKey();
    return;
  }
  const holderAfterSeed = currentHolder(sessionId);
  if (holderAfterSeed) {
    const who = holderAfterSeed.username ? `(${holderAfterSeed.username})` : '';
    sendProtocolError(
      ws,
      'SESSION_HELD_BY_SHELL',
      `这段对话刚被终端接管${who} —— 这一条没有发出去。关掉那个终端后可以重发。`,
      sessionId,
    );
    releaseSendKey();
    return;
  }

  /**
   * 分叉不能接在已有历史的会话后面:明确回协议错误,不无声丢弃。
   *
   * 下面 runtimeOptions 里 `forkFrom` 只在目标会话没有原生 id 时才认,否则静默置 undefined;
   * 放行的话,编辑后的内容会追加进原对话、带着本该丢弃的旧上下文,客户端却拿到 accepted。
   * 前端的编辑重跑总是新开一支(清空 sessionId),这里是最后一道门。
   */
  if (session.provider_session_id && (data.options as AnyRecord | undefined)?.forkFrom) {
    sendProtocolError(
      ws,
      'FORK_TARGET_HAS_HISTORY',
      '「编辑重跑」要开一条新会话,不能接在已有历史的会话后面 —— 这一条没有发出去。',
      sessionId,
    );
    releaseSendKey();
    return;
  }

  const run = chatRunRegistry.startRun({
    appSessionId: sessionId,
    provider,
    providerSessionId: session.provider_session_id,
    connection: ws,
    userId,
    persistDisplayLog,
  });

  if (run) {
    // 推流集合由 `startRun` 的 runStartedHook 统一接(见 chat-run-registry),四个调用点共用同一步,
    // 这里不必再接。续发到这里才算真的成立(所有早退分支都已走完)。
    drainToken?.onAccepted?.();
    // 回合已登记 = 服务端确实收下了这一条。
    sendSendAck(ws, sessionId, clientMessageId, 'accepted');
  }

  if (!run) {
    // 登记不上时不打回去:先试合流进 CLI 队列,不行就收下排队,
    // 回合结束自动续发(见 pendingSends)。
    if (pendingSends.has(sessionId)) {
      sendProtocolError(
        ws,
        'QUEUE_FULL',
        '这条会话已经有一条消息在排队了。等它发出去,或者先撤销那一条。',
        sessionId,
      );
      releaseSendKey();
      return;
    }

    const rawContent = typeof data.content === 'string' ? data.content : '';

    /**
     * 先试合流。
     *
     * 排队会把消息攒在 Prism 手里,画一张「已排队」卡片,等当前这一轮彻底跑完才重新发起一轮。
     * provider 那边本来就有命令队列(后台任务通知走的就是它),直接推进去、由 CLI 自己决定
     * 什么时候投递,才是"我打断你一句"的样子。
     *
     * 三条边界,任何一条不成立都退回排队:
     *   1. 带图片的不合流,见 `mergeUserMessage` 的说明;
     *   2. 已经有一条在排队的不合流,否则会绕过"排队上限一条"的契约,下面 QUEUE_FULL 的提示也不再属实;
     *   3. provider 侧不成立(没有常驻 runtime、没有用户回合在跑、发送者或权限档位与 runtime 不一致等,
     *      见 claude-sdk 的 mergeRefusalReason)。
     */
    const mergeFn = dependencies.mergeFns?.[provider];
    const mergeClientOptions = (data.options ?? {}) as AnyRecord;
    const clientImages = mergeClientOptions.images;
    const carriesImages = Array.isArray(clientImages) && clientImages.length > 0;
    /**
     * 合流路径同样带上 `hiddenContext` 和发送者身份。
     *
     * 「让 Claude 建定时任务」的票据与接口说明全在 hiddenContext 里,丢了它模型只收到那句人话,票据作废。
     * 身份与策略(actorUsername / ownerUserId / 权限档位)交给 provider 侧核对:与目标 runtime
     * 不是同一个人、同一个档位就不合流,退回排队。截断 / 剥离规则与下面 spawn 那条路相同
     * (见 `hiddenContext` 的说明)。
     */
    const mergeHiddenContext = typeof mergeClientOptions.hiddenContext === 'string'
      ? mergeClientOptions.hiddenContext.slice(0, 16_384).trim()
      : '';
    if (mergeFn && !carriesImages && !pendingSends.has(sessionId) && rawContent.trim()) {
      let merged: { merged: boolean; reason?: string; uuid?: string } = { merged: false, reason: 'not-attempted' };
      try {
        merged = await mergeFn(sessionId, {
          command: mergeHiddenContext ? `${rawContent}\n\n${mergeHiddenContext}` : rawContent,
          providerSessionId: session.provider_session_id ?? null,
          actorUsername: authUsername,
          ownerUserId: authUserId,
          runtimeOptions: pickClientRuntimeOptions(mergeClientOptions),
        });
      } catch (error) {
        log.warn('[chat] 合流失败,退回排队:', (error as Error)?.message || error);
      }
      if (merged.merged) {
        /**
         * 用户这条消息当场落库,同一行作为正在跑的这一轮的实时帧推给所有查看者。
         *
         * 与真回合那条路同一份写法(见下面 `hasUserContent` 那一段):实时帧走 `broadcastWithoutPersist`,
         * 不再落一次库。发起人那边按 `clientMessageId` 把乐观气泡换成这一行,别的查看者照常加一行。
         *
         * 这一笔比排队那条路早得多:排队期间刷新,那条乐观气泡就没了,只剩一张卡片;
         * 合流之后它一开始就在日志里。
         */
        const mergedRowId = generateMessageId('user');
        const mergedRow = {
          id: mergedRowId,
          sessionId,
          // 合流消息的 uuid 也是 CLI 认的轮次锚点
          ...(merged.uuid ? { turnUuid: merged.uuid } : {}),
          // 插话不开新的一轮:前端的时间轴 / 产出卡据此不把它当回合边界
          interjection: true,
          timestamp: new Date().toISOString(),
          provider,
          kind: 'text',
          role: 'user',
          content: rawContent,
          // 谁发起的这一轮 + 来源。效果调查卡只弹给发起人,定时任务 / API 的回合不弹。
          senderUserId: authUserId ?? undefined,
          origin: 'web',
          ...(clientMessageId ? { clientMessageId } : {}),
        } as NormalizedMessage;
        if (persistDisplayLog) {
          sessionMessagesDb.append(sessionId, mergedRow);
        }
        chatRunRegistry.broadcastWithoutPersist(sessionId, mergedRow);
        /**
         * 记下 uuid ↔ 这一行 / 这条乐观气泡:停止时 CLI 撤掉它、或用户点「撤回」时,
         * 要能把落了库的那一行标成"已撤回",并让在线端把气泡置灰(见 handleMergedMessageEvent)。
         * 观测回合的归属由 claude-sdk 按 uuid 判,不在这里记。
         *
         * 没落库(seed 失败)也记行 id:这一行已经作为实时帧到了每个查看者那里,撤回 / 送达的广播要能指认它;
         * 标"已撤回"那一笔对不存在的行是空操作。
         */
        if (merged.uuid) {
          rememberMergedRow(merged.uuid, { sessionId, rowId: mergedRowId, clientMessageId });
        }
        drainToken?.onAccepted?.();
        sendSendAck(ws, sessionId, clientMessageId, 'accepted', merged.uuid ?? null);
        return;
      }
      log.info(`[chat] ${sessionId} 这一条不合流(${merged.reason ?? 'unknown'}),走排队`);
    }

    const pending: PendingSend = {
      ws,
      userId,
      data,
      enqueuedAt: Date.now(),
      preview: rawContent.slice(0, 120),
    };
    /**
     * 重新排队也算"服务端收下了"。
     *
     * drain 认领的那条若在这里重新排上而不调 `onAccepted`,`.finally` 会把它当 undeliverable 丢掉:
     * 刚广播的 chat_queued 后面立刻跟一条 chat_queue_cancelled,排队的人若已关掉标签页,消息就此消失。
     *
     * 顺序:`onAccepted` 会广播 `chat_queue_flushed`(上一条排队已被取走),必须在重新广播
     * `chat_queued` 之前调;反过来,客户端最后收到的是"队列空了",而队列里明明还有这一条。
     */
    drainToken?.onAccepted?.();
    pendingSends.set(sessionId, pending);
    broadcastToSessionViewersPerViewer(sessionId, (viewer) => queuedFrame(sessionId, pending, viewer));
    // 排队也是"服务端收下了" —— 前端可以清掉本地那份,不必再投。
    sendSendAck(ws, sessionId, clientMessageId, 'accepted');
    return;
  }

  const clientOptions = (data.options ?? {}) as AnyRecord;
  const command = typeof data.content === 'string' ? data.content : '';
  // 除全局图库外,还放行本会话项目的 attachments/(聊天图片落在那里)。
  const sessionAttachmentRoots = session.project_path
    ? [path.join(session.project_path, ATTACHMENT_DIR_NAME)]
    : [];
  const sanitizedImages = filterImagesToUploadStore(
    clientOptions.images,
    undefined,
    sessionAttachmentRoots,
    (absPath) => attachmentsDb.ownerOf(absPath),
    sessionId,
    authUserId,
  );

  /**
   * 会话命名闭环。客户端每次发送都带 options.sessionSummary(新会话 = 首条消息摘要;
   * 技能调用为「技能名:参数」),服务端落库后侧栏名字刷新也不丢。只在 custom_name
   * 还空着时落一次,用户手动改名 / 已有名字永远优先。
   */
  const sessionSummary = typeof clientOptions.sessionSummary === 'string'
    ? clientOptions.sessionSummary.replace(/\s+/g, ' ').trim().slice(0, 80)
    : '';
  if (sessionSummary) {
    try {
      sessionsDb.setSessionCustomNameIfEmpty(sessionId, sessionSummary);
    } catch { /* 名字是锦上添花,落不上不拦发送 */ }
  }

  /**
   * 隐藏上下文:随消息附带、只给模型看的补充说明。
   *
   * 「让 Claude 创建定时任务」把一次性票据和接口用法装在这里:页面气泡和显示日志只落用户那句人话,
   * 发给运行时的提示词 = 人话 + 隐藏块。来源是已登录前端自己(与 content 同一信任级),
   * 截断到 16KB 防滥用;转发给运行时的 options 里剥掉它,不让它顺流进 provider 的参数层。
   */
  const hiddenContext = typeof clientOptions.hiddenContext === 'string'
    ? clientOptions.hiddenContext.slice(0, 16_384).trim()
    : '';
  delete clientOptions.hiddenContext;

  /**
   * 把用户这条消息本身写进显示日志,同一行再作为这一轮的实时帧推给所有查看者。
   *
   * 日志的其他内容都从出站帧收口(ChatSessionWriter.forward),而用户消息是入站的,没有对应的
   * 出站帧;不在这里落,刷新后用户气泡会整段消失,「编辑重跑 / ↑ 历史回填 / 失败重试」也随之失灵
   * (它们都以历史里的用户行为锚)。
   *
   * 实时帧走 `broadcastWithoutPersist`:编号、进重放缓冲、发给这一轮的所有订阅者,不再落一次库。
   * 共享会话里的别人、同一个人的第二个标签页靠它看到提问;发起人那边按 `clientMessageId`
   * 把本地乐观回显换成这一行。发在 spawn 之前,所以先于这一轮的任何助手帧。
   */
  // `persistDisplayLog` 为 false(seed 失败)时这一行不能落库:它正是会把空日志变成"有一行"的那一笔,
  // 历史就此从界面消失。实时帧照发,在线的人仍看得到提问。
  /**
   * 判据是"这一条有没有内容",不是"正文非空"。
   *
   * 只发图片(不打字)是合法的一条消息,前端提交路径也允许;只看 `command.trim()` 的话,
   * 那条消息不进显示日志,刷新后历史里只有助手的回答,没有"用户问了什么",回合配对也少一条。
   */
  const hasUserContent = Boolean(command.trim())
    || (Array.isArray(sanitizedImages) && sanitizedImages.length > 0);
  /**
   * 这一轮用户消息的 uuid 由这里定,同时写进显示日志那一行(`turnUuid`)并交给运行时推进 CLI。
   * 非 git 目录的「撤销这一轮的文件改动」就是拿它调 `rewindFiles`:CLI 的文件检查点按这个 uuid 认轮次。
   */
  const turnUuid = crypto.randomUUID();
  if (hasUserContent) {
    const userRow = {
      id: generateMessageId('user'),
      sessionId,
      timestamp: new Date().toISOString(),
      provider,
      kind: 'text',
      role: 'user',
      content: command,
      turnUuid,
      ...(Array.isArray(sanitizedImages) && sanitizedImages.length > 0 ? { images: sanitizedImages } : {}),
      // 同上:发起人与来源,调查卡的两道闸靠它。
      senderUserId: authUserId ?? undefined,
      origin: 'web',
      ...(clientMessageId ? { clientMessageId } : {}),
    } as NormalizedMessage;
    if (persistDisplayLog) {
      sessionMessagesDb.append(sessionId, userRow);
    }
    chatRunRegistry.broadcastWithoutPersist(sessionId, userRow);
    // provider 推进输入之前都算没发出:这段时间里被拒或被停止,这一行标成撤回(见 withdrawUnstartedUserTurn)
    unstartedUserTurns.set(run, { row: userRow, persisted: persistDisplayLog });
  }

  // The provider runtimes receive the provider-native session id (that is the
  // id their CLI/SDK understands for resume). Brand-new sessions have no
  // provider id yet, so the runtime starts fresh and announces one, which the
  // gateway writer captures and maps back to the app session id.
  /**
   * 发起这一轮的人是谁 —— 服务端的 bypass 白名单(`PRISM_ALLOW_BYPASS_USERS`)要用它。
   *
   * 权限档位在聊天框下拉里人人可选,而客户端的权限清单存在 localStorage 里
   * (用户自己的偏好,随时能清空)。也就是说不带上这个,服务端对"谁能用
   * bypassPermissions"一句话都说不上。
   *
   * 只在配了白名单时才真的用得上,但这里无条件带 —— 一次主键查询,
   * 而按条件查会让"配置一开就多一条查询路径"变成另一个要维护的分支。
   */
  // 与上面那道可见性门共用同一次查询(见 authViewer)。
  const actorUsername = authUsername;

  const runtimeOptions: AnyRecord = {
    ...pickClientRuntimeOptions(clientOptions),
    actorUsername,
    // 网关 key、「可用人员」、私有模型都按发这条消息的人判(见 claude-sdk 的 turnViewer)
    actorUserId: authUserId,
    // Image attachments are re-validated server-side: only files inside the
    // global upload store may reach the provider runtimes' file reads.
    images: sanitizedImages,
    sessionId: session.provider_session_id ?? undefined,
    // Gateway run identifier: the Claude runtime registers its abort handle
    // under this id so `chat.abort` works even before the provider-native
    // session id is captured (the whole first turn of a new conversation).
    runId: sessionId,
    resume: Boolean(session.provider_session_id),
    /**
     * cwd 只从会话行取。
     *
     * 这里原本是 `clientOptions.cwd ?? session.project_path` —— 客户端给了就赢,
     * 而这个函数的注释(见上)白纸黑字写着 project path 绝不来自客户端,紧邻的下一行
     * `projectPath` 也确实是数据库优先。两行方向相反,是笔误。
     *
     * 后果不是理论上的:用户在自己的会话里(所以会话可见性检查通过)带一个
     * 别人的项目路径发消息,Claude 就带着完整读写工具在别人的项目里跑起来 ——
     * 整套项目可见性模型被绕开。
     */
    cwd: session.project_path ?? undefined,
    projectPath: session.project_path ?? clientOptions.projectPath,
    /**
     * 这一轮图片允许来自哪些目录:由这道门算一次,运行时照用。
     *
     * 运行时若自己再判一遍(全局图库 + cwd),判据与这里不同:台账兜底放行的图(落在别的项目
     * attachments/ 下的历史文件)在这里过了,到那边又被拒,日志只说"outside allowed roots"。
     * 把结论传过去,两道门说同一句话。
     */
    imageRoots: Array.from(new Set([
      ...sessionAttachmentRoots,
      ...sanitizedImages
        .map((image) => (typeof image.path === 'string' ? path.dirname(image.path) : ''))
        .filter((dir): dir is string => Boolean(dir)),
    ])),
    // Fork descriptor for edit-and-rerun (branch off a parent session).
    // Only honored when this session has no native id yet (fresh branch).
    // 父会话要过归属校验(见 resolveAuthorizedFork)。
    forkFrom: !session.provider_session_id
      ? resolveAuthorizedFork(clientOptions.forkFrom, authViewer, ws)
      : undefined,
    // 与显示日志那一行的 turnUuid 是同一个(见上)
    userMessageUuid: turnUuid,
    /** provider 把这一条推进输入了:之后再按停止就是打断这一轮,这一行不再标撤回。 */
    onTurnStarted: () => {
      unstartedUserTurns.delete(run);
    },
    /**
     * 这一条没开跑就被拒了(上一轮迟迟不收尾、CLI 自己那一轮等满上限还在跑):模型没收到它。
     *
     * 不标的话刷新后历史里是一条模型从没收到过的提问。provider 在发 error / complete 之前调它,
     * 这时这一轮还登记着,撤回帧照样编号、进重放缓冲。
     */
    onTurnNotStarted: () => {
      withdrawUnstartedUserTurn(run);
    },
  };

  try {
    await spawnFn(hiddenContext ? `${command}\n\n${hiddenContext}` : command, runtimeOptions, run.writer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`[Chat] Provider runtime "${provider}" failed`, { sessionId, error: message });
  } finally {
    // 这一轮结束了,开没开跑都不再需要这份登记
    unstartedUserTurns.delete(run);
    // Safety net: a runtime that crashed (or resolved) without emitting its
    // terminal `complete` would otherwise leave the session stuck in
    // "processing" forever on every connected client. Scoped to THIS run —
    // a queued message can start the session's next run before this promise
    // settles, and the session-keyed completeRun would kill that new run.
    chatRunRegistry.completeRunIfCurrent(run, { exitCode: 1 });
    // 这一轮结束了,把排队那条接上去。放在 setImmediate 里是为了先让当前
    // 调用栈退干净 —— 续发会再走一遍 handleChatSend,直接递归 await 会把两轮
    // 叠在同一个栈上,出错时的堆栈也读不出是哪一轮。
    scheduleDrainPendingSend(sessionId, dependencies);
  }
}

/**
 * 把排队那条消息接到刚结束的回合后面。
 *
 * 先 delete 再发:这是"认领"动作 —— 中途再有人调 drain(例如 subscribe 那条
 * 兜底)也不会把同一条发两次。
 */
function scheduleDrainPendingSend(sessionId: string, dependencies: ChatWebSocketDependencies): void {
  setImmediate(() => {
    const pending = pendingSends.get(sessionId);
    if (!pending) return;
    if (chatRunRegistry.isProcessing(sessionId)) return; // 新回合已经开跑,让它先跑完

    if (Date.now() - pending.enqueuedAt > PENDING_SEND_TTL_MS) {
      // 半小时前那句话的语境早就不在了,发出去只会让人困惑。
      dropPendingSend(sessionId, 'expired');
      return;
    }

    pendingSends.delete(sessionId);
    // 入队的那个 socket 可能已经关了(关掉标签页后排队仍在服务端活着,这正是服务端排队
    // 的用处)。帧流本来就靠 attachSessionViewers 接给所有在看的人,但 handleChatSend 的
    // "回话对象"(协议错误、QUEUE_FULL 之类)发给死 socket 就进了黑洞 —— 换成一个还活着的
    // viewer;一个都没有就仍用原 socket(反正没人看)。
    const liveWs = pending.ws.readyState === WS_OPEN_STATE
      ? pending.ws
      : [...(sessionViewers.get(sessionId) ?? [])].find((viewer) => viewer.readyState === WS_OPEN_STATE)
        ?? pending.ws;
    let accepted = false;
    const drainToken = {
      cancelled: false,
      clientMessageId: clientMessageIdOf(pending.data),
      onAccepted: () => {
        accepted = true;
        /*
         * 收下了(开跑、合流或重新排上),派发窗口到此结束,令牌当场撤掉。留到整轮跑完的话,
         * 这段时间里点「撤销排队」会落进 handleCancelQueued 的派发分支,回一帧带着这条 clientMessageId 的
         * chat_queue_cancelled,说它没发出去,而模型正在回答它。
         */
        if (drainingSends.get(sessionId) === drainToken) drainingSends.delete(sessionId);
        broadcastToSessionViewers(sessionId, {
          kind: 'chat_queue_flushed',
          sessionId,
          timestamp: new Date().toISOString(),
        });
      },
    };
    drainingSends.set(sessionId, drainToken);
    /**
     * `chat_queue_flushed` 在续发真的成立之后(`onAccepted`)才广播。
     *
     * 先无条件广播的话,前端据此清掉排队指示器,而 `handleChatSend` 里任何一条早退分支
     * (会话不可见、终端接管、provider 不支持等)只给一个 socket 回协议错误,既不广播、也不退回正文:
     * 用户看到的是排队卡消失、消息没发出去、打的那段话凭空没了。
     */
    void handleChatSend(liveWs, pending.userId, pending.data, dependencies, drainToken)
      .catch((error) => {
        log.error('[Chat] 排队消息续发失败:', error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (drainingSends.get(sessionId) === drainToken) drainingSends.delete(sessionId);
        /**
         * 续发没能成立时,要有人告诉界面一声。
         *
         * 上面的 `pendingSends.delete` 是认领,条目从此不在表里。`handleChatSend` 在真正开跑之前
         * 有好几条早退(会话没了、可见性变了、终端接管了、provider 不支持、seed 之后重判等),
         * 它们只给一个 socket 回一条协议错误,既不广播,也走不到 `dropPendingSend`(条目已不在表里,
         * delete 返回 false)。不在这里兜住的话,排队卡永远不消失、消息没发、正文也没退回输入框。
         *
         * 判据放在这里而不是逐条早退上打补丁:"跑完一圈都没人说收下了"这一句,
         * 把将来新增的早退也一并覆盖。
         */
        if (!accepted && !drainToken.cancelled) {
          // 条目已经被认领走了,先放回去,好让 dropPendingSend 走它那套广播与退正文。
          pendingSends.set(sessionId, pending);
          dropPendingSend(sessionId, 'undeliverable');
        }
      });
  });
}

/**
 * 这个 socket 能不能操作这条会话。
 *
 * 每条按 sessionId 寻址的消息都要过这道门(`chat.send` 按发送方身份另判,见那边的说明)。
 *
 * `chat.subscribe` 需要它是因为订阅会把 socket 加进 run 的输出集合:一条对话的
 * 实时流以及其中的工具审批请求,都会广播给集合里的每一个人。
 *
 * 拒绝时回 SESSION_NOT_FOUND 而不是"无权限":对外与"这个 id 不存在"同形。
 */
function assertSocketMaySeeSession(ws: WebSocket, sessionId: string): boolean {
  if (canViewerSeeSession(sessionId, readSocketViewer(ws))) {
    return true;
  }

  sendProtocolError(ws, 'SESSION_NOT_FOUND', `Session "${sessionId}" was not found.`, sessionId);
  return false;
}

/**
 * Handles `chat.abort`: cancels the run for one app session and emits the
 * terminal `complete` on its behalf (runtimes skip their own complete for
 * aborted runs, and the registry drops any duplicate).
 */
async function handleChatAbort(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.abort requires a sessionId.');
    return;
  }

  if (!assertSocketMaySeeSession(ws, sessionId)) {
    return;
  }

  const run = chatRunRegistry.getRun(sessionId);
  if (!run || run.status !== 'running') {
    // complete → setImmediate(drain) 的空窗里按停止:没有活跃回合,但排队那条还躺着,
    // 撤掉它正是这次中止的全部意义,不撤的话排队那条随后照发。
    // 撤到了就不报 NO_ACTIVE_RUN:用户按停止得到了他想要的结果。
    if (dropPendingSend(sessionId, 'aborted')) {
      return;
    }
    // 排队那条刚被认领、正走在 handleChatSend 的 await 里(回合还没登记):
    // 把令牌置为取消,它到 startRun 之前会自己作废。同样算"停住了"。
    const draining = drainingSends.get(sessionId);
    if (draining && !draining.cancelled) {
      draining.cancelled = true;
      return;
    }
    sendProtocolError(ws, 'NO_ACTIVE_RUN', `Session "${sessionId}" has no active run.`, sessionId);
    return;
  }

  /**
   * 中止的意图在按下的那一刻就已确定:排队那条现在就撤,不等 I/O。
   *
   * 不能排在 `await abortFn` 之后:`abortFn` 内部的 `interruptWithTimeout` 最长要等 5 秒,
   * 这期间回合的 promise 先 settle → `handleChatSend` 的 finally 触发 `scheduleDrainPendingSend`
   * → 排队那条被认领并 `startRun` 成新的一轮,停止就晚了一步,排队那条照样发给模型。
   */
  dropPendingSend(sessionId, 'aborted');
  const draining = drainingSends.get(sessionId);
  if (draining) draining.cancelled = true;

  const abortFn = dependencies.abortFns[run.provider];
  /**
   * 发起中止,随即把还没开跑的那一条标成撤回(见 withdrawUnstartedUserTurn)。
   *
   * provider 在中止的第一个 await 之前就记下停止标记,从那一刻起这一条不会再开跑,所以发起之后马上标,
   * 不等中止落定:等的那几秒里,这一条那边看到停止标记、自己收尾,这一轮可能先被关掉,撤回帧就推不出去了。
   */
  const requestAbort = async (
    fn: NonNullable<typeof abortFn>,
    providerSessionId: string,
  ): Promise<boolean> => {
    const attempt = Promise.resolve(fn(providerSessionId, { runId: sessionId }));
    withdrawUnstartedUserTurn(run);
    return Boolean(await attempt);
  };
  let success = false;
  if (abortFn && run.providerSessionId) {
    success = await requestAbort(abortFn, run.providerSessionId);
  }

  // First turn of a new conversation: the provider-native id only arrives
  // mid-stream, so the route above is a no-op until then. Claude registers
  // every run under the app session id (chat.send passes it as runId), and
  // its abort function falls back to that registry when the provider-session
  // route cannot find the run — the turn is aborted (or flagged before it
  // starts) instead of silently running on.
  if (!success && abortFn && run.provider === 'claude') {
    success = await requestAbort(abortFn, '');
  }

  /**
   * 按 run 身份收尾,不按会话 id。
   *
   * `completeRun(sessionId, …)` 会重新按 sessionId 查表,而上面两处 await 期间下一轮完全
   * 可能已经起来了,那样会把新那一轮标成 completed:前端停止转圈、停止按钮消失,而它还在
   * 继续吐帧;`isProcessing` 变 false 之后用户再发一条,`startRun` 直接放行,同一会话出现
   * 两个并发回合,双写同一份 transcript。`completeRunIfCurrent` 就是为此准备的;
   * `run` 是上面 `getRun` 拿到的那个引用。
   */
  chatRunRegistry.completeRunIfCurrent(run, {
    exitCode: success ? 0 : 1,
    aborted: true,
  });
}

/** 单帧批量订阅的上限,见 handleChatSubscribe 里的说明。 */
const MAX_SUBSCRIBE_TARGETS = 200;

/**
 * Handles `chat.subscribe`: for each requested session, reports whether a run
 * is processing, re-attaches the live stream to this socket, replays missed
 * events (seq > lastSeq), and includes pending permission requests.
 *
 * This single message replaces the old `check-session-status`,
 * `get-pending-permissions`, and Claude-only writer reconnect flows.
 */
function handleChatSubscribe(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): void {
  /**
   * 批量订阅要封顶。
   *
   * 循环体每一项都要跑 `canViewerSeeSession`(三次同步 SQLite 查询)+
   * `getPendingApprovalsForSession`(全量扫)+ 一次 `sendJson`,而整个 handler 是同步的,
   * 一次调用在单个事件循环 tick 里跑完。入站单帧上限 4 MiB,`{"sessionId":"x"}` 只要几十字节,
   * 一帧能塞进十万量级;WS 消息层也没有限流(限流只在 HTTP 侧)。不封顶的话,任何通过认证的账号
   * (不需要项目权限:不可见的会话在循环体里才跳过,查询已经花掉了)发一帧就能把事件循环
   * 阻塞数秒,所有人的聊天、心跳、HTTP 全部停摆。
   *
   * 前端最大批量是侧栏同步的十几条,200 有充足余量。
   */
  const requested = Array.isArray(data.sessions) ? data.sessions : [];
  const targets = requested.slice(0, MAX_SUBSCRIBE_TARGETS);
  if (requested.length > MAX_SUBSCRIBE_TARGETS) {
    sendProtocolError(
      ws,
      'TOO_MANY_SESSIONS',
      `一次最多订阅 ${MAX_SUBSCRIBE_TARGETS} 条会话(收到 ${requested.length} 条),多出的已忽略。`,
    );
  }
  /**
   * 只有单条订阅才预热。
   *
   * 批量订阅是侧栏在同步"哪些会话在跑",一次能带十几条 —— 给它们逐个预热会把
   * 常驻池(默认 20 个名额)瞬间填满speculative 进程,再配上按人公平淘汰,
   * 结果是互相踢来踢去。单条订阅才是"用户打开了这段对话"这个信号。
   */
  const isSingleTarget = targets.length === 1;

  for (const target of targets) {
    if (!target || typeof target !== 'object') {
      continue;
    }

    const sessionId = typeof (target as AnyRecord).sessionId === 'string'
      ? ((target as AnyRecord).sessionId as string).trim()
      : '';
    if (!sessionId) {
      continue;
    }

    const lastRunIdRaw = (target as AnyRecord).lastRunId;
    const lastRunId = typeof lastRunIdRaw === 'string' && lastRunIdRaw ? lastRunIdRaw : null;
    const lastSeqRaw = (target as AnyRecord).lastSeq;
    const lastSeq = typeof lastSeqRaw === 'number' && Number.isFinite(lastSeqRaw)
      ? Math.max(0, Math.floor(lastSeqRaw))
      : 0;

    if (!canViewerSeeSession(sessionId, readSocketViewer(ws))) {
      // 静默跳过而不是报错:subscribe 是批量的,一条不可见不该让整批失败,
      // 而逐条回错误又会把"哪些 id 是存在的"告诉调用方。
      continue;
    }

    const run = chatRunRegistry.getRun(sessionId);
    const isProcessing = chatRunRegistry.isProcessing(sessionId);
    const pending = pendingSends.get(sessionId);

    // 排队续发的兜底:回合可能不是从 handleChatSend 的 finally 里结束的(看门狗、
    // 运行时崩溃)。那条路上没人来接排队消息,它会一直躺着。订阅是页面回到
    // 这条会话的时刻,顺手检查一次最便宜。
    if (!isProcessing && pending) {
      scheduleDrainPendingSend(sessionId, dependencies);
    }

    // 打开一段对话时把它的运行时预热起来(见下面的 maybePrewarm)。
    if (!isProcessing && isSingleTarget) {
      maybePrewarm(sessionId, dependencies, ws);
    }

    // 订阅即登记,不只在"这一刻正好在跑"时才接。
    //
    // 只在 `isProcessing` 为真时 attachConnection 的话,空闲时订阅过这条会话的其他标签页
    // 在下一轮开跑时不在推流集合里:整轮一帧收不到,连 complete 都没有(也就不触发兜底刷新),
    // 界面停在旧状态。排队续发起的新 run 也靠这份登记接上其他查看者。
    rememberSessionViewer(sessionId, ws);
    if (isProcessing) {
      chatRunRegistry.attachConnection(sessionId, ws);
    }

    // 待批审批用 app 会话 id 查,不用 `run?.providerSessionId`。
    //
    // 新会话的第一轮里 `providerSessionId` 必然是 null(startRun 从库里读的就是 null,要等运行时
    // announce 才补上),按它查只会得到 `[]`;而前端收到 `chat_subscribed` 是整体替换,空数组会把
    // 已经弹出来的审批框抹掉,随后 55 秒超时。claude-sdk 侧的待批请求同时按 provider 原生 id
    // 和 app 会话 id(`_appSessionId`)索引,app 会话 id 从第一轮就存在,所以这里可以无条件查,
    // 空数组也就真的意味着"没有待批的"。
    const pendingPermissions = dependencies
      .getPendingApprovalsForSession(sessionId)
      .map((approval) =>
        approval && typeof approval === 'object'
          ? { ...(approval as AnyRecord), sessionId }
          : approval,
      );

    sendJson(ws, {
      kind: 'chat_subscribed',
      sessionId,
      isProcessing,
      lastSeq: run?.lastSeq ?? 0,
      // 客户端据此判断自己手里的游标属于哪一轮;轮次一换,游标必须跟着重置。
      runId: chatRunRegistry.currentRunId(sessionId),
      /**
       * 重放缓冲还剩的最早 seq:客户端据此判断"我这段是不是已经被裁掉了"。
       * 见 `earliestBufferedSeq`:没有它,首帧缺口在跳号检测里是看不见的。
       */
      earliestBufferedSeq: chatRunRegistry.earliestBufferedSeq(sessionId),
      pendingPermissions,
      // 排队中的那条也要报出来 —— 刷新页面或换设备后,"有一条在等"这件事
      // 不能只活在发起它的那个标签页里。
      /**
       * 排队消息的正文预览只给排它的人。共享会话里其他查看者只需要知道
       * "有一条在等"(用于排队卡与 QUEUE_FULL 的提示),不该看到别人还没发出去的话。
       */
      queued: pending
        ? {
          preview: isPendingOwner(pending, readSocketViewer(ws)) ? pending.preview : '',
          redacted: !isPendingOwner(pending, readSocketViewer(ws)),
          enqueuedAt: new Date(pending.enqueuedAt).toISOString(),
        }
        : null,
      timestamp: new Date().toISOString(),
    });

    // Replay only for RUNNING runs, strictly after the ack. Completed runs
    // are fully persisted to the provider transcript and served over REST —
    // replaying them (e.g. after a page reload where the client's lastSeq is
    // 0) would duplicate messages the history fetch already returned.
    if (isProcessing) {
      for (const event of chatRunRegistry.replayEvents(sessionId, lastSeq, lastRunId)) {
        sendJson(ws, event);
      }
    }
    // 后台任务条也补一份(刷新 / 换设备后,"还有 2 个后台任务在跑"不能只活在原来那个标签页)。
    // 空表也发:断线 / 重启期间任务跑完了,前端那份还挂着,得靠这一帧清掉。
    const backgroundTasks = latestBackgroundTasks.get(sessionId) ?? [];
    sendJson(ws, backgroundTasksFrame(sessionId, backgroundTasks));
  }
}

/** 预热去抖:同一条会话 60 秒内只预热一次。 */
const PREWARM_DEBOUNCE_MS = 60_000;
/**
 * 预热记录表有上界。
 *
 * 每次单条 `chat.subscribe` 写一条,会话归档、删除都不会清;不设上界的话,常驻实例会随会话数一直涨。
 * 条目只用来判"60 秒内预热过没有",过期即无意义,所以插入时顺手扫掉过期的,并压一道硬上限兜底。
 */
const PREWARM_MAP_CAP = 2000;
const lastPrewarmAt = new Map<string, number>();

function rememberPrewarm(sessionId: string, now: number): void {
  if (lastPrewarmAt.size >= PREWARM_MAP_CAP) {
    for (const [key, at] of lastPrewarmAt) {
      if (now - at > PREWARM_DEBOUNCE_MS) lastPrewarmAt.delete(key);
    }
    // 还是满的(全是新条目)—— 丢掉最早插入的那一批,Map 的迭代序就是插入序。
    if (lastPrewarmAt.size >= PREWARM_MAP_CAP) {
      let toDrop = Math.ceil(PREWARM_MAP_CAP / 4);
      for (const key of lastPrewarmAt.keys()) {
        lastPrewarmAt.delete(key);
        if (--toDrop <= 0) break;
      }
    }
  }
  lastPrewarmAt.set(sessionId, now);
}

/**
 * 打开一段对话时把常驻运行时先拉起来。
 *
 * 只对已有原生会话 id 的对话预热 —— 新会话的第一条消息本来就要新建进程,
 * 提前建一个没有 resume 目标的空进程只是白占名额。
 *
 * 全程 best-effort:任何失败都吞掉,预热是优化不是功能。
 *
 * `ws` 是打开这段对话的那个 socket,预热按它的身份解析网关与 key(调用方已判过它看得见这条会话)。
 */
function maybePrewarm(sessionId: string, dependencies: ChatWebSocketDependencies, ws: WebSocket): void {
  const prewarm = dependencies.prewarmSession;
  if (!prewarm) return;

  const now = Date.now();
  const last = lastPrewarmAt.get(sessionId) ?? 0;
  if (now - last < PREWARM_DEBOUNCE_MS) return;
  rememberPrewarm(sessionId, now);

  // 终端正接管着这段对话时不能预热 —— 预热会再建一个进程 resume 同一段对话,
  // 和 PTY 同时写同一份 transcript,正是所有权登记要消掉的双写(症状:聊了半天,
  // 另一边少一截)。REST 那条同功能接口(server/index.js)有同一道闸门。
  if (currentHolder(sessionId)) return;

  let session;
  try {
    session = sessionsDb.getSessionById(sessionId);
  } catch {
    return;
  }
  if (!session?.provider_session_id) return;

  /**
   * 按打开这段对话的人预热。
   *
   * runtime 签名里有网关指纹(网关与 key 按人解析:个人 key > 网关默认 key > settings.json)。
   * 不带身份就按"无人"解析,对有个人 key 或模型落在别的网关上的人,第一条真实消息必然签名不符、
   * dispose 再 resume 一次,预热白做,还白占一个名额。`runId` 让预热按 app 会话 id 查这条会话选过的模型,
   * 与真实发送同一个查法。
   *
   * 「跳过权限」档位与工具权限清单仍然传不过来(预热时不知道这个人这次会怎么选),它们也在签名里,
   * 与默认不同时第一条消息照样会重建。
   */
  const viewer = readSocketViewer(ws);
  const viewerUserId = viewer.userId === null || viewer.userId === undefined ? NaN : Number(viewer.userId);
  const actorUserId = Number.isFinite(viewerUserId) ? viewerUserId : null;
  void Promise.resolve(
    prewarm({
      sessionId: session.provider_session_id,
      cwd: session.project_path ?? undefined,
      runId: sessionId,
      actorUserId,
      actorUsername: viewer.username,
      ownerUserId: actorUserId,
    }),
  ).catch(() => {
    // 预热失败只意味着下一条消息走冷启动,不该有任何用户可见的后果。
  });
}

/**
 * 撤销排队中的那条消息。
 *
 * 能看到这条会话的人都能撤 —— 与"谁都能中止这条会话的回合"同一口径。"有一条在排队"
 * 本来就对所有查看者可见(subscribe 里报了,只是正文对非发起人脱敏),对它的操作也没理由更严。
 */
async function handleCancelQueued(ws: WebSocket, data: AnyRecord, dependencies: ChatWebSocketDependencies): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.cancel-queued requires a sessionId.');
    return;
  }
  if (!assertSocketMaySeeSession(ws, sessionId)) {
    return;
  }
  /**
   * 撤回合流进 CLI 队列的那一条(带 `mergedUuid`)。
   * 还在 CLI 队列里就撤掉,结果由 handleMergedMessageEvent 广播;已经被模型读到就撤不回,照实回一句。
   */
  const mergedUuid = typeof data.mergedUuid === 'string' ? data.mergedUuid.trim() : '';
  if (mergedUuid) {
    const row = mergedRows.get(mergedUuid);
    if (row && row.sessionId !== sessionId) {
      // 别的会话的 uuid —— 不碰
      sendProtocolError(ws, 'MERGED_NOT_CANCELLABLE', '这条消息已经送到模型面前了,撤不回了。', sessionId, 'chat.cancel-queued', { mergedUuid });
      return;
    }
    const cancelFn = dependencies.cancelMergedFns?.claude;
    const result = cancelFn ? await cancelFn(sessionId, mergedUuid) : { cancelled: false, reason: 'unsupported' };
    if (!result.cancelled && result.reason !== 'unsupported' && result.reason !== 'error') {
      // 撤不回 = 已经被模型读到了:按"已送达"收起所有在线端的「撤回」
      handleMergedMessageEvent({ type: 'delivered', appSessionId: sessionId, uuids: [mergedUuid] });
    }
    if (!result.cancelled) {
      sendProtocolError(
        ws,
        'MERGED_NOT_CANCELLABLE',
        result.reason === 'unsupported'
          ? '当前 CLI 不支持撤回已送进队列的消息。'
          : result.reason === 'error'
            ? '撤回没有及时得到回应 —— 稍后再点一次。'
            : '这条消息已经送到模型面前了,撤不回了。',
        sessionId,
        'chat.cancel-queued',
        // 'error'(比如撤回超时)时它可能还排着 —— 不带 uuid,前端别把「撤回」收起来
        result.reason === 'error' ? undefined : { mergedUuid },
      );
    }
    return;
  }
  if (dropPendingSend(sessionId, 'cancelled')) return;

  /**
   * 派发窗口里的那条也要能撤。
   *
   * `scheduleDrainPendingSend` 先从 `pendingSends` 删掉(认领),再设 `drainingSends` 的取消令牌,
   * 然后走 `handleChatSend`,后者在 `startRun` 之前还要 await 一次 seed(老会话要读 transcript,
   * 能到秒级)。只看 `pendingSends` 的话,回合刚结束、排队卡还显示着的那一两百毫秒里点删除,
   * 用户会看到「没有排队消息」的报错,而那条他刚明确删掉的消息照样发给模型。
   */
  const draining = drainingSends.get(sessionId);
  if (draining && !draining.cancelled) {
    draining.cancelled = true;
    broadcastToSessionViewers(sessionId, {
      kind: 'chat_queue_cancelled',
      sessionId,
      reason: 'cancelled',
      ...(draining.clientMessageId ? { clientMessageId: draining.clientMessageId } : {}),
      timestamp: new Date().toISOString(),
    });
    return;
  }

  sendProtocolError(ws, 'NO_QUEUED_MESSAGE', `Session "${sessionId}" has no queued message.`, sessionId);
}

/**
 * Handles `chat.permission-response`: forwards a tool-approval decision to the
 * pending approval resolver (Claude is the only provider with interactive
 * approvals today, but the message is intentionally provider-neutral).
 */
function handlePermissionResponse(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): void {
  if (typeof data.requestId !== 'string' || data.requestId.length === 0) {
    return;
  }

  // 这个决定属于谁。requestId 登记在 provider 会话下,先换回 app 会话再判定。
  // 没有这一步,任何已登录的 socket 都能替别人的会话点"允许",而工具批准正是
  // 决定要不要真的动文件、真的执行命令的那一步。
  const providerSessionId = dependencies.getToolApprovalSessionId(data.requestId);
  if (!providerSessionId) {
    // 已超时或已被回答:静默丢弃,与原行为一致。
    return;
  }

  const owningSession = sessionsDb.getSessionByProviderSessionId(providerSessionId);
  const appSessionId = owningSession?.session_id ?? providerSessionId;
  if (!canViewerSeeSession(appSessionId, readSocketViewer(ws))) {
    sendProtocolError(ws, 'SESSION_NOT_FOUND', 'No such pending approval.', appSessionId);
    return;
  }

  dependencies.resolveToolApproval(data.requestId, {
    allow: Boolean(data.allow),
    updatedInput: data.updatedInput,
    message: typeof data.message === 'string' ? data.message : undefined,
    rememberEntry: data.rememberEntry,
  });
}

/**
 * 最近一次注册的依赖。给 `drainPendingSendForSession` 用:外部 API 触发的回合结束时
 * 也要续发排队消息,而那条路径(routes/agent.js)拿不到这里的 dependencies。
 * 整个进程只有一套 provider 依赖,存一份即可。
 */
let lastChatDependencies: ChatWebSocketDependencies | null = null;

/**
 * 一轮结束后把排队那条接上去,供非 WS 路径调用。
 *
 * 排队按会话存在服务端,而定时任务 / 外部 API(routes/agent.js)也能在同一条会话上跑回合。
 * 只靠 WS 的 `handleChatSend` 在 finally 里续发的话,这类回合结束后没人来接,
 * 排队那条会一直躺到 30 分钟 TTL 过期被丢掉,用户永远等不到回复。
 */
export function drainPendingSendForSession(sessionId: string): void {
  if (!sessionId || !lastChatDependencies) return;
  scheduleDrainPendingSend(sessionId, lastChatDependencies);
}

/**
 * Handles authenticated chat websocket messages used by the main chat panel.
 *
 * Inbound protocol (client to server):
 * - `chat.send`                { sessionId, content, clientMessageId?, options? }
 * - `chat.abort`               { sessionId }
 * - `chat.subscribe`           { sessions: [{ sessionId, lastSeq?, lastRunId? }] }
 * - `chat.cancel-queued`       { sessionId, mergedUuid? }
 * - `chat.permission-response` { requestId, allow, updatedInput?, message?, rememberEntry? }
 *
 * Outbound protocol (server to client): every frame is `kind`-based — either
 * a provider `NormalizedMessage` (with `seq`) or a gateway event
 * (`chat_subscribed`, `session_upserted`, `loading_progress`,
 * `chat_queued`, `chat_queue_cancelled`, `chat_queue_flushed`, `protocol_error`).
 */
export function handleChatConnection(
  ws: WebSocket,
  request: AuthenticatedWebSocketRequest,
  dependencies: ChatWebSocketDependencies
): void {
  log.debug('对话 WebSocket 已连接');
  lastChatDependencies = dependencies;
  connectedClients.add(ws);

  const userId = readRequestUserId(request);
  // Broadcasts fan out over `connectedClients`, which holds bare sockets.
  // Stamping the identity here is what lets them be filtered by project
  // ownership instead of going to every browser on the server.
  (ws as typeof ws & { prismUserId?: string | number | null; prismUsername?: string | null }).prismUserId = userId;
  (ws as typeof ws & { prismUsername?: string | null }).prismUsername =
    typeof request?.user?.username === 'string' ? request.user.username : null;
  /**
   * 把握手那一刻的 `token_version` 也盖上。
   *
   * 心跳复检若只问"这个用户还在不在",「退出所有设备」/ 改密码(旋转 token_version,
   * 用户行照样在)之后,已建立的聊天连接仍然有效、还能继续发指令。
   * 票据消费那条路已经比对 token_version(见 websocket-auth),这里补上"连接建立之后"的那一半。
   */
  (ws as typeof ws & { prismTokenVersion?: number | null }).prismTokenVersion =
    userId !== null && userId !== undefined
      ? Number(userDb.getUserById(Number(userId))?.token_version ?? 0)
      : null;

  ws.on('message', async (rawMessage) => {
    try {
      const parsed = parseIncomingJsonObject(rawMessage);
      if (!parsed) {
        throw new Error('Invalid websocket payload');
      }

      const data = parsed as AnyRecord;
      const messageType = typeof data.type === 'string' ? data.type : '';

      switch (messageType) {
        case 'ping':
          // Application-level heartbeat for clients that cannot observe the
          // WS-protocol ping/pong frames (browsers). Reply to the sender only
          // — no auth side effects, no broadcast, no session bookkeeping.
          sendJson(ws, { type: 'pong' });
          return;
        case 'chat.send':
          await handleChatSend(ws, userId, data, dependencies);
          return;
        case 'chat.abort':
          await handleChatAbort(ws, data, dependencies);
          return;
        case 'chat.subscribe':
          handleChatSubscribe(ws, data, dependencies);
          return;
        case 'chat.cancel-queued':
          await handleCancelQueued(ws, data, dependencies);
          return;
        case 'chat.permission-response':
          handlePermissionResponse(ws, data, dependencies);
          return;
        default:
          sendProtocolError(ws, 'UNKNOWN_MESSAGE_TYPE', `Unknown message type "${messageType}".`);
          return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Chat WebSocket error:', message);
      sendProtocolError(ws, 'INTERNAL_ERROR', message);
    }
  });

  ws.on('close', () => {
    log.debug('对话客户端已断开');
    connectedClients.delete(ws);
    // 从所有 run 的订阅者集合里摘掉。不摘也不会漏(forward 会清理已关闭的),
    // 但摘掉能让 `liveConnectionCount()` 立刻反映现实 —— 审批帧要不要认为
    // "送到了"读的就是它。
    chatRunRegistry.detachConnection(ws);
    forgetViewerEverywhere(ws);
  });
}
