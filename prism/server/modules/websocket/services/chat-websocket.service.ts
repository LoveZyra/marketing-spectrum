import path from 'node:path';

import type { WebSocket } from 'ws';

import { canViewerSeeSession, sessionsDb } from '@/modules/database/index.js';
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
import { parseIncomingJsonObject } from '@/shared/utils.js';

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

  if (!run) {
    sendProtocolError(
      ws,
      'RUN_IN_PROGRESS',
      `Session "${sessionId}" already has a run in progress.`,
      sessionId
    );
    return;
  }

  const clientOptions = (data.options ?? {}) as AnyRecord;
  const command = typeof data.content === 'string' ? data.content : '';

  // The provider runtimes receive the provider-native session id (that is the
  // id their CLI/SDK understands for resume). Brand-new sessions have no
  // provider id yet, so the runtime starts fresh and announces one, which the
  // gateway writer captures and maps back to the app session id.
  const runtimeOptions: AnyRecord = {
    ...clientOptions,
    // Image attachments are re-validated server-side: only files inside the
    // global upload store may reach the provider runtimes' file reads.
    images: filterImagesToUploadStore(clientOptions.images),
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
    await spawnFn(command, runtimeOptions, run.writer);
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
  }
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

    // Future live events for this run should land on the socket that asked —
    // this is what makes mid-stream page refreshes work for all providers.
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
      pendingPermissions,
      timestamp: new Date().toISOString(),
    });

    // Replay only for RUNNING runs, strictly after the ack. Completed runs
    // are fully persisted to the provider transcript and served over REST —
    // replaying them (e.g. after a page reload where the client's lastSeq is
    // 0) would duplicate messages the history fetch already returned.
    if (isProcessing) {
      for (const event of chatRunRegistry.replayEvents(sessionId, lastSeq)) {
        sendJson(ws, event);
      }
    }
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
 * - `chat.permission-response` { requestId, allow, updatedInput?, message?, rememberEntry? }
 *
 * Outbound protocol (server to client): every frame is `kind`-based — either
 * a provider `NormalizedMessage` (with `seq`) or a gateway event
 * (`chat_subscribed`, `session_upserted`, `loading_progress`,
 * `protocol_error`).
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
  });
}
