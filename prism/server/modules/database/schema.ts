const USER_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME,
    is_active BOOLEAN DEFAULT 1,
    git_name TEXT,
    git_email TEXT,
    has_completed_onboarding BOOLEAN DEFAULT 0,
    -- Bumped on logout-everywhere and password change. Tokens carry the value
    -- they were minted with; a mismatch invalidates them without a blocklist.
    token_version INTEGER NOT NULL DEFAULT 0,
    -- Registration approval. DEFAULT 'approved' is load-bearing: every account
    -- that existed before this column keeps logging in untouched. Only rows
    -- written by /auth/register after this change start out 'pending'.
    approval_status TEXT NOT NULL DEFAULT 'approved',   -- pending|approved|rejected
    approved_at DATETIME,
    reviewed_by INTEGER                                 -- reviewer's user id, for the trail
);
`;

export const API_KEYS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    key_name TEXT NOT NULL,
    -- Legacy plaintext column. Kept nullable for upgraded installs; new keys
    -- write NULL here and store only the hash + display prefix.
    api_key TEXT UNIQUE,
    -- SHA-256 of the key. Lookups hit this, so a database leak yields no
    -- usable credentials.
    api_key_hash TEXT UNIQUE,
    -- First few characters ("ck_1a2b…") so the UI can identify a key it can
    -- no longer display in full.
    api_key_prefix TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_used DATETIME,
    is_active BOOLEAN DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const AUDIT_LOG_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT,
    event TEXT NOT NULL,
    outcome TEXT NOT NULL DEFAULT 'success',
    ip TEXT,
    user_agent TEXT,
    detail TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

export const USER_CREDENTIALS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    credential_name TEXT NOT NULL,
    credential_type TEXT NOT NULL, -- 'github_token', 'gitlab_token', 'bitbucket_token', etc.
    credential_value TEXT NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_notification_preferences (
    user_id INTEGER PRIMARY KEY,
    preferences_json TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const PROJECTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
    project_id TEXT PRIMARY KEY NOT NULL,
    project_path TEXT NOT NULL UNIQUE,
    custom_project_name TEXT DEFAULT NULL,
    isStarred BOOLEAN DEFAULT 0,
    isArchived BOOLEAN DEFAULT 0,
    -- Owner. NULL = unclaimed(仅 root,公共目录例外);具体 id = 个人项目。
    owner_user_id INTEGER,
    -- 显式可见性:'public' = 对所有登录用户可见(创建时选"公共")。
    -- NULL = 默认语义(个人/无主按 owner_user_id 走)。指定用户授权见 project_shares。
    visibility TEXT DEFAULT NULL
);
`;

/**
 * 指定用户授权:一行 = "把 project_id 开放给 user_id"。
 * 创建项目选「指定用户」时写入;可见性判定(JS 与 SQL 两侧)都会查这张表。
 */
export const PROJECT_SHARES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS project_shares (
    project_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    granted_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, user_id),
    FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
);
`;

/**
 * 按用户隔离的项目收藏。老的 projects.isStarred 是全局一份 —— 任何人收藏,
 * root(以及共享/公共项目的其他可见者)看到的都是"已收藏"。这张表把收藏
 * 变成 (project, user) 维度;旧列保留不再作为权威(平台模式无用户时仍回退它)。
 */
export const PROJECT_STARS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS project_stars (
    project_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, user_id),
    FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
);
`;

export const SESSIONS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'claude',
    -- The session id used by the provider CLI/SDK on disk (JSONL file name,
    -- store.db folder, sqlite row id, ...). \`session_id\` is the stable
    -- app-facing id that the frontend uses for the whole session lifetime;
    -- \`provider_session_id\` is filled in once the provider announces its own
    -- id mid-run, or equals \`session_id\` for sessions discovered on disk.
    provider_session_id TEXT,
    custom_name TEXT,
    project_path TEXT,
    jsonl_path TEXT,
    isArchived BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id),
    FOREIGN KEY (project_path) REFERENCES projects(project_path)
    ON DELETE SET NULL
    ON UPDATE CASCADE
);
`;

/**
 * 「给人看的对话日志」——与 CLI 的 JSONL transcript **完全解耦**。
 *
 * ## 为什么要有这张表
 *
 * 在此之前,聊天界面是**回放** CLI 写在 `~/.claude/projects` 下的 JSONL transcript
 * 得到的。那份文件是
 * **模型的记忆**,不是对话记录:里面混着子代理的整段 sidechain、`isMeta` 的图片
 * 尺寸说明、技能正文注入、压缩摘要、各种机器耳语。拿它当显示模型,等于把
 * "CLI 内部怎么记账"直接暴露成"用户看到了什么" —— CLI 每加一种内部行,界面就漏一次
 * (`transcript-provenance.ts` 那一长串判据就是这么攒出来的)。
 *
 * 这张表反过来:**推给前端的每一条消息,原样存一份**。以后 transcript 只用于
 * 重建与审计,不再直接决定界面。
 *
 * `payload` 存整条 NormalizedMessage 的 JSON —— 前端本来就消费这个结构,
 * 回放时不需要再解析、再归一化,也就没有"再判一次出处"的机会。
 *
 * 没有对 `sessions` 建外键:新会话的第一条消息可能早于 sessions 行落库,
 * 外键会让那一条直接写不进去。清理走 `deleteForSession()` 显式调用。
 */
export const SESSION_DISPLAY_MESSAGES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    instructions TEXT NOT NULL,
    project_path TEXT NOT NULL,
    session_mode TEXT NOT NULL DEFAULT 'fixed',
    fixed_session_id TEXT,
    frequency TEXT NOT NULL DEFAULT 'manual',
    run_at_hour INTEGER,
    run_at_minute INTEGER,
    run_at_weekday INTEGER,
    run_at_day INTEGER,
    model TEXT,
    permission_mode TEXT NOT NULL DEFAULT 'bypassPermissions',
    enabled INTEGER NOT NULL DEFAULT 1,
    owner_user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    next_run_at TEXT,
    last_run_at TEXT,
    last_run_status TEXT,
    last_run_detail TEXT,
    last_run_duration_ms INTEGER,
    running INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS session_display_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    payload TEXT NOT NULL,
    UNIQUE (session_id, message_id)
);
`;

/**
 * 聊天附件台账。
 *
 * 附件本体写在**会话所属项目的工作目录**下的 `attachments/`(没有项目时回落到
 * 全局目录),这张表只记"谁、什么时候、传了哪个文件、多大" —— 配额和过期清理
 * 都只认这张表。
 *
 * 为什么必须有台账、不能直接扫目录:`attachments/` 在文件树里是明放的,用户
 * 自己也会往里放东西。**清理只删这张表记过的文件**,用户手工放进去的一个字节
 * 都不碰 —— 扫目录做不到这个区分。
 *
 * `abs_path` 唯一:同一个文件不会记两笔;文件被用户手工删掉时,清扫器把这一行
 * 一并收走(见 attachments.db.ts 的 sweepExpired)。
 *
 * 没有对 `users` 建外键:用户删除时附件该怎么处理是另一件事,不该让台账写入
 * 依赖用户行还在。
 */
export const ATTACHMENTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    session_id TEXT,
    project_path TEXT,
    kind TEXT NOT NULL,
    abs_path TEXT NOT NULL UNIQUE,
    bytes INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

export const LAST_SCANNED_AT_SQL = `
CREATE TABLE IF NOT EXISTS scan_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_scanned_at TIMESTAMP NULL
);
`;


export const APP_CONFIG_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

export const INIT_SCHEMA_SQL = `
-- Initialize authentication database
PRAGMA foreign_keys = ON;

${USER_TABLE_SCHEMA_SQL}
-- Indexes for performance for user lookups
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);

${API_KEYS_TABLE_SCHEMA_SQL}
-- NOTE: idx_api_keys_key / idx_api_keys_hash are created in migrations, after
-- the api_key_hash column exists on upgraded installs.
CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(is_active);

${AUDIT_LOG_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_event ON audit_log(event);

${USER_CREDENTIALS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_user_credentials_user_id ON user_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_user_credentials_type ON user_credentials(credential_type);
CREATE INDEX IF NOT EXISTS idx_user_credentials_active ON user_credentials(is_active);

${USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_user_notification_preferences_user_id ON user_notification_preferences(user_id);

${PROJECTS_TABLE_SCHEMA_SQL}
-- NOTE: These indexes are created in migrations after legacy table-shape repairs.
-- Creating them here can fail on upgraded installs where projects lacks those columns.

${SESSIONS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_session_ids_lookup ON sessions(session_id);
-- NOTE: This index is created in migrations after sessions is rebuilt to include project_path.
-- Creating it here can fail on upgraded installs where the legacy sessions table has no project_path.

${SESSION_DISPLAY_MESSAGES_TABLE_SCHEMA_SQL}
-- 按会话 + 追加顺序取页,回放的唯一查询路径
CREATE INDEX IF NOT EXISTS idx_display_messages_session_id ON session_display_messages(session_id, id);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due ON scheduled_tasks(enabled, next_run_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_owner ON scheduled_tasks(owner_user_id);

${ATTACHMENTS_TABLE_SCHEMA_SQL}
-- 配额按用户求和,清理按时间扫 —— 两条查询各一个索引
CREATE INDEX IF NOT EXISTS idx_attachments_user_id ON attachments(user_id);
CREATE INDEX IF NOT EXISTS idx_attachments_created_at ON attachments(created_at);

${LAST_SCANNED_AT_SQL}

${APP_CONFIG_TABLE_SCHEMA_SQL}

`;
