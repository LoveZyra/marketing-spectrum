import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Save, X } from 'lucide-react';

import ModelVendorIcon from '../../../../llm-logo-provider/ModelVendorIcon';
import {
  CONTEXT_WINDOW_MAX,
  CONTEXT_WINDOW_MIN,
  MODEL_ID_MAX_LENGTH,
  MODEL_VENDORS,
  detectModelVendor,
  formatContextWindow,
  getModelVendor,
  isValidModelId,
} from '../../../../../../shared/modelVendors';
import { filterUsers, toggleUserId, withCurrentChoice, type GatewayChoice } from '../model-gateways/gatewayLogic';
import type { BasicUser } from '../model-gateways/gatewaysApi';

import { EFFORT_LEVELS, type CatalogEntry, type CatalogInput, type EffortLevel } from './modelCatalogApi';

/** 常见窗口的快捷按钮(填进输入框,仍可手改)。 */
const WINDOW_PRESETS = [128_000, 200_000, 256_000, 1_000_000];

/** 内置别名 —— 不能拿来当目录条目的模型名(服务端同样会拒)。 */
const ALIAS_NAMES = new Set(['default', 'sonnet', 'sonnet[1m]', 'opus', 'opus[1m]', 'haiku', 'fable']);

type Props = {
  /** null = 新建 */
  entry: CatalogEntry | null;
  defaultSortOrder: number;
  onCancel: () => void;
  onSave: (input: CatalogInput) => Promise<void>;
  /**
   * hq:
   * - `catalog`(默认,root 的模型目录):网关 = 默认网关 + 共享网关;多一栏「可用人员」;
   * - `private`(每个人的私有模型):网关只能选自己的私有网关;没有说明 / 推荐 / 默认 / 排序 / 可用人员。
   */
  variant?: 'catalog' | 'private';
  /**
   * hq:可选的网关。catalog:共享网关(默认网关由编辑器自己补在最前);private:我的私有网关。
   * 不传 = 老用法,不画网关一栏、也不往服务端发 gatewayId。
   */
  gateways?: GatewayChoice[] | null;
  /** hq:「可用人员」的候选(仅 catalog)。null = 没拉到(只按 id 显示已选的人)。 */
  users?: BasicUser[] | null;
};

const inputClass = 'w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm transition-colors focus:border-primary focus:outline-none';

/** 「可用人员」名单超过这么多人才出搜索框。 */
const USER_SEARCH_THRESHOLD = 8;

export default function ModelCatalogEditor({ entry, defaultSortOrder, onCancel, onSave, variant = 'catalog', gateways, users }: Props) {
  const { t } = useTranslation('settings');
  const isPrivate = variant === 'private';
  const showGateway = gateways !== undefined;
  const [modelId, setModelId] = useState(entry?.modelId ?? '');
  const [label, setLabel] = useState(entry?.label ?? '');
  const [vendor, setVendor] = useState<string>(entry?.vendorOverride ?? 'auto');
  const [description, setDescription] = useState(entry?.description ?? '');
  const [contextWindow, setContextWindow] = useState(entry?.contextWindow ? String(entry.contextWindow) : '');
  const [effortLevels, setEffortLevels] = useState<EffortLevel[]>(entry?.effortLevels ?? []);
  const [effortDefault, setEffortDefault] = useState<string>(entry?.effortDefault ?? '');
  const [recommended, setRecommended] = useState(entry?.recommended ?? true);
  const [enabled, setEnabled] = useState(entry?.enabled ?? true);
  const [isDefault, setIsDefault] = useState(entry?.isDefault ?? false);
  const [sortOrder, setSortOrder] = useState(String(entry?.sortOrder ?? defaultSortOrder));
  // hq:网关(0 = 默认网关;私有模型新建时默认挂第一个私有网关)与可用人员
  const [gatewayId, setGatewayId] = useState<number>(entry?.gatewayId ?? (isPrivate ? (gateways?.[0]?.id ?? 0) : 0));
  const [audience, setAudience] = useState<'everyone' | 'some'>(Array.isArray(entry?.allowedUsers) ? 'some' : 'everyone');
  const [allowedUsers, setAllowedUsers] = useState<number[]>(entry?.allowedUsers ?? []);
  const [userQuery, setUserQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedId = modelId.trim();
  const detected = detectModelVendor(trimmedId);
  const effectiveVendor = vendor === 'auto' ? detected : vendor;

  const problem = useMemo(() => {
    if (!trimmedId) return t('models.catalog.editor.needModelId');
    if (!isValidModelId(trimmedId)) return t('models.catalog.editor.badModelId', { max: MODEL_ID_MAX_LENGTH });
    if (ALIAS_NAMES.has(trimmedId)) return t('models.catalog.editor.aliasModelId', { model: trimmedId });
    if (contextWindow.trim()) {
      const value = Number(contextWindow);
      if (!Number.isInteger(value) || value < CONTEXT_WINDOW_MIN || value > CONTEXT_WINDOW_MAX) {
        return t('models.catalog.editor.badWindow', { min: CONTEXT_WINDOW_MIN.toLocaleString() });
      }
    }
    if (!isPrivate && !Number.isInteger(Number(sortOrder))) return t('models.catalog.editor.badSort');
    if (!isPrivate && isDefault && !enabled) return t('models.catalog.editor.defaultNeedsEnabled');
    if (isPrivate && !(gatewayId > 0)) return t('gateways.catalog.needPrivateGateway', { defaultValue: '先选一个你的私有网关(没有的话先在上面添加)' });
    return null;
  }, [trimmedId, contextWindow, sortOrder, isDefault, enabled, isPrivate, gatewayId, t]);

  /** 下拉里的网关:catalog 前面补默认网关;当前挂的网关不在列表里时补一项占位(保存时原样带回)。 */
  const gatewayChoices = useMemo<GatewayChoice[]>(() => {
    const listed = withCurrentChoice(gateways ?? [], entry?.gatewayId ?? null);
    if (isPrivate) return listed;
    return [
      { id: 0, name: t('gateways.defaultName', { defaultValue: '默认网关(settings.json)' }), host: null, enabled: true, hasDefaultKey: true },
      ...listed.filter((choice) => choice.id !== 0),
    ];
  }, [gateways, entry?.gatewayId, isPrivate, t]);
  const selectedGateway = gatewayChoices.find((choice) => choice.id === gatewayId) ?? null;
  const visibleUsers = useMemo(() => filterUsers(users ?? [], userQuery), [users, userQuery]);
  const knownUserIds = useMemo(() => new Set((users ?? []).map((user) => user.id)), [users]);
  /** 已选、但不在名单里的人(名单没拉到 / 账号没了)—— 照样列出来,可以取消 */
  const unknownSelected = allowedUsers.filter((id) => !knownUserIds.has(id));

  const toggleEffort = (level: EffortLevel) => {
    setEffortLevels((previous) => {
      const next = previous.includes(level) ? previous.filter((item) => item !== level) : [...previous, level];
      const ordered = EFFORT_LEVELS.filter((item) => next.includes(item));
      if (effortDefault && !ordered.includes(effortDefault as EffortLevel)) setEffortDefault('');
      return ordered;
    });
  };

  const submit = async () => {
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const common: CatalogInput = {
        modelId: trimmedId,
        label: label.trim() || trimmedId,
        vendor: vendor === 'auto' ? null : vendor,
        contextWindow: contextWindow.trim() ? Number(contextWindow) : null,
        effortLevels,
        effortDefault: (effortDefault || null) as EffortLevel | null,
        enabled,
      };
      if (isPrivate) {
        // 私有模型:服务端不收说明 / 推荐 / 默认 / 可用人员;排序沿用原值
        await onSave({ ...common, gatewayId });
      } else {
        await onSave({
          ...common,
          description: description.trim() || null,
          recommended,
          isDefault,
          sortOrder: Number(sortOrder),
          ...(showGateway ? { gatewayId, allowedUsers: audience === 'everyone' ? null : allowedUsers } : {}),
        });
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const windowPreview = formatContextWindow(contextWindow.trim() ? Number(contextWindow) : null);

  return (
    <div className="space-y-3 rounded-lg border border-primary/30 bg-card p-4" data-catalog-editor>
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-foreground">
          {entry
            ? t('models.catalog.editor.editTitle', { model: entry.label })
            : isPrivate
              ? t('gateways.privateModels.newTitle', { defaultValue: '添加私有模型' })
              : t('models.catalog.editor.newTitle')}
        </p>
        <button type="button" onClick={onCancel} aria-label={t('models.catalog.editor.cancel')} className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {showGateway && (
          <label className="block min-w-0">
            <span className="mb-1 block text-xs font-medium text-foreground">{t('gateways.catalog.gateway', { defaultValue: '网关' })}</span>
            <select
              value={String(gatewayId)}
              onChange={(event) => setGatewayId(Number(event.target.value))}
              className={inputClass}
              data-catalog-gateway
            >
              {isPrivate && gatewayChoices.length === 0 && (
                <option value="0">{t('gateways.catalog.noPrivateGateway', { defaultValue: '还没有私有网关' })}</option>
              )}
              {gatewayChoices.map((choice) => {
                const base = choice.missing
                  ? t('gateways.catalog.missingGateway', { defaultValue: '网关 {{name}}(已不存在或没拉到)', name: choice.name })
                  : choice.host && choice.id !== 0
                    ? `${choice.name} · ${choice.host}`
                    : choice.name;
                const suffix = !choice.missing && !choice.enabled ? ` ${t('gateways.catalog.disabledSuffix', { defaultValue: '(已停用)' })}` : '';
                return (
                  <option key={choice.id} value={String(choice.id)}>
                    {`${base}${suffix}`}
                  </option>
                );
              })}
            </select>
            {selectedGateway && !isPrivate && selectedGateway.id !== 0 && !selectedGateway.missing && !selectedGateway.enabled && (
              <span className="mt-1 flex items-start gap-1 text-[11px] leading-4 text-amber-700 dark:text-amber-400">
                <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                {t('gateways.catalog.gatewayDisabledHint', { defaultValue: '这个网关已停用 —— 挂在上面的模型暂时谁都用不了' })}
              </span>
            )}
            {selectedGateway && !isPrivate && selectedGateway.id !== 0 && !selectedGateway.missing && selectedGateway.enabled && !selectedGateway.hasDefaultKey && (
              <span className="mt-1 flex items-start gap-1 text-[11px] leading-4 text-amber-700 dark:text-amber-400">
                <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                {t('gateways.catalog.gatewayNoKeyHint', { defaultValue: '这个网关没有默认 key —— 只有填了个人 key 的人能用,其他人在选择器里看到的是灰的' })}
              </span>
            )}
            {(isPrivate || selectedGateway?.id === 0) && (
              <span className="mt-1 block text-[11px] leading-4 text-muted-foreground">
                {isPrivate
                  ? t('gateways.catalog.privateGatewayHelp', { defaultValue: '私有模型只能挂在你自己的私有网关上,只有你看得到、用得了。' })
                  : t('gateways.catalog.defaultGatewayHelp', { defaultValue: '默认网关 = settings.json 里的地址和 token(成员填了个人 key 就用个人的)。' })}
              </span>
            )}
          </label>
        )}
        {showGateway && !isPrivate && (
          <div className="min-w-0" data-catalog-audience>
            <span className="mb-1 block text-xs font-medium text-foreground">{t('gateways.catalog.audience', { defaultValue: '可用人员' })}</span>
            <span className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              <label className="inline-flex cursor-pointer items-center gap-1.5">
                <input type="radio" name={`audience-${entry?.id ?? 'new'}`} checked={audience === 'everyone'} onChange={() => setAudience('everyone')} />
                {t('gateways.catalog.audienceEveryone', { defaultValue: '所有人' })}
              </label>
              <label className="inline-flex cursor-pointer items-center gap-1.5">
                <input type="radio" name={`audience-${entry?.id ?? 'new'}`} checked={audience === 'some'} onChange={() => setAudience('some')} />
                {t('gateways.catalog.audienceSome', { defaultValue: '指定成员' })}
              </label>
            </span>
            {audience === 'some' && (
              <div className="mt-2 space-y-1.5 rounded-md border border-border p-2">
                {(users?.length ?? 0) > USER_SEARCH_THRESHOLD && (
                  <input
                    type="search"
                    value={userQuery}
                    onChange={(event) => setUserQuery(event.target.value)}
                    placeholder={t('gateways.catalog.userSearch', { defaultValue: '搜索成员' })}
                    autoComplete="off"
                    data-lpignore="true"
                    data-1p-ignore="true"
                    className="w-full rounded-md border border-input bg-transparent px-2 py-1 text-xs focus:border-primary focus:outline-none"
                  />
                )}
                <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
                  {[...unknownSelected.map((id) => ({ id, username: `#${id}` })), ...visibleUsers].map((user) => (
                    <label
                      key={user.id}
                      className={`inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-xs ${allowedUsers.includes(user.id) ? 'border-primary/50 bg-primary/10 text-foreground' : 'border-border text-muted-foreground'}`}
                    >
                      <input type="checkbox" className="h-3 w-3" checked={allowedUsers.includes(user.id)} onChange={() => setAllowedUsers((current) => toggleUserId(current, user.id))} />
                      <span className="max-w-40 truncate">{user.username}</span>
                    </label>
                  ))}
                  {users === null && unknownSelected.length === 0 && (
                    <span className="text-[11px] text-muted-foreground">{t('gateways.catalog.usersUnavailable', { defaultValue: '成员名单没拉到 —— 刷新后再选' })}</span>
                  )}
                </div>
              </div>
            )}
            <span className="mt-1 block text-[11px] leading-4 text-muted-foreground">
              {audience === 'everyone'
                ? t('gateways.catalog.audienceEveryoneHelp', { defaultValue: '所有人都能在选择器里看到它(没 key 的人看到的是灰的)。' })
                : allowedUsers.length === 0
                  ? t('gateways.catalog.audienceNoneHelp', { defaultValue: '一个人都没选 = 只有 root 能看到、能用。' })
                  : t('gateways.catalog.audienceSomeHelp', { defaultValue: '已选 {{n}} 人;不在名单里的人看不到这个模型。root 始终可用。', n: allowedUsers.length })}
            </span>
          </div>
        )}

        <label className="block min-w-0">
          <span className="mb-1 block text-xs font-medium text-foreground">{t('models.catalog.editor.modelId')}</span>
          <input
            type="text"
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
            placeholder="glm-5.2 / deepseek-v4 / kimi-k2.5"
            spellCheck={false}
            maxLength={MODEL_ID_MAX_LENGTH}
            className={`${inputClass} font-mono`}
          />
          <span className="mt-1 block text-[11px] leading-4 text-muted-foreground">{t('models.catalog.editor.modelIdHelp')}</span>
        </label>
        <label className="block min-w-0">
          <span className="mb-1 block text-xs font-medium text-foreground">{t('models.catalog.editor.label')}</span>
          <input type="text" value={label} onChange={(event) => setLabel(event.target.value)} placeholder={trimmedId || 'GLM 5.2'} maxLength={80} className={inputClass} />
        </label>

        <label className="block min-w-0">
          <span className="mb-1 block text-xs font-medium text-foreground">{t('models.catalog.editor.vendor')}</span>
          <span className="flex items-center gap-2">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-border bg-background text-foreground">
              <ModelVendorIcon vendor={effectiveVendor} modelId={trimmedId} label={label || trimmedId} size={18} />
            </span>
            <select value={vendor} onChange={(event) => setVendor(event.target.value)} className={`${inputClass} min-w-0`}>
              <option value="auto">
                {t('models.catalog.editor.vendorAuto', { vendor: getModelVendor(detected)?.label ?? t('models.catalog.editor.vendorUnknown') })}
              </option>
              {MODEL_VENDORS.map((item) => (
                <option key={item.id} value={item.id}>{item.label}</option>
              ))}
            </select>
          </span>
        </label>
        {!isPrivate && (
          <label className="block min-w-0">
            <span className="mb-1 block text-xs font-medium text-foreground">{t('models.catalog.editor.description')}</span>
            <input type="text" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={200} className={inputClass} />
          </label>
        )}

        <div className="min-w-0">
          <span className="mb-1 flex items-baseline gap-2 text-xs font-medium text-foreground">
            {t('models.catalog.editor.contextWindow')}
            {windowPreview && <span className="font-mono text-[11px] text-muted-foreground">= {windowPreview}</span>}
          </span>
          <input
            type="number"
            inputMode="numeric"
            min={CONTEXT_WINDOW_MIN}
            max={CONTEXT_WINDOW_MAX}
            step={1000}
            value={contextWindow}
            onChange={(event) => setContextWindow(event.target.value)}
            placeholder={t('models.catalog.editor.windowPlaceholder')}
            className={`${inputClass} font-mono`}
          />
          <span className="mt-1 flex flex-wrap gap-1">
            {WINDOW_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setContextWindow(String(preset))}
                className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:border-primary/40 hover:text-foreground"
              >
                {formatContextWindow(preset)}
              </button>
            ))}
          </span>
          <span className="mt-1 block text-[11px] leading-4 text-muted-foreground">{t('models.catalog.editor.windowHelp')}</span>
        </div>

        <div className="min-w-0">
          <span className="mb-1 block text-xs font-medium text-foreground">{t('models.catalog.editor.effort')}</span>
          <span className="flex flex-wrap gap-1.5">
            {EFFORT_LEVELS.map((level) => (
              <label key={level} className={`inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-xs ${effortLevels.includes(level) ? 'border-primary/50 bg-primary/10 text-foreground' : 'border-border text-muted-foreground'}`}>
                <input type="checkbox" className="h-3 w-3" checked={effortLevels.includes(level)} onChange={() => toggleEffort(level)} />
                {level}
              </label>
            ))}
          </span>
          {effortLevels.length > 0 && (
            <select value={effortDefault} onChange={(event) => setEffortDefault(event.target.value)} className={`${inputClass} mt-2`}>
              <option value="">{t('models.catalog.editor.effortDefaultNone')}</option>
              {effortLevels.map((level) => <option key={level} value={level}>{level}</option>)}
            </select>
          )}
          <span className="mt-1 block text-[11px] leading-4 text-muted-foreground">{t('models.catalog.editor.effortHelp')}</span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border pt-3 text-sm">
        <label className="inline-flex cursor-pointer items-center gap-1.5">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          {t('models.catalog.editor.enabled')}
        </label>
        {!isPrivate && (
          <>
            <label className="inline-flex cursor-pointer items-center gap-1.5">
              <input type="checkbox" checked={recommended} onChange={(event) => setRecommended(event.target.checked)} />
              {t('models.catalog.editor.recommended')}
            </label>
            <label className="inline-flex cursor-pointer items-center gap-1.5">
              <input type="checkbox" checked={isDefault} onChange={(event) => setIsDefault(event.target.checked)} />
              {t('models.catalog.editor.isDefault')}
            </label>
            <label className="inline-flex items-center gap-1.5">
              {t('models.catalog.editor.sortOrder')}
              <input type="number" value={sortOrder} onChange={(event) => setSortOrder(event.target.value)} className="w-20 rounded-md border border-input bg-transparent px-2 py-1 font-mono text-sm focus:border-primary focus:outline-none" />
            </label>
          </>
        )}
      </div>

      {/* 还没开始填模型名时不提示"要填模型名" —— 按钮本来就是灰的 */}
      {(error || (trimmedId && problem)) && (
        <p className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">{error || problem}</p>
      )}

      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground">
          {t('models.catalog.editor.cancel')}
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={saving || Boolean(problem)}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          <Save className="h-4 w-4" />
          {saving ? t('models.saving') : t('models.catalog.editor.save')}
        </button>
      </div>
    </div>
  );
}
