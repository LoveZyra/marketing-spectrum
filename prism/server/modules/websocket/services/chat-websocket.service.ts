import path from 'node:path';

import type { WebSocket } from 'ws';

import { canViewerSeeSession, sessionMessagesDb, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { seedDisplayLogFromTranscript } from '@/modules/providers/index.js';
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import { currentHolder } from '@/modules/websocket/services/conversation-ownership.service.js';
import { getGlobalImageAssetsDir, normalizeImageDescriptors } from '@/shared/image-attachments.js';
import { readSocketViewer } from '@/shared/project-visibility.js';
import type {
  AnyRecord,
  AuthenticatedWebSocketRequest,
  LLMProvider,
} from '@/shared/types.js';
import { generateMessageId, parseIncomingJsonObject } from '@/shared/utils.js';

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
export function filterImagesToUploadStore(images: unknown, assetsRootOverride?: string): AnyRecord[] {
  const assetsRoot = path.resolve(assetsRootOverride ?? getGlobalImageAssetsDir());

  return normalizeImageDescriptors(images).filter((descriptor) => {
    // Relative paths are anchored in the store; absolute ones must already be in it.
    const resolved = path.resolve(assetsRoot, descriptor.path);
    const relative = path.relative(assetsRoot, resolved);
    const isDirectChild =
      relative.length > 0 &&
      !relative.startsWith('..') &&
      !path.isAbsolute(relative) &&
      !relative.includes(path.sep) &&
      !relative.includes('/');

    if (!isDirectChild) {
      console.warn(`[Chat] Dropping image outside the upload store: ${descriptor.path}`);
    }
    return isDirectChild;
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
function sendProtocolError(
  ws: WebSocket,
  code: string,
  error: string,
  sessionId?: string
): void {
  sendJson(ws, {
    kind: 'protocol_error',
    code,
    error,
    sessionId: sessionId ?? null,
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

/** 把所有正在看这条会话的 socket 接进这一轮的推流集合。 */
function attachSessionViewers(sessionId: string): void {
  const viewers = sessionViewers.get(sessionId);
  if (!viewers) return;
  for (const viewer of viewers) {
    if (viewer.readyState !== WS_OPEN_STATE) {
      viewers.delete(viewer);
      continue;
    }
    chatRunRegistry.attachConnection(sessionId, viewer);
  }
  if (viewers.size === 0) sessionViewers.delete(sessionId);
}

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

function queuedFrame(sessionId: string, pending: PendingSend) {
  return {
    kind: 'chat_queued',
    sessionId,
    preview: pending.preview,
    enqueuedAt: new Date(pending.enqueuedAt).toISOString(),
    timestamp: new Date().toISOString(),
  };
}

/**
 * 丢弃一条排队消息并广播。`reason` 会显示给用户 —— "被撤销"和"因为你中止了
 * 回合"是两回事,不说清楚就变成消息凭空消失。
 */
function dropPendingSend(sessionId: string, reason: 'cancelled' | 'aborted' | 'expired'): boolean {
  const pending = pendingSends.get(sessionId);
  if (!pendingSends.delete(sessionId)) return false;
  // 被中止带走的那条要**把正文一起还回去** —— 前端会把它退回输入框。
  //
  // 「停止」是刹车,不该顺手替用户开跑下一段;但也不能把他打过的字吞掉,
  // 因为"排一条纠正再按停止"正是引导 agent 最顺手的操作。所以正文原样退回,
  // 发不发交回给用户的下一次按键。
  // 撤销(cancelled)是用户自己点的删除,他不想要了,不退;
  // 过期(expired)半小时前的语境早就不在了,也不退,只留一句说明。
  const content = reason === 'aborted' && typeof pending?.data?.content === 'string'
    ? pending.data.content
    : null;
  broadcastToSessionViewers(sessionId, {
    kind: 'chat_queue_cancelled',
    sessionId,
    reason,
    ...(content ? { content } : {}),
    timestamp: new Date().toISOString(),
  });
  return true;
}

function readRequiredSessionId(data: AnyRecord): string | null {
  const sessionId = typeof data.sessionId === 'string' ? data.sessionId.trim() : '';
  return sessionId.length > 0 ? sessionId : null;
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
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.send requires a sessionId.');
    return;
  }

  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    sendProtocolError(
      ws,
      'SESSION_NOT_FOUND',
      `Session "${sessionId}" was not found. Create it via POST /api/providers/sessions first.`,
      sessionId
    );
    return;
  }

  // 这道门原来漏在这里 —— abort / subscribe / permission-response 三处都有,
  // 唯独 send 没有,而 send 是四条里影响最大的那条。
  //
  // 常驻 runtime 是**按 provider session id 建索引的,键里没有用户**
  // (claude-sdk.js 的 `claudeRuntimes`),`runtimeForSend` 每次都拿发送方的
  // permissionMode / allowedTools 覆盖 runtime 上的,还会对活着的子进程调
  // `setPermissionMode`。所以少了这道门,任何已登录的 socket 只要拿得到一个
  // 会话 id,就能往别人的对话里发消息、顺带把自己的权限模式按到别人的运行时上
  // —— 包括 bypassPermissions。
  if (!assertSocketMaySeeSession(ws, sessionId)) {
    return;
  }

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
    return;
  }

  const provider = session.provider as LLMProvider;
  const spawnFn = dependencies.spawnFns[provider];
  if (!spawnFn) {
    sendProtocolError(ws, 'UNSUPPORTED_PROVIDER', `Provider "${provider}" is not available.`, sessionId);
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
  await seedDisplayLogFromTranscript(sessionId);

  const run = chatRunRegistry.startRun({
    appSessionId: sessionId,
    provider,
    providerSessionId: session.provider_session_id,
    connection: ws,
    userId,
  });

  if (run) {
    // 这一轮的推流集合不只有发起方 —— 所有正在看这条会话的 socket 一并接上。
    attachSessionViewers(sessionId);
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
      return;
    }

    const rawContent = typeof data.content === 'string' ? data.content : '';
    const pending: PendingSend = {
      ws,
      userId,
      data,
      enqueuedAt: Date.now(),
      preview: rawContent.slice(0, 120),
    };
    pendingSends.set(sessionId, pending);
    broadcastToSessionViewers(sessionId, queuedFrame(sessionId, pending));
    return;
  }

  const clientOptions = (data.options ?? {}) as AnyRecord;
  const command = typeof data.content === 'string' ? data.content : '';
  const sanitizedImages = filterImagesToUploadStore(clientOptions.images);

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
  if (command.trim()) {
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
  const runtimeOptions: AnyRecord = {
    ...clientOptions,
    // Image attachments are re-validated server-side: only files inside the
    // global upload store may reach the provider runtimes' file reads.
    images: sanitizedImages,
    sessionId: session.provider_session_id ?? undefined,
    // Gateway run identifier: the Claude runtime registers its abort handle
    // under this id so `chat.abort` works even before the provider-native
    // session id is captured (the whole first turn of a new conversation).
    runId: sessionId,
    resume: Boolean(session.provider_session_id),
    cwd: clientOptions.cwd ?? session.project_path ?? undefined,
    projectPath: session.project_path ?? clientOptions.projectPath,
    // Prism: fork descriptor for edit-and-rerun (branch off a parent session).
    // Only honored when this session has no native id yet (fresh branch).
    forkFrom: !session.provider_session_id && clientOptions.forkFrom
      ? clientOptions.forkFrom
      : undefined,
  };

  try {
    await spawnFn(hiddenContext ? `${command}\n\n${hiddenContext}` : command, runtimeOptions, run.writer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Chat] Provider runtime "${provider}" failed`, { sessionId, error: message });
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
    broadcastToSessionViewers(sessionId, {
      kind: 'chat_queue_flushed',
      sessionId,
      timestamp: new Date().toISOString(),
    });
    void handleChatSend(pending.ws, pending.userId, pending.data, dependencies).catch((error) => {
      console.error('[Chat] 排队消息续发失败:', error instanceof Error ? error.message : String(error));
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
    sendProtocolError(ws, 'NO_ACTIVE_RUN', `Session "${sessionId}" has no active run.`, sessionId);
    return;
  }

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

  chatRunRegistry.completeRun(sessionId, {
    exitCode: success ? 0 : 1,
    aborted: true,
  });

  // F7:中止的意思是"停",不是"停这一条然后接着跑下一条"。排队那条一并丢掉,
  // 并且说清楚是被中止带走的 —— 否则用户只会看到消息凭空消失。
  dropPendingSend(sessionId, 'aborted');
}

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
  const targets = Array.isArray(data.sessions) ? data.sessions : [];
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
      pendingPermissions,
      // F7:排队中的那条也要报出来 —— 刷新页面或换设备后,"有一条在等"这件事
      // 不能只活在发起它的那个标签页里。
      queued: pending
        ? { preview: pending.preview, enqueuedAt: new Date(pending.enqueuedAt).toISOString() }
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
const lastPrewarmAt = new Map<string, number>();

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
  lastPrewarmAt.set(sessionId, now);

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
  if (!dropPendingSend(sessionId, 'cancelled')) {
    sendProtocolError(ws, 'NO_QUEUED_MESSAGE', `Session "${sessionId}" has no queued message.`, sessionId);
  }
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
export function handleChatConnection(
  ws: WebSocket,
  request: AuthenticatedWebSocketRequest,
  dependencies: ChatWebSocketDependencies
): void {
  console.log('[INFO] Chat WebSocket connected');
  connectedClients.add(ws);

  const userId = readRequestUserId(request);
  // Broadcasts fan out over `connectedClients`, which holds bare sockets.
  // Stamping the identity here is what lets them be filtered by project
  // ownership instead of going to every browser on the server.
  (ws as typeof ws & { prismUserId?: string | number | null; prismUsername?: string | null }).prismUserId = userId;
  (ws as typeof ws & { prismUsername?: string | null }).prismUsername =
    typeof request?.user?.username === 'string' ? request.user.username : null;

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
      console.error('[ERROR] Chat WebSocket error:', message);
      sendProtocolError(ws, 'INTERNAL_ERROR', message);
    }
  });

  ws.on('close', () => {
    console.log('[INFO] Chat client disconnected');
    connectedClients.delete(ws);
    // 从所有 run 的订阅者集合里摘掉。不摘也不会漏(forward 会清理已关闭的),
    // 但摘掉能让 `liveConnectionCount()` 立刻反映现实 —— 审批帧要不要认为
    // "送到了"读的就是它。
    chatRunRegistry.detachConnection(ws);
    forgetViewerEverywhere(ws);
  });
}
