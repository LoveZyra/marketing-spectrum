#!/usr/bin/env node
// Load env vars before other imports execute. load-env.js also runs the
// one-time ~/.cloudcli -> ~/.prism data-dir migration, which must precede any
// import that opens the data dir (middleware/auth.js opens the auth DB).
import './load-env.js';
import fs from 'fs';
import path from 'path';
import http from 'http';

import express from 'express';
import cors from 'cors';

import { AppError } from '@/shared/utils.js';
import { closeSessionsWatcher, initializeSessionsWatcher } from '@/modules/providers/index.js';
import { createWebSocketServer } from '@/modules/websocket/index.js';
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
    abortClaudeSDKSession,
    getActiveClaudeSDKSessions,
    resolveToolApproval,
    getPendingApprovalsForSession,
    getClaudeContextUsage,
    getClaudeSlashCommands,
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
import { createMaServiceFromEnv } from './services/ma-service.js';
import authRoutes from './routes/auth.js';
import taskmasterRoutes from './routes/taskmaster.js';
import mcpUtilsRoutes from './routes/mcp-utils.js';
import commandsRoutes from './routes/commands.js';
import settingsRoutes from './routes/settings.js';
import agentRoutes from './routes/agent.js';
import projectModuleRoutes from './modules/projects/projects.routes.js';
import userRoutes from './routes/user.js';
import pluginsRoutes from './routes/plugins.js';
import providerRoutes from './modules/providers/provider.routes.js';
import voiceRoutes from './voice-proxy.js';
import browserUseRoutes from './modules/browser-use/browser-use.routes.js';
import { assetsRoutes } from './modules/assets/index.js';
import browserUseMcpRoutes from './modules/browser-use/browser-use-mcp.routes.js';
import { browserUseService } from './modules/browser-use/browser-use.service.js';
import { startEnabledPluginServers, stopAllPlugins, getPluginPort } from './utils/plugin-process-manager.js';
import { initializeDatabase, closeConnection, sessionsDb, stopDatabaseBackups } from './modules/database/index.js';
import { validateApiKey, authenticateToken, requireRoot, authenticateWebSocket } from './middleware/auth.js';
import { createAdminRouter, backfillProjectOwners } from './modules/admin/index.js';
import { createPublishRouter, createPublishPublicRouter } from './modules/publish/index.js';
import { createPreviewRouter, createPreviewPublicRouter } from './modules/preview/index.js';
import { apiRateLimiter, TRUST_PROXY } from './middleware/rate-limit.js';
import { consumeTicket } from './shared/ws-tickets.js';
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

// Single WebSocket server that handles chat, shell, and plugin proxy paths.
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
        resolveToolApproval,
        getPendingApprovalsForSession,
    },
    shell: {
        resolveProviderSessionId: (sessionId, provider) => {
            const dbSession = sessionsDb.getSessionById(sessionId);
            return dbSession ? (dbSession.provider_session_id ?? null) : null;
        },
        stripAnsiSequences,
        normalizeDetectedUrl,
        extractUrlsFromText,
        shouldAutoOpenUrlFromOutput,
    },
    getPluginPort,
});

// Make WebSocket server available to routes
app.locals.wss = wss;

// Behind nginx/Caddy the socket address is the proxy's. Opt-in only: trusting
// X-Forwarded-For unconditionally would let any direct client forge a fresh
// source IP per request and walk straight through the rate limiters below.
if (TRUST_PROXY) {
    app.set('trust proxy', true);
}

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

// Published static pages: GET /p/:token/* with no credentials.
//
// Mounted here, alongside the other public router and before the /api gate, so
// that middleware later added to /api cannot change who can read a shared link.
// It brings its own rate limiter — see createPublishPublicRouter.
app.use(createPublishPublicRouter({ rateLimiter: apiRateLimiter }));

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
        const session = sessionsDb.getSessionById(String(req.params.sessionId || ''));
        if (!session?.provider_session_id) {
            return res.json({ success: true, warmed: false, reason: 'no_provider_session' });
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

// Publication management. Mounted before the projects router because both
// answer under /api/projects and the projects router has a `/:projectId/...`
// catch-all that would otherwise swallow these paths.
app.use('/api/projects', createPublishRouter({ authenticateToken }));
app.use('/api/projects', createPreviewRouter({ authenticateToken }));

// Projects API Routes (protected)
app.use('/api/projects', authenticateToken, projectModuleRoutes);

// Account administration — approval queue. Root only (PRISM_ROOT_USERS).
app.use('/api/admin', createAdminRouter({ authenticateToken, requireRoot }));

// Chat image asset upload/serving (global assets store, see server/modules/assets; protected)
app.use('/api/assets', authenticateToken, assetsRoutes);


// Checkpoints: per-turn git snapshots with transactional rollback (prism)
app.use('/api/checkpoints', authenticateToken, checkpointsRoutes);

// Documents: text extraction (PDF/DOCX/PPTX/XLSX/…) + URL article fetch (prism)
app.use('/api/documents', authenticateToken, documentsRoutes);

// Native context usage for a live Claude conversation (prism). Stays here —
// it calls server/claude-sdk.js, which eslint boundaries keeps out of modules.
app.get('/api/claude/context-usage', authenticateToken, async (req, res) => {
    try {
        const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
        if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
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
// protected except /api/browser-use-mcp (local token) and /api/agent (API key).
app.use('/api/taskmaster', authenticateToken, taskmasterRoutes);
app.use('/api/mcp-utils', authenticateToken, mcpUtilsRoutes);
app.use('/api/commands', authenticateToken, commandsRoutes);
app.use('/api/settings', authenticateToken, settingsRoutes); // includes notification-preferences
app.use('/api/user', authenticateToken, userRoutes);
app.use('/api/plugins', authenticateToken, pluginsRoutes);
app.use('/api/browser-use-mcp', browserUseMcpRoutes);
app.use('/api/browser-use', authenticateToken, browserUseRoutes);
app.use('/api/providers', authenticateToken, providerRoutes);
app.use('/api/agent', agentRoutes);
app.use('/api/voice', authenticateToken, voiceRoutes);

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
app.use((err, req, res, next) => {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
  }

  console.error(err);

  return res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    },
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

    // Abort in-flight Claude runs. claude-sdk exports no dispose-all, so use
    // the supported per-session abort API.
    await shutdownStep('claude aborts', async () => {
        const activeSessionIds = getActiveClaudeSDKSessions() || [];
        if (activeSessionIds.length === 0) return;
        console.log(`[Shutdown] Aborting ${activeSessionIds.length} active Claude session(s)`);
        await Promise.allSettled(
            activeSessionIds.map((sessionId) => Promise.resolve(abortClaudeSDKSession(sessionId)))
        );
    });

    await shutdownStep('sessions watcher close', () => closeSessionsWatcher());
    // 营销诊断子进程。放在这儿(而不是最后)是因为它可能正在跑一单几十分钟的诊断,
    // SIGTERM 之后要给它一点收尾时间,别挤到 8s 硬退出的窗口末尾去。
    await shutdownStep('ma service stop', () => maService?.stop());
    // Runtime services — the same set the pre-refactor handler stopped.
    await shutdownStep('browser-use sessions stop', () => browserUseService.stopAllSessions());
    await shutdownStep('plugin processes stop', () => stopAllPlugins());
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

            // Start server-side plugin processes for enabled plugins
            startEnabledPluginServers().catch(err => {
                console.error('[Plugins] Error during startup:', err.message);
            });

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
