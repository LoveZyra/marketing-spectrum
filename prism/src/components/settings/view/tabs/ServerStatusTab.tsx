import { useCallback, useEffect, useState } from 'react';
import { Activity, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { authenticatedFetch } from '../../../../utils/api';

import AttachmentQuotaSection from './AttachmentQuotaSection';
import RuntimeStatsSection from './RuntimeStatsSection';

type ServerStatus = {
  now: string;
  appVersion: string | null;
  nodeVersion: string;
  processUptimeSec: number;
  osUptimeSec: number;
  load1: number;
  cpuCount: number;
  memory: { totalBytes: number; freeBytes: number; processRssBytes: number };
  disk: { path: string; totalKb: number; usedKb: number; availableKb: number; usedPercent: number } | null;
  jupyter: {
    enabled: boolean;
    running: boolean;
    starting: boolean;
    ready: boolean;
    port: number;
    installed: boolean | null;
    lastError: string | null;
  };
  gateway: { host: string; reachable: boolean; statusCode: number | null; latencyMs: number | null; error: string | null } | null;
};

type StatusResponse = { success?: boolean; status?: ServerStatus; error?: string };

const REFRESH_MS = 10_000;

const formatBytes = (bytes: number): string => {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
};

const formatKb = (kb: number): string => formatBytes(kb * 1024);

const formatUptime = (seconds: number): string => {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
};

function StatCard({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'ok' | 'warn' | 'bad' }) {
  const toneClass =
    tone === 'bad'
      ? 'text-muted-foreground'
      : tone === 'warn'
        ? 'text-muted-foreground'
        : 'text-foreground';
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="text-[11px] font-medium uppercase tracking-[1.4px] text-muted-foreground">{label}</div>
      <div className={`mt-1 font-mono text-lg font-semibold ${toneClass}`}>{value}</div>
      {hint && <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

/**
 * 服务器状态面板(root):负载/内存/磁盘/版本 + Jupyter + 网关连通。
 * 打开时每 10s 自动刷新;网关探测由服务端发起且不带 token,只量连通与延迟。
 */
export default function ServerStatusTab() {
  const { t } = useTranslation('settings');
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await authenticatedFetch('/api/admin/server-status');
      const payload = (await response.json()) as StatusResponse;
      if (!response.ok || !payload.status) {
        throw new Error(payload.error || `HTTP ${response.status}`);
      }
      setStatus(payload.status);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const memUsedPct = status
    ? Math.round(((status.memory.totalBytes - status.memory.freeBytes) / status.memory.totalBytes) * 100)
    : 0;
  const loadPerCore = status ? status.load1 / Math.max(1, status.cpuCount) : 0;

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <Activity className="h-4 w-4 text-muted-foreground" />
            {t('server.title', '服务器状态')}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('server.description', '每 10 秒自动刷新。网关探测不携带任何凭据,只量网络连通与延迟。')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-body transition-colors hover:border-border-strong hover:bg-card hover:text-foreground"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'text-primary' : ''}`} />
          {t('server.refresh', '刷新')}
        </button>
      </div>

      {error && (
        <p className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
          {error}
        </p>
      )}

      {status && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard
              label={t('server.load', '负载 (1min)')}
              value={status.load1.toFixed(2)}
              hint={`${status.cpuCount} ${t('server.cores', '核')}`}
              tone={loadPerCore > 1 ? 'bad' : loadPerCore > 0.7 ? 'warn' : 'ok'}
            />
            <StatCard
              label={t('server.memory', '内存')}
              value={`${memUsedPct}%`}
              hint={`${formatBytes(status.memory.totalBytes - status.memory.freeBytes)} / ${formatBytes(status.memory.totalBytes)} · 棱镜 ${formatBytes(status.memory.processRssBytes)}`}
              tone={memUsedPct > 90 ? 'bad' : memUsedPct > 75 ? 'warn' : 'ok'}
            />
            <StatCard
              label={t('server.disk', '磁盘(工作区)')}
              value={status.disk ? `${status.disk.usedPercent}%` : '—'}
              hint={status.disk ? `${t('server.diskFree', '剩余')} ${formatKb(status.disk.availableKb)}` : undefined}
              tone={status.disk && status.disk.usedPercent > 90 ? 'bad' : status.disk && status.disk.usedPercent > 75 ? 'warn' : 'ok'}
            />
            <StatCard
              label={t('server.uptime', '运行时长')}
              value={formatUptime(status.processUptimeSec)}
              hint={`${t('server.osUptime', '主机')} ${formatUptime(status.osUptimeSec)} · 棱镜 v${status.appVersion ?? '?'} · Node ${status.nodeVersion}`}
            />
          </div>

          <div className="space-y-2 rounded-lg border border-border p-4 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium">JupyterLab</span>
              <span
                className={`rounded px-2 py-0.5 text-xs ${
                  status.jupyter.ready
                    ? 'bg-primary/8 text-card-foreground dark:text-primary'
                    : status.jupyter.starting
                      ? 'bg-muted text-muted-foreground'
                      : 'bg-muted text-muted-foreground'
                }`}
              >
                {status.jupyter.ready
                  ? t('server.jupyterReady', { port: status.jupyter.port, defaultValue: `就绪 · 127.0.0.1:${status.jupyter.port}` })
                  : status.jupyter.starting
                    ? t('server.jupyterStarting', '启动中…')
                    : status.jupyter.installed === false
                      ? t('server.jupyterMissing', '未安装')
                      : t('server.jupyterIdle', '未启动(首次打开 Notebook 标签页时拉起)')}
              </span>
            </div>
            {status.jupyter.lastError && (
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-muted px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
                {status.jupyter.lastError}
              </pre>
            )}

            <div className="flex items-center justify-between gap-3 border-t border-border pt-2">
              <span className="font-medium">{t('server.gateway', '模型网关')}</span>
              {status.gateway ? (
                <span
                  className={`rounded px-2 py-0.5 font-mono text-xs ${
                    status.gateway.reachable
                      ? 'bg-primary/8 text-card-foreground dark:text-primary'
                      : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {status.gateway.host}
                  {status.gateway.reachable
                    ? ` · ${status.gateway.latencyMs}ms`
                    : ` · ${status.gateway.error ?? t('server.gatewayDown', '不可达')}`}
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">{t('server.gatewayUnset', '未配置 BASE_URL')}</span>
              )}
            </div>
          </div>

          {/* F6:进程内资源 + 每账号附件配额。机器指标很闲而 Prism 很慢时,
              原因通常在这两块里,而它们此前一个都看不见。 */}
          <RuntimeStatsSection refreshMs={REFRESH_MS} />
          <AttachmentQuotaSection />
        </>
      )}
    </div>
  );
}
