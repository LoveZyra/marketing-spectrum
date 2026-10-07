import { MessageSquare, Terminal, Folder, NotebookPen, Clock, Sparkles, PanelLeftClose, PanelLeftOpen, Wrench, Settings } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import { Tooltip } from '../../shared/view/ui';
import { useUiPreferences } from '../../hooks/useUiPreferences';
import { useSkillWhetEnabled } from '../skillwhet/hooks/useSkillWhetStatus';
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
  { id: 'tasks', labelKey: 'tabs.tasks', icon: Clock },
  // 服务端没挂载 /api/skillwhet 时不显示这一格(见下方 useSkillWhetEnabled 过滤)。
  { id: 'skillwhet', labelKey: 'tabs.skillwhet', icon: Sparkles },
  { id: 'shell', labelKey: 'tabs.shell', icon: Terminal },
  { id: 'files', labelKey: 'tabs.files', icon: Folder },
  { id: 'notebook', labelKey: 'tabs.notebook', icon: NotebookPen },
];

type AppRailProps = {
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  onShowSettings: () => void;
  pendingApprovalCount?: number;
  /**
   * 项目侧栏当前是否展开、如何开合,由 AppContent 决定(聊天页走持久化偏好,
   * 其他页走不落盘的本地状态)。不传时直接读写 sidebarVisible 偏好。
   */
  sidebarOpen?: boolean;
  onToggleSidebar?: () => void;
};

/** 轨上按钮的公共样式:38×38、6px 圆角(设计稿 2a·2b);选中态配色在各调用处。 */
const RAIL_BUTTON_CLASS =
  'relative grid h-[38px] w-[38px] place-items-center rounded-md transition-colors active:translate-y-px';

/**
 * 桌面端最左侧的 56px 图标轨(设计稿 2a / 2b)。
 * 从上到下:Prism 标记 → 发丝线 → 标签页 → 发丝线 → 侧栏开合 → 弹性占位 → 快捷设置 → 设置(挂待审批计数)。
 * 移动端不渲染,小屏走 MainContentHeader 里的顶部标签栏。
 *
 * 这条轨只放 Prism 自己的标签页;外部应用的入口在首页「工具」栏目(清单见 config/externalApps.ts)。
 */
export default function AppRail({
  activeTab,
  setActiveTab,
  onShowSettings,
  pendingApprovalCount = 0,
  sidebarOpen,
  onToggleSidebar,
}: AppRailProps) {
  const { t } = useTranslation(['common', 'sidebar', 'settings']);
  // 侧栏折叠后的展开入口就在这条轨上,不另起窄栏。
  const { preferences, setPreference } = useUiPreferences();
  const skillWhetEnabled = useSkillWhetEnabled();
  const railTabs = RAIL_TABS.filter((tab) => tab.id !== 'skillwhet' || skillWhetEnabled);

  const onSkillPage = activeTab === 'skillwhet';
  // Notebook 页不显示项目栏(见 AppContent),这颗按钮在那一页无物可开合:置灰并在提示里说明。
  const onNotebookPage = activeTab === 'notebook';
  const toggleOpen = onSkillPage ? preferences.skillNavVisible : (sidebarOpen ?? preferences.sidebarVisible);
  const toggleLabel = onNotebookPage
    ? t('sidebar:tooltips.noSidebarOnNotebook', { defaultValue: 'Notebook 页不显示项目栏' })
    : onSkillPage
      ? (toggleOpen ? t('sidebar:tooltips.hideSkillNav', { defaultValue: '收起技能导航' }) : t('sidebar:tooltips.showSkillNav', { defaultValue: '展开技能导航' }))
      : (toggleOpen ? t('sidebar:tooltips.hideSidebar') : t('sidebar:tooltips.showSidebar'));

  const toggleQuickSettings = () => {
    // 快捷设置面板挂在聊天页里;不在聊天页时先切过去,等两帧让面板挂载后再发开关事件。
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
      {/* 轨宽 56px 含 1px 右边框,内容区实为 55px;给 56 会被亚像素缩放挤成 55(水彩细节更糊),
          所以给 54,左右各留半像素。图自带约 2% 透明边、彩虹尾端渐隐,这个尺寸看着满而不顶边;
          小到 40px 时水彩笔触会糊成一团。 */}
      <PrismLogo size={54} tile={false} />

      <div className="my-2 h-px w-6 flex-shrink-0 bg-border" />

      {railTabs.map((tab) => {
        const isActive = tab.id === activeTab;
        const label = t(tab.labelKey);
        return (
          <Tooltip key={tab.id} content={label} position="right">
            <button
              type="button"
              onClick={() => setActiveTab(tab.id)}
              aria-label={label}
              aria-current={isActive ? 'page' : undefined}
              // 选中态只用绿调底 + 深色主题下的一圈外光,不加左侧竖条:竖条在近黑画布上像一根扎眼的荧光棒。
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

      {/* 侧栏开合按钮位置固定、常驻不隐藏:若只在折叠时出现,它一出现整条轨的图标都会下移一格。
          技能优化是全局页面,项目 / 会话侧栏在那一页不渲染(见 AppContent),
          同一颗按钮在那一页改管技能优化自己的「SKILL STUDIO」导航。 */}
      <Tooltip content={toggleLabel} position="right">
        <button
          type="button"
          onClick={() => (onSkillPage
            ? setPreference('skillNavVisible', !preferences.skillNavVisible)
            : onToggleSidebar
              ? onToggleSidebar()
              : setPreference('sidebarVisible', !preferences.sidebarVisible))}
          aria-label={toggleLabel}
          aria-pressed={onNotebookPage ? true : !toggleOpen}
          disabled={onNotebookPage}
          className={`${RAIL_BUTTON_CLASS} text-muted-foreground hover:bg-card hover:text-foreground disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent`}
        >
          {toggleOpen && !onNotebookPage
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
