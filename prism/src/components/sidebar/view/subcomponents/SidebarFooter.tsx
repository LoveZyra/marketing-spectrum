import { Settings } from 'lucide-react';
import type { TFunction } from 'i18next';

type SidebarFooterProps = {
  onShowSettings: () => void;
  /** 待审批账号数;0 不显示。只有 root 会拿到非 0 值,见 usePendingApprovalCount。 */
  notificationCount?: number;
  t: TFunction;
};

/**
 * 红色计数:有多少个账号在等审批。
 *
 * 挂在设置入口上,因为审批队列就在设置 → 账号里。它反映的是真实待办,所以
 * **不会因为"看过了"而清零** —— 批完或拒完自然归零。非 root 恒为 0。
 */
function NotificationBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      className="ml-auto inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold leading-none text-white"
      aria-label={`${count} 个账号待审批`}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

/**
 * prism: trimmed footer — update banner, report-issue, community links and
 * brand line removed per branding cleanup. Only the restart hint (an
 * operational signal, not an update prompt) and Settings remain.
 */
export default function SidebarFooter({
  onShowSettings,
  notificationCount = 0,
  t,
}: SidebarFooterProps) {
  return (
    <div className="flex-shrink-0" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0)' }}>

      <div className="nav-divider" />

      {/* Desktop settings */}
      <div className="hidden px-2 py-1.5 md:block">
        <button
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
          onClick={onShowSettings}
        >
          <Settings className="h-3.5 w-3.5" />
          <span className="text-sm">{t('actions.settings')}</span>
          <NotificationBadge count={notificationCount} />
        </button>
      </div>

      {/* Mobile settings */}
      <div className="px-3 pb-3 pt-2 md:hidden">
        <button
          className="flex h-10 w-full items-center gap-3 rounded-xl bg-muted/40 px-3.5 transition-all hover:bg-muted/60 active:scale-[0.98]"
          onClick={onShowSettings}
        >
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-background/80">
            <Settings className="h-4 w-4 text-muted-foreground" />
          </div>
          <span className="text-sm font-normal text-foreground">{t('actions.settings')}</span>
          <NotificationBadge count={notificationCount} />
        </button>
      </div>
    </div>
  );
}
