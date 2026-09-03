import { lazy, Suspense } from 'react';

import type { AgentCategoryContentSectionProps } from '../types';
import type { McpProject } from '../../../../../mcp/types';
import type { SkillsProject } from '../../../../../skills/types';
import { PanelLoadingFallback } from '../../../../../../shared/view/LazyPanel';

import AccountContent from './content/AccountContent';
import PermissionsContent from './content/PermissionsContent';

/**
 * G3:MCP 与技能两页各自带着一整套上传/拖放/表单逻辑,而它们只在设置弹窗的
 * 某个分类被点开时才用得上 —— 打包进主块等于让**每个人**在首屏为两个多数时候
 * 不会打开的页面付费。懒加载之后它们各自成块,点到才拉。
 */
const McpServers = lazy(() => import('../../../../../mcp/view/McpServers'));
const ProviderSkills = lazy(() => import('../../../../../skills/view/ProviderSkills'));

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
        <Suspense fallback={<PanelLoadingFallback />}>
          {/* SettingsProject.name is populated from the DB projectId by
              normalizeProjectForSettings, so we can map it straight through.
              (dr:这两行原来是 JSX 子节点里的裸 `//` —— 那是文本节点不是注释,
              整句被渲染在了 MCP 页顶上。) */}
          <McpServers
            selectedProvider="claude"
            currentProjects={projects.map<McpProject>((project) => ({
              projectId: project.name,
              displayName: project.displayName,
              fullPath: project.fullPath,
              path: project.path,
            }))}
          />
        </Suspense>
      )}

      {selectedCategory === 'skills' && (
        <Suspense fallback={<PanelLoadingFallback />}>
          <ProviderSkills
            selectedProvider="claude"
            currentProjects={projects.map<SkillsProject>((project) => ({
              projectId: project.name,
              displayName: project.displayName,
              fullPath: project.fullPath,
              path: project.path,
            }))}
          />
        </Suspense>
      )}
    </div>
  );
}
