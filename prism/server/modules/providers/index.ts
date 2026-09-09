export { sessionSynchronizerService } from './services/session-synchronizer.service.js';
export { providerSkillsService } from './services/skills.service.js';
export { providerMcpService } from './services/mcp.service.js';
export { seedDisplayLogFromTranscript } from './services/display-log-seed.service.js';
export { sessionsService } from './services/sessions.service.js';
/**
 * 「这个人能不能拿这个 projectPath 做事」的**唯一实现**。
 *
 * 会话路由(建会话)、任务路由(建/改定时任务)、MCP 路由(写 .mcp.json)三处共用。
 * 曾经任务路由自己内联了一份,两份漂开过 —— 一份跳过已登记项目的工作区重验、
 * 一份不跳(同一个项目开会话可以、建任务被挡),而且一份把服务端的 WORKSPACES_ROOT
 * 回显给了客户端。判据只能有一份。
 */
export { assertViewerMayCreateSessionAt } from './services/session-project-path-guard.service.js';
export { markInterruptedTurnsOnStartup, findInterruptedSessions, INTERRUPTED_TURN_NOTICE } from './services/interrupted-turn-marker.service.js';
export { startArchiveRetentionSweeper, sweepExpiredArchives, findExpiredArchivedSessions, getArchiveRetentionDays } from './services/archive-retention.service.js';
export { getHistoryCacheStats } from './list/claude/claude-sessions.provider.js';

export { initializeSessionsWatcher } from './services/sessions-watcher.service.js';
export { closeSessionsWatcher } from './services/sessions-watcher.service.js';
