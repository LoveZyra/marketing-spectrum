/**
 * 谁正在"持有"一段对话。
 *
 * chat 和 shell 是两条互不知情的路:chat 用 Agent SDK 的常驻 runtime 收发结构化
 * 事件,shell 起一个 `claude --resume` 的 PTY。两边同时开着同一个会话时,两个
 * 进程往同一份 transcript 上追加,谁也看不见谁 —— 表现出来就是"聊了半天,另一边
 * 少一截"。CLI 本身没有多进程仲裁,所以只能在 Prism 这一层记一笔。
 *
 * 模型刻意做得很轻:**默认持有者是 chat,不登记**。只有 shell 显式接管时才写一条
 * 记录,PTY 退出时抹掉。这样常见路径(只用 chat)零开销,也不存在"忘了释放导致
 * chat 被自己锁死"的状态 —— 没有记录就等于 chat 可用。
 */

import { sessionMessagesDb } from '@/modules/database/index.js';

export type ConversationHolder = {
  panel: 'shell';
  userId: string | number | null;
  username: string | null;
  since: string;
};

const holders = new Map<string, ConversationHolder>();

/** 终端接管一段对话。同一会话重复接管按最后一次算。 */
export function claimForShell(
  appSessionId: string,
  viewer: { userId?: string | number | null; username?: string | null },
): ConversationHolder {
  const holder: ConversationHolder = {
    panel: 'shell',
    userId: viewer.userId ?? null,
    username: viewer.username ?? null,
    since: new Date().toISOString(),
  };
  holders.set(appSessionId, holder);
  return holder;
}

/**
 * PTY 退出/断开时调用。不存在也不报错 —— 断开路径不该因为这个抛异常。
 *
 * 顺手把这段对话的**显示日志丢掉**。
 *
 * 显示日志的前提是"这段对话的每一条消息都从 Prism 手里过过一遍"。终端接管的
 * 这一截没有:`claude --resume` 直接往 transcript 上追加,Prism 一个字节都没看见。
 * 留着一份缺了中间一截的日志,界面上就会**少掉终端里聊的那几轮** —— 比回落到
 * transcript 糟糕得多。
 *
 * 丢掉之后,下一次在 Prism 里发言会用 transcript(此时它已经包含终端那一截)
 * 重新抄一份完整的日志。代价是重抄一次,换来的是"要么完整、要么没有"这条不变式。
 */
export function releaseShellClaim(appSessionId: string): void {
  holders.delete(appSessionId);
  try {
    sessionMessagesDb.deleteForSession(appSessionId);
  } catch {
    // 断开路径不抛异常;抄不掉大不了下次继续用旧日志。
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
