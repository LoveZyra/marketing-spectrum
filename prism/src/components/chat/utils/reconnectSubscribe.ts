/**
 * 断线重连之后要补订哪些会话。
 *
 * 服务端的推流集合按 socket 记(`sessionViewers`,socket 关闭即摘除),新 socket 对哪条会话都
 * 不是 viewer。补订本客户端知道在跑的所有会话,加上正在看的那条(有的话)。
 *
 * 停在项目首页 / 新会话页时没有正在看的会话,后台在跑的照样要补:不补就收不到它们的实时帧和
 * `complete`,完成提示音 / 标题提示不响,侧栏转圈只能靠轮询收敛,要等用户点回那条会话才重新订阅。
 * `chat.subscribe` 的 `sessions` 本就是数组,一帧发完。
 */
export function reconnectSubscribeTargets(
  viewedSessionId: string | null,
  processingSessionIds: Iterable<string>,
  cursorOf: (sessionId: string) => { runId: string | null; seq: number } | undefined,
): Array<{ sessionId: string; lastSeq: number; lastRunId: string | null }> {
  const targets = new Map<string, { sessionId: string; lastSeq: number; lastRunId: string | null }>();
  const track = (sessionId: string | null) => {
    if (!sessionId || targets.has(sessionId)) return;
    const cursor = cursorOf(sessionId);
    targets.set(sessionId, { sessionId, lastSeq: cursor?.seq ?? 0, lastRunId: cursor?.runId ?? null });
  };
  track(viewedSessionId);
  for (const sessionId of processingSessionIds) track(sessionId);
  return [...targets.values()];
}

export interface ReconnectResubscribeDeps {
  /** 正在看的会话;停在项目首页 / 新会话页时是 null。 */
  viewedSessionId: string | null;
  /** 本客户端知道在跑的会话。 */
  processingSessionIds: Iterable<string>;
  cursorOf: (sessionId: string) => { runId: string | null; seq: number } | undefined;
  sendMessage: (message: unknown) => boolean;
  /** 订阅确实送出去之后,记下每条会话的发送时刻(丢弃比这次请求更早的 idle ack 用)。 */
  markSubscribed: (sessionId: string, at: number) => void;
  /** 补拉正在看的那条(REST)。 */
  refresh: (sessionId: string) => Promise<unknown>;
  now?: () => number;
}

/**
 * 断线重连之后:先补订,再补拉正在看的那条。
 *
 * 订阅先发,不排在 REST 往返之后:`chat_subscribed` 回执会恢复或清掉转圈、补发漏掉的实时帧、
 * 把还在跑的流重新挂到这个 socket 上,晚一个往返就多漏一段。发送时刻只在确认送出之后才记
 * (与 useChatSessionState 同一不变量):没送出去也记,就等于在等一个不会来的回执。
 */
export async function resubscribeAfterReconnect(deps: ReconnectResubscribeDeps): Promise<void> {
  const targets = reconnectSubscribeTargets(deps.viewedSessionId, deps.processingSessionIds, deps.cursorOf);
  if (targets.length > 0 && deps.sendMessage({ type: 'chat.subscribe', sessions: targets })) {
    const at = (deps.now ?? Date.now)();
    for (const target of targets) deps.markSubscribed(target.sessionId, at);
  }
  if (deps.viewedSessionId) await deps.refresh(deps.viewedSessionId);
}
