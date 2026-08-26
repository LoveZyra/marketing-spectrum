import { useCallback, useEffect, useState } from 'react';
import { HardDrive, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { authenticatedFetch } from '../../../../utils/api';

/**
 * 附件空间:我占了多少、都占在哪、哪些快到期了。
 *
 * 配额是按用户算的,所以只给一个总数是不够的 —— 超限时用户除了发牢骚做不了
 * 别的。按类型、按项目各切一份,再把最近就要被清掉的列出来,「该删哪个」才有据可依。
 */

type UsageKind = { kind: string; count: number; bytes: number; label: string };
type UsageProject = { projectPath: string | null; count: number; bytes: number; label: string };
type UsageExpiring = { path: string; name: string; bytes: number; label: string; createdAt: string };

type Usage = {
  usedBytes: number;
  usedLabel: string;
  quotaBytes: number;
  quotaLabel: string;
  percent: number;
  ttlDays: number;
  count: number;
  byKind: UsageKind[];
  byProject: UsageProject[];
  expiringSoon: UsageExpiring[];
};

const KIND_LABELS: Record<string, string> = { image: '图片', file: '文件' };

export default function AttachmentUsageCard() {
  const { t } = useTranslation('settings');
  const [usage, setUsage] = useState<Usage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await authenticatedFetch('/api/attachments/usage');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setUsage(await response.json());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // 进度条只在接近上限时变色 —— 平时它是一条中性的信息,不该一直报警。
  const nearLimit = (usage?.percent ?? 0) >= 85;

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-card px-4 py-2.5">
        <div className="flex items-center gap-2">
          <HardDrive className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-medium text-foreground">
            {t('account.attachments.title', '附件空间')}
          </h3>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          aria-label={t('account.attachments.refresh', '刷新')}
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="p-4">
        {error && (
          <p className="text-sm text-muted-foreground">
            {t('account.attachments.failed', '读不到用量:')}{error}
          </p>
        )}

        {!error && usage && (
          <>
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-sm text-foreground">
                <span className="font-mono text-base">{usage.usedLabel}</span>
                <span className="text-muted-foreground"> / {usage.quotaLabel}</span>
              </p>
              <p className="text-xs text-muted-foreground">
                {t('account.attachments.count', '共 {{count}} 个附件', { count: usage.count })}
              </p>
            </div>

            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full rounded-full transition-all ${nearLimit ? 'bg-destructive' : 'bg-primary'}`}
                style={{ width: `${Math.max(usage.percent, usage.usedBytes > 0 ? 2 : 0)}%` }}
              />
            </div>

            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {t(
                'account.attachments.help',
                '聊天里传的图片和文件存在会话所属项目的 attachments/ 目录下,超过 {{days}} 天会自动清理。你自己往那个目录里放的文件不受影响。',
                { days: usage.ttlDays },
              )}
            </p>

            {usage.byKind.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {usage.byKind.map((row) => (
                  <span key={row.kind}>
                    {KIND_LABELS[row.kind] || row.kind}
                    <span className="ml-1 font-mono text-foreground">{row.label}</span>
                    <span className="ml-1">({row.count})</span>
                  </span>
                ))}
              </div>
            )}

            {usage.byProject.length > 0 && (
              <div className="mt-3">
                <p className="mb-1.5 text-xs font-medium text-foreground">
                  {t('account.attachments.byProject', '按项目')}
                </p>
                <ul className="space-y-1">
                  {usage.byProject.map((row) => (
                    <li key={row.projectPath ?? '__global__'} className="flex items-baseline justify-between gap-3 text-xs">
                      <span className="truncate font-mono text-muted-foreground" title={row.projectPath ?? ''}>
                        {row.projectPath
                          ? row.projectPath.split('/').filter(Boolean).pop()
                          : t('account.attachments.noProject', '(未归属项目)')}
                      </span>
                      <span className="flex-shrink-0 font-mono text-foreground">{row.label}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {usage.expiringSoon.length > 0 && (
              <div className="mt-3">
                <p className="mb-1.5 text-xs font-medium text-foreground">
                  {t('account.attachments.expiring', '最先被清理的')}
                </p>
                <ul className="space-y-1">
                  {usage.expiringSoon.map((row) => (
                    <li key={row.path} className="flex items-baseline justify-between gap-3 text-xs">
                      <span className="truncate text-muted-foreground" title={row.path}>{row.name}</span>
                      <span className="flex-shrink-0 font-mono text-foreground">{row.label}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {usage.count === 0 && (
              <p className="mt-3 text-xs text-muted-foreground">
                {t('account.attachments.empty', '还没有传过附件。')}
              </p>
            )}
          </>
        )}

        {!error && !usage && loading && (
          <p className="text-sm text-muted-foreground">{t('account.attachments.loading', '正在读取…')}</p>
        )}
      </div>
    </div>
  );
}
