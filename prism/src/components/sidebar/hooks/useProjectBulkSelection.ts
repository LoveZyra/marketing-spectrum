import { useCallback, useMemo, useState } from 'react';

import { api } from '../../../utils/api';

/**
 * 项目多选与批量操作(eo)。
 *
 * ## 为什么是「显式进入多选」而不是常驻复选框
 *
 * 项目行的默认动作是**选中并展开**。把点击悄悄改成"选中",人就会在想打开项目
 * 的时候勾上一堆,然后在工具条上点了删除 —— 文件树那边的注释早就写过这条
 * (「默认动作是打开文件,把它偷偷改成选中会让人删错东西」)。何况侧栏内宽
 * 只有 ~210px,常驻一个复选框会再挤掉项目名 16px。
 *
 * ## 为什么结果要逐条对账
 *
 * 服务端逐条鉴权,看不见的、管不了的会被静默跳过。前端如果只显示"操作成功",
 * 用户会以为 12 个都改了,实际只改了 5 个。所以这里把 succeeded / skipped /
 * failed 原样带回去,由调用方说人话。
 */

export type BulkProjectAction = 'archive' | 'delete' | 'star' | 'unstar' | 'permissions' | 'owner';

export interface BulkProjectResult {
  requested: number;
  succeeded: string[];
  skipped: Array<{ projectId: string; reason: string }>;
  failed: Array<{ projectId: string; reason: string }>;
}

export interface ProjectBulkSelection {
  selectionMode: boolean;
  selectedIds: ReadonlySet<string>;
  selectedCount: number;
  isBusy: boolean;
  enterSelectionMode: () => void;
  exitSelectionMode: () => void;
  toggleSelectionMode: () => void;
  toggleSelection: (projectId: string) => void;
  selectMany: (projectIds: string[]) => void;
  clearSelection: () => void;
  /** 跑一次批量操作。返回结果供调用方对账;网络层出错返回 null。 */
  runAction: (action: BulkProjectAction, extra?: Record<string, unknown>) => Promise<BulkProjectResult | null>;
}

export function useProjectBulkSelection(options: {
  onRefresh: () => void | Promise<void>;
  onError: (message: string) => void;
}): ProjectBulkSelection {
  const { onRefresh, onError } = options;
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isBusy, setIsBusy] = useState(false);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const enterSelectionMode = useCallback(() => setSelectionMode(true), []);

  // 退出多选一并清空选择 —— 留着一份看不见的选中集,下次进来会莫名其妙地"已选 7 个"
  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  }, []);

  const toggleSelectionMode = useCallback(() => {
    setSelectionMode((current) => {
      if (current) setSelectedIds(new Set());
      return !current;
    });
  }, []);

  const toggleSelection = useCallback((projectId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }, []);

  /** 全选 / 取消全选:传进来的这批全在里面就清空,否则并进去。 */
  const selectMany = useCallback((projectIds: string[]) => {
    setSelectedIds((current) => {
      const allSelected = projectIds.length > 0 && projectIds.every((id) => current.has(id));
      if (allSelected) return new Set();
      return new Set([...current, ...projectIds]);
    });
  }, []);

  const runAction = useCallback(async (
    action: BulkProjectAction,
    extra: Record<string, unknown> = {},
  ): Promise<BulkProjectResult | null> => {
    const ids = [...selectedIds];
    if (ids.length === 0 || isBusy) return null;
    setIsBusy(true);
    try {
      const response = await api.bulkProjects(action, ids, extra);
      const payload = (await response.json().catch(() => null)) as {
        data?: BulkProjectResult;
        error?: string;
      } | null;
      if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
      await onRefresh();
      // 删除/归档之后选中的项目已经不在列表里了,留着选中态没有意义
      if (action === 'archive' || action === 'delete') setSelectedIds(new Set());
      return payload?.data ?? null;
    } catch (error) {
      onError(error instanceof Error ? error.message : '批量操作失败,请重试。');
      return null;
    } finally {
      setIsBusy(false);
    }
  }, [selectedIds, isBusy, onRefresh, onError]);

  return useMemo(() => ({
    selectionMode,
    selectedIds,
    selectedCount: selectedIds.size,
    isBusy,
    enterSelectionMode,
    exitSelectionMode,
    toggleSelectionMode,
    toggleSelection,
    selectMany,
    clearSelection,
    runAction,
  }), [
    selectionMode, selectedIds, isBusy, enterSelectionMode, exitSelectionMode,
    toggleSelectionMode, toggleSelection, selectMany, clearSelection, runAction,
  ]);
}

/**
 * 把一次批量结果说成人话。
 *
 * 「全成功」只说一句;有跳过或失败时**必须把数字说出来** —— 用户点了 12 个,
 * 实际动了 5 个,却只看到"操作成功",这比报错还糟。
 */
export function describeBulkResult(result: BulkProjectResult, verb: string): string {
  const { requested, succeeded, skipped, failed } = result;
  if (succeeded.length === requested) return `${verb}了 ${succeeded.length} 个项目`;
  const parts = [`请求 ${requested} 个,${verb}了 ${succeeded.length} 个`];
  if (skipped.length > 0) {
    const notManageable = skipped.filter((entry) => entry.reason === 'not-manageable').length;
    parts.push(notManageable > 0
      ? `${skipped.length} 个跳过(其中 ${notManageable} 个不是你的项目,只有所有者或 root 能改)`
      : `${skipped.length} 个跳过`);
  }
  if (failed.length > 0) parts.push(`${failed.length} 个失败:${failed[0].reason}`);
  return parts.join(' · ');
}
