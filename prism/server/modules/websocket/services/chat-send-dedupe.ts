/**
 * `chat.send` 的幂等门。
 *
 * `socket.send()` 不抛异常只代表写进了本地发送缓冲。socket 在写入之后、服务端读到之前断开
 * (切网、休眠唤醒、代理超时)很常见,而此时前端已清了草稿、画了乐观气泡;用户等不到回应就会重发,
 * 若服务端其实收到了第一条,就会真的执行两遍(模型跑两轮、改两遍文件)。
 * 所以客户端给每次发送生成幂等键(`clientMessageId`,见 `src/components/chat/utils/sendCommand.ts`),
 * 服务端按它去重,收下后回 ACK:收到 ACK 才算发出去了。
 *
 * 表存在单进程内存里,与运行 / 队列 / 接管状态一致;多实例部署时要一起挪到共享存储,
 * 否则幂等只在同一个实例内成立。
 *
 * 窗口取 10 分钟:只盖住"以为没发出去而重发"的那段时间,不做永久去重
 * (隔天再发同一句话是正常操作,而且每次都会有新的 clientMessageId)。
 */

/** 幂等窗口:超过这个时间的键不再记得。 */
export const SEND_DEDUPE_TTL_MS = 10 * 60 * 1000;

/** 每条会话最多记多少个键 —— 防止一条长会话把内存撑起来。 */
export const SEND_DEDUPE_MAX_PER_SESSION = 200;

type SeenMap = Map<string, number>;

const seenBySession = new Map<string, SeenMap>();

function prune(seen: SeenMap, now: number): void {
  for (const [id, at] of seen) {
    if (now - at > SEND_DEDUPE_TTL_MS) seen.delete(id);
  }
  // 还超量就按插入顺序丢最早的(Map 保序)。
  while (seen.size > SEND_DEDUPE_MAX_PER_SESSION) {
    const oldest = seen.keys().next();
    if (oldest.done) break;
    seen.delete(oldest.value);
  }
}

/**
 * 登记一次发送。
 *
 * 返回 `true` 表示这是新的一条,可以继续处理;返回 `false` 表示
 * 同一个 `clientMessageId` 已经收过了 —— 调用方应当只回一个 ACK,不再执行。
 *
 * 没有 `clientMessageId` 的请求一律放行(不带键的客户端、外部 API):
 * 幂等是能力增强,不是准入条件。
 */
export function registerSend(
  sessionId: string,
  clientMessageId: unknown,
  now: number = Date.now(),
): boolean {
  if (typeof clientMessageId !== 'string' || !clientMessageId) return true;

  let seen = seenBySession.get(sessionId);
  if (!seen) {
    seen = new Map();
    seenBySession.set(sessionId, seen);
  }

  const at = seen.get(clientMessageId);
  if (at !== undefined && now - at <= SEND_DEDUPE_TTL_MS) {
    return false;
  }

  // 先删再插:Map 对已存在的键保留原插入位置,而下面按插入顺序淘汰。
  // 不删的话,一个刚过期又重新登记的键会被当成最老的那批先丢掉。
  seen.delete(clientMessageId);
  seen.set(clientMessageId, now);
  // 淘汰放在插入之后 —— 放前面会让上限变成 MAX+1(先剪到 MAX 再插一条)。
  prune(seen, now);
  return true;
}

/**
 * 退还一个还没兑现的幂等键。
 *
 * 契约是"收到 ACK 才算发出去了",没收到 ACK 的重投应被正常处理。`handleChatSend` 在会话可见性
 * 检查之后就登记键,之后的早退分支(终端接管、provider 不支持、准备期被停止、抄历史之后的复检、
 * 排队位已满等)都不回 ACK;不退还的话,遵守契约的重投会撞上去重、拿到假的 `duplicate` ACK,
 * 前端据此清掉这条消息,而它其实没有执行。
 *
 * 所以这些分支返回之前把键退回来。登记与退还在同一个同步块里,中间不会有别的重投挤进来
 * (两份重投并发到达的情况与这里的顺序无关)。
 */
export function forgetSend(sessionId: string, clientMessageId: unknown): void {
  if (typeof clientMessageId !== 'string' || !clientMessageId) return;
  const seen = seenBySession.get(sessionId);
  if (!seen) return;
  seen.delete(clientMessageId);
  if (seen.size === 0) seenBySession.delete(sessionId);
}

/** 会话被删掉/归档时清账,别让键留在内存里。 */
export function forgetSession(sessionId: string): void {
  seenBySession.delete(sessionId);
}

/** 测试用:把整张表清干净。 */
export function resetSendDedupeForTest(): void {
  seenBySession.clear();
}

/** 测试用:看某条会话现在记着几个键。 */
export function sendDedupeSizeForTest(sessionId: string): number {
  return seenBySession.get(sessionId)?.size ?? 0;
}
