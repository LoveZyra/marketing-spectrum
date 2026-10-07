import type { FileTreeNode } from '../types/types';

/**
 * 上传前查同名。`relativePaths` 是文件相对目标目录的路径(文件夹上传带子目录),
 * `targetPath` 是目标目录的绝对路径('' = 项目根)。返回会被覆盖的相对路径。
 * 只看树里已加载的部分:没列到的目录查不出来,那部分由服务端返回的 `overwritten` 兜底。
 */
export function findExistingUploadTargets(
  nodes: FileTreeNode[],
  projectRoot: string | null,
  relativePaths: string[],
  targetPath: string,
): string[] {
  const base = (targetPath || projectRoot || '').replace(/\/+$/, '');
  if (!base) return [];
  const known = new Set<string>();
  const walk = (list: FileTreeNode[]) => {
    for (const node of list) {
      known.add(node.path);
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return relativePaths.filter((relative) => known.has(`${base}/${relative.replace(/^\/+/, '')}`));
}
