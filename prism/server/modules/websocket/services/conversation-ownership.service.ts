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

/** PTY 退出/断开时调用。不存在也不报错 —— 断开路径不该因为这个抛异常。 */
export function releaseShellClaim(appSessionId: string): void {
  holders.delete(appSessionId);
}

/** 当前持有者;返回 null 表示"chat 可用"。 */
export function currentHolder(appSessionId: string): ConversationHolder | null {
  return holders.get(appSessionId) ?? null;
}

/** 测试钩子:清空所有登记。 */
export function resetConversationOwnership(): void {
  holders.clear();
}
