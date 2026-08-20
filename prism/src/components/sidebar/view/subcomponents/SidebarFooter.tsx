import { Settings } from 'lucide-react';
import type { TFunction } from 'i18next';

type SidebarFooterProps = {
  onShowSettings: () => void;
  /** 待审批账号数;0 不显示。只有 root 会拿到非 0 值,见 usePendingApprovalCount。 */
  notificationCount?: number;
  t: TFunction;
};

/**
 * 待审批计数:有多少个账号在等审批。绿色计数(设计语言无红色告警,
 * 红只留给不可逆的销毁确认)。
 *
 * 挂在设置入口上,因为审批队列就在设置 → 账号里。它反映的是真实待办,所以
 * **不会因为"看过了"而清零** —— 批完或拒完自然归零。非 root 恒为 0。
 */
function NotificationBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      className="ml-auto inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 font-mono text-[10px] font-semibold leading-none text-primary-foreground"
      aria-label={`${count} 个账号待审批`}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

/**
 * prism: trimmed footer — 桌面端的设置入口已搬到左侧图标轨(AppRail),
 * 这里只保留移动端抽屉里的设置行。
 */
export default function SidebarFooter({
  onShowSettings,
  notificationCount = 0,
  t,
}: SidebarFooterProps) {
  return (
    <div className="flex-shrink-0 md:hidden" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0)' }}>

      <div className="h-px bg-border" />

      {/* Mobile settings */}
      <div className="px-3 pb-3 pt-2">
        <button
          // 44px:移动端点击目标下限
          className="flex h-11 w-full items-center gap-3 rounded-md border border-border bg-card px-3.5 transition-colors hover:border-border-strong active:translate-y-px"
          onClick={onShowSettings}
        >
          <div className="grid h-7 w-7 place-items-center rounded-sm bg-background">
            <Settings className="h-4 w-4 text-muted-foreground" strokeWidth={2} />
          </div>
          <span className="text-sm font-normal text-foreground">{t('actions.settings')}</span>
          <NotificationBadge count={notificationCount} />
        </button>
      </div>
    </div>
  );
}
