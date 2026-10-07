import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, BadgeCheck, ChevronDown, ChevronRight, Radar, RefreshCw, Search } from 'lucide-react';

import { Button, Input } from '../../../../shared/view/ui';
import { authenticatedFetch } from '../../../../utils/api';
import type { LLMProvider, ProviderModelOption, ProviderModelsDefinition } from '../../../../types/app';
import type { ModelCommandData } from '../../hooks/useChatComposerState';
import { useAuth } from '../../../auth/context/AuthContext';
import ModelVendorIcon from '../../../llm-logo-provider/ModelVendorIcon';
import {
  AUTO_COMPACT_MARGIN,
  MODEL_VENDORS,
  detectModelVendor,
  formatContextWindow,
  getModelVendor,
} from '../../../../../shared/modelVendors';
import { availableFirst, canFixWithKey, isModelAvailable } from '../../utils/modelAvailability';
import { resolveAliasReal } from '../../utils/modelAliasReal';

/**
 * `/models` 的选择器:以模型目录为主,别名组收在最后。
 *
 * 自上而下:
 * - 「私有」:本人的私有模型(带「私有」小标);
 * - 「推荐」:目录里标了推荐的;
 * - 「更多模型」:其余上架条目,按厂商分组(组序同 `MODEL_VENDORS`,认不出的归「其他」);
 * - 「别名 · 子代理用」:default / sonnet / opus / haiku …,带「配置映射 + 实测」两行(实测按钮只给 root)。
 *   目录为空时别名可选、默认展开;目录里有模型时只给 root 看、只读,默认收起(搜索结果里没有目录模型时展开)。
 *
 * 每行:厂商图标、显示名、窗口角标(`128K`)、网关原名、一行说明;当前项打勾。
 * 窗口比当前上下文还小(已过它的压缩线)的行标一句提示 —— 服务端会挡住切过去后的第一条普通消息,
 * 那时发 `/compact` 会先用当前模型压缩,压完自动换过去。
 *
 * 不在默认网关上的模型标网关名;不能用的模型(网关没有可用的 key / 停用)照样列出、置灰点不了,
 * 写上服务端给的原因,填了 key 就能用的带「去填 key」(开 设置 → 模型网关);每一节里不能用的排在后面。
 */

type ModelOption = Partial<ProviderModelOption> & { value: string };

type ModelMappingEntry = {
  actualModel: string | null;
  error: string | null;
  checkedAt: string;
};

type ModelConfigMappingEntry = {
  configuredModel: string | null;
  source: string | null;
};

type ModelMappingsState = {
  mappings: Record<string, ModelMappingEntry>;
  /** 配置层映射:读 settings.json 直接解析,零成本、随改随新,不依赖实测。 */
  configMappings: Record<string, ModelConfigMappingEntry>;
  gatewayHost: string | null;
  /** settings.json 在上次实测后改过 —— 实测值可能过期,提示重测。 */
  stale: boolean;
};

export type ModelPickerContentProps = {
  data: ModelCommandData;
  providerModelCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>;
  providerModelsRefreshing: boolean;
  onHardRefreshProviderModels: () => void;
  currentSessionId: string | null;
  /** 会话此刻用的模型值(目录条目的网关名,或别名)—— 输入框 chip 显示的那个。 */
  activeModelAlias?: string | null;
  /** 这段对话当前的上下文用量(tokens);用来标"切过去就超压缩线"的行。 */
  contextUsedTokens?: number | null;
  onSelectProviderModel: (
    provider: LLMProvider,
    model: string,
    sessionId?: string | null,
  ) => Promise<{ scope: 'default' | 'session'; changed: boolean; model: string }>;
  /** 「去填 key」:打开 设置 → 模型网关(先关掉这个弹窗)。不传就不出这个入口。 */
  onOpenKeySettings?: () => void;
  onClose: () => void;
};

const optionVendor = (option: ModelOption): string | null =>
  getModelVendor(option.vendor)?.id ?? detectModelVendor(option.realModel || option.value);

/** 没有 `group` 字段的数据一律当别名。 */
const isAliasOption = (option: ModelOption, hasGroups: boolean): boolean =>
  !hasGroups || option.group === 'alias';

function SectionTitle({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="mb-1.5 mt-3 flex items-center justify-between gap-2 first:mt-0">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{children}</p>
      {trailing}
    </div>
  );
}

export default function ModelPickerContent({
  data,
  providerModelCatalog,
  providerModelsRefreshing,
  onHardRefreshProviderModels,
  currentSessionId,
  activeModelAlias,
  contextUsedTokens,
  onSelectProviderModel,
  onOpenKeySettings,
  onClose,
}: ModelPickerContentProps) {
  const { t } = useTranslation('chat');
  const isRoot = Boolean(useAuth().user?.isRoot);

  /** "3 分钟前 / 2 小时前 / 5 天前" —— 映射是网关配置,新鲜度比精确时刻有用。 */
  const formatCheckedAgo = (iso: string): string => {
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return '';
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 1) return t('commandResult.models.probedJustNow', { defaultValue: '刚刚实测' });
    if (minutes < 60) return t('commandResult.models.probedMinutesAgo', { count: minutes, defaultValue: '{{count}} 分钟前实测' });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t('commandResult.models.probedHoursAgo', { count: hours, defaultValue: '{{count}} 小时前实测' });
    return t('commandResult.models.probedDaysAgo', { count: Math.floor(hours / 24), defaultValue: '{{count}} 天前实测' });
  };
  const [query, setQuery] = useState('');
  const [changingModel, setChangingModel] = useState<string | null>(null);
  const [pendingSessionModel, setPendingSessionModel] = useState<string | null>(null);
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);
  const [aliasOpen, setAliasOpen] = useState<boolean | null>(null);
  // 选中成功后短暂显示确认再自动关弹窗。用 ref 存 timer,卸载时清掉。
  const autoCloseTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (autoCloseTimerRef.current !== null) window.clearTimeout(autoCloseTimerRef.current);
  }, []);
  const [mappingsState, setMappingsState] = useState<ModelMappingsState>({ mappings: {}, configMappings: {}, gatewayHost: null, stale: false });
  const [probing, setProbing] = useState(false);
  const currentProvider = (data?.current?.provider || 'claude') as LLMProvider;

  const applyMappingsPayload = (payload: {
    mappings?: Record<string, ModelMappingEntry>;
    configMappings?: Record<string, ModelConfigMappingEntry>;
    gatewayHost?: string | null;
    stale?: boolean;
  }) => setMappingsState({
    mappings: payload.mappings ?? {},
    configMappings: payload.configMappings ?? {},
    gatewayHost: payload.gatewayHost ?? null,
    stale: payload.stale === true,
  });

  // 打开弹窗时读缓存的别名映射。只读缓存,不触发探测 —— 探测要花真实的 API 调用,必须是显式动作。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await authenticatedFetch(`/api/providers/${currentProvider}/model-mappings`);
        if (!response.ok) return;
        const payload = (await response.json()) as { data?: Parameters<typeof applyMappingsPayload>[0] };
        if (!cancelled && payload.data) applyMappingsPayload(payload.data);
      } catch {
        // 拿不到就不显示映射行,选择器照常可用。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentProvider]);

  const handleProbeMappings = async () => {
    setProbing(true);
    try {
      const response = await authenticatedFetch(`/api/providers/${currentProvider}/model-mappings/probe`, { method: 'POST' });
      if (!response.ok) {
        throw new Error(t('commandResult.models.probeFailedHttp', { status: response.status, defaultValue: '探测失败(HTTP {{status}})' }));
      }
      const payload = (await response.json()) as { data?: Parameters<typeof applyMappingsPayload>[0] };
      if (payload.data) applyMappingsPayload(payload.data);
    } catch (error) {
      setSelectionNotice(error instanceof Error ? error.message : t('commandResult.models.probeFailed', { defaultValue: '探测失败' }));
    } finally {
      setProbing(false);
    }
  };

  const currentModel = data?.current?.model || 'Unknown';
  /**
   * 「当前」按会话的模型值判(目录条目的网关名,或别名),不按 `data.current.model` ——
   * 自定义网关下后者是别名解析后的真实模型名,与别名不是一个命名空间。
   */
  const currentValue = activeModelAlias || currentModel;
  const providerLabel = data?.current?.providerLabel || 'Claude';
  const liveDefinition = providerModelCatalog[currentProvider];
  const availableOptions = useMemo<ModelOption[]>(() => {
    if (liveDefinition?.OPTIONS && liveDefinition.OPTIONS.length > 0) return liveDefinition.OPTIONS;
    if (Array.isArray(data?.availableOptions) && data.availableOptions.length > 0) return data.availableOptions;
    const availableModels = Array.isArray(data?.availableModels) ? data.availableModels : [];
    return availableModels.map((model) => ({ value: model, label: model }));
  }, [data, liveDefinition]);

  const hasGroups = availableOptions.some((option) => option.group === 'catalog' || option.group === 'alias');
  const currentOption = availableOptions.find((option) => option.value === currentValue) ?? null;

  const { privateModels, recommended, moreByVendor, aliases } = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const matchesQuery = (option: ModelOption): boolean => {
      if (!normalized) return true;
      const configured = mappingsState.configMappings[option.value]?.configuredModel || '';
      const vendorLabel = getModelVendor(optionVendor(option))?.label || '';
      const haystack = `${option.value} ${option.label || ''} ${configured} ${option.description || ''} ${vendorLabel} ${option.gatewayName || ''}`.toLowerCase();
      return haystack.includes(normalized);
    };
    const catalog = availableOptions.filter((option) => !isAliasOption(option, hasGroups) && matchesQuery(option));
    const aliasList = availableOptions.filter((option) => isAliasOption(option, hasGroups) && matchesQuery(option));
    // 私有模型单独一节(最上面),推荐 / 更多里不重复出现。每一节里能用的在前(availableFirst 保持服务端顺序)
    const own = availableFirst(catalog.filter((option) => option.private));
    const rec = availableFirst(catalog.filter((option) => option.recommended && !option.private));
    const rest = availableFirst(catalog.filter((option) => !option.recommended && !option.private));
    const groups: Array<{ id: string; label: string; options: ModelOption[] }> = [];
    for (const vendor of MODEL_VENDORS) {
      const options = rest.filter((option) => optionVendor(option) === vendor.id);
      if (options.length > 0) groups.push({ id: vendor.id, label: vendor.label, options });
    }
    const unknown = rest.filter((option) => !optionVendor(option));
    if (unknown.length > 0) groups.push({ id: 'other', label: t('commandResult.models.otherVendor'), options: unknown });
    return { privateModels: own, recommended: rec, moreByVendor: groups, aliases: aliasList };
  }, [availableOptions, hasGroups, query, mappingsState.configMappings, t]);

  const moreCount = moreByVendor.reduce((sum, group) => sum + group.options.length, 0);
  const catalogCount = privateModels.length + recommended.length + moreCount;
  /*
   * 目录里有模型时别名不当选项(与输入框的模型菜单同一口径,见 splitModelMenu):
   * 子代理默认跟随主模型,别名只在 Claude 派子代理时点名 sonnet/opus/haiku/fable、或 CLI 内部小活时路由用。
   * 这时别名组只给 root 看(只读,带「实测别名」排查网关路由);目录为空(如官方 API)时别名可选。
   */
  const currentIsAlias = currentOption ? isAliasOption(currentOption, hasGroups) : !hasGroups;
  const aliasSources = { probed: mappingsState.mappings, configured: mappingsState.configMappings, stale: mappingsState.stale };
  const currentAliasReal = currentIsAlias ? resolveAliasReal(currentValue, aliasSources) : null;
  const catalogTotal = availableOptions.filter((option) => !isAliasOption(option, hasGroups)).length;
  const aliasesSelectable = catalogTotal === 0;
  const showAliasSection = aliases.length > 0 && (aliasesSelectable || isRoot);
  // 别名组:用户没动过 —— 可选时(目录为空)展开;只读时折叠,除非搜索结果里一条目录模型都没有
  const aliasExpanded = aliasOpen ?? (aliasesSelectable || catalogCount === 0);

  const hasConcreteSessionId = typeof currentSessionId === 'string' && currentSessionId.trim().length > 0;
  const used = typeof contextUsedTokens === 'number' && Number.isFinite(contextUsedTokens) ? contextUsedTokens : null;

  const scheduleAutoClose = () => {
    if (autoCloseTimerRef.current !== null) window.clearTimeout(autoCloseTimerRef.current);
    autoCloseTimerRef.current = window.setTimeout(() => {
      autoCloseTimerRef.current = null;
      onClose();
    }, 650);
  };

  const labelOf = (value: string): string => availableOptions.find((option) => option.value === value)?.label || value;

  const handleSelectModel = async (model: string) => {
    // 不能用的模型点不了(行本身已不是按钮;这里再挡一道)
    if (!isModelAvailable(availableOptions.find((option) => option.value === model))) return;
    setChangingModel(model);
    try {
      const result = await onSelectProviderModel(currentProvider, model, currentSessionId);
      if (result.scope === 'session') {
        setPendingSessionModel(result.model);
        setSelectionNotice(t('commandResult.models.switchedNext', { model: labelOf(result.model) }));
      } else {
        setPendingSessionModel(null);
        setSelectionNotice(t('commandResult.models.setDefault', { model: labelOf(result.model) }));
      }
      scheduleAutoClose();
    } catch (error) {
      setSelectionNotice(error instanceof Error ? error.message : t('commandResult.changeModelFailed'));
    } finally {
      setChangingModel(null);
    }
  };

  const renderCatalogRow = (option: ModelOption, index: number) => {
    const isCurrent = option.value === currentValue;
    const isPending = option.value === pendingSessionModel;
    const isChanging = option.value === changingModel;
    const windowTokens = typeof option.contextWindow === 'number' ? option.contextWindow : null;
    const windowBadge = formatContextWindow(windowTokens);
    const compactLine = windowTokens ? windowTokens - AUTO_COMPACT_MARGIN : null;
    const tooLarge = !isCurrent && used !== null && compactLine !== null && used >= compactLine;
    const label = option.label || option.value;
    const efforts = option.effort?.values?.map((value) => value.value) ?? [];
    // 不能用(网关没 key / 停用)的整行不是按钮:里面可能有「去填 key」按钮,按钮不能套按钮
    const unavailable = !isModelAvailable(option);
    const Row = unavailable ? 'div' : 'button';
    return (
      <Row
        key={option.value}
        {...(unavailable
          ? {}
          : {
            type: 'button' as const,
            onClick: () => handleSelectModel(option.value),
            disabled: Boolean(changingModel),
            'aria-label': `Select model ${option.value}`,
          })}
        data-model-row={option.value}
        data-model-unavailable={unavailable ? 'true' : undefined}
        className={`settings-content-enter group flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60 ${
          isCurrent
            ? 'border-primary/45 bg-primary/10'
            : isPending
              ? 'border-primary/[0.32] bg-primary/[0.08]'
              : unavailable
                ? 'cursor-not-allowed border-dashed border-border bg-card'
                : 'border-border bg-card hover:border-primary/30 hover:bg-background'
        }`}
        style={{ animationDelay: `${Math.min(index * 14, 180)}ms` }}
      >
        <span className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md border border-border bg-background text-foreground ${unavailable ? 'opacity-50 grayscale' : ''}`}>
          <ModelVendorIcon vendor={option.vendor} modelId={option.realModel || option.value} label={label} size={16} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className={`truncate text-sm font-semibold ${unavailable ? 'text-muted-foreground' : 'text-foreground'}`}>{label}</span>
            {option.private && (
              <span className="rounded bg-muted px-1.5 py-px text-[10px] leading-4 text-muted-foreground">{t('modelMenu.privateBadge')}</span>
            )}
            {windowBadge && (
              <span
                className="rounded border border-border bg-muted px-1 py-px font-mono text-[10px] leading-4 text-muted-foreground"
                title={t('commandResult.models.windowTitle', { tokens: windowTokens?.toLocaleString() })}
              >
                {windowBadge}
              </span>
            )}
            {efforts.length > 0 && (
              <span className="text-[10px] leading-4 text-muted-foreground" title={efforts.join(' / ')}>
                {t('commandResult.models.effortLevels', { count: efforts.length })}
              </span>
            )}
            {/* 不在默认网关上的模型标网关名 */}
            {option.gatewayName && (
              <span className="truncate text-[10px] leading-4 text-muted-foreground" title={`${t('commandResult.models.gatewayVia')} ${option.gatewayName}`}>
                {option.gatewayName}
              </span>
            )}
          </span>
          {label !== option.value && (
            <span className="mt-0.5 block truncate font-mono text-[11px] leading-4 text-muted-foreground">{option.value}</span>
          )}
          {option.description && (
            <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">{option.description}</span>
          )}
          {unavailable && (
            <span className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px] leading-4 text-muted-foreground">
              <span>{option.unavailableReason || t('modelMenu.unavailable')}</span>
              {onOpenKeySettings && canFixWithKey(option) && (
                <button
                  type="button"
                  data-model-key-link={option.value}
                  onClick={() => {
                    onClose();
                    onOpenKeySettings();
                  }}
                  className="rounded font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {t('modelMenu.fillKey')}
                </button>
              )}
            </span>
          )}
          {tooLarge && !unavailable && (
            <span className="mt-1 flex items-start gap-1 text-[11px] leading-4 text-amber-700 dark:text-amber-400">
              <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
              {t('commandResult.models.tooLarge', { used: used?.toLocaleString(), line: compactLine?.toLocaleString() })}
            </span>
          )}
          {isPending && !isCurrent && (
            <span className="mt-1 block text-[11px] font-semibold uppercase tracking-[0.14em] text-foreground dark:text-primary">
              {t('commandResult.models.appliesNext', { defaultValue: '下一次回复起生效' })}
            </span>
          )}
        </span>
        {isCurrent ? (
          <BadgeCheck className="mt-1 h-4 w-4 shrink-0 text-primary" aria-label={t('commandResult.models.current')} />
        ) : isChanging ? (
          <RefreshCw className="mt-1 h-4 w-4 shrink-0 animate-spin text-primary" />
        ) : null}
      </Row>
    );
  };

  const renderAliasRow = (option: ModelOption, index: number) => {
    const isCurrent = option.value === currentValue;
    const isPending = option.value === pendingSessionModel;
    const isChanging = option.value === changingModel;
    // 第一行是这一档在 settings.json 里配到的真实模型,别名退到第二行 —— 挑的时候先要知道"会打到哪个模型上"。
    const cardConfig = mappingsState.configMappings[option.value];
    const configModel = cardConfig?.configuredModel ?? null;
    const aliasLine = configModel
      ? [option.value, option.label && option.label !== option.value ? option.label : null].filter(Boolean).join(' · ')
      : (option.label && option.label !== option.value ? option.label : '');
    const mapping = mappingsState.mappings[option.value];
    // 实测过期时不展示实测行 —— 配置值此刻才是新值。
    const probedModel = !mappingsState.stale && mapping?.actualModel ? mapping.actualModel : null;
    const rows: ReactNode[] = [];
    if (probedModel && probedModel !== configModel) {
      const ago = mapping ? formatCheckedAgo(mapping.checkedAt) : '';
      rows.push(
        <span key="probe" className="mt-1 flex flex-wrap items-baseline gap-x-1.5 text-[11px] leading-4">
          <span className="text-muted-foreground">{t('commandResult.models.probedLabel', { defaultValue: '实测' })}</span>
          <span className="font-mono font-semibold text-foreground">{probedModel}</span>
          {ago && <span className="text-muted-foreground">· {ago}</span>}
        </span>,
      );
      if (configModel) {
        rows.push(
          <span key="mismatch" className="mt-1 text-[11px] leading-4 text-muted-foreground">
            {t('commandResult.models.probeMismatch', {
              configured: configModel,
              probed: probedModel,
              defaultValue: '⚠ 实测与配置不一致:网关把「{{configured}}」改写成了「{{probed}}」',
            })}
          </span>,
        );
      }
    } else if (probedModel && probedModel === configModel) {
      const ago = mapping ? formatCheckedAgo(mapping.checkedAt) : '';
      rows.push(
        <span key="verified" className="mt-1 text-[11px] leading-4 text-muted-foreground">
          {t('commandResult.models.probeVerified', { defaultValue: '实测一致' })}{ago ? ` · ${ago}` : ''}
        </span>,
      );
    } else if (!probedModel && !configModel && mapping && !mapping.actualModel) {
      rows.push(
        <span key="error" className="mt-1.5 text-[11px] leading-4 text-muted-foreground">
          {t('commandResult.models.probeError', {
            error: mapping.error || t('commandResult.models.unknownReason', { defaultValue: '未知原因' }),
            defaultValue: '实测失败:{{error}}',
          })}
        </span>,
      );
    }
    const real = resolveAliasReal(option.value, aliasSources);
    // 目录里有模型时别名只读(看路由用),不能点选
    const Row = aliasesSelectable ? 'button' : 'div';
    return (
      <Row
        key={option.value}
        {...(aliasesSelectable
          ? {
            type: 'button' as const,
            onClick: () => handleSelectModel(option.value),
            disabled: Boolean(changingModel),
            'aria-label': `Select model ${option.value}`,
          }
          : {})}
        data-model-row={option.value}
        data-alias-readonly={aliasesSelectable ? undefined : 'true'}
        className={`settings-content-enter flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60 ${
          isCurrent
            ? 'border-primary/45 bg-primary/10'
            : isPending
              ? 'border-primary/[0.32] bg-primary/[0.08]'
              : aliasesSelectable
                ? 'border-border bg-card hover:border-primary/30 hover:bg-background'
                : 'border-border bg-card'
        }`}
        style={{ animationDelay: `${Math.min(index * 14, 180)}ms` }}
      >
        <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md border border-border bg-background text-foreground">
          {/* 没配映射(官方 API)时别名就是 Claude 自己的档位 */}
          <ModelVendorIcon vendor={real ? null : 'claude'} modelId={real || option.value} label={real || option.value} size={16} />
        </span>
        <span className="min-w-0 flex-1">
          <span
            className="block break-all font-mono text-sm font-semibold text-foreground"
            title={cardConfig?.source
              ? t('commandResult.models.configSource', { source: cardConfig.source, defaultValue: '来源:{{source}}(settings.json,实时)' })
              : undefined}
          >
            {configModel ?? option.value}
          </span>
          {aliasLine && <span className="mt-0.5 block break-all font-mono text-[11px] leading-4 text-muted-foreground">{aliasLine}</span>}
          {rows.length > 0 && <span className="flex flex-col">{rows}</span>}
          {isPending && !isCurrent && (
            <span className="mt-1 block text-[11px] font-semibold uppercase tracking-[0.14em] text-foreground dark:text-primary">
              {t('commandResult.models.appliesNext', { defaultValue: '下一次回复起生效' })}
            </span>
          )}
        </span>
        {isCurrent ? (
          <BadgeCheck className="mt-1 h-4 w-4 shrink-0 text-primary" aria-label={t('commandResult.models.current')} />
        ) : isChanging ? (
          <RefreshCw className="mt-1 h-4 w-4 shrink-0 animate-spin text-primary" />
        ) : null}
      </Row>
    );
  };

  const currentLabel = currentOption?.label || currentValue;
  const currentWindow = formatContextWindow(typeof currentOption?.contextWindow === 'number' ? currentOption.contextWindow : null);
  const nothingMatches = catalogCount === 0 && (!showAliasSection || aliases.length === 0);
  let rowIndex = 0;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* 当前模型 + 刷新 */}
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3.5 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-border bg-background text-foreground">
            <ModelVendorIcon
              vendor={currentOption?.vendor}
              modelId={currentOption?.realModel || (currentIsAlias ? currentModel : currentValue)}
              label={currentLabel}
              size={18}
            />
          </span>
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              {t('commandResult.activeModel')} · {providerLabel}
            </p>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="break-all text-sm font-semibold text-foreground">{currentLabel}</span>
              {currentWindow && (
                <span className="rounded border border-border bg-muted px-1 py-px font-mono text-[10px] leading-4 text-muted-foreground">{currentWindow}</span>
              )}
              {/* 别名:它此刻实际打到的模型,与输入框芯片同一判据(resolveAliasReal) */}
              {currentAliasReal && (
                <span className="break-all font-mono text-[11px] text-muted-foreground">→ {currentAliasReal}</span>
              )}
              {pendingSessionModel && pendingSessionModel !== currentValue && (
                <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-foreground dark:text-primary">
                  {t('commandResult.nextBadge', { model: labelOf(pendingSessionModel) })}
                </span>
              )}
            </p>
            {/* 当前模型此刻对当前用户不可用:不悄悄换,说清楚原因(发出去服务端也会这么回) */}
            {currentOption && !isModelAvailable(currentOption) && (
              <p className="mt-0.5 flex items-start gap-1 text-[11px] leading-4 text-amber-700 dark:text-amber-400">
                <AlertTriangle className="mt-px h-3 w-3 shrink-0" aria-hidden />
                <span>{currentOption.unavailableReason || t('modelMenu.unavailable')}</span>
              </p>
            )}
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onHardRefreshProviderModels}
          disabled={providerModelsRefreshing}
          title={t('commandResult.refreshModels')}
          aria-label={t('commandResult.refreshModels')}
          className="h-9 w-9 shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
        >
          <RefreshCw className={`h-4 w-4 ${providerModelsRefreshing ? 'animate-spin text-primary' : ''}`} />
        </Button>
      </div>

      {/* 搜索常驻 */}
      <div className="relative shrink-0">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('commandResult.models.searchPlaceholder', { provider: providerLabel, defaultValue: `搜索 ${providerLabel} 模型…` })}
          className="h-10 rounded-lg border-border bg-card pl-9 pr-3 shadow-none focus-visible:ring-primary/40"
        />
      </div>

      <div className="scrollbar-thin -mr-1 min-h-0 flex-1 overflow-y-auto pr-1">
        {hasGroups && catalogCount === 0 && !query.trim() && (
          <p className="rounded-lg border border-dashed border-border bg-card px-3 py-3 text-[12px] leading-5 text-muted-foreground">
            {t('commandResult.models.emptyCatalog')}
          </p>
        )}

        {privateModels.length > 0 && (
          <>
            <SectionTitle>{t('commandResult.models.privateModels')}</SectionTitle>
            <div className="grid gap-2 md:grid-cols-2">
              {privateModels.map((option) => renderCatalogRow(option, rowIndex++))}
            </div>
          </>
        )}

        {recommended.length > 0 && (
          <>
            <SectionTitle>{t('commandResult.models.recommended')}</SectionTitle>
            <div className="grid gap-2 md:grid-cols-2">
              {recommended.map((option) => renderCatalogRow(option, rowIndex++))}
            </div>
          </>
        )}

        {moreByVendor.length > 0 && (
          <>
            <SectionTitle>{recommended.length > 0 || privateModels.length > 0 ? t('commandResult.models.more') : t('commandResult.models.allModels')}</SectionTitle>
            {/* 按厂商排好;条目多(> 6)才画厂商小标题,少的时候一张网格排下,图标已经标明厂商 */}
            {moreCount > 6 ? (
              <div className="space-y-2.5">
                {moreByVendor.map((group) => (
                  <div key={group.id}>
                    <p className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                      {group.id !== 'other' && <ModelVendorIcon vendor={group.id} size={12} />}
                      {group.label}
                    </p>
                    <div className="grid gap-2 md:grid-cols-2">
                      {group.options.map((option) => renderCatalogRow(option, rowIndex++))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="grid gap-2 md:grid-cols-2">
                {moreByVendor.flatMap((group) => group.options).map((option) => renderCatalogRow(option, rowIndex++))}
              </div>
            )}
          </>
        )}

        {showAliasSection && (
          <>
            <SectionTitle
              trailing={isRoot && aliasExpanded ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleProbeMappings}
                  disabled={probing}
                  title={t('commandResult.models.probeAliasesTitle', { defaultValue: '对每个别名各发一次最小请求,读出网关实际使用的模型' })}
                  className="h-7 gap-1.5 rounded-md px-2 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  <Radar className={`h-3.5 w-3.5 ${probing ? 'text-primary' : ''}`} />
                  {probing ? t('commandResult.models.probing') : t('commandResult.models.probeAliases')}
                </Button>
              ) : null}
            >
              {hasGroups ? (
                <button
                  type="button"
                  onClick={() => setAliasOpen(!aliasExpanded)}
                  aria-expanded={aliasExpanded}
                  className="inline-flex items-center gap-1 uppercase tracking-[0.16em] hover:text-foreground"
                >
                  {aliasExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  {aliasesSelectable ? t('commandResult.models.aliasGroup') : t('commandResult.models.aliasRouting')}
                  <span className="normal-case tracking-normal">({aliases.length})</span>
                </button>
              ) : t('commandResult.models.aliasGroup')}
            </SectionTitle>
            {aliasExpanded && (
              <>
                {mappingsState.stale && (
                  <p className="mb-2 rounded-lg border border-border bg-muted px-3 py-2 text-[11px] leading-4 text-muted-foreground">
                    {t('commandResult.models.probeStale', { defaultValue: '模型配置(settings.json)在上次实测后已变更 —— 下方「实测」行可能过期。' })}
                  </p>
                )}
                <p className="mb-2 text-[11px] leading-4 text-muted-foreground">
                  {aliasesSelectable ? t('commandResult.models.aliasHint') : t('commandResult.models.aliasRoutingHint')}
                  {mappingsState.gatewayHost && (
                    <> · {t('commandResult.models.gatewayVia')} <span className="font-mono">{mappingsState.gatewayHost}</span></>
                  )}
                </p>
                <div className="grid gap-2 md:grid-cols-2">
                  {aliases.map((option) => renderAliasRow(option, rowIndex++))}
                </div>
              </>
            )}
          </>
        )}

        {nothingMatches && (
          <div className="rounded-lg border border-dashed border-border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
            {t('commandResult.models.noMatch')}
          </div>
        )}
      </div>

      {/* 一行说明 / 反馈 */}
      <p className="shrink-0 text-[11px] leading-4 text-muted-foreground">
        {selectionNotice ? (
          <span className="text-foreground">{selectionNotice}</span>
        ) : hasConcreteSessionId ? (
          t('commandResult.sessionScopeNote')
        ) : (
          t('commandResult.defaultScopeNote')
        )}
      </p>
    </div>
  );
}
