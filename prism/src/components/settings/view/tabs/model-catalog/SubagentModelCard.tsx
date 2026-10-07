import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Bot, Check, Link2, Shuffle } from 'lucide-react';

import ModelVendorIcon from '../../../../llm-logo-provider/ModelVendorIcon';
import { FancySelect, type FancyOption } from '../../../../../shared/view/ui/FancySelect';

import {
  CatalogApiError,
  MODEL_CATALOG_CHANGED_EVENT,
  modelCatalogApi,
  type CatalogEntry,
  type SubagentModelPolicy,
} from './modelCatalogApi';

/**
 * 设置 → 模型里的「子代理模型」(root,全局一份)。
 *
 * - 跟随主模型(model = null,默认):不写任何 env,内置子代理沿用主会话的模型;
 *   主模型在 Agent 工具里点名 sonnet / opus / haiku / fable 时走下方的别名映射;
 * - 指定一个模型:写 `CLAUDE_CODE_SUBAGENT_MODEL`,成为子代理的默认模型;
 * - 强制(只在选了模型时可勾):再写 `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`,主模型点名别名也一律用它。
 *
 * 选项 = 跟随主模型 + 目录里上架的条目 + 四个别名(服务端也只认这些,见 setSubagentPolicy)。
 * 改了就存(乐观更新,失败回滚并就地显示原因);从每个对话的下一条消息起生效(常驻进程按新 env 重建)。
 * 目录在上面那块被改(上下架 / 删除)时,靠 MODEL_CATALOG_CHANGED_EVENT 重拉选项。
 */

/** 与「子代理用的别名」那一块管的四档一致;`default` 不列 —— 和「跟随主模型」放在一起只会让人分不清。 */
const SUBAGENT_ALIASES = ['sonnet', 'opus', 'haiku', 'fable'] as const;
/** 服务端认的全部别名(与 ModelCatalogEditor 的 ALIAS_NAMES 同一份口径)—— 存着的是它们就不算"已下架"。 */
const ALIAS_SET: ReadonlySet<string> = new Set<string>([...SUBAGENT_ALIASES, 'default', 'sonnet[1m]', 'opus[1m]']);

/** FancySelect 的值是字符串:空串 = 跟随主模型。 */
const FOLLOW_VALUE = '';

export default function SubagentModelCard() {
  const { t } = useTranslation('settings');
  const [policy, setPolicy] = useState<SubagentModelPolicy | null>(null);
  const [entries, setEntries] = useState<CatalogEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  /** 服务端最后一次确认过的值 —— 保存失败回滚到它,而不是回滚到"上一次乐观值"。 */
  const confirmedRef = useRef<SubagentModelPolicy | null>(null);
  /** 连点两次:只认最后一次请求的结果,先发后到的旧响应不许把界面改回去。 */
  const requestSeq = useRef(0);

  const loadEntries = useCallback(async () => {
    try {
      setEntries(await modelCatalogApi.list());
    } catch {
      // 目录拉不到不影响选择:下拉里至少还有「跟随主模型」与别名
      setEntries(null);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const current = await modelCatalogApi.subagent();
        if (cancelled) return;
        confirmedRef.current = current;
        setPolicy(current);
        setLoadError(null);
      } catch (caught) {
        if (!cancelled) setLoadError(caught instanceof Error ? caught.message : String(caught));
      }
    })();
    void loadEntries();
    const onCatalogChanged = () => void loadEntries();
    window.addEventListener(MODEL_CATALOG_CHANGED_EVENT, onCatalogChanged);
    return () => {
      cancelled = true;
      window.removeEventListener(MODEL_CATALOG_CHANGED_EVENT, onCatalogChanged);
    };
  }, [loadEntries]);

  const apply = async (next: SubagentModelPolicy) => {
    const mine = ++requestSeq.current;
    setPolicy(next);
    setSaveError(null);
    setSaved(false);
    setSaving(true);
    try {
      const stored = await modelCatalogApi.setSubagent(next);
      if (mine !== requestSeq.current) return;
      confirmedRef.current = stored;
      setPolicy(stored);
      setSaved(true);
    } catch (caught) {
      if (mine !== requestSeq.current) return;
      setPolicy(confirmedRef.current);
      setSaveError(
        caught instanceof CatalogApiError && caught.code === 'SUBAGENT_MODEL_NOT_ALLOWED'
          ? t('models.subagent.notAllowed', { model: next.model ?? '' })
          : caught instanceof Error ? caught.message : String(caught),
      );
    } finally {
      if (mine === requestSeq.current) setSaving(false);
    }
  };

  const enabledEntries = useMemo(() => (entries ?? []).filter((entry) => entry.enabled), [entries]);
  const currentModel = policy?.model ?? null;

  /** 当前值已下架 / 不在目录里:服务端此时不写 env,子代理实际跟随主模型 —— 要让 root 看见。 */
  const currentUnavailable = Boolean(
    currentModel && entries !== null && !ALIAS_SET.has(currentModel) && !enabledEntries.some((entry) => entry.modelId === currentModel),
  );

  const options = useMemo<FancyOption[]>(() => {
    const list: FancyOption[] = [
      {
        value: FOLLOW_VALUE,
        label: t('models.subagent.follow'),
        sublabel: t('models.subagent.followSub'),
        icon: <Link2 className="h-4 w-4 text-muted-foreground" />,
      },
    ];
    for (const entry of enabledEntries) {
      list.push({
        value: entry.modelId,
        label: entry.label,
        sublabel: entry.label !== entry.modelId ? entry.modelId : undefined,
        icon: <ModelVendorIcon vendor={entry.vendor} modelId={entry.modelId} label={entry.label} size={16} />,
      });
    }
    for (const alias of SUBAGENT_ALIASES) {
      if (list.some((option) => option.value === alias)) continue;
      list.push({
        value: alias,
        label: alias,
        sublabel: t('models.subagent.aliasSub'),
        icon: <Shuffle className="h-4 w-4 text-muted-foreground" />,
      });
    }
    // 存着的值不在上面任何一项里(已下架 / 被删 / 存的是 default):补一行,触发器才显示得出它
    if (currentModel && !list.some((option) => option.value === currentModel)) {
      const isAlias = ALIAS_SET.has(currentModel);
      list.push({
        value: currentModel,
        label: currentModel,
        sublabel: isAlias ? t('models.subagent.aliasSub') : t('models.subagent.unavailable'),
        icon: isAlias
          ? <Shuffle className="h-4 w-4 text-muted-foreground" />
          : <AlertTriangle className="h-4 w-4 text-amber-700 dark:text-amber-400" />,
      });
    }
    return list;
  }, [enabledEntries, currentModel, t]);

  const currentLabel = currentModel
    ? enabledEntries.find((entry) => entry.modelId === currentModel)?.label ?? currentModel
    : null;

  return (
    <section className="space-y-3 border-t border-border pt-5">
      <div className="min-w-0">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <Bot className="h-4 w-4 text-muted-foreground" />
          {t('models.subagent.title')}
        </h3>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{t('models.subagent.description')}</p>
      </div>

      {!policy ? (
        // 没拿到当前值之前不画下拉:否则会先显示「跟随主模型」,拿到真值再跳,像是被人改了
        <p className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
          {loadError ?? t('models.subagent.loading')}
        </p>
      ) : (
        <div className="space-y-2.5 rounded-lg border border-border p-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <FancySelect
              variant="field"
              className="min-w-64 flex-1"
              value={currentModel ?? FOLLOW_VALUE}
              options={options}
              onChange={(value) => {
                const model = value === FOLLOW_VALUE ? null : value;
                if (model === policy.model) return;
                // 换回「跟随主模型」时强制一并清掉(服务端也这么存)
                void apply({ model, force: model ? policy.force : false });
              }}
              searchable={options.length > 8}
              searchPlaceholder={t('models.subagent.search')}
              ariaLabel={t('models.subagent.title')}
            />
            <label
              className={`inline-flex shrink-0 items-center gap-1.5 text-sm ${currentModel ? 'cursor-pointer text-foreground' : 'cursor-not-allowed text-muted-foreground'}`}
              title={currentModel ? t('models.subagent.forceTitle') : t('models.subagent.forceNeedsModel')}
            >
              <input
                type="checkbox"
                checked={Boolean(currentModel) && policy.force}
                disabled={!currentModel}
                onChange={(event) => {
                  if (!currentModel) return;
                  void apply({ model: currentModel, force: event.target.checked });
                }}
                className="disabled:opacity-50"
              />
              {t('models.subagent.force')}
            </label>
            <span className="inline-flex min-w-16 shrink-0 items-center gap-1 text-xs text-muted-foreground" aria-live="polite">
              {saving
                ? t('models.saving')
                : saved && !saveError && (
                  <>
                    <Check className="h-3.5 w-3.5 text-primary" />
                    {t('models.subagent.saved')}
                  </>
                )}
            </span>
          </div>

          <p className="text-xs leading-relaxed text-muted-foreground">
            {!currentModel
              ? t('models.subagent.modeFollow')
              : policy.force
                ? t('models.subagent.modeForce', { model: currentLabel })
                : t('models.subagent.modeDefault', { model: currentLabel })}
            {currentModel && (
              <span className="ml-1.5 break-all font-mono text-[10px]">
                CLAUDE_CODE_SUBAGENT_MODEL{policy.force ? ' + CLAUDE_CODE_SUBAGENT_MODEL_FORCE' : ''}
              </span>
            )}
          </p>

          {currentUnavailable && (
            <p className="flex items-start gap-1 text-xs leading-relaxed text-amber-700 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {t('models.subagent.staleModel', { model: currentModel })}
            </p>
          )}

          {saveError && (
            <p className="flex items-start gap-1 text-xs leading-relaxed text-amber-700 dark:text-amber-400" role="alert">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {saveError}
            </p>
          )}
        </div>
      )}

      <p className="text-xs leading-relaxed text-muted-foreground">{t('models.subagent.appliesNext')}</p>
    </section>
  );
}
