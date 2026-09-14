import { describe, expect, it } from 'vitest';

import {
  PROGRAMMATIC_SCROLL_TOLERANCE_PX,
  beginScrollRestore,
  isUserInitiatedScroll,
  stepScrollRestore,
  type ScrollRestoreState,
} from './messageWindow';

/**
 * ga(回归):**位置恢复被控制器自己的跟底写掐死。**
 *
 * fz 给 `stepScrollRestore` 加了第四条放弃条件"等待期间用户滚过了就让位",
 * 理由写的是「恢复期间我们一个 scrollTop 都不写,所以不会有程序化滚动混进来」。
 * 那句话是错的:恢复挂在 `wait` 上时 `followBottom` 仍是 true,控制器每次
 * commit 都在写 `scrollTop = scrollHeight`,浏览器随之派发 scroll,
 * `handleScroll` 把"用户滚过了"置真 —— 下一次 commit 直接放弃。
 * **只要恢复需要等超过一帧,就必然被自己掐死。**
 *
 * 上一轮的教训是"手搓一个字面量喂给纯函数不算证明"。所以这里不单测判据,
 * 而是把**控制器 + 滚动事件这一对**照真实顺序跑一遍:
 *
 *   commit → stepScrollRestore → (wait) → 跟底写 scrollTop → 派发 scroll
 *   → handleScroll 决定 userMoved → 下一次 commit …
 *
 * `simulate` 就是这条循环的骨架,两个写点都按真实代码那样"写完读回来记账"。
 * 把 `isUserInitiatedScroll` 换回 fz 那条"有事件就算用户滚的",第一个用例
 * 立刻红 —— 这才是这条修复的反证。
 */

type FakeContainer = {
  scrollTop: number;
  /** 浏览器会把 scrollTop 夹到 [0, scrollHeight - clientHeight]。 */
  readonly maxScrollTop: number;
};

function makeContainer(maxScrollTop: number, scrollTop = 0): FakeContainer {
  let value = scrollTop;
  return {
    get scrollTop() { return value; },
    set scrollTop(next: number) { value = Math.max(0, Math.min(maxScrollTop, next)); },
    maxScrollTop,
  };
}

type SimulateOptions = {
  /** 每次 commit 时 DOM 里有几行(按 commit 顺序,模拟"行分批落地")。 */
  rowCounts: number[];
  /** 恢复目标那一行的标识;不在这一批行里就落不下去,只能等。 */
  spotRowKey: string;
  /** 每次 commit 时这些行的标识。 */
  rowKeysAt: string[][];
  /** 用户在第几次 commit **之后**自己滚了一下(0 起),-1 = 从不。 */
  userScrollsAfterCommit?: number;
  /** 判断"这一下是谁滚的"用的函数 —— 反证时可以换成 fz 那个版本。 */
  decideUserScrolled?: (scrollTop: number, lastProgrammatic: number | null) => boolean;
};

type SimulateResult = {
  outcome: 'applied' | 'gaveUp' | 'stillWaiting';
  appliedAtCommit: number;
  appliedRowIndex: number;
  /** 落地时视口在哪儿 —— 用来验证"真的守住了位置,不是停在底部"。 */
  finalScrollTop: number;
};

function simulate(options: SimulateOptions): SimulateResult {
  const {
    rowCounts,
    spotRowKey,
    rowKeysAt,
    userScrollsAfterCommit = -1,
    decideUserScrolled = isUserInitiatedScroll,
  } = options;

  const container = makeContainer(4300);
  // 换会话那一帧:武装恢复、followBottom 置真(useChatSessionState 的重置 effect)。
  let restore: ScrollRestoreState | null = beginScrollRestore('S:P', { rowKey: spotRowKey, indexFromEnd: 7, offset: -40 });
  let followBottom = true;
  let userMoved = false;
  /** 控制器自己最后写进去的那个值(写完读回来)。null = 还没写过。 */
  let lastProgrammatic: number | null = null;
  let anchorRowIndex = -1;

  /** 浏览器派发一次 scroll —— handleScroll 那一段。 */
  const dispatchScroll = () => {
    if (restore && decideUserScrolled(container.scrollTop, lastProgrammatic)) userMoved = true;
  };

  for (let commit = 0; commit < rowCounts.length; commit += 1) {
    const rowCount = rowCounts[commit];
    const keys = rowKeysAt[commit] ?? [];

    if (restore) {
      const step = stepScrollRestore(restore, 'S:P', rowCount, {
        userMoved,
        rowKeyAt: (index) => keys[index],
      });
      if (step.action === 'apply') {
        anchorRowIndex = step.rowIndex;
        followBottom = false;
        restore = null;
        // 守位:把锚点行校回它原来的偏移(这里用"行高 100px"的假布局)。
        container.scrollTop = anchorRowIndex * 100 - step.offset;
        lastProgrammatic = container.scrollTop;
        dispatchScroll();
        return {
          outcome: 'applied',
          appliedAtCommit: commit,
          appliedRowIndex: anchorRowIndex,
          finalScrollTop: container.scrollTop,
        };
      }
      if (step.action === 'giveUp') {
        restore = null;
        return { outcome: 'gaveUp', appliedAtCommit: -1, appliedRowIndex: -1, finalScrollTop: container.scrollTop };
      }
      restore = step.next;
    }

    // 等待期间控制器照常跟底 —— 这一句就是掐死恢复的那一句。
    if (followBottom && rowCount > 0) {
      container.scrollTop = container.maxScrollTop;
      lastProgrammatic = container.scrollTop;
      dispatchScroll();
    }

    if (commit === userScrollsAfterCommit) {
      // 用户自己滚:落点与我们写进去的那个值不一样。
      container.scrollTop = 1200;
      dispatchScroll();
    }
  }

  return { outcome: 'stillWaiting', appliedAtCommit: -1, appliedRowIndex: -1, finalScrollTop: container.scrollTop };
}

/** 前三次 commit 行数是 30 / 100 / 212(首屏分批落地),目标行只在第三批里。 */
const STAGED_ROWS = [30, 100, 212];
const STAGED_KEYS = [
  Array.from({ length: 30 }, (_, i) => `row-${i + 182}`),
  Array.from({ length: 100 }, (_, i) => `row-${i + 112}`),
  Array.from({ length: 212 }, (_, i) => `row-${i}`),
];

describe('位置恢复 × 控制器跟底写(真实顺序)', () => {
  it('目标行第三批才落地:恢复照样成立,不被自己的跟底写掐死', () => {
    const result = simulate({ rowCounts: STAGED_ROWS, spotRowKey: 'row-40', rowKeysAt: STAGED_KEYS });
    expect(result.outcome).toBe('applied');
    expect(result.appliedAtCommit).toBe(2);
    expect(result.appliedRowIndex).toBe(40);
    // 真的守住了位置,而不是停在底部
    expect(result.finalScrollTop).toBe(40 * 100 + 40);
    expect(result.finalScrollTop).not.toBe(4300);
  });

  it('反证:换回 fz 那条"有滚动事件就算用户滚的",同一条路立刻放弃', () => {
    const result = simulate({
      rowCounts: STAGED_ROWS,
      spotRowKey: 'row-40',
      rowKeysAt: STAGED_KEYS,
      decideUserScrolled: () => true,
    });
    expect(result.outcome).toBe('gaveUp');
  });

  it('用户在等待期间真的自己滚了 → 还是要让位(第四条放弃条件没被削掉)', () => {
    const result = simulate({
      rowCounts: STAGED_ROWS,
      spotRowKey: 'row-40',
      rowKeysAt: STAGED_KEYS,
      userScrollsAfterCommit: 0,
    });
    expect(result.outcome).toBe('gaveUp');
  });

  it('目标行一直没落地 → 按宽限放弃(两个刹车都还在)', () => {
    const rowCounts = Array.from({ length: 30 }, () => 100);
    const rowKeysAt = rowCounts.map(() => Array.from({ length: 100 }, (_, i) => `row-${i + 112}`));
    const result = simulate({ rowCounts, spotRowKey: 'row-40', rowKeysAt });
    expect(result.outcome).toBe('gaveUp');
  });
});

describe('isUserInitiatedScroll', () => {
  it('还没写过任何一下 → 任何滚动都是用户的', () => {
    expect(isUserInitiatedScroll(0, null)).toBe(true);
    expect(isUserInitiatedScroll(4300, null)).toBe(true);
  });

  it('落点与写进去的值一致(含亚像素余量)→ 是我们自己写的', () => {
    expect(isUserInitiatedScroll(4300, 4300)).toBe(false);
    expect(isUserInitiatedScroll(4300 + PROGRAMMATIC_SCROLL_TOLERANCE_PX, 4300)).toBe(false);
    expect(isUserInitiatedScroll(4300 - PROGRAMMATIC_SCROLL_TOLERANCE_PX, 4300)).toBe(false);
  });

  it('落点差得更多 → 用户滚的', () => {
    expect(isUserInitiatedScroll(4300 + PROGRAMMATIC_SCROLL_TOLERANCE_PX + 1, 4300)).toBe(true);
    expect(isUserInitiatedScroll(1200, 4300)).toBe(true);
  });
});
