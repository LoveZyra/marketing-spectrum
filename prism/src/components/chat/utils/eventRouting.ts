/**
 * 实时帧的会话归属(dk)。
 *
 * 症状(线上截图):别的会话的折叠时间轴钉在**每个**页面顶端,F5 才消失。
 * 根因:没带 `sessionId` 的帧一律被记到"当前正在看的那个会话"头上
 * (`sid = msg.sessionId || activeViewSessionId`),然后 `appendRealtime`
 * 落进本地列表;服务端 transcript 不认它,`pruneRealtimeSupersededByServer`
 * 永远清不掉。后台会话 / 定时任务 / 外部 API 触发的回合里,凡是绕过
 * ChatSessionWriter 装饰的边角帧都可能不带会话 id,于是全被焊死在你正看的页面上。
 *
 * 修法:**归属不明的帧一律不落盘**。
 * 1. 服务端每帧都带 `runId`(dc 起),凡是同时带 runId 和 sessionId 的帧,
 *    先把映射记下来;
 * 2. 没带 sessionId 的帧按 runId 查映射;
 * 3. 还查不到 → 返回 null,调用方只把它当控制帧,并打一条 warn ——
 *    宁可少一行,也不要把别的会话的内容焊死在这里。
 *
 * 唯一保留兜底的是 `protocol_error`:它是对**本客户端刚发出的动作**的直接回话,
 * 归到正在看的会话展示是合理的(也只用于展示,不参与游标)。
 */

/** runId → sessionId 映射的容量上限。超限丢最老的(Map 按插入序迭代)。 */
export const RUN_SESSION_MAP_CAP = 200;

type RoutedEvent = { runId?: unknown; sessionId?: unknown; kind?: unknown };

/** 从帧里学映射:runId 与 sessionId 同时在场才算数。 */
export function learnRunSession(
  map: Map<string, string>,
  msg: RoutedEvent,
  cap: number = RUN_SESSION_MAP_CAP,
): void {
  if (typeof msg.runId !== 'string' || !msg.runId) return;
  if (typeof msg.sessionId !== 'string' || !msg.sessionId) return;
  if (!map.has(msg.runId) && map.size >= cap) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(msg.runId, msg.sessionId);
}

/**
 * 解出这一帧属于哪条会话:自带 sessionId 优先,否则按 runId 查映射,
 * 都没有就是 null —— 调用方不得把 null 归到任何会话头上。
 */
export function resolveEventSid(map: Map<string, string>, msg: RoutedEvent): string | null {
  if (typeof msg.sessionId === 'string' && msg.sessionId) return msg.sessionId;
  if (typeof msg.runId === 'string' && msg.runId) return map.get(msg.runId) ?? null;
  return null;
}

/**
 * 丢帧告警的节流:同一个 (kind, runId) 只报一次,免得一轮里几十条同源帧
 * 把控制台刷成瀑布。集合有界,超限整个清掉重来(告警丢了无所谓,行为不变)。
 */
export function createDropWarner(
  warn: (message: string) => void = (message) => console.warn(message),
  cap = 100,
) {
  const seen = new Set<string>();
  return (msg: RoutedEvent): void => {
    const key = `${String(msg.kind ?? 'unknown')}:${typeof msg.runId === 'string' ? msg.runId : 'none'}`;
    if (seen.has(key)) return;
    if (seen.size >= cap) seen.clear();
    seen.add(key);
    warn(`[Chat] 丢弃一帧归属不明的实时消息(kind=${String(msg.kind ?? 'unknown')}, runId=${typeof msg.runId === 'string' ? msg.runId : '无'})—— 它没带会话 id,也查不到所属回合。`);
  };
}
