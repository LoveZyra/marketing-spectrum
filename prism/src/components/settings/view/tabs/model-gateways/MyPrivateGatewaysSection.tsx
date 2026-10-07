import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, KeyRound, Lock, Pencil, PlugZap, Plus, Trash2 } from 'lucide-react';

import type { CatalogEntry } from '../model-catalog/modelCatalogApi';

import GatewayForm from './GatewayForm';
import GatewayTestResultLine from './GatewayTestResultLine';
import KeyEntryForm from './KeyEntryForm';
import { authTypeBadge, maskKey, type PrivateSectionMode } from './gatewayLogic';
import { errorMessage, gatewaysAdminApi, myGatewaysApi, type GatewayTestResult, type MyGatewayView } from './gatewaysApi';

/**
 * 「模型网关 → 我的私有网关」。只有自己看得到、用得了;key 就是网关本身的(不分默认 / 个人)。
 *
 * - `active`(root 允许):加 / 改 / 换 key / 测试 / 启停 / 删;
 * - `readonly`(root 关掉了私有网关,但我名下还有):只列出来,只能删;关掉之后服务端对改动一律回 403。
 * 删网关时服务端会连同挂在上面的私有模型一起删,确认按钮上写明有几个。
 */
type Props = {
  owned: MyGatewayView[];
  mode: Exclude<PrivateSectionMode, 'hidden'>;
  onGateways: (next: MyGatewayView[]) => void;
  onModels: (next: CatalogEntry[]) => void;
};

export default function MyPrivateGatewaysSection({ owned, mode, onGateways, onModels }: Props) {
  const { t } = useTranslation('settings');
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const active = mode === 'active';

  return (
    <section className="space-y-3" data-my-private-gateways>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-64">
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <Lock className="h-4 w-4 text-muted-foreground" />
            {t('gateways.privateGw.title', { defaultValue: '我的私有网关' })}
          </h3>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            {t('gateways.privateGw.description', { defaultValue: '接入你自己的网关和 key,只有你看得到、用得了。管理员只看得到网关名和主机名,看不到 key。' })}
          </p>
        </div>
        {active && (
          <button
            type="button"
            onClick={() => {
              setAdding(true);
              setNotice(null);
            }}
            disabled={adding}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('gateways.privateGw.add', { defaultValue: '添加私有网关' })}
          </button>
        )}
      </div>

      {!active && (
        <p className="flex items-start gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {t('gateways.privateGw.disabledNote', { defaultValue: '管理员关掉了私有网关:下面这些暂时用不了,只能删除。' })}
        </p>
      )}
      {notice && !adding && (
        <p className="bg-primary/8 rounded-md border border-primary/30 px-3 py-2 text-xs text-card-foreground dark:text-primary">{notice}</p>
      )}

      {adding && active && (
        <GatewayForm
          title={t('gateways.privateGw.addTitle', { defaultValue: '添加私有网关' })}
          withKey
          keyHint={t('gateways.privateGw.keyHint', { defaultValue: '可以先不填,之后在列表里补;没有 key 的私有网关上的模型用不了。' })}
          saveLabel={t('gateways.admin.create', { defaultValue: '保存网关' })}
          onCancel={() => setAdding(false)}
          onTestUnsaved={(values) => gatewaysAdminApi.testUnsaved({ baseUrl: values.baseUrl, authType: values.authType, key: values.key })}
          onSave={async (values) => {
            onGateways(await myGatewaysApi.createPrivate({
              name: values.name.trim(),
              baseUrl: values.baseUrl.trim(),
              authType: values.authType,
              ...(values.key.trim() ? { key: values.key.trim() } : {}),
            }));
            setAdding(false);
            setNotice(t('gateways.privateGw.createdNotice', { defaultValue: '已添加「{{name}}」。在下面「我的私有模型」里把模型挂上去。', name: values.name.trim() }));
          }}
        />
      )}

      {owned.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-4 text-center text-xs text-muted-foreground">
          {t('gateways.privateGw.empty', { defaultValue: '还没有私有网关。' })}
        </p>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {owned.map((gateway) => (
            <PrivateGatewayRow key={gateway.id} gateway={gateway} active={active} onGateways={onGateways} onModels={onModels} />
          ))}
        </ul>
      )}
    </section>
  );
}

type Panel = 'edit' | 'key' | null;

function PrivateGatewayRow({ gateway, active, onGateways, onModels }: {
  gateway: MyGatewayView;
  active: boolean;
  onGateways: (next: MyGatewayView[]) => void;
  onModels: (next: CatalogEntry[]) => void;
}) {
  const { t } = useTranslation('settings');
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState<'toggle' | 'test' | 'delete' | 'clearKey' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmClearKey, setConfirmClearKey] = useState(false);
  const [testResult, setTestResult] = useState<GatewayTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const last4 = gateway.defaultKeyLast4 ?? gateway.personalLast4;

  const run = async (kind: NonNullable<typeof busy>, action: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  const togglePanel = (next: Panel) => {
    setPanel((current) => (current === next ? null : next));
    setError(null);
  };

  const smallButton = 'inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50';

  return (
    <li className={`space-y-2 px-3 py-2.5 ${gateway.enabled && active ? '' : 'bg-muted/40'}`} data-private-gateway={gateway.id}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-56">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`text-sm font-semibold ${gateway.enabled ? 'text-foreground' : 'text-muted-foreground'}`}>{gateway.name}</span>
            <span className="rounded border border-border bg-muted px-1 py-px font-mono text-[10px] leading-4 text-muted-foreground">{authTypeBadge(gateway.authType)}</span>
            {!gateway.enabled && (
              <span className="rounded border border-border px-1 py-px text-[10px] leading-4 text-muted-foreground">{t('gateways.common.disabledBadge', { defaultValue: '已停用' })}</span>
            )}
            <span className="text-[10px] leading-4 text-muted-foreground">{t('gateways.common.modelCount', { defaultValue: '{{n}} 个模型', n: gateway.modelCount })}</span>
          </div>
          <div className="mt-0.5 break-all font-mono text-[11px] leading-4 text-muted-foreground">{gateway.baseUrl ?? gateway.host ?? '—'}</div>
          {gateway.hasDefaultKey ? (
            <div className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{t('gateways.privateGw.keySet', { defaultValue: 'key {{key}}', key: maskKey(last4) })}</div>
          ) : (
            <div className="mt-0.5 flex items-start gap-1 text-[11px] leading-4 text-amber-700 dark:text-amber-400">
              <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
              <span>{t('gateways.privateGw.keyMissing', { defaultValue: '还没有 key —— 填上才能用' })}</span>
            </div>
          )}
          {testResult && <div className="mt-1"><GatewayTestResultLine result={testResult} /></div>}
        </div>

        <div className="flex flex-wrap items-center gap-1">
          {active && (
            <>
              <button
                type="button"
                role="switch"
                aria-checked={gateway.enabled}
                aria-label={t('gateways.common.enabled', { defaultValue: '启用' })}
                title={gateway.enabled ? t('gateways.common.disable', { defaultValue: '停用' }) : t('gateways.common.enable', { defaultValue: '启用' })}
                onClick={() => void run('toggle', async () => onGateways(await myGatewaysApi.updatePrivate(gateway.id, { enabled: !gateway.enabled })))}
                disabled={busy !== null}
                className={`relative mr-1 h-5 w-9 shrink-0 rounded-full border transition-colors disabled:opacity-50 ${gateway.enabled ? 'border-primary bg-primary' : 'border-border bg-muted'}`}
              >
                <span className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-background shadow transition-colors ${gateway.enabled ? 'left-[1.125rem]' : 'left-0.5'}`} />
              </button>
              <button
                type="button"
                onClick={() => void run('test', async () => {
                  setTestResult(null);
                  setTestResult(await myGatewaysApi.test(gateway.id));
                })}
                disabled={busy !== null}
                className={smallButton}
              >
                <PlugZap className={`h-3.5 w-3.5 ${busy === 'test' ? 'animate-pulse text-primary' : ''}`} />
                {busy === 'test' ? t('gateways.common.testing', { defaultValue: '测试中…' }) : t('gateways.common.test', { defaultValue: '测试' })}
              </button>
              <button type="button" onClick={() => togglePanel('edit')} className={`${smallButton} ${panel === 'edit' ? 'bg-muted text-foreground' : ''}`}>
                <Pencil className="h-3.5 w-3.5" />
                {t('gateways.common.edit', { defaultValue: '编辑' })}
              </button>
              <button type="button" onClick={() => togglePanel('key')} className={`${smallButton} ${panel === 'key' ? 'bg-muted text-foreground' : ''}`}>
                <KeyRound className="h-3.5 w-3.5" />
                {gateway.hasDefaultKey
                  ? t('gateways.privateGw.replaceKey', { defaultValue: '更换 key' })
                  : t('gateways.privateGw.setKey', { defaultValue: '填 key' })}
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => {
              if (!confirmDelete) {
                setConfirmDelete(true);
                return;
              }
              void run('delete', async () => {
                const result = await myGatewaysApi.removePrivate(gateway.id);
                onModels(result.models);
                onGateways(result.gateways);
              }).finally(() => setConfirmDelete(false));
            }}
            onBlur={() => setConfirmDelete(false)}
            disabled={busy !== null}
            aria-label={t('gateways.common.delete', { defaultValue: '删除' })}
            title={t('gateways.privateGw.deleteTitle', { defaultValue: '删除这个网关,连同挂在上面的私有模型' })}
            className={`inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs transition-colors disabled:opacity-50 ${
              confirmDelete ? 'bg-destructive/10 text-destructive' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {confirmDelete && (gateway.modelCount > 0
              ? t('gateways.privateGw.confirmDeleteWithModels', { defaultValue: '确认删除(连同 {{n}} 个私有模型)', n: gateway.modelCount })
              : t('gateways.common.confirmDelete', { defaultValue: '确认删除' }))}
          </button>
        </div>
      </div>

      {error && (
        <p className="flex items-start gap-1 rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground" role="alert">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-700 dark:text-amber-400" />
          <span className="min-w-0 break-words">{error}</span>
        </p>
      )}

      {active && panel === 'edit' && (
        <GatewayForm
          title={t('gateways.admin.editTitle', { defaultValue: '编辑网关「{{name}}」', name: gateway.name })}
          initial={{ name: gateway.name, baseUrl: gateway.baseUrl, authType: gateway.authType }}
          withKey={false}
          onCancel={() => setPanel(null)}
          onSave={async (values) => {
            onGateways(await myGatewaysApi.updatePrivate(gateway.id, { name: values.name.trim(), baseUrl: values.baseUrl.trim(), authType: values.authType }));
            setPanel(null);
          }}
        />
      )}

      {active && panel === 'key' && (
        <div className="space-y-2">
          {gateway.hasDefaultKey && (
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>{t('gateways.privateGw.currentKey', { defaultValue: '现在的 key:{{key}}', key: maskKey(last4) })}</span>
              <button
                type="button"
                onClick={() => {
                  if (!confirmClearKey) {
                    setConfirmClearKey(true);
                    return;
                  }
                  void run('clearKey', async () => {
                    onGateways(await myGatewaysApi.setPrivateKey(gateway.id, null));
                    setPanel(null);
                  }).finally(() => setConfirmClearKey(false));
                }}
                onBlur={() => setConfirmClearKey(false)}
                disabled={busy !== null}
                className={`inline-flex items-center gap-1 rounded-md px-2 py-1 transition-colors disabled:opacity-50 ${
                  confirmClearKey ? 'bg-destructive/10 text-destructive' : 'border border-border hover:bg-muted hover:text-foreground'
                }`}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {confirmClearKey
                  ? t('gateways.privateGw.confirmClearKey', { defaultValue: '确认清除 —— 之后这个网关上的模型用不了' })
                  : t('gateways.privateGw.clearKey', { defaultValue: '清除 key' })}
              </button>
            </div>
          )}
          <KeyEntryForm
            ariaLabel={t('gateways.privateGw.keyAria', { defaultValue: '私有网关的 key' })}
            onCancel={() => setPanel(null)}
            onTest={(key) => myGatewaysApi.test(gateway.id, key)}
            onSave={async (key) => {
              onGateways(await myGatewaysApi.setPrivateKey(gateway.id, key));
              setPanel(null);
              setTestResult(null);
            }}
          />
        </div>
      )}
    </li>
  );
}
