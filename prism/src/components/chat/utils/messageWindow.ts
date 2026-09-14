import type { ChatMessage } from '../types/types';

/**
 * 聊天区的「渲染窗口」计算。
 *
 * 会话区没有虚拟化 —— `visibleMessageCount` 有多大,就有多少条**真实 DOM**
 * (`chatMessages.slice(-visibleMessageCount)`)。以前「加载全部」和搜索跳转会把
 * 它直接开到 `Infinity`,几百上千条的会话整棵树进 DOM,之后每来一个流式 token
 * 都要 diff 一遍这棵树,长会话越用越卡。
 *
 * 这里把「开到无穷」换成「分批放开」:**数据层照旧全量拉**(搜索、导出、跳转都
 * 不受影响),只是 DOM 分次长出来。真正的虚拟化要能预估每条高度,而这里的消息
 * 高度完全不可预测(markdown / 代码块 / 图片 / 可折叠工具卡),还要和滚动位置
 * 恢复、自动补齐、搜索高亮三套逻辑对齐,那是另一件事。
 */

/** 一批放多少条。「看更早的」每次加这么多,「加载全部」拉完数据先显示这么多。 */
export const MESSAGE_BATCH_SIZE = 200;

/** 搜索跳转时在目标上方多留几条,免得命中的那条正好贴在窗口第一行。 */
export const SEARCH_TARGET_MARGIN = 20;

/** 「看更早的」:在当前窗口上再放一批。已经是 Infinity 就不动。 */
export function revealBatch(current: number, step: number = MESSAGE_BATCH_SIZE): number {
  if (!Number.isFinite(current)) return current;
  return current + step;
}

/** 「加载全部」拉完数据后的初始窗口:至少一批,已经开得更大就保持。 */
export function initialWindowAfterLoadAll(current: number, batch: number = MESSAGE_BATCH_SIZE): number {
  if (!Number.isFinite(current)) return current;
  return Math.max(current, batch);
}

function toEpoch(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN;
  if (typeof value === 'string' && value !== '') return new Date(value).getTime();
  return Number.NaN;
}

/** 和 DOM 侧的匹配口径保持一致:去掉首尾省略号、取前 80 字、小写。 */
export function normalizeSearchPhrase(snippet: string | undefined): string {
  if (typeof snippet !== 'string' || snippet === '') return '';
  const clean = snippet.replace(/^\.{3}/, '').replace(/\.{3}$/, '').trim();
  const phrase = clean.slice(0, 80).toLowerCase().trim();
  return phrase.length >= 10 ? phrase : '';
}

export interface SearchTargetLike {
  snippet?: string;
  timestamp?: string;
}

/**
 * 在数据里定位搜索目标,返回下标;找不到返回 -1。
 *
 * 先按正文片段找(和 DOM 匹配同口径,正向取第一个命中),找不到再按时间戳取最
 * 接近的一条。注意 DOM 匹配的是渲染后的 `textContent`,这里匹配的是原始
 * `content`/`displayText`,两者不完全等价 —— 所以这个结果只用来**决定窗口开多
 * 大**,真正的滚动定位仍然由 DOM 那一轮负责。
 */
export function findTargetIndex(
  messages: readonly Pick<ChatMessage, 'content' | 'displayText' | 'timestamp'>[],
  target: SearchTargetLike,
): number {
  const phrase = normalizeSearchPhrase(target.snippet);
  if (phrase) {
    for (let i = 0; i < messages.length; i += 1) {
      const message = messages[i];
      const text = `${typeof message?.content === 'string' ? message.content : ''}\n${
        typeof message?.displayText === 'string' ? message.displayText : ''
      }`.toLowerCase();
      if (text.includes(phrase)) return i;
    }
  }

  const targetEpoch = toEpoch(target.timestamp);
  if (Number.isFinite(targetEpoch)) {
    let best = -1;
    let bestDiff = Number.POSITIVE_INFINITY;
    for (let i = 0; i < messages.length; i += 1) {
      const epoch = toEpoch(messages[i]?.timestamp);
      if (!Number.isFinite(epoch)) continue;
      const diff = Math.abs(epoch - targetEpoch);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = i;
      }
    }
    return best;
  }

  return -1;
}

/**
 * 搜索跳转要开多大的窗口:**刚好盖住目标**,而不是整段放开。
 *
 * 定位不到目标时返回全长 —— 搜索跳转不能因为省 DOM 而跳不到,宁可这一次多渲染
 * 一些。目标本来就在末尾附近(最常见的情况)时,窗口几乎不用动。
 */
export function visibleCountForTarget(
  messages: readonly Pick<ChatMessage, 'content' | 'displayText' | 'timestamp'>[],
  target: SearchTargetLike,
  current: number,
  margin: number = SEARCH_TARGET_MARGIN,
): number {
  const total = messages.length;
  if (total === 0) return current;
  if (!Number.isFinite(current)) return current;

  const index = findTargetIndex(messages, target);
  if (index < 0) return total;

  const needed = Math.min(total, total - index + margin);
  return Math.max(current, needed);
}

/* ── 按会话记住渲染窗口 ─────────────────────────────────────────── */

/**
 * **换会话不该把上一条会话的窗口白白扔掉。**
 *
 * 现在的行为:在 A 里点了「加载全部」、又「看更早」翻上去几百条,切到 B 再切
 * 回 A —— 窗口砍回首屏 30 条,那几次翻页与那次全量拉取的**结果全部作废**,
 * 要重新点一遍。fm 那轮把"换会话确定性重置"做对了(不再残留 B 的值),
 * 但"回到 A 恢复成离开时的样子"一直欠着。
 *
 * 记的是**视图**状态,不是数据:数据在 store 的槽位里,这里只记"当时摊开多少条"
 * 和"当时是不是已经全量在手"。
 */
export type SessionWindowMemo = {
  /** 离开时窗口里摊着多少条 */
  visibleCount: number;
  /** 离开时「更早的全都在手里了」是不是真的 */
  allLoaded: boolean;
};

export type SessionWindowMemory = ReadonlyMap<string, SessionWindowMemo>;

/** 最多记多少条会话 —— 满了丢最久没碰的那条(Map 的插入序即使用序)。 */
export const MAX_REMEMBERED_WINDOWS = 40;

export const EMPTY_WINDOW_MEMORY: SessionWindowMemory = new Map();

/**
 * "按会话记一份东西"的 LRU 写入。重复记同一条会**先删后插**,好让它排到队尾 ——
 * 否则淘汰的是最近才看过的那条。
 */
function rememberIn<T>(
  memory: ReadonlyMap<string, T>,
  sessionKey: string,
  value: T,
): ReadonlyMap<string, T> {
  if (!sessionKey) return memory;
  const next = new Map(memory);
  next.delete(sessionKey);
  next.set(sessionKey, value);
  while (next.size > MAX_REMEMBERED_WINDOWS) {
    const oldest = next.keys().next();
    if (oldest.done) break;
    next.delete(oldest.value);
  }
  return next;
}

function forgetIn<T>(
  memory: ReadonlyMap<string, T>,
  sessionKey: string,
): ReadonlyMap<string, T> {
  if (!memory.has(sessionKey)) return memory;
  const next = new Map(memory);
  next.delete(sessionKey);
  return next;
}

/** 记下这条会话离开时的窗口。 */
export function rememberSessionWindow(
  memory: SessionWindowMemory,
  sessionKey: string,
  memo: SessionWindowMemo,
): SessionWindowMemory {
  return rememberIn(memory, sessionKey, memo);
}

export function forgetSessionWindow(
  memory: SessionWindowMemory,
  sessionKey: string,
): SessionWindowMemory {
  return forgetIn(memory, sessionKey);
}

export type RecallWindowInput = {
  /** 记下来的那份,没有就是第一次看这条会话 */
  memo: SessionWindowMemo | undefined;
  /** **现在**这条会话手里实际有多少条(槽位里的合并结果) */
  loadedCount: number;
  /** 服务端还说有更早的吗(槽位的 hasMore) */
  hasMore: boolean;
  /** 这条会话一共多少条;0 表示不知道 */
  total: number;
  /** 首屏第一段窗口 */
  phase1: number;
};

/**
 * 回到一条会话时,窗口开多大、要不要恢复「全都在手里了」。
 *
 * ## 两条不变式,都能把分页搞死,所以写在一起
 *
 * **1. `allLoaded` 只在手里真的还是全量时才恢复。**
 * 它为真会让 `loadOlderMessages` / 自动补页 / 「看更早」**全部直接 return**。
 * 如果离开 A 时是全量、期间槽位被淘汰或过期、回来只重新拉了首页 20 条,
 * 照记忆恢复成 true 就等于**把「看更早」永久按死** —— 用户再也翻不上去,
 * 而且看不出为什么。这正是 `du` 那轮修过的死法,只是当时的来源是跨会话串写。
 *
 * 所以判据是"手里**现在**还是不是全量":`!hasMore` 且已加载条数够得上 total。
 * `total` 为 0 表示服务端没给总数,此时只认 `!hasMore`。
 *
 * **2. 窗口不能比手里的条数还大。**
 * 大了会让"首屏第二帧放大"那个 effect 直接短路
 * (`chatMessages.length <= visibleMessageCount`),而它同时是首屏长到
 * `INITIAL` 的唯一入口 —— 窗口会卡在一个虚高的数上不再生长。
 *
 * 没有记忆(第一次看)就走原来的首屏两段式,返回 `phase1`。
 */
export function recallSessionWindow(input: RecallWindowInput): SessionWindowMemo {
  const { memo, loadedCount, hasMore, total, phase1 } = input;
  if (!memo) return { visibleCount: phase1, allLoaded: false };

  const stillComplete = !hasMore && (total <= 0 || loadedCount >= total);
  const allLoaded = memo.allLoaded && stillComplete;

  const ceiling = Math.max(phase1, loadedCount);
  const visibleCount = Number.isFinite(memo.visibleCount)
    ? Math.min(Math.max(memo.visibleCount, phase1), ceiling)
    : ceiling;

  return { visibleCount, allLoaded };
}


/* ── 按会话记住阅读位置 ─────────────────────────────────────────── */

/**
 * 离开一条会话时,人停在哪儿。
 *
 * 坐标用**倒数第几行 + 那一行距容器顶的偏移** —— 和滚动控制器的锚点同一套坐标:
 * 往前补页(看更早)会在列表**头部**插入,正数下标全都要挪,倒数下标不会动。
 *
 * `null`(不是这个类型,是持有它的那一侧)表示"当时就在底部" —— 回来跟底即可,
 * 不需要守位。
 */
export type SessionReadingSpot = {
  /**
   * ga:**那一行的稳定标识** —— 恢复时按它精确找回,不再靠数下标。
   *
   * 倒数下标看着稳(前插不动它),实际有三个来源会让它错位:
   * 后台追加的行、流式气泡与运行指示器的出没、以及**展开一条工具行**
   * (展开区里嵌套的 MessageComponent 同样带 `.chat-message`)。
   * fz 那版试图用"离开与回来之间的消息条数差"去补偿,但那两个量**单位不同**:
   * 60 次工具调用是 61 条消息、渲染出来只有 1 行,补偿反而把落点推出去几十行。
   *
   * 现在顶层行都带 `data-row-key`(嵌套的展开行不带,自然被排除),
   * 直接按它找 —— 找到就精确落位,找不到才退回下标。
   */
  rowKey?: string;
  /** 从末尾倒数第几行(0 = 最后一行)。`rowKey` 找不到时的兜底。 */
  indexFromEnd: number;
  /** 那一行顶边相对容器顶的偏移(可以为负:半行露在视口上方) */
  offset: number;
  /**
   * fz:记这一刻**手里一共有多少条消息**。
   *
   * 倒数下标对**前插**(看更早)是稳的 —— 前插只动头部,倒数坐标不变,这也是
   * 当初选它的理由。但**追加**没有守卫:离开之后这条会话在后台继续跑,新行
   * 全都加在尾部,倒数第 40 行于是指到了别处;回合结束时流式气泡和「运行中」
   * 指示器消失,也会偏一两行。
   *
   * 离开与回来之间的增长几乎全是追加(补页只发生在正看着的时候,而那时位置
   * 每次 commit 都在重记),所以拿两次的条数差把倒数下标顺过去就够准。
   * 老记录没有这个字段 → 不补偿,行为同以前。
   */
  messageCount?: number;
};

export type SessionSpotMemory = ReadonlyMap<string, SessionReadingSpot | null>;

export const EMPTY_SPOT_MEMORY: SessionSpotMemory = new Map();

/**
 * 位置**每次 commit 都在写**,窗口只在离开那一刻写一次 —— 两者存在两张表里,
 * 不合并。合并就是"同一条记录两个写者",fr 那个排队 bug 正是这个形状:
 * 一侧写回盘上、另一侧的守卫恰好跳过,记录就永远清不掉。
 */
export function rememberReadingSpot(
  memory: SessionSpotMemory,
  sessionKey: string,
  spot: SessionReadingSpot | null,
): SessionSpotMemory {
  return rememberIn(memory, sessionKey, spot);
}

/**
 * 记下的位置**现在还落得下去吗**。
 *
 * 回来时行数可能比离开时少(窗口被钳、这一页还没补齐),倒数下标越界就别硬来 ——
 * 硬来的话 `rows[负数]` 是 undefined,再往下就是把视口钉到一个算不出来的地方。
 * 返回 null = 放弃守位,跟底。
 */
export function resolveReadingSpot(
  spot: SessionReadingSpot | null | undefined,
  rowCount: number,
  /** 现在这些行各自的标识(下标一一对应),用来精确找回 `spot.rowKey`。 */
  rowKeyAt?: (index: number) => string | undefined,
): { rowIndex: number; offset: number } | null {
  if (!spot || rowCount <= 0) return null;
  if (!Number.isFinite(spot.offset)) return null;

  /**
   * ga:**先按标识找。** 找到就精确落位 —— 尾部追加了多少行、中间展开过几行、
   * 流式气泡在不在,统统不影响。
   */
  if (spot.rowKey && rowKeyAt) {
    for (let i = rowCount - 1; i >= 0; i -= 1) {
      if (rowKeyAt(i) === spot.rowKey) return { rowIndex: i, offset: spot.offset };
    }
    // 那一行不在窗口里(被裁掉 / 窗口变小)—— 下标兜底也不会更准,直接放弃。
    return null;
  }

  // 老记录没有标识:退回倒数下标(不做任何补偿 —— 补偿的单位对不上,见上面注释)。
  if (!Number.isFinite(spot.indexFromEnd)) return null;
  if (spot.indexFromEnd < 0 || spot.indexFromEnd >= rowCount) return null;
  return { rowIndex: rowCount - 1 - spot.indexFromEnd, offset: spot.offset };
}

/* ── 谁动的方向盘:程序化滚动 vs 用户滚动 ────────────────────────── */

/**
 * 判"这一下滚动是我们自己写的"时允许的误差(px)。亚像素布局与浏览器对
 * `scrollTop` 的夹取会让读回值和写入值差一点点。
 */
export const PROGRAMMATIC_SCROLL_TOLERANCE_PX = 2;

/**
 * ga:**这一次滚动事件是用户滚的,还是控制器自己写出来的?**
 *
 * fz 给恢复加"用户滚过了就让位"时,判据是"等待期间只要来一次滚动事件就算
 * 用户滚的",理由写的是「恢复期间我们一个 scrollTop 都不写」——**那句话是错的**:
 * 恢复挂在 `wait` 上时 `followBottom` 仍是 true,控制器每次 commit 都在写
 * `scrollTop = scrollHeight`。于是恢复只要需要等超过一帧(也就是"记的位置比
 * 首屏更靠上"的全部情况,即唯一值得恢复的情况),就必然被自己写出去的滚动
 * 事件掐死。助理一边找上次读的那页,一边自己把书压到最后一页,然后把自己
 * 压书的动静听成"主人动手了",于是撒手不管。
 *
 * 正确的判据是**落点**:控制器每次写完都把读回来的值记下来
 * (`programmaticScrollTopRef`),滚动事件里的 `scrollTop` 跟它一致就是我们
 * 自己那一下。`null` = 还没写过任何一下,那么任何滚动都只可能是用户的。
 */
export function isUserInitiatedScroll(
  scrollTop: number,
  lastProgrammaticScrollTop: number | null,
): boolean {
  if (lastProgrammaticScrollTop === null) return true;
  if (!Number.isFinite(scrollTop) || !Number.isFinite(lastProgrammaticScrollTop)) return true;
  return Math.abs(scrollTop - lastProgrammaticScrollTop) > PROGRAMMATIC_SCROLL_TOLERANCE_PX;
}

/* ── 恢复过程:等行落地,等不到就放弃 ───────────────────────────── */

/** 最多等多少次 commit。 */
export const MAX_RESTORE_COMMITS = 40;
/** 连续多少次 commit 行数不再增长就认为"到齐了" —— 到齐了还落不下去就放弃。 */
export const MAX_RESTORE_STALE_COMMITS = 6;

export type ScrollRestoreState = {
  /** 这份恢复是给**哪条会话**的 —— 不比对就会把 A 的位置恢复到 B 身上 */
  sessionKey: string;
  spot: SessionReadingSpot;
  /** 已经等了几次 commit */
  commits: number;
  /** 上次看到多少行 */
  lastRowCount: number;
  /** 连续多少次没长 */
  stale: number;
};

export type ScrollRestoreSignals = {
  /** 现在这些行各自的标识(下标一一对应)。 */
  rowKeyAt?: (index: number) => string | undefined;
  /**
   * 等待期间用户自己滚过了吗。
   *
   * fz:**这是第四条放弃条件,而且它才是最该有的那条。** 恢复落地时会故意把
   * 锚点的 `scrollTop` 写成当前值好让 `userMoved` 失效 —— 那是为了让守位分支
   * 肯动手,可代价是恢复**完全不认"用户已经接管方向盘"**,而控制器其余部分
   * 处处以 `userMoved` 为最高优先级。
   *
   * 于是:打开一条正在跑的会话,页面还在加载,用户等不及自己滚到底想跟着看 ——
   * 几百毫秒后恢复到了,把他抬回上次读的地方**并且关掉跟底**,新内容在下面刷
   * 而视口不动。这比不恢复还糟。
   */
  userMoved: boolean;
};

export type ScrollRestoreStep =
  | { action: 'apply'; rowIndex: number; offset: number }
  | { action: 'wait'; next: ScrollRestoreState }
  | { action: 'giveUp' };

export function beginScrollRestore(
  sessionKey: string,
  spot: SessionReadingSpot | null | undefined,
): ScrollRestoreState | null {
  if (!sessionKey || !spot) return null;
  return { sessionKey, spot, commits: 0, lastRowCount: -1, stale: 0 };
}

/**
 * 每次 commit 走一步。
 *
 * 行是**分批**落地的(首屏 30 → 100,数据还可能在重拉),所以不能"第一次落不下去
 * 就放弃";但也不能无限等 —— 一直挂着 `followBottom = false` 会让用户回到一条
 * 正在跑的会话时**不跟底**,新内容在下面刷而视口不动,那比不恢复还糟。
 *
 * 两个刹车:总 commit 数上限,以及"行数不再增长"之后的宽限。
 */
export function stepScrollRestore(
  state: ScrollRestoreState,
  sessionKey: string,
  rowCount: number,
  signals: ScrollRestoreSignals = { userMoved: false },
): ScrollRestoreStep {
  // 串会话立刻放弃 —— 这份位置属于别人。
  if (state.sessionKey !== sessionKey) return { action: 'giveUp' };
  // 用户自己动了方向盘就放弃 —— 他现在看的地方比我们记的那个新。
  if (signals.userMoved) return { action: 'giveUp' };

  const resolved = resolveReadingSpot(state.spot, rowCount, signals.rowKeyAt);
  if (resolved) return { action: 'apply', rowIndex: resolved.rowIndex, offset: resolved.offset };

  const grew = rowCount > state.lastRowCount;
  const commits = state.commits + 1;
  const stale = grew ? 0 : state.stale + 1;
  if (commits >= MAX_RESTORE_COMMITS || stale >= MAX_RESTORE_STALE_COMMITS) {
    return { action: 'giveUp' };
  }
  return { action: 'wait', next: { ...state, commits, lastRowCount: rowCount, stale } };
}
