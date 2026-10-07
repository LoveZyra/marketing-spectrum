const USER_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- COLLATE NOCASE 是安全属性,不是便利属性。isRootUser() 拿小写后的用户名
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
    -- Registration approval. DEFAULT 'approved' is load-bearing: when an older
    -- database gains this column, every account already in it keeps logging in
    -- untouched. Only /auth/register writes 'pending' (when approval is required).
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
    -- 签发这把 key 时 users.token_version 的值。退出所有设备 / 改密 /
    -- 重置密码 / 停用都会递增 users.token_version,校验时两者不等即作废 ——
    -- 与 JWT、WS 票据同一套失效机制。老库里迁移前签发的 key 为 NULL,由迁移回填。
    token_version INTEGER,
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
    -- 这条记录是对谁做的(被删会话所属项目的 owner)。非 root 在审计页看得到
    -- "我做的 OR 对我做的" —— 会话被删的人也要能查到是谁删的。
    -- 老库由迁移补列(可空,加列即可)。
    target_user_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

/**
 * 最近删除(会话回收站)。
 *
 * 删除会话不直接 DELETE:`sessions` 行、显示日志、`session_display_log_state`
 * 整体搬进这两张表,transcript 与它的 `<id>/` 目录搬到 `<数据目录>/trash/` 下;
 * 保留期(`PRISM_TRASH_RETENTION_DAYS`,默认 30 天)内可以原样恢复,超期由清扫器真删。
 *
 * 为什么是另两张表而不是在 `sessions` 上加一列 `deleted_at`:
 * 活表上每一条查询(侧栏、搜索、可见性、监视器合并……)都得学会过滤这一列,
 * 漏一处就是"已删除的会话又出现了";搬进别的表,活表上的查询一条都不用改。
 *
 * `session_trash_messages.id` 保留原 `session_display_messages.id`(AUTOINCREMENT
 * 的 id 不会被重用),恢复时按原 id 写回,顺序、分叉锚点全部与删除前一致。
 */
export const SESSION_TRASH_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS session_trash (
    session_id TEXT PRIMARY KEY NOT NULL,
    provider TEXT NOT NULL DEFAULT 'claude',
    provider_session_id TEXT,
    custom_name TEXT,
    project_path TEXT,
    -- 项目行在删项目时会一起没了;恢复要能把它按原样建回来。
    project_id TEXT,
    project_display_name TEXT,
    project_owner_user_id INTEGER,
    project_visibility TEXT,
    jsonl_path TEXT,
    trash_jsonl_path TEXT,
    trash_dir_path TEXT,
    isArchived INTEGER NOT NULL DEFAULT 0,
    display_log_trimmed INTEGER NOT NULL DEFAULT 0,
    message_count INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME,
    updated_at DATETIME,
    deleted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_by_user_id INTEGER,
    deleted_by_username TEXT,
    -- session | bulk | empty_archived | project | retention | api
    deleted_via TEXT NOT NULL DEFAULT 'session'
);

CREATE TABLE IF NOT EXISTS session_trash_messages (
    id INTEGER PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    payload TEXT NOT NULL,
    provider_assistant_uuid TEXT,
    UNIQUE (session_id, message_id)
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
 * 账号级界面偏好(权限清单、项目排序、编辑器偏好)。
 *
 * 跟着账号存在服务端:只放 localStorage 的话,换台电脑、换个浏览器或清一次缓存就全部归零,
 * 而这些设置是用户一条条调出来的。
 *
 * 存成一个 JSON blob 而不是一行一个键:这些偏好只有"整份读、整份写"一种用法,
 * 拆成键值表没有任何好处;以后加一项偏好时,blob 也不需要迁移。
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
 * 按用户隔离的项目收藏,(project, user) 维度。projects.isStarred 是全局一份 ——
 * 任何人收藏,所有可见者看到的都是"已收藏" —— 所以不再作为权威,
 * 只在平台模式没有用户时回退使用。
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
    -- 归档那一刻;未归档为 NULL。归档保留期从它与最后活动时间中较晚的那个起算。
    archived_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id),
    FOREIGN KEY (project_path) REFERENCES projects(project_path)
    ON DELETE SET NULL
    ON UPDATE CASCADE
);
`;

/**
 * 定时任务(scheduled_tasks / scheduled_task_runs)、用量台账(usage_records)与
 * 显示日志(session_display_messages / session_display_log_state)的建表语句。
 *
 * 显示日志是「给人看的对话日志」,与 CLI 的 JSONL transcript 完全解耦。transcript
 * (`~/.claude/projects` 下)是模型的记忆,不是对话记录:里面混着子代理的整段 sidechain、
 * `isMeta` 的图片尺寸说明、技能正文注入、压缩摘要等机器内容;拿它当显示模型,
 * CLI 每加一种内部行,界面就漏一次(见 `transcript-provenance.ts` 那一长串判据)。
 * 所以推给前端的每一条消息原样存一份,transcript 只用于重建与审计,不直接决定界面。
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

-- 定时任务的运行记录,一次运行一行。scheduled_tasks 上的 last_run_* 四列只存最近一次,
-- 每跑一次覆盖一次 —— 任务连着失败几回时,前几次的失败原因要从这张表查。
-- trigger 是 SQLite 保留字,所以列名叫 trigger_kind。
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
 * 用量与费用台账。
 *
 * ## 为什么必须落库
 *
 * "total_cost_usd" 会推到前端,但只在浏览器内存里的话,刷新就没、换台机器就没,
 * 更答不了"这个月团队一共花了多少""哪个项目最贵",也就答不出"值不值"。
 *
 * ## 为什么是独立一张表,不是给 sessions 加几列
 *
 * 一个会话有很多轮。加列的话只能存累计值,而且每轮都要 UPDATE 一遍 —— 既丢了
 * "哪一轮贵"的粒度,又在热路径上多一次写。独立表是纯 append,一轮一行,
 * 按天/按人/按项目聚合都是一句 GROUP BY。
 *
 * ## 冗余 username / project_path 是故意的
 *
 * 账要在主体消失之后依然可读:用户注销了、项目删了,"上个月谁花的钱"这个
 * 问题仍然要答得出。JOIN 到 users / projects 的话,这两张表一删,历史账就成了
 * 一串查不出名字的 id。这是账本类数据和业务表的根本区别。
 *
 * ## cost_usd 存的是增量,不是 SDK 给的那个数
 *
 * SDK 的 "total_cost_usd" 是会话累计(前端也是当"最新值覆盖"用的,不是累加)。
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
    -- chat(人点的)/ task(定时任务)/ api(外部接口)/ background(CLI 自己发起的回合,
    -- 比如后台任务跑完回报的那一轮)。同一笔账是谁跑出来的,决定了它该记在谁头上,
    -- 也决定了"降本"该从哪儿下手。compact(独立的压缩回合)只出现在老库的历史行里:
    -- 压缩在用户回合内由 CLI 完成,账记在那一轮的来源下。没有 CHECK 约束,加来源不用迁移。
    source TEXT NOT NULL DEFAULT 'chat',  -- chat / task / api / background(历史行还有 compact)
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
    -- 这一行自己的原生 assistant uuid,「编辑重跑」的分叉锚点。
    -- 只有 assistant 侧的行有值(见 server/shared/fork-anchor.ts):非空 =
    -- 可以直接拿去 SDK 的 resumeSessionAt。老库由迁移补列,历史行为 NULL,
    -- 端点对它们回落到扫 jsonl。
    provider_assistant_uuid TEXT,
    UNIQUE (session_id, message_id)
);

-- 显示日志「还完不完整」的标记。
--
-- \`fetchHistory\` 的规则是"日志有行就完全改读日志、不再看 transcript",而
-- \`trimSession\` 会把超出上限的最早那批物理删掉。两条叠在一起,没有这个标记的话
-- 长会话的早期历史会从界面永久消失(磁盘上的 jsonl 还在,应用不会再读)。这张表
-- 记的就是这条判据:裁过 = 日志不再是完整记录 = 回放必须回落 transcript。
--
-- 单独一张表而不是 \`sessions\` 上加一列,理由与上面那张表不建外键是同一条:
-- 显示日志可以早于 sessions 行存在,标记跟着日志走才不会写进空气里。
CREATE TABLE IF NOT EXISTS session_display_log_state (
    session_id TEXT PRIMARY KEY,
    trimmed INTEGER NOT NULL DEFAULT 0
);
`;

/**
 * 用户对助手回答的反馈 —— 赞 / 踩(`source='vote'`)与「调过 skill 的回合结束后
 * 抽样问一句效果如何」的调查卡(`source='survey'`)。两者写同一张表、同一行:一人对
 * 一条回答只有一份意见,后来的覆盖先来的。
 *
 * 这是技能优化(SkillWhet)的数据源,但它记的是"用户怎么评价这条回答",不是
 * 优化状态 —— 哪天技能优化撤掉,这份数据照样有用,所以它进 SQLite 而优化状态不进。
 *
 * `message_id` 是显示日志里的 app 消息 id(assistant 正文是 `<uuid>_text`,稳定、
 * 刷新不变);`message_uuid` 是从它反推的原生 uuid(`nativeUuidFromMessageId`),
 * 供 harvest 按转录 uuid 对齐。`verdict`:+1 好 / 0 一般 / -1 差;调查卡
 * 「跳过」时为 NULL、`status='dismissed'`,留着算响应率,不进训练。
 */
export const MESSAGE_FEEDBACK_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS message_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    project_id TEXT,
    message_id TEXT NOT NULL,
    message_uuid TEXT,
    user_id INTEGER NOT NULL,
    source TEXT NOT NULL DEFAULT 'vote',
    verdict INTEGER,
    status TEXT NOT NULL DEFAULT 'answered',
    category TEXT,
    note TEXT,
    expected_output TEXT,
    skill_hint TEXT,
    task_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (message_id, user_id)
);
`;

/**
 * 技能优化的夜训计划 —— root 逐个「纳入夜训」的决定(默认一个都不纳入)。
 *
 * 和 `message_feedback` 一样,这是"人的决定",所以进 SQLite;训练本身的状态
 * (作业、进度、staging、checkpoint)仍只在 SkillWhet 的 home 里。
 *
 * - `window_start` / `window_end`:服务器本地时间 `HH:MM`,可跨零点(22:00–06:00);
 * - `max_cost_usd`:这个 skill 单次夜训的费用上限,NULL = 沿用 `PRISM_SKILLWHET_MAX_COST_USD`;
 *   一晚所有 skill 合计另有 `PRISM_SKILLWHET_NIGHTLY_MAX_COST_USD`;
 * - `config_json`:runner / 三个角色的模型等训练参数(与新建训练表单同一套键);
 * - `min_new_tasks`:自上次夜训起新进库的可判分任务少于它就跳过;
 * - `last_night`:最近一次被调度器处理过的那一晚(`YYYY-MM-DD`;一晚 = 当天中午到次日中午,记当天),一晚只处理一次;
 * - `copy_id`:纳入时副本的身份(来源 | 上传者 | 导入时间)。副本被移除 / 重新上传 / 重新导入后对不上,
 *   调度器不跑它、自动移出 —— root 批准的是那一份副本,不是这个名字;
 * - `last_result`:`running | improved | unchanged | no_candidate | budget | skipped_no_new_tasks |
 *   skipped_busy | deferred_budget | interrupted | cancelled | error`;
 * - `consecutive_noop`:连续几晚跑了却没收益;到 NIGHTLY_AUTOPAUSE_AFTER(3)自动 `enrolled=0`
 *   并记 `auto_paused_at`。
 */
export const SKILLWHET_NIGHTLY_PLAN_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS skillwhet_nightly_plan (
    skill_name TEXT PRIMARY KEY,
    enrolled INTEGER NOT NULL DEFAULT 0,
    window_start TEXT NOT NULL DEFAULT '02:00',
    window_end TEXT NOT NULL DEFAULT '06:00',
    max_cost_usd REAL,
    rounds INTEGER NOT NULL DEFAULT 2,
    config_json TEXT,
    min_new_tasks INTEGER NOT NULL DEFAULT 5,
    copy_id TEXT,
    last_night TEXT,
    last_run_at DATETIME,
    last_job_id TEXT,
    last_result TEXT,
    last_detail TEXT,
    consecutive_noop INTEGER NOT NULL DEFAULT 0,
    auto_paused_at DATETIME,
    updated_by INTEGER,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

/**
 * 聊天附件台账。
 *
 * 附件本体写在会话所属项目的工作目录下的 `attachments/`(没有项目时回落到
 * 全局目录),这张表只记"谁、什么时候、传了哪个文件、多大" —— 配额和过期清理
 * 都只认这张表。
 *
 * 为什么必须有台账、不能直接扫目录:`attachments/` 在文件树里是明放的,用户
 * 自己也会往里放东西。清理只删这张表记过的文件,用户手工放进去的一个字节
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


/**
 * 模型目录:选择器里列哪些网关模型、各自的窗口与档位。
 *
 * - `model_id`:网关上的名字,原样传给 SDK。≤ 80 字符,字母数字开头(字符集见 shared/modelVendors.ts);
 * - `vendor`:图标与分组;NULL = 按 model_id 自动识别;
 * - `context_window`:NULL = 不设(非 Claude 名 CLI 按 200000);有值 ≥ 100000(CLI 的 autoCompactWindow 下限);
 * - `effort_levels`:JSON 数组;NULL = 不出档位选择;
 * - `is_default`:新会话默认选中,最多一条(INDEX_SCHEMA_SQL 里的部分唯一索引);
 * - `last_probe`:最近一次「实测」的结果 JSON;
 * - `gateway_id`:走哪个网关;NULL = settings.json 那一套(网关 0);
 * - `allowed_users`:可用人员,用户 id 的 JSON 数组;NULL = 所有人。
 */
export const MODEL_CATALOG_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS model_catalog (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    vendor TEXT,
    description TEXT,
    context_window INTEGER,
    effort_levels TEXT,
    effort_default TEXT,
    recommended INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    is_default INTEGER NOT NULL DEFAULT 0,
    last_probe TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER,
    gateway_id INTEGER,
    allowed_users TEXT
);
`;

/**
 * 模型网关 —— 除了 settings.json 那一套(网关 id 0,不进这张表)之外的网关。
 *
 * - `owner_user_id`:NULL = 共享网关(root 管,目录条目可以挂上来);有值 = 这个人的私有网关,
 *   只有他自己看得到、只能挂他自己的私有模型(`user_models`);
 * - `auth_type`:`bearer` → `ANTHROPIC_AUTH_TOKEN`(Authorization: Bearer);`x-api-key` → `ANTHROPIC_API_KEY`;
 * - `default_key`:网关的默认 key(AES-256-GCM 密文,见 shared/crypto-box.js);私有网关的 key 就存在这里。
 *   NULL = 没有默认 key —— 只有填了个人 key 的人能用这个网关上的模型。
 *
 * 纯加表:回滚到没有这张表的版本时,它留在库里没人读,无害。
 */
export const MODEL_GATEWAYS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS model_gateways (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    auth_type TEXT NOT NULL DEFAULT 'bearer',
    default_key TEXT,
    default_key_last4 TEXT,
    owner_user_id INTEGER,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by INTEGER,
    FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

/**
 * 个人 key —— 某个人在某个网关上用自己的 key(本人填,或 root 代填,`set_by` 记是谁填的)。
 * `gateway_id = 0` 指 settings.json 那一套默认网关。值是密文;`key_last4` 只给界面认 key 用。
 * 唯一索引 (gateway_id, user_id) 在 INDEX_SCHEMA_SQL 里。
 */
export const GATEWAY_USER_KEYS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS gateway_user_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gateway_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    key_enc TEXT NOT NULL,
    key_last4 TEXT,
    set_by INTEGER,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

/**
 * 私有模型 —— 挂在本人私有网关上的模型,只有本人看得到、用得了。字段与 `model_catalog` 同义
 * (没有推荐 / 默认 / 可用人员这些面向全员的字段)。唯一索引 (user_id, model_id) 在 INDEX_SCHEMA_SQL 里。
 */
export const USER_MODELS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    gateway_id INTEGER NOT NULL,
    model_id TEXT NOT NULL,
    label TEXT NOT NULL,
    vendor TEXT,
    context_window INTEGER,
    effort_levels TEXT,
    effort_default TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

/**
 * 每模型回合健康度(首字延迟 / 失败率 / 失败原因)。每个用户回合一行,保留 30 天。
 * 纯加表:回滚到没有这张表的版本时,它留在库里没人读,无害。
 */
export const MODEL_TURN_STATS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS model_turn_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'chat',
    is_error INTEGER NOT NULL DEFAULT 0,
    terminal_reason TEXT,
    ttft_ms INTEGER,
    duration_ms INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
 * 建表在这里,建索引不在这里。
 *
 * `INIT_SCHEMA_SQL` 由 `initializeDatabase` 在 `runMigrations` 之前用一句
 * `db.exec` 整体执行。`CREATE TABLE IF NOT EXISTS` 对老库是空操作 —— 这一步
 * 看到的表可能还是迁移前的形状,缺着迁移才补的列。
 *
 * 若在建表旁边建索引、而索引引用了这种列,老库升级时 `db.exec` 整句抛(exec 非原子,
 * 前面的 DDL 已经落库),`initializeDatabase` 把异常往上抛 —— 服务起不来,
 * 重启也只会在同一处再炸。
 *
 * 所以全部索引都在 `INDEX_SCHEMA_SQL` 里,由迁移在末尾执行(那时列一定齐了)。
 * 这个常量里不许出现 CREATE INDEX,有一条 schema 自检测试钉着。
 */
export const INIT_SCHEMA_SQL = `
-- Initialize authentication database
PRAGMA foreign_keys = ON;

${USER_TABLE_SCHEMA_SQL}

${API_KEYS_TABLE_SCHEMA_SQL}
-- NOTE: idx_api_keys_key / idx_api_keys_hash are created in migrations, after
-- the migration that adds the api_key_hash column.

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

${SESSION_TRASH_TABLE_SCHEMA_SQL}

${ATTACHMENTS_TABLE_SCHEMA_SQL}

${MESSAGE_FEEDBACK_TABLE_SCHEMA_SQL}

${SKILLWHET_NIGHTLY_PLAN_TABLE_SCHEMA_SQL}

${MODEL_CATALOG_TABLE_SCHEMA_SQL}

${MODEL_TURN_STATS_TABLE_SCHEMA_SQL}

${MODEL_GATEWAYS_TABLE_SCHEMA_SQL}

${GATEWAY_USER_KEYS_TABLE_SCHEMA_SQL}

${USER_MODELS_TABLE_SCHEMA_SQL}

${LAST_SCANNED_AT_SQL}

${APP_CONFIG_TABLE_SCHEMA_SQL}

`;

/**
 * 所有索引,由 `runMigrations` 在末尾执行 —— 那时每张表的列一定齐了。
 *
 * 为什么不放在建表旁边:见 `INIT_SCHEMA_SQL` 上面那段注释。一句话是
 * INIT 跑在迁移之前,看到的可能是老库形状。
 */
export const INDEX_SCHEMA_SQL = `
-- users:username 上的 UNIQUE 已经生成隐式索引(sqlite_autoindex),不另建。
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);

-- api_keys:idx_api_keys_key / idx_api_keys_hash 在迁移里单独建 ——
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
-- 归档面板:过滤 + 排序 + 分页一条索引吃下。只有 isArchived 的索引时排序一律走
-- TEMP B-TREE(表达式排序),一万条归档会话之后每翻一页都要重排一次。
CREATE INDEX IF NOT EXISTS idx_sessions_archived_recent
  ON sessions(isArchived, datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC);

-- 按会话 + 追加顺序取页,回放的唯一查询路径
CREATE INDEX IF NOT EXISTS idx_display_messages_session_id ON session_display_messages(session_id, id);

-- 最近删除 —— 列表与清扫都按删除时间扫,监视器按 provider id 查"是不是在回收站里"。
CREATE INDEX IF NOT EXISTS idx_session_trash_deleted_at ON session_trash(deleted_at);
CREATE INDEX IF NOT EXISTS idx_session_trash_provider_session_id ON session_trash(provider_session_id);
CREATE INDEX IF NOT EXISTS idx_session_trash_messages_session ON session_trash_messages(session_id, id);
-- 审计"对我做的"那一支
CREATE INDEX IF NOT EXISTS idx_audit_log_target_user_id ON audit_log(target_user_id);

CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due ON scheduled_tasks(enabled, next_run_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_owner ON scheduled_tasks(owner_user_id);
-- 详情页永远是「这个任务的最近 N 条」,倒序取,所以按 (task_id, id DESC) 建。
CREATE INDEX IF NOT EXISTS idx_task_runs_task ON scheduled_task_runs(task_id, id DESC);

CREATE INDEX IF NOT EXISTS idx_message_feedback_skill ON message_feedback(skill_hint, status);
CREATE INDEX IF NOT EXISTS idx_message_feedback_session ON message_feedback(session_id);
CREATE INDEX IF NOT EXISTS idx_message_feedback_user_skill ON message_feedback(user_id, skill_hint, updated_at);

-- 用量台账的三条聚合路径。
-- 按时间倒序翻页(总账页)、按人按时间(个人账单)、按会话(会话详情里的那一行)。
CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_records(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_usage_user_created ON usage_records(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_records(session_id, id DESC);

-- 配额按用户求和,清理按时间扫 —— 两条查询各一个索引
CREATE INDEX IF NOT EXISTS idx_attachments_user_id ON attachments(user_id);
CREATE INDEX IF NOT EXISTS idx_attachments_created_at ON attachments(created_at);

-- 模型目录 —— 默认模型最多一条(部分唯一索引),列表按上架 + 排序取。
CREATE UNIQUE INDEX IF NOT EXISTS idx_model_catalog_single_default ON model_catalog(is_default) WHERE is_default = 1;
CREATE INDEX IF NOT EXISTS idx_model_catalog_enabled_order ON model_catalog(enabled, sort_order, id);

-- 网关 / 个人 key / 私有模型
CREATE INDEX IF NOT EXISTS idx_model_gateways_owner ON model_gateways(owner_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gateway_user_keys_unique ON gateway_user_keys(gateway_id, user_id);
CREATE INDEX IF NOT EXISTS idx_gateway_user_keys_user ON gateway_user_keys(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_models_unique ON user_models(user_id, model_id);

-- 每模型回合健康度 —— 按时间窗汇总、按时间清理。
CREATE INDEX IF NOT EXISTS idx_model_turn_stats_created ON model_turn_stats(created_at);
`;

/**
 * 已经没用了、但老库里还躺着的索引 —— 由迁移显式 DROP。
 *
 * `CREATE INDEX IF NOT EXISTS` 只管建,不管删;从 INDEX_SCHEMA_SQL 里去掉的索引,
 * 在老库里会一直留着白吃写开销(sessions 上约 15%)。
 */
export const RETIRED_INDEXES = [
  // 与 PRIMARY KEY (session_id) 生成的 sqlite_autoindex 逐字重复
  'idx_session_ids_lookup',
  // 与 username 的 UNIQUE 隐式索引重复
  'idx_users_username',
  // user_id 是 INTEGER PRIMARY KEY(rowid 别名),索引没有读收益
  'idx_user_notification_preferences_user_id',
  // getProjectPaths(visibleTo) 的 OR 里有一支是 IN(子查询),SQLite 因此放弃多索引 OR,
  // 查询计划始终是 SCAN projects —— 这两条索引用不上。
  'idx_projects_owner',
  'idx_projects_visibility',
] as const;


