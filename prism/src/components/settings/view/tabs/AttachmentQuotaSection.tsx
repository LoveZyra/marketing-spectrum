import { useCallback, useEffect, useState } from 'react';
import { HardDrive } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { authenticatedFetch } from '../../../../utils/api';

type QuotaRow = {
  userId: number;
  username: string;
  isActive: boolean;
  count: number;
  usedBytes: number;
  usedLabel: string;
  quotaBytes: number;
  quotaLabel: string;
  quotaMbOverride: number | null;
  percent: number;
};

/**
 * 每账号附件用量与配额覆盖(F6,root)。
 *
 * 配额本来就是按账号算的,可之前只有一个全局值:多数人用不到 1 GB,个别人要传
 * 一堆设计稿 —— 为了那一个人把全局值抬上去,等于给所有人都开了那么大的口子。
 * 这里逐人可覆盖,留空即回到全局默认。
 *
 * 用量按占用从大到小排,因为 root 打开这一页时想知道的永远是"谁占得最多"。
 */
export default function AttachmentQuotaSection() {
  const { t } = useTranslation('settings');
  const [rows, setRows] = useState<QuotaRow[]>([]);
  const [defaultQuotaBytes, setDefaultQuotaBytes] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ userId: number; value: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await authenticatedFetch('/api/admin/attachment-usage');
      const payload = (await response.json()) as { users?: QuotaRow[]; defaultQuotaBytes?: number; error?: string };
      if (!response.ok || !payload.users) throw new Error(payload.error || `HTTP ${response.status}`);
      setRows(payload.users);
      setDefaultQuotaBytes(payload.defaultQuotaBytes ?? 0);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async (userId: number, raw: string) => {
    setSaving(true);
    try {
      const trimmed = raw.trim();
      const response = await authenticatedFetch(`/api/admin/users/${userId}/attachment-quota`, {
        method: 'PUT',
        body: JSON.stringify({ quotaMb: trimmed === '' ? null : Number(trimmed) }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      setEditing(null);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }, [load]);

  return (
    <div className="space-y-3 rounded-lg border border-border p-4">
      <div className="flex items-center gap-2">
        <HardDrive className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">{t('server.quotaTitle', '附件配额')}</span>
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">
          {t('server.quotaDefault', '全局默认')} {(defaultQuotaBytes / 1024 ** 3).toFixed(1)} GB
        </span>
      </div>

      <p className="text-xs text-muted-foreground">
        {t('server.quotaHint', '留空即跟随全局默认(PRISM_ATTACHMENT_QUOTA_MB)。单位 MB。')}
      </p>

      {error && <p className="text-xs text-muted-foreground">{error}</p>}

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="text-[11px] uppercase tracking-[1.4px] text-muted-foreground">
              <th className="py-1.5 pr-3 font-medium">{t('server.quotaUser', '账号')}</th>
              <th className="py-1.5 pr-3 font-medium">{t('server.quotaUsed', '已用')}</th>
              <th className="py-1.5 pr-3 font-medium">{t('server.quotaLimit', '上限')}</th>
              <th className="py-1.5 font-medium">{t('server.quotaOverride', '覆盖(MB)')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.userId} className="border-t border-border">
                <td className="py-1.5 pr-3">
                  <span className={row.isActive ? '' : 'text-muted-foreground line-through'}>{row.username}</span>
                </td>
                <td className="py-1.5 pr-3 font-mono text-muted-foreground">
                  {row.usedLabel}
                  <span className="ml-1 opacity-60">({row.percent}% · {row.count})</span>
                </td>
                <td className="py-1.5 pr-3 font-mono text-muted-foreground">{row.quotaLabel}</td>
                <td className="py-1.5">
                  {editing?.userId === row.userId ? (
                    <span className="flex items-center gap-1.5">
                      <input
                        autoFocus
                        type="number"
                        min={1}
                        value={editing.value}
                        onChange={(event) => setEditing({ userId: row.userId, value: event.target.value })}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') void save(row.userId, editing.value);
                          if (event.key === 'Escape') setEditing(null);
                        }}
                        placeholder={t('server.quotaFollowDefault', '默认')}
                        className="w-24 rounded border border-border bg-transparent px-1.5 py-0.5 font-mono text-xs"
                      />
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => void save(row.userId, editing.value)}
                        className="rounded border border-border px-1.5 py-0.5 text-[11px] hover:bg-card disabled:opacity-60"
                      >
                        {t('server.quotaSave', '保存')}
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditing(null)}
                        className="rounded px-1 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                      >
                        {t('server.quotaCancel', '取消')}
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setEditing({ userId: row.userId, value: row.quotaMbOverride ? String(row.quotaMbOverride) : '' })}
                      className="rounded border border-dashed border-border px-2 py-0.5 font-mono text-[11px] text-muted-foreground hover:border-border-strong hover:text-foreground"
                    >
                      {row.quotaMbOverride ? `${row.quotaMbOverride} MB` : t('server.quotaFollowDefault', '默认')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
