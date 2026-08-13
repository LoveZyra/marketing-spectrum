import express, { type Router } from 'express';

import { getConnection } from '@/modules/database/index.js';

type SystemPublicRouterDependencies = {
  /** 安装方式,固定为 'npm'(tar 包部署)。 */
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
