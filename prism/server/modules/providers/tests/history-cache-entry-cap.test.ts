import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { FetchHistoryCache } from '@/modules/providers/list/claude/history-cache.js';

const entry = (n: number) => ({
  messages: Array.from({ length: n }, (_, i) => ({ id: `m${i}` })) as never,
  total: n,
});

/**
 * 单条目上限。
 *
 * 存在的理由:预算原本只有一道总闸,于是一个超大会话能独占绝大部分额度,把其他
 * 所有人的条目挤出去 —— 单人使用看不出来,多用户下就是"某个人打开了长会话,
 * 其余人的历史集体变冷"。
 */
describe('history 缓存的单条目上限', () => {
  test('超过单条目上限的会话不进缓存,也不驱逐已有条目', () => {
    const cache = new FetchHistoryCache({ maxBytes: 1000, maxEntryBytes: 250 });
    cache.set('small', 'fp1', 200, entry(2));

    cache.set('huge', 'fp2', 900, entry(2));

    assert.equal(cache.get('huge', 'fp2'), null, '超限条目不该被缓存');
    assert.ok(cache.get('small', 'fp1'), '已有的小条目不该被它挤掉');
  });

  test('不传 maxEntryBytes 时保持旧契约:只受总预算约束', () => {
    // 默认必须保持宽松 —— 单条目上限是部署策略,不是这个类的固有语义。
    // 生产实例在 claude-sessions.provider.ts 里显式设成总预算的 1/4。
    const cache = new FetchHistoryCache({ maxBytes: 400 });
    cache.set('big', 'fp', 399, entry(1));
    assert.ok(cache.get('big', 'fp'), '不设单条目上限时,只要装得下就该缓存');
  });

  test('总预算仍然生效:多个合规条目累加超预算时驱逐最旧的', () => {
    const cache = new FetchHistoryCache({ maxBytes: 400, maxEntryBytes: 200 });
    cache.set('a', 'fp', 150, entry(1));
    cache.set('b', 'fp', 150, entry(1));
    cache.set('c', 'fp', 150, entry(1));

    assert.equal(cache.get('a', 'fp'), null, '最旧的应当被驱逐');
    assert.ok(cache.get('c', 'fp'));
  });
});
