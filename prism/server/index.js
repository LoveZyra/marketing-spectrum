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
import { closeSessionsWatcher, initializeSessionsWatcher, markInterruptedTurnsOnStartup, sessionsService, startArchiveRetentionSweeper } from '@/modules/providers/index.js';
import { broadcastRuntimeEvicted, createWebSocketServer } from '@/modules/websocket/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { createTasksRouter, startTaskScheduler, stopTaskScheduler } from '@/modules/tasks/index.js';
import { createFilesRouter } from '@/modules/files/index.js';
import {
    createSystemPublicRouter,
    createUsageRouter,
    writeLocalServerMarker,
    removeLocalServerMarker,
} from '@/modules/system/index.js';

import { getConnectableHost } from '../shared/networkHosts.js';

import { findAppRoot, getModuleDir, getDataDir, migrateLegacyDataDir } from './utils/runtime-paths.js';
import {
    queryClaudeSDK,
    prewarmClaudeSession,
    setRuntimeEvictionNotifier,
    releaseClaudeSession,
    abortClaudeSDKSession,
    getActiveClaudeSDKSessions,
    disposeAllRuntimes,
    getToolApprovalSessionId,
    resolveToolApproval,
    getPendingApprovalsForSession,
    getClaudeContextUsage,
    getClaudeSlashCommands,
    getRuntimePoolStats,
} from './claude-sdk.js';
import checkpointsRoutes from './routes/checkpoints.js';
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
import authRoutes from './routes/auth.js';
import commandsRoutes from './routes/commands.js';
import settingsRoutes from './routes/settings.js';
import agentRoutes from './routes/agent.js';
import projectModuleRoutes from './modules/projects/projects.routes.js';
import providerRoutes from './modules/providers/provider.routes.js';
import { assetsRoutes, attachmentUsageRoutes } from './modules/assets/index.js';
import { startAttachmentSweeper } from './shared/attachment-storage.js';
import { canViewerSeeSession, closeConnection, initializeDatabase, sessionMessagesDb, sessionsDb, stopDatabaseBackups } from './modules/database/index.js';
import { readRequestViewer } from './shared/project-visibility.js';
import { currentHolder } from './modules/websocket/services/conversation-ownership.service.js';
import { validateApiKey, authenticateToken, requireRoot, authenticateWebSocket } from './middleware/auth.js';
import { createAdminRouter, backfillProjectOwners } from './modules/admin/index.js';
import { createPreviewRouter, createPreviewPublicRouter } from './modules/preview/index.js';
import { jupyterRoutes, createJupyterProxyHandler, handleJupyterUpgrade, stopJupyter } from './modules/jupyter/index.js';
import { apiRateLimiter, createRateLimiter, TRUST_PROXY } from './middleware/rate-limit.js';
import { consumeTicket } from './shared/ws-tickets.js';
import { listRootUsernames } from './shared/root-users.js';
import { IS_PLATFORM } from './constants/config.js';
import { c } from './utils/colors.js';

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

console.log('SERVER_PORT from env:', process.env.SERVER_PORT);

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

// Behind nginx/Caddy the socket address is the proxy's. Opt-in only: trusting
// X-Forwarded-For unconditionally would let any direct client forge a fresh
// source IP per request and walk straight through the rate limiters below.
if (TRUST_PROXY) {
    app.set('trust proxy', true);
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
app.use(compression({ threshold: 1024 }));

app.use(cors({
    ...(corsOrigins.length > 0 ? { origin: corsOrigins } : {}),
    exposedHeaders: ['X-Refreshed-Token', 'X-Prism-Truncated'],
}));

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
    console.log(`${c.info('[INFO]')} 营销诊断反代已挂载: ${MA_PROXY_PREFIX}/* -> ${maProxyRouter.maProxyTarget}`);
}

// recsys 反代(/recsys/* -> 本机回环的推荐算法点位监控),PRISM_RECSYS_TARGET 不配
// 就完全不挂载。位置的三条讲究与上面 ma-proxy 完全相同,不再重复;唯一要额外说的是
// 它挂在 Prism 的前端静态资源之前 —— 否则 /recsys 会先被前端路由接走。
const recsysProxyRouter = createRecsysProxyRouterFromEnv(process.env, console);
if (recsysProxyRouter) {
    app.use(RECSYS_PROXY_PREFIX, apiRateLimiter, recsysProxyRouter);
    console.log(`${c.info('[INFO]')} 推荐算法点位反代已挂载: ${RECSYS_PROXY_PREFIX}/* -> ${recsysProxyRouter.recsysTarget}`);
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
    console.log(`${c.info('[INFO]')} 推荐算法点位反代未配置(PRISM_RECSYS_TARGET 未设置),${RECSYS_PROXY_PREFIX} 会给出配置提示页`);
}

// 反代只负责"转",不负责"上游是否活着"。配了 PRISM_MA_API_AUTOSTART 就顺带把上游那个
// Python 进程也由 Prism 拉起、由 Prism 收掉 —— 监听地址从 PRISM_MA_API_TARGET 反推,
// 从根上杜绝"反代指 8092、服务听 8091"这类两边日志都正常的故障。默认不配=不启动。
const maService = createMaServiceFromEnv(process.env, console);

app.use(express.json({
    limit: '50mb',
    type: (req) => {
        // Skip multipart/form-data requests (for file uploads like images)
        const contentType = req.headers['content-type'] || '';
        return contentType.includes('multipart/form-data') ? false : contentType.includes('json');
    }
}));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Public system endpoints (no authentication): GET /health (unchanged) and
// GET /api/ready (readiness probe). Mounted before the /api API-key gate.
app.use(createSystemPublicRouter({
    installMode,
    runningVersion: RUNNING_VERSION,
    isWatcherReady: () => sessionsWatcherReady,
}));

// Editor preview reads: GET /preview/:ticket/*. Authorized by a 5-minute
// ticket in the path because the sandboxed iframe sends no credentials.
app.use(createPreviewPublicRouter({ rateLimiter: apiRateLimiter }));

// Rate limiting on every /api route.
//
// Prism binds 0.0.0.0 by default so phones and other LAN machines can reach
// it; this is the mitigation that choice requires. Deliberately mounted
// before validateApiKey so unauthenticated floods are capped too. Static
// assets and the SPA fallback are not limited — only the API surface is.
app.use('/api', apiRateLimiter);

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
        const result = await prewarmClaudeSession({
            sessionId: session.provider_session_id,
            resume: true,
            cwd: session.project_path || body.cwd || undefined,
            projectPath: session.project_path || undefined,
            permissionMode: body.permissionMode,
            toolsSettings: body.toolsSettings,
            model: body.model,
            effort: body.effort,
        });

        res.json({ success: true, ...result });
    } catch (error) {
        console.warn('[Prewarm] failed:', error?.message || error);
        res.json({ success: true, warmed: false, reason: 'error' });
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

// Account administration — approval queue. Root only (PRISM_ROOT_USERS).
app.use('/api/admin', createAdminRouter({
  authenticateToken,
  requireRoot,
  runningVersion: RUNNING_VERSION,
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
    deleteSession: (sessionId) => sessionsService.deleteOrArchiveSessionById(sessionId, {
        force: true,
        deletedFromDisk: true,
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
app.use('/api/providers', authenticateToken, providerRoutes);
app.use('/api/agent', agentRoutes);

// Serve public files (like api-docs.html)
app.use(express.static(path.join(APP_ROOT, 'public')));

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

  console.error(err);

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
const SHUTDOWN_HARD_EXIT_MS = 8000;
let shutdownInProgress = false;

// Runs one cleanup step; failures are logged, never rethrown.
async function shutdownStep(label, fn) {
    try {
        await fn();
    } catch (err) {
        console.error(`[Shutdown] ${label} failed:`, err?.message || err);
    }
}

// Single shutdown path for SIGTERM/SIGINT. Idempotent: a second signal is
// ignored; the 8s hard-exit timer still guarantees termination.
async function shutdown(signal) {
    if (shutdownInProgress) {
        console.log(`[Shutdown] ${signal} received while already shutting down — ignoring`);
        return;
    }
    shutdownInProgress = true;
    console.log(`[Shutdown] ${signal} received — closing (hard exit in ${SHUTDOWN_HARD_EXIT_MS / 1000}s)`);

    const hardExitTimer = setTimeout(() => {
        console.error('[Shutdown] Cleanup exceeded time limit — forcing exit');
        process.exit(1);
    }, SHUTDOWN_HARD_EXIT_MS);
    hardExitTimer.unref();

    // Stop accepting new HTTP connections (not awaited: idle keep-alive
    // sockets can hold close() open past the hard-exit window).
    await shutdownStep('http close', () => {
        server.close(() => console.log('[Shutdown] HTTP server closed'));
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
        if (running.length > 0) console.log(`[Shutdown] Marked ${running.length} interrupted run(s)`);
    });

    // Abort in-flight Claude runs (sessions with a live turn)…
    await shutdownStep('claude aborts', async () => {
        const activeSessionIds = getActiveClaudeSDKSessions() || [];
        if (activeSessionIds.length === 0) return;
        console.log(`[Shutdown] Aborting ${activeSessionIds.length} active Claude session(s)`);
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
        if (disposed > 0) console.log(`[Shutdown] Disposed ${disposed} idle Claude runtime(s)`);
    });

    // JupyterLab 子进程(SIGTERM;kernel 落盘由 jupyter 自己负责)。
    await shutdownStep('jupyter stop', () => stopJupyter());

    await shutdownStep('sessions watcher close', () => closeSessionsWatcher());
    // 营销诊断子进程。放在这儿(而不是最后)是因为它可能正在跑一单几十分钟的诊断,
    // SIGTERM 之后要给它一点收尾时间,别挤到 8s 硬退出的窗口末尾去。
    await shutdownStep('ma service stop', () => maService?.stop());
    // Runtime services — the same set the pre-refactor handler stopped.
    await shutdownStep('server marker removal', () => removeLocalServerMarker(LOCAL_SERVER_MARKER_PATH));
    // Database last so every step above could still use it. Stop the backup
    // timer first — a VACUUM INTO firing mid-close would reopen the handle.
    await shutdownStep('database backup timer stop', () => stopDatabaseBackups());
    await shutdownStep('database close', () => closeConnection());

    process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// Initialize database and start server
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

        // F14:给「回合跑到一半被重启打断」的会话补一条「请重发」标记。
        // **必须在这一刻做** —— 判据是"日志最后一条是用户消息",而正在流式输出
        // 的会话看起来一模一样;进程刚起来时不存在这种会话,晚一秒都可能误伤。
        markInterruptedTurnsOnStartup();

        // 首次部署最容易踩的坑:PRISM_ROOT_USERS 配空或拼错 → 没人是 root →
        // 没人能开审批队列 → 同事注册后全部卡在待审、登不进,而产品里没有任何提示。
        // 至少在启动日志里喊一声,让运维一眼看到。
        if (listRootUsernames().length === 0) {
            console.warn('');
            console.warn(`${c.warn('[WARN]')} PRISM_ROOT_USERS 为空 —— 没有任何管理员。`);
            console.warn('       后果:设置页看不到「账号」标签,新注册的账号会永远卡在待审批、无人能批。');
            console.warn('       解决:在 .env 里设 PRISM_ROOT_USERS=<你的用户名>(用该名字注册后即为 root),然后重启。');
            console.warn('');
        }

        // Production mode = a built dist folder exists
        const distIndexPath = path.join(APP_ROOT, 'dist', 'index.html');
        const isProduction = fs.existsSync(distIndexPath);

        console.log(`${c.info('[INFO]')} Using Claude Agents SDK for Claude integration`);
        console.log('');

        if (isProduction) {
            console.log(`${c.info('[INFO]')} To run in production mode, go to http://${DISPLAY_HOST}:${SERVER_PORT}`);
        }

        console.log(`${c.info('[INFO]')} To run in development mode with hot-module replacement, go to http://${DISPLAY_HOST}:${VITE_PORT}`);

        server.listen(SERVER_PORT, HOST, async () => {
            const appInstallPath = APP_ROOT;
            // 定时任务调度器:服务就绪即装载(执行走与网页聊天同一条 run 通道)。
            try { startTaskScheduler(queryClaudeSDK); } catch (error) {
                console.warn('[Tasks] 调度器启动失败:', error?.message || error);
            }
            await writeLocalServerMarker(LOCAL_SERVER_MARKER_PATH, buildLocalServerMarker()).catch((error) => {
                console.warn('[WARN] Could not write local server marker:', error.message);
            });

            console.log('');
            console.log(c.dim('═'.repeat(63)));
            console.log(`  ${c.bright('Prism Server - Ready')}`);
            console.log(c.dim('═'.repeat(63)));
            console.log('');
            console.log(`${c.info('[INFO]')} Server URL:  ${c.bright('http://' + DISPLAY_HOST + ':' + SERVER_PORT)}`);
            console.log(`${c.info('[INFO]')} Installed at: ${c.dim(appInstallPath)}`);
            console.log(`${c.tip('[TIP]')}  Run "prism status" for full configuration details`);
            console.log('');

            // Start watching the projects folder for changes
            await initializeSessionsWatcher();
            sessionsWatcherReady = true;

            // 营销诊断服务。不 await:它要等 healthz,慢的时候几十秒,不该拖着
            // "Server Ready" 之后的启动流程。起不来也只是 /api/ma/* 返回 502,
            // Prism 其余功能一概不受影响 —— 所以这里 catch 掉,绝不让它把 Prism 带崩。
            maService?.start().catch(err => {
                console.error('[ma-service] 自启失败:', err?.message || err);
            });
        });
    } catch (error) {
        console.error('[ERROR] Failed to start server:', error);
        process.exit(1);
    }
}

startServer();
