import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Save, Shuffle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { authenticatedFetch } from '../../../../utils/api';

type ManagedAlias = 'sonnet' | 'opus' | 'haiku' | 'fable';

const ALIASES: ManagedAlias[] = ['sonnet', 'opus', 'haiku', 'fable'];

const ENV_KEYS: Record<ManagedAlias, string> = {
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
};

type ConfigView = {
  settingsPath: string;
  exists: boolean;
  mtimeMs: number | null;
  defaultModel: string | null;
  mappings: Record<ManagedAlias, string | null>;
  baseUrl: string | null;
  hasAuthToken: boolean;
};

type ConfigResponse = { data?: ConfigView; error?: string; details?: string };

/**
 * 模型映射管理(root):可视化编辑 settings.json 的别名映射与 default 档。
 * 保存 = 原子写回文件;已有的热感知让下一条消息直接用新映射,无需重启;
 * 实测缓存同时被置 stale,模型切换页会提示重测。
 */
export default function ModelMappingSettingsTab() {
  const { t } = useTranslation('settings');
  const [view, setView] = useState<ConfigView | null>(null);
  const [draftMappings, setDraftMappings] = useState<Record<ManagedAlias, string>>({
    sonnet: '',
    opus: '',
    haiku: '',
    fable: '',
  });
  const [draftDefault, setDraftDefault] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await authenticatedFetch('/api/providers/claude/model-config');
      const payload = (await response.json()) as ConfigResponse;
      if (!response.ok || !payload.data) {
        throw new Error(payload.error || `HTTP ${response.status}`);
      }
      setView(payload.data);
      setDraftDefault(payload.data.defaultModel ?? '');
      setDraftMappings({
        sonnet: payload.data.mappings.sonnet ?? '',
        opus: payload.data.mappings.opus ?? '',
        haiku: payload.data.mappings.haiku ?? '',
        fable: payload.data.mappings.fable ?? '',
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = useMemo(() => {
    if (!view) return false;
    if ((view.defaultModel ?? '') !== draftDefault.trim()) return true;
    return ALIASES.some((alias) => (view.mappings[alias] ?? '') !== draftMappings[alias].trim());
  }, [view, draftDefault, draftMappings]);

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const body = {
        defaultModel: draftDefault.trim() || null,
        mappings: Object.fromEntries(
          ALIASES.map((alias) => [alias, draftMappings[alias].trim() || null]),
        ),
      };
      const response = await authenticatedFetch('/api/providers/claude/model-config', {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as ConfigResponse;
      if (!response.ok || !payload.data) {
        throw new Error(payload.details || payload.error || `HTTP ${response.status}`);
      }
      setView(payload.data);
      setSaved(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <Shuffle className="h-4 w-4 text-muted-foreground" />
            {t('models.title', '模型映射')}
          </h3>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            {t(
              'models.description',
              '把 Sonnet / Opus / Haiku / Fable 这几档,映射到网关上真实的模型名。保存即生效,下一条消息就走新映射,不用重启。',
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-body transition-colors hover:border-border-strong hover:bg-card hover:text-foreground"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'text-primary' : ''}`} />
          {t('models.reload', '重新读取')}
        </button>
      </div>

      {error && (
        <p className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
          {error}
        </p>
      )}
      {saved && !dirty && (
        <p className="bg-primary/8 rounded-md border border-primary/30 px-3 py-2 text-xs text-card-foreground dark:text-primary">
          {t('models.saved', '已写入 settings.json —— 热感知已接管,下一条消息即用新映射。')}
        </p>
      )}

      <div className="space-y-3 rounded-lg border border-border p-4">
        {/* 档名与环境变量名放在输入框**上面**一行:这些变量名有 30 个字符,
            塞进左侧 88px 的列里必然压到输入框上(实测就是这么糊在一起的)。
            提到上面之后,所有输入框左边界对齐,变量名也不用再截断。 */}
        {ALIASES.map((alias) => (
          <div key={alias} className="min-w-0">
            <div className="mb-1 flex min-w-0 items-baseline gap-2">
              <span className="flex-none text-sm font-medium capitalize">{alias}</span>
              <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground" title={ENV_KEYS[alias]}>
                {ENV_KEYS[alias]}
              </span>
            </div>
            <input
              type="text"
              value={draftMappings[alias]}
              onChange={(event) =>
                setDraftMappings((previous) => ({ ...previous, [alias]: event.target.value }))
              }
              placeholder={t('models.unsetPlaceholder', '留空 —— 用 CLI 内置 ID,由网关决定')}
              spellCheck={false}
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm text-code transition-colors focus:border-primary focus:outline-none"
            />
          </div>
        ))}

        <div className="min-w-0 border-t border-border pt-3">
          <div className="mb-1 flex min-w-0 items-baseline gap-2">
            <span className="flex-none text-sm font-medium">default</span>
            <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">settings.model</span>
          </div>
          <input
            type="text"
            list="prism-default-model-options"
            value={draftDefault}
            onChange={(event) => setDraftDefault(event.target.value)}
            placeholder={t('models.defaultPlaceholder', '留空 —— 跟随 CLI 内置链')}
            spellCheck={false}
            className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm text-code transition-colors focus:border-primary focus:outline-none"
          />
          <datalist id="prism-default-model-options">
            {ALIASES.map((alias) => (
              <option key={alias} value={alias} />
            ))}
          </datalist>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            {t('models.defaultHelp', '填别名(如 sonnet)就跟着那一档走;也可以直接填网关的模型名。')}
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 text-xs text-muted-foreground">
          {view && (
            <>
              <span className="font-mono">{view.settingsPath}</span>
              {view.baseUrl && (
                <span className="ml-2">
                  {t('models.gateway', '网关')}: <span className="font-mono">{view.baseUrl}</span>
                </span>
              )}
              {!view.exists && (
                <span className="ml-2 text-muted-foreground">
                  {t('models.missingFile', '(文件尚不存在,保存时会创建)')}
                </span>
              )}
            </>
          )}
        </div>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || loading || !dirty}
          className="inline-flex shrink-0 items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          <Save className="h-4 w-4" />
          {saving ? t('models.saving', '保存中…') : t('models.save', '保存映射')}
        </button>
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        {t(
          'models.cacheNote',
          '改完之后,模型切换页上一次的实测结果就不作数了 —— 想确认网关的真实行为,去那页重新实测一次。',
        )}
      </p>

      <p className="text-xs leading-relaxed text-muted-foreground">
        {t(
          'models.tokenNote',
          '本页只读写映射字段;settings.json 里的网关地址与鉴权 token 原样保留,也不会传到浏览器。',
        )}
      </p>
    </div>
  );
}
