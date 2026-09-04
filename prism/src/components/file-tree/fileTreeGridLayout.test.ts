import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * eo:表格视图那一行是 `grid grid-cols-12`,**列宽之和必须正好 12,而且行里
 * 不许有第 5 个网格子项**。
 *
 * 用户实测报的就是这个:进多选之后复选框作为兄弟节点插在四格前面 → 一行 5 个
 * 子项 → 最后那格「权限」被挤到第二行,整张表看着像散了。修法是把复选框放进
 * 「名称」那一格里面。
 *
 * 为什么用读源码的方式钉:客户端测试跑在 node 环境(没有 jsdom),渲染不出来;
 * 而这条约束一旦破掉,**类型检查和现有测试全都是绿的**,只有人打开页面才看得见。
 * 所以宁可用一个笨办法钉住,也好过下次改这一行时再踩一遍。
 */
const source = readFileSync(
  fileURLToPath(new URL('./view/FileTreeNode.tsx', import.meta.url)),
  'utf8',
);

/** detailed 分支的正文:从 `viewMode === 'detailed' ? (` 到下一个 `) : viewMode ===`。 */
const detailedBranch = (() => {
  const start = source.indexOf("{viewMode === 'detailed' ? (");
  const end = source.indexOf(") : viewMode === 'compact' ?", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
})();

describe('文件树表格视图的网格', () => {
  it('表头和行用同一套 12 列', () => {
    const header = readFileSync(
      fileURLToPath(new URL('./view/FileTreeDetailedColumns.tsx', import.meta.url)),
      'utf8',
    );
    expect(header).toContain('grid-cols-12');
    expect(source).toContain('grid grid-cols-12');
  });

  it('四格列宽加起来正好 12(5+2+3+2)', () => {
    const spans = [...detailedBranch.matchAll(/col-span-(\d+)/g)].map((m) => Number(m[1]));
    expect(spans).toEqual([5, 2, 3, 2]);
    expect(spans.reduce((sum, value) => sum + value, 0)).toBe(12);
  });

  it('复选框长在「名称」那一格里面,不是并排的第 5 个子项', () => {
    const nameCell = detailedBranch.slice(
      detailedBranch.indexOf('col-span-5'),
      detailedBranch.indexOf('col-span-2'),
    );
    expect(nameCell).toContain('type="checkbox"');
  });

  it('行首那个复选框显式排除了 detailed —— 少了这个守卫就又是 5 个子项', () => {
    expect(source).toContain("selectionMode && onToggleSelect && viewMode !== 'detailed'");
  });
});
