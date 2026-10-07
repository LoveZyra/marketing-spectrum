export { sessionSynchronizerService } from './services/session-synchronizer.service.js';
export { providerSkillsService } from './services/skills.service.js';
export { providerMcpService } from './services/mcp.service.js';
export { seedDisplayLogFromTranscript } from './services/display-log-seed.service.js';
export { sessionsService, setSessionRuntimeReleaser } from './services/sessions.service.js';
export type { SessionActor, TrashedSessionListItem } from './services/sessions.service.js';
// 最近删除(会话回收站)的清扫器与保留期
export { startTrashSweeper, sweepExpiredTrash, getTrashRetentionDays } from './services/session-trash.service.js';
/**
 * 「这个人能不能拿这个 projectPath 做事」的唯一实现。
 * 会话路由(建会话)、任务路由(建/改定时任务)、MCP 路由(写 .mcp.json)三处共用;
 * 不要在调用方另写一份:判据一旦分叉,同一个项目就可能开得了会话却建不了任务。
 */
export { assertViewerMayCreateSessionAt } from './services/session-project-path-guard.service.js';
export { markInterruptedTurnsOnStartup, findInterruptedSessions, INTERRUPTED_TURN_NOTICE } from './services/interrupted-turn-marker.service.js';
export { startArchiveRetentionSweeper, sweepExpiredArchives, findExpiredArchivedSessions, getArchiveRetentionDays } from './services/archive-retention.service.js';
export { getHistoryCacheStats } from './list/claude/claude-sessions.provider.js';

export { initializeSessionsWatcher } from './services/sessions-watcher.service.js';
export { closeSessionsWatcher } from './services/sessions-watcher.service.js';
// ~/.claude/settings.json 的启动自检(跨会话拒收 / 两个工具禁用 / transcript 保留期 / env 冲突),只 warn
export { runClaudeSettingsSelfCheck, checkClaudeUserSettings } from './list/claude/claude-settings-selfcheck.js';
// 模型目录 —— 闸口 / 前置检查 / 别名解析 / 播种(websocket、tasks、agent、skillwhet 共用)
export {
  claudeModelCatalog,
  invalidateCatalogCache,
  ModelNotAllowedError,
  isModelAlias,
  modelViewerFor,
  seedModelCatalogOnce,
  type CatalogEntry,
  type ModelViewer,
} from './list/claude/claude-model-catalog.service.js';
// 模型网关与 key(选择器的"能不能用"、SkillWhet 只认网关 0)
export { modelsDefinitionFor, DEFAULT_GATEWAY_ID } from './list/claude/claude-gateways.service.js';
// 带 key 的 flag 设置文件:启动时清掉上一个进程留下的
export { sweepStaleFlagSettingsFiles } from './list/claude/claude-flag-settings-file.js';
// /cost 的分母要按"会话当前模型"查目录窗口(usage 路由不能 import claude-sdk.js)
export { providerModelsService } from './services/provider-models.service.js';
