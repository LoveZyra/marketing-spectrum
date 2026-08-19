import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, RefreshCw, ScrollText } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api } from '../../../../../utils/api';

type AuditEntry = {
  id: number;
  user_id: number | null;
  username: string | null;
  event: string;
  outcome: string;
  ip: string | null;
  detail: string | null;
  created_at: string;
};

type AuditResponse = {
  entries?: AuditEntry[];
  total?: number;
  error?: string;
};

const PAGE_SIZE = 20;

const formatTime = (value: string): string => {
  const parsed = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
};

/**
 * 审计日志列表(登录/登出/审批/改密/停用等安全事件)。
 * 服务端裁剪可见范围:root 全量,普通用户只有自己的行 —— 组件两处通用。
 */
export default function AuditLogList() {
  const { t } = useTranslation('settings');
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (targetPage: number) => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.auth.auditLog({ limit: PAGE_SIZE, offset: targetPage * PAGE_SIZE });
      const payload = (await response.json()) as AuditResponse;
      if (!response.ok) {
        throw new Error(payload.error || 'Failed to load audit log');
      }
      setEntries(payload.entries ?? []);
      setTotal(payload.total ?? 0);
      setPage(targetPage);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(0);
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <ScrollText className="h-4 w-4 text-muted-foreground" />
          {t('audit.title', '安全审计日志')}
          <span className="text-xs font-normal text-muted-foreground">
            {t('audit.total', { count: total, defaultValue: `共 ${total} 条` })}
          </span>
        </h3>
        <button
          type="button"
          onClick={() => void load(page)}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-accent"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          {t('audit.refresh', '刷新')}
        </button>
      </div>

      {error && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300">
          {error}
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">{t('audit.columns.time', '时间')}</th>
              <th className="px-3 py-2 text-left font-medium">{t('audit.columns.user', '用户')}</th>
              <th className="px-3 py-2 text-left font-medium">{t('audit.columns.event', '事件')}</th>
              <th className="px-3 py-2 text-left font-medium">IP</th>
              <th className="px-3 py-2 text-left font-medium">{t('audit.columns.detail', '详情')}</th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-sm text-muted-foreground">
                  {loading ? t('audit.loading', '加载中…') : t('audit.empty', '暂无记录')}
                </td>
              </tr>
            )}
            {entries.map((entry) => (
              <tr key={entry.id} className="border-t border-border">
                <td className="whitespace-nowrap px-3 py-1.5 text-xs text-muted-foreground">
                  {formatTime(entry.created_at)}
                </td>
                <td className="px-3 py-1.5 text-xs font-medium">{entry.username ?? '—'}</td>
                <td className="px-3 py-1.5">
                  <span
                    className={`rounded px-1.5 py-0.5 font-mono text-[11px] ${
                      entry.outcome === 'failure'
                        ? 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300'
                        : 'bg-muted text-foreground/80'
                    }`}
                  >
                    {entry.event}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
                  {entry.ip ?? '—'}
                </td>
                <td className="max-w-[260px] truncate px-3 py-1.5 text-xs text-muted-foreground" title={entry.detail ?? ''}>
                  {entry.detail ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
          <button
            type="button"
            disabled={page === 0 || loading}
            onClick={() => void load(page - 1)}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 hover:bg-accent disabled:opacity-40"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            {t('audit.prev', '上一页')}
          </button>
          <span>
            {page + 1} / {totalPages}
          </span>
          <button
            type="button"
            disabled={page + 1 >= totalPages || loading}
            onClick={() => void load(page + 1)}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 hover:bg-accent disabled:opacity-40"
          >
            {t('audit.next', '下一页')}
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
