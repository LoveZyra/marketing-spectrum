import { useState } from 'react';
import { KeyRound, LogOut, ShieldOff, UserRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../../../auth/context/AuthContext';
import { api, isValidRefreshedToken } from '../../../../utils/api';

/**
 * 我的账号:当前登录身份 + 退出登录/切换账号 + 退出所有设备。
 *
 * 「退出登录」和「切换账号」在机制上是同一件事 —— 清掉本地令牌后应用自动回到
 * 登录页,输入另一个账号即完成切换,所以做成一个按钮、两个说法都写上。
 * 「退出所有设备」走服务端 token_version 递增,吊销这个账号在**所有**浏览器/设备
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
    <div className="max-w-xl space-y-6">
      {/* 当前身份 */}
      <div className="flex items-center gap-3 rounded-lg border border-border p-4">
        <div className="bg-primary/8 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-primary">
          <UserRound className="h-5 w-5" />
        </div>
        <div className="min-w-0">
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
      </div>

      {/* 修改密码 */}
      <div className="overflow-hidden rounded-lg border border-border">
        <div className="flex items-center gap-2 border-b border-border bg-card px-4 py-2.5">
          <KeyRound className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-medium text-foreground">
            {t('account.password.title', '修改密码')}
          </h3>
        </div>
        <div className="p-4">
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t('account.password.help', '修改成功后,这个账号在其他设备上的登录会全部失效;当前设备保持登录。')}
          </p>
          <div className="mt-3 space-y-2">
            <input
              type="password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              placeholder={t('account.password.current', '当前密码')}
              autoComplete="current-password"
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm transition-colors focus:border-primary focus:outline-none"
            />
            <input
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              placeholder={t('account.password.new', '新密码(至少 6 位)')}
              autoComplete="new-password"
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm transition-colors focus:border-primary focus:outline-none"
            />
            <input
              type="password"
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
            type="button"
            onClick={() => void handleChangePassword()}
            disabled={passwordBusy || !currentPassword || !newPassword || !confirmPassword}
            className="mt-3 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {passwordBusy
              ? t('account.password.working', '修改中…')
              : t('account.password.submit', '修改密码')}
          </button>
        </div>
      </div>

      {/* 退出登录 / 切换账号 */}
      <div className="overflow-hidden rounded-lg border border-border">
        <div className="border-b border-border bg-card px-4 py-2.5">
          <h3 className="text-sm font-medium text-foreground">{t('account.logoutTitle')}</h3>
        </div>
        <div className="p-4">
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t('account.logoutHelp')}
          </p>
          <button
            type="button"
            onClick={handleLogout}
            className="mt-3 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <LogOut className="h-4 w-4" />
            {t('account.logoutButton')}
          </button>
        </div>
      </div>

      {/* 退出所有设备 */}
      <div className="overflow-hidden rounded-lg border border-border">
        <div className="border-b border-border bg-card px-4 py-2.5">
          <h3 className="text-sm font-medium text-foreground">{t('account.revokeAllTitle')}</h3>
        </div>
        <div className="p-4">
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t('account.revokeAllHelp')}
          </p>
          {/* 调色板里没有红:二次确认靠文案切换 + 主按钮态表达,不再用 destructive 底色 */}
          <button
            type="button"
            onClick={handleRevokeAll}
            disabled={revoking}
            className={`mt-3 inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium transition-colors disabled:opacity-60 ${
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
              className="ml-2 mt-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
            >
              {t('account.revokeAllCancel')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
