import type { TodoItem } from './taskChecklist';

/**
 * 工作面板「进度」区的时间轴(对齐 Cowork 的 Progress 栏)—— 纯逻辑,不碰 DOM。
 *
 * 读法是一条竖线:**当前步**是线上那颗点,上面是走过的(灰字),下面是还没到的
 * (正文色)。清单是会话级累计的,一个长会话能攒几十条已完成的历史 —— 所以
 * 当前步之前的已完成条目只留**最近几条**,更早的收进顶上一行「N 个更早的步骤」,
 * 点开原地展开。只改呈现:一条不丢,顺序就是建立顺序。
 *
 * 为什么折的是"当前步之前的已完成",而不是"所有已完成":
 * - 当前步**之后**的已完成(agent 跳着做、先勾了后面的)不是历史,是正在
 *   推进的这一段里的事,折掉它用户会以为那步没做 —— 照常显示;
 * - 当前步之前**没完成**的(被跳过 / 还没轮到)是待办,更不能藏。
 */

export type ProgressRowState = 'done' | 'active' | 'pending';

export interface ProgressRow {
  item: TodoItem;
  /** 在完整清单里的下标(0 起)。 */
  index: number;
  /** done = completed,active = in_progress,pending = pending。 */
  state: ProgressRowState;
  /** 当前步(锚点):时间轴上那颗点、`aria-current="step"`、默认滚动位置。 */
  isAnchor: boolean;
  /** 默认滚动停在这一行(= 锚点;没有锚点时 = 第一条没完成的)。见 ProgressTimeline.focusIndex。 */
  isFocus: boolean;
}

export interface ProgressTimeline {
  /** 锚点下标;-1 = 没有锚点(清单为空,或全部完成)。 */
  anchorIndex: number;
  /** 锚点已开工(in_progress);false 时它只是"下一个要做的"(pending),点画成空心。 */
  anchorStarted: boolean;
  /**
   * 默认滚动位置:有锚点就是锚点;没有锚点但还有没完成的(新回合还没动清单)= 第一条没完成的;全部完成 = -1。
   * 复审(五轮 P3):锚点在"上一轮的老任务"和"没有"之间切换时,滚动位置不跟着跳(原来没有锚点就滚到底)。
   */
  focusIndex: number;
  /**
   * 属于"更早的历史"、默认收起的条数(与 showEarlier 无关)。
   * 0 = 不需要折叠行;展开时 rows 里含着它们,UI 显示「收起更早的步骤」。
   */
  foldableCount: number;
  /** 要画出来的行,完整清单的顺序。 */
  rows: ProgressRow[];
  /** 锚点的 1 起序号(「第 N 步」);没有锚点为 null。 */
  stepNumber: number | null;
  total: number;
  done: number;
  allDone: boolean;
}

export interface BuildProgressTimelineOptions {
  /** 用户点开了「N 个更早的步骤」。 */
  showEarlier?: boolean;
  /** 锚点之前保留几条最近完成的(默认 2)。 */
  keepRecent?: number;
  /** 会话数到的最后一个用户回合(extractSessionChecklistWithTurn 的 currentTurn);见 findProgressAnchor。 */
  currentTurn?: number;
}

/** 锚点之前保留的最近完成条数 —— 也是默认滚动时锚点上方留出的行数。 */
export const DEFAULT_KEEP_RECENT = 2;

/**
 * 锚点(当前步),按**最近一个有任务动静的用户回合**(`TodoItem.turn`)来认:
 * 1. 这一轮里的第一个 in_progress(已开工);
 * 2. 没有的话:这一轮里最后完成的那条之后的第一个 pending(多轮接着做同一份清单:上一轮建的 pending 也算);
 * 3. 再没有:这一轮里的第一个 pending(刚列出来的新清单 / 同一轮跳着做,前面还有没做的);
 * 4. 都没有(这一轮做完了 / 全部完成 / 空清单):没有锚点。
 *
 * 复审(P1,三轮):清单是**整个会话累计**的 —— 某一轮被停止时留下的 in_progress / pending 老任务,agent
 * 往往不会回头关掉。只看状态的话,它们会被当成当前步:第几步数错、之后完成的几十条一条都不折、自动滚动也
 * 滚到它那里。按回合认就分得开:它们属于更早的回合,照样显示、不折,只是不当锚点。
 *
 * **没有回合信息**(TodoWrite 清单、老服务端的基线)时退回只看状态的规则:**最后一个** in_progress
 * (老回合停下的通常排在前面);没有就最后完成那条之后的第一个 pending;再没有就第一个 pending。
 *
 * 复审(五轮 P1):`currentTurn` = 会话数到的最后一个用户回合。它比清单里最大的回合号还大,说明**最近这条用户
 * 消息之后清单还没被动过**(刚发出去、agent 还没开工;或者这一轮压根不碰清单,比如「停,先做 X」)——
 * 这时没有当前步,不拿上一轮的老任务充数。agent 一动清单,锚点就回来。
 */
export function findProgressAnchor(
  todos: readonly TodoItem[],
  currentTurn = 0,
): { index: number; started: boolean } {
  const latestTurn = todos.reduce((max, todo) => Math.max(max, todo.turn ?? 0), 0);
  if (latestTurn === 0) return findAnchorByStatus(todos);
  if (currentTurn > latestTurn) return { index: -1, started: false };
  const inLatest = (todo: TodoItem) => (todo.turn ?? 0) === latestTurn;
  const active = todos.findIndex((todo) => todo.status === 'in_progress' && inLatest(todo));
  if (active >= 0) return { index: active, started: true };
  let lastDoneThisTurn = -1;
  for (let index = todos.length - 1; index >= 0; index -= 1) {
    if (todos[index].status === 'completed' && inLatest(todos[index])) { lastDoneThisTurn = index; break; }
  }
  if (lastDoneThisTurn >= 0) {
    const next = todos.findIndex((todo, index) => index > lastDoneThisTurn && todo.status === 'pending');
    if (next >= 0) return { index: next, started: false };
  }
  return { index: todos.findIndex((todo) => todo.status === 'pending' && inLatest(todo)), started: false };
}

/** 没有回合信息时的规则(见上)。 */
function findAnchorByStatus(todos: readonly TodoItem[]): { index: number; started: boolean } {
  for (let index = todos.length - 1; index >= 0; index -= 1) {
    if (todos[index].status === 'in_progress') return { index, started: true };
  }
  let lastDone = -1;
  for (let index = todos.length - 1; index >= 0; index -= 1) {
    if (todos[index].status === 'completed') { lastDone = index; break; }
  }
  const next = todos.findIndex((todo, index) => index > lastDone && todo.status === 'pending');
  if (next >= 0) return { index: next, started: false };
  return { index: todos.findIndex((todo) => todo.status === 'pending'), started: false };
}

export function buildProgressTimeline(
  todos: readonly TodoItem[],
  { showEarlier = false, keepRecent = DEFAULT_KEEP_RECENT, currentTurn = 0 }: BuildProgressTimelineOptions = {},
): ProgressTimeline {
  const total = todos.length;
  const done = todos.filter((todo) => todo.status === 'completed').length;
  const { index: anchorIndex, started: anchorStarted } = findProgressAnchor(todos, currentTurn);

  // "更早的历史" = 锚点之前的已完成;没有锚点(全部完成 / 这一轮没在推进清单)就是全部已完成 —— 只留最近两条。
  const historyEnd = anchorIndex >= 0 ? anchorIndex : total;
  // 只管默认滚动停哪(不影响折叠):没有锚点时停在第一条没完成的
  const focusIndex = anchorIndex >= 0 ? anchorIndex : todos.findIndex((todo) => todo.status !== 'completed');
  const earlierDone: number[] = [];
  for (let index = 0; index < historyEnd; index += 1) {
    if (todos[index].status === 'completed') earlierDone.push(index);
  }
  const keep = Math.max(0, Math.floor(keepRecent));
  const foldable = earlierDone.slice(0, Math.max(0, earlierDone.length - keep));
  const hidden = new Set(showEarlier ? [] : foldable);

  const rows: ProgressRow[] = [];
  todos.forEach((item, index) => {
    if (hidden.has(index)) return;
    rows.push({
      item,
      index,
      state: item.status === 'completed' ? 'done' : item.status === 'in_progress' ? 'active' : 'pending',
      isAnchor: index === anchorIndex,
      isFocus: index === focusIndex,
    });
  });

  return {
    anchorIndex,
    anchorStarted: anchorIndex >= 0 && anchorStarted,
    focusIndex,
    foldableCount: foldable.length,
    rows,
    stepNumber: anchorIndex >= 0 ? anchorIndex + 1 : null,
    total,
    done,
    allDone: total > 0 && done === total,
  };
}

/* ------------------------------------------------------------------------- *
 * 滚动与边缘渐隐 —— DOM 那边量好数,判据在这里。
 * ------------------------------------------------------------------------- */

export interface AnchorScrollInput {
  /** 锚点行顶边,在滚动内容坐标系里(= 相对视口的 top − 容器 top + scrollTop)。 */
  anchorTop: number;
  /** 锚点**正上方**那几行的高度,由近及远。 */
  aboveHeights: readonly number[];
  /** 锚点上方留出几行(默认 2,对应最近完成的那两条)。 */
  keepAbove?: number;
  /**
   * 算出来的位置不超过这个值就直接回到 0 —— 传列表本身的顶边:那上面只剩
   * 「N 个更早的步骤」那一行和内边距,为它们留一截空白滚动没有意义,
   * 整个露出来正好(截图里那一行就在最上面)。
   */
  snapToTopBelow?: number;
}

/** 默认滚动位置:锚点贴近视口顶部,上方留出最近完成的几行。 */
export function anchorScrollTop({
  anchorTop,
  aboveHeights,
  keepAbove = DEFAULT_KEEP_RECENT,
  snapToTopBelow = 0,
}: AnchorScrollInput): number {
  let top = anchorTop;
  for (const height of aboveHeights.slice(0, Math.max(0, keepAbove))) top -= height;
  // 半像素容差:getBoundingClientRect 带小数,别因为 0.3px 留一条缝。
  if (top <= snapToTopBelow + 0.5) return 0;
  return Math.round(top);
}

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** 上面还有内容 → 顶边渐隐;下面还有 → 底边渐隐。1px 容差吸收缩放带来的小数。 */
export function edgeFadeState(
  { scrollTop, scrollHeight, clientHeight }: ScrollMetrics,
  tolerance = 1,
): { top: boolean; bottom: boolean } {
  return {
    top: scrollTop > tolerance,
    bottom: scrollTop + clientHeight < scrollHeight - tolerance,
  };
}

/** 渐隐用的 mask-image;两头都不用淡时返回 null(把 mask 摘掉)。 */
export function edgeFadeMask({ top, bottom }: { top: boolean; bottom: boolean }, size = 20): string | null {
  if (!top && !bottom) return null;
  const stops = [
    top ? `transparent 0, #000 ${size}px` : '#000 0',
    bottom ? `#000 calc(100% - ${size}px), transparent 100%` : '#000 100%',
  ];
  return `linear-gradient(to bottom, ${stops.join(', ')})`;
}
