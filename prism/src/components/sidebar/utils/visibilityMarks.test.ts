import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { planVisibilityMarks } from './visibilityMarks';

const plan = (over: Partial<Parameters<typeof planVisibilityMarks>[0]> = {}) =>
  planVisibilityMarks({
    isPublic: false,
    isRootOnly: false,
    isSharedToViewer: false,
    sharedOutCount: 0,
    ...over,
  });

/**
 * 这组用例钉的是同一条规则:**只画当前实际生效的那个最宽可见范围**。
 *
 * 反面教材有两个,都是"每个判断单看都为真,合起来才是错的":
 * 锁 + 已共享、地球 + 已共享。所以下面刻意把"更宽的范围成立时,更窄的一个都不画"
 * 逐条写出来。
 */
describe('项目行的可见性图标 —— 只画最宽的那一档', () => {
  test('公共项目:只画地球。已共享给几个人一概不显示 —— 所有人本来就能看', () => {
    assert.deepEqual(plan({ isPublic: true }), ['public']);
    assert.deepEqual(plan({ isPublic: true, sharedOutCount: 2 }), ['public']);
    // 公共 + 无主(公共项目本来就是无主的)也不该冒出锁
    assert.deepEqual(plan({ isPublic: true, isRootOnly: true, sharedOutCount: 3 }), ['public']);
  });

  test('非公共、已共享:只画共享标 —— 锁不再成立,那 N 个人看得见它', () => {
    assert.deepEqual(plan({ isRootOnly: true, sharedOutCount: 1 }), ['sharedOut']);
    assert.deepEqual(plan({ isRootOnly: true, sharedOutCount: 9 }), ['sharedOut']);
  });

  test('无主、没共享出去:一把「仅 root」的锁', () => {
    assert.deepEqual(plan({ isRootOnly: true }), ['rootOnly']);
  });

  test('有主、没共享:一个图标都不画 —— 那是最常见的状态,不该有噪声', () => {
    assert.deepEqual(plan(), []);
  });

  test('「他人共享给你」是另一个维度,和范围标并存', () => {
    // 它回答的是"这个项目是谁给你的",不是"谁能看见"
    assert.deepEqual(plan({ isSharedToViewer: true }), ['shared']);
    assert.deepEqual(plan({ isPublic: true, isSharedToViewer: true }), ['public', 'shared']);
  });
});
