import { describe, expect, it } from 'vitest';

import { describeBulkResult, type BulkProjectResult } from './useProjectBulkSelection';

/**
 * eo:批量结果的**如实播报**。
 *
 * 服务端逐条鉴权,不是自己的项目会被静默跳过。用户选了 12 个、实际只动了 5 个,
 * 却看到一句「操作成功」—— 这比直接报错更糟:他会以为都改好了,过几天才发现
 * 有一半没改,而那时已经没人记得当时选了哪些。所以这个函数只有一条规矩:
 * **没有全成就必须把数字说出来。**
 */
const result = (patch: Partial<BulkProjectResult>): BulkProjectResult => ({
  requested: 0, succeeded: [], skipped: [], failed: [], ...patch,
});

describe('describeBulkResult', () => {
  it('全成功:一句话,不啰嗦', () => {
    expect(describeBulkResult(result({ requested: 3, succeeded: ['a', 'b', 'c'] }), '归档'))
      .toBe('归档了 3 个项目');
  });

  it('有跳过:把"请求多少、成了多少、跳过多少"都说出来', () => {
    const text = describeBulkResult(result({
      requested: 3,
      succeeded: ['a'],
      skipped: [{ projectId: 'b', reason: 'not-visible' }, { projectId: 'c', reason: 'not-visible' }],
    }), '归档');
    expect(text).toContain('请求 3 个');
    expect(text).toContain('归档了 1 个');
    expect(text).toContain('2 个跳过');
  });

  it('跳过原因是"管不了"时要点破 —— 否则用户以为是 bug', () => {
    const text = describeBulkResult(result({
      requested: 2,
      succeeded: ['a'],
      skipped: [{ projectId: 'b', reason: 'not-manageable' }],
    }), '改了权限的');
    expect(text).toMatch(/不是你的项目/);
    expect(text).toMatch(/所有者或 root/);
  });

  it('有失败:带上第一条原因,别让人对着"失败了"猜', () => {
    const text = describeBulkResult(result({
      requested: 2,
      succeeded: ['a'],
      failed: [{ projectId: 'b', reason: 'EACCES: permission denied' }],
    }), '删除');
    expect(text).toContain('1 个失败');
    expect(text).toContain('EACCES: permission denied');
  });

  it('一个都没成:仍然报出请求数,不能只说"失败"', () => {
    const text = describeBulkResult(result({
      requested: 4,
      skipped: [
        { projectId: 'a', reason: 'not-manageable' }, { projectId: 'b', reason: 'not-manageable' },
        { projectId: 'c', reason: 'not-manageable' }, { projectId: 'd', reason: 'not-manageable' },
      ],
    }), '改了权限的');
    expect(text).toContain('请求 4 个');
    expect(text).toContain('0 个');
  });
});
