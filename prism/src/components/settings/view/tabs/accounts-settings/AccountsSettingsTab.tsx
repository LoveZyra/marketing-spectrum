import { useTranslation } from 'react-i18next';
import { Check, Loader2, RefreshCw, X } from 'lucide-react';

import { useAccountApprovals, type AdminUser } from '../../../hooks/useAccountApprovals';

const STATUS_STYLES: Record<AdminUser['approval_status'], string> = {
  pending: 'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300',
  approved: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300',
  rejected: 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300',
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
  const { users, isLoading, error, busyUserId, refresh, decide } = useAccountApprovals(true);

  const pendingCount = users.filter((user) => user.approval_status === 'pending').length;

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
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-accent"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          {t('accounts.refresh', '刷新')}
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300">
          {error}
        </div>
      )}

      {pendingCount > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-200">
          {t('accounts.pendingCount', { count: pendingCount, defaultValue: `${pendingCount} 个账号待审批` })}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs text-muted-foreground">
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
              <tr key={user.id} className="border-t border-border">
                <td className="px-3 py-2 font-medium">{user.username}</td>
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
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    ) : (
                      <>
                        {user.approval_status !== 'approved' && (
                          <button
                            type="button"
                            onClick={() => void decide(user.id, 'approve')}
                            className="inline-flex items-center gap-1 rounded border border-emerald-300/60 px-2 py-1 text-xs text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-900/20"
                          >
                            <Check className="h-3 w-3" />
                            {t('accounts.actions.approve', '通过')}
                          </button>
                        )}
                        {user.approval_status !== 'rejected' && (
                          <button
                            type="button"
                            onClick={() => void decide(user.id, 'reject')}
                            className="inline-flex items-center gap-1 rounded border border-red-300/60 px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-900/20"
                          >
                            <X className="h-3 w-3" />
                            {t('accounts.actions.reject', '驳回')}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
