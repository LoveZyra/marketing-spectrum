import express, { type RequestHandler, type Router } from 'express';
// cross-spawn is a drop-in for child_process.spawn that resolves .cmd
// shims/PATHEXT on Windows and delegates to the native spawn elsewhere.
import spawn from 'cross-spawn';

import { getConnection } from '@/modules/database/index.js';

type SystemPublicRouterDependencies = {
  /** 'git' | 'npm' — computed once at startup by the composition root. */
  installMode: string;
  /** Version of the running code, captured at process start (may be null). */
  runningVersion: string | null;
  /**
   * Reports whether the sessions watcher finished initializing. Optional:
   * the watcher module exports no state accessor, so the composition root
   * (which awaits initializeSessionsWatcher) injects this. When absent the
   * watcher is treated as optional and reported as 'unknown'.
   */
  isWatcherReady?: () => boolean;
};

type SystemUpdateRouterDependencies = {
  authenticateToken: RequestHandler;
  isPlatform: boolean;
  installMode: string;
  /** Absolute app root (repo root for git installs). */
  appRoot: string;
};

/**
 * Public system endpoints (no authentication):
 * - GET /health     — unchanged legacy liveness endpoint
 * - GET /api/ready  — readiness: 200 only when the DB answers a trivial query
 *                     (and, when observable, the sessions watcher is up)
 *
 * Mounted BEFORE the /api API-key gate, exactly where /health lived before,
 * so probes keep working without credentials.
 */
export function createSystemPublicRouter(dependencies: SystemPublicRouterDependencies): Router {
  const { installMode, runningVersion, isWatcherReady } = dependencies;
  const router = express.Router();

  // Public health check endpoint (no authentication required)
  router.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      installMode,
      version: runningVersion
    });
  });

  // Readiness probe: unlike /health (pure liveness), this answers 200 only
  // when the process can actually serve requests.
  router.get('/api/ready', (req, res) => {
    let dbState: 'ok' | 'error' = 'error';
    try {
      // Trivial round-trip through better-sqlite3; throws if the connection
      // cannot be opened or the database file is unusable.
      getConnection().prepare('SELECT 1').get();
      dbState = 'ok';
    } catch (error) {
      console.error('[Ready] Database check failed:', (error as Error).message);
    }

    const watcherState: 'ok' | 'pending' | 'unknown' = isWatcherReady
      ? (isWatcherReady() ? 'ok' : 'pending')
      : 'unknown';

    // The watcher is required only when its state is observable; 'unknown'
    // (no accessor injected) never blocks readiness.
    const ready = dbState === 'ok' && watcherState !== 'pending';

    res.status(ready ? 200 : 503).json({
      ready,
      db: dbState,
      watcher: watcherState,
    });
  });

  return router;
}

/**
 * POST /api/system/update — moved verbatim from server/index.js. Mounted at
 * its original position (after the static middleware) with the same
 * authenticateToken gate.
 */
export function createSystemUpdateRouter(dependencies: SystemUpdateRouterDependencies): Router {
  const { authenticateToken, isPlatform, installMode, appRoot } = dependencies;
  const router = express.Router();

  // System update endpoint
  router.post('/api/system/update', authenticateToken, async (req, res) => {
    try {
      // Get the project root directory (parent of server directory)
      const projectRoot = appRoot;

      console.log('Starting system update from directory:', projectRoot);

      // Prism updates from source only; the upstream npm-registry self-update
      // path was removed with the web-only refactor.
      if (!isPlatform && installMode !== 'git') {
        return res.status(501).json({
          success: false,
          error: 'Self-update is only supported for git installations. Update Prism from source and restart the server.'
        });
      }

      // Platform deployments use their own update workflow from the project root.
      const updateCommand = isPlatform
      // In platform, husky and dev dependencies are not needed
        ? 'npm run update:platform'
        : 'git checkout main && git pull && npm install';

      const updateCwd = projectRoot;

      const child = spawn('sh', ['-c', updateCommand], {
        cwd: updateCwd,
        env: process.env
      });

      let output = '';
      let errorOutput = '';

      child.stdout?.on('data', (data) => {
        const text = data.toString();
        output += text;
        console.log('Update output:', text);
      });

      child.stderr?.on('data', (data) => {
        const text = data.toString();
        errorOutput += text;
        console.error('Update error:', text);
      });

      child.on('close', (code) => {
        if (code === 0) {
          res.json({
            success: true,
            output: output || 'Update completed successfully',
            message: 'Update completed. Please restart the server to apply changes.'
          });
        } else {
          res.status(500).json({
            success: false,
            error: 'Update command failed',
            output: output,
            errorOutput: errorOutput
          });
        }
      });

      child.on('error', (error) => {
        console.error('Update process error:', error);
        res.status(500).json({
          success: false,
          error: error.message
        });
      });

    } catch (error) {
      console.error('System update error:', error);
      res.status(500).json({
        success: false,
        error: (error as Error).message
      });
    }
  });

  return router;
}
