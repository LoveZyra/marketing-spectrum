import type {
  AgentCategory,
  AuthStatus,
  ClaudePermissionsState,
  SettingsProject,
} from '../../../types/types';

// This tab used to be a four-agent switchboard: a pill bar to choose between
// Claude, Cursor, Codex and OpenCode, and a props surface carrying each one's
// permissions model alongside the others. With Claude the only agent the pill
// bar had a single pill, so the selection is gone — and with it every
// `selectedAgent` prop that existed only so a section could ask which agent
// was on screen.
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
