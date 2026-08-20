import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Ban, Check, KeyRound, RefreshCw, Undo2, X } from 'lucide-react';

import { useAuth } from '../../../../auth/context/AuthContext';
import { useAccountApprovals, type AdminUser } from '../../../hooks/useAccountApprovals';

import AuditLogList from './AuditLogList';

const STATUS_STYLES: Record<AdminUser['approval_status'], string> = {
  pending: 'bg-muted text-body',
  approved: 'bg-primary/8 text-card-foreground dark:text-primary',
  rejected: 'border border-border text-muted-foreground',
};

const formatDate = (value: string | null): string => {
  if (!value) return '—';
  const parsed = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
};

/**
 * Account approval queue. Rendered only for root — see Settings.tsx.
 *
 * Deliberately plain: the whole job is "who is waiting, and let me say yes or
 * no". Pending accounts sort first (server-side), so the thing that needs
 * action is always at the top without the reviewer scanning for it.
 */
export default function AccountsSettingsTab() {
  const { t } = useTranslation('settings');
  const { user: currentUser } = useAuth();
  const { users, isLoading, error, busyUserId, refresh, decide, resetPassword, setActive } =
    useAccountApprovals(true);

  const pendingCount = users.filter((user) => user.approval_status === 'pending').length;

  // 重置密码的内联小表单:点了哪一行,就在那一行下方展开输入框。
  const [resetTargetId, setResetTargetId] = useState<number | null>(null);
  const [resetValue, setResetValue] = useState('');
  const [resetDoneFor, setResetDoneFor] = useState<string | null>(null);

  const submitReset = async (target: AdminUser) => {
    const ok = await resetPassword(target.id, resetValue);
    if (ok) {
      setResetDoneFor(target.username);
      setResetTargetId(null);
      setResetValue('');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold">{t('accounts.title', '账号审批')}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {t(
              'accounts.description',
              '新注册的账号需要审批后才能登录。root 账号由服务端 PRISM_ROOT_USERS 指定。',
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-body transition-colors hover:border-border-strong hover:bg-card hover:text-foreground"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'text-primary' : ''}`} />
          {t('accounts.refresh', '刷新')}
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
          {error}
        </div>
      )}

      {resetDoneFor && (
        <div className="bg-primary/8 rounded-md border border-primary/30 px-3 py-2 text-xs text-card-foreground dark:text-primary">
          {t('accounts.resetDone', { name: resetDoneFor, defaultValue: `已重置 ${resetDoneFor} 的密码,其所有设备已退出登录。` })}
        </div>
      )}

      {pendingCount > 0 && (
        <div className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
          {t('accounts.pendingCount', { count: pendingCount, defaultValue: `${pendingCount} 个账号待审批` })}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-card text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">{t('accounts.columns.username', '用户名')}</th>
              <th className="px-3 py-2 text-left font-medium">{t('accounts.columns.status', '状态')}</th>
              <th className="px-3 py-2 text-left font-medium">{t('accounts.columns.registered', '注册时间')}</th>
              <th className="px-3 py-2 text-left font-medium">{t('accounts.columns.reviewer', '审批人')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('accounts.columns.actions', '操作')}</th>
            </tr>
          </thead>
          <tbody>
            {users.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-sm text-muted-foreground">
                  {isLoading ? t('accounts.loading', '加载中…') : t('accounts.empty', '暂无账号')}
                </td>
              </tr>
            )}

            {users.map((user) => (
              <Fragment key={user.id}>
                <tr className={`border-t border-border ${user.is_active ? '' : 'opacity-60'}`}>
                  <td className="px-3 py-2 font-medium">
                    {user.username}
                    {!user.is_active && (
                      <span className="ml-2 rounded-sm border border-border px-1.5 py-px text-[10px] leading-[14px] text-muted-foreground">
                        {t('accounts.disabled', '已停用')}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`rounded px-1.5 py-0.5 text-xs ${STATUS_STYLES[user.approval_status]}`}>
                      {t(`accounts.status.${user.approval_status}`, user.approval_status)}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{formatDate(user.created_at)}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {user.reviewed_by_username ?? '—'}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-1.5">
                      {busyUserId === user.id ? (
                        <span className="h-4 w-4 flex-none rounded-full border-[1.5px] border-primary" aria-hidden />
                      ) : (
                        <>
                          {user.approval_status !== 'approved' && (
                            <button
                              type="button"
                              onClick={() => void decide(user.id, 'approve')}
                              className="hover:bg-primary/8 inline-flex items-center gap-1 rounded border border-primary/30 px-2 py-1 text-xs text-card-foreground transition-colors dark:text-primary"
                            >
                              <Check className="h-3 w-3" />
                              {t('accounts.actions.approve', '通过')}
                            </button>
                          )}
                          {user.approval_status !== 'rejected' && (
                            <button
                              type="button"
                              onClick={() => void decide(user.id, 'reject')}
                              className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-body transition-colors hover:bg-card hover:text-foreground"
                            >
                              <X className="h-3 w-3" />
                              {t('accounts.actions.reject', '驳回')}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              setResetDoneFor(null);
                              setResetValue('');
                              setResetTargetId(resetTargetId === user.id ? null : user.id);
                            }}
                            title={t('accounts.actions.resetPassword', '重置密码')}
                            className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-body transition-colors hover:bg-card hover:text-foreground"
                          >
                            <KeyRound className="h-3 w-3" />
                            {t('accounts.actions.resetPassword', '重置密码')}
                          </button>
                          {user.is_active ? (
                            user.id !== Number(currentUser?.id) && (
                              <button
                                type="button"
                                onClick={() => void setActive(user.id, false)}
                                title={t('accounts.actions.deactivate', '停用')}
                                className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-body transition-colors hover:bg-card hover:text-foreground"
                              >
                                <Ban className="h-3 w-3" />
                                {t('accounts.actions.deactivate', '停用')}
                              </button>
                            )
                          ) : (
                            <button
                              type="button"
                              onClick={() => void setActive(user.id, true)}
                              title={t('accounts.actions.activate', '启用')}
                              className="hover:bg-primary/8 inline-flex items-center gap-1 rounded border border-primary/30 px-2 py-1 text-xs text-card-foreground transition-colors dark:text-primary"
                            >
                              <Undo2 className="h-3 w-3" />
                              {t('accounts.actions.activate', '启用')}
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </td>
                </tr>
                {resetTargetId === user.id && (
                  <tr className="border-t border-border bg-muted">
                    <td colSpan={5} className="px-3 py-2">
                      <div className="flex items-center justify-end gap-2">
                        <span className="text-xs text-muted-foreground">
                          {t('accounts.resetFor', { name: user.username, defaultValue: `为 ${user.username} 设置新密码(其所有设备将被踢出):` })}
                        </span>
                        <input
                          type="password"
                          value={resetValue}
                          onChange={(event) => setResetValue(event.target.value)}
                          placeholder={t('accounts.resetPlaceholder', '新密码(至少 6 位)')}
                          autoFocus
                          className="w-52 rounded-md border border-input bg-transparent px-2 py-1 text-xs transition-colors focus:border-primary focus:outline-none"
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' && resetValue.length >= 6) void submitReset(user);
                            if (event.key === 'Escape') setResetTargetId(null);
                          }}
                        />
                        <button
                          type="button"
                          disabled={resetValue.length < 6 || busyUserId === user.id}
                          onClick={() => void submitReset(user)}
                          className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                        >
                          {t('accounts.resetConfirm', '确认重置')}
                        </button>
                        <button
                          type="button"
                          onClick={() => setResetTargetId(null)}
                          className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
                        >
                          {t('accounts.resetCancel', '取消')}
                        </button>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <div className="border-t border-border pt-4">
        <AuditLogList />
      </div>

      <p className="text-xs text-muted-foreground">
        {t(
          'accounts.notIsolationNotice',
          '说明:账号区分只用于界面隔离(各人只看到自己的项目和公共项目),不是越权防护 —— 知道项目 id 的人仍然可以直接调用接口。',
        )}
      </p>
    </div>
  );
}
