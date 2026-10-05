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
  /**
   * hn(B2):`catalog` = 模型目录里的网关模型;`alias` = 内置别名组(子代理与 CLI 内部任务用,
   * 选择器里默认收起)。老数据没有这个字段,当 alias 看。
   */
  group?: 'catalog' | 'alias';
  /** 厂商(图标与分组);null = 认不出,画首字母徽标。 */
  vendor?: string | null;
  /** 推荐区 */
  recommended?: boolean;
  /** 目录里填的上下文窗口;null = 没填(CLI 默认)。 */
  contextWindow?: number | null;
  /** 真实的网关模型名 —— 目录条目就是 value 本身;别名组靠 configMappings 另查。 */
  realModel?: string;
  /** hq:走哪个网关(0 = settings.json 那一套)。 */
  gatewayId?: number;
  /** hq:网关名(只在不是默认网关时给,选择器里小字显示)。 */
  gatewayName?: string;
  /** hq:本人的私有模型(服务端排在最前)。 */
  private?: boolean;
  /** hq:这个人现在能不能用(网关没有默认 key、他也没填自己的 key / 网关停用 → false)。缺省 = 能用。 */
  available?: boolean;
  /** hq:不能用的原因(服务端给的中文,原样显示)。 */
  unavailableReason?: string;
  /** hq:不能用的原因码 —— no_key 才给「去填 key」;网关停用 / 不见了只能找管理员。 */
  unavailableCode?: 'no_key' | 'gateway_disabled' | 'gateway_missing';
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

export type AppTab = 'chat' | 'tasks' | 'skillwhet' | 'files' | 'shell' | 'notebook';

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
  /** hl 复核 P3-8:正在看的项目已被移除(归档 / 删除 / 收回可见性);对话区保留,只显示提示。 */
  removedFromView?: boolean;
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
