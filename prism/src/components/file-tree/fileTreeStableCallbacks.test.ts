import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * 文件树传给子树的回调要引用稳定,否则 `memo(FileTreeNode)` 一条都不生效。
 *
 * `useFileTreeOperations` 返回的是每次渲染新建的对象,依赖它的 useCallback / useEffect
 * 每次渲染都会重建;所以只能依赖从里面取出的、本身是 useCallback 的函数。
 * 组件在 node 环境挂不起来,读源码钉住这两头。
 */
const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

/** 源码里作为最后一个实参的数组(hook 的依赖数组)中,不带属性访问的 `operations`。 */
const wholeObjectDeps = (source: string): string[] =>
  [...source.matchAll(/\[([^[\]]*)\],?\s*\)/g)]
    .map((match) => match[1])
    .filter((deps) => deps.split(',').some((dep) => dep.trim() === 'operations'));

describe('FileTree 的稳定回调', () => {
  const tree = read('./view/FileTree.tsx');

  it('判据能抓到依赖整个 operations 的写法', () => {
    expect(wholeObjectDeps('  }, [isInProject, operations, upload.treeRef]);')).toHaveLength(1);
    expect(wholeObjectDeps("    (path: string) => operations.handleStartCreate(path, 'file'),\n    [operations],\n  );")).toHaveLength(1);
    expect(wholeObjectDeps('  }, [operations.isCreating]);')).toEqual([]);
  });

  it('没有任何 hook 依赖整个 operations 对象', () => {
    expect(tree).toMatch(/const \{ handleStartCreate, downloadPaths, deleteItemDirectly \} = operations;/);
    expect(wholeObjectDeps(tree)).toEqual([]);
  });

  it('新建文件 / 文件夹、批量下载 / 删除、Cmd+N 都改依赖取出来的函数', () => {
    expect(tree).toMatch(/\(path: string\) => handleStartCreate\(path, 'file'\),\s*\[handleStartCreate\],/);
    expect(tree).toMatch(/\(path: string\) => handleStartCreate\(path, 'directory'\),\s*\[handleStartCreate\],/);
    expect(tree).toMatch(/\[filteredFiles, selectedPaths, downloadPaths, showToast, t, clearSelection\]/);
    expect(tree).toMatch(/\[filteredFiles, selectedPaths, deleteItemDirectly, refreshFiles, showToast, t, clearSelection\]/);
    expect(tree).toMatch(/\[isInProject, handleStartCreate, upload\.treeRef\]/);
  });

  it('取出来的三个函数在 hook 里都是 useCallback;handleStartCreate 不依赖任何东西', () => {
    const hook = read('./hooks/useFileTreeOperations.ts');
    expect(hook).toMatch(/const handleStartCreate = useCallback\(\(parentPath: string, type: 'file' \| 'directory'\) => \{[\s\S]*?\n {2}\}, \[\]\);/);
    expect(hook).toMatch(/const downloadPaths = useCallback\(/);
    expect(hook).toMatch(/const deleteItemDirectly = useCallback\(/);
  });
});
