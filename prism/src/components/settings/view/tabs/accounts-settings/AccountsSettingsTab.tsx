import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Ban, Check, KeyRound, RefreshCw, Undo2, X } from 'lucide-react';

import { useAuth } from '../../../../auth/context/AuthContext';
import { useAccountApprovals, type AdminUser } from '../../../hooks/useAccountApprovals';
import { middleTruncate } from '../../../../../utils/middleTruncate';

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

      {/*
        这里原来是 `overflow-hidden` —— 窗口一窄,「操作」那一列被**直接切掉**,
        而且没有任何办法滚过去看(2026-09-15 用户实测截图)。旁边的审计表一直是
        `overflow-x-auto`,这张漏了。放不下时给一条横向滚动,东西至少够得着;
        下面几列的响应式收起负责让"放不下"尽量别发生。
      */}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-card text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">{t('accounts.columns.username', '用户名')}</th>
              <th className="px-3 py-2 text-left font-medium">{t('accounts.columns.status', '状态')}</th>
              <th className="px-3 py-2 text-left font-medium">{t('accounts.columns.registered', '注册时间')}</th>
              {/* 审批人:这张表里最不要紧的一列,窄屏让位给「操作」 */}
              <th className="hidden px-3 py-2 text-left font-medium lg:table-cell">{t('accounts.columns.reviewer', '审批人')}</th>
              {/* 其余四列都是 text-left,这一列原来是 text-right —— 表头对不齐,统一成左对齐 */}
              <th className="px-3 py-2 text-left font-medium">{t('accounts.columns.actions', '操作')}</th>
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
                  <td className="max-w-48 px-3 py-2 font-medium">
                    {/*
                      用户名可能很长。尾部省略会把 `zhangsan-2024` 和 `zhangsan-2025`
                      截成同一个名字,所以用中间省略;全名放 title,悬停还能看到。
                    */}
                    <span className="whitespace-nowrap" title={user.username}>
                      {middleTruncate(user.username, 18)}
                    </span>
                    {!user.is_active && (
                      <span className="ml-2 rounded-sm border border-border px-1.5 py-px text-[10px] leading-[14px] text-muted-foreground">
                        {t('accounts.disabled', '已停用')}
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    {/*
                      `-ml-1.5` 抵掉徽标自己的 `px-1.5`:不抵的话这一列的文字比表头「状态」
                      右移 6px(2026-09-15 实测 375.8 → 381.8),一眼就看得出没对齐,
                      而左右两列(用户名、注册时间)都是严丝合缝的。
                    */}
                    <span className={`-ml-1.5 whitespace-nowrap rounded px-1.5 py-0.5 text-xs ${STATUS_STYLES[user.approval_status]}`}>
                      {t(`accounts.status.${user.approval_status}`, user.approval_status)}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs tabular-nums text-muted-foreground">{formatDate(user.created_at)}</td>
                  <td className="hidden max-w-40 px-3 py-2 text-xs text-muted-foreground lg:table-cell">
                    <span className="block truncate" title={user.reviewed_by_username ?? ''}>
                      {user.reviewed_by_username ? middleTruncate(user.reviewed_by_username, 16) : '—'}
                    </span>
                  </td>
                  {/* 操作列按内容定宽(w-px + nowrap),按钮文字不再被折成两行 */}
                  <td className="w-px whitespace-nowrap px-3 py-2">
                    <div className="flex items-center justify-start gap-1.5">
                      {busyUserId === user.id ? (
                        <span className="h-4 w-4 flex-none rounded-full border-[1.5px] border-primary" aria-hidden />
                      ) : (
                        <>
                          {user.approval_status !== 'approved' && (
                            <button
                              type="button"
                              onClick={() => void decide(user.id, 'approve')}
                              title={t('accounts.actions.approve', '通过')}
                              aria-label={t('accounts.actions.approve', '通过')}
                              className="hover:bg-primary/8 inline-flex flex-none items-center gap-1 whitespace-nowrap rounded border border-primary/30 px-2 py-1 text-xs text-card-foreground transition-colors dark:text-primary"
                            >
                              <Check className="h-3 w-3" />
                              <span className="hidden xl:inline">{t('accounts.actions.approve', '通过')}</span>
                            </button>
                          )}
                          {user.approval_status !== 'rejected' && (
                            <button
                              type="button"
                              onClick={() => void decide(user.id, 'reject')}
                              title={t('accounts.actions.reject', '驳回')}
                              aria-label={t('accounts.actions.reject', '驳回')}
                              className="inline-flex flex-none items-center gap-1 whitespace-nowrap rounded border border-border px-2 py-1 text-xs text-body transition-colors hover:bg-card hover:text-foreground"
                            >
                              <X className="h-3 w-3" />
                              <span className="hidden xl:inline">{t('accounts.actions.reject', '驳回')}</span>
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
                            aria-label={t('accounts.actions.resetPassword', '重置密码')}
                            className="inline-flex flex-none items-center gap-1 whitespace-nowrap rounded border border-border px-2 py-1 text-xs text-body transition-colors hover:bg-card hover:text-foreground"
                          >
                            <KeyRound className="h-3 w-3" />
                            <span className="hidden xl:inline">{t('accounts.actions.resetPassword', '重置密码')}</span>
                          </button>
                          {user.is_active ? (
                            user.id !== Number(currentUser?.id) && (
                              <button
                                type="button"
                                onClick={() => void setActive(user.id, false)}
                                title={t('accounts.actions.deactivate', '停用')}
                                aria-label={t('accounts.actions.deactivate', '停用')}
                                className="inline-flex flex-none items-center gap-1 whitespace-nowrap rounded border border-border px-2 py-1 text-xs text-body transition-colors hover:bg-card hover:text-foreground"
                              >
                                <Ban className="h-3 w-3" />
                                <span className="hidden xl:inline">{t('accounts.actions.deactivate', '停用')}</span>
                              </button>
                            )
                          ) : (
                            <button
                              type="button"
                              onClick={() => void setActive(user.id, true)}
                              title={t('accounts.actions.activate', '启用')}
                              aria-label={t('accounts.actions.activate', '启用')}
                              className="hover:bg-primary/8 inline-flex flex-none items-center gap-1 whitespace-nowrap rounded border border-primary/30 px-2 py-1 text-xs text-card-foreground transition-colors dark:text-primary"
                            >
                              <Undo2 className="h-3 w-3" />
                              <span className="hidden xl:inline">{t('accounts.actions.activate', '启用')}</span>
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
                      {/* ec:与 AccountSettingsTab 同一个坑 —— 裸露的密码框会让浏览器密码管理器
                          去页面上找"用户名框"填,落到侧栏搜索框上。包进 form,带上被重置账号的
                          隐藏用户名,标 new-password:既不串位,保存提示也会指向正确的账号。 */}
                      <form
                        className="flex flex-wrap items-center justify-start gap-2"
                        onSubmit={(event) => {
                          event.preventDefault();
                          if (resetValue.length >= 6 && busyUserId !== user.id) void submitReset(user);
                        }}
                      >
                        <span className="text-xs text-muted-foreground">
                          {t('accounts.resetFor', { name: user.username, defaultValue: `为 ${user.username} 设置新密码(其所有设备将被踢出):` })}
                        </span>
                        <input
                          type="text"
                          name="username"
                          autoComplete="username"
                          value={user.username}
                          readOnly
                          className="hidden"
                        />
                        <input
                          type="password"
                          name="new-password"
                          autoComplete="new-password"
                          value={resetValue}
                          onChange={(event) => setResetValue(event.target.value)}
                          placeholder={t('accounts.resetPlaceholder', '新密码(至少 6 位)')}
                          autoFocus
                          className="w-52 rounded-md border border-input bg-transparent px-2 py-1 text-xs transition-colors focus:border-primary focus:outline-none"
                          onKeyDown={(event) => {
                            if (event.key === 'Escape') setResetTargetId(null);
                          }}
                        />
                        <button
                          type="submit"
                          disabled={resetValue.length < 6 || busyUserId === user.id}
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
                      </form>
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
