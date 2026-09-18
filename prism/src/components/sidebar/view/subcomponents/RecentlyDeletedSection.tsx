import { useCallback, useEffect, useState } from 'react';
import { RotateCcw, Trash2 } from 'lucide-react';
import type { TFunction } from 'i18next';

import { api } from '../../../../utils/api';

export type TrashedSessionItem = {
  sessionId: string;
  provider: string;
  sessionTitle: string;
  projectPath: string | null;
  projectDisplayName: string;
  projectExists: boolean;
  lastActivity: string | null;
  messageCount: number;
  deletedAt: string;
  deletedBy: string | null;
  deletedVia: string;
  transcriptKept: boolean;
  purgeAt: string | null;
  canRestore: boolean;
};

type TrashResponse = {
  success?: boolean;
  data?: {
    sessions?: TrashedSessionItem[];
    total?: number;
    hasMore?: boolean;
    retentionDays?: number;
  };
  error?: string;
};

type Props = {
  /** 只在归档视图打开时才拉数据。 */
  active: boolean;
  /**
   * 外面每做一次可能改变回收站内容的操作就 +1(永久删除、清空归档、批量删除)。
   *
   * 少了它,「清空归档」之后这一段还写着"没有最近删除的会话"—— 而弹窗刚说过
   * 「移入最近删除,保留期内可恢复」。用户看到的是"它把我的会话真删了",
   * 而这一段是在同一个视图里、同一屏上。
   */
  reloadToken?: number;
  /** 恢复成功后调用 —— 侧栏与归档列表要刷新(归档态的会话恢复后回到归档列表)。 */
  onRestored?: () => void;
  t: TFunction;
};

const PAGE = 100;

const formatWhen = (value: string | null): string => {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
};

const daysUntil = (value: string | null): number | null => {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.ceil((parsed - Date.now()) / (24 * 3600 * 1000)));
};

/**
 * gk:「最近删除」—— 永久删除的会话在保留期内躺在这里,可以恢复。
 *
 * 放在归档视图的底部:归档是"藏起来",最近删除是"删了但还能反悔",两者都在
 * 同一个"不在活跃列表里"的地方找。每一条写清楚**谁、几点、从哪删的**,和
 * **还有几天会被清扫** —— 这两样正是 2026-09-14 那次误删之后查不出来的东西。
 */
export default function RecentlyDeletedSection({ active, reloadToken = 0, onRestored, t }: Props) {
  const [items, setItems] = useState<TrashedSessionItem[]>([]);
  const [total, setTotal] = useState(0);
  const [retentionDays, setRetentionDays] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.trashedSessions({ limit: PAGE });
      const payload = (await response.json()) as TrashResponse;
      if (!response.ok || !payload.data) {
        throw new Error(payload.error || `HTTP ${response.status}`);
      }
      setItems(payload.data.sessions ?? []);
      setTotal(payload.data.total ?? 0);
      setRetentionDays(typeof payload.data.retentionDays === 'number' ? payload.data.retentionDays : null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (active) void load();
  }, [active, load, reloadToken]);

  const restore = useCallback(async (sessionId: string) => {
    setBusyId(sessionId);
    try {
      const response = await api.restoreTrashedSession(sessionId);
      if (!response.ok) {
        let message = t('recentlyDeleted.restoreFailed', '恢复失败,请稍后再试。');
        try {
          const payload = (await response.json()) as { error?: string; message?: string };
          message = payload.error || payload.message || message;
        } catch { /* 非 JSON 回包就用默认文案 */ }
        alert(message);
        return;
      }
      setItems((current) => current.filter((item) => item.sessionId !== sessionId));
      setTotal((current) => Math.max(0, current - 1));
      onRestored?.();
    } catch (caught) {
      console.error('[Sidebar] Failed to restore trashed session:', caught);
      alert(t('recentlyDeleted.restoreFailed', '恢复失败,请稍后再试。'));
    } finally {
      setBusyId(null);
    }
  }, [onRestored, t]);

  if (!active) return null;

  return (
    <div className="mt-3 px-2" data-recently-deleted="true">
      <div className="overflow-hidden rounded-lg border border-dashed border-border">
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors hover:bg-accent"
        >
          <span className="flex min-w-0 items-center gap-2">
            <Trash2 className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
            <span className="truncate text-xs font-normal text-foreground">
              {t('recentlyDeleted.title', '最近删除')}
            </span>
            {retentionDays !== null && (
              <span className="truncate text-[11px] text-muted-foreground">
                {retentionDays > 0
                  ? t('recentlyDeleted.retention', { days: retentionDays, defaultValue: '保留 {{days}} 天' })
                  : t('recentlyDeleted.retentionForever', '不自动清除')}
              </span>
            )}
          </span>
          <span className="flex-shrink-0 rounded-full border border-border px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
            {total}
          </span>
        </button>

        {expanded && (
          <div className="divide-y divide-border border-t border-border">
            {error && (
              <p className="px-3 py-2 text-xs text-muted-foreground">{error}</p>
            )}
            {!error && loading && items.length === 0 && (
              <p className="px-3 py-2 text-xs text-muted-foreground">{t('recentlyDeleted.loading', '正在加载…')}</p>
            )}
            {!error && !loading && items.length === 0 && (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                {t('recentlyDeleted.empty', '没有最近删除的会话。永久删除的会话会先到这里,保留期内可以恢复。')}
              </p>
            )}
            {items.map((item) => {
              const days = daysUntil(item.purgeAt);
              const deletedLine = [
                item.deletedBy
                  ? t('recentlyDeleted.deletedBy', { who: item.deletedBy, when: formatWhen(item.deletedAt), defaultValue: '{{who}} 于 {{when}} 删除' })
                  : t('recentlyDeleted.deletedAt', { when: formatWhen(item.deletedAt), defaultValue: '{{when}} 删除' }),
                days !== null ? t('recentlyDeleted.purgeIn', { days, defaultValue: '{{days}} 天后清除' }) : null,
                !item.transcriptKept ? t('recentlyDeleted.noTranscript', '无 transcript') : null,
              ].filter(Boolean).join(' · ');
              return (
                <div key={item.sessionId} className="flex items-center gap-2 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-xs font-normal text-foreground" title={item.sessionTitle}>
                        {item.sessionTitle}
                      </span>
                      <span className="ml-auto flex-shrink-0 text-[11px] text-muted-foreground">
                        {item.messageCount > 0
                          ? t('recentlyDeleted.messageCount', { count: item.messageCount, defaultValue: '{{count}} 条' })
                          : ''}
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-[11px] text-muted-foreground" title={item.projectPath ?? ''}>
                      {item.projectDisplayName}
                      {!item.projectExists && ` · ${t('recentlyDeleted.projectGone', '项目已删除')}`}
                    </p>
                    {/*
                      这一行就是整个功能存在的理由 —— "谁删的、几点、还剩几天"。
                      侧栏只有 ~158px,它必然被截断,所以**必须**有 title 兜底
                      (上面两行早就有了,这一行漏了:2026-09-15 实测)。
                      先把整句拼出来,文本与 title 用同一份,不会再漂开。
                    */}
                    <p className="mt-0.5 truncate text-[11px] text-muted-foreground" title={deletedLine}>
                      {deletedLine}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-primary/[0.08] text-foreground transition-colors hover:bg-primary/[0.16] disabled:cursor-not-allowed disabled:opacity-40 dark:text-primary"
                    onClick={() => void restore(item.sessionId)}
                    disabled={!item.canRestore || busyId === item.sessionId}
                    title={item.canRestore
                      ? t('recentlyDeleted.restore', '恢复')
                      : t('recentlyDeleted.cannotRestore', '只有项目负责人、管理员或删除它的人可以恢复')}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
            {items.length > 0 && total > items.length && (
              <p className="px-3 py-2 text-[11px] text-muted-foreground">
                {t('recentlyDeleted.more', { shown: items.length, total, defaultValue: '只列出最近 {{shown}} 条(共 {{total}} 条)' })}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
