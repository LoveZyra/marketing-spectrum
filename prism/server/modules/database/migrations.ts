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
 * `sessions.archived_at`:归档那一刻,归档保留期按它与最后活动时间中较晚的那个算
 * (见 `sessionsDb.getExpiredArchivedSessions`)。
 *
 * 老库加列后,已归档的行回填为 `updated_at`(没有更准的归档时间,判据结果与加列前相同);
 * 未归档的留 NULL。加列与回填只在列不存在时做一次。要排在 `rebuildSessionsTableWithProjectSchema`
 * 之后:那个重建按写死的列清单建表,不带这一列。
 */
const addSessionArchivedAt = (db: Database): void => {
  const columnNames = getTableInfo(db, 'sessions').map((column) => column.name);
  if (columnNames.includes('archived_at')) return;
  addColumnToTableIfNotExists(db, 'sessions', columnNames, 'archived_at', 'DATETIME');
  const backfilled = db
    .prepare('UPDATE sessions SET archived_at = COALESCE(updated_at, created_at) WHERE isArchived = 1')
    .run().changes;
  if (backfilled > 0) {
    log.info(`Running migration: 回填 ${backfilled} 条已归档会话的 archived_at`);
  }
};

/**
 * 用量台账的会话键统一为 app 会话 id(`/cost` 按前端的 app 会话 id 查)。
 *
 * 以 provider 原生 id 落库的行要改挂到对应的 app 会话 id 上 —— 网页会话的两个 id
 * 必然不同,不迁就查不到这些账。
 *
 * 只迁能一一对上的行(`sessions` 里有对应映射、且两个 id 确实不同)。
 * 对不上的(会话行已删)原样留着 —— 台账是账本,宁可留一条查不到主的行,也不删。
 * 幂等:迁过的行 `session_id` 已是 app id,再跑匹配不上。
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

/**
 * Adds the `provider_session_id` mapping column used by the session gateway.
 *
 * Rows without a mapping are keyed directly by the provider-native session id,
 * so backfilling `provider_session_id` with `session_id` keeps every such row
 * resolvable through the mapping.
 */
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
 * Drops the tables of the retired Web Push and desktop notification channels
 * (`push_subscriptions` + `vapid_keys`, and `notification_channel_endpoints`)
 * that older databases may still carry, so stale credentials/endpoints don't
 * linger in user databases.
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
 * 删除已下线的发布功能留下的 `published_pages` 表。
 *
 * 表里只存"某个项目里的某个相对路径 + 一个 token",没有别处引用;留着不只占地方,
 * 还会让人以为发布还在,然后去找那个不存在的路由。
 *
 * 不做数据迁移:发布行只是引用,从不保存文件内容,丢的只是"发出去过哪些链接"的记录,
 * 文件一个都不会少。
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

  /*
   * 必须在哈希之前:下面那步是 `UPDATE … SET api_key = NULL`,而老表上那一列是 `NOT NULL` ——
   * 不先松约束,这句 UPDATE 自己就会抛;迁移的异常往上抛,服务直接起不来
   * (建过密钥的老库正是这种情况)。
   */
  relaxLegacyApiKeyNotNull(db);

  /*
   * key 记下签发时的 users.token_version,让「退出所有设备 / 改密 / 重置密码」也作废 API key。
   * 存量 key 回填成用户当前的版本 —— 现在仍然能用,下一次作废动作起跟着失效;
   * 不回填的话 NULL 永远视为有效。
   * 加列放在 relaxLegacyApiKeyNotNull 之后:那一步按写死的列清单重建表(见 REQUIRED_COLUMNS
   * 的说明);api_keys 以后再加列,也要同步补进那份清单,否则会被重建吞掉。
   */
  addColumnToTableIfNotExists(
    db, 'api_keys', getTableInfo(db, 'api_keys').map((column) => column.name), 'token_version', 'INTEGER',
  );
  if (tableExists(db, 'users') && getTableInfo(db, 'users').some((column) => column.name === 'token_version')) {
    db.exec(`
      UPDATE api_keys SET token_version = (
        SELECT token_version FROM users WHERE users.id = api_keys.user_id
      ) WHERE token_version IS NULL
    `);
  }

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
 * 去掉老库 `api_keys.api_key` 上的 `NOT NULL`。
 *
 * 老表是 `api_key TEXT UNIQUE NOT NULL`(明文存 key);现在只存哈希,新建走
 * `INSERT … (api_key, api_key_hash, api_key_prefix) VALUES (NULL, ?, ?)`,在老表上会撞
 * `NOT NULL constraint failed: api_keys.api_key`,新建 API 密钥永远失败。
 *
 * 这一步不能依赖"有没有行要哈希":一把密钥都没建过的老库,哈希迁移什么也不做,
 * 约束却原样留着;界面上只表现为"点了创建没反应"(服务端一行 error)。
 *
 * SQLite 改不了列约束,只能重建表(做法同 projects / sessions 的重建)。
 * 重建用写死的列清单,api_keys 加列时要同步补进来。
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
        token_version INTEGER,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    db.exec(`
      INSERT INTO api_keys__new
        (id, user_id, key_name, api_key, api_key_hash, api_key_prefix, created_at, last_used, is_active, token_version)
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
        COALESCE(${pick('is_active', '1')}, 1),
        ${pick('token_version', 'NULL')}
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
 * 清掉已下线的技能训练(SkillOpt 接入)留在库里的东西。只跑一次。
 *
 * 只跑一次(app_config 里记标记):无条件的 `DROP TABLE IF EXISTS skillopt_runs`
 * 会在功能哪天重新接回来之后,于下一次启动悄无声息地删掉新建的表。
 *
 * 清三样:
 * 1. `skillopt_runs` 整张表(训练记录;真正的产物在磁盘上,不在库里);
 * 2. `skillopt*` 的审计行 —— 功能已不存在,这些追责记录没有意义;
 * 3. 训练留下的幽灵项目行:rollout 与 optimizer 的临时工作目录被当成项目登记过。
 *    这些路径的形状写在这里而不是运行时判据里,因为它们描述的是存量数据,
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
     * 并且有 `work` 段,第二条要求目录名本身以那几个前缀开头。
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
 * 把 `users.username` 重建为大小写不敏感(`COLLATE NOCASE UNIQUE`)。
 *
 * 为什么:`isRootUser()` 拿 `username.trim().toLowerCase()` 与 `PRISM_ROOT_USERS` 比对。
 * 若 username 是默认 BINARY 排序的 `UNIQUE`,`PRISM_ROOT_USERS=alice` 时任何人都能注册
 * `Alice`(或 `" alice "`):插入不冲突,`isRootUser("Alice")` 为真 -> 绕过注册审批当场发 JWT,
 * 之后每个请求都按 root 处理(重置任意账号密码、读全站审计日志、改任意项目属主)。
 * 攻击者不需要任何凭据 —— root 用户名不是秘密(审计页、项目属主、共享名单里到处都是)。
 *
 * 为什么改列的排序规则,而不是在注册处 lower 一下:注册只是其中一个入口,在某一处补归一化
 * 等于再加一份会漂的判据。`COLLATE NOCASE` 放在列上,`UNIQUE` 和所有 `WHERE username = ?`
 * 一次性变成大小写不敏感 —— 真源只有一个,以后新增查询也不会漏。
 *
 * 存量撞车(`alice` / `Alice` 两行并存)时直接建 NOCASE 唯一索引会失败,而删除或合并账号
 * 不可逆,不能替用户做主。做法:同组保留 id 最小的那行(最早注册,几乎必然是本人),其余
 * 重命名为 `<名字>~dup<id>` —— `isRootUser("Alice~dup4")` 为 false,冒充当场失效;账号数据
 * 一行不删,root 可以在管理页自行处置。顺带把所有用户名 `trim()` 一遍(前后空格是同一个洞)。
 *
 * 幂等:DDL 里已是 NOCASE 就直接返回。重建用写死的列清单,users 加列时必须同步改下面的
 * 建表语句与 INSERT(以及 REQUIRED_COLUMNS)。
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
        reviewed_by INTEGER,
        -- 这一列不在 schema.ts 的建表语句里(由迁移补上),而这份清单是写死的 ——
        -- 清单里漏掉的列会被这段重建抹掉:账号管理页报 500,每人的配额覆盖值一起丢失。
        -- 给 users 加列时,这份清单和下面的 INSERT 必须同步改,
        -- 文件尾的 verifyRebuiltTableColumns 会在漏改时当场报出来。
        attachment_quota_mb INTEGER
      )
    `);
    db.exec(`
      INSERT INTO users__new (
        id, username, password_hash, created_at, last_login, is_active,
        git_name, git_email, has_completed_onboarding, token_version,
        approval_status, approved_at, reviewed_by, attachment_quota_mb
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
        ${pick('reviewed_by', 'NULL')},
        ${pick('attachment_quota_mb', 'NULL')}
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

/**
 * `projects.owner_user_id` — NULL means unowned: visible to non-root users only
 * when the project sits under the public workspace directory.
 *
 * Added on its own rather than inside `rebuildProjectsTableWithPrimaryKeySchema`
 * because that rebuild only fires on pre-project_id schemas; installs that
 * already migrated would never see the column otherwise.
 */
const addProjectOwnerColumn = (db: Database): void => {
  const projectsTableInfo = db.prepare('PRAGMA table_info(projects)').all() as TableInfoRow[];
  const columnNames = projectsTableInfo.map((column) => column.name);
  addColumnToTableIfNotExists(db, 'projects', columnNames, 'owner_user_id', 'INTEGER');
};

/**
 * `projects.visibility` + `project_shares` —— 创建项目时的显式权限三选
 * (个人 / 公共 / 指定用户)。visibility='public' 对所有登录用户可见;
 * project_shares 逐用户授权。NULL / 无行时按默认语义(有主按 owner,
 * 无主仅 root、公共目录例外),所以存量数据无需迁移。
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
 * 全局的 isStarred=1 归属给项目 owner;无主项目的收藏归给全部 root 账号
 * (无主项目默认只有 root 看得到,标记只可能是 root 打的)。表已存在时
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

/**
 * 各表必须具备的列 —— 迁移末尾比对一次(verifyRebuiltTableColumns),也参与 schema 指纹
 * 与"有待跑迁移"的判定(见 init-db.ts)。
 *
 * 重建函数(如 rebuildUsersTableWithCaseInsensitiveUsername)的建表列清单是写死的:
 * 某列若由迁移后加、却没补进那份清单,重建就会连列带数据抹掉。而表在、行数对、
 * 用户名对,只有列集合不对 —— 不比对列集合就发现不了,直到某个页面 500。
 *
 * 不抛异常:列缺了固然是 bug,但让服务起不来是更大的事故,而且"重建后补跑加列"
 * 通常已经把列加回来了 —— 这一道的职责是让问题在日志里无法被忽略,不是当刹车。
 *
 * 加新列时:改 `REQUIRED_COLUMNS`,并检查对应重建函数的列清单。测试钉着两者一致。
 */
export const REQUIRED_COLUMNS: Record<string, string[]> = {
  users: [
    'id', 'username', 'password_hash', 'created_at', 'last_login', 'is_active',
    'git_name', 'git_email', 'has_completed_onboarding', 'token_version',
    'approval_status', 'approved_at', 'reviewed_by', 'attachment_quota_mb',
  ],
  // token_version 由 migrateApiKeysToHashed 加;relaxLegacyApiKeyNotNull 会按写死的列清单重建这张表。
  api_keys: [
    'id', 'user_id', 'key_name', 'api_key', 'api_key_hash', 'api_key_prefix',
    'created_at', 'last_used', 'is_active', 'token_version',
  ],
  // 反馈表(建表在 INIT_SCHEMA_SQL 里)。钉住列清单:将来有人重建这张表,
  // 漏列会在启动日志里被点名。下面几张表同理。
  message_feedback: [
    'id', 'session_id', 'project_id', 'message_id', 'message_uuid', 'user_id', 'source',
    'verdict', 'status', 'category', 'note', 'expected_output', 'skill_hint', 'task_id',
    'created_at', 'updated_at',
  ],
  // 模型目录。
  model_catalog: [
    'id', 'model_id', 'label', 'vendor', 'description', 'context_window', 'effort_levels', 'effort_default',
    'recommended', 'sort_order', 'enabled', 'is_default', 'last_probe', 'created_at', 'updated_at', 'updated_by',
    // 网关与可用人员(老库由迁移加列)
    'gateway_id', 'allowed_users',
  ],
  // 网关 / 个人 key / 私有模型。
  model_gateways: [
    'id', 'name', 'base_url', 'auth_type', 'default_key', 'default_key_last4', 'owner_user_id', 'enabled',
    'created_at', 'updated_at', 'updated_by',
  ],
  gateway_user_keys: ['id', 'gateway_id', 'user_id', 'key_enc', 'key_last4', 'set_by', 'updated_at'],
  user_models: [
    'id', 'user_id', 'gateway_id', 'model_id', 'label', 'vendor', 'context_window', 'effort_levels', 'effort_default',
    'enabled', 'sort_order', 'created_at', 'updated_at',
  ],
  // 每模型回合健康度。
  model_turn_stats: ['id', 'model', 'source', 'is_error', 'terminal_reason', 'ttft_ms', 'duration_ms', 'created_at'],
  // 夜训计划。
  skillwhet_nightly_plan: [
    'skill_name', 'enrolled', 'window_start', 'window_end', 'max_cost_usd', 'rounds', 'config_json',
    'min_new_tasks', 'copy_id', 'last_night', 'last_run_at', 'last_job_id', 'last_result', 'last_detail',
    'consecutive_noop', 'auto_paused_at', 'updated_by', 'updated_at',
  ],
};

/** @returns 每张表缺了哪些列(全齐时是空对象) */
export const findMissingColumns = (db: Database): Record<string, string[]> => {
  const missing: Record<string, string[]> = {};
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    if (!tableExists(db, table)) continue;
    const actual = new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as TableInfoRow[]).map((c) => c.name)
    );
    const gaps = required.filter((name) => !actual.has(name));
    if (gaps.length > 0) missing[table] = gaps;
  }
  return missing;
};

const verifyRebuiltTableColumns = (db: Database): void => {
  const missing = findMissingColumns(db);
  for (const [table, gaps] of Object.entries(missing)) {
    log.error(
      `[MIGRATION] 表 ${table} 缺列:${gaps.join(', ')} —— `
      + '多半是某个重建迁移的写死列清单漏了它。查 REQUIRED_COLUMNS 与对应的 rebuild* 函数。'
    );
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
    // 附件配额的每用户覆盖(MB)。NULL = 跟随全局默认
    // (PRISM_ATTACHMENT_QUOTA_MB),所以存量账号一行都不用动。
    addColumnToTableIfNotExists(db, 'users', userColumnNames, 'attachment_quota_mb', 'INTEGER');

    migrateApiKeysToHashed(db);

    db.exec(AUDIT_LOG_TABLE_SCHEMA_SQL);
    db.exec('CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON audit_log(user_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_audit_log_event ON audit_log(event)');

    db.exec(APP_CONFIG_TABLE_SCHEMA_SQL);
    db.exec(USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL);
    // 账号级界面偏好(权限清单 / 项目排序 / 编辑器偏好)。
    db.exec(USER_UI_SETTINGS_TABLE_SCHEMA_SQL);

    dropWebPushAndDesktopNotificationTables(db);
    dropPublishedPagesTable(db);

    // 用户名大小写不敏感(防止注册大小写变体冒充 root,详见函数注释)。
    // 放在前面:它重建 users 表,而后面的迁移可能读用户行。
    rebuildUsersTableWithCaseInsensitiveUsername(db);

    /*
     * 重建之后再补一次 users 的加列(幂等)—— 自愈层。
     *
     * 上面那批 addColumn 跑在重建之前,而重建是 DROP + 按写死的清单重建:清单漏一列,
     * 先加上的列就被抹掉,这一趟迁移里也没人补回来,要等下次启动才恢复。
     *
     * 三层防线,各治一种死法:
     *   ① 重建函数的列清单写全          → 列和数据都不丢(最要紧的一层);
     *   ② 这里重建后再跑一遍            → 万一清单漏改,列当场回来(数据仍然会丢);
     *   ③ 末尾的 verifyRebuiltTableColumns → 真漏了立刻在日志里报出来,而不是等某个页面 500。
     */
    const usersAfterRebuild = (db.prepare('PRAGMA table_info(users)').all() as { name: string }[])
      .map((column) => column.name);
    addColumnToTableIfNotExists(db, 'users', usersAfterRebuild, 'git_name', 'TEXT');
    addColumnToTableIfNotExists(db, 'users', usersAfterRebuild, 'git_email', 'TEXT');
    addColumnToTableIfNotExists(db, 'users', usersAfterRebuild, 'has_completed_onboarding', 'BOOLEAN DEFAULT 0');
    addColumnToTableIfNotExists(db, 'users', usersAfterRebuild, 'token_version', 'INTEGER NOT NULL DEFAULT 0');
    addColumnToTableIfNotExists(db, 'users', usersAfterRebuild, 'approval_status', "TEXT NOT NULL DEFAULT 'approved'");
    addColumnToTableIfNotExists(db, 'users', usersAfterRebuild, 'approved_at', 'DATETIME');
    addColumnToTableIfNotExists(db, 'users', usersAfterRebuild, 'reviewed_by', 'INTEGER');
    addColumnToTableIfNotExists(db, 'users', usersAfterRebuild, 'attachment_quota_mb', 'INTEGER');

    db.exec(PROJECTS_TABLE_SCHEMA_SQL);
    rebuildProjectsTableWithPrimaryKeySchema(db);
    addProjectOwnerColumn(db);
    addProjectVisibilityAndShares(db);
    // 顺序要紧:`addProjectStarsTable` 的搬迁读 `SELECT … FROM projects WHERE isStarred = 1`,
    // workspace 时代的数据必须先搬进 projects。那次搬迁是严格一次性的(`if (existing) return`),
    // 读到空表就永不重试 —— 老库的收藏会全丢(有登录用户时侧栏只认 project_stars)。
    migrateLegacyWorkspaceTableIntoProjects(db);

    addProjectStarsTable(db);
    rebuildSessionsTableWithProjectSchema(db);
    migrateLegacySessionNames(db);
    addProviderSessionIdMapping(db);
    addSessionArchivedAt(db);
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
     * 老库里那几条会一直留着白吃写开销(sessions 上约 15%)。
     * 名单与理由见 schema.ts 的 `RETIRED_INDEXES`。
     */
    for (const name of RETIRED_INDEXES) {
      db.exec(`DROP INDEX IF EXISTS ${name}`);
    }

    if (tableExists(db, 'workspace_original_paths')) {
      log.info('Running migration: Dropping legacy workspace_original_paths table');
      db.exec('DROP TABLE workspace_original_paths');
    }

    // 已下线的技能训练留下的数据,一次性清理(做过就不再做,见函数注释)
    removeSkillOptLeftovers(db);

    /**
     * 显示日志补 `provider_assistant_uuid` 列 —— 「编辑重跑」的分叉锚点。
     *
     * 可空、加列即可:不重建表、不改动任何既有行(历史行留 NULL,端点对它们
     * 退回扫 jsonl)。不建索引 —— 查询是
     * `WHERE session_id = ? AND id < ? AND provider_assistant_uuid IS NOT NULL
     *  ORDER BY id DESC LIMIT 1`,现有的 (session_id, id) 正好吃得到。
     */
    if (tableExists(db, 'session_display_messages')) {
      addColumnToTableIfNotExists(
        db,
        'session_display_messages',
        getTableInfo(db, 'session_display_messages').map((column) => column.name),
        'provider_assistant_uuid',
        'TEXT',
      );
    }

    /**
     * 审计日志补 `target_user_id` 列 —— "这条记录对谁做的"。
     *
     * 可空、加列即可,历史行留 NULL(它们本来也没有受影响者这个概念)。
     * 非 root 的审计可见范围据此扩成"我做的 OR 对我做的"(见 audit-log.ts)。
     * 索引在最后的 INDEX_SCHEMA_SQL 里统一建 —— 那时这一列一定已经在了。
     */
    if (tableExists(db, 'audit_log')) {
      addColumnToTableIfNotExists(
        db,
        'audit_log',
        getTableInfo(db, 'audit_log').map((column) => column.name),
        'target_user_id',
        'INTEGER',
      );
    }

    /**
     * 显示日志的孤儿行 —— 每次启动收一次。
     *
     * `session_display_messages` 没有外键,而它指向的会话行有好几条路径会消失:
     * 迁移里删幽灵项目的会话时不连带删日志;`projects` 行被删时 FK 是
     * `ON DELETE SET NULL`,会话行留下、`project_path` 变 NULL —— 那些会话此后只有
     * root 看得到,它们的日志再也没有任何入口能删。孤儿只增不减,而这是全库行数
     * 最大的表(8 万行约 108 MB)。
     *
     * 放在启动而不是写入时:孤儿是别处删东西产生的,写入路径上判不出来;
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

    /*
     * 模型目录的 gateway_id(走哪个网关)/ allowed_users(可用人员):新库建表时已带,老库在这里补。
     * 放在 INDEX_SCHEMA_SQL 之前 —— 若有索引引用这两列,那时列一定在。
     * 网关 / 个人 key / 私有模型三张表由 INIT_SCHEMA_SQL 的 CREATE TABLE IF NOT EXISTS 建。
     */
    if (tableExists(db, 'model_catalog')) {
      const catalogColumns = getTableInfo(db, 'model_catalog').map((c) => c.name);
      addColumnToTableIfNotExists(db, 'model_catalog', catalogColumns, 'gateway_id', 'INTEGER');
      addColumnToTableIfNotExists(db, 'model_catalog', catalogColumns, 'allowed_users', 'TEXT');
    }

    /**
     * 所有索引统一在这里建 —— 迁移末尾,那时每张表的列一定齐了。
     *
     * INIT_SCHEMA_SQL 跑在迁移之前,`CREATE TABLE IF NOT EXISTS` 对老库是空操作;索引若写在
     * 建表旁边,就可能引用一个迁移才补上的列,整句 `db.exec` 抛 → 服务起不来,而且 exec
     * 非原子,前面的 DDL 已经落库。所以 `INIT_SCHEMA_SQL` 里不许出现 CREATE INDEX,有测试钉着。
     * 在这之后才加的列(如下面的 copy_id),不能被 INDEX_SCHEMA_SQL 里的索引引用。
     */
    db.exec(INDEX_SCHEMA_SQL);

    db.exec(LAST_SCANNED_AT_SQL);

    // 夜训计划表的 copy_id:新库建表时已带,缺这一列的老表在这里补。
    if (tableExists(db, 'skillwhet_nightly_plan')) {
      const planColumns = (db.prepare('PRAGMA table_info(skillwhet_nightly_plan)').all() as TableInfoRow[]).map((c) => c.name);
      addColumnToTableIfNotExists(db, 'skillwhet_nightly_plan', planColumns, 'copy_id', 'TEXT');
    }

    // 列清单自检(见 REQUIRED_COLUMNS 的说明)。放在最后 —— 那时所有加列都跑过了。
    verifyRebuiltTableColumns(db);

    log.info('Database migrations completed successfully');
  } catch (error: any) {
    log.error('Error running migrations:', error.message);
    throw error;
  }
};
