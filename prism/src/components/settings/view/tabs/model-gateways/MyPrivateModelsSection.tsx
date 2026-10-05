import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Layers, Network, Pencil, Plus, Radar, Trash2, XCircle } from 'lucide-react';

import ModelVendorIcon from '../../../../llm-logo-provider/ModelVendorIcon';
import { formatContextWindow } from '../../../../../../shared/modelVendors';
import ModelCatalogEditor from '../model-catalog/ModelCatalogEditor';
import { probeAgo } from '../model-catalog/catalogHints';
import type { CatalogEntry, CatalogInput, CatalogProbeResult } from '../model-catalog/modelCatalogApi';

import { toGatewayChoice, type PrivateSectionMode } from './gatewayLogic';
import { errorMessage, myGatewaysApi, type MyGatewayView } from './gatewaysApi';

/**
 * hq:「模型网关 → 我的私有模型」。挂在我的私有网关上,只有我在选择器里看得到。
 * 编辑表单复用目录的 ModelCatalogEditor(`variant="private"`:网关只能选我的私有网关,没有推荐 / 默认 / 可用人员);
 * 「实测」与目录同一套检查,但结果不落库 —— 只在这一页显示到刷新为止。
 */
type Props = {
  models: CatalogEntry[];
  owned: MyGatewayView[];
  mode: Exclude<PrivateSectionMode, 'hidden'>;
  onModels: (next: CatalogEntry[]) => void;
};

export default function MyPrivateModelsSection({ models, owned, mode, onModels }: Props) {
  const { t } = useTranslation('settings');
  const active = mode === 'active';
  /** null = 不在编辑;'new' = 新建;数字 = 编辑那一条 */
  const [editing, setEditing] = useState<'new' | number | null>(null);
  const [busy, setBusy] = useState<Record<number, 'probe' | 'toggle' | 'delete' | undefined>>({});
  const [probes, setProbes] = useState<Record<number, CatalogProbeResult>>({});
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const gatewayChoices = useMemo(() => owned.map(toGatewayChoice), [owned]);
  const gatewayNames = useMemo(() => new Map(owned.map((gateway) => [gateway.id, gateway.name])), [owned]);
  const editingEntry = typeof editing === 'number' ? models.find((model) => model.id === editing) ?? null : null;

  const setBusyFor = (id: number, value: 'probe' | 'toggle' | 'delete' | undefined) =>
    setBusy((previous) => ({ ...previous, [id]: value }));

  const runRow = async (id: number, kind: 'probe' | 'toggle' | 'delete', action: () => Promise<void>) => {
    setBusyFor(id, kind);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusyFor(id, undefined);
    }
  };

  const handleSave = async (input: CatalogInput) => {
    const next = editing === 'new' || editing === null
      ? await myGatewaysApi.createModel(input)
      : await myGatewaysApi.updateModel(editing, input);
    onModels(next);
    setEditing(null);
    setNotice(t('gateways.privateModels.savedNotice', { defaultValue: '已保存「{{model}}」。对话页的模型列表里会出现在最前面。', model: input.label ?? input.modelId ?? '' }));
  };

  return (
    <section className="space-y-3" data-my-private-models>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-64">
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <Layers className="h-4 w-4 text-muted-foreground" />
            {t('gateways.privateModels.title', { defaultValue: '我的私有模型' })}
          </h3>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            {t('gateways.privateModels.description', { defaultValue: '挂在你的私有网关上的模型,只出现在你自己的模型选择器里。' })}
          </p>
        </div>
        {active && (
          <button
            type="button"
            onClick={() => {
              setEditing('new');
              setNotice(null);
            }}
            disabled={editing === 'new' || owned.length === 0}
            title={owned.length === 0 ? t('gateways.privateModels.needGateway', { defaultValue: '先添加一个私有网关' }) : undefined}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('gateways.privateModels.add', { defaultValue: '添加私有模型' })}
          </button>
        )}
      </div>

      {error && <p className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground" role="alert">{error}</p>}
      {notice && !editing && (
        <p className="bg-primary/8 rounded-md border border-primary/30 px-3 py-2 text-xs text-card-foreground dark:text-primary">{notice}</p>
      )}

      {active && editing !== null && (
        <ModelCatalogEditor
          key={editing === 'new' ? 'new' : `edit-${editing}`}
          variant="private"
          entry={editingEntry}
          defaultSortOrder={0}
          gateways={gatewayChoices}
          onCancel={() => setEditing(null)}
          onSave={handleSave}
        />
      )}

      <div className="overflow-hidden rounded-lg border border-border">
        {models.length === 0 ? (
          <p className="px-4 py-4 text-center text-xs text-muted-foreground">
            {owned.length === 0
              ? t('gateways.privateModels.emptyNoGateway', { defaultValue: '还没有私有模型。先在上面添加一个私有网关,再把模型挂上去。' })
              : t('gateways.privateModels.empty', { defaultValue: '还没有私有模型。点「添加私有模型」填网关上的模型名。' })}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {models.map((model) => {
              const rowBusy = busy[model.id];
              const probe = probes[model.id];
              const windowBadge = formatContextWindow(model.contextWindow);
              const gatewayId = model.gatewayId ?? 0;
              return (
                <li
                  key={model.id}
                  data-private-model={model.modelId}
                  className={`flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 ${model.enabled && active ? '' : 'bg-muted/40'}`}
                >
                  <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-md border border-border bg-background text-foreground ${model.enabled ? '' : 'opacity-50'}`}>
                    <ModelVendorIcon vendor={model.vendor} modelId={model.modelId} label={model.label} size={18} />
                  </span>
                  <div className="min-w-0 flex-1 basis-48">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className={`min-w-0 break-words text-sm font-semibold ${model.enabled ? 'text-foreground' : 'text-muted-foreground'}`}>{model.label}</span>
                      {windowBadge && (
                        <span className="rounded border border-border bg-muted px-1 py-px font-mono text-[10px] leading-4 text-muted-foreground">{windowBadge}</span>
                      )}
                      <span className="inline-flex max-w-full items-center gap-0.5 rounded border border-border px-1 py-px text-[10px] leading-4 text-muted-foreground">
                        <Network className="h-2.5 w-2.5 shrink-0" />
                        <span className="truncate">{gatewayNames.get(gatewayId) ?? `#${gatewayId}`}</span>
                      </span>
                      {!model.enabled && (
                        <span className="rounded border border-border px-1 py-px text-[10px] leading-4 text-muted-foreground">{t('models.catalog.disabled', { defaultValue: '已下架' })}</span>
                      )}
                      {model.effortLevels.length > 0 && (
                        <span className="text-[10px] leading-4 text-muted-foreground">{model.effortLevels.join(' · ')}</span>
                      )}
                    </div>
                    {model.label !== model.modelId && (
                      <div className="mt-0.5 break-all font-mono text-[11px] leading-4 text-muted-foreground">{model.modelId}</div>
                    )}
                    {probe && (
                      <div className={`mt-1 flex items-start gap-1 text-[11px] leading-4 ${probe.ok ? 'text-muted-foreground' : 'text-amber-700 dark:text-amber-400'}`}>
                        {probe.ok ? <CheckCircle2 className="mt-px h-3 w-3 shrink-0 text-primary" /> : <XCircle className="mt-px h-3 w-3 shrink-0" />}
                        <span className="min-w-0 break-words">
                          {probe.ok
                            ? t('models.catalog.probeOk', { ms: probe.latencyMs, tokens: probe.inputTokens ?? 0, ago: probeAgo(probe.at) })
                            : t('models.catalog.probeFailed', { error: probe.error ?? '?', ago: probeAgo(probe.at) })}
                          {probe.respondedModel && probe.respondedModel !== model.modelId && (
                            <> · {t('models.catalog.probeResponded', { model: probe.respondedModel })}</>
                          )}
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-1">
                    {active && (
                      <>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={model.enabled}
                          aria-label={t('gateways.privateModels.enabled', { defaultValue: '上架' })}
                          onClick={() => void runRow(model.id, 'toggle', async () => onModels(await myGatewaysApi.updateModel(model.id, { enabled: !model.enabled })))}
                          disabled={Boolean(rowBusy)}
                          title={model.enabled ? t('models.catalog.disable', { defaultValue: '下架' }) : t('models.catalog.enable', { defaultValue: '上架' })}
                          className={`relative h-5 w-9 rounded-full border transition-colors disabled:opacity-50 ${model.enabled ? 'border-primary bg-primary' : 'border-border bg-muted'}`}
                        >
                          <span className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-background shadow transition-colors ${model.enabled ? 'left-[1.125rem]' : 'left-0.5'}`} />
                        </button>
                        <button
                          type="button"
                          onClick={() => void runRow(model.id, 'probe', async () => {
                            const result = await myGatewaysApi.probeModel(model.id);
                            setProbes((previous) => ({ ...previous, [model.id]: result }));
                          })}
                          disabled={Boolean(rowBusy)}
                          title={t('models.catalog.probeTitle', { defaultValue: '发一次带工具调用的最小请求:名字被接受、工具往返、usage、回复的模型名' })}
                          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                        >
                          <Radar className={`h-3.5 w-3.5 ${rowBusy === 'probe' ? 'animate-pulse text-primary' : ''}`} />
                          {rowBusy === 'probe' ? t('models.catalog.probing', { defaultValue: '实测中…' }) : t('models.catalog.probe', { defaultValue: '实测' })}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditing(model.id);
                            setNotice(null);
                          }}
                          aria-label={t('gateways.common.edit', { defaultValue: '编辑' })}
                          title={t('gateways.common.edit', { defaultValue: '编辑' })}
                          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        if (confirmDelete !== model.id) {
                          setConfirmDelete(model.id);
                          return;
                        }
                        void runRow(model.id, 'delete', async () => {
                          onModels(await myGatewaysApi.removeModel(model.id));
                          setConfirmDelete(null);
                          if (editing === model.id) setEditing(null);
                        });
                      }}
                      onBlur={() => setConfirmDelete((current) => (current === model.id ? null : current))}
                      disabled={Boolean(rowBusy)}
                      aria-label={t('gateways.common.delete', { defaultValue: '删除' })}
                      title={t('gateways.common.delete', { defaultValue: '删除' })}
                      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs transition-colors disabled:opacity-50 ${
                        confirmDelete === model.id ? 'bg-destructive/10 text-destructive' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                      }`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      {confirmDelete === model.id && t('gateways.common.confirmDelete', { defaultValue: '确认删除' })}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
