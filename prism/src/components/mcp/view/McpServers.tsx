import { Edit3, Globe, Lock, Plus, Server, Terminal, Trash2, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { isManagedMcpServerName } from '../../../../shared/managedMcpServers.js';
import type { McpProject, McpProvider, McpScope, ProviderMcpServer } from '../types';
import { Badge, Button } from '../../../shared/view/ui';
import { MCP_PROVIDER_NAMES } from '../constants';
import { useMcpServers } from '../hooks/useMcpServers';
import { maskSecret } from '../utils/mcpFormatting';

import McpServerFormModal from './modals/McpServerFormModal';

type McpServersProps = {
  selectedProvider: McpProvider;
  currentProjects: McpProject[];
};

const getTransportIcon = (transport: string | undefined) => {
  if (transport === 'stdio') {
    return <Terminal className="h-4 w-4" />;
  }

  if (transport === 'sse') {
    return <Zap className="h-4 w-4" />;
  }

  if (transport === 'http') {
    return <Globe className="h-4 w-4" />;
  }

  return <Server className="h-4 w-4" />;
};

const getScopeLabel = (scope: McpScope): string => {
  if (scope === 'user') {
    return 'user';
  }

  if (scope === 'local') {
    return 'local';
  }

  return 'project';
};

const getServerKey = (server: ProviderMcpServer): string => (
  `${server.provider}:${server.scope}:${server.workspacePath || 'global'}:${server.name}`
);

// Written and removed automatically by a Prism feature toggle (the Browser
// tab), not added by the user, so they are shown read-only: editing or deleting
// one here would leave the toggle on with nothing behind it. The name list is
// shared with the backend that registers them — see that module for why this
// stopped agreeing with reality once.
const isManagedServer = (server: ProviderMcpServer): boolean => isManagedMcpServerName(server.name);

function ConfigLine({ label, children }: { label: string; children: string }) {
  if (!children) {
    return null;
  }

  return (
    <div>
      {label}:{' '}
      <code className="rounded bg-muted px-1 text-xs">{children}</code>
    </div>
  );
}

export default function McpServers({ selectedProvider, currentProjects }: McpServersProps) {
  const { t } = useTranslation('settings');
  const {
    servers,
    isLoading,
    isLoadingProjectScopes,
    loadError,
    deleteError,
    saveStatus,
    isFormOpen,
    editingServer,
    openForm,
    closeForm,
    submitForm,
    deleteServer,
  } = useMcpServers({ selectedProvider, currentProjects });

  const providerName = MCP_PROVIDER_NAMES[selectedProvider];
  // This was a template-literal key — `mcpServers.description.${selectedProvider}` —
  // resolving against four sibling entries in settings.json. Only the Claude one
  // survives, and a literal key is what the i18n lint/extraction tooling can see.
  const description = t('mcpServers.description.claude', {
    defaultValue: `Model Context Protocol servers provide additional tools and data sources to ${providerName}`,
  });
  // There used to be a second "Add Global MCP Server" entry beside this one,
  // which wrote the same server to Claude, Cursor, Codex and OpenCode at once.
  // With Claude the only provider it did exactly what this button does, except
  // it refused SSE — the transports had been narrowed to what all four had in
  // common. Two buttons, one of them quietly worse.
  const addButtonLabel = `Add ${providerName} MCP Server`;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <Server className="mt-0.5 h-5 w-5 flex-shrink-0 text-purple-500" />
          <div className="min-w-0 space-y-1">
            <h3 className="text-lg font-medium text-foreground">{t('mcpServers.title')}</h3>
            <p className="text-sm text-muted-foreground">{description}</p>
          </div>
        </div>
        <Button onClick={() => openForm()} className="w-full gap-2 sm:w-auto">
          <Plus className="h-4 w-4" />
          {addButtonLabel}
        </Button>

      </div>

      <div className="space-y-2">
        <div className="min-h-4">
          {saveStatus === 'success' && (
            <span className="animate-in fade-in text-xs text-muted-foreground">{t('saveStatus.success')}</span>
          )}
          {isLoadingProjectScopes && (
            <span className="animate-in fade-in text-xs text-muted-foreground">Refreshing project scopes...</span>
          )}
        </div>
      </div>

      {(loadError || deleteError) && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800/60 dark:bg-red-900/20 dark:text-red-200">
          {deleteError || loadError}
        </div>
      )}

      <div className="space-y-2">
        {isLoading && servers.length === 0 && (
          <div className="py-8 text-center text-muted-foreground">Loading MCP servers...</div>
        )}

        {servers.map((server) => {
          const managed = isManagedServer(server);

          return (
            <div key={getServerKey(server)} className="rounded-lg border border-border bg-card/50 p-4">
              <div className="flex items-start justify-between">
                <div className="min-w-0 flex-1">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    {!managed && getTransportIcon(server.transport)}
                    <span className="font-medium text-foreground">{server.name}</span>
                    {!managed && (
                      <>
                        <Badge variant="outline" className="text-xs">
                          {server.transport || 'stdio'}
                        </Badge>
                        <Badge variant="outline" className="text-xs">
                          {getScopeLabel(server.scope)}
                        </Badge>
                        {server.projectDisplayName && (
                          <Badge variant="outline" className="max-w-full truncate text-xs">
                            {server.projectDisplayName}
                          </Badge>
                        )}
                      </>
                    )}
                    {managed && (
                      <Badge variant="outline" className="gap-1 text-xs text-muted-foreground">
                        <Lock className="h-3 w-3" />
                        {t('mcpServers.managed.badge', { defaultValue: 'Managed' })}
                      </Badge>
                    )}
                  </div>

                  <div className="space-y-1 text-sm text-muted-foreground">
                    {!managed && (
                      <>
                        <ConfigLine label={t('mcpServers.config.command')}>{server.command || ''}</ConfigLine>
                        <ConfigLine label={t('mcpServers.config.url')}>{server.url || ''}</ConfigLine>
                        <ConfigLine label={t('mcpServers.config.args')}>{(server.args || []).join(' ')}</ConfigLine>
                        {server.env && Object.keys(server.env).length > 0 && (
                          <ConfigLine label={t('mcpServers.config.environment')}>
                            {Object.entries(server.env).map(([key, value]) => `${key}=${maskSecret(value)}`).join(', ')}
                          </ConfigLine>
                        )}
                      </>
                    )}
                    {managed && (
                      <div className="text-xs text-muted-foreground">
                        {t('mcpServers.managed.hint', {
                          defaultValue: 'Managed by Prism.',
                        })}
                      </div>
                    )}
                  </div>
                </div>

                {!managed && (
                  <div className="ml-4 flex items-center gap-2">
                    <Button
                      onClick={() => openForm(server)}
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-foreground"
                      title={t('mcpServers.actions.edit')}
                    >
                      <Edit3 className="h-4 w-4" />
                    </Button>
                    <Button
                      onClick={() => deleteServer(server)}
                      variant="ghost"
                      size="sm"
                      className="text-red-600 hover:text-red-700"
                      title={t('mcpServers.actions.delete')}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {!isLoading && !isLoadingProjectScopes && servers.length === 0 && (
          <div className="py-8 text-center text-muted-foreground">{t('mcpServers.empty')}</div>
        )}
      </div>

      <McpServerFormModal
        provider={selectedProvider}
        isOpen={isFormOpen}
        editingServer={editingServer}
        currentProjects={currentProjects}
        title={editingServer ? undefined : addButtonLabel}
        submitLabel={addButtonLabel}
        onClose={closeForm}
        onSubmit={submitForm}
      />
    </div>
  );
}
