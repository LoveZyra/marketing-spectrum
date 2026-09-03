import { describe, expect, it } from 'vitest';

/**
 * du:分页游标与本地窗口的不变量。
 *
 * store 的 `slot.offset` 是"服务端尾部偏移"游标,而 `serverMessages` 是本地
 * 已加载窗口。`fetchFromServer` 与(修复后的)`refreshFromServer` 都必须让
 * 二者对齐;`fetchMore` 按服务端本页返回条数推进。这里把这条规则单独钉住 ——
 * 它被破坏时的症状(整页消息永久缺失)在集成测试里几乎抓不到。
 */

type Slot = { serverMessages: { id: string }[]; offset: number };

const rows = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `m${from + i}` }));

/** fetchFromServer 落地:窗口 = 本次返回,游标 = 请求 offset + 本次条数。 */
function applyFetch(slot: Slot, requestOffset: number, page: { id: string }[]): void {
  slot.serverMessages = page;
  slot.offset = requestOffset + page.length;
}

/** fetchMore 落地:老消息前插(按 id 去重),游标按**服务端返回条数**推进。 */
function applyFetchMore(slot: Slot, page: { id: string }[]): void {
  const seen = new Set(slot.serverMessages.map((m) => m.id));
  slot.serverMessages = [...page.filter((m) => !seen.has(m.id)), ...slot.serverMessages];
  slot.offset += page.length;
}

/** refreshFromServer 落地(du 修复后):窗口换成新的尾窗,游标跟着改写。 */
function applyRefresh(slot: Slot, tailWindow: { id: string }[]): void {
  slot.serverMessages = tailWindow;
  slot.offset = slot.serverMessages.length;
}

describe('分页游标不变量:offset === 已加载窗口长度', () => {
  it('首屏 → 上翻一页:游标与窗口同步', () => {
    const slot: Slot = { serverMessages: [], offset: 0 };
    applyFetch(slot, 0, rows(21, 20));          // 尾部 20 条
    expect(slot.offset).toBe(slot.serverMessages.length);
    applyFetchMore(slot, rows(1, 20));           // 再上翻 20 条
    expect(slot.offset).toBe(slot.serverMessages.length);
    expect(slot.offset).toBe(40);
  });

  it('上翻在途时回合结束刷新落地:游标必须回到尾窗长度,否则下一页跳空', () => {
    const slot: Slot = { serverMessages: [], offset: 0 };
    applyFetch(slot, 0, rows(21, 20));
    applyFetchMore(slot, rows(1, 20));           // 窗口 40、游标 40
    expect(slot.offset).toBe(40);

    // 刷新是 await 之前按 loadedCount=20 算的 limit,落地时只带回尾部 20 条。
    applyRefresh(slot, rows(21, 20));
    expect(slot.serverMessages).toHaveLength(20);
    // 修复前这里是 40:下一次「看更早」按 offset=40 取,倒数 20~40 那段被跳过。
    expect(slot.offset).toBe(20);
    expect(slot.offset).toBe(slot.serverMessages.length);

    // 接着上翻:拿回的正是刚被换掉的那一段,窗口重新长回 40,不缺行。
    applyFetchMore(slot, rows(1, 20));
    expect(slot.serverMessages.map((m) => m.id)).toEqual(rows(1, 40).map((m) => m.id));
  });
});
