
import { SETTINGS_MAIN_TABS, type SettingsMainTabMeta } from '../constants/constants';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../../auth/context/AuthContext';

import { cn } from '../../../lib/utils';
import { PillBar, Pill } from '../../../shared/view/ui';
import type { SettingsMainTab } from '../types/types';

type SettingsSidebarProps = {
  activeTab: SettingsMainTab;
  onChange: (tab: SettingsMainTab) => void;
};

// 图标类型跟着单一来源走。原来写死成 `typeof Bot`(lucide 的
// ForwardRefExoticComponent),比 constants.ts 里声明的 ComponentType 更窄,
// 派生时会对不上 —— 以清单那边为准。
type NavItem = SettingsMainTabMeta;

// 派生自 SETTINGS_MAIN_TABS —— 这份清单曾经是手写的第二份,结果只有它有 voice,
// 命令面板和深链校验那两份没有。加标签只改 constants.ts。
const NAV_ITEMS: NavItem[] = SETTINGS_MAIN_TABS;

export default function SettingsSidebar({ activeTab, onChange }: SettingsSidebarProps) {
  const { t } = useTranslation('settings');
  const isRoot = Boolean(useAuth().user?.isRoot);
  const navItems = NAV_ITEMS.filter((item) => !item.rootOnly || isRoot);

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden w-56 flex-shrink-0 border-r border-border bg-muted/30 md:flex md:flex-col">
        <nav className="flex flex-col gap-1 p-3">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;

            return (
              <button
                key={item.id}
                onClick={() => onChange(item.id)}
                className={cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-colors duration-150',
                  isActive
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground active:bg-accent/50',
                )}
              >
                <Icon className="h-4 w-4 flex-shrink-0" />
                {t(item.labelKey)}
              </button>
            );
          })}
        </nav>
      </aside>

      {/* Mobile horizontal nav — pill bar */}
      <div className="flex-shrink-0 border-b border-border px-3 py-2 md:hidden">
        <PillBar className="scrollbar-hide w-full overflow-x-auto">
          {navItems.map((item) => {
            const Icon = item.icon;

            return (
              <Pill
                key={item.id}
                isActive={activeTab === item.id}
                onClick={() => onChange(item.id)}
                className="flex-shrink-0"
              >
                <Icon className="h-3.5 w-3.5" />
                {t(item.labelKey)}
              </Pill>
            );
          })}
        </PillBar>
      </div>
    </>
  );
}
