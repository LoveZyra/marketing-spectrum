import { describe, expect, it } from 'vitest';

import {
  EMPTY_WINDOW_MEMORY,
  MAX_REMEMBERED_WINDOWS,
  forgetSessionWindow,
  recallSessionWindow,
  rememberSessionWindow,
  type SessionWindowMemory,
} from './messageWindow';

const PHASE1 = 30;

describe('rememberSessionWindow', () => {
  it('记一条、读回来', () => {
    const memory = rememberSessionWindow(EMPTY_WINDOW_MEMORY, 'A', { visibleCount: 400, allLoaded: true });
    expect(memory.get('A')).toEqual({ visibleCount: 400, allLoaded: true });
  });

  it('不改原来那份(纯函数)', () => {
    const before: SessionWindowMemory = new Map([['A', { visibleCount: 30, allLoaded: false }]]);
    const after = rememberSessionWindow(before, 'A', { visibleCount: 400, allLoaded: true });
    expect(before.get('A')).toEqual({ visibleCount: 30, allLoaded: false });
    expect(after.get('A')?.visibleCount).toBe(400);
  });

  it('空 key 不记', () => {
    expect(rememberSessionWindow(EMPTY_WINDOW_MEMORY, '', { visibleCount: 1, allLoaded: false }).size).toBe(0);
  });

  it('超上限丢最久没碰的那条', () => {
    let memory: SessionWindowMemory = EMPTY_WINDOW_MEMORY;
    for (let i = 0; i < MAX_REMEMBERED_WINDOWS + 5; i += 1) {
      memory = rememberSessionWindow(memory, `s${i}`, { visibleCount: 30 + i, allLoaded: false });
    }
    expect(memory.size).toBe(MAX_REMEMBERED_WINDOWS);
    expect(memory.has('s0')).toBe(false);
    expect(memory.has(`s${MAX_REMEMBERED_WINDOWS + 4}`)).toBe(true);
  });

  it('**重复记同一条要排到队尾**,否则淘汰的是刚看过的那条', () => {
    let memory: SessionWindowMemory = EMPTY_WINDOW_MEMORY;
    for (let i = 0; i < MAX_REMEMBERED_WINDOWS; i += 1) {
      memory = rememberSessionWindow(memory, `s${i}`, { visibleCount: 30, allLoaded: false });
    }
    // 又回到 s0 看了一眼,再离开
    memory = rememberSessionWindow(memory, 's0', { visibleCount: 200, allLoaded: false });
    // 再来一条新的把上限顶掉
    memory = rememberSessionWindow(memory, 'new', { visibleCount: 30, allLoaded: false });
    expect(memory.has('s0')).toBe(true);   // 刚看过的还在
    expect(memory.has('s1')).toBe(false);  // 被淘汰的是真正最久没碰的
  });

  it('forget 只动目标那条;没有就原样返回', () => {
    const memory = rememberSessionWindow(EMPTY_WINDOW_MEMORY, 'A', { visibleCount: 90, allLoaded: false });
    expect(forgetSessionWindow(memory, 'A').has('A')).toBe(false);
    expect(forgetSessionWindow(memory, 'B')).toBe(memory);
  });
});

/**
 * **两条不变式,任何一条破了都会把分页搞死。**
 *
 * 1. `allLoaded` 只在"手里现在还是全量"时才恢复 —— 它为真会让
 *    `loadOlderMessages` / 自动补页 / 「看更早」全部直接 return;
 *    照记忆无脑恢复 = 把「看更早」永久按死,而且看不出为什么。
 * 2. 窗口不能比手里的条数还大 —— 大了会让"首屏第二帧放大"那个 effect 短路
 *    (`chatMessages.length <= visibleMessageCount`),窗口卡在虚高的数上不再生长。
 */
describe('recallSessionWindow', () => {
  it('第一次看这条会话 → 走首屏两段式', () => {
    expect(recallSessionWindow({ memo: undefined, loadedCount: 0, hasMore: true, total: 0, phase1: PHASE1 }))
      .toEqual({ visibleCount: PHASE1, allLoaded: false });
  });

  it('回到全量还在手里的会话 → 窗口与 allLoaded 都恢复', () => {
    expect(recallSessionWindow({
      memo: { visibleCount: 400, allLoaded: true },
      loadedCount: 500, hasMore: false, total: 500, phase1: PHASE1,
    })).toEqual({ visibleCount: 400, allLoaded: true });
  });

  it('**手里已经不是全量了 → allLoaded 必须降级**(否则「看更早」永久失效)', () => {
    // 期间槽位被淘汰/过期,回来只重新拉了首页 20 条
    expect(recallSessionWindow({
      memo: { visibleCount: 400, allLoaded: true },
      loadedCount: 20, hasMore: true, total: 500, phase1: PHASE1,
    })).toEqual({ visibleCount: PHASE1, allLoaded: false });
  });

  it('hasMore=false 但条数不够 total → 仍然降级', () => {
    expect(recallSessionWindow({
      memo: { visibleCount: 400, allLoaded: true },
      loadedCount: 20, hasMore: false, total: 500, phase1: PHASE1,
    }).allLoaded).toBe(false);
  });

  it('服务端没给 total(0)→ 只认 hasMore', () => {
    expect(recallSessionWindow({
      memo: { visibleCount: 400, allLoaded: true },
      loadedCount: 20, hasMore: false, total: 0, phase1: PHASE1,
    }).allLoaded).toBe(true);
    expect(recallSessionWindow({
      memo: { visibleCount: 400, allLoaded: true },
      loadedCount: 20, hasMore: true, total: 0, phase1: PHASE1,
    }).allLoaded).toBe(false);
  });

  it('记忆里本来就不是全量 → 手里再全也不擅自置真', () => {
    expect(recallSessionWindow({
      memo: { visibleCount: 200, allLoaded: false },
      loadedCount: 500, hasMore: false, total: 500, phase1: PHASE1,
    }).allLoaded).toBe(false);
  });

  it('**窗口不能超过手里的条数**', () => {
    expect(recallSessionWindow({
      memo: { visibleCount: 400, allLoaded: false },
      loadedCount: 120, hasMore: true, total: 500, phase1: PHASE1,
    }).visibleCount).toBe(120);
  });

  it('窗口也不能小于首屏第一段', () => {
    expect(recallSessionWindow({
      memo: { visibleCount: 5, allLoaded: false },
      loadedCount: 500, hasMore: false, total: 500, phase1: PHASE1,
    }).visibleCount).toBe(PHASE1);
    // 手里比首屏还少时,上限抬到 phase1(窗口比数据大是无害的,反过来会卡住生长)
    expect(recallSessionWindow({
      memo: { visibleCount: 400, allLoaded: false },
      loadedCount: 3, hasMore: false, total: 3, phase1: PHASE1,
    }).visibleCount).toBe(PHASE1);
  });

  it('Infinity 之类的脏值不往外传', () => {
    const recalled = recallSessionWindow({
      memo: { visibleCount: Number.POSITIVE_INFINITY, allLoaded: false },
      loadedCount: 240, hasMore: false, total: 240, phase1: PHASE1,
    });
    expect(Number.isFinite(recalled.visibleCount)).toBe(true);
    expect(recalled.visibleCount).toBe(240);
  });

  it('端到端:A 里加载全部 → 切到 B → 切回 A,窗口原样回来', () => {
    let memory: SessionWindowMemory = EMPTY_WINDOW_MEMORY;
    // 在 A 里点了「加载全部」又翻了几批
    memory = rememberSessionWindow(memory, 'A', { visibleCount: 600, allLoaded: true });
    // 去 B 看了一眼再回来,A 的槽位还在
    const recalled = recallSessionWindow({
      memo: memory.get('A'), loadedCount: 640, hasMore: false, total: 640, phase1: PHASE1,
    });
    expect(recalled).toEqual({ visibleCount: 600, allLoaded: true });
  });
});


/**
 * fz:**槽位马上要被换掉的话,它现在说什么都不算数。**
 *
 * 调用点原来喂的是**重拉之前**的槽位 —— `recallSessionWindow` 的不变式本身
 * 是对的,但输入是过期的。回到一条放置过久的长会话:`allLoaded` 按旧槽位恢复
 * 成 true,紧接着重拉把正文换成尾部 20 条、`hasMore` 变回 true。两条横幅互斥,
 * 同时消失;`loadOlderMessages` / 自动补页 / 「加载全部」浮层又全在
 * `if (allMessagesLoadedRef.current) return` 上退出 —— 内容取不回来,
 * 屏幕上一个入口都没有。
 */
describe('过期槽位不能作数(调用点把 hasMore 喂成 true)', () => {
  it('要重拉时 → allLoaded 一律降级', () => {
    const memo = { visibleCount: 600, allLoaded: true };
    // willReuseSlot 为 false 时调用点传的就是 hasMore: true
    expect(recallSessionWindow({ memo, loadedCount: 5000, hasMore: true, total: 5000, phase1: 30 }).allLoaded)
      .toBe(false);
  });

  it('复用槽位时 → 照常恢复', () => {
    const memo = { visibleCount: 600, allLoaded: true };
    expect(recallSessionWindow({ memo, loadedCount: 5000, hasMore: false, total: 5000, phase1: 30 }).allLoaded)
      .toBe(true);
  });
});
