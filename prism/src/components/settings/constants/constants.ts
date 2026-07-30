import type { ComponentType } from 'react';
import {
  Bell,
  Bot,
  GitBranch,
  Info,
  KeyRound,
  ListChecks,
  MonitorPlay,
  Palette,
  Plug,
} from 'lucide-react';

import type {
  CodeEditorSettingsState,
  SettingsMainTab,
} from '../types/types';

export type SettingsMainTabMeta = {
  id: SettingsMainTab;
  label: string;
  keywords: string;
  icon: ComponentType<{ className?: string }>;
};

export const SETTINGS_MAIN_TABS: SettingsMainTabMeta[] = [
  { id: 'agents', label: 'Agents', keywords: 'agents subagents claude code', icon: Bot },
  { id: 'appearance', label: 'Appearance', keywords: 'appearance theme dark light language', icon: Palette },
  { id: 'git', label: 'Git', keywords: 'git github commits', icon: GitBranch },
  { id: 'api', label: 'API Tokens', keywords: 'api tokens auth keys', icon: KeyRound },
  { id: 'tasks', label: 'Tasks', keywords: 'tasks taskmaster', icon: ListChecks },
  { id: 'browser', label: 'Browser', keywords: 'browser playwright chromium automation', icon: MonitorPlay },
  { id: 'notifications', label: 'Notifications', keywords: 'notifications alerts push', icon: Bell },
  { id: 'plugins', label: 'Plugins', keywords: 'plugins extensions integrations', icon: Plug },
  { id: 'about', label: 'About', keywords: 'about version info', icon: Info },
];

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
