import type { IncomingMessage } from 'node:http';

//----------------- HTTP RESPONSE SHAPES ------------
/**
 * Canonical success envelope used by backend APIs that return a structured payload.
 *
 * Use this for route handlers that need a stable `success/data` shape so frontend
 * consumers can parse responses consistently across endpoints.
 */
export type ApiSuccessShape<TData = unknown> = {
  success: true;
  data: TData;
};

/**
 * Generic plain-object record used when parsing loosely typed JSON payloads.
 *
 * Use this only after runtime shape checks, not as a replacement for validated
 * domain models.
 */
export type AnyRecord = Record<string, any>;

// ---------------------------
//----------------- WEBSOCKET TRANSPORT TYPES ------------
/**
 * Minimal websocket client contract used by backend broadcaster services.
 *
 * Any transport object added to `connectedClients` must implement these two
 * members so shared services can safely send JSON strings and check whether the
 * socket is still open before broadcasting.
 */
export type RealtimeClientConnection = {
  readyState: number;
  send(data: string): void;
  /**
   * Who is on the other end. Attached at upgrade time so broadcasts can be
   * scoped per recipient — without it every connected socket looks identical
   * and the only options are "send to everyone" or "send to nobody".
   */
  prismUserId?: string | number | null;
  prismUsername?: string | null;
};

/**
 * Authenticated user payload attached to websocket upgrade requests.
 *
 * Platform and OSS auth flows currently use either `id` or `userId`; both are
 * represented here so websocket handlers can resolve a stable writer user id.
 */
export type AuthenticatedWebSocketUser = {
  id?: string | number;
  userId?: string | number;
  username?: string;
  [key: string]: unknown;
};

/**
 * HTTP upgrade request shape after websocket authentication succeeds.
 *
 * `verifyClient` populates `request.user` with the authenticated payload, and
 * downstream websocket handlers rely on this extended request type.
 */
export type AuthenticatedWebSocketRequest = IncomingMessage & {
  user?: AuthenticatedWebSocketUser;
};

/**
 * Who is asking — the minimum identity every visibility decision needs.
 *
 * Deliberately just these two fields. `username` is here because root is
 * decided by name against `PRISM_ROOT_USERS` and never stored on the row, so a
 * numeric id alone cannot answer "is this root". Anything richer would invite
 * each call site to invent its own shape, which is how the archived-sessions
 * endpoint ended up with no filter at all.
 */
export type Viewer = {
  userId: number | string | null;
  username: string | null;
};

// ---------------------------
//----------------- PROVIDER MESSAGE MODEL ------------
/**
 * Providers supported by the unified server runtime.
 *
 * Use this as the source of truth whenever a function or payload needs to identify
 * a specific LLM integration. Claude Code is the only supported provider.
 */
export type LLMProvider = 'claude';

/**
 * One selectable model row in a provider model catalog.
 */
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

/**
 * Provider model catalog returned by `GET /api/providers/:provider/models`.
 */
export type ProviderModelsDefinition = {
  OPTIONS: ProviderModelOption[];
  DEFAULT: string;
};

/**
 * Cache metadata returned alongside one provider model catalog.
 *
 * `updatedAt` is when the current cached snapshot was last refreshed from the
 * provider itself. `expiresAt` is the backend cache expiry timestamp, and
 * `source` tells callers whether the current response came from in-memory cache,
 * persisted disk cache, or a fresh provider fetch.
 */
export type ProviderModelsCacheInfo = {
  updatedAt: string;
  expiresAt: string;
  source: 'memory' | 'disk' | 'fresh';
};

/**
 * Full provider model lookup result returned by the backend service layer.
 *
 * Use this shape when a caller needs both the selectable model catalog and the
 * cache metadata that explains how current the catalog is.
 */
export type ProviderModelsResult = {
  models: ProviderModelsDefinition;
  cache: ProviderModelsCacheInfo;
};

// ---------------------------
//----------------- PROVIDER ACTIVE MODEL TYPES ------------
/**
 * Provider-neutral result for the model that is actively driving a session or
 * provider runtime at the time of lookup.
 *
 * `model` must always be populated. Provider adapters should use the
 * provider-specific lookup method requested by the caller, and only fall back
 * to the provider catalog `DEFAULT` value when the active model cannot be read.
 */
export type ProviderCurrentActiveModel = {
  model: string;
};

/**
 * Input payload used when one session needs to use a different model on its
 * next resumed turn.
 *
 * This is a backend-owned session override, not a claim that the provider has
 * already switched the currently running session in-place. Provider adapters
 * persist this request so the next CLI/SDK resume can inject the chosen model
 * using the provider-specific mechanism supported by that runtime.
 */
export type ProviderChangeActiveModelInput = {
  sessionId: string;
  model: string;
};

/**
 * Provider-neutral session model-change state.
 *
 * `supported` indicates whether the provider adapter supports the app's
 * session-scoped resume override flow. `changed` is the persisted boolean the
 * resume layer checks before forcing a model on the next resumed turn. When
 * `changed` is `false`, `model` is `null` and the runtime should use the
 * normal request/default model selection path.
 */
export type ProviderSessionActiveModelChange = {
  provider: LLMProvider;
  sessionId: string;
  supported: boolean;
  changed: boolean;
  model: string | null;
};

/**
 * Message/event variants emitted by provider adapters and normalized transports.
 *
 * Keep this union in sync with event kinds produced by provider session adapters.
 */
export type MessageKind =
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'thinking'
  | 'stream_delta'
  | 'stream_end'
  | 'error'
  | 'complete'
  | 'status'
  | 'permission_request'
  | 'permission_cancelled'
  | 'session_created'
  | 'interactive_prompt'
  | 'task_notification'
  // prism additions: per-turn git checkpoints + changed-files summaries
  | 'checkpoint_created'
  | 'changed_files';

/**
 * Event kinds added by the chat gateway layer on top of provider message kinds.
 *
 * These are app-level realtime events (subscription acks, sidebar deltas,
 * project loading progress, protocol failures) that are not produced by any
 * provider adapter. Together with `MessageKind` they form the complete set of
 * `kind` values a websocket client can receive, so the frontend only ever
 * needs one kind-based switch.
 */
export type GatewayEventKind =
  | 'chat_subscribed'
  | 'session_upserted'
  | 'loading_progress'
  | 'protocol_error';

/**
 * Complete set of `kind` values emitted to websocket clients.
 *
 * Every server-to-client websocket frame carries a `kind` from this union.
 * Provider runtimes emit `MessageKind` values; gateway services emit
 * `GatewayEventKind` values.
 */
export type ServerEventKind = MessageKind | GatewayEventKind;

/**
 * Provider-neutral message envelope used in REST responses and realtime channels.
 *
 * Every provider-specific message must be converted into this shape before being
 * emitted outside provider-specific modules.
 */
export type NormalizedMessage = {
  id: string;
  sessionId: string;
  timestamp: string;
  provider: LLMProvider;
  kind: MessageKind;
  /**
   * Monotonic per-run sequence number assigned by the chat run registry when a
   * live event is forwarded to the websocket. History messages loaded over
   * REST do not carry it. Clients use it with `chat.subscribe` to replay only
   * the live events they missed across websocket reconnects.
   */
  seq?: number;
  /** 这条事件属于哪一轮。客户端据此判断补发游标还作不作数。 */
  runId?: string;
  role?: 'user' | 'assistant';
  /**
   * 这一轮实际服务的模型(assistant 文本消息携带;取自响应元数据的 message.model)。
   * 前端在每条回答的时间戳旁显示 —— 模型的自我介绍会顺着上下文复述历史,不可信,
   * 这个字段才是"谁答的"的铁证。
   */
  model?: string;
  content?: string;
  /**
   * Optional display-oriented metadata used by providers that need to expose
   * richer transcript artifacts without introducing a brand-new message kind.
   *
   * Current Claude usage:
   * - local slash commands expose parsed command fields
   * - compact summaries are flagged so the UI can treat them differently later
   */
  displayText?: string;
  commandName?: string;
  commandMessage?: string;
  commandArgs?: string;
  isLocalCommand?: boolean;
  isLocalCommandStdout?: boolean;
  isCompactSummary?: boolean;
  images?: unknown;
  toolName?: string;
  toolInput?: unknown;
  toolId?: string;
  toolResult?: {
    content?: string;
    isError?: boolean;
    toolUseResult?: unknown;
  };
  isError?: boolean;
  text?: string;
  tokens?: number;
  canInterrupt?: boolean;
  /** 状态的类别。目前只有 'compacting' —— 让前端能本地化并单独造型,
      而不是把英文状态原文摆到界面上。 */
  statusKind?: 'compacting';
  /**
   * 一次压缩的实况。压缩是**一次模型调用**,没有完成度可言 —— 这里带的是能诚实
   * 给出的三件事:阶段(running/done/failed)、心跳(beat,只在 CLI 真的吐东西时
   * 递增)、以及结束后的硬数据(pre/post token 与耗时,来自 compact_metadata)。
   * `blocking` 说明这次压缩占不占用户的等待时间;`lastDurationMs` 是本会话上次
   * 压缩用时 —— 界面上唯一诚实的"还要多久"参照。
   */
  compaction?: {
    phase: 'running' | 'done' | 'failed' | 'skipped';
    /** phase='skipped' 时为什么没压:对话太短,或用户中止。都不是失败。 */
    skipReason?: 'too-short' | 'aborted';
    trigger: 'manual' | 'auto' | 'maintenance' | 'presend';
    blocking: boolean;
    beat?: number;
    /** 服务端算的已用时长 —— 断线重连后客户端不必从 0 重新起算。 */
    elapsedMs?: number;
    /** 心跳断多久算「没有响应」。跟着这一回合的静默看门狗走,不写死。 */
    stallAfterMs?: number;
    preTokens?: number | null;
    postTokens?: number | null;
    durationMs?: number | null;
    lastDurationMs?: number | null;
    error?: string | null;
  };
  requestId?: string;
  input?: unknown;
  context?: unknown;
  reason?: string;
  newSessionId?: string;
  status?: string;
  summary?: string;
  tokenBudget?: unknown;
  subagentTools?: unknown;
  toolUseResult?: unknown;
  sequence?: number;
  rowid?: number;
  [key: string]: unknown;
};

/**
 * Shared options used to fetch historical provider messages.
 *
 * Consumers should pass provider-specific lookup hints (`projectPath`) only
 * when the selected provider requires them.
 *
 * `providerSessionId` is the provider-native session id from the sessions
 * index (transcript file name / provider database key). Provider adapters
 * must use it — never the app-facing session id they were called with — when
 * matching transcript rows on disk, because app-created sessions use an
 * app-allocated id that the provider has never seen.
 */
export type FetchHistoryOptions = {
  projectPath?: string;
  limit?: number | null;
  offset?: number;
  providerSessionId?: string;
};

/**
 * Standardized response payload returned from provider history readers.
 *
 * Use this as the contract for APIs that return paginated conversation history.
 */
export type FetchHistoryResult = {
  messages: NormalizedMessage[];
  total: number;
  hasMore: boolean;
  offset: number;
  limit: number | null;
  tokenUsage?: unknown;
};

// ---------------------------
//----------------- PROVIDER SKILL TYPES ------------
/**
 * Scope where a provider skill definition was discovered.
 *
 * Describes the origin of each skill markdown file without leaking
 * provider-specific folder names into route contracts: `user` is
 * `~/.claude/skills`, `project` is `<workspace>/.claude/skills`, and `plugin`
 * is an enabled plugin install.
 *
 * Upstream also had `repo`, `admin` and `system` here, for Codex repository
 * lookup locations and OpenCode's system skill roots. Those providers were
 * removed, so no adapter can emit them any more and they are gone from the
 * union; the frontend coerces an unrecognized scope to `user` rather than
 * dropping the skill, so an old row cannot break the list.
 */
export type ProviderSkillScope = 'user' | 'project' | 'plugin';

/**
 * Shared input accepted by provider skill listing operations.
 *
 * Routes pass `workspacePath` when a caller wants project/repository skills for
 * a specific folder. Providers should fall back to the backend process cwd when
 * this option is omitted.
 */
export type ProviderSkillListOptions = {
  workspacePath?: string;
};

/**
 * One supporting file bundled with an uploaded provider skill.
 *
 * `relativePath` is resolved below the installed skill directory and must never
 * be absolute or contain traversal segments. Text files may use `utf8`; binary
 * scripts and assets should use `base64` so JSON transport does not corrupt
 * their bytes.
 */
export type ProviderSkillCreateFile = {
  relativePath: string;
  content: string;
  encoding: 'utf8' | 'base64';
};

/**
 * One skill markdown payload submitted for provider-managed installation.
 *
 * `content` is the raw markdown body that will be written to `SKILL.md`.
 * `directoryName` lets callers control the target folder name explicitly when
 * they want stable filesystem paths that differ from the markdown front matter
 * `name` field. `fileName` is optional upload metadata used only as a final
 * fallback when no directory name or front matter name is present. `files`
 * carries scripts, references, and other files from a complete skill folder.
 */
export type ProviderSkillCreateEntry = {
  content: string;
  directoryName?: string;
  fileName?: string;
  files?: ProviderSkillCreateFile[];
};

/**
 * Shared input accepted by provider skill creation operations.
 *
 * The service layer batches multiple skill definitions in one request. Each
 * entry can contain only markdown or a complete skill folder.
 */
export type ProviderSkillCreateInput = {
  entries: ProviderSkillCreateEntry[];
};

export type ProviderSkillRemoveInput = {
  directoryName: string;
};

/**
 * Normalized skill record returned by provider skill adapters.
 *
 * The `command` value is the exact invocation text the selected provider expects
 * for this skill: `/skill-name` for user and project skills, and the
 * namespaced `/plugin-name:skill-name` form for plugin skills.
 * `sourcePath` points to the skill markdown file that produced the record so
 * callers can distinguish duplicate skill names across scopes.
 */
export type ProviderSkill = {
  provider: LLMProvider;
  name: string;
  description: string;
  command: string;
  scope: ProviderSkillScope;
  sourcePath: string;
  pluginName?: string;
  pluginId?: string;
  /**
   * F13:这个技能的目录名 —— **只有能被卸载的那些才有**(用户级、直接躺在受管
   * 技能根目录下的那一层)。
   *
   * 由服务端给,而不是让前端从 sourcePath 里猜:哪些路径算"受管根目录之下"
   * 是服务端的知识,猜错的后果是界面给出一个点了会失败(或更糟,删错东西)的
   * 卸载按钮。字段不在 = 不可卸载,界面据此不画按钮。
   */
  directoryName?: string;
};

/**
 * Internal source descriptor consumed by shared provider skill discovery logic.
 *
 * Concrete provider adapters build these records from their native lookup rules.
 * The shared skills provider then scans `rootDir` for child skill markdown files
 * and uses `commandForSkill` or `commandPrefix` to produce the provider-specific
 * invocation command. Set `recursive` only when a provider stores skills under
 * arbitrary nested folders below the source root.
 */
export type ProviderSkillSource = {
  scope: ProviderSkillScope;
  rootDir: string;
  recursive?: boolean;
  commandPrefix?: '/' | '$';
  commandForSkill?: (skillName: string) => string;
  pluginName?: string;
  pluginId?: string;
};

// ---------------------------
//----------------- SHARED ERROR TYPES ------------
/**
 * Optional metadata used when constructing application-level errors.
 *
 * `statusCode` should reflect the HTTP response status, while `code` identifies
 * the stable machine-readable error category.
 */
export type AppErrorOptions = {
  code?: string;
  statusCode?: number;
  details?: unknown;
};

// ---------------------------
//----------------- MCP TYPES ------------
/**
 * Scope where an MCP server definition is stored and resolved.
 *
 * `user` is global for a user account, `local` is provider-local, and `project`
 * is tied to a specific project path.
 */
export type McpScope = 'user' | 'local' | 'project';

/**
 * Transport protocol used by an MCP server definition.
 */
export type McpTransport = 'stdio' | 'http' | 'sse';

/**
 * Normalized MCP server model exposed to frontend and route handlers.
 *
 * Provider adapters should map provider-native config to this structure before
 * returning results.
 *
 * `command`/`args`/`env` describe a stdio server and `url`/`headers` an http or
 * sse one; between them they cover everything `ClaudeMcpProvider` can persist.
 * A `cwd`, an `envVars` list, a `bearerTokenEnvVar` and `envHttpHeaders` were
 * carried here too for Codex's config format — the route validated them and the
 * adapter then discarded them, so they are gone along with Codex.
 */
export type ProviderMcpServer = {
  provider: LLMProvider;
  name: string;
  scope: McpScope;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
};

/**
 * Payload for create/update MCP server operations.
 *
 * Routes and services should accept this type, validate it, and then persist it
 * through provider-specific MCP repositories.
 */
export type UpsertProviderMcpServerInput = {
  name: string;
  scope?: McpScope;
  transport: McpTransport;
  workspacePath?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
};

// ---------------------------
//----------------- PROVIDER AUTH TYPES ------------
/**
 * Authentication status result returned by provider health checks.
 *
 * This shape is consumed by settings/status endpoints to report installation and
 * credential state for each provider.
 */
export type ProviderAuthStatus = {
  installed: boolean;
  provider: LLMProvider;
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
};

// ---------------------------
//----------------- SHARED DATABASE CREDENTIAL TYPES ------------
/**
 * Safe credential view returned by credential listing APIs.
 *
 * This intentionally excludes the raw credential secret while still exposing
 * metadata needed for UI rendering and management operations.
 */
export type CredentialPublicRow = {
  id: number;
  credential_name: string;
  credential_type: string;
  description: string | null;
  created_at: string;
  is_active: number;
};

/**
 * Result returned after creating a credential record.
 *
 * Use this return shape when callers need the created id and display metadata,
 * but must never receive the stored secret value.
 */
export type CreateCredentialResult = {
  id: number | bigint;
  credentialName: string;
  credentialType: string;
};

// ---------------------------
//----------------- PROJECT PERSISTENCE TYPES ------------
/**
 * Canonical project row shape returned by the projects repository.
 *
 * Use this type whenever backend services need to pass around one database
 * project record without leaking raw SQL row typing across modules.
 */
export type ProjectRepositoryRow = {
  project_id: string;
  project_path: string;
  custom_project_name: string | null;
  isStarred: number;
  isArchived: number;
  /** NULL = unclaimed(仅 root,公共目录例外);具体 id = 个人项目。 */
  owner_user_id: number | null;
  /** 'public' = 显式公共(所有登录用户可见);NULL = 默认语义。 */
  visibility: string | null;
};

/** 项目可见性档位(创建时的三选)。 */
export type ProjectVisibilityChoice = 'personal' | 'public' | 'shared';

/**
 * Result category returned by `projectsDb.createProjectPath`.
 *
 * `created` means a fresh row was inserted, `reactivated_archived` means an
 * existing archived path was accepted and updated, and `active_conflict` means
 * an already-active path blocked project creation.
 */
export type CreateProjectPathOutcome =
  | 'created'
  | 'reactivated_archived'
  | 'active_conflict';

/**
 * Structured result returned by project-path upsert operations.
 *
 * Services should use this result to decide whether a request succeeded,
 * should return a conflict, or needs follow-up retrieval of row metadata.
 */
export type CreateProjectPathResult = {
  outcome: CreateProjectPathOutcome;
  project: ProjectRepositoryRow | null;
};

/**
 * Validation result for user-supplied workspace/project paths.
 *
 * `resolvedPath` is present only when validation succeeds. `error` is present
 * only when validation fails and is suitable for user-facing diagnostics.
 */
export type WorkspacePathValidationResult = {
  valid: boolean;
  resolvedPath?: string;
  error?: string;
};
