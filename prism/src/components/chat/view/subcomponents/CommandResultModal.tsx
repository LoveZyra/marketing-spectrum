import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Activity,
  BadgeCheck,
  CircleHelp,
  Coins,
  Cpu,
  Gauge,
  Package,
  Search,
  Server,
  Sparkles,
  TerminalSquare,
  Timer,
  RefreshCw,
  Radar,
  X,
} from 'lucide-react';

import { Badge, Button, Dialog, DialogContent, DialogTitle, Input } from '../../../../shared/view/ui';
import { authenticatedFetch } from '../../../../utils/api';
import type { LLMProvider, ProviderModelsCacheInfo, ProviderModelsDefinition } from '../../../../types/app';
import type {
  CommandModalPayload,
  CostCommandData,
  HelpCommandData,
  ModelCommandData,
  StatusCommandData,
} from '../../hooks/useChatComposerState';

type CommandResultModalProps = {
  payload: CommandModalPayload | null;
  onClose: () => void;
  providerModelCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>;
  providerModelCacheCatalog: Partial<Record<LLMProvider, ProviderModelsCacheInfo>>;
  providerModelsRefreshing: boolean;
  onHardRefreshProviderModels: () => void;
  currentSessionId: string | null;
  onSelectProviderModel: (
    provider: LLMProvider,
    model: string,
    sessionId?: string | null,
  ) => Promise<{
    scope: 'default' | 'session';
    changed: boolean;
    model: string;
  }>;
};

type CommandEntry = {
  name: string;
  description?: string;
  namespace?: string;
};

type ModelOption = {
  value: string;
  label?: string;
  description?: string;
};

// Keyed by the `provider` string the server echoes back on a command result.
// Cursor, Codex and OpenCode used to have entries here; anything unrecognised
// still falls through to the raw string below rather than the fallback.
const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude',
};

const FALLBACK_COMMANDS: CommandEntry[] = [
  { name: '/models', description: 'Browse available models for the active provider.' },
  { name: '/cost', description: 'Review token usage for the active session.' },
  { name: '/status', description: 'Inspect runtime, version, provider, and environment status.' },
  { name: '/memory', description: 'Open the project CLAUDE.md memory file.' },
  { name: '/config', description: 'Open settings and configuration.' },
  { name: '/help', description: 'Show command documentation and syntax.' },
];

const getProviderLabel = (provider: string | undefined, fallback = 'Unknown') => {
  if (!provider) {
    return fallback;
  }

  return PROVIDER_LABELS[provider] || provider;
};

const formatNumber = (value: number) => {
  if (!Number.isFinite(value)) {
    return '0';
  }
  return value.toLocaleString();
};

function MetricCard({
  label,
  value,
  icon: Icon,
  tone = 'neutral',
  compact = false,
}: {
  label: string;
  value: string;
  icon: typeof Activity;
  tone?: 'neutral' | 'primary' | 'success';
  compact?: boolean;
}) {
  const toneClass =
    tone === 'primary'
      ? 'border-primary/35 bg-primary/10 text-primary'
      : tone === 'success'
        ? 'border-primary/[0.32] bg-primary/[0.08] text-primary'
        : 'border-border bg-background text-muted-foreground';

  return (
    <div
      className={`group rounded-lg border border-border bg-card transition-colors duration-200 hover:border-primary/25 ${
        compact ? 'p-3' : 'p-4'
      }`}
    >
      <div className={`inline-flex rounded-lg border ${compact ? 'mb-2 p-1.5' : 'mb-3 p-2'} ${toneClass}`}>
        <Icon className={compact ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
      </div>
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
      <p className={`${compact ? 'mt-0.5 text-[13px]' : 'mt-1 text-sm'} break-all font-semibold text-foreground`}>{value}</p>
    </div>
  );
}

function SearchField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-10 rounded-lg border-border bg-card pl-9 pr-3 shadow-none focus-visible:ring-primary/40"
      />
    </div>
  );
}

function HelpContent({ data }: { data: HelpCommandData }) {
  const [query, setQuery] = useState('');
  const commands = (Array.isArray(data.commands) && data.commands.length > 0
    ? data.commands
    : FALLBACK_COMMANDS) as CommandEntry[];

  const filteredCommands = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return commands;
    }

    return commands.filter((command) => {
      const haystack = `${command.name} ${command.description || ''} ${command.namespace || ''}`.toLowerCase();
      return haystack.includes(normalized);
    });
  }, [commands, query]);

  return (
    <div className="grid h-full min-h-0 gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <div className="flex min-h-0 flex-col gap-3">
        <SearchField value={query} onChange={setQuery} placeholder="Filter commands..." />

        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto pr-1">
          <div className="grid gap-2 sm:grid-cols-2">
            {filteredCommands.map((command, index) => (
              <div
                key={`${command.namespace || 'builtin'}-${command.name}`}
                className="settings-content-enter rounded-lg border border-border bg-card p-3 transition-colors duration-200 hover:border-primary/30"
                style={{ animationDelay: `${Math.min(index * 18, 160)}ms` }}
              >
                <div className="flex items-start justify-between gap-3">
                  <code className="rounded-lg border border-primary/20 bg-primary/10 px-2 py-1 text-xs font-semibold text-foreground dark:text-primary">
                    {command.name}
                  </code>
                  <Badge variant="secondary" className="shrink-0 text-[10px] capitalize">
                    {command.namespace || 'builtin'}
                  </Badge>
                </div>
                <p className="mt-3 text-sm leading-5 text-muted-foreground">
                  {command.description || 'No description available.'}
                </p>
              </div>
            ))}
          </div>

          {filteredCommands.length === 0 && (
            <div className="rounded-lg border border-dashed border-border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
              No commands match that filter.
            </div>
          )}
        </div>
      </div>

      <aside className="space-y-3">
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
            <TerminalSquare className="h-4 w-4 text-primary" />
            Syntax
          </div>
          <div className="space-y-2 text-sm text-muted-foreground">
            <p><code className="text-foreground">/command arg1 arg2</code></p>
            <p><code className="text-foreground">$ARGUMENTS</code> passes all args.</p>
            <p><code className="text-foreground">$1</code>, <code className="text-foreground">$2</code> pass positional args.</p>
            <p><code className="text-foreground">@file</code> includes file contents.</p>
          </div>
        </div>

        <div className="rounded-lg border border-primary/25 bg-primary/10 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
            <Sparkles className="h-4 w-4 text-primary" />
            Quick tip
          </div>
          <p className="text-sm leading-5 text-muted-foreground">
            Type <code className="text-foreground">/</code> in the composer to open the command palette, then use arrows and Enter to run a command.
          </p>
        </div>
      </aside>
    </div>
  );
}

/**
 * 别名 → 真实模型的实测结果,由后端探测(逐别名各发一次最小请求)后缓存。
 *
 * ANTHROPIC_BASE_URL 指向自定义网关时,界面上选 "sonnet" 实际由哪个模型来答
 * 是网关说了算。所以卡片第一行直接摆**配置里的真实模型名**,Claude 侧的档名
 * 退到第二行 —— 挑模型时先要知道的是"会打到哪个模型上"。
 */
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

/** "3 分钟前 / 2 小时前 / 5 天前" —— 映射是网关配置,新鲜度比精确时刻有用。 */
function formatCheckedAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '刚刚实测';
  if (minutes < 60) return `${minutes} 分钟前实测`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前实测`;
  return `${Math.floor(hours / 24)} 天前实测`;
}

function ModelsContent({
  data,
  providerModelCatalog,
  providerModelsRefreshing,
  onHardRefreshProviderModels,
  currentSessionId,
  onSelectProviderModel,
  onClose,
}: {
  data: ModelCommandData;
  providerModelCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>;
  providerModelsRefreshing: boolean;
  onHardRefreshProviderModels: () => void;
  currentSessionId: string | null;
  onSelectProviderModel: CommandResultModalProps['onSelectProviderModel'];
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [changingModel, setChangingModel] = useState<string | null>(null);
  const [pendingSessionModel, setPendingSessionModel] = useState<string | null>(null);
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);
  // 选中成功后短暂显示确认再自动关弹窗。用 ref 存 timer,卸载时清掉,避免关到
  // 已经不在的组件上。
  const autoCloseTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (autoCloseTimerRef.current !== null) {
      window.clearTimeout(autoCloseTimerRef.current);
    }
  }, []);
  const [mappingsState, setMappingsState] = useState<ModelMappingsState>({ mappings: {}, configMappings: {}, gatewayHost: null, stale: false });
  const [probing, setProbing] = useState(false);
  const currentProvider = (data?.current?.provider || 'claude') as LLMProvider;

  // 打开弹窗时读缓存的实测映射。只读缓存,不触发探测 —— 探测要花真实的 API
  // 调用,必须是显式动作。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await authenticatedFetch(`/api/providers/${currentProvider}/model-mappings`);
        if (!response.ok) return;
        const payload = (await response.json()) as {
          data?: {
            mappings?: Record<string, ModelMappingEntry>;
            configMappings?: Record<string, ModelConfigMappingEntry>;
            gatewayHost?: string | null;
            stale?: boolean;
          };
        };
        if (!cancelled && payload.data) {
          setMappingsState({
            mappings: payload.data.mappings ?? {},
            configMappings: payload.data.configMappings ?? {},
            gatewayHost: payload.data.gatewayHost ?? null,
            stale: payload.data.stale === true,
          });
        }
      } catch {
        // 拿不到就不显示映射行,卡片照常可用。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentProvider]);

  const handleProbeMappings = async () => {
    setProbing(true);
    try {
      const response = await authenticatedFetch(`/api/providers/${currentProvider}/model-mappings/probe`, {
        method: 'POST',
      });
      if (!response.ok) throw new Error(`探测失败(HTTP ${response.status})`);
      const payload = (await response.json()) as {
        data?: {
          mappings?: Record<string, ModelMappingEntry>;
          configMappings?: Record<string, ModelConfigMappingEntry>;
          gatewayHost?: string | null;
          stale?: boolean;
        };
      };
      if (payload.data) {
        setMappingsState({
          mappings: payload.data.mappings ?? {},
          configMappings: payload.data.configMappings ?? {},
          gatewayHost: payload.data.gatewayHost ?? null,
          stale: payload.data.stale === true,
        });
      }
    } catch (error) {
      setSelectionNotice(error instanceof Error ? error.message : '探测失败');
    } finally {
      setProbing(false);
    }
  };
  const currentModel = data?.current?.model || 'Unknown';
  const providerLabel = data?.current?.providerLabel || getProviderLabel(currentProvider);
  const liveDefinition = providerModelCatalog[currentProvider];
  const availableOptions = useMemo<ModelOption[]>(() => {
    if (liveDefinition?.OPTIONS && liveDefinition.OPTIONS.length > 0) {
      return liveDefinition.OPTIONS;
    }

    if (Array.isArray(data?.availableOptions) && data.availableOptions.length > 0) {
      return data.availableOptions;
    }

    const availableModels = Array.isArray(data?.availableModels) ? data.availableModels : [];
    return availableModels.map((model) => ({ value: model, label: model }));
  }, [data, liveDefinition]);
  const filteredOptions = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return availableOptions;
    }

    return availableOptions.filter((option) => {
      // 卡片第一行现在是配置的真实模型名,搜索也得能按它命中。
      const configured = mappingsState.configMappings[option.value]?.configuredModel || '';
      const haystack = `${option.value} ${option.label || ''} ${configured} ${option.description || ''}`.toLowerCase();
      return haystack.includes(normalized);
    });
  }, [availableOptions, query, mappingsState.configMappings]);

  const hasConcreteSessionId = typeof currentSessionId === 'string' && currentSessionId.trim().length > 0;
  const showSearch = availableOptions.length > 6;

  // 成功切换后短暂延时再关弹窗:让绿色确认("下一条生效")闪一下,读起来是
  // "切换完成、自动收起",而不是默默无反应。失败则不关,把错误留在弹窗里。
  const scheduleAutoClose = () => {
    if (autoCloseTimerRef.current !== null) {
      window.clearTimeout(autoCloseTimerRef.current);
    }
    autoCloseTimerRef.current = window.setTimeout(() => {
      autoCloseTimerRef.current = null;
      onClose();
    }, 650);
  };

  const handleSelectModel = async (model: string) => {
    setChangingModel(model);
    try {
      const result = await onSelectProviderModel(currentProvider, model, currentSessionId);
      if (result.scope === 'session') {
        setPendingSessionModel(result.model);
        setSelectionNotice(`已切换 · 下一条消息将用 ${result.model}`);
      } else {
        setPendingSessionModel(null);
        setSelectionNotice(`已设为默认模型：${result.model}`);
      }
      // 切换成功 —— 自动收起弹窗(用户要的"切换后直接关闭")。
      scheduleAutoClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to change the model right now.';
      setSelectionNotice(message);
    } finally {
      setChangingModel(null);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* Compact context bar: active model + refresh, no clutter */}
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3.5 py-2.5">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Active model · {providerLabel}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="break-all font-mono text-sm font-semibold text-foreground">{currentModel}</span>
            {pendingSessionModel && pendingSessionModel !== currentModel && (
              <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-foreground dark:text-primary">
                → {pendingSessionModel} next
              </span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleProbeMappings}
            disabled={probing}
            title="对每个别名各发一次最小请求,读出网关实际使用的模型"
            className="h-9 shrink-0 gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <Radar className={`h-4 w-4 ${probing ? 'text-primary' : ''}`} />
            {probing ? '实测中…' : '实测真实模型'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onHardRefreshProviderModels}
            disabled={providerModelsRefreshing}
            title="Refresh model list from providers"
            aria-label="Refresh model list from providers"
            className="h-9 w-9 shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className={`h-4 w-4 ${providerModelsRefreshing ? 'text-primary' : ''}`} />
          </Button>
        </div>
      </div>

      {/* settings.json 在上次实测后改过 —— 实测值可能已过期,提醒重测。 */}
      {mappingsState.stale && (
        <p className="shrink-0 rounded-lg border border-border bg-muted px-3 py-2 text-[11px] leading-4 text-muted-foreground">
          模型配置(settings.json)在上次实测后已变更 —— 下方「实际模型」可能过期。
          点右上「实测真实模型」重测一次即可更新。
        </p>
      )}

      {/* 自定义网关提示。官方 API(gatewayHost 为空)下不显示 —— 那时不存在改写。 */}
      {mappingsState.gatewayHost && (
        <p className="shrink-0 rounded-lg border border-border bg-muted px-3 py-2 text-[11px] leading-4 text-muted-foreground">
          本部署经由网关 <span className="font-mono">{mappingsState.gatewayHost}</span> 转发。
          每张卡片第一行是这一档在 settings.json 里配到的真实模型,第二行是它在 Claude 侧的档名。
          想确认网关真的这么走,点右上「实测真实模型」。
        </p>
      )}

      {showSearch && (
        <SearchField value={query} onChange={setQuery} placeholder={`Search ${providerLabel} models...`} />
      )}

      {filteredOptions.length > 0 ? (
        <div className="scrollbar-thin -mr-1 min-h-0 flex-1 overflow-y-auto pr-1">
          <div className="grid gap-2 md:grid-cols-2">
            {filteredOptions.map((option, index) => {
              const isCurrent = option.value === currentModel;
              const isPendingSelection = option.value === pendingSessionModel;
              const isChanging = option.value === changingModel;
              // 卡片第一行是**这一档实际会用到的模型**(settings.json 里配的那个),
              // Claude 侧的档名退到第二行当注脚 —— 挑模型时先看的是"会打到哪个模型上",
              // 而不是"这一档在 Claude 那边叫什么"。没配映射时第一行就退回档名本身。
              const cardConfig = mappingsState.configMappings[option.value];
              const cardConfigModel = cardConfig?.configuredModel ?? null;
              const cardAliasLine = cardConfigModel
                ? [option.value, option.label && option.label !== option.value ? option.label : null]
                  .filter(Boolean).join(' · ')
                : (option.label && option.label !== option.value ? option.label : '');
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => handleSelectModel(option.value)}
                  disabled={Boolean(changingModel)}
                  aria-label={`Select model ${option.value}`}
                  className={`settings-content-enter group flex min-h-16 flex-col rounded-lg border p-3 text-left transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60 ${
                    isCurrent
                      ? 'border-primary/45 bg-primary/10'
                      : isPendingSelection
                        ? 'border-primary/[0.32] bg-primary/[0.08]'
                        : 'border-border bg-card hover:border-primary/30 hover:bg-background'
                  }`}
                  style={{ animationDelay: `${Math.min(index * 14, 180)}ms` }}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span
                      className="break-all font-mono text-sm font-semibold text-foreground"
                      title={cardConfig?.source ? `来源:${cardConfig.source}(settings.json,实时)` : undefined}
                    >
                      {cardConfigModel ?? option.value}
                    </span>
                    {isCurrent ? (
                      <BadgeCheck className="h-4 w-4 shrink-0 text-primary" />
                    ) : isChanging ? (
                      <RefreshCw className="h-4 w-4 shrink-0 text-primary" />
                    ) : null}
                  </span>
                  {cardAliasLine && (
                    <span className="mt-1 break-all font-mono text-[11px] leading-4 text-muted-foreground">
                      {cardAliasLine}
                    </span>
                  )}
                  {(() => {
                    const mapping = mappingsState.mappings[option.value];
                    const configModel = cardConfigModel;
                    // 实测过期时不展示实测行 —— 第一行的配置值此刻才是新值。
                    const probedModel = !mappingsState.stale && mapping?.actualModel ? mapping.actualModel : null;
                    const rows: ReactNode[] = [];

                    // 实测行:端到端验证(网关那一跳)。与配置一致就不重复占一行。
                    if (probedModel && probedModel !== configModel) {
                      const ago = mapping ? formatCheckedAgo(mapping.checkedAt) : '';
                      rows.push(
                        <span key="probe" className="mt-1 flex flex-wrap items-baseline gap-x-1.5 text-[11px] leading-4">
                          <span className="text-muted-foreground">实测</span>
                          <span className="font-mono font-semibold text-foreground">{probedModel}</span>
                          {ago && <span className="text-muted-foreground">· {ago}</span>}
                        </span>,
                      );
                      if (configModel) {
                        // 两层不一致 = 网关在改写 CLI 发出的名字 —— 这是重要信号,不是显示错误。
                        rows.push(
                          <span key="mismatch" className="mt-1 text-[11px] leading-4 text-muted-foreground">
                            ⚠ 实测与配置不一致:网关把「{configModel}」改写成了「{probedModel}」
                          </span>,
                        );
                      }
                    } else if (probedModel && probedModel === configModel) {
                      const ago = mapping ? formatCheckedAgo(mapping.checkedAt) : '';
                      rows.push(
                        <span key="verified" className="mt-1 text-[11px] leading-4 text-muted-foreground">
                          实测一致{ago ? ` · ${ago}` : ''}
                        </span>,
                      );
                    } else if (!probedModel && !configModel && mapping && !mapping.actualModel) {
                      rows.push(
                        <span key="error" className="mt-1.5 text-[11px] leading-4 text-muted-foreground">
                          实测失败:{mapping.error || '未知原因'}
                        </span>,
                      );
                    }

                    return rows.length > 0 ? <>{rows}</> : null;
                  })()}
                  {isCurrent && (
                    <span className="mt-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-foreground dark:text-primary">Current selection</span>
                  )}
                  {isPendingSelection && !isCurrent && (
                    <span className="mt-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-foreground dark:text-primary">
                      Applies next response
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
          No models match that search.
        </div>
      )}

      {/* Single quiet line of guidance / feedback */}
      <p className="shrink-0 text-[11px] leading-4 text-muted-foreground">
        {selectionNotice ? (
          <span className="text-foreground">{selectionNotice}</span>
        ) : hasConcreteSessionId ? (
          'Your choice applies to this session on the next response.'
        ) : (
          'Your choice becomes the default model for new turns.'
        )}
      </p>
    </div>
  );
}

function CostContent({ data }: { data: CostCommandData }) {
  const used = Number(data.tokenUsage?.used ?? 0);
  const total = Number(data.tokenUsage?.total ?? 0);
  const model = data.model || 'Unknown';
  const provider = getProviderLabel(data.provider, data.provider || 'Unknown');
  const hasBreakdown =
    typeof data.tokenBreakdown?.input === 'number' ||
    typeof data.tokenBreakdown?.output === 'number';
  const usageRows = [
    { label: 'Total tokens used', value: formatNumber(used), icon: Activity },
    ...(hasBreakdown
      ? [
          {
            label: 'Input tokens',
            value: formatNumber(Number(data.tokenBreakdown?.input ?? 0)),
            icon: TerminalSquare,
          },
          {
            label: 'Output tokens',
            value: formatNumber(Number(data.tokenBreakdown?.output ?? 0)),
            icon: Coins,
          },
        ]
      : [
          {
            label: 'Breakdown',
            value: 'Unavailable',
            icon: TerminalSquare,
          },
        ]),
    ...(total > 0
      ? [{ label: 'Context window', value: formatNumber(total), icon: Gauge }]
      : []),
  ];

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        {usageRows.map((row) => {
          const Icon = row.icon;

          return (
            <div
              key={row.label}
              className="flex items-center justify-between gap-4 border-b border-border px-4 py-3 last:border-b-0"
            >
              <div className="flex min-w-0 items-center gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-primary/20 bg-primary/10 text-foreground dark:text-primary">
                  <Icon className="h-4 w-4" />
                </span>
                <span className="truncate text-sm font-medium text-foreground">{row.label}</span>
              </div>
              <span className="shrink-0 font-mono text-sm font-semibold text-foreground">{row.value}</span>
            </div>
          );
        })}
      </div>

      <div className="rounded-lg border border-border bg-card p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Provider</p>
            <p className="mt-1 text-sm font-semibold text-foreground">{provider}</p>
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Model</p>
            <p className="mt-1 break-all font-mono text-sm text-foreground">{model}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusContent({ data }: { data: StatusCommandData }) {
  const memoryRssMb = data.memoryUsage?.rssMb;
  const rows = [
    { label: 'Package', value: data.packageName || 'claude-code-ui', icon: Package },
    { label: 'Version', value: data.version || 'Unknown', icon: BadgeCheck, tone: 'success' as const },
    { label: 'Uptime', value: data.uptime || 'Unknown', icon: Timer },
    { label: 'Provider', value: getProviderLabel(data.provider, data.provider || 'Unknown'), icon: Server, tone: 'primary' as const },
    { label: 'Model', value: data.model || 'Unknown', icon: Cpu },
    { label: 'Node.js', value: data.nodeVersion || 'Unknown', icon: TerminalSquare },
    { label: 'Platform', value: data.platform || 'Unknown', icon: Activity },
    { label: 'Memory', value: typeof memoryRssMb === 'number' ? `${memoryRssMb} MB RSS` : 'Unknown', icon: Gauge },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-lg border border-border p-4">
        <div className="flex items-center gap-3">
          <span className="relative flex h-3 w-3">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
            <span className="relative inline-flex h-3 w-3 rounded-full bg-primary" />
          </span>
          <div>
            <p className="text-sm font-semibold text-foreground">Runtime online</p>
            <p className="text-xs text-muted-foreground">Process {data.pid ? `#${data.pid}` : 'status'} is responding.</p>
          </div>
        </div>
        <Badge className="rounded-full bg-primary text-primary-foreground hover:bg-primary">Healthy</Badge>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {rows.map((row) => (
          <MetricCard key={row.label} label={row.label} value={String(row.value)} icon={row.icon} tone={row.tone} />
        ))}
      </div>
    </div>
  );
}

export default function CommandResultModal({
  payload,
  onClose,
  providerModelCatalog,
  providerModelsRefreshing,
  onHardRefreshProviderModels,
  currentSessionId,
  onSelectProviderModel,
}: CommandResultModalProps) {
  const isOpen = Boolean(payload);
  const kind = payload?.kind;
  const isModelsModal = kind === 'models';

  const modalMeta = {
    help: {
      eyebrow: 'Command center',
      title: 'Help & Shortcuts',
      subtitle: 'Search built-ins, syntax patterns, and command usage without leaving the chat.',
      icon: CircleHelp,
    },
    models: {
      eyebrow: 'Model selection',
      title: 'Choose a Model',
      subtitle: 'Pick the model this provider should use.',
      icon: Cpu,
    },
    cost: {
      eyebrow: 'Session telemetry',
      title: 'Token Usage',
      subtitle: 'Input, output, and total token counts for this session.',
      icon: Coins,
    },
    status: {
      eyebrow: 'Runtime health',
      title: 'System Status',
      subtitle: 'Version, provider, runtime, and environment details in one place.',
      icon: Activity,
    },
  } as const;

  const activeMeta = kind ? modalMeta[kind] : null;
  const HeaderIcon = activeMeta?.icon || Sparkles;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="prism-modal-shadow flex h-[min(92dvh,48rem)] w-[calc(100vw-1rem)] max-w-5xl flex-col overflow-hidden rounded-lg border-border bg-popover p-0 sm:w-[min(94vw,64rem)]">
        <DialogTitle>{activeMeta?.title || 'Command Result'}</DialogTitle>

        <div
          className={`flex shrink-0 items-start justify-between gap-3 border-b border-border bg-popover ${
            isModelsModal ? 'px-4 py-3 sm:px-5 sm:py-4' : 'px-4 py-4 sm:px-6 sm:py-5'
          }`}
        >
          <div className="flex min-w-0 items-center gap-3">
            <div
              className={`flex shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-foreground ${
                isModelsModal ? 'h-9 w-9' : 'h-10 w-10'
              }`}
            >
              <HeaderIcon className={isModelsModal ? 'h-4 w-4' : 'h-5 w-5'} />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {activeMeta?.eyebrow}
              </p>
              <p className="mt-0.5 text-lg font-semibold tracking-tight text-foreground sm:text-xl">
                {activeMeta?.title}
              </p>
              <p className="mt-0.5 max-w-2xl text-sm leading-5 text-muted-foreground">
                {activeMeta?.subtitle}
              </p>
            </div>
          </div>

          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="h-8 w-8 shrink-0 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close command result modal"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="settings-content-enter min-h-0 flex-1 overflow-hidden px-4 py-4 sm:px-6 sm:py-5">
          {payload?.kind === 'help' && <HelpContent data={payload.data as HelpCommandData} />}
          {payload?.kind === 'models' && (
            <ModelsContent
              data={payload.data as ModelCommandData}
              providerModelCatalog={providerModelCatalog}
              providerModelsRefreshing={providerModelsRefreshing}
              onHardRefreshProviderModels={onHardRefreshProviderModels}
              currentSessionId={currentSessionId}
              onSelectProviderModel={onSelectProviderModel}
              onClose={onClose}
            />
          )}
          {payload?.kind === 'cost' && <CostContent data={payload.data as CostCommandData} />}
          {payload?.kind === 'status' && <StatusContent data={payload.data as StatusCommandData} />}
        </div>

        <div className="flex shrink-0 flex-col gap-3 border-t border-border bg-card px-4 py-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="flex items-center gap-2">
            <Gauge className="h-3.5 w-3.5" />
            <span>Esc closes the modal.</span>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={onClose} className="rounded-lg">
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
