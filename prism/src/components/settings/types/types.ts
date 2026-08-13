import type { Dispatch, SetStateAction } from 'react';

import type { LLMProvider } from '../../../types/app';
import type { ProviderAuthStatus } from '../../provider-auth/types';

export type SettingsMainTab = 'agents' | 'appearance' | 'api' | 'voice' | 'tasks' | 'browser' | 'notifications' | 'plugins' | 'accounts' | 'about';
export type AgentProvider = LLMProvider;
export type AgentCategory = 'account' | 'permissions' | 'mcp' | 'skills';
export type ProjectSortOrder = 'name' | 'date';
export type SaveStatus = 'success' | 'error' | null;

export type SettingsProject = {
  name: string;
  displayName?: string;
  fullPath?: string;
  path?: string;
};

export type AuthStatus = ProviderAuthStatus;

export type ClaudePermissionsState = {
  allowedTools: string[];
  disallowedTools: string[];
  skipPermissions: boolean;
};

export type NotificationPreferencesState = {
  channels: {
    inApp: boolean;
    webPush: boolean;
    desktop: boolean;
    sound: boolean;
  };
  events: {
    actionRequired: boolean;
    stop: boolean;
    error: boolean;
  };
};

export type CodeEditorSettingsState = {
  wordWrap: boolean;
  showMinimap: boolean;
  lineNumbers: boolean;
  fontSize: string;
};

// `SettingsStoragePayload` described the three localStorage blobs the settings
// modal wrote — claude, cursor and codex. It was never imported anywhere, so it
// documented the shape rather than enforcing it; the cursor and codex blobs are
// gone and the claude one is written inline by `useSettingsController`.

export type SettingsProps = {
  isOpen: boolean;
  onClose: () => void;
  projects?: SettingsProject[];
  initialTab?: string;
};

export type SetState<T> = Dispatch<SetStateAction<T>>;
