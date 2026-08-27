import { MessageSquare, Terminal, Folder, NotebookPen, Clock, PanelLeftClose, PanelLeftOpen, Wrench, Settings } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import { Tooltip } from '../../shared/view/ui';
import { useUiPreferences } from '../../hooks/useUiPreferences';
import type { AppTab } from '../../types/app';
import PrismLogo from '../PrismLogo';
import { QUICK_SETTINGS_TOGGLE_EVENT } from '../quick-settings-panel/constants';

type RailTab = {
  id: AppTab;
  labelKey: string;
  icon: LucideIcon;
};

const RAIL_TABS: RailTab[] = [
  { id: 'chat', labelKey: 'tabs.chat', icon: MessageSquare },
  // 定时任务(cj 轮,用户指定:对话与终端之间,时钟图标)
  { id: 'tasks', labelKey: 'tabs.tasks', icon: Clock },
  { id: 'shell', labelKey: 'tabs.shell', icon: Terminal },
  { id: 'files', labelKey: 'tabs.files', icon: Folder },
  { id: 'notebook', labelKey: 'tabs.notebook', icon: NotebookPen },
];

type AppRailProps = {
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  onShowSettings: () => void;
  pendingApprovalCount?: number;
};

/** 轨上的按钮:38×38 / 6px 圆角 / 选中态沉降底 + 贴轨边 2px 绿竖条(设计稿 2a·2b)。 */
const RAIL_BUTTON_CLASS =
  'relative grid h-[38px] w-[38px] place-items-center rounded-md transition-colors active:translate-y-px';

/**
 * 桌面端最左侧的 56px 图标轨(设计稿 2a / 2b)。
 * 从上到下:Prism 标记 → 发丝线 → 四个标签 → 发丝线 → 侧栏开合 → 弹性占位 → 快捷设置 → 设置(挂待审批计数)。
 * 移动端不渲染 —— 小屏仍走 MainContentHeader 里的顶部标签栏。
 */
export default function AppRail({
  activeTab,
  setActiveTab,
  onShowSettings,
  pendingApprovalCount = 0,
}: AppRailProps) {
  const { t } = useTranslation(['common', 'sidebar', 'settings']);
  // 侧栏折叠后不再另起一条窄栏 —— 展开入口就挂在这条轨上
  const { preferences, setPreference } = useUiPreferences();

  const toggleQuickSettings = () => {
    // 快捷设置面板挂在聊天页里;不在聊天页时先切过去,下一帧再开面板。
    if (activeTab !== 'chat') {
      setActiveTab('chat');
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          window.dispatchEvent(new CustomEvent(QUICK_SETTINGS_TOGGLE_EVENT));
        });
      });
      return;
    }
    window.dispatchEvent(new CustomEvent(QUICK_SETTINGS_TOGGLE_EVENT));
  };

  return (
    <nav
      aria-label="棱镜"
      className="hidden h-full w-14 flex-shrink-0 flex-col items-center gap-1.5 border-r border-border bg-background py-3 md:flex"
    >
      {/* 轨宽 56px **含 1px 右边框**,内容区实为 55px —— 给满 56 会被挤成 55
          (亚像素缩放,水彩细节更糊),所以给 54,左右各留半像素。
          图本身自带约 2% 透明边、彩虹尾端渐隐,这个尺寸看着满而不顶边。
          再往下到 40px,水彩笔触会糊成一团色。 */}
      <PrismLogo size={54} tile={false} />

      <div className="my-2 h-px w-6 flex-shrink-0 bg-border" />

      {RAIL_TABS.map((tab) => {
        const isActive = tab.id === activeTab;
        const label = t(tab.labelKey);
        return (
          <Tooltip key={tab.id} content={label} position="right">
            <button
              type="button"
              onClick={() => setActiveTab(tab.id)}
              aria-label={label}
              aria-current={isActive ? 'page' : undefined}
              // 选中态不再挂左侧绿竖条:一格绿调底 + 深色下一圈外光就够了,
              // 竖条在近黑画布上会变成一根扎眼的荧光棒。
              className={`${RAIL_BUTTON_CLASS} ${
                isActive
                  ? 'prism-glow bg-muted text-primary'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              <tab.icon className="h-4 w-4" strokeWidth={2} />
            </button>
          </Tooltip>
        );
      })}

      <div className="my-2 h-px w-6 flex-shrink-0 bg-border" />

      {/* 侧栏开合:位置固定在这里(Notebook 与快捷设置之间),常驻不隐藏 ——
          按钮若"只在折叠时出现",它一出现整条轨的图标都会往下挪一格。 */}
      <Tooltip
        content={preferences.sidebarVisible ? t('sidebar:tooltips.hideSidebar') : t('sidebar:tooltips.showSidebar')}
        position="right"
      >
        <button
          type="button"
          onClick={() => setPreference('sidebarVisible', !preferences.sidebarVisible)}
          aria-label={preferences.sidebarVisible ? t('sidebar:tooltips.hideSidebar') : t('sidebar:tooltips.showSidebar')}
          aria-pressed={!preferences.sidebarVisible}
          className={`${RAIL_BUTTON_CLASS} text-muted-foreground hover:bg-card hover:text-foreground`}
        >
          {preferences.sidebarVisible
            ? <PanelLeftClose className="h-4 w-4" strokeWidth={2} />
            : <PanelLeftOpen className="h-4 w-4" strokeWidth={2} />}
        </button>
      </Tooltip>

      <div className="flex-1" aria-hidden />

      <Tooltip content={t('settings:quickSettings.title')} position="right">
        <button
          type="button"
          onClick={toggleQuickSettings}
          aria-label={t('settings:quickSettings.title')}
          className={`${RAIL_BUTTON_CLASS} text-muted-foreground hover:bg-card hover:text-foreground`}
        >
          <Wrench className="h-4 w-4" strokeWidth={2} />
        </button>
      </Tooltip>

      <Tooltip content={t('sidebar:actions.settings')} position="right">
        <button
          type="button"
          onClick={onShowSettings}
          aria-label={t('sidebar:actions.settings')}
          className={`${RAIL_BUTTON_CLASS} text-muted-foreground hover:bg-card hover:text-foreground`}
        >
          <Settings className="h-4 w-4" strokeWidth={2} />
          {pendingApprovalCount > 0 && (
            <span
              className="absolute right-1 top-1 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-primary px-0.5 font-mono text-[9px] font-semibold leading-none text-primary-foreground"
              aria-label={`${pendingApprovalCount} 个账号待审批`}
            >
              {pendingApprovalCount > 99 ? '99+' : pendingApprovalCount}
            </span>
          )}
        </button>
      </Tooltip>
    </nav>
  );
}
