import type {
  AgentCategory,
  AuthStatus,
  ClaudePermissionsState,
  SettingsProject,
} from '../../../types/types';

export type AgentsSettingsTabProps = {
  authStatus: AuthStatus;
  onLogin: () => void;
  claudePermissions: ClaudePermissionsState;
  onClaudePermissionsChange: (value: ClaudePermissionsState) => void;
  projects: SettingsProject[];
};

export type AgentCategoryTabsSectionProps = {
  categories: AgentCategory[];
  selectedCategory: AgentCategory;
  onSelectCategory: (category: AgentCategory) => void;
};

export type AgentCategoryContentSectionProps = {
  selectedCategory: AgentCategory;
  authStatus: AuthStatus;
  onLogin: () => void;
  claudePermissions: ClaudePermissionsState;
  onClaudePermissionsChange: (value: ClaudePermissionsState) => void;
  projects: SettingsProject[];
};
