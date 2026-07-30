import type { AgentCategoryContentSectionProps } from '../types';
import type { McpProject } from '../../../../../mcp/types';
import { McpServers } from '../../../../../mcp';
import type { SkillsProject } from '../../../../../skills/types';
import { ProviderSkills } from '../../../../../skills';

import AccountContent from './content/AccountContent';
import PermissionsContent from './content/PermissionsContent';

export default function AgentCategoryContentSection({
  selectedCategory,
  authStatus,
  onLogin,
  claudePermissions,
  onClaudePermissionsChange,
  projects,
}: AgentCategoryContentSectionProps) {
  return (
    <div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-3 md:p-4">
      {selectedCategory === 'account' && (
        <AccountContent authStatus={authStatus} onLogin={onLogin} />
      )}

      {/* Cursor's allow/deny command lists and Codex's permission-mode radio
          used to sit beside this block, each behind its own `selectedAgent`
          check. Claude's tool lists are all that is left. */}
      {selectedCategory === 'permissions' && (
        <PermissionsContent
          skipPermissions={claudePermissions.skipPermissions}
          onSkipPermissionsChange={(value) => {
            onClaudePermissionsChange({ ...claudePermissions, skipPermissions: value });
          }}
          allowedTools={claudePermissions.allowedTools}
          onAllowedToolsChange={(value) => {
            onClaudePermissionsChange({ ...claudePermissions, allowedTools: value });
          }}
          disallowedTools={claudePermissions.disallowedTools}
          onDisallowedToolsChange={(value) => {
            onClaudePermissionsChange({ ...claudePermissions, disallowedTools: value });
          }}
        />
      )}

      {selectedCategory === 'mcp' && (
        // SettingsProject.name is populated from the DB projectId by
        // normalizeProjectForSettings, so we can map it straight through.
        <McpServers
          selectedProvider="claude"
          currentProjects={projects.map<McpProject>((project) => ({
            projectId: project.name,
            displayName: project.displayName,
            fullPath: project.fullPath,
            path: project.path,
          }))}
        />
      )}

      {selectedCategory === 'skills' && (
        <ProviderSkills
          selectedProvider="claude"
          currentProjects={projects.map<SkillsProject>((project) => ({
            projectId: project.name,
            displayName: project.displayName,
            fullPath: project.fullPath,
            path: project.path,
          }))}
        />
      )}
    </div>
  );
}
