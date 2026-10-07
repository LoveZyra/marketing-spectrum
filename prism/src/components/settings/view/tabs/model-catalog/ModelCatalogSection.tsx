import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, Layers, Network, Pencil, Plus, Radar, RefreshCw, Star, Trash2, UserRound, XCircle } from 'lucide-react';

import ModelVendorIcon from '../../../../llm-logo-provider/ModelVendorIcon';
import { formatContextWindow } from '../../../../../../shared/modelVendors';
import { describeAudience, namesOf, toGatewayChoice, type GatewayChoice } from '../model-gateways/gatewayLogic';
import { MODEL_GATEWAYS_CHANGED_EVENT, gatewaysAdminApi, type BasicUser } from '../model-gateways/gatewaysApi';

import ModelCatalogEditor from './ModelCatalogEditor';
import ModelStatsLine from './ModelStatsLine';
import { STATS_DAYS, needsContextWindowWarning, probeAgo } from './catalogHints';
import { fetchModelStats, modelCatalogApi, type CatalogEntry, type CatalogInput, type ModelTurnStats } from './modelCatalogApi';

/**
 * 设置页「模型目录」(root)。
 *
 * 表格:图标 / 显示名 + 网关名 / 窗口 / 档位 / 标记(推荐、默认、已下架)/ 最近一次实测 / 操作(上下架、实测、编辑、删除)。
 * 编辑在表格上方内联展开(设置本身就是弹窗,不再叠一层弹窗)。
 *
 * 每行另有:
 * - 近 7 天健康度(回合数 / 失败率 / 首字延迟,见 ModelStatsLine);统计接口失败只是不画,不影响目录;
 * - 新 Claude 模型没填窗口时的琥珀色提醒(CLI 会按 1M 算,判定见 catalogHints);
 * - 挂在非默认网关上的标网关名,限定了人员的标「限 N 人」。
 *
 * 网关与成员名单从 `GET /gateways` 单独拉,拉不到只是下拉里只剩默认网关;
 * 上面「网关」那块一改就广播 MODEL_GATEWAYS_CHANGED_EVENT,这里跟着重拉。
 */

type GatewayInfo = { choices: GatewayChoice[]; users: BasicUser[]; names: Map<number, string> };

type StatsView = { days: number; byModel: Map<string, ModelTurnStats> };

export default function ModelCatalogSection() {
  const { t } = useTranslation('settings');
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** null = 不在编辑;'new' = 新建;数字 = 编辑那一条 */
  const [editing, setEditing] = useState<'new' | number | null>(null);
  const [busy, setBusy] = useState<Record<number, 'probe' | 'toggle' | 'delete' | undefined>>({});
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  /** null = 没拉到(或还没拉)—— 不画健康度那一行 */
  const [stats, setStats] = useState<StatsView | null>(null);
  // 只认最后一次加载的健康度(重新加载后,早先那次慢回来的不覆盖)
  const statsSeqRef = useRef(0);
  /** 共享网关 + 成员名单;null = 没拉到 */
  const [gatewayInfo, setGatewayInfo] = useState<GatewayInfo | null>(null);
  const gatewaySeqRef = useRef(0);

  const loadGateways = useCallback(async () => {
    const seq = ++gatewaySeqRef.current;
    try {
      const payload = await gatewaysAdminApi.list();
      if (seq !== gatewaySeqRef.current) return;
      setGatewayInfo({
        choices: payload.gateways.map(toGatewayChoice),
        users: payload.users,
        names: new Map(payload.gateways.map((gateway) => [gateway.id, gateway.name])),
      });
    } catch {
      if (seq === gatewaySeqRef.current) setGatewayInfo(null);
    }
  }, []);

  useEffect(() => {
    void loadGateways();
    const onGatewaysChanged = () => void loadGateways();
    window.addEventListener(MODEL_GATEWAYS_CHANGED_EVENT, onGatewaysChanged);
    return () => window.removeEventListener(MODEL_GATEWAYS_CHANGED_EVENT, onGatewaysChanged);
  }, [loadGateways]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    // 目录与健康度并行拉、各自落地:健康度慢或失败只影响那一行,不能把目录一起拖住
    const seq = ++statsSeqRef.current;
    void fetchModelStats(STATS_DAYS)
      .then((value) => {
        if (seq === statsSeqRef.current) setStats({ days: value.days, byModel: new Map((value.models ?? []).map((item) => [item.model, item])) });
      })
      .catch(() => {
        if (seq === statsSeqRef.current) setStats(null);
      });
    try {
      setEntries(await modelCatalogApi.list());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const replaceEntry = (next: CatalogEntry) => {
    setEntries((previous) => {
      const found = previous.some((entry) => entry.id === next.id);
      const merged = found ? previous.map((entry) => (entry.id === next.id ? next : entry)) : [...previous, next];
      // 设了默认 → 别的条目的默认在服务端已被清掉,这里同步
      const normalized = next.isDefault ? merged.map((entry) => (entry.id === next.id ? entry : { ...entry, isDefault: false })) : merged;
      return [...normalized].sort((a, b) => (a.sortOrder - b.sortOrder) || (a.id - b.id));
    });
  };

  const setBusyFor = (id: number, value: 'probe' | 'toggle' | 'delete' | undefined) =>
    setBusy((previous) => ({ ...previous, [id]: value }));

  const handleSave = async (input: CatalogInput): Promise<void> => {
    const saved = editing === 'new' || editing === null
      ? await modelCatalogApi.create(input)
      : await modelCatalogApi.update(editing, input);
    replaceEntry(saved);
    setEditing(null);
    setNotice(t('models.catalog.savedNotice', { model: saved.label }));
  };

  const handleToggle = async (entry: CatalogEntry) => {
    setBusyFor(entry.id, 'toggle');
    setError(null);
    try {
      replaceEntry(await modelCatalogApi.update(entry.id, { enabled: !entry.enabled }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyFor(entry.id, undefined);
    }
  };

  const handleProbe = async (entry: CatalogEntry) => {
    setBusyFor(entry.id, 'probe');
    setError(null);
    try {
      const { entry: next } = await modelCatalogApi.probe(entry.id);
      replaceEntry(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyFor(entry.id, undefined);
    }
  };

  const handleDelete = async (entry: CatalogEntry) => {
    if (confirmDelete !== entry.id) {
      setConfirmDelete(entry.id);
      return;
    }
    setBusyFor(entry.id, 'delete');
    setError(null);
    try {
      await modelCatalogApi.remove(entry.id);
      setEntries((previous) => previous.filter((item) => item.id !== entry.id));
      setConfirmDelete(null);
      if (editing === entry.id) setEditing(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyFor(entry.id, undefined);
    }
  };

  const editingEntry = useMemo(
    () => (typeof editing === 'number' ? entries.find((entry) => entry.id === editing) ?? null : null),
    [editing, entries],
  );
  const nextSortOrder = entries.reduce((max, entry) => Math.max(max, entry.sortOrder), 0) + 10;

  return (
    <section className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <Layers className="h-4 w-4 text-muted-foreground" />
            {t('models.catalog.title')}
          </h3>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{t('models.catalog.description')}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => {
              void load();
              void loadGateways();
            }}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-body transition-colors hover:border-border-strong hover:bg-card hover:text-foreground"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin text-primary' : ''}`} />
            {t('models.reload')}
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing('new');
              setNotice(null);
            }}
            disabled={editing === 'new'}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('models.catalog.add')}
          </button>
        </div>
      </div>

      {error && <p className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">{error}</p>}
      {notice && !editing && (
        <p className="bg-primary/8 rounded-md border border-primary/30 px-3 py-2 text-xs text-card-foreground dark:text-primary">{notice}</p>
      )}

      {editing !== null && (
        <ModelCatalogEditor
          key={editing === 'new' ? 'new' : `edit-${editing}`}
          entry={editingEntry}
          defaultSortOrder={nextSortOrder}
          onCancel={() => setEditing(null)}
          onSave={handleSave}
          gateways={gatewayInfo?.choices ?? null}
          users={gatewayInfo?.users ?? null}
        />
      )}

      <div className="overflow-hidden rounded-lg border border-border">
        {entries.length === 0 && !loading ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('models.catalog.empty')}</p>
        ) : (
          <ul className="divide-y divide-border">
            {entries.map((entry) => {
              const windowBadge = formatContextWindow(entry.contextWindow);
              const probe = entry.lastProbe;
              const rowBusy = busy[entry.id];
              const gatewayId = entry.gatewayId ?? 0;
              const audience = describeAudience(entry.allowedUsers);
              return (
                <li
                  key={entry.id}
                  data-catalog-row={entry.modelId}
                  className={`flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 ${entry.enabled ? '' : 'bg-muted/40'}`}
                >
                  <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-md border border-border bg-background text-foreground ${entry.enabled ? '' : 'opacity-50'}`}>
                    <ModelVendorIcon vendor={entry.vendor} modelId={entry.modelId} label={entry.label} size={18} />
                  </span>
                  <div className="min-w-48 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className={`text-sm font-semibold ${entry.enabled ? 'text-foreground' : 'text-muted-foreground'}`}>{entry.label}</span>
                      {windowBadge && (
                        <span className="rounded border border-border bg-muted px-1 py-px font-mono text-[10px] leading-4 text-muted-foreground">{windowBadge}</span>
                      )}
                      {entry.recommended && (
                        <span className="inline-flex items-center gap-0.5 rounded border border-primary/30 bg-primary/10 px-1 py-px text-[10px] leading-4 text-foreground dark:text-primary">
                          <Star className="h-2.5 w-2.5" />
                          {t('models.catalog.recommended')}
                        </span>
                      )}
                      {entry.isDefault && (
                        <span className="rounded border border-primary/40 bg-primary px-1 py-px text-[10px] leading-4 text-primary-foreground">{t('models.catalog.isDefault')}</span>
                      )}
                      {!entry.enabled && (
                        <span className="rounded border border-border px-1 py-px text-[10px] leading-4 text-muted-foreground">{t('models.catalog.disabled')}</span>
                      )}
                      {entry.effortLevels.length > 0 && (
                        <span className="text-[10px] leading-4 text-muted-foreground">{entry.effortLevels.join(' · ')}</span>
                      )}
                      {gatewayId !== 0 && (
                        <span
                          className="inline-flex max-w-full items-center gap-0.5 rounded border border-border px-1 py-px text-[10px] leading-4 text-muted-foreground"
                          title={t('gateways.catalog.rowGatewayTitle', { defaultValue: '走网关「{{name}}」', name: gatewayInfo?.names.get(gatewayId) ?? `#${gatewayId}` })}
                        >
                          <Network className="h-2.5 w-2.5 shrink-0" />
                          <span className="truncate">{gatewayInfo?.names.get(gatewayId) ?? `#${gatewayId}`}</span>
                        </span>
                      )}
                      {audience.kind === 'some' && (
                        <span
                          className="inline-flex items-center gap-0.5 rounded border border-border px-1 py-px text-[10px] leading-4 text-muted-foreground"
                          title={audience.count > 0
                            ? namesOf(entry.allowedUsers ?? [], gatewayInfo?.users).join(', ')
                            : t('gateways.catalog.audienceNoneHelp', { defaultValue: '一个人都没选 = 只有 root 能看到、能用。' })}
                        >
                          <UserRound className="h-2.5 w-2.5 shrink-0" />
                          {audience.count > 0
                            ? t('gateways.catalog.rowLimited', { defaultValue: '限 {{n}} 人', n: audience.count })
                            : t('gateways.catalog.rowRootOnly', { defaultValue: '仅 root' })}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] leading-4 text-muted-foreground">
                      {entry.label !== entry.modelId && <span className="font-mono">{entry.modelId}</span>}
                      {entry.description && <span className="truncate">{entry.description}</span>}
                    </div>
                    {needsContextWindowWarning(entry) && (
                      <div className="mt-1 flex items-start gap-1 text-[11px] leading-4 text-amber-700 dark:text-amber-400">
                        <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                        <span>{t('models.catalog.windowMissing')}</span>
                      </div>
                    )}
                    {probe && (
                      <div className={`mt-1 flex items-start gap-1 text-[11px] leading-4 ${probe.ok ? 'text-muted-foreground' : 'text-amber-700 dark:text-amber-400'}`}>
                        {probe.ok ? <CheckCircle2 className="mt-px h-3 w-3 shrink-0 text-primary" /> : <XCircle className="mt-px h-3 w-3 shrink-0" />}
                        <span>
                          {probe.ok
                            ? t('models.catalog.probeOk', { ms: probe.latencyMs, tokens: probe.inputTokens ?? 0, ago: probeAgo(probe.at) })
                            : t('models.catalog.probeFailed', { error: probe.error ?? '?', ago: probeAgo(probe.at) })}
                          {probe.respondedModel && probe.respondedModel !== entry.modelId && (
                            <> · {t('models.catalog.probeResponded', { model: probe.respondedModel })}</>
                          )}
                        </span>
                      </div>
                    )}
                    {stats && <ModelStatsLine stats={stats.byModel.get(entry.modelId)} days={stats.days} />}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={entry.enabled}
                      onClick={() => void handleToggle(entry)}
                      disabled={Boolean(rowBusy)}
                      title={entry.enabled ? t('models.catalog.disable') : t('models.catalog.enable')}
                      className={`relative h-5 w-9 rounded-full border transition-colors disabled:opacity-50 ${entry.enabled ? 'border-primary bg-primary' : 'border-border bg-muted'}`}
                    >
                      <span className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-background shadow transition-all ${entry.enabled ? 'left-[1.125rem]' : 'left-0.5'}`} />
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleProbe(entry)}
                      disabled={Boolean(rowBusy)}
                      title={t('models.catalog.probeTitle')}
                      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                    >
                      <Radar className={`h-3.5 w-3.5 ${rowBusy === 'probe' ? 'animate-pulse text-primary' : ''}`} />
                      {rowBusy === 'probe' ? t('models.catalog.probing') : t('models.catalog.probe')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(entry.id);
                        setNotice(null);
                      }}
                      aria-label={t('models.catalog.edit')}
                      title={t('models.catalog.edit')}
                      className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDelete(entry)}
                      onBlur={() => setConfirmDelete((current) => (current === entry.id ? null : current))}
                      disabled={Boolean(rowBusy)}
                      aria-label={t('models.catalog.delete')}
                      title={t('models.catalog.delete')}
                      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs transition-colors disabled:opacity-50 ${
                        confirmDelete === entry.id ? 'bg-destructive/10 text-destructive' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                      }`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      {confirmDelete === entry.id && t('models.catalog.confirmDelete')}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">{t('models.catalog.footnote')}</p>
    </section>
  );
}
