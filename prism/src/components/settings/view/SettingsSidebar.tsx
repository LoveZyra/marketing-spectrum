
import { useTranslation } from 'react-i18next';

import { SETTINGS_MAIN_TABS, type SettingsMainTabMeta } from '../constants/constants';
import { useAuth } from '../../auth/context/AuthContext';
import { cn } from '../../../lib/utils';
import { PillBar, Pill } from '../../../shared/view/ui';
import type { SettingsMainTab } from '../types/types';

type SettingsSidebarProps = {
  activeTab: SettingsMainTab;
  onChange: (tab: SettingsMainTab) => void;
};

type NavItem = SettingsMainTabMeta;

// 导航项(连同类型)派生自 SETTINGS_MAIN_TABS,加标签只改 constants.ts。
const NAV_ITEMS: NavItem[] = SETTINGS_MAIN_TABS;

export default function SettingsSidebar({ activeTab, onChange }: SettingsSidebarProps) {
  const { t } = useTranslation('settings');
  const isRoot = Boolean(useAuth().user?.isRoot);
  const navItems = NAV_ITEMS.filter((item) => !item.rootOnly || isRoot);

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden w-56 flex-shrink-0 border-r border-border md:flex md:flex-col">
        <nav className="flex flex-col gap-1 p-3">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;

            return (
              <button
                key={item.id}
                onClick={() => onChange(item.id)}
                className={cn(
                  'relative flex items-center gap-3 rounded-md px-2.5 py-2 text-left text-sm font-medium transition-colors',
                  isActive
                    ? 'prism-panel bg-card text-foreground dark:bg-muted'
                    : 'text-body hover:bg-muted hover:text-foreground',
                )}
              >
                <Icon className={cn('h-4 w-4 flex-shrink-0', isActive && 'text-primary')} />
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
