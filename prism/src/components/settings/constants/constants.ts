import type { ComponentType } from 'react';
import { Activity, Bell, Bot, Info, KeyRound, Palette, Shuffle, UserRound, Users } from 'lucide-react';

import type {
  CodeEditorSettingsState,
  SettingsMainTab,
} from '../types/types';

export type SettingsMainTabMeta = {
  id: SettingsMainTab;
  label: string;
  keywords: string;
  icon: ComponentType<{ className?: string }>;
  /**
   * Hidden from non-root accounts. The server 403s these routes regardless —
   * this only keeps a tab that can do nothing out of everyone else's settings.
   */
  /** i18n key under the `settings` namespace — 侧栏用它,命令面板回落到 label。 */
  labelKey: string;
  rootOnly?: boolean;
};

/**
 * 设置页所有主标签的**唯一**清单。顺序即侧栏顺序。
 *
 * 之前这份清单在三个地方各写了一遍(这里、`SettingsSidebar` 的 NAV_ITEMS、
 * `useSettingsController` 的 KNOWN_MAIN_TABS),然后就漂了:只有侧栏那份有
 * `voice`,于是命令面板搜不到语音设置,`?tab=voice` 深链也会静默回落到 agents。
 * 现在另外两处都从这里派生,加一个标签只需要在这里加一行。
 */
export const SETTINGS_MAIN_TABS: SettingsMainTabMeta[] = [
  { id: 'agents', label: 'Agents', labelKey: 'mainTabs.agents', keywords: 'agents subagents claude code', icon: Bot },
  { id: 'appearance', label: 'Appearance', labelKey: 'mainTabs.appearance', keywords: 'appearance theme dark light language', icon: Palette },
  { id: 'api', label: 'API Tokens', labelKey: 'mainTabs.apiTokens', keywords: 'api tokens auth keys', icon: KeyRound },
  { id: 'accounts', label: 'Accounts', labelKey: 'mainTabs.accounts', keywords: 'accounts users approval root admin', icon: Users, rootOnly: true },
  { id: 'notifications', label: 'Notifications', labelKey: 'mainTabs.notifications', keywords: 'notifications alerts push', icon: Bell },
  { id: 'account', label: 'My Account', labelKey: 'mainTabs.account', keywords: 'account logout switch user sign out password 退出 登出 切换账号 修改密码', icon: UserRound },
  { id: 'models', label: 'Model Mapping', labelKey: 'mainTabs.models', keywords: 'model mapping alias sonnet opus haiku fable settings.json 模型 映射 别名', icon: Shuffle, rootOnly: true },
  { id: 'server', label: 'Server Status', labelKey: 'mainTabs.server', keywords: 'server status cpu memory disk jupyter gateway 服务器 状态 网关', icon: Activity, rootOnly: true },
  { id: 'about', label: 'About', labelKey: 'mainTabs.about', keywords: 'about version info', icon: Info },
];

/** 所有合法的主标签 id。深链与持久化的标签值据此校验。 */
export const SETTINGS_MAIN_TAB_IDS = SETTINGS_MAIN_TABS.map((tab) => tab.id);

// `AGENT_PROVIDERS` and `AGENT_CATEGORIES` used to live here and were imported
// by nobody — the agents tab built both lists itself, which is why nothing
// noticed that `AGENT_CATEGORIES` was missing `skills`. Along with them went
// `DEFAULT_CURSOR_PERMISSIONS`, `DEFAULT_PROJECT_SORT_ORDER` and
// `DEFAULT_SAVE_STATUS`, none of which had a reader either.
export const DEFAULT_CODE_EDITOR_SETTINGS: CodeEditorSettingsState = {
  wordWrap: false,
  showMinimap: true,
  lineNumbers: true,
  fontSize: '14',
};
