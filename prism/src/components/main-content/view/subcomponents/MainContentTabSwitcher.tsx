import { MessageSquare, Terminal, Folder, NotebookPen, Clock, Sparkles, type LucideIcon } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import { Tooltip, PillBar, Pill } from '../../../../shared/view/ui';
import type { AppTab } from '../../../../types/app';
import { useSkillWhetEnabled } from '../../../skillwhet/hooks/useSkillWhetStatus';

type MainContentTabSwitcherProps = {
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
};

type BuiltInTab = {
  kind: 'builtin';
  id: AppTab;
  labelKey: string;
  icon: LucideIcon;
};

type TabDefinition = BuiltInTab;

const BASE_TABS: BuiltInTab[] = [
  { kind: 'builtin', id: 'chat',  labelKey: 'tabs.chat',  icon: MessageSquare },
  { kind: 'builtin', id: 'tasks', labelKey: 'tabs.tasks', icon: Clock },
  { kind: 'builtin', id: 'skillwhet', labelKey: 'tabs.skillwhet', icon: Sparkles },
  { kind: 'builtin', id: 'shell', labelKey: 'tabs.shell', icon: Terminal },
  { kind: 'builtin', id: 'files', labelKey: 'tabs.files', icon: Folder },
  { kind: 'builtin', id: 'notebook', labelKey: 'tabs.notebook', icon: NotebookPen },
];



export default function MainContentTabSwitcher({
  activeTab,
  setActiveTab,
}: MainContentTabSwitcherProps) {
  const { t } = useTranslation();
  const skillWhetEnabled = useSkillWhetEnabled();

  const builtInTabs: BuiltInTab[] = BASE_TABS.filter((tab) => tab.id !== 'skillwhet' || skillWhetEnabled);

  const tabs: TabDefinition[] = builtInTabs;

  return (
    <PillBar>
      {tabs.map((tab) => {
        const isActive = tab.id === activeTab;
        const displayLabel = t(tab.labelKey);

        return (
          <Tooltip key={tab.id} content={displayLabel} position="bottom">
            <Pill
              isActive={isActive}
              onClick={() => setActiveTab(tab.id)}
              className="px-3 py-2.5"
              // lg 以下文字隐藏、按钮只剩图标,显式给 aria-label,读屏器才念得出是哪个页签。
              ariaLabel={displayLabel}
            >
              <tab.icon className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
              <span className="hidden lg:inline">{displayLabel}</span>
            </Pill>
          </Tooltip>
        );
      })}
    </PillBar>
  );
}
