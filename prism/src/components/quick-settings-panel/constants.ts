import {
  Brain,
  Eye,
  Languages,
  } from 'lucide-react';

import type { PreferenceToggleItem } from './types';

export const HANDLE_POSITION_STORAGE_KEY = 'quickSettingsHandlePosition';

/** 图标轨上的快捷设置入口通过这个 window 事件开关面板(面板挂在聊天页内)。 */
export const QUICK_SETTINGS_TOGGLE_EVENT = 'prism:quick-settings-toggle';

export const DEFAULT_HANDLE_POSITION = 50;
export const HANDLE_POSITION_MIN = 10;
export const HANDLE_POSITION_MAX = 90;
export const DRAG_THRESHOLD_PX = 5;

export const SETTING_ROW_CLASS =
  'flex items-center justify-between p-3 rounded-lg bg-card border border-border transition-colors';

// 可点的行才给 hover 反馈,且只动描边(设计系统的 outline hover 规则)。
export const TOGGLE_ROW_CLASS = `${SETTING_ROW_CLASS} cursor-pointer hover:border-border-strong`;

export const CHECKBOX_CLASS =
  'h-4 w-4 rounded-sm border-border text-primary focus:ring-ring focus:ring-2 bg-muted checked:bg-primary';

export const TOOL_DISPLAY_TOGGLES: PreferenceToggleItem[] = [
  {
    key: 'showRawParameters',
    labelKey: 'quickSettings.showRawParameters',
    icon: Eye,
  },
  {
    key: 'showThinking',
    labelKey: 'quickSettings.showThinking',
    icon: Brain,
  },
];

export const INPUT_SETTING_TOGGLES: PreferenceToggleItem[] = [
  {
    key: 'sendByCtrlEnter',
    labelKey: 'quickSettings.sendByCtrlEnter',
    icon: Languages,
  },
];
