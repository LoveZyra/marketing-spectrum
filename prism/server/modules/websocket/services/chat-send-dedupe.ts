/**
 * F09:`chat.send` 的幂等门。
 *
 * ## 为什么需要它
 *
 * 在此之前,"这条消息发出去了没有"在前端的判据是 `socket.send()` 没抛异常 ——
 * 那只代表**本地写进了发送缓冲**。socket 在写入之后、服务端读到之前断开是很
 * 常见的一瞬(切网、休眠唤醒、代理超时),而这一瞬里前端已经清了草稿、
 * 画了乐观气泡。用户看到消息"发出去了"却没有任何回应,于是重发 ——
 * 如果服务端其实收到了第一条,这一下就是**真的发了两遍**,模型跑两轮、
 * 改两遍文件。
 *
 * 修法是标准的那一套:客户端给每次发送生成一个幂等键(`clientMessageId`,
 * 见 `src/components/chat/utils/sendCommand.ts`),服务端按它去重,
 * 并在收下之后回一个 ACK。**收到 ACK 才算发出去了。**
 *
 * ## 为什么是内存
 *
 * 与运行/队列/接管状态一致(见清单里的 R08):这些都存在单进程内存里。
 * 多实例部署前必须一起重新评估 —— 那时这张表要挪到共享存储,否则两个实例
 * 各记各的,幂等只在同一个实例内成立。
 *
 * 窗口取 10 分钟:它要盖住的是"用户以为没发出去,于是重发"的那段时间,
 * 而不是永久去重(永久去重会让"隔天又发了同一句话"被吞掉 —— 那是正常操作,
 * 何况正常操作每次都会有新的 clientMessageId)。
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
 * 返回 `true` 表示**这是新的一条**,可以继续处理;返回 `false` 表示
 * 同一个 `clientMessageId` 已经收过了 —— 调用方应当只回一个 ACK,不再执行。
 *
 * 没有 `clientMessageId` 的请求一律放行(老客户端、外部 API):
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

  // 先删再插:Map 对**已存在**的键保留原插入位置,而下面按插入顺序淘汰。
  // 不删的话,一个刚过期又重新登记的键会被当成最老的那批先丢掉。
  seen.delete(clientMessageId);
  seen.set(clientMessageId, now);
  // 淘汰放在插入**之后** —— 放前面会让上限变成 MAX+1(先剪到 MAX 再插一条)。
  prune(seen, now);
  return true;
}

/**
 * ga:**退还一个还没兑现的幂等键。**
 *
 * 这张表的契约写在文件开头:**收到 ACK 才算发出去了**,没收到 ACK 的重投
 * 应该被正常处理。可 `handleChatSend` 是在会话可见性检查之后**立刻**登记键的,
 * 之后还有六条早退分支(终端接管、provider 不支持、准备期被停止、抄历史之后
 * 的两道复检、排队位已满)—— 它们一条都不回 ACK,键却已经烧掉了。任何遵守
 * 契约的重投都会撞上去重、拿到一个**假的 `duplicate` ACK**,前端据此清盘:
 * 这条消息既没执行,也没有任何痕迹。
 *
 * 门房的规矩是"收下包裹就撕一张回执";他却先在登记本上划掉单号,再去看仓库
 * 门开没开 —— 门锁着的时候他不收包裹、也不给回执,单号却已经划掉了。
 *
 * 所以这些分支返回之前把键退回来。登记与退还都在同一个同步块里,中间不会有
 * 别的重投挤进来(唯一的例外是**并发**的两份重投,那种情况本来就存在,
 * 而且和这里的顺序无关)。
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
