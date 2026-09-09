import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { shouldKeepOrphanedSessionView } from './sessionViewGuard';

/**
 * fi:线上截图 —— 用户在一条**正在跑**的会话上不断切换,切到「新会话」页面之后,
 * 标题是新会话,正文却挂着那条会话的内容,而且随它的流式持续更新;F5 才消失,
 * root 新开页面看不到。
 *
 * 病根是 `selectedSession` 为空时的例外分支:原来只要 `currentSessionId` 指的会话
 * 还在跑就不清它。这条例外本意是保护"新会话页上刚建立、路由还没跟上"的那条,
 * 但判据是**在不在跑**而不是**从哪来的**,于是从别的会话切走也被它挡住了。
 */
describe('selectedSession 为空时,正文还能不能用 currentSessionId 撑着', () => {
  test('本视图刚建立的 + 正在跑 → 保留(这是例外存在的理由)', () => {
    assert.equal(shouldKeepOrphanedSessionView({
      currentSessionId: 'N', establishedHere: 'N', isProcessing: true,
    }), true);
  });

  test('⚠️ 从别的会话切走留下的 + 正在跑 → 必须清(线上那个 bug)', () => {
    /*
     * 这正是截图里的组合:A 在跑,用户点了项目行 / 切了项目,
     * selectedSession 变空但 currentSessionId 还是 A。
     * 原来的判据在这里返回 true —— A 的正文就被钉在新会话页面上了。
     */
    assert.equal(shouldKeepOrphanedSessionView({
      currentSessionId: 'A', establishedHere: null, isProcessing: true,
    }), false, '不是本视图建立的 id,哪怕在跑也不能撑着正文');
  });

  test('本视图建立的但已经不跑了 → 清(和原来一致)', () => {
    assert.equal(shouldKeepOrphanedSessionView({
      currentSessionId: 'N', establishedHere: 'N', isProcessing: false,
    }), false);
  });

  test('建立标记指向另一条会话 → 清', () => {
    // establishedHere 是上一条新会话留下的旧标记,currentSessionId 已经换了
    assert.equal(shouldKeepOrphanedSessionView({
      currentSessionId: 'A', establishedHere: 'N', isProcessing: true,
    }), false);
  });

  test('没有 currentSessionId → 无所谓,清', () => {
    assert.equal(shouldKeepOrphanedSessionView({
      currentSessionId: null, establishedHere: null, isProcessing: false,
    }), false);
  });
});
