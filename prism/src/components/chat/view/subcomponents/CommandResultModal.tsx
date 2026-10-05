import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  X,
} from 'lucide-react';

import { Badge, Button, Dialog, DialogContent, DialogTitle, Input } from '../../../../shared/view/ui';
import type { LLMProvider, ProviderModelsCacheInfo, ProviderModelsDefinition } from '../../../../types/app';
import type {
  CommandModalPayload,
  CostCommandData,
  HelpCommandData,
  ModelCommandData,
  StatusCommandData,
} from '../../hooks/useChatComposerState';
import { uiLocale } from '../../../../utils/uiLocale';
import { detectModelVendor, getModelVendor } from '../../../../../shared/modelVendors';

import ModelPickerContent from './ModelPickerContent';

type CommandResultModalProps = {
  payload: CommandModalPayload | null;
  onClose: () => void;
  providerModelCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>;
  providerModelCacheCatalog: Partial<Record<LLMProvider, ProviderModelsCacheInfo>>;
  providerModelsRefreshing: boolean;
  onHardRefreshProviderModels: () => void;
  currentSessionId: string | null;
  /**
   * 会话此刻用的**档位别名**(default / sonnet / opus …),也就是输入框那枚 chip
   * 显示的那个。卡片的「当前」必须按它判,不能按 `data.current.model` ——
   * 自定义网关下后者是解析后的真实模型名,与档名不是一个命名空间。
   */
  activeModelAlias?: string | null;
  /** hn:当前上下文用量 —— 选择器标出"切过去就超压缩线"的模型。 */
  contextUsedTokens?: number | null;
  onSelectProviderModel: (
    provider: LLMProvider,
    model: string,
    sessionId?: string | null,
  ) => Promise<{
    scope: 'default' | 'session';
    changed: boolean;
    model: string;
  }>;
  /** hq:`/models` 里不能用的模型旁「去填 key」—— 开 设置 → 模型网关。 */
  onOpenKeySettings?: () => void;
};

type CommandEntry = {
  name: string;
  description?: string;
  namespace?: string;
};

// Keyed by the `provider` string the server echoes back on a command result.
// Cursor, Codex and OpenCode used to have entries here; anything unrecognised
// still falls through to the raw string below rather than the fallback.
const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude',
};

// description 是 i18n key(commandResult.builtins.*);服务端下发的命令仍用其原始 description。
const FALLBACK_COMMAND_KEYS: Array<{ name: string; key: string }> = [
  { name: '/models', key: 'commandResult.builtins.models' },
  { name: '/cost', key: 'commandResult.builtins.cost' },
  { name: '/status', key: 'commandResult.builtins.status' },
  { name: '/memory', key: 'commandResult.builtins.memory' },
  { name: '/config', key: 'commandResult.builtins.config' },
  { name: '/help', key: 'commandResult.builtins.help' },
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
  return value.toLocaleString(uiLocale());
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
  const { t } = useTranslation('chat');
  const [query, setQuery] = useState('');
  const fallbackCommands = useMemo<CommandEntry[]>(
    () => FALLBACK_COMMAND_KEYS.map(({ name, key }) => ({ name, description: t(key) })),
    [t],
  );
  const commands = (Array.isArray(data.commands) && data.commands.length > 0
    ? data.commands
    : fallbackCommands) as CommandEntry[];

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
        <SearchField value={query} onChange={setQuery} placeholder={t('commandResult.filterCommands')} />

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
                  {command.description || t('commandResult.noDescription')}
                </p>
              </div>
            ))}
          </div>

          {filteredCommands.length === 0 && (
            <div className="rounded-lg border border-dashed border-border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
              {t('commandResult.help.noMatch', { defaultValue: '没有匹配的命令。' })}
            </div>
          )}
        </div>
      </div>

      <aside className="space-y-3">
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
            <TerminalSquare className="h-4 w-4 text-primary" />
            {/* hl(P3 中英混排):中文界面下原来这一栏整块英文。 */}
            {t('commandResult.help.syntax', { defaultValue: '语法' })}
          </div>
          <div className="space-y-2 text-sm text-muted-foreground">
            <p><code className="text-foreground">/command arg1 arg2</code></p>
            <p><code className="text-foreground">$ARGUMENTS</code> {t('commandResult.help.allArgs', { defaultValue: '传入全部参数。' })}</p>
            <p><code className="text-foreground">$1</code>, <code className="text-foreground">$2</code> {t('commandResult.help.positionalArgs', { defaultValue: '按位置传参。' })}</p>
            <p><code className="text-foreground">@file</code> {t('commandResult.help.fileArg', { defaultValue: '把文件内容带进来。' })}</p>
          </div>
        </div>

        <div className="rounded-lg border border-primary/25 bg-primary/10 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
            <Sparkles className="h-4 w-4 text-primary" />
            {t('commandResult.help.quickTip', { defaultValue: '小技巧' })}
          </div>
          <p className="text-sm leading-5 text-muted-foreground">
            {t('commandResult.help.quickTipBody', { defaultValue: '在输入框里输入 / 打开命令菜单,用方向键选择、回车执行。' })}
          </p>
        </div>
      </aside>
    </div>
  );
}

function CostContent({ data }: { data: CostCommandData }) {
  const { t } = useTranslation('chat');
  const used = Number(data.tokenUsage?.used ?? 0);
  const total = Number(data.tokenUsage?.total ?? 0);
  const model = data.model || t('commandResult.unknown');
  const provider = getProviderLabel(data.provider, data.provider || t('commandResult.unknown'));
  // 服务端给了厂商(目录条目 / 别名换真名之后)就用它,否则按真名 / 名字识别
  const detectedVendor = getModelVendor(data.vendor)?.id ?? detectModelVendor(data.realModel ?? data.model);
  const nonClaudeVendor = detectedVendor && detectedVendor !== 'claude' ? getModelVendor(detectedVendor)?.label ?? null : null;
  const hasBreakdown =
    typeof data.tokenBreakdown?.input === 'number' ||
    typeof data.tokenBreakdown?.output === 'number';
  const usageRows = [
    { label: t('commandResult.totalTokens'), value: formatNumber(used), icon: Activity },
    ...(hasBreakdown
      ? [
          {
            label: t('commandResult.inputTokens'),
            value: formatNumber(Number(data.tokenBreakdown?.input ?? 0)),
            icon: TerminalSquare,
          },
          {
            label: t('commandResult.outputTokens'),
            value: formatNumber(Number(data.tokenBreakdown?.output ?? 0)),
            icon: Coins,
          },
        ]
      : [
          {
            label: t('commandResult.breakdown'),
            value: t('commandResult.unavailable'),
            icon: TerminalSquare,
          },
        ]),
    ...(total > 0
      ? [{ label: t('commandResult.contextWindow'), value: formatNumber(total), icon: Gauge }]
      : []),
    // 会话累计费用(F4):只有本次浏览器会话里跑过回合、拿到过 result 帧才有。
    ...(typeof data.costUsd === 'number' && data.costUsd > 0
      ? [{
          label: t('commandResult.sessionCost', { defaultValue: '本会话累计费用' }),
          value: `$${data.costUsd < 0.01 ? data.costUsd.toFixed(4) : data.costUsd.toFixed(2)}`,
          icon: Coins,
        }]
      : []),
    /*
     * fh:台账里的累计花销。和上面那行的区别值得说清楚 ——
     *
     * 上面那个来自**浏览器内存**:只有你这次打开页面之后跑过回合才有,刷新就没。
     * 这一行来自服务端台账(`usage_records`),**跨重启、跨设备都在**。
     *
     * 两个并列而不是合并:它们口径不同,对不上的时候正好说明"你这次打开之前
     * 它还花过钱"。合成一个数会把这层信息抹掉。
     */
    ...(data.ledger && Number(data.ledger.costUsd) > 0
      ? [{
          label: t('commandResult.ledgerCost', { defaultValue: '台账累计(含历史)' }),
          value: `$${Number(data.ledger.costUsd).toFixed(4)} · ${Number(data.ledger.runs) || 0} 轮`,
          icon: Coins,
        }]
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

      {/* hn(Q12):CLI 对不认识的模型按默认 Claude 价计费 —— 非 Claude 模型的费用只是估算 */}
      {nonClaudeVendor && (typeof data.costUsd === 'number' || data.ledger) && (
        <p className="rounded-lg border border-border bg-muted px-3 py-2 text-[12px] leading-5 text-muted-foreground">
          {t('commandResult.cost.estimateNote', { vendor: nonClaudeVendor })}
        </p>
      )}

      <div className="rounded-lg border border-border bg-card p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{t('commandResult.status.provider', { defaultValue: '提供方' })}</p>
            <p className="mt-1 text-sm font-semibold text-foreground">{provider}</p>
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{t('commandResult.status.model', { defaultValue: '模型' })}</p>
            <p className="mt-1 break-all font-mono text-sm text-foreground">{model}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusContent({ data }: { data: StatusCommandData }) {
  const { t } = useTranslation('chat');
  const memoryRssMb = data.memoryUsage?.rssMb;
  const unknown = t('commandResult.unknown');
  const rows = [
    { label: t('commandResult.status.package'), value: data.packageName || 'prism', icon: Package },
    { label: t('commandResult.status.version'), value: data.release || (data.version ? `v${data.version}` : unknown), icon: BadgeCheck, tone: 'success' as const },
    { label: t('commandResult.status.uptime'), value: data.uptime || unknown, icon: Timer },
    { label: t('commandResult.status.provider'), value: getProviderLabel(data.provider, data.provider || unknown), icon: Server, tone: 'primary' as const },
    { label: t('commandResult.status.model'), value: data.model || unknown, icon: Cpu },
    { label: t('commandResult.status.node'), value: data.nodeVersion || unknown, icon: TerminalSquare },
    { label: t('commandResult.status.platform'), value: data.platform || unknown, icon: Activity },
    { label: t('commandResult.status.memory'), value: typeof memoryRssMb === 'number' ? `${memoryRssMb} MB RSS` : unknown, icon: Gauge },
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
            <p className="text-sm font-semibold text-foreground">{t('commandResult.status.runtimeOnline')}</p>
            <p className="text-xs text-muted-foreground">{t('commandResult.status.processResponding', { pid: data.pid ? `#${data.pid}` : '' })}</p>
          </div>
        </div>
        <Badge className="rounded-full bg-primary text-primary-foreground hover:bg-primary">{t('commandResult.status.healthy')}</Badge>
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
  activeModelAlias,
  contextUsedTokens,
  onSelectProviderModel,
  onOpenKeySettings,
}: CommandResultModalProps) {
  const { t } = useTranslation('chat');
  const isOpen = Boolean(payload);
  const kind = payload?.kind;
  const isModelsModal = kind === 'models';

  const modalMeta = {
    help: {
      eyebrow: t('commandResult.help.eyebrow'),
      title: t('commandResult.help.title'),
      subtitle: t('commandResult.help.subtitle'),
      icon: CircleHelp,
    },
    models: {
      eyebrow: t('commandResult.models.eyebrow'),
      title: t('commandResult.models.title'),
      subtitle: t('commandResult.models.subtitle'),
      icon: Cpu,
    },
    cost: {
      eyebrow: t('commandResult.cost.eyebrow'),
      title: t('commandResult.cost.title'),
      subtitle: t('commandResult.cost.subtitle'),
      icon: Coins,
    },
    status: {
      eyebrow: t('commandResult.status.eyebrow'),
      title: t('commandResult.status.title'),
      subtitle: t('commandResult.status.subtitle'),
      icon: Activity,
    },
  } as const;

  const activeMeta = kind ? modalMeta[kind] : null;
  const HeaderIcon = activeMeta?.icon || Sparkles;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="prism-modal-shadow flex h-[min(92dvh,48rem)] w-[calc(100vw-1rem)] max-w-5xl flex-col overflow-hidden rounded-lg border-border bg-popover p-0 sm:w-[min(94vw,64rem)]">
        <DialogTitle>{activeMeta?.title || t('commandResult.fallbackTitle')}</DialogTitle>

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
            aria-label={t('commandResult.closeAria')}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="settings-content-enter min-h-0 flex-1 overflow-hidden px-4 py-4 sm:px-6 sm:py-5">
          {payload?.kind === 'help' && <HelpContent data={payload.data as HelpCommandData} />}
          {payload?.kind === 'models' && (
            <ModelPickerContent
              data={payload.data as ModelCommandData}
              providerModelCatalog={providerModelCatalog}
              providerModelsRefreshing={providerModelsRefreshing}
              onHardRefreshProviderModels={onHardRefreshProviderModels}
              currentSessionId={currentSessionId}
              activeModelAlias={activeModelAlias}
              contextUsedTokens={contextUsedTokens}
              onSelectProviderModel={onSelectProviderModel}
              onOpenKeySettings={onOpenKeySettings}
              onClose={onClose}
            />
          )}
          {payload?.kind === 'cost' && <CostContent data={payload.data as CostCommandData} />}
          {payload?.kind === 'status' && <StatusContent data={payload.data as StatusCommandData} />}
        </div>

        <div className="flex shrink-0 flex-col gap-3 border-t border-border bg-card px-4 py-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="flex items-center gap-2">
            <Gauge className="h-3.5 w-3.5" />
            <span>{t('commandResult.escHint')}</span>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={onClose} className="rounded-lg">
            {t('commandResult.close', { defaultValue: '关闭' })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
