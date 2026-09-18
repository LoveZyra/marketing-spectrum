import path from 'node:path';

import type { WebSocket } from 'ws';

import { attachmentsDb, canViewerSeeSession, sessionMessagesDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { chatRunRegistry, setRunStartedHook} from '@/modules/websocket/services/chat-run-registry.service.js';
import { noteMergedSend } from '@/modules/websocket/services/observed-run.service.js';
import { seedDisplayLogFromTranscript } from '@/modules/providers/index.js';
import { connectedClients, WS_OPEN_STATE } from '@/shared/websocket-state.js';
import { currentHolder } from '@/modules/websocket/services/conversation-ownership.service.js';
import { ATTACHMENT_DIR_NAME } from '@/shared/attachment-storage.js';
import { getGlobalImageAssetsDir, normalizeImageDescriptors } from '@/shared/image-attachments.js';
import { readSocketViewer } from '@/shared/project-visibility.js';
import type {
  AnyRecord,
  AuthenticatedWebSocketRequest,
  LLMProvider,
} from '@/shared/types.js';
import { generateMessageId, parseIncomingJsonObject } from '@/shared/utils.js';
import { createLogger } from '@/shared/logger.js';

import { forgetSend, registerSend } from './chat-send-dedupe.js';
const log = createLogger('ws-chat');

/**
 * Trust boundary for client-supplied image attachments: chat.send options come
 * straight from the browser, and the provider runtimes read the referenced
 * files off disk (Claude base64-encodes them into the prompt). Only images
 * that live directly inside the global upload store (`~/.prism/assets`,
 * where POST /api/assets/images puts them) are allowed through — anything
 * else (absolute paths elsewhere, traversal, subdirectories) is dropped.
 *
 * Exported for tests; `assetsRootOverride` exists only for them.
 */
/**
 * F08:无主附件(台账里查不到的老文件)要不要拒。
 *
 * 默认**放行** —— 直接拒会让老会话的编辑重跑 / 排队重放连自己的图都发不出去。
 * 打开这个开关的环境按"没有归属证明就不给用"办。
 */
function strictAttachmentOwner(): boolean {
  const raw = process.env.PRISM_STRICT_ATTACHMENT_OWNER;
  return raw === '1' || raw === 'true';
}

export function filterImagesToUploadStore(
  images: unknown,
  assetsRootOverride?: string,
  /**
   * ed:额外允许的根目录 —— 会话所属项目的 `attachments/`。
   *
   * cu 起,聊天图片按会话所属项目落到 `<项目>/attachments/`(配额、清理都按项目走),
   * 全局 `~/.prism/assets` 只在拿不到项目时兜底。而这道门一直只认全局目录,结果是
   * **每一张在项目会话里发的图都被丢掉**:runtime 收不到图(模型说"看不到图片"),
   * 用户行落库时也没有 images —— 回合一结束、历史一刷新,乐观气泡被服务端拷贝顶掉,
   * 图片就"过一会儿消失了"(用户实测)。项目目录是这个会话本来就有权读的,放行它的
   * 直接子文件与放行全局目录同一个安全水位;仍然只认**直接子文件**,不认子目录与穿越。
   */
  extraRoots: readonly string[] = [],
  /**
   * A7:**台账兜底** —— 路径不在任何允许的根下,但附件台账说它就是**这条会话**
   * 上传的,照样放行。
   *
   * 为什么需要它:上传落盘的目录由**前端传的 projectId**(侧栏选中的项目)决定,
   * 而这道门比的是 `sessions.project_path`。两者是两个不同来源的值,只要对不齐
   * ——root 看别人的会话时尤其容易——图片就在这里被静默丢掉:页面上显示得
   * 好好的(前端按侧栏 projectId 走 files/content 取原图),模型却一张都收不到。
   *
   * 台账是**服务端在落盘那一刻记的**(user_id / session_id / abs_path),
   * 不是客户端说的,所以拿它当判据比路径形状更硬。它同时也把**已经传坏的
   * 那些历史图**救回来了:目录改不了,但归属是有据可查的。
   */
  ledgerOwner?: (absPath: string) => { userId: number | null; sessionId: string | null } | undefined,
  sessionId?: string | null,
  /**
   * F08:**发起这一轮的人是谁。**
   *
   * 全局图库(`~/.prism/assets`)是**所有用户共用的一个目录**,而这道门此前只判
   * "在不在这个目录里" —— 知道别人的文件名(路径会出现在导出、日志、
   * 甚至别人分享的截图里)就能把**别人的图**塞进自己的对话发给模型。
   * 项目内的 `attachments/` 不在此列:那道门前面已经过了会话可见性。
   *
   * 传了 userId 才启用归属校验;不传(测试、外部调用)维持原行为。
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
   * fj:放行时**顺手把路径定成绝对路径**。
   *
   * 这道门用"assets 根 / 项目 attachments 根"来解析裸文件名,而运行时那边
   * (`resolveImageAbsolutePath`)对相对路径是**按 cwd 解析**的 —— 两个不同的根。
   * 于是一个裸文件名在这里判过了,到了运行时却指向另一个目录、文件不存在,
   * 模型又一次"看不到图片",而日志里什么都不会说。
   *
   * 判过之后就把它钉成绝对路径,后面没有第二次解析的机会。
   */
  const globalRoot = path.resolve(assetsRootOverride ?? getGlobalImageAssetsDir());

  return normalizeImageDescriptors(images).flatMap((descriptor) => {
    const matchedRoot = roots.find((root) => isDirectChildOf(root, descriptor.path));
    if (matchedRoot) {
      const resolved = path.resolve(matchedRoot, descriptor.path);

      /**
       * F08:**共用目录里的图要查归属。**
       *
       * 只对全局图库查 —— 它是所有用户共用的一个目录。项目内的 `attachments/`
       * 不查:走到这里说明会话可见性已经过了,那个项目本来就读得到。
       *
       * 台账里没有记录的("加固之前"落盘的老文件)默认放行并单独记一行日志:
       * 直接拒绝会让**老会话的编辑重跑 / 排队重放**连自己的图都发不出去。
       * 想收紧的环境把 `PRISM_STRICT_ATTACHMENT_OWNER=1` 打开,无主文件一律拒。
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
          // 台账明确说它是**别人的** —— 无论如何都不放行。
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
      // gh:与上面全局库那条分支同口径 —— 台账记着它属于这条会话**且**是发送者自己传的。
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
  /**
   * gc:**真合流** —— 会话忙着时,把用户这条话直接推进 provider 的命令队列,
   * 而不是攒在 Prism 自己的 `pendingSends` 里等这一轮跑完。
   *
   * 可选注入:没接线、或者这一次不成立(没有常驻 runtime、正在自动压缩、
   * 带了图片……)时**照旧走排队** —— 合流是增强,不是替换,退回去就是今天的行为。
   */
  mergeFns?: Partial<Record<
    LLMProvider,
    (
      appSessionId: string,
      options: {
        command: string;
        providerSessionId?: string | null;
        /** gh:发送者身份与它这次的运行时选项 —— provider 侧据此核对"同一个人、同一个档位"。 */
        actorUsername?: string | null;
        ownerUserId?: number | null;
        runtimeOptions?: AnyRecord;
      },
    ) => Promise<{ merged: boolean; reason?: string; uuid?: string }>
  >>;
  /**
   * F14:把一段对话的常驻运行时先拉起来(可选注入)。
   *
   * 打开一段旧对话到发出第一条消息之间,通常有几秒到十几秒的空档 —— 用户在读
   * 上文、在打字。冷启动那几秒本可以塞进这个空档,而不是让他按下回车之后再等。
   * 失败一律吞掉:预热是优化,不是功能,失败最多回到原来的速度。
   */
  prewarmSession?: (options: { sessionId: string; cwd?: string }) => Promise<unknown>;
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
   * 接受 **app 会话 id 或 provider 原生 id**,两者都能命中。用 app id 调是关键 ——
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
 * Reports a protocol-level failure to the requesting client.
 *
 * Protocol errors deliberately use their own `kind` (instead of the provider
 * `error` message kind) so the frontend can distinguish "your request was
 * invalid" from "the model run produced an error" without inspecting text.
 */
/**
 * F09:收下这一条的回执。
 *
 * `accepted` = 这一轮已经登记 / 已经收进排队;`duplicate` = 同一个幂等键
 * 之前收过,这次什么都没做。两者对前端是同一个意思:**服务端有了,别再发**。
 * 分开写只是为了排查时能看出来是哪一种。
 *
 * 没有 `clientMessageId` 的请求不回 ACK —— 老客户端本来也不认它。
 */
function sendSendAck(
  ws: WebSocket,
  sessionId: string,
  clientMessageId: string | null,
  status: 'accepted' | 'duplicate',
): void {
  if (!clientMessageId) return;
  sendJson(ws, {
    kind: 'chat_ack',
    sessionId,
    clientMessageId,
    status,
    timestamp: new Date().toISOString(),
  });
}

function sendProtocolError(
  ws: WebSocket,
  code: string,
  error: string,
  sessionId?: string,
  /**
   * gk:这条错是在回哪种请求。同一个 code 在不同请求上意义不同(`SESSION_NOT_FOUND`
   * 在 chat.send 上 = 这条会话已经没了;在 permission-response 上 = 没这条待批),
   * 客户端只对 `chat.send` 那一种切「会话已被删除」态。
   */
  request?: 'chat.send' | 'chat.abort' | 'chat.subscribe' | 'permission-response' | 'chat.cancel-queued',
): void {
  sendJson(ws, {
    kind: 'protocol_error',
    code,
    error,
    sessionId: sessionId ?? null,
    ...(request ? { request } : {}),
    timestamp: new Date().toISOString(),
  });
}

/**
 * F7 —— 一条会话最多收一条「排队中」的消息。
 *
 * 之前 `chat.send` 撞上在跑的回合就直接 `RUN_IN_PROGRESS` 打回去。前端确实有
 * 自己的排队(cb 轮那条,存在浏览器 localStorage 里),但它盖不住两种情况:
 *
 *   1. **判定竞态** —— 前端以为空闲、服务端还在跑(上一轮刚结束的帧还在路上、
 *      或者另一台设备刚发过一条)。这时前端不会入队,而是照常发,然后吃一个
 *      协议错误 —— 那条消息就没了。
 *   2. **关掉标签页** —— 前端的队列是 localStorage,页面一关就没人替它发。
 *
 * 服务端收下这一条,回合结束后自动续发。**只收一条**:排两条以上就等于允许
 * 用户把一串指令扔进黑盒,而中间那条的结果他根本没看到就发了下一条 ——
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
 * fz(安全):客户端 options **白名单** —— 只有这几个键能进运行时。
 *
 * ## 为什么是白名单,不是"把危险的删掉"
 *
 * 这里原来是 `{ ...clientOptions, ...服务端覆盖项 }`。覆盖名单是一份**黑名单**:
 * 谁想起来了就往上加一条。`cwd` 就是这么补上的(客户端给了就赢 → 拿别人的项目
 * 路径跑 Claude)。而漏掉的那两个更狠:
 *
 * - `oneShot` → 让这一轮走一次性路径;
 * - `newSessionId` → 一次性路径把它**直接钉成 SDK 的 transcript id**
 *   (`claude-sdk.js` 的 `mapCliOptionsToSDK`,优先级还高于 resume)。
 *
 * 于是:在自己的会话里发一条 `chat.send`,options 里塞
 * `{ oneShot: true, newSessionId: "<别人的会话 id>" }` —— 流上第一条消息把这个 id
 * 回灌给网关 → `assignProviderSessionId` 查到撞号的那一行 → **DELETE 掉别人的
 * 会话行**,并把它的 transcript 路径和名字并进攻击者自己那行。会话 id 是 uuid,
 * 就在浏览器地址栏里,不是密钥。
 *
 * 黑名单治不了这个病:运行时能读的键有二十来个(`ownerUserId` / `usageSource` /
 * `resumeSessionId` / `runId` / `imageRoots`…),下一个人加一个新键,这里不会跟着改。
 * 白名单反过来 —— 忘了加只会让一个新功能不生效(看得见),不会让一个新洞打开。
 *
 * 名单就是前端 `buildSendOptions` 真正会发的那几项。`images` / `forkFrom` /
 * `hiddenContext` / `projectPath` **不在这里** —— 它们各自有专门的校验分支
 * (重新落盘校验 / 归属校验 / 剥离 / 数据库优先),白名单放行反而会绕过那些分支。
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
 * fl:这条会话有没有排队中的消息 —— 删除会话前要看它。
 *
 * 排队的那条会在回合结束后被 drain 出去,给一条已经被删掉的会话起新一轮。
 */
export function hasPendingSendForSession(appSessionId: string): boolean {
  return pendingSends.has(appSessionId) || drainingSends.has(appSessionId);
}

/**
 * fj:排队消息的定时清扫。
 *
 * 30 分钟 TTL 原来**只在 `scheduleDrainPendingSend` 的 setImmediate 里检查**,
 * 而那个函数只在「某一轮结束」或「有人 subscribe 这条会话」时才被调用。
 * 一条会话如果排了消息之后既没有新回合、也没人再打开,那条 `PendingSend`
 * (含最大 4 MiB 的 `data` 和一个已关闭 socket 的引用)就一直留在内存里。
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
 * dv:**已认领、正在派发中**的续发。
 *
 * `scheduleDrainPendingSend` 先把消息从 pendingSends 里摘掉(认领,防重发),
 * 再走 `handleChatSend` —— 而后者在 `startRun` 之前还有几段 await(抄历史、
 * 图片上传…)。这段窗口里:回合还没登记,排队也已经不在表里,于是用户按
 * 停止时两头都找不到东西可撤,"刹车没刹住",那条消息照样发出去。
 * 派发期间在这里留个可取消的令牌,中止路径据此把它拦下来。
 */
const drainingSends = new Map<string, { cancelled: boolean }>();

/**
 * 谁**正在看**哪条会话(chat.subscribe 登记,socket 关闭时摘掉)。
 *
 * 注意和 `broadcastToSessionViewers` 的区别:那个按"能不能看见"过滤,是**权限**;
 * 这个是"此刻真的开着这条会话",是**意愿**。推流集合该跟后者走 —— 按权限推
 * 会把整段助手输出发给共享项目里所有没在看的人。
 *
 * 用途:新一轮开跑时,把这些 socket 一并接进推流集合。原来只接"发起这一轮的
 * 那个 socket",于是空闲时订阅过的第二个标签页整轮一帧收不到。
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
 * du:**每一轮都重判可见性**。此前只在 `chat.subscribe` 那一刻查一次,
 * 之后这个 socket 就一直躺在 viewers 里 —— 项目被改私有 / 共享被撤销之后,
 * 它照样能收到后续每一轮的全部帧(工具结果正文、文件内容、审批请求)。
 * 下面的 `broadcastToSessionViewers` 本来就是每帧重判的,两条推流路径的
 * 口径必须一致。判不过的直接从 viewers 摘掉,不再接流。
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
 * fz:注册到回合注册表 —— 四个 `startRun` 调用点(网页聊天、定时任务、
 * 外部 API 同步/异步)从此走同一步。此前只有 `chat.send` 那条路 attach,
 * 另外三条起的回合对**已经开着**这条会话的浏览器一帧都不推。
 */
setRunStartedHook(attachSessionViewers);

/** 排队消息的存活上限。超时的不再发 —— 半小时前那句话的语境早就不在了。 */
const PENDING_SEND_TTL_MS = 30 * 60 * 1000;

/**
 * 把一帧发给**所有能看到这条会话**的在线 socket。
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
 * gi:按查看者**分别**造帧的广播 —— 排队消息的正文只给排它的人,别人拿到的是脱敏版。
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
 * F14:某段对话的常驻进程被名额挤掉了,告诉正在看它的人一声。
 *
 * 被挤掉本身是正常且必要的(池子有上限),问题在于它**静默**:那段对话的下一条
 * 消息要重建进程并 resume,慢几秒,而用户只会觉得"今天特别卡"。这条帧让界面
 * 能给一句可解释的提示。用 `status` 类型是因为它就是状态,不是错误 ——
 * 什么都没坏,也没有任何东西需要用户处理。
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
 * gk:**会话被永久删除了,告诉所有还看得到它的人。**
 *
 * 两段式:删除之前先把"现在谁看得见这条会话"这份名单定下来(判定要靠 sessions 行,
 * 行一删就判不出来了),行删掉之后再把帧发出去。发晚了的好处是客户端收到帧时
 * 服务端状态已经一致 —— 它随后不管是刷侧栏还是重发,拿到的都是"已经没了"。
 *
 * 此前没有这条帧:别处删了,开着的页面要到**下一次发送**撞到 SESSION_NOT_FOUND 才知道,
 * 而那句报错还是给开发者看的英文。
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
 * gl:会话从最近删除里恢复了 —— 给所有**现在**看得见它的 socket 推一帧。
 *
 * 与 `prepareSessionRemovedBroadcast` 的区别在于名单什么时候定:删除要在动行**之前**
 * 收名单(行没了就判不出可见性),恢复则相反 —— 行已经回来了,当场收即可。
 *
 * **不复用 `announceSessionUpsert`**:那条路带着 `if (row.isArchived) return`
 * 的闸门(侧栏不该让归档会话弹回活跃列表),而恢复一条归档态的会话同样需要
 * 通知前端撤掉「已被删除」态。gk 借用它,结果就是归档态恢复后页面永远卡在删除态。
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
    // gi:正文预览只给排它的人;别人拿到空串 + redacted 标记(客户端据此显示占位,而不是把空串当"没正文")
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
  // 被中止带走的那条要**把正文一起还回去** —— 前端会把它退回输入框。
  //
  // 「停止」是刹车,不该顺手替用户开跑下一段;但也不能把他打过的字吞掉,
  // 因为"排一条纠正再按停止"正是引导 agent 最顺手的操作。所以正文原样退回,
  // 发不发交回给用户的下一次按键。
  // 撤销(cancelled)是用户自己点的删除,他不想要了,不退;
  // 过期(expired)半小时前的语境早就不在了,也不退,只留一句说明。
  // fz:`undeliverable`(续发没能成立)同样退正文 —— 用户什么都没做错,
  // 那段话不能凭空消失。
  const content = (reason === 'aborted' || reason === 'undeliverable')
    && typeof pending?.data?.content === 'string'
    ? pending.data.content
    : null;
  // gi:退回的正文**只退给排它的人** —— 共享会话里别人的输入框不该被灌进这段话。
  broadcastToSessionViewersPerViewer(sessionId, (viewer) => ({
    kind: 'chat_queue_cancelled',
    sessionId,
    reason,
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
 * fj:编辑重跑的**父会话**必须过归属校验。
 *
 * `forkFrom.providerSessionId` 此前是客户端原样透传,零校验 —— 它会直接变成
 * SDK 的 `resume`,也就是"把那条会话的 transcript 当成本轮的上下文加载进来"。
 * 紧邻几行的 `cwd` 已经因为同一形状的笔误修过一次(注释就在上面),而这一条
 * 一直留着。
 *
 * 能不能读到别人的对话,还取决于 CLI 解析 `--resume` 时找不找得到跨项目的
 * transcript —— 但这不是把校验省掉的理由:**现在是零校验,而补上只要几行**。
 *
 * 校验不过就丢弃 `forkFrom`(降级成一条普通新会话)并回一条协议错误,而不是
 * 整轮拒绝:用户看得懂"分叉没成立",一轮对话凭空失败则看不懂。
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
  /** dv:续发派发令牌 —— 中止路径可以在 startRun 之前把这一条拦下来。 */
  /**
   * dv:续发派发令牌 —— 中止路径可以在 startRun 之前把这一条拦下来。
   * fj:`onAccepted` 在 run 真的登记之后回调,续发据此才广播 `chat_queue_flushed`
   *     (无条件先广播的话,任何一条早退分支都会让排队卡消失而消息没发出去)。
   */
  drainToken?: { cancelled: boolean; onAccepted?: () => void },
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.send requires a sessionId.');
    return;
  }

  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    // gk:这句仍是给日志/开发者看的;客户端按 code + request 切成「这条会话已被删除」态,不再原样显示它。
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
   * fj:授权身份取自 **`userId`(发送方)**,不是 `ws`(回话用的那个 socket)。
   *
   * 这两者平时相等,唯独**排队消息续发**时不等:`scheduleDrainPendingSend` 在
   * 入队 socket 已关闭时,会从 `sessionViewers` 里挑一个"还活着的别人的 socket"
   * 当回话对象 —— 于是 A 排的那条消息,被拿 B 的身份去过可见性检查。
   *
   * 具体后果:A 在共享会话里排了消息 → A 的访问被撤销 → B 还在看 →
   * 续发按 **B** 的身份通过校验,**A 的消息照样执行**。
   *
   * `ws` 仍然是回话通道(协议错误发给它),但它不再是身份来源。
   */
  const authUserId = typeof userId === 'number' || typeof userId === 'string' ? Number(userId) : null;
  /**
   * 用户名要一起带上 —— root 是按 **用户名**(`PRISM_ROOT_USERS`)认的,
   * 只给 userId 会让 root 也被这道门挡住。
   *
   * 这次查询本来在下面为 `actorUsername` 做,提到这里一次查询两处用。
   */
  const authUsername = authUserId !== null ? userDb.getUserById(authUserId)?.username ?? null : null;
  const authViewer = { userId: authUserId, username: authUsername };

  // 这道门原来漏在这里 —— abort / subscribe / permission-response 三处都有,
  // 唯独 send 没有,而 send 是四条里影响最大的那条。
  //
  // 常驻 runtime 是**按 provider session id 建索引的,键里没有用户**
  // (claude-sdk.js 的 `claudeRuntimes`),`runtimeForSend` 每次都拿发送方的
  // permissionMode / allowedTools 覆盖 runtime 上的,还会对活着的子进程调
  // `setPermissionMode`。所以少了这道门,任何已登录的 socket 只要拿得到一个
  // 会话 id,就能往别人的对话里发消息、顺带把自己的权限模式按到别人的运行时上
  // —— 包括 bypassPermissions。
  if (!canViewerSeeSession(sessionId, authViewer)) {
    sendProtocolError(ws, 'SESSION_NOT_FOUND', `Session "${sessionId}" was not found.`, sessionId, 'chat.send');
    return;
  }

  /**
   * F09:幂等门。
   *
   * 放在可见性检查**之后** —— 否则任何已登录 socket 都能拿它探"这个会话 id
   * 存不存在、这条消息发过没有"。
   *
   * 同一个 `clientMessageId` 第二次到达时:**只回 ACK,不执行**。
   * 前端据此把 outbox 那条标成 acked、清掉排队记录,不会再重投。
   */
  const clientMessageId = typeof data.clientMessageId === 'string' ? data.clientMessageId : null;
  /**
   * **续发不过幂等门。**
   *
   * 排队那一条在收下时已经登记过它的键了(见下面 `pendingSends` 那支),
   * 而续发是服务端拿着**同一份 data** 重新进这个函数 —— 按键判重会把它当成
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
   * ga:**没回 ACK 的早退,必须把幂等键退回去。**
   *
   * 键在这里就登记了,可下面还有六条早退分支一条都不回 ACK(终端接管、
   * provider 不支持、准备期被停止、抄历史之后的两道复检、排队位已满)。
   * 按这张表自己写的契约("收到 ACK 才算发出去了"),遵守契约的重投会撞上
   * 去重、拿到一个假的 `duplicate` ACK —— 这条消息既没执行也没有痕迹。
   * 详见 chat-send-dedupe.ts 里 `forgetSend` 的说明。
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
   * 回合开始之前,先确保这个会话的显示日志是**完整的**。
   *
   * 老会话(这一轮之前建的)日志里一行都没有,而这次回合会往里写。写完之后
   * `fetchHistory` 就会改从日志读 —— 如果不先把已有历史抄进去,刷新页面时
   * 之前的对话会整段消失。抄一次就够,之后这个会话永久归日志管。
   *
   * 放在 `startRun` 之前:抄的是"这次发送之前"的历史,顺序天然对得上,
   * 也不会和本回合正在写入的新消息抢同一批 id。
   */
  // du:抄写结果要看。失败(读不动 transcript / 整批没落成)时**本轮整轮
  // 不落日志** —— 落哪怕一行,fetchHistory 就改判日志为权威,老会话几百条
  // 历史立刻从界面消失且不可恢复。这一轮继续走 transcript,下轮再抄一次。
  /**
   * fl:**直接发送的准备期也要能被停止。**
   *
   * `drainingSends` 只覆盖"排队消息续发"那条路;普通 `chat.send` 在这段 await
   * (老会话读整份 transcript,能到秒级)里既没有 run、也没有排队记录,于是
   * `chat.abort` 三个分支全落空,回 `NO_ACTIVE_RUN` —— 而 seed 返回之后这一轮
   * 照常起跑。用户按了停止,机器却开始干活。
   *
   * 用同一张令牌桌:调用方传进来的(续发)优先,没有就自己登记一张。
   */
  const preparingToken = drainToken ?? { cancelled: false };
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

  // dv:抄历史那几段 await 期间用户按了停止 —— 这一条就此作废,不再开回合。
  //
  // dz:用 `chat_queue_cancelled` + reason:'aborted' + content,**不再**发一个
  // 自造的 `chat_queue_dropped`。后者前端一个 case 都没有(dv 只加了服务端这半
  // 边):排队指示器"有一条在等"会一直挂到刷新,消息正文既不退回输入框、还会
  // 作为一条未知 kind 的行混进消息列表。复用已经接好的那条路 —— 清指示器 +
  // 正文退回输入框(见 useChatRealtimeHandlers 的 chat_queue_cancelled 分支)。
  if (preparingToken.cancelled) {
    const droppedContent = typeof data.content === 'string' ? data.content : null;
    broadcastToSessionViewers(sessionId, {
      kind: 'chat_queue_cancelled',
      sessionId,
      reason: 'aborted',
      ...(droppedContent ? { content: droppedContent } : {}),
      timestamp: new Date().toISOString(),
    });
    releaseSendKey();
    return;
  }

  /**
   * fj:seed 那段 await 之后,**三道门全部重判一次**。
   *
   * 上面的可见性检查、终端接管检查都发生在 `await seedDisplayLogFromTranscript`
   * **之前**,而那一步要读整份 transcript,老会话能到秒级。这段窗口里完全可能:
   *   - 共享被撤销 → 一条本不该发的消息照样发进去了;
   *   - 终端刚接管这段对话 → chat 和 PTY 同时写同一份 transcript(双写,
   *     正是所有权登记要消掉的那件事)。
   *
   * `drainToken.cancelled` 已经覆盖了"停止"这一路,这里补上另外两路。
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
   * gh:**分叉不能接在已有历史的会话后面 —— 明说,不再无声丢弃。**
   *
   * 下面 runtimeOptions 里 `forkFrom` 只在"目标会话没有原生 id"时才认,否则静默
   * 置 undefined。composer 的同页提交会把 sessionId 清空(新开一支),但排队记录
   * 恢复 / 后台续发那两条路此前把它钉回原会话 —— 编辑后的内容就这样**追加**进了
   * 原对话,带着本该被丢弃的旧上下文,而客户端拿到的是 accepted。
   * 前端两条路已改(不再钉原会话);这里是最后一道门:真到了这里就回一条协议错误。
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
    // 推流集合由 `startRun` 的 runStartedHook 统一接(见 chat-run-registry),
    // 四个调用点共用同一步 —— 这里不再单独调一次。
    // fj:续发到这里才算真的成立(所有早退分支都已经走完)。
    drainToken?.onAccepted?.();
    // F09:回合已登记 = 服务端确实收下了这一条。
    sendSendAck(ws, sessionId, clientMessageId, 'accepted');
  }

  if (!run) {
    // F7:不再直接打回去 —— 收下这一条,回合结束自动续发(见 pendingSends)。
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
     * gc:**先试真合流。**
     *
     * 排队这条路的问题不是它错,是它**攒着**:消息躺在 Prism 手里,画一张
     * 「已排队」的卡片,要等当前这一轮彻底跑完才由 Prism 重新发起一轮。
     * 而 provider 那边本来就有命令队列(后台任务通知走的就是它),
     * 直接推进去,由 CLI 自己决定什么时候投递 —— 那才是"我打断你一句"的样子。
     *
     * 三条边界,任何一条不成立都**退回排队**(= 今天的行为,不是退步):
     *   1. 带图片的不合流 —— 见 `mergeUserMessage` 的说明(那段顺序不动);
     *   2. 已经有一条在排队的不合流 —— 否则"排队上限一条"这条契约会被绕过,
     *      而且下面那条 QUEUE_FULL 的提示就变成谎话;
     *   3. provider 侧不成立(没有常驻 runtime、正在自动压缩……)。
     */
    const mergeFn = dependencies.mergeFns?.[provider];
    const mergeClientOptions = (data.options ?? {}) as AnyRecord;
    const clientImages = mergeClientOptions.images;
    const carriesImages = Array.isArray(clientImages) && clientImages.length > 0;
    /**
     * gh:合流路径**不再丢 `hiddenContext`,也不再丢发送者的身份**。
     *
     * 「让 Claude 建定时任务」的票据与接口说明全在 hiddenContext 里,此前只有
     * spawn 那条路拼进去,合流那条路把它整个扔了 —— 模型只收到那句人话,票据作废。
     * 身份与策略(actorUsername / ownerUserId / 权限档位)交给 provider 侧核对:
     * 与目标 runtime 不是同一个人、同一个档位,就不合流,退回排队。
     * 与下面 spawn 那条路同一份截断/剥离规则(见 `hiddenContext` 的说明)。
     */
    const mergeHiddenContext = typeof mergeClientOptions.hiddenContext === 'string'
      ? mergeClientOptions.hiddenContext.slice(0, 16_384).trim()
      : '';
    if (mergeFn && !carriesImages && !pendingSends.has(sessionId) && rawContent.trim()) {
      let merged: { merged: boolean; reason?: string } = { merged: false, reason: 'not-attempted' };
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
         * 用户这条消息**当场落库**。
         *
         * 与真回合那条路同一份写法(见下面 `hasUserContent` 那一段):只落库、
         * **不外发帧** —— 在线端已有乐观气泡,再广播会双;刷新后前端的 `local_`
         * 乐观行会被这份服务端拷贝正常去重。
         *
         * 这一笔比排队那条路**早得多**:排队期间刷新,那条乐观气泡就没了,
         * 只剩一张卡片(今天的行为)。合流之后它一开始就在日志里。
         */
        if (persistDisplayLog) {
          sessionMessagesDb.append(sessionId, {
            id: generateMessageId('user'),
            sessionId,
            timestamp: new Date().toISOString(),
            provider,
            kind: 'text',
            role: 'user',
            content: rawContent,
          } as Parameters<typeof sessionMessagesDb.append>[1]);
        }
        /**
         * 告诉观测回合:**下一轮无主帧是用户自己发的**,不是后台任务触发的 ——
         * 别给它盖「📬 这一轮由 Claude Code 自己发起」的标记。
         *
         * (合流的消息可能被 CLI 当场并进这一轮 —— 那时根本不会有无主帧,
         * 这个标记会自己过期,见 noteMergedSend。)
         */
        noteMergedSend(sessionId);
        drainToken?.onAccepted?.();
        sendSendAck(ws, sessionId, clientMessageId, 'accepted');
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
     * gh:重新排队也是"服务端收下了"。
     *
     * drain 认领的那条若在这里重新排上,`.finally` 里那句"跑完一圈都没人说收下了"
     * 会把它当 undeliverable 丢掉 —— 刚广播的 chat_queued 立刻跟一条 chat_queue_cancelled,
     * 而排队的人若已关掉标签页,这条消息就此消失。
     *
     * **顺序**:`onAccepted` 会广播 `chat_queue_flushed`(上一条排队已被取走),所以要在
     * 重新广播 `chat_queued` **之前**调 —— 反过来客户端最后收到的是"队列空了",而队列里
     * 明明还有这一条。
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
  // ed:除全局图库外,还放行本会话项目的 attachments/(cu 起图片就落在那里)。
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
   * do:会话命名闭环。客户端每次发送都带 options.sessionSummary(新会话 =
   * 首条消息摘要;技能调用已换成「技能名:参数」),此前服务端从来没读它 ——
   * 侧栏名字只是前端乐观行,一刷新就没。这里只在 custom_name 还空着时落一次,
   * 用户手动改名/已有名字永远优先。
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
   * 隐藏上下文(ck 轮):随消息附带、只给模型看的补充说明。
   *
   * 「让 Claude 创建定时任务」把一次性票据和接口用法装在这里 —— 页面气泡和
   * 显示日志只落用户那句人话,发给运行时的提示词= 人话 + 隐藏块。来源是已
   * 登录前端自己(和 content 同一信任级),截断到 16KB 防滥用;转发给运行时
   * 的 options 里剥掉它,不让它顺流进 provider 的参数层。
   */
  const hiddenContext = typeof clientOptions.hiddenContext === 'string'
    ? clientOptions.hiddenContext.slice(0, 16_384).trim()
    : '';
  delete clientOptions.hiddenContext;

  /**
   * 把**用户这条消息本身**写进显示日志。
   *
   * 日志的其它内容都从出站帧收口(ChatSessionWriter.forward),但用户的消息是
   * 入站的,从来没有对应的出站帧 —— 于是显示日志时代(az 起)的会话刷新页面后
   * **用户气泡整段消失**(活着的页面靠前端乐观回显撑着,才一直没露馅),连带
   * 重载后「编辑重跑 / ↑ 历史回填 / 失败重试」全部失灵(它们都以历史里的用户行
   * 为锚)。这里直接落库、**不**外发帧:在线端已有乐观气泡,再广播会双;
   * 刷新后前端的 local_ 乐观行会被这份服务端拷贝正常去重(hasServerEchoForLocalUser)。
   */
  // du:`persistDisplayLog` 为 false(seed 失败)时这一行也不能写 —— 它正是
  // 会把空日志变成"有一行"的那一笔,历史就此从界面消失。
  /**
   * fl:判据从"正文非空"改成"**这一条有没有内容**"。
   *
   * 只发图片(不打字)是合法的一条消息 —— 前端的提交路径也允许了 ——
   * 但这里只在 `command.trim()` 非空时才写用户事件,于是那条消息**不进显示日志**:
   * 刷新之后历史里只有助手的回答,没有"用户问了什么",回合配对也少一条。
   */
  const hasUserContent = Boolean(command.trim())
    || (Array.isArray(sanitizedImages) && sanitizedImages.length > 0);
  if (persistDisplayLog && hasUserContent) {
    sessionMessagesDb.append(sessionId, {
      id: generateMessageId('user'),
      sessionId,
      timestamp: new Date().toISOString(),
      provider,
      kind: 'text',
      role: 'user',
      content: command,
      ...(Array.isArray(sanitizedImages) && sanitizedImages.length > 0 ? { images: sanitizedImages } : {}),
    } as Parameters<typeof sessionMessagesDb.append>[1]);
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
  // fj:与上面那道可见性门共用同一次查询(见 authViewer)。
  const actorUsername = authUsername;

  const runtimeOptions: AnyRecord = {
    ...pickClientRuntimeOptions(clientOptions),
    actorUsername,
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
     * cwd **只从会话行取**。
     *
     * 这里原本是 `clientOptions.cwd ?? session.project_path` —— 客户端给了就赢,
     * 而这个函数的注释(见上)白纸黑字写着 project path 绝不来自客户端,紧邻的下一行
     * `projectPath` 也确实是数据库优先。两行方向相反,是笔误。
     *
     * 后果不是理论上的:用户在**自己的**会话里(所以会话可见性检查通过)带一个
     * 别人的项目路径发消息,Claude 就带着完整读写工具在别人的项目里跑起来 ——
     * 整套项目可见性模型被绕开。
     */
    cwd: session.project_path ?? undefined,
    projectPath: session.project_path ?? clientOptions.projectPath,
    /**
     * A7:这一轮图片允许来自哪些目录 —— **由这道门算一次,运行时照用**。
     *
     * 运行时那边原来自己再判一遍(全局图库 + cwd),判据与这里不同:
     * 台账兜底放行的那些图(落在别的项目 attachments/ 下的历史文件)在这里
     * 过了,到那边又被拒,而日志只说"outside allowed roots"。
     * 把结论传过去,两道门从此说同一句话。
     */
    imageRoots: Array.from(new Set([
      ...sessionAttachmentRoots,
      ...sanitizedImages
        .map((image) => (typeof image.path === 'string' ? path.dirname(image.path) : ''))
        .filter((dir): dir is string => Boolean(dir)),
    ])),
    // Prism: fork descriptor for edit-and-rerun (branch off a parent session).
    // Only honored when this session has no native id yet (fresh branch).
    // fj:**父会话要过归属校验**(见 resolveAuthorizedFork)。
    forkFrom: !session.provider_session_id
      ? resolveAuthorizedFork(clientOptions.forkFrom, authViewer, ws)
      : undefined,
  };

  try {
    await spawnFn(hiddenContext ? `${command}\n\n${hiddenContext}` : command, runtimeOptions, run.writer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`[Chat] Provider runtime "${provider}" failed`, { sessionId, error: message });
  } finally {
    // Safety net: a runtime that crashed (or resolved) without emitting its
    // terminal `complete` would otherwise leave the session stuck in
    // "processing" forever on every connected client. Scoped to THIS run —
    // a queued message can start the session's next run before this promise
    // settles, and the session-keyed completeRun would kill that new run.
    chatRunRegistry.completeRunIfCurrent(run, { exitCode: 1 });
    // F7:这一轮结束了,把排队那条接上去。放在 setImmediate 里是为了先让当前
    // 调用栈退干净 —— 续发会再走一遍 handleChatSend,直接递归 await 会把两轮
    // 叠在同一个栈上,出错时的堆栈也读不出是哪一轮。
    scheduleDrainPendingSend(sessionId, dependencies);
  }
}

/**
 * 把排队那条消息接到刚结束的回合后面(F7)。
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
    // dn-O3:入队的那个 socket 可能已经关了(标签页关闭后排队仍在服务端活着,
    // 这正是 F7 的卖点)。帧流本来就靠 attachSessionViewers 接给所有在看的人,
    // 但 handleChatSend 的"回话对象"(协议错误、QUEUE_FULL 之类)发给死 socket
    // 就进了黑洞 —— 换成一个还活着的 viewer;一个都没有就仍用原 socket
    // (行为同旧,反正没人看)。
    const liveWs = pending.ws.readyState === WS_OPEN_STATE
      ? pending.ws
      : [...(sessionViewers.get(sessionId) ?? [])].find((viewer) => viewer.readyState === WS_OPEN_STATE)
        ?? pending.ws;
    let accepted = false;
    const drainToken = {
      cancelled: false,
      onAccepted: () => {
        accepted = true;
        broadcastToSessionViewers(sessionId, {
          kind: 'chat_queue_flushed',
          sessionId,
          timestamp: new Date().toISOString(),
        });
      },
    };
    drainingSends.set(sessionId, drainToken);
    /**
     * fj:`chat_queue_flushed` 挪到**续发真的成立之后**再广播。
     *
     * 原来是无条件先广播:前端据此清掉排队指示器,紧接着 `handleChatSend` 里
     * 任何一条早退分支(会话不可见、终端接管、provider 不支持)只会给一个 socket
     * 回一条协议错误,既不广播、也不像 `dropPendingSend` 那样把正文退回输入框。
     * 从用户视角就是「排队卡消失了、消息没发出去、我打的那段话凭空没了」。
     */
    void handleChatSend(liveWs, pending.userId, pending.data, dependencies, drainToken)
      .catch((error) => {
        log.error('[Chat] 排队消息续发失败:', error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (drainingSends.get(sessionId) === drainToken) drainingSends.delete(sessionId);
        /**
         * fz:**续发没能成立时,得有人告诉界面一声。**
         *
         * 上面那句 `pendingSends.delete` 是"认领"—— 条目从此不在表里了。
         * 而 `handleChatSend` 在真正开跑之前有六条早退(会话没了、可见性变了、
         * 终端接管了、provider 不支持、seed 之后重判……),它们只给一个 socket
         * 回一条协议错误,**既不广播,也走不到 `dropPendingSend`**(条目已经
         * 不在表里,那个 delete 返回 false)。
         *
         * fj 那轮把 `chat_queue_flushed` 从"无条件先广播"挪到 `onAccepted`,
         * 堵住了"卡片消失但消息没发";另一半没跟上 —— 现在是**卡片永远不消失,
         * 而消息同样没发**,正文也没退回输入框。要刷新才能让它消失。
         *
         * 判据放在这里而不是逐条早退上打补丁:六条早退里漏一条,病就还在;
         * 而"跑完一圈都没人说收下了"这一句,把将来新增的早退也一并覆盖。
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
 * 每条按 sessionId 寻址的消息都要过这道门 —— `chat.send` 曾经漏了,见那边的说明。
 *
 * `chat.subscribe` 需要它是因为订阅会把 socket 加进 run 的输出集合:一条对话的
 * 实时流、以及其中的工具审批请求,都会广播给集合里的每一个人。
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
    // dn-B4:complete → setImmediate(drain) 的空窗里按停止:没有活跃回合,
    // 但排队那条还躺着 —— 撤掉它正是这次中止的全部意义。原来这里提前 return,
    // 走不到下面的 dropPendingSend,排队那条随后照发("刹车没刹住"的最后残余)。
    // 撤到了就不报 NO_ACTIVE_RUN:用户按停止得到了他想要的结果。
    if (dropPendingSend(sessionId, 'aborted')) {
      return;
    }
    // dv:排队那条刚被认领、正走在 handleChatSend 的 await 里(回合还没登记)
    // —— 把令牌置为取消,它到 startRun 之前会自己作废。同样算"停住了"。
    const draining = drainingSends.get(sessionId);
    if (draining && !draining.cancelled) {
      draining.cancelled = true;
      return;
    }
    sendProtocolError(ws, 'NO_ACTIVE_RUN', `Session "${sessionId}" has no active run.`, sessionId);
    return;
  }

  /**
   * fj:中止的意图在**按下的那一刻**就已确定 —— 排队那条现在就撤,不等 I/O。
   *
   * 原来这两件事都排在 `await abortFn` 之后。而 `abortFn` 内部的
   * `interruptWithTimeout` 最长要等 5 秒,这期间:回合的 promise 先 settle →
   * `handleChatSend` 的 finally 触发 `scheduleDrainPendingSend` → 排队那条被认领
   * 并 `startRun` 成新的一轮。等 await 回来时,"停止"已经晚了一步 ——
   * 排队那条照样发给了模型,正是 F7/dv 想根治的那件事。
   */
  dropPendingSend(sessionId, 'aborted');
  const draining = drainingSends.get(sessionId);
  if (draining) draining.cancelled = true;

  const abortFn = dependencies.abortFns[run.provider];
  let success = false;
  if (abortFn && run.providerSessionId) {
    success = Boolean(await abortFn(run.providerSessionId, { runId: sessionId }));
  }

  // First turn of a new conversation: the provider-native id only arrives
  // mid-stream, so the route above is a no-op until then. Claude registers
  // every run under the app session id (chat.send passes it as runId), and
  // its abort function falls back to that registry when the provider-session
  // route cannot find the run — the turn is aborted (or flagged before it
  // starts) instead of silently running on.
  if (!success && abortFn && run.provider === 'claude') {
    success = Boolean(await abortFn('', { runId: sessionId }));
  }

  /**
   * fj:按 **run 身份**收尾,不是按会话 id。
   *
   * `completeRun(sessionId, …)` 会**重新按 sessionId 查表**,而上面那两处 await
   * 期间下一轮完全可能已经起来了 —— 于是这一句把**新那一轮**标成了 completed:
   * 前端停止转圈、停止按钮消失,而它还在继续吐帧;`isProcessing` 变 false 之后
   * 用户再发一条会让 `startRun` 直接放行,同一会话出现两个并发回合,双写同一份
   * transcript。
   *
   * registry 本来就为这个坑备了 `completeRunIfCurrent`(它的注释写的正是这件事),
   * 只是中止路径没用上。`run` 用的是上面 `getRun` 拿到的那个引用。
   */
  chatRunRegistry.completeRunIfCurrent(run, {
    exitCode: success ? 0 : 1,
    aborted: true,
  });
}

/**
 * Handles `chat.subscribe`: for each requested session, reports whether a run
 * is processing, re-attaches the live stream to this socket, replays missed
 * events (seq > lastSeq), and includes pending permission requests.
 *
 * This single message replaces the old `check-session-status`,
 * `get-pending-permissions`, and Claude-only writer reconnect flows.
 */
/** fj:单帧批量订阅的上限 —— 见 handleChatSubscribe 里的说明。 */
const MAX_SUBSCRIBE_TARGETS = 200;

function handleChatSubscribe(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): void {
  /**
   * fj:批量订阅要封顶。
   *
   * 循环体每一项都要跑 `canViewerSeeSession`(三次同步 SQLite 查询)+
   * `getPendingApprovalsForSession`(全量扫)+ 一次 `sendJson`,而整个 handler 是
   * **同步**的 —— 一次调用在单个事件循环 tick 里跑完。入站单帧上限 4 MiB,而
   * `{"sessionId":"x"}` 只要几十字节,所以一帧能塞进十万量级;WS 消息层又没有
   * 任何限流(限流只在 HTTP 侧)。
   *
   * 于是任何一个通过认证的账号(不需要任何项目权限 —— 不可见的会话是在循环体
   * 里才被跳过,三次查询已经花掉了)发一帧就能把事件循环阻塞数秒,期间所有人的
   * 聊天、心跳、HTTP 全部停摆,同时十几万条 ack 一次性排进发送队列。
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
   * 只有**单条**订阅才预热。
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

    // F7 兜底:回合可能不是从 handleChatSend 的 finally 里结束的(看门狗、
    // 运行时崩溃)。那条路上没人来接排队消息,它会一直躺着。订阅是页面回到
    // 这条会话的时刻,顺手检查一次最便宜。
    if (!isProcessing && pending) {
      scheduleDrainPendingSend(sessionId, dependencies);
    }

    // F14:打开一段对话时把它的运行时预热起来(见下面的 maybePrewarm)。
    if (!isProcessing && isSingleTarget) {
      maybePrewarm(sessionId, dependencies);
    }

    // 订阅即登记 —— **不再只在"这一刻正好在跑"时才接**。
    //
    // 原来只有 `isProcessing` 为真才 attachConnection,于是"空闲时订阅过这条会话"
    // 的第二个标签页,在下一轮开跑时根本不在推流集合里:整轮一帧收不到,
    // 连 complete 都没有(因而也不触发兜底刷新),界面停在旧状态直到手动切走再切回。
    // F7 排队续发同理 —— 新 run 只认"当初排队的那个 socket"。
    rememberSessionViewer(sessionId, ws);
    if (isProcessing) {
      chatRunRegistry.attachConnection(sessionId, ws);
    }

    // 待批审批用 **app 会话 id** 查,不再走 `run?.providerSessionId`。
    //
    // 原来是 `run?.providerSessionId ? 查 : []`,而新会话的第一轮里
    // `providerSessionId` 必然是 null(startRun 从库里读的就是 null,要等运行时
    // announce 才补上)。于是那个三元**必定短路成 `[]`** —— 而前端收到
    // `chat_subscribed` 是整体替换,空数组也算数组,**已经弹出来的审批框会被抹掉**。
    // 症状就是"弹窗闪一下就没了,然后 55 秒后超时"。
    //
    // 现在 claude-sdk 侧的待批请求同时按 provider 原生 id 和 app 会话 id 索引
    // (`_appSessionId`),app 会话 id 从第一轮就存在,所以这里可以无条件地查,
    // 空数组也就真的意味着"没有待批的",替换语义随之变得正确。
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
       * fj:重放缓冲还剩的最早 seq —— 客户端据此判断"我这段是不是已经被裁掉了"。
       * 见 `earliestBufferedSeq`:没有它,首帧缺口在跳号检测里是看不见的。
       */
      earliestBufferedSeq: chatRunRegistry.earliestBufferedSeq(sessionId),
      pendingPermissions,
      // F7:排队中的那条也要报出来 —— 刷新页面或换设备后,"有一条在等"这件事
      // 不能只活在发起它的那个标签页里。
      /**
       * gh:排队消息的**正文预览只给排它的人**。共享会话里其他查看者只需要知道
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
  }
}

/** 预热去抖:同一条会话 60 秒内只预热一次。 */
const PREWARM_DEBOUNCE_MS = 60_000;
/**
 * fj:有上界。
 *
 * 原来是一个纯 `Map`,每次单条 `chat.subscribe` 写一条、**进程生命周期内从不删除**
 * (会话归档、删除都不会清)。单条开销约百字节,但无上界 —— 长期不重启的实例
 * (部署文档说明是常驻服务)会随会话数一直涨。
 *
 * 条目只用来判"60 秒内预热过没有",过期即无意义,所以插入时顺手扫掉过期的,
 * 并压一道硬上限兜底。
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
 * 打开一段对话时把常驻运行时先拉起来(F14)。
 *
 * 只对**已有原生会话 id** 的对话预热 —— 新会话的第一条消息本来就要新建进程,
 * 提前建一个没有 resume 目标的空进程只是白占名额。
 *
 * 全程 best-effort:任何失败都吞掉,预热是优化不是功能。
 */
function maybePrewarm(sessionId: string, dependencies: ChatWebSocketDependencies): void {
  const prewarm = dependencies.prewarmSession;
  if (!prewarm) return;

  const now = Date.now();
  const last = lastPrewarmAt.get(sessionId) ?? 0;
  if (now - last < PREWARM_DEBOUNCE_MS) return;
  rememberPrewarm(sessionId, now);

  // 终端正接管着这段对话时**不能**预热 —— 预热会再建一个进程 resume 同一段对话,
  // 和 PTY 同时写同一份 transcript,正是所有权登记要消掉的双写(症状:聊了半天,
  // 另一边少一截)。REST 那条同功能接口一直有这道闸门(server/index.js),
  // 这条 WS 路径是 F14 后加的,当时漏了。
  if (currentHolder(sessionId)) return;

  let session;
  try {
    session = sessionsDb.getSessionById(sessionId);
  } catch {
    return;
  }
  if (!session?.provider_session_id) return;

  // 注意:这里只传得出 sessionId + cwd,而 runtime 的签名是按 cwd/effort/bypass 算的。
  // 用户开着非默认 effort 或「跳过权限」时,第一条真实消息会因为签名不符而
  // dispose 重建 —— 预热白做。要根治得让预热拿到用户的档位设置,那需要另外一条
  // 数据通路,这里先不动;至少它不会再造成双写。
  void Promise.resolve(
    prewarm({ sessionId: session.provider_session_id, cwd: session.project_path ?? undefined }),
  ).catch(() => {
    // 预热失败只意味着下一条消息回到原来的速度,不该有任何用户可见的后果。
  });
}

/**
 * F7:撤销排队中的那条消息。
 *
 * 能看到这条会话的人都能撤 —— 与"谁都能中止这条会话的回合"同一口径。排队消息
 * 本来就是公开可见的(subscribe 里报了),对它的操作也没理由更严。
 */
function handleCancelQueued(ws: WebSocket, data: AnyRecord): void {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.cancel-queued requires a sessionId.');
    return;
  }
  if (!assertSocketMaySeeSession(ws, sessionId)) {
    return;
  }
  if (dropPendingSend(sessionId, 'cancelled')) return;

  /**
   * fj:派发窗口里的那条也要能撤。
   *
   * `scheduleDrainPendingSend` 先从 `pendingSends` 删掉(认领),再设
   * `drainingSends` 的取消令牌,然后走 `handleChatSend` —— 后者在 `startRun`
   * 之前还要 await 一次 seed(老会话要读 transcript,能到秒级)。
   * `chat.abort` 早就会读这个令牌,`chat.cancel-queued` 却只看 `pendingSends`,
   * 查不到就直接回 `NO_QUEUED_MESSAGE`。
   *
   * 于是回合刚结束、排队卡还显示着的那一两百毫秒里点删除:用户看到
   * 「没有排队消息」的错误提示,然后那条他刚刚明确删掉的消息照样发给了模型。
   */
  const draining = drainingSends.get(sessionId);
  if (draining && !draining.cancelled) {
    draining.cancelled = true;
    broadcastToSessionViewers(sessionId, {
      kind: 'chat_queue_cancelled',
      sessionId,
      reason: 'cancelled',
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
 * Handles authenticated chat websocket messages used by the main chat panel.
 *
 * Inbound protocol (client to server):
 * - `chat.send`                { sessionId, content, options? }
 * - `chat.abort`               { sessionId }
 * - `chat.subscribe`           { sessions: [{ sessionId, lastSeq? }] }
 * - `chat.cancel-queued`       { sessionId }
 * - `chat.permission-response` { requestId, allow, updatedInput?, message?, rememberEntry? }
 *
 * Outbound protocol (server to client): every frame is `kind`-based — either
 * a provider `NormalizedMessage` (with `seq`) or a gateway event
 * (`chat_subscribed`, `session_upserted`, `loading_progress`,
 * `chat_queued`, `chat_queue_cancelled`, `chat_queue_flushed`, `protocol_error`).
 */
/**
 * dv:最近一次注册的依赖。给 `drainPendingSendForSession` 用 —— 外部 API
 * 触发的回合结束时也要续发排队消息,而那条路径(routes/agent.js)拿不到
 * 这里的 dependencies。整个进程只有一套 provider 依赖,存一份即可。
 */
let lastChatDependencies: ChatWebSocketDependencies | null = null;

/**
 * dv:一轮结束后把排队那条接上去 —— 供**非 WS 路径**调用。
 *
 * 排队(F7)是按会话存在服务端的,而外部 API(routes/agent.js)也能在同一条
 * 会话上跑回合。此前只有 WS 的 `handleChatSend` 在 finally 里续发:用户在页面
 * 上排了一条,恰好这时定时任务/外部 API 在同一会话跑了一轮 —— 那一轮结束后
 * 没有人来接,排队那条就一直躺到 30 分钟 TTL 过期被丢掉,用户永远等不到回复。
 */
export function drainPendingSendForSession(sessionId: string): void {
  if (!sessionId || !lastChatDependencies) return;
  scheduleDrainPendingSend(sessionId, lastChatDependencies);
}

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
   * fl:把**握手那一刻的 `token_version`** 也盖上。
   *
   * fj 的心跳复检只问"这个用户还在不在",而「退出所有设备」/ 改密码走的是
   * **旋转 token_version**,用户行照样在 —— 于是那条已经建立的聊天连接一直有效,
   * 还能继续发指令。用户以为撤销了所有设备,实际只撤销了"再拿新票据"的能力。
   *
   * 票据消费那条路已经比对 token_version(见 websocket-auth),这里补上"连接
   * 建立之后"的那一半。
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
          handleCancelQueued(ws, data);
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
