/**
 * The agent backends this build can talk to.
 *
 * Kept in step with the server's own `LLMProvider`, which is `'claude'` and has
 * been since the provider registry was narrowed. This side still listed cursor,
 * codex and opencode, so the UI went on offering three providers whose every
 * request `resolveProvider()` answers with `UNSUPPORTED_PROVIDER` — a picker
 * where two thirds of the entries are a 400.
 */
export type LLMProvider = 'claude';

export type ProviderModelOption = {
  value: string;
  label: string;
  description?: string;
  effort?: {
    default?: string;
    values: {
      value: string;
      description?: string;
    }[];
  };
};

export type ProviderModelsDefinition = {
  OPTIONS: ProviderModelOption[];
  DEFAULT: string;
};

export type ProviderModelsCacheInfo = {
  updatedAt: string;
  expiresAt: string;
  source: 'memory' | 'disk' | 'fresh';
};

export type AppTab = 'chat' | 'tasks' | 'files' | 'shell' | 'notebook';

export interface ProjectSession {
  id: string;
  title?: string;
  summary?: string;
  name?: string;
  createdAt?: string;
  created_at?: string;
  updated_at?: string;
  lastActivity?: string;
  messageCount?: number;
  provider?: LLMProvider;
  __provider?: LLMProvider;
  // Tags the session with the owning project's DB `projectId` so UI handlers
  // (session switching, sidebar focus, etc.) can match against selectedProject.
  __projectId?: string;
  [key: string]: unknown;
}

export interface ProjectSessionMeta {
  total?: number;
  hasMore?: boolean;
  [key: string]: unknown;
}

// After the projectName → projectId migration the backend no longer returns a
// folder-derived `name` string. Projects are now addressed everywhere by the
// DB-assigned `projectId` (primary key in the `projects` table), and the UI
// uses the same identifier for routing, state keys and API calls.
export interface Project {
  projectId: string;
  displayName: string;
  fullPath: string;
  path?: string;
  isStarred?: boolean;
  /**
   * Owning account id. `null` = unclaimed (only root sees it, unless it sits
   * under PRISM_PUBLIC_WORKSPACE). Undefined on payloads produced before
   * ownership existed. NOTE: null no longer implies "public" —— use `isPublic`.
   */
  ownerUserId?: number | null;
  /**
   * True only when the project is genuinely world-visible: explicitly created
   * as public (visibility='public') or unclaimed AND under the configured
   * public workspace. Drives the "公共" badge.
   */
  isPublic?: boolean;
  /** 这个项目是被「指定用户」授权给当前登录用户的 —— 显示"共享"徽标。 */
  sharedWithViewer?: boolean;
  /** 授权名单人数;owner/root 视角靠它显示"已共享·N"(他们不是接收方)。 */
  sharedUserCount?: number;
  sessions?: ProjectSession[];
  sessionMeta?: ProjectSessionMeta;
  [key: string]: unknown;
}

export interface LoadingProgress {
  kind?: 'loading_progress';
  phase?: string;
  current: number;
  total: number;
  currentProject?: string;
  [key: string]: unknown;
}
