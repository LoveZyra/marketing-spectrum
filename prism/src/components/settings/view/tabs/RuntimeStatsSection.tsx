import { useCallback, useEffect, useState } from 'react';
import { Cpu } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { authenticatedFetch } from '../../../../utils/api';

type OwnerUsage = {
  userId: number | null;
  username: string | null;
  total?: number;
  busy?: number;
  count?: number;
};

export type RuntimeStats = {
  now: string;
  runtimes: {
    max: number;
    size: number;
    busy: number;
    idle: number;
    idleReapMs: number;
    oneShotOverflow: { active: number; max: number };
    byOwner: OwnerUsage[];
  };
  runs: { running: number; oldestStartedAt: string | null };
  approvals: { pending: number };
  pty: { count: number; attached: number; detached: number; takeover: number; bufferedBytes: number; byOwner: OwnerUsage[] };
  caches: { history: { entries: number; bytes: number } };
};

const formatBytes = (bytes: number): string => {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
};

const ownerLabel = (owner: OwnerUsage, anonymous: string): string =>
  owner.username ?? (owner.userId == null ? anonymous : `#${owner.userId}`);

/**
 * 进程内资源(F6,root 只读):常驻池 / 在飞回合 / 待审批 / PTY / 历史缓存。
 *
 * 与上面那组「这台机器怎么样」的指标是两回事:机器很闲而 Prism 很慢,原因通常
 * 就在这里 —— 名额被占满、某人挂了一堆 PTY、缓存把内存吃了。按账号切一份,
 * 是因为"满了"本身不可行动,"被谁占满了"才可行动。
 *
 * 面板只读:没有回收按钮。能一键杀掉别人正在跑的回合,风险远大于省下的事。
 */
export default function RuntimeStatsSection({ refreshMs }: { refreshMs: number }) {
  const { t } = useTranslation('settings');
  const [stats, setStats] = useState<RuntimeStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await authenticatedFetch('/api/admin/stats');
      const payload = (await response.json()) as { success?: boolean; stats?: RuntimeStats; error?: string };
      if (!response.ok || !payload.stats) throw new Error(payload.error || `HTTP ${response.status}`);
      setStats(payload.stats);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), refreshMs);
    return () => window.clearInterval(timer);
  }, [load, refreshMs]);

  const anonymous = t('server.anonymousOwner', '未登录');

  return (
    <div className="space-y-3 rounded-lg border border-border p-4">
      <div className="flex items-center gap-2">
        <Cpu className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">{t('server.runtimeTitle', '进程内资源')}</span>
      </div>

      {error && <p className="text-xs text-muted-foreground">{error}</p>}

      {stats && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-lg border border-border p-3">
              <div className="text-[11px] font-medium uppercase tracking-[1.4px] text-muted-foreground">
                {t('server.runtimePool', '常驻会话')}
              </div>
              <div className="mt-1 font-mono text-lg font-semibold">
                {stats.runtimes.size}/{stats.runtimes.max}
              </div>
              <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                {t('server.runtimeBusy', { busy: stats.runtimes.busy, defaultValue: `在跑 ${stats.runtimes.busy}` })}
                {stats.runtimes.oneShotOverflow.max > 0
                  ? ` · ${t('server.overflow', '溢出')} ${stats.runtimes.oneShotOverflow.active}/${stats.runtimes.oneShotOverflow.max}`
                  : ''}
              </div>
            </div>
            <div className="rounded-lg border border-border p-3">
              <div className="text-[11px] font-medium uppercase tracking-[1.4px] text-muted-foreground">
                {t('server.runsRunning', '在飞回合')}
              </div>
              <div className="mt-1 font-mono text-lg font-semibold">{stats.runs.running}</div>
              <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                {stats.runs.oldestStartedAt
                  ? `${t('server.oldestRun', '最早')} ${new Date(stats.runs.oldestStartedAt).toLocaleTimeString()}`
                  : '—'}
              </div>
            </div>
            <div className="rounded-lg border border-border p-3">
              <div className="text-[11px] font-medium uppercase tracking-[1.4px] text-muted-foreground">
                {t('server.ptyTitle', '终端')}
              </div>
              <div className="mt-1 font-mono text-lg font-semibold">{stats.pty.count}</div>
              <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                {t('server.ptyDetached', '断开待回收')} {stats.pty.detached} · {formatBytes(stats.pty.bufferedBytes)}
              </div>
            </div>
            <div className="rounded-lg border border-border p-3">
              <div className="text-[11px] font-medium uppercase tracking-[1.4px] text-muted-foreground">
                {t('server.historyCache', '历史缓存')}
              </div>
              <div className="mt-1 font-mono text-lg font-semibold">{formatBytes(stats.caches.history.bytes)}</div>
              <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                {stats.caches.history.entries} {t('server.cacheEntries', '条')} · {t('server.pendingApprovals', '待审批')} {stats.approvals.pending}
              </div>
            </div>
          </div>

          {(stats.runtimes.byOwner.length > 0 || stats.pty.byOwner.length > 0) && (
            <div className="grid gap-3 sm:grid-cols-2">
              {stats.runtimes.byOwner.length > 0 && (
                <div className="rounded-md border border-border px-3 py-2">
                  <div className="text-[11px] font-medium uppercase tracking-[1.4px] text-muted-foreground">
                    {t('server.runtimeByOwner', '常驻会话按账号')}
                  </div>
                  <ul className="mt-1.5 space-y-1">
                    {stats.runtimes.byOwner.map((owner) => (
                      <li key={`rt-${owner.userId ?? 'anon'}`} className="flex items-center justify-between font-mono text-[11px]">
                        <span className="truncate">{ownerLabel(owner, anonymous)}</span>
                        <span className="text-muted-foreground">
                          {owner.total ?? 0}
                          {owner.busy ? ` (${owner.busy} ${t('server.busyShort', '在跑')})` : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {stats.pty.byOwner.length > 0 && (
                <div className="rounded-md border border-border px-3 py-2">
                  <div className="text-[11px] font-medium uppercase tracking-[1.4px] text-muted-foreground">
                    {t('server.ptyByOwner', '终端按账号')}
                  </div>
                  <ul className="mt-1.5 space-y-1">
                    {stats.pty.byOwner.map((owner) => (
                      <li key={`pty-${owner.userId ?? 'anon'}`} className="flex items-center justify-between font-mono text-[11px]">
                        <span className="truncate">{ownerLabel(owner, anonymous)}</span>
                        <span className="text-muted-foreground">{owner.count ?? 0}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
