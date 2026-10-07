import type { ComponentType } from 'react';
import { Activity, Bell, Bot, Info, KeyRound, Network, Palette, Shuffle, UserRound, Users } from 'lucide-react';

import type {
  CodeEditorSettingsState,
  SettingsMainTab,
} from '../types/types';

export type SettingsMainTabMeta = {
  id: SettingsMainTab;
  label: string;
  keywords: string;
  icon: ComponentType<{ className?: string }>;
  /** i18n key under the `settings` namespace — 侧栏用它,命令面板回落到 label。 */
  labelKey: string;
  /**
   * Hidden from non-root accounts. The server 403s these routes regardless —
   * this only keeps a tab that can do nothing out of everyone else's settings.
   */
  rootOnly?: boolean;
};

/**
 * 设置页所有主标签的唯一清单,顺序即侧栏顺序。
 *
 * 侧栏(`SettingsSidebar` 的 NAV_ITEMS)、命令面板、深链校验(`useSettingsController` 的
 * KNOWN_MAIN_TABS)都从这里派生,加一个标签只需要在这里加一行。
 */
export const SETTINGS_MAIN_TABS: SettingsMainTabMeta[] = [
  { id: 'agents', label: 'Agents', labelKey: 'mainTabs.agents', keywords: 'agents subagents claude code', icon: Bot },
  { id: 'appearance', label: 'Appearance', labelKey: 'mainTabs.appearance', keywords: 'appearance theme dark light language', icon: Palette },
  { id: 'api', label: 'API Tokens', labelKey: 'mainTabs.apiTokens', keywords: 'api tokens auth keys', icon: KeyRound },
  { id: 'accounts', label: 'Accounts', labelKey: 'mainTabs.accounts', keywords: 'accounts users approval root admin', icon: Users, rootOnly: true },
  { id: 'notifications', label: 'Notifications', labelKey: 'mainTabs.notifications', keywords: 'notifications alerts push', icon: Bell },
  { id: 'account', label: 'My Account', labelKey: 'mainTabs.account', keywords: 'account logout switch user sign out password 退出 登出 切换账号 修改密码', icon: UserRound },
  // 每个人都有:填自己的 key、管自己的私有网关 / 模型(root 也在这里填自己的 key)
  { id: 'gateways', label: 'Model Gateways', labelKey: 'mainTabs.gateways', keywords: 'model gateway key api key personal private base url 模型网关 网关 个人 key 密钥 私有网关 私有模型', icon: Network },
  { id: 'models', label: 'Models', labelKey: 'mainTabs.models', keywords: 'model catalog mapping alias sonnet opus haiku fable settings.json context window gateway 模型 目录 映射 别名 窗口 网关', icon: Shuffle, rootOnly: true },
  { id: 'server', label: 'Server Status', labelKey: 'mainTabs.server', keywords: 'server status cpu memory disk jupyter gateway 服务器 状态 网关', icon: Activity, rootOnly: true },
  { id: 'about', label: 'About', labelKey: 'mainTabs.about', keywords: 'about version info', icon: Info },
];

/** 所有合法的主标签 id。深链与持久化的标签值据此校验。 */
export const SETTINGS_MAIN_TAB_IDS = SETTINGS_MAIN_TABS.map((tab) => tab.id);

export const DEFAULT_CODE_EDITOR_SETTINGS: CodeEditorSettingsState = {
  wordWrap: false,
  showMinimap: true,
  lineNumbers: true,
  fontSize: '14',
};
