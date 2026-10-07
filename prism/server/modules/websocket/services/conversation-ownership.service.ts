/**
 * 谁正在"持有"一段对话。
 *
 * chat 和 shell 是两条互不知情的路:chat 用 Agent SDK 的常驻 runtime 收发结构化
 * 事件,shell 起一个 `claude --resume` 的 PTY。两边同时开着同一个会话时,两个
 * 进程往同一份 transcript 上追加,谁也看不见谁 —— 表现出来就是"聊了半天,另一边
 * 少一截"。CLI 本身没有多进程仲裁,所以只能在 Prism 这一层记一笔。
 *
 * 模型刻意做得很轻:默认持有者是 chat,不登记。只有 shell 显式接管时才写一条
 * 记录,PTY 退出时抹掉。这样常见路径(只用 chat)零开销,也不存在"忘了释放导致
 * chat 被自己锁死"的状态 —— 没有记录就等于 chat 可用。
 */

import { sessionMessagesDb } from '@/modules/database/index.js';

export type ConversationHolder = {
  panel: 'shell';
  userId: string | number | null;
  username: string | null;
  since: string;
  /** 释放凭据 —— 见 `claimForShell`。 */
  token?: string;
};

const holders = new Map<string, ConversationHolder>();

/**
 * 接管令牌的序号。
 *
 * 令牌让"谁持有"可判定,防两种错:接管时覆盖别人的记录(之后一方退出就删掉整把锁,
 * 另一方的 PTY 还连着,chat 却以为没人接管,与它双写同一份 transcript);以及任一条
 * 断开路径释放掉别人刚建立的锁。释放时必须出示自己那张令牌,对不上就不动。
 */
let claimSequence = 0;

/**
 * 终端接管一段对话。返回的 token 是释放时的凭据。
 *
 * 已被接管时不覆盖:两个终端都被记成持有者的话,后者先退出会释放整把锁,前者的 PTY
 * 却还连着,chat 于是判成"没人接管",与那个 PTY 双写同一份 transcript。
 * 已有持有者时返回现有的持有者(不带 token),调用方据此知道自己没拿到锁。
 */
export function claimForShell(
  appSessionId: string,
  viewer: { userId?: string | number | null; username?: string | null },
): ConversationHolder {
  const existing = holders.get(appSessionId);
  if (existing) {
    /**
     * 有持有者就不发第二张令牌,同一个人也不例外:真正的重连走不到这里(shell 那边按
     * terminalId 复用 PTY,提前返回),能走到这里的是同一用户的另一个 PTY。把同一张令牌给它的话,
     * 第一个终端关闭时令牌匹配,锁被释放、显示日志被删,而第二个 PTY 还在写,chat 也随之放行。
     * 终端那边据此打印"已被另一个终端接管"。
     */
    return { ...existing, token: undefined };
  }
  const holder: ConversationHolder = {
    panel: 'shell',
    userId: viewer.userId ?? null,
    username: viewer.username ?? null,
    since: new Date().toISOString(),
    token: `claim_${++claimSequence}_${Date.now()}`,
  };
  holders.set(appSessionId, holder);
  return holder;
}

/**
 * PTY 退出/断开时调用。不存在也不报错 —— 断开路径不该因为这个抛异常。
 *
 * 同时丢掉这段对话的显示日志。
 *
 * 显示日志的前提是"这段对话的每一条消息都从 Prism 手里过过一遍"。终端接管的
 * 这一截没有:`claude --resume` 直接往 transcript 上追加,Prism 一个字节都没看见。
 * 留着一份缺了中间一截的日志,界面上就会少掉终端里聊的那几轮 —— 比回落到
 * transcript 糟糕得多。
 *
 * 丢掉之后,下一次在 Prism 里发言会用 transcript(此时它已经包含终端那一截)
 * 重新抄一份完整的日志。代价是重抄一次,换来的是"要么完整、要么没有"这条不变式。
 */
export function releaseShellClaim(appSessionId: string, token?: string): void {
  const current = holders.get(appSessionId);
  if (!current) return;
  /**
   * 出示的令牌对不上就什么都不做。
   *
   * 不给令牌的调用方照常释放:一刀切要求令牌会让任何一条漏传的断开路径
   * 把锁永久留住,那比偶尔多释放一次更糟。
   */
  if (token && current.token && current.token !== token) {
    return;
  }
  holders.delete(appSessionId);
  try {
    sessionMessagesDb.deleteForSession(appSessionId);
  } catch {
    // 断开路径不抛异常;删不掉大不了下次继续用旧日志。
  }
}

/** 当前持有者;返回 null 表示"chat 可用"。 */
export function currentHolder(appSessionId: string): ConversationHolder | null {
  return holders.get(appSessionId) ?? null;
}

/** 测试钩子:清空所有登记。 */
export function resetConversationOwnership(): void {
  holders.clear();
}
