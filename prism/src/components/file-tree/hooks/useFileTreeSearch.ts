import { useMemo, useState } from 'react';

import { collectExpandedDirectoryPaths, filterFileTree } from '../utils/fileTreeUtils';
import type { FileTreeNode } from '../types/types';

type UseFileTreeSearchArgs = {
  files: FileTreeNode[];
};

type UseFileTreeSearchResult = {
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  filteredFiles: FileTreeNode[];
  /**
   * 搜索期间临时要展开的目录集合(命中项的全部祖先)。
   *
   * 是派生值,不写进用户的展开状态:消费方渲染时把它与用户自己的展开集合做并集,
   * 查询一清空这个集合就归空,树回到用户之前折叠的样子。
   */
  searchExpandedPaths: Set<string>;
};

export function useFileTreeSearch({ files }: UseFileTreeSearchArgs): UseFileTreeSearchResult {
  const [searchQuery, setSearchQuery] = useState('');

  const { filteredFiles, searchExpandedPaths } = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) {
      return { filteredFiles: files, searchExpandedPaths: new Set<string>() };
    }
    const filtered = filterFileTree(files, query);
    return {
      filteredFiles: filtered,
      searchExpandedPaths: new Set(collectExpandedDirectoryPaths(filtered)),
    };
  }, [files, searchQuery]);

  return {
    searchQuery,
    setSearchQuery,
    filteredFiles,
    searchExpandedPaths,
  };
}
