import type { McpFormState, McpProvider, McpScope, McpTransport } from './types';

export const MCP_PROVIDER_NAMES: Record<McpProvider, string> = {
  claude: 'Claude',
};

export const MCP_SUPPORTED_SCOPES: Record<McpProvider, McpScope[]> = {
  claude: ['user', 'project', 'local'],
};

export const MCP_SUPPORTED_TRANSPORTS: Record<McpProvider, McpTransport[]> = {
  claude: ['stdio', 'http', 'sse'],
};

export const DEFAULT_MCP_FORM: McpFormState = {
  name: '',
  scope: 'user',
  workspacePath: '',
  transport: 'stdio',
  command: '',
  args: [],
  env: {},
  url: '',
  headers: {},
  importMode: 'form',
  jsonInput: '',
};
