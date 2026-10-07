export { initializeDatabase, startDatabaseBackups, stopDatabaseBackups } from '@/modules/database/init-db.js';
export { backupDatabase, closeConnection, getConnection, getDatabasePath } from '@/modules/database/connection.js';
export { canViewerSeeSession, canViewerManageSession } from '@/modules/database/session-visibility.js';
export { canViewerSeeProjectPath, projectVisibilityInput, resolveVisibleProjectRoot } from '@/modules/database/project-access.js';
export { NO_SUCH_USER_ID, type VisibilityScope } from '@/modules/database/visibility-sql.js';
export { apiKeysDb } from '@/modules/database/repositories/api-keys.js';
export { auditLogDb } from '@/modules/database/repositories/audit-log.js';
export type { AuditEntry, AuditEvent, AuditRow } from '@/modules/database/repositories/audit-log.js';
export { appConfigDb } from '@/modules/database/repositories/app-config.js';
export { isDurableDisplayMessage, sessionMessagesDb } from '@/modules/database/repositories/session-messages.db.js';
export { credentialsDb } from '@/modules/database/repositories/credentials.js';
export { githubTokensDb } from '@/modules/database/repositories/github-tokens.js';
export { notificationPreferencesDb } from '@/modules/database/repositories/notification-preferences.js';
export { projectsDb } from '@/modules/database/repositories/projects.db.js';
export { scanStateDb } from '@/modules/database/repositories/scan-state.db.js';
export { scheduledTasksDb } from '@/modules/database/repositories/scheduled-tasks.db.js';
export { taskRunHistoryLimit } from '@/modules/database/repositories/scheduled-tasks.db.js';
export type { ScheduledTaskRow, ScheduledTaskInsert, ScheduledTaskRunRow, TaskFrequency, TaskSessionMode } from '@/modules/database/repositories/scheduled-tasks.db.js';
export { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
export { sessionTrashDb } from '@/modules/database/repositories/session-trash.db.js';
export type { SessionTrashRow, TrashDeletedVia } from '@/modules/database/repositories/session-trash.db.js';
export { uiSettingsDb, type UiSettingsRecord } from '@/modules/database/repositories/ui-settings.db.js';
export { skillWhetNightlyDb, NIGHTLY_AUTOPAUSE_AFTER, type NightlyPlanRow, type NightlyPlanInput, type NightlyResult } from '@/modules/database/repositories/skillwhet-nightly.db.js';
export { messageFeedbackDb, type MessageFeedbackRow, type SkillFeedbackStats, type FeedbackSource, type FeedbackStatus } from '@/modules/database/repositories/message-feedback.db.js';
export { userDb } from '@/modules/database/repositories/users.js';
export type { ApprovalStatus, UserAdminRow } from '@/modules/database/repositories/users.js';
export { attachmentsDb, type AttachmentKind, type AttachmentRecord } from '@/modules/database/repositories/attachments.db.js';
export { usageRecordsDb, deriveCostDelta } from '@/modules/database/repositories/usage-records.db.js';
export type { UsageRecordInput, UsageRecordRow, UsageSummaryRow, UsageSource } from '@/modules/database/repositories/usage-records.db.js';
// 模型目录(选择器里的网关模型、各自的窗口与档位)
export { modelCatalogDb, type ModelCatalogRow, type ModelCatalogWrite } from '@/modules/database/repositories/model-catalog.db.js';
export { modelTurnStatsDb, type ModelTurnSummary } from '@/modules/database/repositories/model-turn-stats.db.js';
export {
  gatewayUserKeysDb,
  modelGatewaysDb,
  userModelsDb,
  type GatewayUserKeyRow,
  type ModelGatewayRow,
  type ModelGatewayWrite,
  type UserModelRow,
  type UserModelWrite,
} from '@/modules/database/repositories/model-gateways.db.js';
