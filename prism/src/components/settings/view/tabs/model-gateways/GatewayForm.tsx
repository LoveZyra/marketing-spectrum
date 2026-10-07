import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PlugZap, Save, X } from 'lucide-react';

import GatewayTestResultLine from './GatewayTestResultLine';
import SecretKeyInput from './SecretKeyInput';
import {
  FORM_PROBLEM_FALLBACKS,
  GATEWAY_NAME_MAX_LENGTH,
  baseUrlSavedAs,
  formProblemKey,
  formProblemVars,
  gatewayFormProblem,
  unsavedTestProblem,
  type FormProblem,
} from './gatewayLogic';
import { GATEWAY_AUTH_TYPES, errorMessage, type GatewayAuthType, type GatewayTestResult } from './gatewaysApi';

/**
 * 网关表单,root 的共享网关与每个人的私有网关共用。
 *
 * - 新建(`withKey`):名字 / 地址 / 鉴权方式 / 可选的 key;「先测试」用表单里的地址与 key 打一次(不保存);
 * - 编辑(不带 key):只改名字 / 地址 / 鉴权方式。key 在行上单独换,免得一改名字就要重新粘一遍 key。
 */
export type GatewayFormValues = { name: string; baseUrl: string; authType: GatewayAuthType; key: string };

type Props = {
  title: string;
  initial?: { name: string; baseUrl: string | null; authType: GatewayAuthType };
  withKey: boolean;
  keyLabel?: string;
  keyHint?: string;
  saveLabel?: string;
  onSave: (values: GatewayFormValues) => Promise<void>;
  /** 新建时「先测试」;不给就不画这个按钮 */
  onTestUnsaved?: (values: GatewayFormValues) => Promise<GatewayTestResult>;
  onCancel: () => void;
};

const inputClass = 'w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm transition-colors focus:border-primary focus:outline-none';

export default function GatewayForm({ title, initial, withKey, keyLabel, keyHint, saveLabel, onSave, onTestUnsaved, onCancel }: Props) {
  const { t } = useTranslation('settings');
  const [name, setName] = useState(initial?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '');
  const [authType, setAuthType] = useState<GatewayAuthType>(initial?.authType ?? 'bearer');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<GatewayTestResult | null>(null);

  const values: GatewayFormValues = { name, baseUrl, authType, key: withKey ? key : '' };
  const problem = gatewayFormProblem(values, withKey ? 'optional' : 'none');
  const testProblem = unsavedTestProblem(values);
  const describe = (code: FormProblem) => t(formProblemKey(code), { defaultValue: FORM_PROBLEM_FALLBACKS[code], ...formProblemVars(code) });
  const savedAs = baseUrlSavedAs(baseUrl);
  // 还什么都没填时不提示"要填网关名" —— 按钮本来就是灰的
  const touched = Boolean(name.trim() || baseUrl.trim() || key.trim());

  const save = async () => {
    if (problem || busy) return;
    setBusy('save');
    setError(null);
    try {
      await onSave(values);
      setKey('');
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    if (!onTestUnsaved || testProblem || busy) return;
    setBusy('test');
    setError(null);
    setTestResult(null);
    try {
      setTestResult(await onTestUnsaved(values));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  const resetTest = () => setTestResult(null);

  return (
    <div className="space-y-3 rounded-lg border border-primary/30 bg-card p-3 sm:p-4" data-gateway-form>
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 truncate text-sm font-semibold text-foreground">{title}</p>
        <button
          type="button"
          onClick={onCancel}
          aria-label={t('gateways.common.cancel', { defaultValue: '取消' })}
          className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="block min-w-0">
          <span className="mb-1 block text-xs font-medium text-foreground">{t('gateways.form.name', { defaultValue: '网关名' })}</span>
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={GATEWAY_NAME_MAX_LENGTH}
            placeholder={t('gateways.form.namePlaceholder', { defaultValue: '比如:智谱 GLM、公司 DeepSeek' })}
            autoComplete="off"
            data-lpignore="true"
            data-1p-ignore="true"
            className={inputClass}
          />
        </label>
        <label className="block min-w-0">
          <span className="mb-1 block text-xs font-medium text-foreground">{t('gateways.form.authType', { defaultValue: '鉴权方式' })}</span>
          <select
            value={authType}
            onChange={(event) => {
              setAuthType(event.target.value as GatewayAuthType);
              resetTest();
            }}
            className={inputClass}
          >
            {GATEWAY_AUTH_TYPES.map((type) => (
              <option key={type} value={type}>
                {type === 'bearer'
                  ? t('gateways.authType.bearer', { defaultValue: 'Bearer(Authorization: Bearer …)' })
                  : t('gateways.authType.xApiKey', { defaultValue: 'x-api-key(请求头 x-api-key)' })}
              </option>
            ))}
          </select>
        </label>
        <label className="block min-w-0 md:col-span-2">
          <span className="mb-1 block text-xs font-medium text-foreground">{t('gateways.form.baseUrl', { defaultValue: '网关地址' })}</span>
          <input
            type="url"
            inputMode="url"
            value={baseUrl}
            onChange={(event) => {
              setBaseUrl(event.target.value);
              resetTest();
            }}
            placeholder="https://gateway.example.com"
            spellCheck={false}
            autoComplete="off"
            data-lpignore="true"
            data-1p-ignore="true"
            className={`${inputClass} font-mono`}
          />
          <span className="mt-1 block break-all text-[11px] leading-4 text-muted-foreground">
            {savedAs
              ? t('gateways.form.baseUrlSavedAs', { defaultValue: '会存成 {{url}}(CLI 自己拼 /v1/messages)', url: savedAs })
              : t('gateways.form.baseUrlHelp', { defaultValue: '填到 /v1 之前为止,CLI 会自己拼 /v1/messages。' })}
          </span>
        </label>
        {withKey && (
          <div className="min-w-0 md:col-span-2">
            <span className="mb-1 block text-xs font-medium text-foreground">{keyLabel ?? t('gateways.form.key', { defaultValue: 'key(可选)' })}</span>
            <SecretKeyInput
              value={key}
              onChange={(next) => {
                setKey(next);
                resetTest();
              }}
              ariaLabel={keyLabel ?? t('gateways.form.key', { defaultValue: 'key(可选)' })}
              placeholder={t('gateways.common.keyPlaceholder', { defaultValue: '粘贴 key(只存服务端,保存后只显示末四位)' })}
            />
            {keyHint && <span className="mt-1 block text-[11px] leading-4 text-muted-foreground">{keyHint}</span>}
          </div>
        )}
      </div>

      {testResult && <GatewayTestResultLine result={testResult} />}
      {(error || (touched && problem)) && (
        <p className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground" role="alert">
          {error ?? (problem ? describe(problem) : '')}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {t('gateways.common.cancel', { defaultValue: '取消' })}
        </button>
        {onTestUnsaved && (
          <button
            type="button"
            onClick={() => void test()}
            disabled={Boolean(testProblem) || busy !== null}
            title={testProblem ? describe(testProblem) : t('gateways.form.testFirstTitle', { defaultValue: '用表单里的地址和 key 打一次 /v1/models,不保存' })}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-muted disabled:opacity-50"
          >
            <PlugZap className={`h-4 w-4 ${busy === 'test' ? 'animate-pulse text-primary' : ''}`} />
            {busy === 'test' ? t('gateways.common.testing', { defaultValue: '测试中…' }) : t('gateways.common.testFirst', { defaultValue: '先测试' })}
          </button>
        )}
        <button
          type="button"
          onClick={() => void save()}
          disabled={Boolean(problem) || busy !== null}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          <Save className="h-4 w-4" />
          {busy === 'save' ? t('gateways.common.saving', { defaultValue: '保存中…' }) : (saveLabel ?? t('gateways.common.save', { defaultValue: '保存' }))}
        </button>
      </div>
    </div>
  );
}
