import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, KeyRound, Pencil, PlugZap, Trash2, Users } from 'lucide-react';

import GatewayForm from './GatewayForm';
import GatewayTestResultLine from './GatewayTestResultLine';
import KeyEntryForm from './KeyEntryForm';
import MemberKeysPanel from './MemberKeysPanel';
import { authTypeBadge, describeDefaultKey, maskKey } from './gatewayLogic';
import { errorMessage, gatewaysAdminApi, type BasicUser, type GatewayTestResult, type GatewayView } from './gatewaysApi';

/**
 * root 的共享网关一行:名字 / 地址 / 鉴权方式 / 默认 key 状态 / 启用开关 / 模型数,
 * 行内展开:编辑、设置 / 更换 / 清除默认 key、成员 key;测试连接的结果挂在行上。
 * 删除:还有目录模型挂着时服务端回 409(GATEWAY_IN_USE),把它的原话显示在行上。
 */
type Panel = 'edit' | 'key' | 'members' | null;

type Props = {
  gateway: GatewayView;
  users: BasicUser[];
  onChanged: (next: GatewayView) => void;
  onRemoved: (id: number) => void;
};

export default function SharedGatewayRow({ gateway, users, onChanged, onRemoved }: Props) {
  const { t } = useTranslation('settings');
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState<'toggle' | 'test' | 'delete' | 'clearKey' | null>(null);
  const [testResult, setTestResult] = useState<GatewayTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmClearKey, setConfirmClearKey] = useState(false);
  const keyView = describeDefaultKey(gateway);

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
  const activeButton = 'bg-muted text-foreground';

  return (
    <li className={`space-y-2 px-3 py-2.5 ${gateway.enabled ? '' : 'bg-muted/40'}`} data-gateway-row={gateway.id}>
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
          <div className="mt-0.5 break-all font-mono text-[11px] leading-4 text-muted-foreground" title={gateway.baseUrl ?? undefined}>
            {gateway.baseUrl ?? gateway.host ?? '—'}
          </div>
          {keyView.kind === 'set' ? (
            <div className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
              {t('gateways.admin.defaultKeySet', { defaultValue: '默认 key {{key}}', key: maskKey(keyView.last4) })}
            </div>
          ) : (
            <div className="mt-0.5 flex items-start gap-1 text-[11px] leading-4 text-amber-700 dark:text-amber-400">
              <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
              <span>{t('gateways.admin.defaultKeyMissing', { defaultValue: '没有默认 key —— 只有填了个人 key 的人能用' })}</span>
            </div>
          )}
          {testResult && <div className="mt-1"><GatewayTestResultLine result={testResult} /></div>}
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            role="switch"
            aria-checked={gateway.enabled}
            aria-label={t('gateways.common.enabled', { defaultValue: '启用' })}
            onClick={() => void run('toggle', async () => onChanged(await gatewaysAdminApi.update(gateway.id, { enabled: !gateway.enabled })))}
            disabled={busy !== null}
            title={gateway.enabled ? t('gateways.common.disable', { defaultValue: '停用' }) : t('gateways.common.enable', { defaultValue: '启用' })}
            className={`relative mr-1 h-5 w-9 shrink-0 rounded-full border transition-colors disabled:opacity-50 ${gateway.enabled ? 'border-primary bg-primary' : 'border-border bg-muted'}`}
          >
            <span className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-background shadow transition-colors ${gateway.enabled ? 'left-[1.125rem]' : 'left-0.5'}`} />
          </button>
          <button
            type="button"
            onClick={() => void run('test', async () => {
              setTestResult(null);
              setTestResult(await gatewaysAdminApi.test(gateway.id));
            })}
            disabled={busy !== null}
            title={t('gateways.admin.testTitle', { defaultValue: '用默认 key 打一次 /v1/models(你自己在这个网关上有个人 key 时用你的)' })}
            className={smallButton}
          >
            <PlugZap className={`h-3.5 w-3.5 ${busy === 'test' ? 'animate-pulse text-primary' : ''}`} />
            {busy === 'test' ? t('gateways.common.testing', { defaultValue: '测试中…' }) : t('gateways.common.testConnection', { defaultValue: '测试连接' })}
          </button>
          <button type="button" onClick={() => togglePanel('edit')} className={`${smallButton} ${panel === 'edit' ? activeButton : ''}`}>
            <Pencil className="h-3.5 w-3.5" />
            {t('gateways.common.edit', { defaultValue: '编辑' })}
          </button>
          <button type="button" onClick={() => togglePanel('key')} className={`${smallButton} ${panel === 'key' ? activeButton : ''}`}>
            <KeyRound className="h-3.5 w-3.5" />
            {keyView.kind === 'set'
              ? t('gateways.admin.replaceDefaultKey', { defaultValue: '更换默认 key' })
              : t('gateways.admin.setDefaultKey', { defaultValue: '设置默认 key' })}
          </button>
          <button type="button" onClick={() => togglePanel('members')} className={`${smallButton} ${panel === 'members' ? activeButton : ''}`}>
            <Users className="h-3.5 w-3.5" />
            {t('gateways.admin.memberKeys', { defaultValue: '成员 key' })}
          </button>
          <button
            type="button"
            onClick={() => {
              if (!confirmDelete) {
                setConfirmDelete(true);
                return;
              }
              void run('delete', async () => {
                await gatewaysAdminApi.remove(gateway.id);
                onRemoved(gateway.id);
              }).finally(() => setConfirmDelete(false));
            }}
            onBlur={() => setConfirmDelete(false)}
            disabled={busy !== null}
            aria-label={t('gateways.common.delete', { defaultValue: '删除' })}
            title={t('gateways.common.delete', { defaultValue: '删除' })}
            className={`inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs transition-colors disabled:opacity-50 ${
              confirmDelete ? 'bg-destructive/10 text-destructive' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {confirmDelete && t('gateways.common.confirmDelete', { defaultValue: '确认删除' })}
          </button>
        </div>
      </div>

      {error && (
        <p className="flex items-start gap-1 rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground" role="alert">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-700 dark:text-amber-400" />
          <span className="min-w-0 break-words">{error}</span>
        </p>
      )}

      {panel === 'edit' && (
        <GatewayForm
          title={t('gateways.admin.editTitle', { defaultValue: '编辑网关「{{name}}」', name: gateway.name })}
          initial={{ name: gateway.name, baseUrl: gateway.baseUrl, authType: gateway.authType }}
          withKey={false}
          onCancel={() => setPanel(null)}
          onSave={async (values) => {
            onChanged(await gatewaysAdminApi.update(gateway.id, { name: values.name.trim(), baseUrl: values.baseUrl.trim(), authType: values.authType }));
            setPanel(null);
          }}
        />
      )}

      {panel === 'key' && (
        <div className="space-y-2">
          {keyView.kind === 'set' && (
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>{t('gateways.admin.currentDefaultKey', { defaultValue: '现在的默认 key:{{key}}', key: maskKey(keyView.last4) })}</span>
              <button
                type="button"
                onClick={() => {
                  if (!confirmClearKey) {
                    setConfirmClearKey(true);
                    return;
                  }
                  void run('clearKey', async () => {
                    onChanged(await gatewaysAdminApi.clearDefaultKey(gateway.id));
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
                  ? t('gateways.admin.confirmClearDefaultKey', { defaultValue: '确认清除 —— 之后只有填了个人 key 的人能用' })
                  : t('gateways.admin.clearDefaultKey', { defaultValue: '清除默认 key' })}
              </button>
            </div>
          )}
          <KeyEntryForm
            ariaLabel={t('gateways.admin.defaultKeyLabel', { defaultValue: '网关的默认 key' })}
            hint={t('gateways.admin.defaultKeyHint', { defaultValue: '没填个人 key 的人都用这把。' })}
            onCancel={() => setPanel(null)}
            onTest={(key) => gatewaysAdminApi.test(gateway.id, key)}
            onSave={async (key) => {
              onChanged(await gatewaysAdminApi.setDefaultKey(gateway.id, key));
              setPanel(null);
            }}
          />
        </div>
      )}

      {panel === 'members' && (
        <MemberKeysPanel gatewayId={gateway.id} gatewayName={gateway.name} users={users} onClose={() => setPanel(null)} />
      )}
    </li>
  );
}
