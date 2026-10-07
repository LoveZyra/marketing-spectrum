import { useState } from 'react';
import { KeyRound, LogOut, ShieldOff, UserRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../../../auth/context/AuthContext';
import { api, isValidRefreshedToken } from '../../../../utils/api';

import AttachmentUsageCard from './AttachmentUsageCard';
import AuditLogList from './accounts-settings/AuditLogList';
import SkillSurveyToggleCard from './SkillSurveyToggleCard';

/**
 * 我的账号:当前登录身份 + 退出登录/切换账号 + 退出所有设备。
 *
 * 「退出登录」和「切换账号」在机制上是同一件事 —— 清掉本地令牌后应用自动回到
 * 登录页,输入另一个账号即完成切换,所以做成一个按钮、两个说法都写上。
 * 「退出所有设备」走服务端 token_version 递增,吊销这个账号在所有浏览器/设备
 * 上已签发的旧令牌(令牌泄露后的恢复手段),需二次确认。
 */
export default function AccountSettingsTab() {
  const { t } = useTranslation('settings');
  const { user, logout } = useAuth();
  const [revoking, setRevoking] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  // 修改密码表单。成功后服务端已吊销其他设备令牌,并给本会话回发新令牌 ——
  // 落回 localStorage,当前设备无感继续。
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordDone, setPasswordDone] = useState(false);

  const handleChangePassword = async () => {
    if (passwordBusy || !currentPassword || !newPassword || !confirmPassword) return;
    setPasswordError(null);
    setPasswordDone(false);
    if (newPassword.length < 6) {
      setPasswordError(t('account.password.tooShort', '新密码至少 6 位'));
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError(t('account.password.mismatch', '两次输入的新密码不一致'));
      return;
    }
    setPasswordBusy(true);
    try {
      const response = await api.auth.changePassword(currentPassword, newPassword);
      const payload = (await response.json()) as { token?: string; error?: string };
      if (!response.ok) {
        throw new Error(payload.error || t('account.password.failed', '修改失败'));
      }
      if (isValidRefreshedToken(payload.token)) {
        localStorage.setItem('auth-token', payload.token);
      }
      setPasswordDone(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (caught) {
      setPasswordError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPasswordBusy(false);
    }
  };

  const handleLogout = () => {
    logout();
  };

  const handleRevokeAll = async () => {
    if (!confirmRevoke) {
      setConfirmRevoke(true);
      return;
    }

    setRevoking(true);
    try {
      // 先趁令牌还有效吊销全部旧令牌,再清本地会话回登录页。
      await api.auth.logout({ all: true });
    } catch {
      // 端点失败也继续本地登出 —— 用户的意图是"离开",不该被网络问题卡住。
    } finally {
      setRevoking(false);
      logout();
    }
  };

  return (
    /* 与其余页签一致:不在页面这一层设宽度上限,由弹窗自己的宽度决定。 */
    <div className="space-y-6">
      {/*
        当前身份 + 两个退出入口:退出都是「对当前账号做的事」,和身份行放在一起才好找,
        也不会把「附件空间」「修改密码」这些要读的内容顶下去。各自的标题与说明放在按钮的 `title` 里。
        窄屏时按钮组整体换到下一行(`flex-wrap` + `basis-full sm:basis-auto`)。
      */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-4">
        <div className="bg-primary/8 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-primary">
          <UserRound className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">
            {user?.username ?? '—'}
            {user?.isRoot && (
              <span className="ml-2 rounded-sm border border-border px-1.5 py-px font-mono text-[10px] font-medium leading-[14px] text-muted-foreground">
                root
              </span>
            )}
          </p>
          <p className="text-xs text-muted-foreground">{t('account.signedInAs')}</p>
        </div>

        <div className="flex basis-full flex-wrap items-center justify-end gap-2 sm:basis-auto">
          <button
            type="button"
            onClick={handleLogout}
            title={`${t('account.logoutTitle')} — ${t('account.logoutHelp')}`}
            aria-label={t('account.logoutButton')}
            className="inline-flex flex-none items-center gap-2 whitespace-nowrap rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <LogOut className="h-4 w-4" />
            {t('account.logoutButton')}
          </button>

          {/* 调色板里没有红:二次确认靠文案切换 + 主按钮态表达,不用 destructive 底色 */}
          <button
            type="button"
            onClick={handleRevokeAll}
            disabled={revoking}
            title={`${t('account.revokeAllTitle')} — ${t('account.revokeAllHelp')}`}
            aria-label={t('account.revokeAllButton')}
            className={`inline-flex flex-none items-center gap-2 whitespace-nowrap rounded-md border px-4 py-2 text-sm font-medium transition-colors disabled:opacity-60 ${
              confirmRevoke
                ? 'border-primary bg-primary text-primary-foreground hover:bg-primary/90'
                : 'border-border text-body hover:bg-card hover:text-foreground'
            }`}
          >
            <ShieldOff className="h-4 w-4" />
            {revoking
              ? t('account.revokeAllWorking')
              : confirmRevoke
                ? t('account.revokeAllConfirm')
                : t('account.revokeAllButton')}
          </button>

          {confirmRevoke && !revoking && (
            <button
              type="button"
              onClick={() => setConfirmRevoke(false)}
              className="flex-none whitespace-nowrap rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
            >
              {t('account.revokeAllCancel')}
            </button>
          )}
        </div>
      </div>

      <AttachmentUsageCard />

      {/* 技能效果询问开关;技能优化没挂载时整卡不显示 */}
      <SkillSurveyToggleCard />

      {/* 修改密码 */}
      <div className="overflow-hidden rounded-lg border border-border">
        <div className="flex items-center gap-2 border-b border-border bg-card px-4 py-2.5">
          <KeyRound className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-medium text-foreground">
            {t('account.password.title', '修改密码')}
          </h3>
        </div>
        {/*
          这三个密码框必须放在自己的 <form> 里,并带一个用户名字段。页面一出现 current-password,
          Chrome 密码管理器就会填入保存的密码并找一个「用户名框」填登录名;密码框不在 form 里时
          它把整页当一张表单,取密码框之前最近的文本框 —— 正是侧栏的项目搜索框,项目列表随之被过滤空。
          包进 form 后 Chrome 只在 form 内找;隐藏的只读用户名字段(值为当前账号,Chromium 认
          display:none 的 autocomplete=username)给了它正确的落点,保存 / 更新的凭据也对。
        */}
        <form
          className="p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void handleChangePassword();
          }}
        >
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t('account.password.help', '修改成功后,这个账号在其他设备上的登录会全部失效;当前设备保持登录。')}
          </p>
          <div className="mt-3 space-y-2">
            <input
              type="text"
              name="username"
              autoComplete="username"
              value={user?.username ?? ''}
              readOnly
              className="hidden"
            />
            <input
              type="password"
              name="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              placeholder={t('account.password.current', '当前密码')}
              autoComplete="current-password"
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm transition-colors focus:border-primary focus:outline-none"
            />
            <input
              type="password"
              name="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              placeholder={t('account.password.new', '新密码(至少 6 位)')}
              autoComplete="new-password"
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm transition-colors focus:border-primary focus:outline-none"
            />
            <input
              type="password"
              name="confirm-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              placeholder={t('account.password.confirm', '再输一遍新密码')}
              autoComplete="new-password"
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm transition-colors focus:border-primary focus:outline-none"
            />
          </div>
          {passwordError && (
            <p className="mt-2 text-xs text-muted-foreground">{passwordError}</p>
          )}
          {passwordDone && (
            <p className="mt-2 text-xs text-card-foreground dark:text-primary">
              {t('account.password.done', '密码已修改,其他设备已全部退出。')}
            </p>
          )}
          <button
            type="submit"
            disabled={passwordBusy || !currentPassword || !newPassword || !confirmPassword}
            className="mt-3 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {passwordBusy
              ? t('account.password.working', '修改中…')
              : t('account.password.submit', '修改密码')}
          </button>
        </form>
      </div>

      {/*
        与我有关的操作记录:普通用户也要能看到别人对自己做过的操作(例如自己负责的项目里的会话被删)。
        范围由服务端裁剪:非 root 只看到我做的 + 对我做的(对我做的那些行抹掉了 ip)。
      */}
      <div className="rounded-lg border border-border bg-card p-4">
        <p className="mb-3 text-xs text-muted-foreground">
          {t('audit.mineHint', '包括你自己的登录、删除等操作,以及别人对你负责的项目里的会话做的删除 / 归档 / 恢复。')}
        </p>
        <AuditLogList title={t('audit.mineTitle', '与我有关的操作记录')} />
      </div>
    </div>
  );
}
