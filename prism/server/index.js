#!/usr/bin/env node
// Load env vars before other imports execute. load-env.js also runs the
// one-time ~/.cloudcli -> ~/.prism data-dir migration, which must precede any
// import that opens the data dir (middleware/auth.js opens the auth DB).
import './load-env.js';
import fs from 'fs';
import path from 'path';
import http from 'http';

import express from 'express';
import compression from 'compression';
import cors from 'cors';

import { AppError, generateMessageId } from '@/shared/utils.js';
import { methodOverrideMiddleware } from '@/shared/method-override.js';
import { claudeModelCatalog, modelViewerFor, sweepStaleFlagSettingsFiles, closeSessionsWatcher, initializeSessionsWatcher, markInterruptedTurnsOnStartup, runClaudeSettingsSelfCheck, seedModelCatalogOnce, sessionsService, setSessionRuntimeReleaser, startArchiveRetentionSweeper, startTrashSweeper } from '@/modules/providers/index.js';
import { backgroundApprovalWriter, broadcastBackgroundTasks, broadcastRuntimeEvicted, createWebSocketServer, drainPendingSendForSession, forgetObservedRun, handleMergedMessageEvent, observeOrphanFrames } from '@/modules/websocket/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { createTasksRouter, startTaskScheduler, stopTaskScheduler } from '@/modules/tasks/index.js';
import { createFilesRouter, createFileDownloadRouter } from '@/modules/files/index.js';
import { pruneInternalProjects } from '@/modules/projects/services/project-prune.service.js';
import {
    createSystemPublicRouter,
    createUsageRouter,
    writeLocalServerMarker,
    removeLocalServerMarker,
} from '@/modules/system/index.js';
import { createLogger } from '@/shared/logger.js';
import { readReleaseInfo } from '@/shared/release-info.js';
import { scrubbedSessionMarkersAtStartup } from '@/shared/claude-runtime-env.js';
import { NightlyScheduler, SkillWhetClient, createSkillWhetRouter } from '@/modules/skillwhet/index.js';

import { getConnectableHost } from '../shared/networkHosts.js';

import { notifyRunFailed } from './services/notification-orchestrator.js';
import { findAppRoot, getModuleDir, getDataDir, migrateLegacyDataDir } from './utils/runtime-paths.js';
import {
    queryClaudeSDK,
    prewarmClaudeSession,
    setRuntimeEvictionNotifier,
    setOrphanTurnHook,
    setRuntimeDisposedHook,
    setMergedMessageHook,
    setBackgroundTasksHook,
    setBackgroundApprovalWriterFactory,
    cancelMergedMessage,
    mergeUserMessage,
    releaseClaudeSession,
    abortClaudeSDKSession,
    getActiveClaudeSDKSessions,
    disposeAllRuntimes,
    getToolApprovalSessionId,
    resolveToolApproval,
    getPendingApprovalsForSession,
    getClaudeContextUsage,
    getClaudeSlashCommands,
    describeClaudeRuntime,
    getRuntimePoolStats,
    stopClaudeBackgroundTask,
    backgroundClaudeForegroundTasks,
    rewindClaudeFiles,
    isClaudeSDKSessionActive,
    applyServerToolPolicy,
    describeBypassUnderRoot,
} from './claude-sdk.js';
import checkpointsRoutes, { findActiveRunForCwd } from './routes/checkpoints.js';
import documentsRoutes from './routes/documents.js';
import {
    stripAnsiSequences,
    normalizeDetectedUrl,
    extractUrlsFromText,
    shouldAutoOpenUrlFromOutput,
} from './utils/url-detection.js';
import { createMaProxyRouterFromEnv, MA_PROXY_PREFIX } from './routes/ma-proxy.js';
import { createRecsysProxyRouterFromEnv, RECSYS_PROXY_PREFIX } from './routes/recsys-proxy.js';
import { createMaServiceFromEnv } from './services/ma-service.js';
import { createSkillWhetServiceFromConfig, resolveSkillWhetConfig, startSkillWhetJobsPruner } from './services/skillwhet-service.js';
import { runStartupStep } from './utils/startup-step.js';
import authRoutes from './routes/auth.js';
import commandsRoutes from './routes/commands.js';
import settingsRoutes from './routes/settings.js';
import agentRoutes from './routes/agent.js';
import projectModuleRoutes from './modules/projects/projects.routes.js';
import providerRoutes from './modules/providers/provider.routes.js';
import { createSessionOutputsRouter, createSessionOutputDownloadRouter } from './modules/providers/session-outputs.routes.js';
import { assetsRoutes, attachmentUsageRoutes } from './modules/assets/index.js';
import { startAttachmentSweeper } from './shared/attachment-storage.js';
import { canViewerSeeSession, closeConnection, initializeDatabase, sessionMessagesDb, sessionsDb, stopDatabaseBackups, userDb } from './modules/database/index.js';
import { readRequestViewer } from './shared/project-visibility.js';
import { currentHolder } from './modules/websocket/services/conversation-ownership.service.js';
import { validateApiKey, authenticateToken, requireRoot, authenticateWebSocket, hasVerifiableCredential } from './middleware/auth.js';
import { createAdminRouter, backfillProjectOwners } from './modules/admin/index.js';
import { createPreviewRouter, createPreviewPublicRouter } from './modules/preview/index.js';
import { jupyterRoutes, createJupyterProxyHandler, handleJupyterUpgrade, stopJupyter } from './modules/jupyter/index.js';
import { apiRateLimiter, createRateLimiter, TRUST_PROXY } from './middleware/rate-limit.js';
import { consumeTicket } from './shared/ws-tickets.js';
import { listRootUsernames } from './shared/root-users.js';
import { trustProxyHops } from './shared/client-ip.js';
import { IS_PLATFORM } from './constants/config.js';
import { c } from './utils/colors.js';

const log = createLogger('boot');

const __dirname = getModuleDir(import.meta.url);
// The server source runs from /server, while the compiled output runs from /dist-server/server.
// Resolving the app root once keeps every repo-level lookup below aligned across both layouts.
const APP_ROOT = findAppRoot(__dirname);
// 安装方式固定为 npm(tar 包部署)。原来靠探测 APP_ROOT/.git 自动判定 —— 那条路径
// 已随 git 功能一并移除,残留的 .git 目录不该再改变服务行为。
const installMode = 'npm';
// Version of the RUNNING code, captured once at startup (deliberately not
// re-read per request: after an update, package.json is newer than this
// process — the mismatch tells the frontend a restart is pending).
const RUNNING_VERSION = (() => {
    try {
        return JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version || null;
    } catch {
        return null;
    }
})();
// v2.0.0:同一时刻再取一次发布信息(包里 RELEASE.json 的日期与提交号;从源码跑时没有)。
const RUNNING_RELEASE = readReleaseInfo(APP_ROOT);

log.info('SERVER_PORT from env:', process.env.SERVER_PORT);
// hm(A3.4):启动时删掉的会话标记(见 load-env.js)。
const scrubbedSessionMarkers = scrubbedSessionMarkersAtStartup();
if (scrubbedSessionMarkers.length > 0) {
    log.info(`清掉了继承来的 Claude 会话标记:${scrubbedSessionMarkers.join(', ')}(否则 Prism 起的 CLI 会被当成子会话、不写 transcript)`);
}

const app = express();
const server = http.createServer(app);

// Node's default requestTimeout (5 minutes) budgets the WHOLE request, body
// included, so it silently caps upload throughput rather than upload size: a
// 1GB file-tree upload only completes if the client sustains ~3.5MB/s for the
// full transfer. Widen the body budget so the multer fileSize limits are the
// real ceiling instead of the client's bandwidth.
//
// headersTimeout deliberately keeps its 60s default. Trickling *headers* is the
// slow-loris shape worth refusing quickly, and it is unaffected by how long a
// legitimate body takes; a slow body is already bounded by the per-route size
// limits and by multer discarding partial files on abort.
server.requestTimeout = 30 * 60 * 1000;

// Flipped once initializeSessionsWatcher() resolves; read by /api/ready.
let sessionsWatcherReady = false;

// Single WebSocket server that handles the chat and shell paths.
const wss = createWebSocketServer(server, {
    verifyClient: {
        isPlatform: IS_PLATFORM,
        authenticateWebSocket,
        // Single-use ?ticket= upgrade auth (see server/shared/ws-tickets.js).
        consumeTicket,
    },
    chat: {
        spawnFns: { claude: queryClaudeSDK },
        abortFns: { claude: abortClaudeSDKSession },
        // gc:真合流 —— 会话忙着时把用户这条话直接推进 CLI 的命令队列,
        // 而不是攒在 Prism 自己的排队里等这一轮跑完。不成立时自动退回排队。
        mergeFns: { claude: mergeUserMessage },
        // ho(ho-1):撤回一条还在 CLI 队列里的合流消息
        cancelMergedFns: { claude: cancelMergedMessage },
        getToolApprovalSessionId,
        resolveToolApproval,
        getPendingApprovalsForSession,
        // F14:打开一段对话即预热它的常驻运行时,把冷启动塞进"读上文 + 打字"
        // 那几秒里,而不是让用户按下回车之后再等。
        prewarmSession: prewarmClaudeSession,
    },
    // /jupyter/* 的 WebSocket(kernel channels 等)整体交给 jupyter 反代隧道。
    jupyterUpgrade: handleJupyterUpgrade,
    shell: {
        // 终端接管一段对话前,先把 chat 那边的常驻 runtime 放掉:一个持有者,
        // 而且 dispose 的收尾保证 transcript 完整落盘,终端 resume 才不会少一截。
        releaseConversation: (providerSessionId) => releaseClaudeSession(providerSessionId),
        // hm(A3.3):接管命令的 `--permission-mode` 过与对话同一份策略(bypass 名单、root 下的 bypass)。
        policeTakeoverPermissionMode: (requestedMode, actorUsername) => {
            const policed = applyServerToolPolicy(requestedMode, [], actorUsername, []);
            if (describeBypassUnderRoot(policed.permissionMode)) {
                return { mode: 'default', notice: '服务以 root 运行,「跳过权限」档位会被 CLI 拒绝 —— 接管按默认档位进入。' };
            }
            return {
                mode: policed.permissionMode,
                notice: policed.permissionMode !== requestedMode
                    ? `你不在 PRISM_ALLOW_BYPASS_USERS 名单里,接管按「${policed.permissionMode}」档位进入。`
                    : null,
            };
        },
        resolveProviderSessionId: (sessionId, provider) => {
            const dbSession = sessionsDb.getSessionById(sessionId);
            return dbSession ? (dbSession.provider_session_id ?? null) : null;
        },
        stripAnsiSequences,
        normalizeDetectedUrl,
        extractUrlsFromText,
        shouldAutoOpenUrlFromOutput,
    },
});

// Make WebSocket server available to routes
app.locals.wss = wss;

// F14:常驻进程被名额挤掉时,给还在看那段对话的人推一条状态帧。
// claude-sdk 不认识 websocket 层,由组合根接线。
setRuntimeEvictionNotifier(broadcastRuntimeEvicted);

/**
 * gk:永久删除一条会话之前先收掉它空闲着的常驻 runtime。
 *
 * 2026-09-14 的事故:行和 transcript 删掉之后,常驻 CLI 又活了半小时,被回收时按老路径
 * 写了两行收尾记录,同名文件"复活"成一个空壳。`releaseClaudeSession` 对"回合在飞"
 * 返回 released:false,删除路径据此拒绝(409)。同样由组合根接线 —— providers 不认识 claude-sdk。
 */
setSessionRuntimeReleaser((providerSessionId) => releaseClaudeSession(providerSessionId));

/**
 * gb:CLI 自己发起的那一轮(后台子代理完成通知、会话内定时任务)交给观测回合接住。
 * 同样由组合根接线 —— claude-sdk 不认识 run 注册表。不接线时行为退回改动前
 * (只计数、丢弃),所以这一行是这个功能的总开关。
 */
setOrphanTurnHook(observeOrphanFrames);
// hn(B2):runtime 被丢弃(换窗口重建、淘汰、回收)时,它开着的观测回合就地收掉。
setRuntimeDisposedHook(forgetObservedRun);
// ho(ho-1):合流消息的去向(停止时被撤 / 用户撤回 / 已送达)—— 落库那一行标记、在线端气泡跟着变。
setMergedMessageHook(handleMergedMessageEvent);
// ho(hq-1):后台任务全量表变了 —— 推给正在看这段对话的人(输入框上方的后台任务条)。
setBackgroundTasksHook(broadcastBackgroundTasks);
// ho(ho-3):主回合结束后,后台子代理要的审批送给正在看这段对话的人(不接线 = 原来的直接拒)。
setBackgroundApprovalWriterFactory(backgroundApprovalWriter);

// Behind nginx/Caddy the socket address is the proxy's. Opt-in only: trusting
// X-Forwarded-For unconditionally would let any direct client forge a fresh
// source IP per request and walk straight through the rate limiters below.
if (TRUST_PROXY) {
    // hj(审计 P2-5):`true` 让 req.ip 取 XFF 最左项(客户端可伪造);按层数信任才取对。
    app.set('trust proxy', trustProxyHops() || 1);
}

// JupyterLab 反代(/jupyter/* -> 127.0.0.1 上 Prism 托管的 lab 实例)。
// 挂载位置有讲究,三点都不能挪:
//   * 在 express.json 之前 —— notebook 保存(PUT /api/contents)的请求体要原样
//     流式透传,先解析再重序列化既费内存又可能改字节形态。
//   * 在全局安全头中间件之前 —— 那里给一切响应打 X-Frame-Options: DENY,而
//     lab 恰恰要装进自家 iframe(反代内部改打 SAMEORIGIN)。
//   * 限流单独给 —— lab 一次冷加载上百个静态资源,套 /api 的 600/min 会饿死;
//     鉴权(票据换 cookie)在反代内部,见 jupyter-proxy.service。
const jupyterRateLimiter = createRateLimiter({
    windowMs: 60_000,
    max: 3000,
    message: 'Too many Jupyter requests, slow down',
});
app.use('/jupyter', jupyterRateLimiter, createJupyterProxyHandler());

// Baseline security headers on every response (API and static alike).
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
});

// CORS: PRISM_CORS_ORIGINS (comma-separated) restricts allowed origins;
// unset keeps the historical permissive behavior (documented LAN/mobile use).
const corsOrigins = (process.env.PRISM_CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
// gzip/deflate。放在所有路由之前,静态资源和 API 一起覆盖。
//
// 值得的理由不在静态资源(866 kB 的入口块传成 253 kB 已经很可观),而在 API:
// `/api/providers/sessions/:id/messages` 在三千轮的会话上响应体是 42 MB,
// 未压缩直接过网;transcript 是 JSON,压缩比在 8–15 倍量级。
//
// threshold 1024:比这更小的响应压缩收益抵不过两边的 CPU。
// 已经压过的内容(Content-Encoding 已设)compression 自己会跳过。
// hj(审计 P2-1):**下载直传口不压缩。** 压缩会去掉 Content-Length、改成分块传输,
// 浏览器下载栏就只剩「已下载 XX MB」没有百分比 —— csv / txt / json / md 这类最常下的
// 文本文件,gw 做的原生进度条一直不生效。下载本来就是要原样落盘的字节,压它没有意义。
app.use(compression({
    threshold: 1024,
    // 用 originalUrl 不用 path:compression 的 filter 在**第一次写响应时**才调,那时请求已经进了
    // `app.use('/api/downloads', router)`,req.url / req.path 被挂载点剥成了 `/file`。
    filter: (req, res) => ((req.originalUrl || '').startsWith('/api/downloads/') ? false : compression.filter(req, res)),
}));

app.use(cors({
    ...(corsOrigins.length > 0 ? { origin: corsOrigins } : {}),
    exposedHeaders: ['X-Refreshed-Token', 'X-Prism-Truncated'],
}));

// dj:/api 一律禁缓存。这些 JSON 响应此前没有任何 Cache-Control 却带着 ETag,
// 浏览器磁盘缓存会把响应头(含 X-Refreshed-Token 静默续期头)一起存下;后续同
// URL 命中 304 时,按 RFC 7234 缓存里未被替换的旧头要合并回响应 —— 于是 A 账号
// 时代缓存下来的续期令牌,能在 B 账号登录后"复活"并把 B 的会话整个换成 A。
// 线上表现:退出 root 后无论登谁,最终都跳回 root;网络面板只看得到 304,
// 看不到被合并进来的头,极难排查。三件事一起断根:
//   * no-store —— 浏览器与合规代理都不再存 /api 响应,毒源断掉;
//   * Vary: Authorization —— 兜住只认 Vary 的中间层缓存,按用户分键;
//   * etag 关掉 —— /api 不再产生可供"304 合并"的响应(动态 JSON 上 ETag 本来
//     就没有收益,反而让历史毒缓存一直靠 304 续命)。静态资源走 express.static
//     自己的 ETag/Cache-Control,不受这个 app 级开关影响。
// SSE / 预览等自设缓存头的路由在各自 handler 里后写,照旧生效。
app.set('etag', false);
app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.vary('Authorization');
    next();
});

// ea:方法隧道 —— 前端把 PATCH/PUT/DELETE 一律作为 POST + X-HTTP-Method-Override
// 发出,这里在**任何路由之前**把 req.method 改回真实方法。只放行 GET/POST 的
// 企业代理(用户 Windows 机器实测:定时任务的启停开关 PATCH 发不出去)从此
// 挡不住这三种请求。见 shared/method-override.ts。必须在所有 router 之前。
app.use('/api', methodOverrideMiddleware());
// 启动日志留一行:线上排查"隧道到底生效没有"时 grep 这一句即可。
log.info(`方法隧道已启用:POST + X-HTTP-Method-Override / ?_method → PATCH/PUT/DELETE`);

// dm:慢请求日志。阈值毫秒,PRISM_SLOW_REQUEST_MS 覆盖,0 关闭,默认 2000。
// 只记一行 —— 方法、路径、状态码、耗时、用户。SSE 常开连接不算慢,跳过。
// 单线程服务器上,一个 2s 的请求就是所有人排队 2s;这行日志让"最近变卡了"
// 的排查从猜路由变成看日志。
const SLOW_REQUEST_MS = (() => {
    const parsed = parseInt(process.env.PRISM_SLOW_REQUEST_MS ?? '', 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2000;
})();
if (SLOW_REQUEST_MS > 0) {
    app.use('/api', (req, res, next) => {
        const startedAt = process.hrtime.bigint();
        res.on('finish', () => {
            const contentType = String(res.getHeader('Content-Type') || '');
            if (contentType.includes('text/event-stream')) return;
            const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
            if (elapsedMs < SLOW_REQUEST_MS) return;
            const user = req.user?.username || '-';
            log.warn(`[Slow] ${req.method} ${req.originalUrl} → ${res.statusCode} ${Math.round(elapsedMs)}ms user=${user}`);
        });
        next();
    });
}

// 营销诊断 API 反代(/api/ma/* -> 本机回环的诊断服务),PRISM_MA_API_TARGET 不配
// 就完全不挂载。位置是有讲究的,三点都不能挪:
//   * 在 express.json 之前 —— 这样请求体是原样透传的字节流,不用先解析再重新
//     序列化一遍(重新序列化会改动 JSON 的字节形态,下游按 64KB 收的体积上限
//     就对不准了)。
//   * 在 validateApiKey 之前 —— 外部调用方带的是诊断服务的 x-ma-api-key,不是
//     Prism 的 key;鉴权由下游自己做。
//   * 限流仍然在前 —— 显式挂 apiRateLimiter,因为这条路会在 /api 那道总限流
//     之前就把请求结掉,不显式挂就等于给 8080 开了一条不限流的通道。
const maProxyRouter = createMaProxyRouterFromEnv(process.env, console);
if (maProxyRouter) {
    app.use(MA_PROXY_PREFIX, apiRateLimiter, maProxyRouter);
    log.info(`营销诊断反代已挂载: ${MA_PROXY_PREFIX}/* -> ${maProxyRouter.maProxyTarget}`);
}

// recsys 反代(/recsys/* -> 本机回环的推荐算法点位监控),PRISM_RECSYS_TARGET 不配
// 就完全不挂载。位置的三条讲究与上面 ma-proxy 完全相同,不再重复;唯一要额外说的是
// 它挂在 Prism 的前端静态资源之前 —— 否则 /recsys 会先被前端路由接走。
const recsysProxyRouter = createRecsysProxyRouterFromEnv(process.env, console);
if (recsysProxyRouter) {
    app.use(RECSYS_PROXY_PREFIX, apiRateLimiter, recsysProxyRouter);
    log.info(`推荐算法点位反代已挂载: ${RECSYS_PROXY_PREFIX}/* -> ${recsysProxyRouter.recsysTarget}`);
} else {
    // 没配 PRISM_RECSYS_TARGET 时给一句人话。不接的话 /recsys 会一路掉到 SPA 的
    // catch-all,浏览器里看到的是 Prism 自己的界面套在一个奇怪地址上 —— 那比 404
    // 还难懂,而且会让人以为是前端坏了。欢迎页上那个"算法效果查询"是常驻入口,
    // 所以这条路必须有人接着。
    app.use(RECSYS_PROXY_PREFIX, apiRateLimiter, (req, res) => {
        res.status(503).type('html').send(
            '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
            + '<title>算法效果查询未配置</title></head>'
            + '<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1.5rem;line-height:1.7">'
            + '<h1 style="font-size:1.25rem">算法效果查询还没接上</h1>'
            + '<p>这台 Prism 没有配置 recsys 反代,所以 <code>/recsys</code> 后面没有东西。</p>'
            + '<p>在 Prism 的 <code>.env</code> 里加上这一行,然后重启:</p>'
            + '<pre style="background:#f4f4f5;padding:.75rem 1rem;border-radius:.375rem;overflow-x:auto">'
            + 'PRISM_RECSYS_TARGET=127.0.0.1:3010</pre>'
            + '<p style="color:#666;font-size:.9rem">目标必须是回环地址;上游 recsys 那边记得配 '
            + '<code>HOST=127.0.0.1</code>。</p></body></html>'
        );
    });
    log.info(`推荐算法点位反代未配置(PRISM_RECSYS_TARGET 未设置),${RECSYS_PROXY_PREFIX} 会给出配置提示页`);
}

// 反代只负责"转",不负责"上游是否活着"。配了 PRISM_MA_API_AUTOSTART 就顺带把上游那个
// Python 进程也由 Prism 拉起、由 Prism 收掉 —— 监听地址从 PRISM_MA_API_TARGET 反推,
// 从根上杜绝"反代指 8092、服务听 8091"这类两边日志都正常的故障。默认不配=不启动。
const maService = createMaServiceFromEnv(process.env, console);

// gy:技能优化(SkillWhet)。`PRISM_SKILLWHET_ENABLE=1` 才挂整层;`PRISM_SKILLWHET_AUTOSTART=1`
// 再由 Prism 拉起 `whet serve`(照 ma-service 那套:healthz、退避重启、退出一起收)。
// 不配就一个字不打、一条路由不挂、轨上没有那一格 —— 与 ma / recsys 同一规矩。
const skillWhetConfig = resolveSkillWhetConfig(process.env, console);
const skillWhetService = createSkillWhetServiceFromConfig(skillWhetConfig, console, process.env);
// he:夜训调度器 —— 只在技能优化挂载时跑;一个 skill 都没纳入就什么都不做(D3:默认零纳入)。
const skillWhetNightly = skillWhetConfig.enabled
    ? new NightlyScheduler({ client: new SkillWhetClient({ baseUrl: skillWhetConfig.baseUrl, token: skillWhetConfig.token }) })
    : null;
// hl:SkillWhet home 的 jobs/ 保留策略(PRISM_SKILLWHET_JOBS_RETENTION_DAYS,默认 90 天)—— 只在挂载时起。
let skillWhetJobsPruner = null;

// Public system endpoints (no authentication): GET /health (unchanged) and
// GET /api/ready (readiness probe). Mounted before the /api API-key gate.
app.use(createSystemPublicRouter({
    installMode,
    runningVersion: RUNNING_VERSION,
    runningRelease: RUNNING_RELEASE,
    isWatcherReady: () => sessionsWatcherReady,
}));

// Editor preview reads: GET /preview/:ticket/*. Authorized by a 5-minute
// ticket in the path because the sandboxed iframe sends no credentials.
app.use(createPreviewPublicRouter({ rateLimiter: apiRateLimiter }));
// hj:上面两个公开路由只有 GET、不需要请求体,排在 /api 限流之前 —— /api/ready 是 Docker 的
// HEALTHCHECK,同机反代时全员共用一个 IP 桶,排在限流之后的话桶一满健康检查就 429、容器被判不健康。

// hj(审计 P2-3):**限流挪到解析请求体之前**,请求体上限按「像不像登录用户」分两档。
//
// 原来 50MB 的 JSON 解析排在限流(原第 376 行)和鉴权之前:未登录的请求也能让服务器解析
// 50MB(实测 34MB 对象体阻塞事件循环 1.25 秒),限流拦不住。现在:
//   - 先过 /api 限流;
//   - 带着能验签的 JWT(或存在的 API key)→ 50MB(保存大文件、长对话要用);
//   - 其余(未登录、伪造的令牌)→ 1MB,注册 / 登录 / 票据接口都远用不到这么多。
// 真正的鉴权照旧在各路由上。urlencoded 没有任何接口需要大表单,统一 1MB。
app.use('/api', apiRateLimiter);
const jsonBodyType = (req) => {
    // Skip multipart/form-data requests (for file uploads like images)
    const contentType = req.headers['content-type'] || '';
    return contentType.includes('multipart/form-data') ? false : contentType.includes('json');
};
const largeJsonParser = express.json({ limit: '50mb', type: jsonBodyType });
const smallJsonParser = express.json({ limit: '1mb', type: jsonBodyType });
app.use((req, res, next) => (hasVerifiableCredential(req) ? largeJsonParser : smallJsonParser)(req, res, next));
app.use(express.urlencoded({ limit: '1mb', extended: true }));



// Rate limiting on every /api route.
//
// Prism binds 0.0.0.0 by default so phones and other LAN machines can reach
// it; this is the mitigation that choice requires. Deliberately mounted
// before validateApiKey so unauthenticated floods are capped too. Static
// assets and the SPA fallback are not limited — only the API surface is.
// (hj:/api 限流已挪到解析请求体之前,见上。)

// Optional API key validation (if configured)
app.use('/api', validateApiKey);

// Authentication routes (public)
app.use('/api/auth', authRoutes);

/**
 * POST /api/providers/:provider/sessions/:sessionId/prewarm
 *
 * Build a conversation's resident runtime before its next message instead of
 * inside it. The subprocess launch, SDK init and MCP server startup are the
 * same work either way — this just stops them landing on the user's first
 * turn, which is the whole reason chat felt slower than running `claude` in a
 * shell (there you watch it boot before you start typing).
 *
 * Best-effort by design: every failure answers 200 with `warmed:false`. A
 * pre-warm that could break a send would be worse than the latency it saves.
 *
 * Only conversations that already have a provider-native session id can be
 * warmed: the runtime map is keyed by that id, and a brand-new conversation
 * has none until its first turn announces one. Those still pay the cost.
 */
app.post('/api/providers/:provider/sessions/:sessionId/prewarm', authenticateToken, async (req, res) => {
    if (req.params.provider !== 'claude') {
        return res.json({ success: true, warmed: false, reason: 'unsupported_provider' });
    }

    try {
        const appSessionId = String(req.params.sessionId || '');
        const session = sessionsDb.getSessionById(appSessionId);
        if (!session?.provider_session_id) {
            return res.json({ success: true, warmed: false, reason: 'no_provider_session' });
        }

        // 终端正接管着这段对话时不能预热。chat 面板的预热 effect 会在会话 id、
        // 权限模式、模型、项目路径任一变化时重触发,而接管的动作恰恰是"先释放
        // chat 的常驻 runtime,再起 claude --resume" —— 预热若在这中间跑,就会
        // 再建一个进程 resume 同一段对话,正是所有权登记要消掉的双写。
        if (currentHolder(appSessionId)) {
            return res.json({ success: true, warmed: false, reason: 'held_by_shell' });
        }

        // 归属校验:预热会真的起一个 Claude 进程读这段对话的 transcript。
        if (!canViewerSeeSession(appSessionId, readRequestViewer(req))) {
            return res.status(404).json({ success: false, error: 'Session not found' });
        }

        const body = req.body || {};
        // hn(B2):选择框里是不在目录里 / 已下架的模型 → 不预热(静默;真发消息时 chat.send 会明说)。
        if (typeof body.model === 'string' && !(await claudeModelCatalog.isUsable(body.model, modelViewerFor(req.user?.id ?? null, req.user?.username ?? null)))) {
            return res.json({ success: true, warmed: false, reason: 'model_not_allowed' });
        }
        const result = await prewarmClaudeSession({
            sessionId: session.provider_session_id,
            resume: true,
            cwd: session.project_path || body.cwd || undefined,
            projectPath: session.project_path || undefined,
            permissionMode: body.permissionMode,
            toolsSettings: body.toolsSettings,
            model: body.model,
            effort: body.effort,
            // hq:按点开会话的这个人预热(网关 key、「可用人员」、私有模型)—— 否则预热出来的 runtime 用的是默认 key,
            // 第一条真消息因为网关指纹不同又得重建一次;私有模型 / 限人模型干脆预热失败
            actorUserId: req.user?.id ?? null,
            actorUsername: req.user?.username ?? null,
        });

        res.json({ success: true, ...result });
    } catch (error) {
        log.warn('[Prewarm] failed:', error?.message || error);
        res.json({ success: true, warmed: false, reason: 'error' });
    }
});

/**
 * GET  /api/providers/:provider/sessions/:sessionId/runtime
 * POST /api/providers/:provider/sessions/:sessionId/runtime/release
 *
 * ef:「常驻会话」从**猜**变成**可读可控**。
 *
 * 顶栏原来靠前端自己记"我这一页见过它在跑"来显示常驻状态 —— 刷新即忘,而且
 * 只能显示、不能关。这两个接口把常驻池的实情交出去:GET 报在不在 / 忙不忙 /
 * 哪个模型 / 空闲多久,POST release 释放(正在跑的回合不释放,照实回 reason)。
 * 打开常驻走既有的 prewarm 接口,不再另开一个。
 *
 * 归属校验与 prewarm 同一套:能看见这段会话才能查、才能释放。
 */
app.get('/api/providers/:provider/sessions/:sessionId/runtime', authenticateToken, (req, res) => {
    if (req.params.provider !== 'claude') {
        return res.json({ success: true, resident: false, reason: 'unsupported_provider' });
    }
    try {
        // 归属校验用的是**应用侧会话 id**(即路由参数)。会话行的主键列叫
        // `session_id`,行上根本没有 `id` —— eh 之前这里写成 `session.id`,
        // 于是永远拿 undefined 去校验、永远 404,前端把它读成"未常驻":
        // 点开常驻成功了,菜单里那行还是显示「未开」。
        const appSessionId = String(req.params.sessionId || '');
        const session = sessionsDb.getSessionById(appSessionId);
        if (!session) return res.status(404).json({ success: false, error: 'Session not found' });
        if (!canViewerSeeSession(appSessionId, readRequestViewer(req))) {
            return res.status(404).json({ success: false, error: 'Session not found' });
        }
        if (!session.provider_session_id) {
            return res.json({ success: true, resident: false, busy: false, reason: 'no_provider_session' });
        }
        return res.json({ success: true, ...describeClaudeRuntime(session.provider_session_id) });
    } catch (error) {
        log.warn('[Runtime] status failed:', error?.message || error);
        return res.json({ success: true, resident: false, busy: false, reason: 'error' });
    }
});

app.post('/api/providers/:provider/sessions/:sessionId/runtime/release', authenticateToken, async (req, res) => {
    if (req.params.provider !== 'claude') {
        return res.json({ success: true, released: false, reason: 'unsupported_provider' });
    }
    try {
        const appSessionId = String(req.params.sessionId || '');
        const session = sessionsDb.getSessionById(appSessionId);
        if (!session) return res.status(404).json({ success: false, error: 'Session not found' });
        if (!canViewerSeeSession(appSessionId, readRequestViewer(req))) {
            return res.status(404).json({ success: false, error: 'Session not found' });
        }
        // 终端接管期间的释放归终端管(它自己有一套所有权登记),这里不越界。
        if (currentHolder(appSessionId)) {
            return res.json({ success: true, released: false, reason: 'held_by_shell' });
        }
        if (!session.provider_session_id) {
            return res.json({ success: true, released: true, reason: 'not_resident' });
        }
        const result = await releaseClaudeSession(session.provider_session_id);
        return res.json({ success: true, ...result, ...describeClaudeRuntime(session.provider_session_id) });
    } catch (error) {
        log.warn('[Runtime] release failed:', error?.message || error);
        return res.json({ success: true, released: false, reason: 'error' });
    }
});

/**
 * ho(hq-1):后台任务条 —— 停掉一个后台任务 / 把正在跑的前台命令转到后台。
 * 归属校验与上面 runtime 状态同一套:能看见这段会话才能动它的任务(与"谁都能按停止"同口径)。
 */
function resolveClaudeRuntimeSession(req, res) {
    if (req.params.provider !== 'claude') {
        res.status(400).json({ success: false, error: 'unsupported_provider' });
        return null;
    }
    const appSessionId = String(req.params.sessionId || '');
    const session = sessionsDb.getSessionById(appSessionId);
    if (!session || !canViewerSeeSession(appSessionId, readRequestViewer(req))) {
        res.status(404).json({ success: false, error: 'Session not found' });
        return null;
    }
    if (!session.provider_session_id) {
        res.json({ success: true, done: false, reason: 'not_resident' });
        return null;
    }
    return session;
}

app.post('/api/providers/:provider/sessions/:sessionId/runtime/tasks/:taskId/stop', authenticateToken, async (req, res) => {
    try {
        const session = resolveClaudeRuntimeSession(req, res);
        if (!session) return;
        const result = await stopClaudeBackgroundTask(session.provider_session_id, String(req.params.taskId || ''));
        return res.json({ success: true, ...result });
    } catch (error) {
        log.warn('[Runtime] stop task failed:', error?.message || error);
        return res.json({ success: true, stopped: false, reason: 'error' });
    }
});

app.post('/api/providers/:provider/sessions/:sessionId/runtime/background', authenticateToken, async (req, res) => {
    try {
        const session = resolveClaudeRuntimeSession(req, res);
        if (!session) return;
        const toolUseId = typeof req.body?.toolUseId === 'string' && req.body.toolUseId ? req.body.toolUseId : null;
        const result = await backgroundClaudeForegroundTasks(session.provider_session_id, toolUseId);
        return res.json({ success: true, ...result });
    } catch (error) {
        log.warn('[Runtime] background failed:', error?.message || error);
        return res.json({ success: true, backgrounded: false, reason: 'error' });
    }
});

/**
 * ho(hq-2):非 git 目录「撤销这一轮之后的文件改动」。`dryRun: true`(默认)只列出会动哪些文件。
 * 能看见这段会话就能退 —— 与 git 检查点的还原同口径;有回合在跑时 409。
 */
app.post('/api/providers/:provider/sessions/:sessionId/runtime/rewind-files', authenticateToken, async (req, res) => {
    try {
        const session = resolveClaudeRuntimeSession(req, res);
        if (!session) return;
        const turnUuid = typeof req.body?.turnUuid === 'string' ? req.body.turnUuid : '';
        const dryRun = req.body?.dryRun !== false;
        /*
         * 复审修正:与预热、git 检查点还原同一套闸门。
         * - 终端正接管着这段对话 → 不许(没有常驻 runtime 时下面会预热一个 CLI resume 同一段 transcript = 双写);
         * - 这段对话在跑 → 409;
         * - 真撤销时同一目录下别的会话 / 一次性回合 / 定时任务在跑 → 409(会和它同时改同一棵树)。
         */
        if (currentHolder(session.session_id)) {
            return res.status(409).json({ success: false, ok: false, reason: 'held_by_shell', error: '这段对话正被终端接管 —— 先退出终端里的 claude 再撤销' });
        }
        if (isClaudeSDKSessionActive(session.provider_session_id)) {
            return res.status(409).json({ success: false, ok: false, reason: 'busy', error: '这段对话正在跑,等这一轮结束再撤销' });
        }
        if (!dryRun) {
            const activeRun = await findActiveRunForCwd(session.project_path).catch(() => null);
            if (activeRun) {
                return res.status(409).json({ success: false, ok: false, reason: 'cwd_busy', error: `同一目录下另一段对话(${activeRun.sessionId})正在跑,等它停下再撤销` });
            }
        }
        // hq:actor —— 没有常驻进程时按点「撤销」的人拉起(网关 key 按人)
        const rewindOptions = {
            cwd: session.project_path ?? null,
            runId: session.session_id,
            actorUserId: req.user?.id ?? null,
            actorUsername: req.user?.username ?? null,
        };
        // 真撤销的回包里 CLI 不列文件(实测 filesChanged 为空)—— 先预览一次拿到会动哪些文件,落 files_reverted 用
        let previewFiles = null;
        if (!dryRun) {
            const preview = await rewindClaudeFiles(session.provider_session_id, turnUuid, { ...rewindOptions, dryRun: true })
                .catch((error) => ({ ok: false, reason: 'error', error: error?.message || String(error) }));
            // 预览都不成(没常驻 / 没开检查点 / 在跑 / 退不了)—— 真撤销也不会成,直接回,别再预热一次(复审三轮)
            if (!preview?.ok) {
                if (preview?.reason === 'busy') return res.status(409).json({ success: false, ...preview, error: '这段对话正在跑,等这一轮结束再撤销' });
                return res.json({ success: true, ...preview, dryRun: false });
            }
            previewFiles = Array.isArray(preview.files) ? preview.files : [];
        }
        const result = await rewindClaudeFiles(session.provider_session_id, turnUuid, { ...rewindOptions, dryRun });
        if (result.reason === 'busy') return res.status(409).json({ success: false, ...result, error: '这段对话正在跑,等这一轮结束再撤销' });
        // 真撤销成功:落一条 files_reverted(与 git 检查点还原同一个反向帧),产出面板不再挂着已经撤掉的文件
        const touched = [...new Set([...(previewFiles ?? []), ...(Array.isArray(result.files) ? result.files : [])])];
        if (!dryRun && result.ok && touched.length > 0) {
            try {
                const base = session.project_path || '';
                // 只收撤销后**已经不在了**的文件(这一轮之后新建的)—— 与 git 检查点只收"新增"同口径;
                // 改过的老文件还在盘上,不能从更早几轮的产出里一起抹掉(复审二轮)
                const removed = touched
                    .map((file) => (path.isAbsolute(file) || !base ? file : path.join(base, file)))
                    .filter((absolute) => !fs.existsSync(absolute));
                if (removed.length > 0) sessionMessagesDb.append(session.session_id, {
                    id: `files_reverted_rewind_${turnUuid}_${Date.now()}`,
                    sessionId: session.session_id,
                    timestamp: new Date().toISOString(),
                    provider: 'claude',
                    kind: 'files_reverted',
                    cwd: null,
                    paths: removed,
                });
            } catch (error) {
                log.warn('[Runtime] rewind files_reverted frame append failed:', error?.message || error);
            }
        }
        return res.json({ success: true, ...result });
    } catch (error) {
        log.warn('[Runtime] rewind failed:', error?.message || error);
        return res.json({ success: true, ok: false, reason: 'error' });
    }
});

// Preview ticket endpoint. Mounted before the projects router because both
// answer under /api/projects and the projects router has a `/:projectId/...`
// catch-all that would otherwise swallow these paths.
app.use('/api/projects', createPreviewRouter({ authenticateToken }));

// Projects API Routes (protected)
app.use('/api/projects', authenticateToken, projectModuleRoutes);

// 定时任务(cj 轮):CRUD + 立即运行 + Claude 直建票据通道。
app.use('/api/tasks', createTasksRouter({ authenticateToken }));

// gy:技能优化。未启用时挂一个真 404(JSON)—— 不接的话 /api/skillwhet/* 会掉到 SPA 的
// catch-all 回 200 + index.html,前端虽然也能把它当"没有"(解析失败兜底),但 curl 排查时
// 看到一坨 HTML 只会让人以为路由坏了。
if (skillWhetConfig.enabled) {
    app.use('/api/skillwhet', createSkillWhetRouter({
        authenticateToken,
        client: new SkillWhetClient({ baseUrl: skillWhetConfig.baseUrl, token: skillWhetConfig.token }),
        config: skillWhetConfig,
    }));
    log.info(`技能优化已挂载: /api/skillwhet -> ${skillWhetConfig.label}(home=${skillWhetConfig.home}${skillWhetConfig.autostart ? ',由 Prism 拉起 serve' : ',serve 由外部起'})`);
} else {
    app.use('/api/skillwhet', (req, res) => {
        res.status(404).json({ success: false, error: '技能优化未启用(PRISM_SKILLWHET_ENABLE 未设置)', code: 'SKILLWHET_DISABLED' });
    });
    log.info('技能优化未启用(PRISM_SKILLWHET_ENABLE 未设置)');
}

// Account administration — approval queue. Root only (PRISM_ROOT_USERS).
app.use('/api/admin', createAdminRouter({
  authenticateToken,
  requireRoot,
  runningVersion: RUNNING_VERSION,
  runningRelease: RUNNING_RELEASE.label,
  // F6:常驻池快照注入(admin 模块不直接 import claude-sdk.js)。
  runtimePool: getRuntimePoolStats,
}));

// Chat image asset upload/serving (see server/modules/assets; protected)
app.use('/api/assets', authenticateToken, assetsRoutes);

// 附件用量:设置页里"我占了多少配额"那一块的数据源
app.use('/api/attachments', authenticateToken, attachmentUsageRoutes);
// 过期附件清扫:启动跑一次,之后每小时一轮。只删台账记过的文件。
startAttachmentSweeper();
// F8:归档保留期清扫。**默认关**(PRISM_ARCHIVE_RETENTION_DAYS 未配或为 0)——
// 永久删除不可逆,不能因为升级了一版就悄悄开始删用户的东西。
startArchiveRetentionSweeper({
    // gk:归档保留期到点 = 进最近删除(不再直接真删),再过 PRISM_TRASH_RETENTION_DAYS 才清扫。
    deleteSession: (sessionId) => sessionsService.deleteOrArchiveSessionById(sessionId, {
        force: true,
        deletedFromDisk: true,
        actor: null,
        via: 'retention',
    }),
});


// Checkpoints: per-turn git snapshots with transactional rollback (prism)
app.use('/api/checkpoints', authenticateToken, checkpointsRoutes);

// JupyterLab 控制面:状态查询 + 铸 iframe 入口票(反代本体挂在最前面,见上)。
app.use('/api/jupyter', authenticateToken, jupyterRoutes);

// Documents: text extraction (PDF/DOCX/PPTX/XLSX/…) + URL article fetch (prism)
app.use('/api/documents', authenticateToken, documentsRoutes);

// Native context usage for a live Claude conversation (prism). Stays here —
// it calls server/claude-sdk.js, which eslint boundaries keeps out of modules.
app.get('/api/claude/context-usage', authenticateToken, async (req, res) => {
    try {
        const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
        if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
        // 归属校验:相邻的 prewarm 有,这两条 /api/claude/* 当初漏了。
        if (!canViewerSeeSession(sessionId, readRequestViewer(req))) {
            return res.status(404).json({ error: 'Session not found' });
        }
        const usage = await getClaudeContextUsage(sessionId);
        if (!usage) return res.json({ available: false });
        res.json({ available: true, totalTokens: usage.totalTokens, maxTokens: usage.maxTokens, ratio: usage.ratio });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Prism: live CLI slash-command list for a session's resident runtime (same
// claude-sdk boundary reason as above). Accepts the APP session id.
app.get('/api/claude/slash-commands', authenticateToken, async (req, res) => {
    try {
        const appSessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
        if (!appSessionId) return res.status(400).json({ error: 'sessionId is required' });
        if (!canViewerSeeSession(appSessionId, readRequestViewer(req))) {
            return res.status(404).json({ error: 'Session not found' });
        }
        const row = sessionsDb.getSessionById(appSessionId);
        const providerSessionId = row?.provider_session_id || appSessionId;
        const commands = await getClaudeSlashCommands(providerSessionId);
        res.json({ available: Boolean(commands), commands: commands || [] });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Session usage endpoints (protected): fork-point at its original position;
// token-usage moved up next to it (no route in between matches that path).
app.use(createUsageRouter({ authenticateToken }));

// Remaining feature routers, mounted in the pre-refactor order. All are JWT
// protected except /api/agent (API-key auth for the external agent endpoint).
app.use('/api/commands', authenticateToken, commandsRoutes);
app.use('/api/settings', authenticateToken, settingsRoutes); // includes notification-preferences
// ei:会话产出文件读取。必须排在 providerRoutes **前面** —— 那个路由器里有
// `/sessions/:sessionId` 一类的通配段,会把 `/sessions/:id/output` 先吃掉。
app.use('/api/providers', createSessionOutputsRouter({ authenticateToken }));

/*
 * 「交给浏览器自己下」的直传口。**这三条不带登录态**,认的是一张 5 分钟失效、
 * 只指向一个目标的下载票 —— 一次普通导航设不了 Authorization 头,凭据只能进 URL
 * (EventSource 和沙箱预览撞的是同一堵墙,解法也一样)。
 *
 * **必须挂在 /api/downloads,不能挂在 /api/projects 下。** 上面那句
 * `app.use('/api/projects', authenticateToken, projectModuleRoutes)` 是**前缀中间件**,
 * 排在文件路由前面:任何 /api/projects/... 的请求都要先过它,一条靠票据的链接会被
 * 直接 401,而且失败形态和"票过期"一模一样,极难排查。换个前缀就与注册顺序彻底无关,
 * 顺带把"无认证面"收敛成一个可以一眼数清的前缀。
 */
app.use('/api/downloads', createFileDownloadRouter());
app.use('/api/downloads', createSessionOutputDownloadRouter());
app.use('/api/providers', authenticateToken, providerRoutes);
app.use('/api/agent', agentRoutes);

/*
 * gp:**dist 必须排在 public 前面。**
 *
 * 这两行原来是反的,于是 `public/` 里任何一个与构建产物同名的文件都会把真正的
 * 应用**盖掉**。2026-09-15 在测试环境上就是这么坏的:`public/` 里躺着一份
 * **2026-09-02 的旧构建**(`index.html` + `assets/`,谁手工拷进去的已不可考),
 * 而发布包里没有这两个路径,`tar --overwrite` 永远删不掉它 ——
 *
 *   - 打开 `http://host:8080/` 或 `/index.html` → public 那层先答 → **两周前的前端**;
 *   - 打开 `/session/xxx` 这种无扩展名深链 → 走到下面的 `app.get('*')` → dist/index.html
 *     → **当天的前端**。
 *
 * 同一台机器上"有时新版有时老版",就是这么来的:取决于你进的是根地址还是深链。
 * 而且 public 这层没有 setHeaders,老快照还是 `max-age=0` + 弱 ETag,
 * 在网络面板里只看得到 200/304,看不出自己吃的是哪一份。
 *
 * 调成 dist 优先之后:构建产物(含 vite 从 public/ 复制进去的那份静态资源)先答,
 * public 只兜底"构建之后才丢进去的文件"。再加 `index: false`,让它连
 * `/` 的目录索引都不接。
 */
// Static files after API routes; HTML uncached, hashed assets cached hard.
app.use(express.static(path.join(APP_ROOT, 'dist'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        } else if (filePath.match(/\.(js|css|woff2?|ttf|eot|svg|png|jpg|jpeg|gif|ico)$/)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
    }
}));

// Serve public files (like api-docs.html) — 只兜底 dist 里没有的那些。
app.use(express.static(path.join(APP_ROOT, 'public'), { index: false }));

// File CRUD, uploads, browse-filesystem, and file-tree endpoints (protected)
app.use(createFilesRouter({ authenticateToken }));

// Serve React app for all other routes (static-asset requests already got
// their chance in express.static above; anything with an extension 404s).
app.get('*', (req, res) => {
    if (path.extname(req.path)) {
        return res.status(404).send('Not found');
    }

    const indexPath = path.join(APP_ROOT, 'dist', 'index.html');
    if (fs.existsSync(indexPath)) {
        // No-cache headers on HTML prevent service worker issues after builds
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.sendFile(indexPath);
    } else {
        // In development, redirect to the Vite dev server when dist is absent
        const redirectHost = getConnectableHost(req.hostname);
        res.redirect(`${req.protocol}://${redirectHost}:${VITE_PORT}`);
    }
});

// global error middleware must be last
//
// 错误体形状统一:全站 245 处手写响应都是 `{ error: "<字符串>" }`,而所有前端消费
// 方(api.js、文件树、侧栏、向导…)读的也都是 `data.error` 当字符串。AppError 这条
// 分支原先把 `error` 写成 `{code,message,details}` 对象 —— 同名字段一边字符串一边
// 对象,前端 `data.error` 直接渲染就得到 "[object Object]"。这里对齐成:`error` 恒为
// 字符串(消息),结构化信息放同级的 `code` / `details`。
app.use((err, req, res, next) => {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      error: err.message,
      code: err.code,
      ...(err.details !== undefined ? { details: err.details } : {}),
    });
  }

  // hj:请求体解析失败(太大 / JSON 写坏 / 编码不认)是客户端的错,不是服务端的 500 ——
  // body-parser 自己带着 4xx 的 status 和 `type`。原来一律 500 并打一条 ERROR 带堆栈:
  // 未登录的人发一个超限请求体,日志里就多一条看着像故障的 ERROR。
  if (err && typeof err.type === 'string' && typeof err.status === 'number' && err.status >= 400 && err.status < 500) {
    const message = err.type === 'entity.too.large'
      ? 'Request body too large'
      : err.type === 'entity.parse.failed' ? 'Malformed JSON body' : 'Bad request body';
    return res.status(err.status).json({ success: false, error: message, code: 'BAD_REQUEST_BODY' });
  }

  log.error(err);

  return res.status(500).json({
    success: false,
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
  });
});

const SERVER_PORT = process.env.SERVER_PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const DISPLAY_HOST = getConnectableHost(HOST);
const VITE_PORT = process.env.VITE_PORT || 5173;
const LOCAL_SERVER_MARKER_PATH = path.join(getDataDir(), 'local-server.json');

const buildLocalServerMarker = () => ({
    pid: process.pid, host: HOST,
    port: Number.parseInt(String(SERVER_PORT), 10),
    url: `http://${DISPLAY_HOST}:${SERVER_PORT}`,
    installMode, appRoot: APP_ROOT,
    updatedAt: new Date().toISOString(),
});

// ── Graceful shutdown ────────────────────────────────────────────────────────
/**
 * hl(静态 P2-25):此前是 8s,而 prism.sh 6s 就 kill -9,两个受管子进程又各串行等 4s ——
 * 两个都开着时数据库关闭那一步永远轮不到。现在:子进程并行停(最多 4s),这里 12s,
 * prism.sh 等 15s;并且硬退出前也会同步关一次数据库(见 hardExitTimer)。
 */
const SHUTDOWN_HARD_EXIT_MS = 12_000;
let shutdownInProgress = false;

// Runs one cleanup step; failures are logged, never rethrown.
async function shutdownStep(label, fn) {
    try {
        await fn();
    } catch (err) {
        log.error(`[Shutdown] ${label} failed:`, err?.message || err);
    }
}

// Single shutdown path for SIGTERM/SIGINT. Idempotent: a second signal is
// ignored; the hard-exit timer still guarantees termination.
async function shutdown(signal) {
    if (shutdownInProgress) {
        log.info(`[Shutdown] ${signal} received while already shutting down — ignoring`);
        return;
    }
    shutdownInProgress = true;
    log.info(`[Shutdown] ${signal} received — closing (hard exit in ${SHUTDOWN_HARD_EXIT_MS / 1000}s)`);

    const hardExitTimer = setTimeout(() => {
        log.error('[Shutdown] Cleanup exceeded time limit — forcing exit');
        // hl(静态 P2-25):就算前面哪一步卡死了,数据库也要关干净 —— close 是同步的,
        // 几毫秒的事;不关的话 WAL 留在需要恢复的状态上,下次启动多一次恢复。
        try { stopDatabaseBackups(); closeConnection(); } catch (err) {
            log.error('[Shutdown] database close on hard exit failed:', err?.message || err);
        }
        process.exit(1);
    }, SHUTDOWN_HARD_EXIT_MS);
    hardExitTimer.unref();

    // Stop accepting new HTTP connections (not awaited: idle keep-alive
    // sockets can hold close() open past the hard-exit window).
    await shutdownStep('http close', () => {
        server.close(() => log.info('[Shutdown] HTTP server closed'));
    });

    // Terminate WS clients, then close the WS server. Terminating shell
    // sockets fires their close handlers, which kill the PTYs (the shell
    // service exports no separate cleanup registry).
    await shutdownStep('websocket close', () => {
        for (const client of wss.clients) {
            try { client.terminate(); } catch { /* socket already gone */ }
        }
        wss.close();
    });

    // F14c:优雅关停(部署重启)时,给每个**在跑**的会话补一条「回合被中断」——
    // 落进显示日志,重启后打开会话即见,且它是收尾错误行,cb 轮的「重发上一条
    // 消息」按钮会自动出现,一键续上。强杀(kill -9)写不了,认了。
    await shutdownStep('task scheduler stop', () => stopTaskScheduler());

    await shutdownStep('interrupted-run markers', () => {
        const running = chatRunRegistry.listRunningRuns();
        for (const run of running) {
            sessionMessagesDb.append(run.sessionId, {
                id: generateMessageId('restart'),
                sessionId: run.sessionId,
                timestamp: new Date().toISOString(),
                provider: run.provider,
                kind: 'error',
                content: '服务已重启,这一回合被中断。点下方「重发上一条消息」可继续。',
            });
        }
        if (running.length > 0) log.info(`[Shutdown] Marked ${running.length} interrupted run(s)`);
    });

    // Abort in-flight Claude runs (sessions with a live turn)…
    await shutdownStep('claude aborts', async () => {
        const activeSessionIds = getActiveClaudeSDKSessions() || [];
        if (activeSessionIds.length === 0) return;
        log.info(`[Shutdown] Aborting ${activeSessionIds.length} active Claude session(s)`);
        await Promise.allSettled(
            activeSessionIds.map((sessionId) => Promise.resolve(abortClaudeSDKSession(sessionId)))
        );
    });

    // …then dispose the idle resident pool. abort above only touches sessions
    // with a live turn; idle runtimes (up to MAX_RUNTIMES claude subprocesses)
    // would otherwise be left for process.exit to sever implicitly. Dispose
    // them explicitly so every subprocess is closed cleanly.
    await shutdownStep('claude runtime dispose', async () => {
        const disposed = await disposeAllRuntimes();
        if (disposed > 0) log.info(`[Shutdown] Disposed ${disposed} idle Claude runtime(s)`);
    });

    // JupyterLab 子进程(SIGTERM;kernel 落盘由 jupyter 自己负责)。
    await shutdownStep('jupyter stop', () => stopJupyter());

    await shutdownStep('sessions watcher close', () => closeSessionsWatcher());
    // 受管子进程(营销诊断、SkillWhet serve)。放在这儿(而不是最后)是因为它们可能正在
    // 跑一单几十分钟的活,SIGTERM 之后要给一点收尾时间,别挤到硬退出的窗口末尾去。
    // hl(静态 P2-25):**并行**停 —— 各自最多等 4s TERM 宽限,串行就是 8s,数据库关闭
    // 那步永远轮不到。夜训调度器只是清定时器,顺带并进来。
    await shutdownStep('child services stop', () => Promise.allSettled([
        shutdownStep('ma service stop', () => maService?.stop()),
        shutdownStep('skillwhet nightly stop', () => skillWhetNightly?.stop()),
        shutdownStep('skillwhet jobs pruner stop', () => skillWhetJobsPruner?.stop()),
        shutdownStep('skillwhet service stop', () => skillWhetService?.stop()),
    ]));
    // Runtime services — the same set the pre-refactor handler stopped.
    await shutdownStep('server marker removal', () => removeLocalServerMarker(LOCAL_SERVER_MARKER_PATH));
    // Database last so every step above could still use it. Stop the backup
    // timer first — an incremental `db.backup()` firing mid-close would reopen the handle.
    await shutdownStep('database backup timer stop', () => stopDatabaseBackups());
    await shutdownStep('database close', () => closeConnection());

    process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

/**
 * 进程级兜底。**这是一台多用户服务器**,一个人的一次意外不该把所有人的会话、
 * 终端和定时任务一起带走。
 *
 * package.json 要求 node >= 22,而 Node >= 15 的 `--unhandled-rejections` 默认是
 * `throw` —— 也就是说在补上这两条之前,任何一个没 catch 的 promise、任何一个没挂
 * 监听器的流 error,都是**整机退出**。
 *
 * 两种事故分开对待(hl,静态 P1-13):
 *
 * - `uncaughtException`:同步栈上抛出来没人接,状态已经不可信(半开的事务、半写的
 *   transcript)。带着不可信的状态继续服务,比重启一次更糟 —— 走 `shutdown()` 退出,
 *   让数据库、备份定时器、子进程收尾(裸崩会把 WAL 留在需要恢复的状态上),然后交给
 *   prism.sh 的守护循环拉起来。`shutdown` 自己有硬退出窗口,所以不会卡死在这里。
 * - `unhandledRejection`:**只记日志,不退出。** 一个没 catch 的 promise 几乎总是某个
 *   请求 / 某个会话自己的事(它那条链路已经断了),让所有人一起断线并不能让谁的状态
 *   更可信 —— 而在 Node 22 的默认下它和 uncaughtException 同样是整机退出。审计时线上
 *   多次"全员掉线"都是这一类。日志里带 `[UNHANDLED]` 前缀,排障时 grep 它。
 */
const fatal = (kind) => (error) => {
  log.error(`[FATAL] ${kind}:`, error);
  // shutdown 自身再抛就真没救了,兜一层直接退,别形成递归。
  try {
    void shutdown(kind);
  } catch (shutdownError) {
    log.error('[FATAL] shutdown 自身失败,直接退出:', shutdownError);
    process.exit(1);
  }
};

process.on('uncaughtException', fatal('uncaughtException'));
process.on('unhandledRejection', (reason) => {
  log.error('[UNHANDLED] unhandledRejection(只记日志,服务继续):', reason);
});

// Initialize database and start server
/**
 * `public/` 本该只有图标、品牌图、api-docs 这类随仓库走的静态文件。
 * 出现 `index.html` 或 `assets/` 就说明有人往里拷过一份构建产物 ——
 * 发布包里没有这两个路径,`tar --overwrite` 删不掉,它会一直留在那里。
 */
function warnAboutStalePublicBuild() {
    const publicDir = path.join(APP_ROOT, 'public');
    const strays = ['index.html', 'assets'].filter((name) => fs.existsSync(path.join(publicDir, name)));
    if (strays.length === 0) return;
    log.warn(
        `[static] public/ 里有构建产物残留:${strays.join('、')} —— 它不来自发布包,`
        + `升级时不会被覆盖或删除。dist/ 已排在它前面,应用不受影响,但建议手工移走:`
        + `mv ${strays.map((name) => path.join(publicDir, name)).join(' ')} <别处>`,
    );
}

async function startServer() {
    try {
        // Data-dir migration safety net: the effective call runs in load-env.js
        // before any import can open the auth DB; this one is an idempotent
        // no-op unless startup order ever changes.
        migrateLegacyDataDir();

        // Initialize authentication database
        await initializeDatabase();

        // One-shot: hand pre-existing projects to the root account. Runs after
        // migrations (the columns must exist) and is a no-op once its
        // app_config flag is set, or while no configured root has registered.
        backfillProjectOwners();

        /**
         * gk:最近删除的清扫。默认 30 天(PRISM_TRASH_RETENTION_DAYS;显式 0 = 永不自动清)。
         * 启动跑一次(停机期间积压的最多),之后每 6 小时一轮。
         *
         * **必须在 initializeDatabase 之后** —— 第一件事就是查 `session_trash`。
         * 放在模块顶层时,首次升级那一次开机它必定撞 `no such table` 并被吞掉,
         * 于是"启动跑一次"在最需要它的那一次(升级后第一次开机)从来没跑过。
         */
        startTrashSweeper();

        /*
         * gp:`public/` 里如果躺着一份旧构建,开机时喊一声。
         *
         * 挂载顺序已经改成 dist 优先(见上面那段),所以这份残留不再能盖掉应用;
         * 但它仍然是"部署包永远删不掉、又占着盘"的东西 —— 而且下次谁把顺序改回去,
         * 症状会一模一样地回来(根地址是两周前的前端,深链是新的)。
         * 与其让人再查一次,不如开机就把路径念出来。
         */
        warnAboutStalePublicBuild();

        // F14:给「回合跑到一半被重启打断」的会话补一条「请重发」标记。
        // **必须在这一刻做** —— 判据是"日志最后一条是用户消息",而正在流式输出
        // 的会话看起来一模一样;进程刚起来时不存在这种会话,晚一秒都可能误伤。
        markInterruptedTurnsOnStartup();

        // 首次部署最容易踩的坑:PRISM_ROOT_USERS 配空或拼错 → 没人是 root →
        // 没人能开审批队列 → 同事注册后全部卡在待审、登不进,而产品里没有任何提示。
        // 至少在启动日志里喊一声,让运维一眼看到。
        if (listRootUsernames().length === 0) {
            log.warn('');
            log.warn(`PRISM_ROOT_USERS 为空 —— 没有任何管理员。`);
            log.warn('       后果:设置页看不到「账号」标签,新注册的账号会永远卡在待审批、无人能批。');
            log.warn('       解决:在 .env 里设 PRISM_ROOT_USERS=<你的用户名>(用该名字注册后即为 root),然后重启。');
            log.warn('');
        }

        // hj(审计 P0-2):名单里**还没注册**的名字,谁先注册谁就是 root(注册即 approved)。
        // 部署时写好名单、本人还没来注册的那段时间,这是一个谁都能捡的管理员位。
        for (const rootName of listRootUsernames()) {
            if (!userDb.getUserByUsername(rootName)) {
                log.warn(`PRISM_ROOT_USERS 里的「${rootName}」还没有注册(或已停用)—— 谁先用这个名字注册,谁就是管理员。请本人尽快注册,或从名单里去掉。`);
            }
        }

        // Production mode = a built dist folder exists
        const distIndexPath = path.join(APP_ROOT, 'dist', 'index.html');
        const isProduction = fs.existsSync(distIndexPath);

        // v2.0.0:第一眼就知道跑的是哪个版本(部署后核对用)
        log.info(`Prism ${RUNNING_RELEASE.label ?? '(版本号读不到)'}`);
        log.info(`Using Claude Agents SDK for Claude integration`);
        log.raw('');

        if (isProduction) {
            log.info(`To run in production mode, go to http://${DISPLAY_HOST}:${SERVER_PORT}`);
        }

        log.info(`To run in development mode with hot-module replacement, go to http://${DISPLAY_HOST}:${VITE_PORT}`);

        server.listen(SERVER_PORT, HOST, async () => {
            const appInstallPath = APP_ROOT;
            // 定时任务调度器:服务就绪即装载(执行走与网页聊天同一条 run 通道)。
            // 超时后要能真的掐掉回合(否则子进程继续写同一份 transcript,下一拍
            // 又起第二个进程),回合结束后要能放行排队的网页消息 —— 两个能力都由
            // 这里注入,tasks 模块不直接 import claude-sdk(模块边界 + 防环)。
            try {
                startTaskScheduler(queryClaudeSDK, {
                    abortClaudeRun: (runId) => abortClaudeSDKSession('', { runId }),
                    drainPendingSend: drainPendingSendForSession,
                    // 任务失败要有人知道 —— 无人值守正是定时任务存在的理由。
                    // 走与回合失败同一条编排(偏好闸 + 去重 + 通道),不另开一套。
                    notifyTaskFailed: ({ userId, sessionId, taskName, error }) => {
                        notifyRunFailed({
                            userId,
                            provider: 'system',
                            sessionId,
                            error: `定时任务「${taskName}」执行失败:${error}`,
                            sessionName: taskName,
                        });
                    },
                });
            } catch (error) {
                log.warn('[Tasks] 调度器启动失败:', error?.message || error);
            }
            /**
             * 清掉 Prism 自己跑 CLI 留下的幽灵项目行(目前只剩模型探测那一种)。
             *
             * 忽略判据只挡住"新的进不来",挡不住**已经在库里的** —— 侧栏是直接
             * 读表的。这一步按真实路径清账,每次启动跑一次(判据很窄,平时是空转)。
             */
            try {
                const { removed } = pruneInternalProjects();
                if (removed.length > 0) {
                    log.info(`清理了 ${removed.length} 个 Prism 自己跑出来的幽灵项目`);
                }
            } catch (error) {
                log.warn('[Projects] 幽灵项目清理失败:', error?.message || error);
            }
            await writeLocalServerMarker(LOCAL_SERVER_MARKER_PATH, buildLocalServerMarker()).catch((error) => {
                log.warn('Could not write local server marker:', error.message);
            });

            // 启动横幅走 log.raw():这几行的**排版本身就是内容**,
            // 每行前面挂上时间戳和级别只会把框线冲垮。日志分级管的是流水,
            // 不管这种一次性的招牌。
            log.raw('');
            log.raw(c.dim('═'.repeat(63)));
            log.raw(`  ${c.bright('Prism Server - Ready')}`);
            log.raw(c.dim('═'.repeat(63)));
            log.raw('');
            log.raw(`${c.info('[INFO]')} Server URL:  ${c.bright('http://' + DISPLAY_HOST + ':' + SERVER_PORT)}`);
            log.raw(`${c.info('[INFO]')} Installed at: ${c.dim(appInstallPath)}`);
            log.raw(`${c.tip('[TIP]')}  Run "prism status" for full configuration details`);
            log.raw('');

            // hl 复核(P3):下面各段各自兜底、互不连坐 —— 会话监听起不来,营销诊断 / 技能优化 /
            // 作业清理照样要起(见 utils/startup-step.js)。
            // 受管子进程先发起(不 await:它们要等 healthz,慢的时候几十秒,不该拖着启动流程;
            // 起不来也只是对应的 /api/ma/*、/api/skillwhet/* 不可用,Prism 其余功能不受影响)。
            // hm:~/.claude/settings.json 自检(只 warn,不改文件;日志前缀「claude 设置自检」)。
            await runStartupStep('claude settings self-check', () => runClaudeSettingsSelfCheck(log), log);
            // hq(复审 P1):上一个进程留下的带 key 的 flag 设置文件(它的 CLI 子进程早已退出)
            await runStartupStep('flag settings sweep', () => {
                const removed = sweepStaleFlagSettingsFiles();
                if (removed > 0) log.info(`[网关] 清掉上一个进程留下的 ${removed} 个 flag 设置文件`);
            }, log);
            // hn(B1):模型目录首次播种(按 settings.json 的别名映射;播过一次就不再播,见 seedModelCatalogOnce)。
            await runStartupStep('model catalog seed', async () => {
                const { seeded, added } = await seedModelCatalogOnce();
                if (seeded) {
                    log.info(`[模型目录] 首次播种:${added.length > 0 ? added.join(', ') : '(settings.json 里没有可播的网关模型名,请在设置页手动添加)'}`);
                } else {
                    log.info(`[模型目录] 共 ${claudeModelCatalog.listAll().length} 条,上架 ${claudeModelCatalog.listEnabled().length} 条,默认 ${claudeModelCatalog.defaultModel()}`);
                }
            }, log);
            void runStartupStep('ma service start', () => maService?.start(), log);
            // gy:技能优化的 serve 同样不 await、起不来只影响 /api/skillwhet/*。
            void runStartupStep('skillwhet service start', () => skillWhetService?.start(), log);
            await runStartupStep('skillwhet nightly start', () => skillWhetNightly?.start(), log);
            await runStartupStep('skillwhet jobs pruner start', () => {
                skillWhetJobsPruner = startSkillWhetJobsPruner(skillWhetConfig, { env: process.env, logger: console });
            }, log);

            // Start watching the projects folder for changes.失败时 sessionsWatcherReady 保持 false,
            // /api/ready 如实报 pending,而不是假装就绪。
            if (await runStartupStep('sessions watcher', () => initializeSessionsWatcher(), log)) {
                sessionsWatcherReady = true;
            }
        });
    } catch (error) {
        log.error('Failed to start server:', error);
        process.exit(1);
    }
}

startServer();
