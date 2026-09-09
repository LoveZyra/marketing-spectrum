const USER_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- COLLATE NOCASE 是**安全属性**,不是便利属性。isRootUser() 拿小写后的用户名
    -- 去比对 PRISM_ROOT_USERS,而这一列若是默认的 BINARY 排序,'Alice' 与 'alice'
    -- 就能共存 —— 任何人注册一个大小写变体即可绕过注册审批并拿到 root。
    -- 放在列上而不是在某个查询里 lower(),是为了让 UNIQUE 和所有
    -- "WHERE username = ?" 共用同一个口径,不会有下一个查询漏掉它。
    -- (这段注释在模板字符串里,别用反引号。)
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
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

/**
 * F11:账号级界面偏好。
 *
 * 权限清单、项目排序、编辑器偏好此前**全在 localStorage** —— 换台电脑、换个浏览器
 * 或者清一次缓存,全部归零,而这些设置是用户一条条调出来的。这里给它们一个跟着
 * 账号走的家。
 *
 * 存成一个 JSON blob 而不是一行一个键:这些偏好只有"整份读、整份写"一种用法,
 * 拆成键值表除了让读写各多一次 JOIN 之外没有任何好处;而未来加一项偏好时,
 * blob 不需要迁移。
 */
export const USER_UI_SETTINGS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_ui_settings (
    user_id INTEGER PRIMARY KEY,
    settings_json TEXT NOT NULL,
    -- 客户端声明的最后修改时间(ISO)。同步时用它比新旧:离线改过的一侧不该被
    -- 另一侧的旧值覆盖。
    client_updated_at TEXT,
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

-- 定时任务的运行记录(cz 轮)。此前只有 scheduled_tasks 上的 last_run_* 四个单数列,
-- 每跑一次覆盖一次 —— 任务连着失败几回时,前几次的失败原因根本查不到。
-- 这里一次运行一行。trigger 是 SQLite 保留字,所以列名叫 trigger_kind。
CREATE TABLE IF NOT EXISTS scheduled_task_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    trigger_kind TEXT NOT NULL DEFAULT 'schedule',
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    detail TEXT,
    session_id TEXT
);

/*
 * fg:用量与费用台账。
 *
 * ## 为什么必须落库
 *
 * "total_cost_usd" 一直流到前端了,但**只活在浏览器内存里**,终点是 "/cost" 弹窗的
 * 一行。刷新就没,换台机器就没,更别说"这个月团队一共花了多少""哪个项目最贵"。
 * 审计报告的原话:这一步不做,这个产品永远答不出"值不值"。
 *
 * ## 为什么是独立一张表,不是给 sessions 加几列
 *
 * 一个会话有很多轮。加列的话只能存累计值,而且每轮都要 UPDATE 一遍 —— 既丢了
 * "哪一轮贵"的粒度,又在热路径上多一次写。独立表是纯 append,一轮一行,
 * 按天/按人/按项目聚合都是一句 GROUP BY。
 *
 * ## 冗余 username / project_path 是故意的
 *
 * 账要在**主体消失之后依然可读**:用户注销了、项目删了,"上个月谁花的钱"这个
 * 问题仍然要答得出。JOIN 到 users / projects 的话,这两张表一删,历史账就成了
 * 一串查不出名字的 id。这是账本类数据和业务表的根本区别。
 *
 * ## cost_usd 存的是**增量**,不是 SDK 给的那个数
 *
 * SDK 的 "total_cost_usd" 是**会话累计**(前端也是当"最新值覆盖"用的,不是累加)。
 * 直接一轮一行地存进来再 SUM,就是把第 N 轮的账算 N 遍。所以写入时算增量,
 * 见 "usage-records.db.ts" 里的 "costUsdCumulative" 处理。
 * 两个值都留:"cost_usd" 用来求和,"cost_usd_cumulative" 用来对账和查错。
 */
CREATE TABLE IF NOT EXISTS usage_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    project_path TEXT,
    user_id INTEGER,
    username TEXT,
    provider TEXT NOT NULL,
    model TEXT,
    -- chat(人点的)/ compact(自动压缩)/ task(定时任务)/ api(外部接口)。
    -- 同一笔账是谁跑出来的,决定了它该记在谁头上,也决定了"降本"该从哪儿下手 ——
    -- 压缩单列一档正是为此:"这个月为什么贵了"的答案很可能就是压缩跑得多。
    source TEXT NOT NULL DEFAULT 'chat',  -- chat / compact / task / api
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    cost_usd_cumulative REAL NOT NULL DEFAULT 0,
    duration_ms INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
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

-- fj:显示日志「还完不完整」的标记。
--
-- \`fetchHistory\` 的规则是"日志有行就完全改读日志、不再看 transcript",而
-- \`trimSession\` 会把超出上限的最早那批**物理删掉**。两条叠在一起 = 长会话的
-- 早期历史从界面永久消失(磁盘上的 jsonl 还在,应用再也不读)。这张表就是那条
-- 缺失的判据:裁过 = 日志不再是完整记录 = 回放必须回落 transcript。
--
-- 单独一张表而不是 \`sessions\` 上加一列,理由与上面那张表不建外键是同一条:
-- **显示日志可以早于 sessions 行存在**,标记跟着日志走才不会写进空气里。
CREATE TABLE IF NOT EXISTS session_display_log_state (
    session_id TEXT PRIMARY KEY,
    trimmed INTEGER NOT NULL DEFAULT 0
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

/**
 * **建表在这里,建索引不在这里。**
 *
 * `INIT_SCHEMA_SQL` 由 `initializeDatabase` 在 `runMigrations` **之前**用一句
 * `db.exec` 整体执行。`CREATE TABLE IF NOT EXISTS` 对老库是空操作 —— 也就是说这一步
 * 看到的表可能还是**迁移前的形状**,缺着后来才加的列。
 *
 * 于是"顺手在建表旁边建个索引"是一个反复出事的形状:索引引用了一个迁移才会补上的列,
 * 老库升级时 `db.exec` 整句抛(exec 非原子,前面的 DDL 已经落库了),
 * `initializeDatabase` 把异常往上抛 —— **服务起不来**,而且重启只会在同一处再炸。
 * projects / sessions / api_keys 三处都各自踩过一次,当时是逐个挪进迁移、留一行 NOTE。
 *
 * 这一轮把**全部**索引统一搬到 `INDEX_SCHEMA_SQL`,由迁移在最后执行(那时列一定齐了)。
 * 逐个挪治不了这个病:只要建索引还允许写在建表旁边,下一个人还会这么写。
 * 现在的规矩很简单 —— **这个常量里不许出现 CREATE INDEX**,有一条 schema 自检测试钉着。
 */
export const INIT_SCHEMA_SQL = `
-- Initialize authentication database
PRAGMA foreign_keys = ON;

${USER_TABLE_SCHEMA_SQL}

${API_KEYS_TABLE_SCHEMA_SQL}
-- NOTE: idx_api_keys_key / idx_api_keys_hash are created in migrations, after

${AUDIT_LOG_TABLE_SCHEMA_SQL}

${USER_CREDENTIALS_TABLE_SCHEMA_SQL}

${USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL}

${USER_UI_SETTINGS_TABLE_SCHEMA_SQL}

${PROJECTS_TABLE_SCHEMA_SQL}
-- NOTE: These indexes are created in migrations after legacy table-shape repairs.
-- Creating them here can fail on upgraded installs where projects lacks those columns.

${SESSIONS_TABLE_SCHEMA_SQL}
-- NOTE: This index is created in migrations after sessions is rebuilt to include project_path.
-- Creating it here can fail on upgraded installs where the legacy sessions table has no project_path.

${SESSION_DISPLAY_MESSAGES_TABLE_SCHEMA_SQL}

${ATTACHMENTS_TABLE_SCHEMA_SQL}

${LAST_SCANNED_AT_SQL}

${APP_CONFIG_TABLE_SCHEMA_SQL}

`;

/**
 * 所有索引。**由 `runMigrations` 在最后执行** —— 那时每张表的列一定齐了。
 *
 * 为什么不放回建表旁边:见 `INIT_SCHEMA_SQL` 上面那段注释。一句话是
 * INIT 跑在迁移之前,看到的可能是老库形状。
 */
export const INDEX_SCHEMA_SQL = `
-- users:username 上的 UNIQUE 已经生成隐式索引(sqlite_autoindex),不再重复建。
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);

-- api_keys:idx_api_keys_key / idx_api_keys_hash 仍在迁移里单独建 ——
-- 它们依赖 api_key_hash 列,而那列是迁移补的。
CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(is_active);

CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_event ON audit_log(event);

CREATE INDEX IF NOT EXISTS idx_user_credentials_user_id ON user_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_user_credentials_type ON user_credentials(credential_type);
CREATE INDEX IF NOT EXISTS idx_user_credentials_active ON user_credentials(is_active);

-- user_notification_preferences.user_id 是 INTEGER PRIMARY KEY(rowid 别名),
-- 再建索引是纯写开销,没有读收益。

-- sessions.session_id 是 PRIMARY KEY,同样已有隐式索引。
CREATE INDEX IF NOT EXISTS idx_sessions_provider_session_id ON sessions(provider_session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_project_path ON sessions(project_path);
CREATE INDEX IF NOT EXISTS idx_sessions_is_archived ON sessions(isArchived);
-- 归档面板:过滤 + 排序 + 分页一条索引吃下。原来只有 isArchived,排序一律走
-- TEMP B-TREE(表达式排序),一万条归档会话之后每翻一页都要重排一次。
CREATE INDEX IF NOT EXISTS idx_sessions_archived_recent
  ON sessions(isArchived, datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC);

-- 按会话 + 追加顺序取页,回放的唯一查询路径
CREATE INDEX IF NOT EXISTS idx_display_messages_session_id ON session_display_messages(session_id, id);

CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due ON scheduled_tasks(enabled, next_run_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_owner ON scheduled_tasks(owner_user_id);
-- 详情页永远是「这个任务的最近 N 条」,倒序取,所以按 (task_id, id DESC) 建。
CREATE INDEX IF NOT EXISTS idx_task_runs_task ON scheduled_task_runs(task_id, id DESC);

-- fg:用量台账的三条聚合路径。
-- 按时间倒序翻页(总账页)、按人按时间(个人账单)、按会话(会话详情里的那一行)。
CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_records(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_usage_user_created ON usage_records(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_records(session_id, id DESC);

-- 配额按用户求和,清理按时间扫 —— 两条查询各一个索引
CREATE INDEX IF NOT EXISTS idx_attachments_user_id ON attachments(user_id);
CREATE INDEX IF NOT EXISTS idx_attachments_created_at ON attachments(created_at);
`;

/**
 * 已经没用了、但老库里还躺着的索引 —— 由迁移显式 DROP。
 *
 * `CREATE INDEX IF NOT EXISTS` 只管建,不管删;上面那几条从清单里去掉之后,
 * 老库里的旧索引会一直留着白吃写开销(sessions 上实测约 15%)。
 */
export const RETIRED_INDEXES = [
  // 与 PRIMARY KEY (session_id) 生成的 sqlite_autoindex 逐字重复
  'idx_session_ids_lookup',
  // 与 username 的 UNIQUE 隐式索引重复
  'idx_users_username',
  // user_id 是 INTEGER PRIMARY KEY(rowid 别名),索引没有读收益
  'idx_user_notification_preferences_user_id',
  // 迁移里加这两条时说是为了让 getProjectPaths(visibleTo) 不再线性扫,
  // 但那条查询的 OR 里有一支是 IN(子查询),SQLite 直接放弃多索引 OR ——
  // 计划实测始终是 SCAN projects,两条索引从来没被用过。
  'idx_projects_owner',
  'idx_projects_visibility',
] as const;


