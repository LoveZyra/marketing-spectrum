import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, KeyRound, PlugZap, Trash2 } from 'lucide-react';

import GatewayTestResultLine from './GatewayTestResultLine';
import KeyEntryForm from './KeyEntryForm';
import { authTypeBadge, describeKeySource, maskKey } from './gatewayLogic';
import { errorMessage, myGatewaysApi, type GatewayTestResult, type MyGatewayView } from './gatewaysApi';

/**
 * 「模型网关 → 我的 key」里的一张卡:默认网关 / 一个共享网关上,我的回合用哪把 key、上面有哪些我能用的模型;
 * 填 / 换 / 清我的个人 key,测试(不带 key = 测我现在会用的那把;填 key 的表单里「先测试」测输入框里那把)。
 */
type Props = {
  gateway: MyGatewayView;
  me: string | null;
  onGateways: (next: MyGatewayView[]) => void;
};

export default function MyGatewayKeyCard({ gateway, me, onGateways }: Props) {
  const { t } = useTranslation('settings');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<'test' | 'clear' | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [testResult, setTestResult] = useState<GatewayTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const source = describeKeySource(gateway, me);
  const isDefault = gateway.scope === 'default';

  const test = async () => {
    setBusy('test');
    setError(null);
    setTestResult(null);
    try {
      setTestResult(await myGatewaysApi.test(gateway.id));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  const clear = async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setBusy('clear');
    setError(null);
    setNotice(null);
    try {
      onGateways(await myGatewaysApi.clearKey(gateway.id));
      setTestResult(null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
      setConfirmClear(false);
    }
  };

  const smallButton = 'inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50';

  return (
    <div className="space-y-2 rounded-lg border border-border p-3" data-my-gateway={gateway.id}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-56">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-semibold text-foreground">
              {isDefault ? t('gateways.defaultNameShort', { defaultValue: '默认网关' }) : gateway.name}
            </span>
            <span className="rounded border border-border bg-muted px-1 py-px font-mono text-[10px] leading-4 text-muted-foreground">{authTypeBadge(gateway.authType)}</span>
          </div>
          {(gateway.baseUrl ?? gateway.host) && (
            <div className="mt-0.5 break-all font-mono text-[11px] leading-4 text-muted-foreground">{gateway.baseUrl ?? gateway.host}</div>
          )}
          <div
            className={`mt-1 flex items-start gap-1 text-xs leading-4 ${source.kind === 'none' ? 'text-amber-700 dark:text-amber-400' : 'text-foreground'}`}
            data-key-source={gateway.source}
          >
            {source.kind === 'none'
              ? <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
              : <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0 text-primary" />}
            <span className="min-w-0">
              {source.kind === 'personal' && (
                <>
                  {t('gateways.mine.sourcePersonal', { defaultValue: '用我的 key {{key}}', key: maskKey(source.last4) })}
                  {source.setByOther && (
                    <span className="ml-1 text-muted-foreground">{t('gateways.mine.setByOther', { defaultValue: '(由 {{name}} 代填)', name: source.setByOther })}</span>
                  )}
                </>
              )}
              {source.kind === 'gatewayDefault' && t('gateways.mine.sourceGatewayDefault', { defaultValue: '用网关默认 key' })}
              {source.kind === 'settings' && t('gateways.mine.sourceSettings', { defaultValue: '用默认配置(settings.json)' })}
              {source.kind === 'none' && t('gateways.mine.sourceNone', { defaultValue: '没有可用的 key,这个网关上的模型用不了' })}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            onClick={() => void test()}
            disabled={busy !== null}
            title={t('gateways.mine.testTitle', { defaultValue: '用我现在会用的那把 key 打一次 /v1/models' })}
            className={smallButton}
          >
            <PlugZap className={`h-3.5 w-3.5 ${busy === 'test' ? 'animate-pulse text-primary' : ''}`} />
            {busy === 'test' ? t('gateways.common.testing', { defaultValue: '测试中…' }) : t('gateways.common.test', { defaultValue: '测试' })}
          </button>
          {gateway.canSetPersonalKey && (
            <button
              type="button"
              onClick={() => {
                setEditing((current) => !current);
                setNotice(null);
              }}
              className={`${smallButton} ${editing ? 'bg-muted text-foreground' : ''}`}
            >
              <KeyRound className="h-3.5 w-3.5" />
              {source.kind === 'personal'
                ? t('gateways.mine.replaceKey', { defaultValue: '更换我的 key' })
                : t('gateways.mine.setKey', { defaultValue: '填我的 key' })}
            </button>
          )}
          {gateway.canSetPersonalKey && source.kind === 'personal' && (
            <button
              type="button"
              onClick={() => void clear()}
              onBlur={() => setConfirmClear(false)}
              disabled={busy !== null}
              className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors disabled:opacity-50 ${
                confirmClear ? 'bg-destructive/10 text-destructive' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {confirmClear ? t('gateways.common.confirmClear', { defaultValue: '确认清除' }) : t('gateways.common.clear', { defaultValue: '清除' })}
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-1" data-my-gateway-models>
        {gateway.models.length === 0 ? (
          <span className="text-[11px] text-muted-foreground">{t('gateways.mine.noModels', { defaultValue: '这个网关上暂时没有你能用的模型。' })}</span>
        ) : (
          gateway.models.map((model) => (
            <span
              key={model.modelId}
              title={model.modelId}
              className={`max-w-full truncate rounded border px-1.5 py-px text-[11px] leading-4 ${source.kind === 'none' ? 'border-border text-muted-foreground opacity-60' : 'border-border bg-muted text-foreground'}`}
            >
              {model.label}
            </span>
          ))
        )}
      </div>

      {testResult && <GatewayTestResultLine result={testResult} />}
      {error && <p className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground" role="alert">{error}</p>}
      {notice && !editing && (
        <p className="bg-primary/8 rounded-md border border-primary/30 px-3 py-2 text-xs text-card-foreground dark:text-primary">{notice}</p>
      )}

      {editing && (
        <KeyEntryForm
          ariaLabel={t('gateways.mine.keyLabel', { defaultValue: '我在这个网关上的 key' })}
          hint={isDefault
            ? t('gateways.mine.keyHintDefault', { defaultValue: '填了之后,你的回合用你自己的 key;清掉就回到默认配置。' })
            : t('gateways.mine.keyHintShared', { defaultValue: '填了之后,你的回合用你自己的 key,不再用网关的默认 key。' })}
          onCancel={() => setEditing(false)}
          onTest={(key) => myGatewaysApi.test(gateway.id, key)}
          onSave={async (key) => {
            onGateways(await myGatewaysApi.setKey(gateway.id, key));
            setEditing(false);
            setTestResult(null);
            setNotice(t('gateways.mine.savedNotice', { defaultValue: '已保存。之后你在这个网关上的回合用这把 key。' }));
          }}
        />
      )}
    </div>
  );
}
