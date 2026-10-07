import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { summarizeArchivedBulkShortfall } from './archivedBulkReceipt';

/**
 * 批量恢复 / 永久删除归档会话:实际处理的条数少于选中的条数时,要让用户看见。
 *
 * 服务端逐条鉴权,看不见或无权操作的静默跳过,出错的不中断其余。只写 console 的话,
 * 用户以为全成了,少掉的那几条既不知道,也不知道该不该重试。
 */
describe('summarizeArchivedBulkShortfall', () => {
  it('全部处理了:没有缺口', () => {
    expect(summarizeArchivedBulkShortfall(3, { succeeded: ['a', 'b', 'c'], skipped: [], failed: [] })).toBeNull();
  });

  it('有跳过、有出错:分开计数', () => {
    expect(summarizeArchivedBulkShortfall(5, { succeeded: ['a', 'b'], skipped: ['c'], failed: ['d', 'e'] }))
      .toEqual({ requested: 5, done: 2, skipped: 1, failed: 2 });
  });

  it('回执里没有 skipped / failed:差额都算出错', () => {
    expect(summarizeArchivedBulkShortfall(4, { succeeded: ['a'] })).toEqual({ requested: 4, done: 1, skipped: 0, failed: 3 });
  });

  it('回执缺失:一条都没算处理', () => {
    expect(summarizeArchivedBulkShortfall(2, undefined)).toEqual({ requested: 2, done: 0, skipped: 0, failed: 2 });
  });
});

describe('侧栏批量归档操作接线', () => {
  const controller = readFileSync(fileURLToPath(new URL('../hooks/useSidebarController.ts', import.meta.url)), 'utf8');

  it('缺口用看得见的提示说出来,不再只写 console', () => {
    expect(controller).toMatch(/const shortfall = summarizeArchivedBulkShortfall\(ids\.length, payload\.data\);/);
    expect(controller).toMatch(/t\('messages\.bulkDeleteShortfall', \{/);
    expect(controller).toMatch(/t\('messages\.bulkRestoreShortfall', \{/);
    expect(controller).toMatch(/variant: shortfall\.failed > 0 \? 'error' : 'default',/);
    expect(controller).not.toMatch(/console\.warn\(`\[Sidebar\] 批量/);
  });
});
