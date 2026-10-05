import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PlugZap, Save } from 'lucide-react';

import GatewayTestResultLine from './GatewayTestResultLine';
import SecretKeyInput from './SecretKeyInput';
import { FORM_PROBLEM_FALLBACKS, formProblemKey, formProblemVars, keyProblem } from './gatewayLogic';
import { errorMessage, type GatewayTestResult } from './gatewaysApi';

/**
 * hq:内联的「填 key」小表单 —— 默认 key、我的个人 key、私有网关的 key 共用。
 * 保存成功后清空输入(父级通常顺手把表单收起);「先测试」拿输入框里这把测,不保存。
 */
type Props = {
  ariaLabel: string;
  placeholder?: string;
  saveLabel?: string;
  hint?: string;
  onSave: (key: string) => Promise<void>;
  onTest?: (key: string) => Promise<GatewayTestResult>;
  onCancel: () => void;
};

export default function KeyEntryForm({ ariaLabel, placeholder, saveLabel, hint, onSave, onTest, onCancel }: Props) {
  const { t } = useTranslation('settings');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<GatewayTestResult | null>(null);

  const problem = keyProblem(value);
  const problemText = problem
    ? t(formProblemKey(problem), { defaultValue: FORM_PROBLEM_FALLBACKS[problem], ...formProblemVars(problem) })
    : null;

  const save = async () => {
    if (problem || busy) return;
    setBusy('save');
    setError(null);
    try {
      await onSave(value);
      setValue('');
      setTestResult(null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    if (!onTest || problem || busy) return;
    setBusy('test');
    setError(null);
    setTestResult(null);
    try {
      setTestResult(await onTest(value));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-2 rounded-md border border-primary/30 bg-card p-3" data-key-entry>
      <SecretKeyInput
        value={value}
        onChange={(next) => {
          setValue(next);
          setTestResult(null);
        }}
        ariaLabel={ariaLabel}
        placeholder={placeholder ?? t('gateways.common.keyPlaceholder', { defaultValue: '粘贴 key(只存服务端,保存后只显示末四位)' })}
        onEnter={() => void save()}
        disabled={busy === 'save'}
      />
      {hint && <p className="text-[11px] leading-4 text-muted-foreground">{hint}</p>}
      {value.trim() && problemText && <p className="text-[11px] leading-4 text-amber-700 dark:text-amber-400">{problemText}</p>}
      {testResult && <GatewayTestResultLine result={testResult} />}
      {error && <p className="rounded-md border border-border bg-muted px-2.5 py-1.5 text-xs text-muted-foreground" role="alert">{error}</p>}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {t('gateways.common.cancel', { defaultValue: '取消' })}
        </button>
        {onTest && (
          <button
            type="button"
            onClick={() => void test()}
            disabled={Boolean(problem) || busy !== null}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-50"
          >
            <PlugZap className={`h-3.5 w-3.5 ${busy === 'test' ? 'animate-pulse text-primary' : ''}`} />
            {busy === 'test' ? t('gateways.common.testing', { defaultValue: '测试中…' }) : t('gateways.common.testFirst', { defaultValue: '先测试' })}
          </button>
        )}
        <button
          type="button"
          onClick={() => void save()}
          disabled={Boolean(problem) || busy !== null}
          className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          <Save className="h-3.5 w-3.5" />
          {busy === 'save' ? t('gateways.common.saving', { defaultValue: '保存中…' }) : (saveLabel ?? t('gateways.common.saveKey', { defaultValue: '保存 key' }))}
        </button>
      </div>
    </div>
  );
}
