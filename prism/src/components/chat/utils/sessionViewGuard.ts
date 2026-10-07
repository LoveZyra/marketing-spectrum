/**
 * `selectedSession` 为空时,正文能否继续按 `currentSessionId` 渲染。
 *
 * 这条判定所在的 effect 有几百行、没法起 hook 来测,所以抽成纯函数单独钉住。
 *
 * - `currentSessionId`:正文此刻按哪条会话渲染;
 * - `establishedHere`:本视图自己刚建立的会话 id(新会话页上发第一条消息、网关分配了 id、
 *   路由还没跟上)—— 只有这种来源的 id 有资格继续撑着;
 * - `isProcessing`:那条会话是否在跑。
 *
 * 只有「本视图建立的 + 正在跑」才保留,缺一个就清。只看 `isProcessing` 不够:从一条正在跑的会话切走
 * (点项目行 / 切项目,这条路不 bump newSessionTrigger)也满足,别的会话正文会被留在「新会话」页上持续更新。
 */
export function shouldKeepOrphanedSessionView(input: {
  currentSessionId: string | null;
  establishedHere: string | null;
  isProcessing: boolean;
}): boolean {
  return Boolean(input.currentSessionId)
    && input.establishedHere === input.currentSessionId
    && input.isProcessing;
}
