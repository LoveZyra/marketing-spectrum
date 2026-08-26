export interface DiffLine {
  type: 'added' | 'removed';
  content: string;
  lineNum: number;
}

export type DiffCalculator = (oldStr: string, newStr: string) => DiffLine[];

/**
 * LCS 表的格子预算。超过它就不再做 O(N×M) 对齐 —— 一次 5000×5000 行的
 * Edit 会分配 2500 万个格子,主线程直接冻住几秒(diff 是在渲染路径上算的)。
 * 25 万格约等于 500×500 行的改动区,单次毫秒级。
 */
const LCS_CELL_BUDGET = 250_000;

export const calculateDiff = (oldStr: string, newStr: string): DiffLine[] => {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');

  // 真实编辑几乎总是局部的:先掐掉公共前后缀,LCS 只跑真正的改动区。
  // 这一步把常见大文件小改动的开销从 O(N×M) 压到 O(改动区²),
  // 也是让下面的预算判断只看"改了多少"而不是"文件多大"的前提。
  let prefixLength = 0;
  const maxPrefix = Math.min(oldLines.length, newLines.length);
  while (prefixLength < maxPrefix && oldLines[prefixLength] === newLines[prefixLength]) {
    prefixLength += 1;
  }
  let suffixLength = 0;
  const maxSuffix = maxPrefix - prefixLength;
  while (
    suffixLength < maxSuffix
    && oldLines[oldLines.length - 1 - suffixLength] === newLines[newLines.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  const oldCore = oldLines.slice(prefixLength, oldLines.length - suffixLength);
  const newCore = newLines.slice(prefixLength, newLines.length - suffixLength);
  const diffLines: DiffLine[] = [];

  // 改动区仍然超预算(两边各几千行都不一样):放弃逐行对齐,整段按
  // "全删 + 全增"呈现。牺牲行级对齐精度,换主线程不被冻死 —— 这种量级的
  // 改动人眼本来也不会逐行读对齐。
  if (oldCore.length * newCore.length > LCS_CELL_BUDGET) {
    for (let index = 0; index < oldCore.length; index += 1) {
      diffLines.push({ type: 'removed', content: oldCore[index], lineNum: prefixLength + index + 1 });
    }
    for (let index = 0; index < newCore.length; index += 1) {
      diffLines.push({ type: 'added', content: newCore[index], lineNum: prefixLength + index + 1 });
    }
    return diffLines;
  }

  // Use LCS alignment so insertions/deletions don't cascade into a full-file "changed" diff.
  const lcsTable: number[][] = Array.from({ length: oldCore.length + 1 }, () =>
    new Array<number>(newCore.length + 1).fill(0),
  );
  for (let oldIndex = oldCore.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newCore.length - 1; newIndex >= 0; newIndex -= 1) {
      if (oldCore[oldIndex] === newCore[newIndex]) {
        lcsTable[oldIndex][newIndex] = lcsTable[oldIndex + 1][newIndex + 1] + 1;
      } else {
        lcsTable[oldIndex][newIndex] = Math.max(
          lcsTable[oldIndex + 1][newIndex],
          lcsTable[oldIndex][newIndex + 1],
        );
      }
    }
  }

  let oldIndex = 0;
  let newIndex = 0;

  while (oldIndex < oldCore.length && newIndex < newCore.length) {
    const oldLine = oldCore[oldIndex];
    const newLine = newCore[newIndex];

    if (oldLine === newLine) {
      oldIndex += 1;
      newIndex += 1;
      continue;
    }

    if (lcsTable[oldIndex + 1][newIndex] >= lcsTable[oldIndex][newIndex + 1]) {
      diffLines.push({ type: 'removed', content: oldLine, lineNum: prefixLength + oldIndex + 1 });
      oldIndex += 1;
      continue;
    }

    diffLines.push({ type: 'added', content: newLine, lineNum: prefixLength + newIndex + 1 });
    newIndex += 1;
  }

  while (oldIndex < oldCore.length) {
    diffLines.push({ type: 'removed', content: oldCore[oldIndex], lineNum: prefixLength + oldIndex + 1 });
    oldIndex += 1;
  }

  while (newIndex < newCore.length) {
    diffLines.push({ type: 'added', content: newCore[newIndex], lineNum: prefixLength + newIndex + 1 });
    newIndex += 1;
  }

  return diffLines;
};

export const createCachedDiffCalculator = (): DiffCalculator => {
  const cache = new Map<string, DiffLine[]>();

  return (oldStr: string, newStr: string) => {
    const key = JSON.stringify([oldStr, newStr]);
    const cached = cache.get(key);
    if (cached) {
      return cached;
    }

    const calculated = calculateDiff(oldStr, newStr);
    cache.set(key, calculated);
    if (cache.size > 100) {
      const firstKey = cache.keys().next().value;
      if (firstKey) {
        cache.delete(firstKey);
      }
    }
    return calculated;
  };
};
