import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Lock, Network, Plus, PlugZap, RefreshCw, Users } from 'lucide-react';

import SettingsToggle from '../../SettingsToggle';
import { MODEL_CATALOG_CHANGED_EVENT } from '../model-catalog/modelCatalogApi';

import GatewayForm from './GatewayForm';
import GatewayTestResultLine from './GatewayTestResultLine';
import MemberKeysPanel from './MemberKeysPanel';
import SharedGatewayRow from './SharedGatewayRow';
import { authTypeBadge } from './gatewayLogic';
import { errorMessage, gatewaysAdminApi, type AdminGatewaysPayload, type GatewayTestResult, type GatewayView } from './gatewaysApi';

/**
 * hq:设置 → 模型 最上面的「网关」(root)。
 *
 * 1. 默认网关(settings.json,id 0,只读):地址、鉴权方式、有没有 token;测试连接、成员 key;
 * 2. 共享网关:每行见 SharedGatewayRow;
 * 3. 添加网关:名字 / 地址 / 鉴权方式 / 可选默认 key,「先测试」打一次 /v1/models;
 * 4. 私有网关总开关 + 所有成员的私有网关(只读,收起)。
 *
 * 目录那块改了模型(挂到哪个网关)会广播 MODEL_CATALOG_CHANGED_EVENT —— 这里据此安静地重拉一次,模型数才对得上。
 */
export default function GatewaysAdminSection() {
  const { t } = useTranslation('settings');
  const [data, setData] = useState<AdminGatewaysPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [defaultPanel, setDefaultPanel] = useState(false);
  const [defaultTest, setDefaultTest] = useState<GatewayTestResult | null>(null);
  const [defaultTesting, setDefaultTesting] = useState(false);
  const [togglingPrivate, setTogglingPrivate] = useState(false);
  const [showPrivate, setShowPrivate] = useState(false);
  // 只认最后一次加载(连点刷新时,先发后到的旧响应不覆盖)
  const seqRef = useRef(0);

  const load = useCallback(async ({ quiet = false }: { quiet?: boolean } = {}) => {
    const seq = ++seqRef.current;
    if (!quiet) {
      setLoading(true);
      setError(null);
    }
    try {
      const next = await gatewaysAdminApi.list();
      if (seq === seqRef.current) setData(next);
    } catch (caught) {
      if (seq === seqRef.current && !quiet) setError(errorMessage(caught));
    } finally {
      // 不按 seq 判:安静重拉会把 seq 顶上去,按 seq 判的话转圈就停不下来了
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const onCatalogChanged = () => void load({ quiet: true });
    window.addEventListener(MODEL_CATALOG_CHANGED_EVENT, onCatalogChanged);
    return () => window.removeEventListener(MODEL_CATALOG_CHANGED_EVENT, onCatalogChanged);
  }, [load]);

  const replaceGateway = (next: GatewayView) =>
    setData((current) => (current ? { ...current, gateways: current.gateways.map((item) => (item.id === next.id ? next : item)) } : current));

  const removeGateway = (id: number) =>
    setData((current) => (current ? { ...current, gateways: current.gateways.filter((item) => item.id !== id) } : current));

  const testDefault = async () => {
    setDefaultTesting(true);
    setDefaultTest(null);
    setError(null);
    try {
      setDefaultTest(await gatewaysAdminApi.test(0));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setDefaultTesting(false);
    }
  };

  const togglePrivate = async (allow: boolean) => {
    setTogglingPrivate(true);
    setError(null);
    try {
      const stored = await gatewaysAdminApi.setAllowPrivate(allow);
      setData((current) => (current ? { ...current, allowPrivate: stored } : current));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setTogglingPrivate(false);
    }
  };

  const defaultGateway = data?.defaultGateway ?? null;
  const users = data?.users ?? [];
  const smallButton = 'inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50';

  return (
    <section className="space-y-3" data-gateways-admin>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-64">
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <Network className="h-4 w-4 text-muted-foreground" />
            {t('gateways.admin.title', { defaultValue: '网关' })}
          </h3>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            {t('gateways.admin.description', { defaultValue: '模型走哪个网关、用谁的 key。默认用 settings.json 里的网关和 key;可以再加别的网关,每个网关可以有一把默认 key,成员也可以填自己的 key(个人的优先)。' })}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-body transition-colors hover:border-border-strong hover:bg-card hover:text-foreground"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin text-primary' : ''}`} />
            {t('gateways.common.reload', { defaultValue: '重新读取' })}
          </button>
          <button
            type="button"
            onClick={() => {
              setAdding(true);
              setNotice(null);
            }}
            disabled={adding || !data}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('gateways.admin.add', { defaultValue: '添加网关' })}
          </button>
        </div>
      </div>

      {error && <p className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground" role="alert">{error}</p>}
      {notice && !adding && (
        <p className="bg-primary/8 rounded-md border border-primary/30 px-3 py-2 text-xs text-card-foreground dark:text-primary">{notice}</p>
      )}

      {adding && (
        <GatewayForm
          title={t('gateways.admin.addTitle', { defaultValue: '添加共享网关' })}
          withKey
          keyLabel={t('gateways.admin.defaultKeyOptional', { defaultValue: '默认 key(可选)' })}
          keyHint={t('gateways.admin.defaultKeyOptionalHint', { defaultValue: '不填也行 —— 那就只有填了个人 key 的人能用这个网关上的模型。' })}
          saveLabel={t('gateways.admin.create', { defaultValue: '保存网关' })}
          onCancel={() => setAdding(false)}
          onTestUnsaved={(values) => gatewaysAdminApi.testUnsaved({ baseUrl: values.baseUrl, authType: values.authType, key: values.key })}
          onSave={async (values) => {
            const created = await gatewaysAdminApi.create({
              name: values.name.trim(),
              baseUrl: values.baseUrl.trim(),
              authType: values.authType,
              ...(values.key.trim() ? { defaultKey: values.key.trim() } : {}),
            });
            setData((current) => (current ? { ...current, gateways: [...current.gateways, created] } : current));
            setAdding(false);
            setNotice(t('gateways.admin.createdNotice', { defaultValue: '已添加网关「{{name}}」。在下面的模型目录里把模型挂到它上面。', name: created.name }));
          }}
        />
      )}

      <div className="overflow-hidden rounded-lg border border-border">
        <ul className="divide-y divide-border">
          {/* 默认网关:settings.json 里的那一套,不进库、不能改,只能测和管成员 key */}
          <li className="space-y-2 px-3 py-2.5" data-gateway-row="0">
            <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
              <div className="min-w-0 flex-1 basis-56">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-semibold text-foreground">{t('gateways.defaultName', { defaultValue: '默认网关(settings.json)' })}</span>
                  {defaultGateway && (
                    <>
                      <span className="rounded border border-border bg-muted px-1 py-px font-mono text-[10px] leading-4 text-muted-foreground">{authTypeBadge(defaultGateway.authType)}</span>
                      <span className="text-[10px] leading-4 text-muted-foreground">{t('gateways.common.modelCount', { defaultValue: '{{n}} 个模型', n: defaultGateway.modelCount })}</span>
                    </>
                  )}
                </div>
                <div className="mt-0.5 break-all font-mono text-[11px] leading-4 text-muted-foreground">
                  {defaultGateway ? (defaultGateway.baseUrl ?? defaultGateway.host ?? t('gateways.admin.defaultNoBaseUrl', { defaultValue: '未设 ANTHROPIC_BASE_URL(直连 Anthropic)' })) : '…'}
                </div>
                {defaultGateway && (
                  <div className={`mt-0.5 text-[11px] leading-4 ${defaultGateway.hasDefaultKey ? 'text-muted-foreground' : 'text-amber-700 dark:text-amber-400'}`}>
                    {defaultGateway.hasDefaultKey
                      ? t('gateways.admin.settingsHasToken', { defaultValue: 'settings.json 里有 token —— 没填个人 key 的人都用它' })
                      : t('gateways.admin.settingsNoToken', { defaultValue: 'settings.json 里没有 token —— 只有填了个人 key 的人能用' })}
                  </div>
                )}
                {defaultTest && <div className="mt-1"><GatewayTestResultLine result={defaultTest} /></div>}
              </div>
              <div className="flex flex-wrap items-center gap-1">
                <button type="button" onClick={() => void testDefault()} disabled={defaultTesting || !defaultGateway} className={smallButton}>
                  <PlugZap className={`h-3.5 w-3.5 ${defaultTesting ? 'animate-pulse text-primary' : ''}`} />
                  {defaultTesting ? t('gateways.common.testing', { defaultValue: '测试中…' }) : t('gateways.common.testConnection', { defaultValue: '测试连接' })}
                </button>
                <button
                  type="button"
                  onClick={() => setDefaultPanel((current) => !current)}
                  disabled={!defaultGateway}
                  className={`${smallButton} ${defaultPanel ? 'bg-muted text-foreground' : ''}`}
                >
                  <Users className="h-3.5 w-3.5" />
                  {t('gateways.admin.memberKeys', { defaultValue: '成员 key' })}
                </button>
              </div>
            </div>
            {defaultPanel && (
              <MemberKeysPanel
                gatewayId={0}
                gatewayName={t('gateways.defaultName', { defaultValue: '默认网关(settings.json)' })}
                users={users}
                onClose={() => setDefaultPanel(false)}
              />
            )}
          </li>

          {(data?.gateways ?? []).map((gateway) => (
            <SharedGatewayRow
              key={gateway.id}
              gateway={gateway}
              users={users}
              onChanged={replaceGateway}
              onRemoved={removeGateway}
            />
          ))}
        </ul>
        {data && data.gateways.length === 0 && (
          <p className="border-t border-border px-4 py-4 text-center text-xs text-muted-foreground">
            {t('gateways.admin.emptyShared', { defaultValue: '还没有别的网关。所有模型都走默认网关;点「添加网关」接入另一家。' })}
          </p>
        )}
      </div>

      {data && (
        <div className="space-y-2 rounded-lg border border-border p-3">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                {t('gateways.admin.allowPrivate', { defaultValue: '允许成员添加私有网关和模型' })}
              </p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {t('gateways.admin.allowPrivateHelp', { defaultValue: '打开后,每个人能在「模型网关」里加只有自己看得到、用得了的网关和模型。关掉后私有模型立刻不能再用;已有的数据保留,本人仍可删除。' })}
              </p>
            </div>
            <SettingsToggle
              checked={data.allowPrivate}
              onChange={(value) => void togglePrivate(value)}
              disabled={togglingPrivate}
              ariaLabel={t('gateways.admin.allowPrivate', { defaultValue: '允许成员添加私有网关和模型' })}
            />
          </div>

          {data.privateGateways.length > 0 ? (
            <div>
              <button
                type="button"
                onClick={() => setShowPrivate((current) => !current)}
                aria-expanded={showPrivate}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                {showPrivate ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                {t('gateways.admin.privateListToggle', { defaultValue: '成员的私有网关({{n}})', n: data.privateGateways.length })}
              </button>
              {showPrivate && (
                <ul className="mt-2 divide-y divide-border overflow-hidden rounded-md border border-border">
                  {data.privateGateways.map((gateway) => (
                    <li key={gateway.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2 text-xs">
                      <span className="font-medium text-foreground">{gateway.ownerUsername ?? `#${gateway.ownerUserId ?? '?'}`}</span>
                      <span className={gateway.enabled ? 'text-foreground' : 'text-muted-foreground'}>{gateway.name}</span>
                      <span className="min-w-0 break-all font-mono text-[11px] text-muted-foreground">{gateway.host ?? '—'}</span>
                      {!gateway.enabled && (
                        <span className="rounded border border-border px-1 py-px text-[10px] leading-4 text-muted-foreground">{t('gateways.common.disabledBadge', { defaultValue: '已停用' })}</span>
                      )}
                      <span className="text-[11px] text-muted-foreground">{t('gateways.common.modelCount', { defaultValue: '{{n}} 个模型', n: gateway.modelCount })}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{t('gateways.admin.privateNone', { defaultValue: '还没有人加私有网关。' })}</p>
          )}
        </div>
      )}
    </section>
  );
}
