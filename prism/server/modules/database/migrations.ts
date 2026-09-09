import crypto from 'crypto';

import { Database } from 'better-sqlite3';


import {
  APP_CONFIG_TABLE_SCHEMA_SQL,
  AUDIT_LOG_TABLE_SCHEMA_SQL,
  INDEX_SCHEMA_SQL,
  LAST_SCANNED_AT_SQL,
  RETIRED_INDEXES,
  PROJECTS_TABLE_SCHEMA_SQL,
  PROJECT_SHARES_TABLE_SCHEMA_SQL,
  PROJECT_STARS_TABLE_SCHEMA_SQL,
  SESSIONS_TABLE_SCHEMA_SQL,
  USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL,
  USER_UI_SETTINGS_TABLE_SCHEMA_SQL,
} from '@/modules/database/schema.js';
import { listRootUsernames } from '@/shared/root-users.js';
import { createLogger } from '@/shared/logger.js';
const log = createLogger('db');

const SQLITE_UUID_SQL = `
lower(hex(randomblob(4))) || '-' ||
lower(hex(randomblob(2))) || '-' ||
lower(hex(randomblob(2))) || '-' ||
lower(hex(randomblob(2))) || '-' ||
lower(hex(randomblob(6)))
`;

type TableInfoRow = {
  name: string;
  pk: number;
  /** PRAGMA table_info 的 notnull 列:1 表示该列带 NOT NULL 约束。 */
  notnull: number;
};

const addColumnToTableIfNotExists = (
  db: Database,
  tableName: string,
  columnNames: string[],
  columnName: string,
  columnType: string
) => {
  if (!columnNames.includes(columnName)) {
    log.info(`Running migration: Adding ${columnName} column to ${tableName} table`);
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`);
  }
};

const tableExists = (db: Database, tableName: string): boolean =>
  Boolean(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName)
  );

const getTableInfo = (db: Database, tableName: string): TableInfoRow[] =>
  db.prepare(`PRAGMA table_info(${tableName})`).all() as TableInfoRow[];

const migrateLegacySessionNames = (db: Database): void => {
  const hasLegacySessionNamesTable = tableExists(db, 'session_names');
  const hasSessionsTable = tableExists(db, 'sessions');

  if (!hasLegacySessionNamesTable) {
    return;
  }

  if (hasSessionsTable) {
    log.info('Running migration: Merging session_names into sessions');
    db.exec(`
      INSERT INTO sessions (session_id, provider, custom_name, created_at, updated_at)
      SELECT
        session_id,
        COALESCE(provider, 'claude'),
        custom_name,
        COALESCE(created_at, CURRENT_TIMESTAMP),
        COALESCE(updated_at, CURRENT_TIMESTAMP)
      FROM session_names
      WHERE true
      ON CONFLICT(session_id) DO UPDATE SET
        provider = excluded.provider,
        custom_name = COALESCE(excluded.custom_name, sessions.custom_name),
        created_at = COALESCE(sessions.created_at, excluded.created_at),
        updated_at = COALESCE(excluded.updated_at, sessions.updated_at)
    `);
    db.exec('DROP TABLE session_names');
    return;
  }

  log.info('Running migration: Renaming session_names table to sessions');
  db.exec('ALTER TABLE session_names RENAME TO sessions');
};

const migrateLegacyWorkspaceTableIntoProjects = (db: Database): void => {
  db.exec(PROJECTS_TABLE_SCHEMA_SQL);

  if (!tableExists(db, 'workspace_original_paths')) {
    return;
  }

  log.info('Running migration: Migrating workspace_original_paths data into projects');
  db.exec(`
    INSERT INTO projects (project_id, project_path, custom_project_name, isStarred, isArchived)
    SELECT
      CASE
        WHEN workspace_id IS NULL OR trim(workspace_id) = ''
        THEN ${SQLITE_UUID_SQL}
        ELSE workspace_id
      END,
      workspace_path,
      custom_workspace_name,
      COALESCE(isStarred, 0),
      0
    FROM workspace_original_paths
    WHERE workspace_path IS NOT NULL AND trim(workspace_path) <> ''
    ON CONFLICT(project_path) DO UPDATE SET
      custom_project_name = COALESCE(projects.custom_project_name, excluded.custom_project_name),
      isStarred = COALESCE(projects.isStarred, excluded.isStarred)
  `);
};

const rebuildProjectsTableWithPrimaryKeySchema = (db: Database): void => {
  const hasProjectsTable = tableExists(db, 'projects');
  if (!hasProjectsTable) {
    db.exec(PROJECTS_TABLE_SCHEMA_SQL);
    return;
  }

  const projectsTableInfo = getTableInfo(db, 'projects');
  const columnNames = projectsTableInfo.map((column) => column.name);
  const hasProjectIdPrimaryKey = projectsTableInfo.some(
    (column) => column.name === 'project_id' && column.pk === 1,
  );

  if (hasProjectIdPrimaryKey) {
    addColumnToTableIfNotExists(db, 'projects', columnNames, 'custom_project_name', 'TEXT DEFAULT NULL');
    addColumnToTableIfNotExists(db, 'projects', columnNames, 'isStarred', 'BOOLEAN DEFAULT 0');
    addColumnToTableIfNotExists(db, 'projects', columnNames, 'isArchived', 'BOOLEAN DEFAULT 0');
    db.exec(`
      UPDATE projects
      SET project_id = ${SQLITE_UUID_SQL}
      WHERE project_id IS NULL OR trim(project_id) = ''
    `);
    return;
  }

  log.info('Running migration: Rebuilding projects table to enforce project_id primary key');

  const projectPathExpression = columnNames.includes('project_path')
    ? 'project_path'
    : columnNames.includes('workspace_path')
      ? 'workspace_path'
      : 'NULL';

  const customProjectNameExpression = columnNames.includes('custom_project_name')
    ? 'custom_project_name'
    : columnNames.includes('custom_workspace_name')
      ? 'custom_workspace_name'
      : 'NULL';

  const isStarredExpression = columnNames.includes('isStarred') ? 'COALESCE(isStarred, 0)' : '0';

  const isArchivedExpression = columnNames.includes('isArchived') ? 'COALESCE(isArchived, 0)' : '0';

  const projectIdExpression = columnNames.includes('project_id')
    ? `CASE
         WHEN project_id IS NULL OR trim(project_id) = ''
         THEN ${SQLITE_UUID_SQL}
         ELSE project_id
       END`
    : SQLITE_UUID_SQL;

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN TRANSACTION');
    db.exec('DROP TABLE IF EXISTS projects__new');
    db.exec(`
      CREATE TABLE projects__new (
        project_id TEXT PRIMARY KEY NOT NULL,
        project_path TEXT NOT NULL UNIQUE,
        custom_project_name TEXT DEFAULT NULL,
        isStarred BOOLEAN DEFAULT 0,
        isArchived BOOLEAN DEFAULT 0
      )
    `);
    db.exec(`
      WITH source_rows AS (
        SELECT
          ${projectPathExpression} AS project_path,
          ${customProjectNameExpression} AS custom_project_name,
          ${isStarredExpression} AS isStarred,
          ${isArchivedExpression} AS isArchived,
          ${projectIdExpression} AS candidate_project_id,
          rowid AS source_rowid
        FROM projects
        WHERE ${projectPathExpression} IS NOT NULL AND trim(${projectPathExpression}) <> ''
      ),
      deduped_paths AS (
        SELECT
          project_path,
          custom_project_name,
          isStarred,
          isArchived,
          candidate_project_id,
          source_rowid,
          ROW_NUMBER() OVER (PARTITION BY project_path ORDER BY source_rowid) AS project_path_rank
        FROM source_rows
      ),
      prepared_rows AS (
        SELECT
          CASE
            WHEN ROW_NUMBER() OVER (PARTITION BY candidate_project_id ORDER BY source_rowid) = 1
            THEN candidate_project_id
            ELSE ${SQLITE_UUID_SQL}
          END AS project_id,
          project_path,
          custom_project_name,
          isStarred,
          isArchived
        FROM deduped_paths
        WHERE project_path_rank = 1
      )
      INSERT INTO projects__new (
        project_id,
        project_path,
        custom_project_name,
        isStarred,
        isArchived
      )
      SELECT
        project_id,
        project_path,
        custom_project_name,
        isStarred,
        isArchived
      FROM prepared_rows
    `);
    db.exec('DROP TABLE projects');
    db.exec('ALTER TABLE projects__new RENAME TO projects');
    db.exec('COMMIT');
  } catch (migrationError) {
    db.exec('ROLLBACK');
    throw migrationError;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
};

const rebuildSessionsTableWithProjectSchema = (db: Database): void => {
  const hasSessions = tableExists(db, 'sessions');
  if (!hasSessions) {
    db.exec(SESSIONS_TABLE_SCHEMA_SQL);
    return;
  }

  const sessionsTableInfo = getTableInfo(db, 'sessions');
  const columnNames = sessionsTableInfo.map((column) => column.name);
  const primaryKeyColumns = sessionsTableInfo
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((column) => column.name);

  const shouldRebuild =
    !columnNames.includes('project_path') ||
    primaryKeyColumns.length !== 1 ||
    primaryKeyColumns[0] !== 'session_id' ||
    !columnNames.includes('provider');

  if (!shouldRebuild) {
    addColumnToTableIfNotExists(db, 'sessions', columnNames, 'jsonl_path', 'TEXT');
    addColumnToTableIfNotExists(db, 'sessions', columnNames, 'isArchived', 'BOOLEAN DEFAULT 0');
    addColumnToTableIfNotExists(db, 'sessions', columnNames, 'created_at', 'DATETIME');
    addColumnToTableIfNotExists(db, 'sessions', columnNames, 'updated_at', 'DATETIME');
    db.exec('UPDATE sessions SET isArchived = COALESCE(isArchived, 0)');
    db.exec('UPDATE sessions SET created_at = COALESCE(created_at, CURRENT_TIMESTAMP)');
    db.exec('UPDATE sessions SET updated_at = COALESCE(updated_at, CURRENT_TIMESTAMP)');
    return;
  }

  log.info('Running migration: Rebuilding sessions table to project-based schema');

  const projectPathExpression = columnNames.includes('project_path')
    ? 'project_path'
    : columnNames.includes('workspace_path')
      ? 'workspace_path'
      : 'NULL';

  const providerExpression = columnNames.includes('provider')
    ? "COALESCE(provider, 'claude')"
    : "'claude'";

  const customNameExpression = columnNames.includes('custom_name')
    ? 'custom_name'
    : 'NULL';

  const jsonlPathExpression = columnNames.includes('jsonl_path')
    ? 'jsonl_path'
    : 'NULL';

  const isArchivedExpression = columnNames.includes('isArchived')
    ? 'COALESCE(isArchived, 0)'
    : '0';

  const createdAtExpression = columnNames.includes('created_at')
    ? 'COALESCE(created_at, CURRENT_TIMESTAMP)'
    : 'CURRENT_TIMESTAMP';

  const updatedAtExpression = columnNames.includes('updated_at')
    ? 'COALESCE(updated_at, CURRENT_TIMESTAMP)'
    : 'CURRENT_TIMESTAMP';

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN TRANSACTION');
    db.exec('DROP TABLE IF EXISTS sessions__new');
    db.exec(`
      CREATE TABLE sessions__new (
        session_id TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'claude',
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
      )
    `);
    db.exec(`
      WITH source_rows AS (
        SELECT
          session_id,
          ${providerExpression} AS provider,
          ${customNameExpression} AS custom_name,
          ${projectPathExpression} AS project_path,
          ${jsonlPathExpression} AS jsonl_path,
          ${isArchivedExpression} AS isArchived,
          ${createdAtExpression} AS created_at,
          ${updatedAtExpression} AS updated_at,
          rowid AS source_rowid
        FROM sessions
        WHERE session_id IS NOT NULL AND trim(session_id) <> ''
      ),
      ranked_rows AS (
        SELECT
          session_id,
          provider,
          custom_name,
          project_path,
          jsonl_path,
          isArchived,
          created_at,
          updated_at,
          ROW_NUMBER() OVER (
            PARTITION BY session_id
            ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, source_rowid DESC
          ) AS session_rank
        FROM source_rows
      )
      INSERT INTO sessions__new (
        session_id,
        provider,
        custom_name,
        project_path,
        jsonl_path,
        isArchived,
        created_at,
        updated_at
      )
      SELECT
        session_id,
        provider,
        custom_name,
        project_path,
        jsonl_path,
        isArchived,
        created_at,
        updated_at
      FROM ranked_rows
      WHERE session_rank = 1
    `);
    db.exec('DROP TABLE sessions');
    db.exec('ALTER TABLE sessions__new RENAME TO sessions');
    db.exec('COMMIT');
  } catch (migrationError) {
    db.exec('ROLLBACK');
    throw migrationError;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
};

/**
 * Adds the `provider_session_id` mapping column used by the session gateway.
 *
 * Rows that existed before this migration were always keyed directly by the
 * provider-native session id, so backfilling `provider_session_id` with
 * `session_id` keeps every legacy row resolvable through the new mapping.
 */
/**
 * fj:用量台账的会话键从 provider 原生 id 迁到 app 会话 id。
 *
 * 落库那两处原来存的是 provider 原生 id,而 `/cost` 按前端的 app 会话 id 查 ——
 * 网页会话两个 id 必然不同,那一行台账因此**恒为空**。改成落 app id 之后,
 * 已有的历史行仍然挂在旧键上,不迁就等于把过去的账丢掉。
 *
 * 只迁能一一对上的行(`sessions` 里有对应映射、且两个 id 确实不同)。
 * 迁不动的(会话行已删)原样留着 —— 台账是账本,宁可留一条查不到主的行,
 * 也不删。做过就不会再动:第二次跑时 `session_id` 已经是 app id,匹配不上。
 */
const remapUsageRecordsToAppSessionIds = (db: Database): void => {
  if (!tableExists(db, 'usage_records')) return;
  const result = db.prepare(`
    UPDATE usage_records
    SET session_id = (
      SELECT s.session_id FROM sessions s
      WHERE s.provider_session_id = usage_records.session_id
        AND s.session_id <> s.provider_session_id
      LIMIT 1
    )
    WHERE EXISTS (
      SELECT 1 FROM sessions s
      WHERE s.provider_session_id = usage_records.session_id
        AND s.session_id <> s.provider_session_id
    )
  `).run();
  if (result.changes > 0) {
    log.info(`Running migration: 用量台账会话键迁到 app 会话 id(${result.changes} 行)`);
  }
};

const addProviderSessionIdMapping = (db: Database): void => {
  const sessionsTableInfo = getTableInfo(db, 'sessions');
  const columnNames = sessionsTableInfo.map((column) => column.name);

  addColumnToTableIfNotExists(db, 'sessions', columnNames, 'provider_session_id', 'TEXT');
  db.exec(`
    UPDATE sessions
    SET provider_session_id = session_id
    WHERE provider_session_id IS NULL
  `);
};

/**
 * Web Push and Electron desktop notifications were removed with the web-only
 * refactor. Databases created by earlier versions still carry their tables
 * (`push_subscriptions` + `vapid_keys` for Web Push, and
 * `notification_channel_endpoints` for desktop notification targets); drop
 * them so stale credentials/endpoints don't linger in user databases.
 */
const dropWebPushAndDesktopNotificationTables = (db: Database): void => {
  const legacyTables = ['push_subscriptions', 'vapid_keys', 'notification_channel_endpoints'];
  const hasAnyLegacyTable = legacyTables.some((tableName) => tableExists(db, tableName));
  if (hasAnyLegacyTable) {
    log.info('Running migration: Dropping legacy Web Push / desktop notification tables');
  }

  db.exec('DROP INDEX IF EXISTS idx_push_subscriptions_user_id');
  db.exec('DROP INDEX IF EXISTS idx_notification_channel_endpoints_user_id');
  for (const tableName of legacyTables) {
    db.exec(`DROP TABLE IF EXISTS ${tableName}`);
  }
};

/**
 * 发布功能移除后清掉它的表。
 *
 * 表里存的是"某个项目里的某个相对路径 + 一个 token",没有别处引用,功能没了之后
 * 它就是一堆谁也不会再读的行。留着的坏处不只是占地方 —— 下一个人看到
 * `published_pages` 会以为发布还在,然后去找那个不存在的路由。
 *
 * 不做数据迁移:发布行本来就只是**引用**,从不保存文件内容,所以丢的只是
 * "曾经发出去过哪些链接"这条记录,文件一个都不会少。
 */
const dropPublishedPagesTable = (db: Database): void => {
  if (tableExists(db, 'published_pages')) {
    log.info('Running migration: Dropping published_pages (publishing feature removed)');
  }
  db.exec('DROP INDEX IF EXISTS idx_published_pages_project');
  db.exec('DROP TABLE IF EXISTS published_pages');
};

const ensureProjectsForSessionPaths = (db: Database): void => {
  if (!tableExists(db, 'sessions')) {
    return;
  }

  db.exec(`
    INSERT INTO projects (project_id, project_path, custom_project_name, isStarred, isArchived)
    SELECT
      ${SQLITE_UUID_SQL},
      project_path,
      NULL,
      0,
      0
    FROM sessions
    WHERE project_path IS NOT NULL AND trim(project_path) <> ''
    ON CONFLICT(project_path) DO NOTHING
  `);
};

/**
 * Moves api_keys from plaintext storage to hash-only storage.
 *
 * Existing keys stay usable: their plaintext is hashed in place, the hash and
 * a display prefix are backfilled, and the plaintext column is nulled out.
 * That is a one-way trip — after this runs the full key exists only wherever
 * the user saved it, which is the point.
 */
const migrateApiKeysToHashed = (db: Database): void => {
  if (!tableExists(db, 'api_keys')) return;

  const columnNames = getTableInfo(db, 'api_keys').map((column) => column.name);
  addColumnToTableIfNotExists(db, 'api_keys', columnNames, 'api_key_hash', 'TEXT');
  addColumnToTableIfNotExists(db, 'api_keys', columnNames, 'api_key_prefix', 'TEXT');

  /**
   * **必须在哈希之前**:下面那步是 `UPDATE … SET api_key = NULL`,
   * 老表上那一列是 `NOT NULL` —— 先不松约束的话,这句 UPDATE 自己就会抛,
   * 而迁移是往上抛的,结果是**服务直接起不来**。
   * (已经建过密钥的老库升级上来正是这种情况。)
   */
  relaxLegacyApiKeyNotNull(db);

  // Plaintext rows that predate hashing.
  const legacyRows = db
    .prepare(
      'SELECT id, api_key FROM api_keys WHERE api_key IS NOT NULL AND (api_key_hash IS NULL OR api_key_hash = \'\')'
    )
    .all() as { id: number; api_key: string }[];

  if (legacyRows.length > 0) {
    log.info(`Running migration: Hashing ${legacyRows.length} stored API key(s)`);
    const update = db.prepare(
      'UPDATE api_keys SET api_key_hash = ?, api_key_prefix = ?, api_key = NULL WHERE id = ?'
    );
    const runAll = db.transaction((rows: { id: number; api_key: string }[]) => {
      for (const row of rows) {
        const hash = crypto.createHash('sha256').update(row.api_key).digest('hex');
        update.run(hash, row.api_key.slice(0, 11), row.id);
      }
    });
    runAll(legacyRows);
  }

  // The legacy UNIQUE index on api_key would reject a second NULL on some
  // older SQLite builds and is meaningless now that the column is emptied.
  db.exec('DROP INDEX IF EXISTS idx_api_keys_key');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(api_key_hash)');
};

/**
 * 老库里的 `api_keys.api_key` 是 `NOT NULL`,新代码往那一列写 NULL —— 于是
 * **新建 API 密钥永远失败**。
 *
 * 上游最初的建表是 `api_key TEXT UNIQUE NOT NULL`(明文存 key)。改成只存哈希之后,
 * 新建走的是 `INSERT … (api_key, api_key_hash, api_key_prefix) VALUES (NULL, ?, ?)`,
 * 在那种老表上直接撞 `NOT NULL constraint failed: api_keys.api_key`。
 *
 * 全新安装不会有这个问题(建表用的是新形状),所以它只在**升级上来的库**上出现,
 * 而且**一把密钥都没建过的库最隐蔽**:上面那段哈希迁移只 UPDATE
 * `api_key IS NOT NULL` 的行,一行都没有就什么也没做,约束原样留着。
 * 界面那边失败只打一行 error,于是表现成"点了创建没反应"。
 *
 * SQLite 改不了列约束,只能重建表。照搬 projects / sessions 两处的做法。
 */
const relaxLegacyApiKeyNotNull = (db: Database): void => {
  const info = getTableInfo(db, 'api_keys');
  const apiKeyColumn = info.find((column) => column.name === 'api_key');
  // notnull === 0 就是已经可空,什么都不用做(全新安装走这条)。
  if (!apiKeyColumn || Number(apiKeyColumn.notnull) === 0) return;

  log.info('Running migration: Relaxing legacy NOT NULL on api_keys.api_key');

  const columnNames = info.map((column) => column.name);
  const pick = (name: string, fallback: string) =>
    (columnNames.includes(name) ? name : fallback);

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN TRANSACTION');
    db.exec('DROP TABLE IF EXISTS api_keys__new');
    db.exec(`
      CREATE TABLE api_keys__new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        key_name TEXT NOT NULL,
        api_key TEXT UNIQUE,
        api_key_hash TEXT UNIQUE,
        api_key_prefix TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_used DATETIME,
        is_active BOOLEAN DEFAULT 1,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    db.exec(`
      INSERT INTO api_keys__new
        (id, user_id, key_name, api_key, api_key_hash, api_key_prefix, created_at, last_used, is_active)
      SELECT
        id,
        user_id,
        key_name,
        -- 已经哈希过的行这一列是空串或明文残留;空串按"没有"处理,
        -- 免得新表的 UNIQUE 把多行空串判成重复。
        NULLIF(api_key, ''),
        ${pick('api_key_hash', 'NULL')},
        ${pick('api_key_prefix', 'NULL')},
        ${pick('created_at', 'CURRENT_TIMESTAMP')},
        ${pick('last_used', 'NULL')},
        COALESCE(${pick('is_active', '1')}, 1)
      FROM api_keys
    `);
    db.exec('DROP TABLE api_keys');
    db.exec('ALTER TABLE api_keys__new RENAME TO api_keys');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }

  // 重建把索引也带走了,补回来。
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(api_key_hash)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(is_active)');
};

/**
 * `projects.owner_user_id` — NULL means public.
 *
 * Added on its own rather than inside `rebuildProjectsTableWithPrimaryKeySchema`
 * because that rebuild only fires on pre-project_id schemas; installs that
 * already migrated would never see the column otherwise.
 */
/**
 * eu:把技能训练(SkillOpt 接入)留在库里的东西清干净。**只跑一次。**
 *
 * ## 为什么要有"只跑一次"这件事
 *
 * 直接写一句无条件的 `DROP TABLE IF EXISTS skillopt_runs` 是个坑:哪天把这个
 * 功能重新接回来,建表语句刚建好,下一次启动这句又把它删了 —— 而且删得悄无声息。
 * 所以在 `app_config` 里记一个标记,做过就不再做。重新接回来时新表不会被误伤。
 *
 * ## 清三样
 *
 * 1. `skillopt_runs` 整张表(训练记录;真正的产物在磁盘上,不在库里);
 * 2. `skillopt_*` 的审计行 —— 功能都没了,留着这几条追责记录没有意义;
 * 3. **训练留下的幽灵项目行**:rollout 与 optimizer 各自的临时工作目录曾被
 *    当成项目登记进来。这些路径的形状写在这里而不是运行时判据里,是因为
 *    它们描述的是**历史数据**,不是以后还要执行的规则 —— 功能已经删了,
 *    运行时不会再产生这种路径。
 */
const SKILLOPT_CLEANUP_KEY = 'cleanup.skillopt.v1';

const removeSkillOptLeftovers = (db: Database): void => {
  const done = db
    .prepare('SELECT value FROM app_config WHERE key = ?')
    .get(SKILLOPT_CLEANUP_KEY) as { value?: string } | undefined;
  if (done) return;

  let removedProjects = 0;
  if (tableExists(db, 'projects')) {
    const rows = db
      .prepare('SELECT project_id, project_path FROM projects')
      .all() as Array<{ project_id: string; project_path: string }>;
    /**
     * 训练期间被登记进来的两种目录:
     *   - 我们自己的 rollout 工作区:`<PRISM_SKILLOPT_HOME>/…/work/<任务名>`,
     *     默认 home 是 `~/.prism/skillopt`,路径里一定有 `.prism/skillopt`;
     *   - SkillOpt 自己开的临时目录:`skillopt_claude_*` / `skillopt_codex_*` /
     *     `skillopt-generated-*`(它 `tempfile.TemporaryDirectory` 的几个前缀)。
     *
     * 判据写窄 —— 删错一行就是删掉用户真实的项目。名字里带 skillopt 的正常项目
     * (`~/projects/skillopt-notes`)不会命中:第一条要求路径里有 `.prism/skillopt`
     * **并且**有 `work` 段,第二条要求**目录名本身**以那几个前缀开头。
     */
    const isLeftover = (projectPath: string): boolean => {
      if (!projectPath) return false;
      const normalized = projectPath.replace(/\\/g, '/');
      const segments = normalized.split('/');
      if (normalized.includes('/.prism/skillopt/') && segments.includes('work')) return true;
      return segments.some((segment) => {
        const value = segment.replace(/_/g, '-');
        return value.startsWith('skillopt-claude-')
          || value.startsWith('skillopt-codex-')
          || value.startsWith('skillopt-generated-');
      });
    };

    const deleteSessions = tableExists(db, 'sessions')
      ? db.prepare('DELETE FROM sessions WHERE project_path = ?')
      : null;
    const deleteProject = db.prepare('DELETE FROM projects WHERE project_id = ?');
    for (const row of rows) {
      if (!isLeftover(row.project_path)) continue;
      deleteSessions?.run(row.project_path);
      deleteProject.run(row.project_id);
      removedProjects += 1;
    }
  }

  let removedAudit = 0;
  if (tableExists(db, 'audit_log')) {
    removedAudit = db.prepare("DELETE FROM audit_log WHERE event LIKE 'skillopt%'").run().changes;
  }

  const hadTable = tableExists(db, 'skillopt_runs');
  if (hadTable) db.exec('DROP TABLE skillopt_runs');

  db.prepare('INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)')
    .run(SKILLOPT_CLEANUP_KEY, new Date().toISOString());

  if (hadTable || removedProjects > 0 || removedAudit > 0) {
    log.info(
      `Running migration: removed SkillOpt leftovers (table=${hadTable ? 'dropped' : 'absent'}, `
      + `projects=${removedProjects}, audit=${removedAudit})`,
    );
  }
};

/**
 * 用户名改成**大小写不敏感**(`COLLATE NOCASE UNIQUE`)。
 *
 * ## 这修的是一个未登录即可利用的提权
 *
 * `isRootUser()` 拿 `username.trim().toLowerCase()` 去和 `PRISM_ROOT_USERS` 比对,
 * 而 `users.username` 是 SQLite 默认 BINARY 排序的 `UNIQUE`,注册时又不做任何归一化。
 * 于是 `PRISM_ROOT_USERS=alice` 时,任何人注册 `Alice`:
 *
 *   - UNIQUE 不冲突(BINARY 下 `Alice` != `alice`),插入成功;
 *   - `isRootUser("Alice")` 为真 -> **绕过注册审批**,当场发 JWT;
 *   - 之后每个请求 `withRootFlag` 都判定 `isRoot=true` -> 重置任意账号密码、
 *     读全站审计日志、改任意项目属主。
 *
 * 实测打穿过:`Alice` 打 `/api/admin/users` 拿到 200,而正常非 root 账号是 403。
 * 攻击者不需要任何凭据 —— root 用户名根本不是秘密(审计页、项目属主、共享名单里到处都是)。
 * 带前后空格的 `" alice "` 同样成立。
 *
 * ## 为什么是改排序规则,而不是在注册处 lower 一下
 *
 * 注册只是**其中一个**入口。库里的口径本来就已经不一致了:`findIdByUsername`
 * 是大小写不敏感的(注释还写明了),而登录走的 `getUserByUsername` 是敏感的。
 * 在某一处补归一化,等于再加一份会漂的判据。
 *
 * 把 `COLLATE NOCASE` 放到**列**上,`UNIQUE` 和所有 `WHERE username = ?` 一次性
 * 全部变成大小写不敏感 —— 真源只有一个,以后新增查询也不会漏。
 *
 * ## 存量撞车怎么处置
 *
 * 老库里可能已经躺着 `alice` / `Alice` 两行(可能就是这个攻击留下的)。直接建
 * NOCASE 唯一索引会失败,而**删账号或合并账号都是不可逆的**,不能替用户做主。
 *
 * 做法:同一组里**保留 id 最小的那行**(最早注册的,几乎必然是本人),其余重命名成
 * `<名字>~dup<id>`。重命名本身就解除了冒充:`isRootUser("Alice~dup4")` 为 false,
 * 提权当场失效;账号数据一行不删,root 可以在管理页看到并自行处置。
 * 顺带把所有用户名 `trim()` 一遍 —— 前后空格是同一个洞的变体。
 *
 * 幂等:库里已经是 NOCASE 就直接返回,不重复重建。
 */
const rebuildUsersTableWithCaseInsensitiveUsername = (db: Database): void => {
  if (!tableExists(db, 'users')) return;

  const ddl = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'")
    .get() as { sql?: string } | undefined;
  // 已经做过就不再做。判据放宽到不区分大小写,免得被 DDL 里的书写差异骗过。
  if (ddl?.sql && /username[^,]*collate\s+nocase/i.test(ddl.sql)) return;

  const columns = db.prepare('PRAGMA table_info(users)').all() as TableInfoRow[];
  if (columns.length === 0) return;
  const columnNames = new Set(columns.map((column) => column.name));
  const has = (name: string): boolean => columnNames.has(name);
  // 老库可能缺后加的列;缺了就用与建表默认值一致的字面量补齐。
  const pick = (name: string, fallback: string): string => (has(name) ? name : fallback);

  // 撞车检测按「trim + 小写」分组 —— 这正是新唯一索引将要使用的口径。
  const collisions = db
    .prepare(`
      SELECT id, username
      FROM users
      WHERE lower(trim(username)) IN (
        SELECT lower(trim(username)) FROM users
        GROUP BY lower(trim(username))
        HAVING COUNT(*) > 1
      )
      ORDER BY lower(trim(username)), id
    `)
    .all() as Array<{ id: number; username: string }>;

  const renamed: Array<{ id: number; from: string; to: string }> = [];
  if (collisions.length > 0) {
    const seen = new Set<string>();
    const rename = db.prepare('UPDATE users SET username = ? WHERE id = ?');
    for (const row of collisions) {
      const key = String(row.username ?? '').trim().toLowerCase();
      if (!seen.has(key)) {
        seen.add(key); // 每组第一条(id 最小)保留原名
        continue;
      }
      const next = `${String(row.username ?? '').trim()}~dup${row.id}`;
      rename.run(next, row.id);
      renamed.push({ id: row.id, from: row.username, to: next });
    }
  }

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN TRANSACTION');
    db.exec('DROP TABLE IF EXISTS users__new');
    db.exec(`
      CREATE TABLE users__new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        password_hash TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_login DATETIME,
        is_active BOOLEAN DEFAULT 1,
        git_name TEXT,
        git_email TEXT,
        has_completed_onboarding BOOLEAN DEFAULT 0,
        token_version INTEGER NOT NULL DEFAULT 0,
        approval_status TEXT NOT NULL DEFAULT 'approved',
        approved_at DATETIME,
        reviewed_by INTEGER
      )
    `);
    db.exec(`
      INSERT INTO users__new (
        id, username, password_hash, created_at, last_login, is_active,
        git_name, git_email, has_completed_onboarding, token_version,
        approval_status, approved_at, reviewed_by
      )
      SELECT
        id,
        trim(username),
        password_hash,
        ${pick('created_at', 'CURRENT_TIMESTAMP')},
        ${pick('last_login', 'NULL')},
        ${pick('is_active', '1')},
        ${pick('git_name', 'NULL')},
        ${pick('git_email', 'NULL')},
        ${pick('has_completed_onboarding', '0')},
        ${has('token_version') ? 'COALESCE(token_version, 0)' : '0'},
        ${has('approval_status') ? "COALESCE(approval_status, 'approved')" : "'approved'"},
        ${pick('approved_at', 'NULL')},
        ${pick('reviewed_by', 'NULL')}
      FROM users
      WHERE username IS NOT NULL AND trim(username) <> ''
    `);
    db.exec('DROP TABLE users');
    db.exec('ALTER TABLE users__new RENAME TO users');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }

  log.info('Running migration: users.username 改为 COLLATE NOCASE UNIQUE(大小写不敏感)');
  if (renamed.length > 0) {
    log.warn(
      `[MIGRATION] 检测到 ${renamed.length} 个大小写撞车的用户名,已重命名(账号数据未删):`,
    );
    for (const item of renamed) {
      log.warn(`  #${item.id} "${item.from}" -> "${item.to}"`);
    }
    log.warn('  这些账号需要用新名字登录。若其中有冒充 root 的账号,重命名已使其失去 root。');
  }
};

const addProjectOwnerColumn = (db: Database): void => {
  const projectsTableInfo = db.prepare('PRAGMA table_info(projects)').all() as TableInfoRow[];
  const columnNames = projectsTableInfo.map((column) => column.name);
  addColumnToTableIfNotExists(db, 'projects', columnNames, 'owner_user_id', 'INTEGER');
};

/**
 * `projects.visibility` + `project_shares` —— 创建项目时的显式权限三选
 * (个人 / 公共 / 指定用户)。visibility='public' 对所有登录用户可见;
 * project_shares 逐用户授权。NULL/无行 = 原有语义不变(个人按 owner,
 * 无主仅 root、公共目录例外),所以存量数据零迁移成本。
 */
const addProjectVisibilityAndShares = (db: Database): void => {
  const projectsTableInfo = db.prepare('PRAGMA table_info(projects)').all() as TableInfoRow[];
  const columnNames = projectsTableInfo.map((column) => column.name);
  addColumnToTableIfNotExists(db, 'projects', columnNames, 'visibility', 'TEXT DEFAULT NULL');
  db.exec(PROJECT_SHARES_TABLE_SCHEMA_SQL);
  db.exec('CREATE INDEX IF NOT EXISTS idx_project_shares_user ON project_shares(user_id)');
};

/**
 * 收藏按用户隔离(project_stars),并做一次性搬迁:
 * 老的全局 isStarred=1 归属给项目 owner;无主项目的旧收藏归给全部 root 账号
 * (无主项目本来只有 root 看得到,旧标记只可能是 root 打的)。表已存在时
 * 整段跳过 —— 搬迁只跑一次,之后两边各自演化互不干扰。
 */
const addProjectStarsTable = (db: Database): void => {
  const existing = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_stars'")
    .get();
  db.exec(PROJECT_STARS_TABLE_SCHEMA_SQL);
  db.exec('CREATE INDEX IF NOT EXISTS idx_project_stars_user ON project_stars(user_id)');
  if (existing) return;

  db.prepare(`
    INSERT OR IGNORE INTO project_stars (project_id, user_id)
    SELECT project_id, owner_user_id FROM projects
    WHERE isStarred = 1 AND owner_user_id IS NOT NULL
  `).run();

  const rootIds = listRootUsernames()
    .map((username) => db
      .prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE')
      .get(username) as { id: number } | undefined)
    .filter((row): row is { id: number } => row !== undefined)
    .map((row) => row.id);
  const insertForRoot = db.prepare(`
    INSERT OR IGNORE INTO project_stars (project_id, user_id)
    SELECT project_id, ? FROM projects
    WHERE isStarred = 1 AND owner_user_id IS NULL
  `);
  for (const rootId of rootIds) {
    insertForRoot.run(rootId);
  }
};

export const runMigrations = (db: Database) => {
  try {
    const usersTableInfo = db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
    const userColumnNames = usersTableInfo.map((column) => column.name);

    addColumnToTableIfNotExists(db, 'users', userColumnNames, 'git_name', 'TEXT');
    addColumnToTableIfNotExists(db, 'users', userColumnNames, 'git_email', 'TEXT');
    addColumnToTableIfNotExists(
      db,
      'users',
      userColumnNames,
      'has_completed_onboarding',
      'BOOLEAN DEFAULT 0'
    );
    addColumnToTableIfNotExists(
      db,
      'users',
      userColumnNames,
      'token_version',
      'INTEGER NOT NULL DEFAULT 0'
    );
    // Approval trio. 'approved' as the column default is what keeps existing
    // accounts logging in after this migration; do not tighten it.
    addColumnToTableIfNotExists(
      db,
      'users',
      userColumnNames,
      'approval_status',
      "TEXT NOT NULL DEFAULT 'approved'"
    );
    addColumnToTableIfNotExists(db, 'users', userColumnNames, 'approved_at', 'DATETIME');
    addColumnToTableIfNotExists(db, 'users', userColumnNames, 'reviewed_by', 'INTEGER');
    // F6:附件配额的**每用户覆盖**(MB)。NULL = 跟随全局默认
    // (PRISM_ATTACHMENT_QUOTA_MB),所以存量账号一行都不用动。
    addColumnToTableIfNotExists(db, 'users', userColumnNames, 'attachment_quota_mb', 'INTEGER');

    migrateApiKeysToHashed(db);

    db.exec(AUDIT_LOG_TABLE_SCHEMA_SQL);
    db.exec('CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON audit_log(user_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_audit_log_event ON audit_log(event)');

    db.exec(APP_CONFIG_TABLE_SCHEMA_SQL);
    db.exec(USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL);
    // F11:账号级界面偏好(权限清单 / 项目排序 / 编辑器偏好)。
    db.exec(USER_UI_SETTINGS_TABLE_SCHEMA_SQL);

    dropWebPushAndDesktopNotificationTables(db);
    dropPublishedPagesTable(db);

    // 用户名大小写不敏感 —— 修一个未登录即可利用的提权,详见函数注释。
    // 放在前面:它重建 users 表,而后面的迁移可能读用户行。
    rebuildUsersTableWithCaseInsensitiveUsername(db);

    db.exec(PROJECTS_TABLE_SCHEMA_SQL);
    rebuildProjectsTableWithPrimaryKeySchema(db);
    addProjectOwnerColumn(db);
    addProjectVisibilityAndShares(db);
    // 顺序**要紧**:`addProjectStarsTable` 的搬迁读 `SELECT … FROM projects WHERE
    // isStarred = 1`,而 workspace 时代的数据这时还在 `workspace_original_paths` 里。
    // 原来这两行是反的 —— 搬迁读到空表、什么都没搬,而它又是严格一次性的
    // (`if (existing) return`),下次启动永不重试。结果是老库升上来之后**收藏全丢**:
    // 旧的 isStarred 列还在,但有登录用户时侧栏只认 project_stars,界面上一个收藏都没有。
    migrateLegacyWorkspaceTableIntoProjects(db);

    addProjectStarsTable(db);
    rebuildSessionsTableWithProjectSchema(db);
    migrateLegacySessionNames(db);
    addProviderSessionIdMapping(db);
    remapUsageRecordsToAppSessionIds(db);
    ensureProjectsForSessionPaths(db);

    db.exec('CREATE INDEX IF NOT EXISTS idx_projects_is_starred ON projects(isStarred)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_projects_is_archived ON projects(isArchived)');

    db.exec('DROP INDEX IF EXISTS idx_session_names_lookup');
    db.exec('DROP INDEX IF EXISTS idx_sessions_workspace_path');
    db.exec('DROP INDEX IF EXISTS idx_workspace_original_paths_is_starred');
    db.exec('DROP INDEX IF EXISTS idx_workspace_original_paths_workspace_id');

    /**
     * 退役索引:`CREATE INDEX IF NOT EXISTS` 只管建不管删,从清单里去掉之后
     * 老库里那几条会一直留着白吃写开销(sessions 上实测约 15%)。
     * 名单与理由见 schema.ts 的 `RETIRED_INDEXES`。
     */
    for (const name of RETIRED_INDEXES) {
      db.exec(`DROP INDEX IF EXISTS ${name}`);
    }

    if (tableExists(db, 'workspace_original_paths')) {
      log.info('Running migration: Dropping legacy workspace_original_paths table');
      db.exec('DROP TABLE workspace_original_paths');
    }

    // eu:技能训练撤掉之后的一次性清账(做过就不再做,见函数注释)
    removeSkillOptLeftovers(db);

    /**
     * 显示日志的孤儿行 —— 每次启动收一次。
     *
     * `session_display_messages` 没有外键,而它指向的会话行有好几条路径会消失:
     * 迁移里删幽灵项目的会话时没连带删日志;`projects` 行被删时 FK 是
     * `ON DELETE SET NULL`,会话行留下、`project_path` 变 NULL —— 那些会话此后只有
     * root 看得到,它们的日志再也没有任何入口能删。孤儿只增不减,而这是全库行数
     * 最大的表(实测 8 万行 ≈ 108 MB)。
     *
     * 放在启动而不是写入时:孤儿是**别处删东西**产生的,写入路径上判不出来;
     * 而这条 DELETE 走 `(session_id, id)` 索引 + `sessions` 主键,正常安装上是毫秒级。
     */
    if (tableExists(db, 'session_display_messages') && tableExists(db, 'sessions')) {
      const orphans = db
        .prepare(`
          DELETE FROM session_display_messages
          WHERE session_id NOT IN (SELECT session_id FROM sessions)
        `)
        .run();
      if (orphans.changes > 0) {
        log.info(`Running migration: 清掉 ${orphans.changes} 条没有归属会话的显示日志`);
      }
    }

    /**
     * **所有索引统一在这里建** —— 迁移的最后一步,那时每张表的列一定齐了。
     *
     * 它们原来散落在 `INIT_SCHEMA_SQL` 的建表语句旁边,而 INIT 跑在迁移**之前**:
     * `CREATE TABLE IF NOT EXISTS` 对老库是空操作,于是索引可能引用一个迁移才补上的列,
     * 整句 `db.exec` 抛 → 服务起不来,而且 exec 非原子,前面的 DDL 已经落库。
     * projects / sessions / api_keys 三处各自踩过一次,当时是逐个挪进来、留一行 NOTE。
     *
     * 逐个挪治不了这个病:只要建索引还允许写在建表旁边,下一个人还会那么写。
     * 现在 `INIT_SCHEMA_SQL` 里**不许出现 CREATE INDEX**,有测试钉着。
     */
    db.exec(INDEX_SCHEMA_SQL);

    db.exec(LAST_SCANNED_AT_SQL);
    log.info('Database migrations completed successfully');
  } catch (error: any) {
    log.error('Error running migrations:', error.message);
    throw error;
  }
};
