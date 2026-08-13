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
    -- Owner. NULL means public: visible to everyone. This is a tidiness
    -- boundary, not a security one — see the spec doc; project-level routes
    -- deliberately do not check it.
    owner_user_id INTEGER
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

export const LAST_SCANNED_AT_SQL = `
CREATE TABLE IF NOT EXISTS scan_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_scanned_at TIMESTAMP NULL
);
`;

/**
 * Published static pages.
 *
 * Stores a *reference* to a workspace path, never a copy of the bytes: the
 * public route reads the file live, so editing it and refreshing the browser is
 * the whole of "republishing". The UNIQUE on (project_id, rel_path) is what
 * makes re-publishing idempotent and keeps an already-shared URL working.
 */
export const PUBLISHED_PAGES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS published_pages (
    id TEXT PRIMARY KEY NOT NULL,
    token TEXT UNIQUE NOT NULL,
    project_id TEXT NOT NULL,
    rel_path TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'file',   -- file | folder
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(project_id, rel_path)
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

${LAST_SCANNED_AT_SQL}

${APP_CONFIG_TABLE_SCHEMA_SQL}

${PUBLISHED_PAGES_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_published_pages_project ON published_pages(project_id);
`;
