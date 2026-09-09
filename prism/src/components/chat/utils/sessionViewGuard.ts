/**
 * `selectedSession` 为空时,正文还能不能继续用 `currentSessionId` 撑着。
 *
 * 抽成纯函数只为一件事:能被钉住。这条判定住在一个几百行的 effect 里,
 * 没法起 hook 来测;而它恰恰是线上"新会话页面上挂着别的会话正文"的病根。
 *
 * ## 三个输入
 *
 * - `currentSessionId`:正文此刻按哪条会话渲染;
 * - `establishedHere`:这个 id 是不是**本视图自己刚建立的**(新会话页上发第一条
 *   消息、网关分配了 id、路由还没跟上)—— 只有这种来源的 id 有资格继续撑着;
 * - `isProcessing`:那条会话在不在跑。
 *
 * ## 唯一放行的组合
 *
 * 本视图建立的 + 正在跑。少一个都清。
 *
 * 原来只看 `isProcessing`:从一条正在跑的会话切走(点项目行 / 切项目,那条路
 * 不 bump newSessionTrigger)也满足,于是别的会话的正文被钉在「新会话」页面上,
 * 随它的流式一直更新,F5 才消失。root 新开页面看不到,因为没有这段残留状态。
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
