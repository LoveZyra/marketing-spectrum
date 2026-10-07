import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Save, Trash2, Users, X } from 'lucide-react';

import SecretKeyInput from './SecretKeyInput';
import { FORM_PROBLEM_FALLBACKS, formatDbTime, formProblemKey, formProblemVars, keyProblem, maskKey } from './gatewayLogic';
import { errorMessage, gatewaysAdminApi, type BasicUser, type GatewayKeyHolder } from './gatewaysApi';

/**
 * root 管某个网关(含默认网关 0)上的「成员 key」:谁填了个人 key(只看末四位)、替人填 / 换 / 清。
 * 个人 key 只给那个人自己的回合用,优先于网关的默认 key。
 */
type Props = {
  gatewayId: number;
  gatewayName: string;
  users: BasicUser[];
  onClose: () => void;
};

export default function MemberKeysPanel({ gatewayId, gatewayName, users, onClose }: Props) {
  const { t } = useTranslation('settings');
  const [holders, setHolders] = useState<GatewayKeyHolder[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [userId, setUserId] = useState<string>('');
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState<number | null>(null);
  const [confirmClear, setConfirmClear] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setHolders(await gatewaysAdminApi.keys(gatewayId));
    } catch (caught) {
      setLoadError(errorMessage(caught));
    }
  }, [gatewayId]);

  useEffect(() => {
    void load();
  }, [load]);

  const problem = keyProblem(key);
  const holderIds = new Set((holders ?? []).map((holder) => holder.userId));
  const selectedUser = users.find((user) => String(user.id) === userId) ?? null;

  const save = async () => {
    if (!selectedUser || problem || saving) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      setHolders(await gatewaysAdminApi.setMemberKey(gatewayId, selectedUser.id, key));
      setKey('');
      setNotice(t('gateways.members.savedNotice', { defaultValue: '已给 {{name}} 填好 key。', name: selectedUser.username }));
      setUserId('');
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  const clear = async (holder: GatewayKeyHolder) => {
    if (confirmClear !== holder.userId) {
      setConfirmClear(holder.userId);
      return;
    }
    setClearing(holder.userId);
    setError(null);
    setNotice(null);
    try {
      setHolders(await gatewaysAdminApi.clearMemberKey(gatewayId, holder.userId));
      setConfirmClear(null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setClearing(null);
    }
  };

  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/30 p-3" data-member-keys={gatewayId}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <Users className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{t('gateways.members.title', { defaultValue: '成员 key · {{gateway}}', gateway: gatewayName })}</span>
          </p>
          <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
            {t('gateways.members.description', { defaultValue: '个人 key 只给本人的回合用,优先于网关的默认 key。可以替人填,本人也能在「模型网关」里自己填。' })}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('gateways.common.close', { defaultValue: '收起' })}
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {loadError && <p className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">{loadError}</p>}

      {holders === null && !loadError ? (
        <p className="text-xs text-muted-foreground">{t('gateways.common.loading', { defaultValue: '读取中…' })}</p>
      ) : holders && holders.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('gateways.members.empty', { defaultValue: '还没有人在这个网关上填个人 key。' })}</p>
      ) : holders ? (
        <ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-background">
          {holders.map((holder) => (
            <li key={holder.userId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs">
              <span className="min-w-0 break-all font-medium text-foreground">{holder.username}</span>
              <span className="font-mono text-muted-foreground">{maskKey(holder.keyLast4)}</span>
              <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">
                {holder.setBy
                  ? t('gateways.members.setByAt', { defaultValue: '{{by}} 设置于 {{when}}', by: holder.setBy, when: formatDbTime(holder.updatedAt) })
                  : formatDbTime(holder.updatedAt)}
              </span>
              <button
                type="button"
                onClick={() => void clear(holder)}
                onBlur={() => setConfirmClear((current) => (current === holder.userId ? null : current))}
                disabled={clearing !== null}
                className={`inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 transition-colors disabled:opacity-50 ${
                  confirmClear === holder.userId ? 'bg-destructive/10 text-destructive' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {confirmClear === holder.userId
                  ? t('gateways.common.confirmClear', { defaultValue: '确认清除' })
                  : t('gateways.common.clear', { defaultValue: '清除' })}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="space-y-2 border-t border-border pt-3">
        <p className="text-xs font-medium text-foreground">{t('gateways.members.addTitle', { defaultValue: '替成员填 / 换 key' })}</p>
        <div className="grid gap-2 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto]">
          <select
            value={userId}
            onChange={(event) => setUserId(event.target.value)}
            aria-label={t('gateways.members.user', { defaultValue: '成员' })}
            className="w-full min-w-0 rounded-md border border-input bg-transparent px-2 py-2 text-sm focus:border-primary focus:outline-none"
          >
            <option value="">{t('gateways.members.pickUser', { defaultValue: '选一个成员…' })}</option>
            {users.map((user) => (
              <option key={user.id} value={String(user.id)}>
                {holderIds.has(user.id)
                  ? t('gateways.members.userHasKey', { defaultValue: '{{name}}(已有 key,保存即替换)', name: user.username })
                  : user.username}
              </option>
            ))}
          </select>
          <SecretKeyInput
            value={key}
            onChange={setKey}
            ariaLabel={t('gateways.members.keyLabel', { defaultValue: '成员的 key' })}
            placeholder={t('gateways.common.keyPlaceholder', { defaultValue: '粘贴 key(只存服务端,保存后只显示末四位)' })}
            onEnter={() => void save()}
            disabled={saving}
          />
          <button
            type="button"
            onClick={() => void save()}
            disabled={!selectedUser || Boolean(problem) || saving}
            className="inline-flex items-center justify-center gap-1 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" />
            {saving ? t('gateways.common.saving', { defaultValue: '保存中…' }) : t('gateways.common.save', { defaultValue: '保存' })}
          </button>
        </div>
        {key.trim() && problem && (
          <p className="text-[11px] leading-4 text-amber-700 dark:text-amber-400">
            {t(formProblemKey(problem), { defaultValue: FORM_PROBLEM_FALLBACKS[problem], ...formProblemVars(problem) })}
          </p>
        )}
        {error && <p className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground" role="alert">{error}</p>}
        {notice && <p className="bg-primary/8 rounded-md border border-primary/30 px-3 py-2 text-xs text-card-foreground dark:text-primary">{notice}</p>}
      </div>
    </div>
  );
}
