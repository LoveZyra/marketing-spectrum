import type { LLMProvider } from '../../types/app';

export type McpProvider = LLMProvider;
export type McpScope = 'user' | 'local' | 'project';
export type McpTransport = 'stdio' | 'http' | 'sse';
export type McpImportMode = 'form' | 'json';
export type KeyValueMap = Record<string, string>;

// Internal MCP shape; `projectId` replaces the legacy `name` field from the
// projectName → projectId migration.
export type McpProject = {
  projectId: string;
  displayName?: string;
  fullPath?: string;
  path?: string;
};

/**
 * One entry out of Claude's MCP config.
 *
 * The fields here are exactly the ones `ClaudeMcpProvider` serialises and reads
 * back: `command`/`args`/`env` for stdio, `url`/`headers` for http and sse. A
 * `cwd`, an `envVars` list, a `bearerTokenEnvVar` and `envHttpHeaders` used to
 * ride along as well — those are Codex's config format, and with Codex gone the
 * form collected them, the route parsed them and the adapter dropped them.
 */
export type ProviderMcpServer = {
  provider: McpProvider;
  name: string;
  scope: McpScope;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: KeyValueMap;
  url?: string;
  headers?: KeyValueMap;
  workspacePath?: string;
  projectName?: string;
  projectDisplayName?: string;
};

export type McpFormState = {
  name: string;
  scope: McpScope;
  workspacePath: string;
  transport: McpTransport;
  command: string;
  args: string[];
  env: KeyValueMap;
  url: string;
  headers: KeyValueMap;
  importMode: McpImportMode;
  jsonInput: string;
};

export type UpsertProviderMcpServerPayload = {
  name: string;
  scope: McpScope;
  transport: McpTransport;
  workspacePath?: string;
  command?: string;
  args?: string[];
  env?: KeyValueMap;
  url?: string;
  headers?: KeyValueMap;
};

export type ApiSuccessResponse<T> = {
  success: true;
  data: T;
};

export type ApiErrorResponse = {
  success: false;
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
};

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;
