import os from 'node:os';
import path from 'node:path';
import { promises as fsPromises } from 'node:fs';

import chokidar, { type ChokidarOptions, type FSWatcher } from 'chokidar';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { sessionSynchronizerService } from '@/modules/providers/services/session-synchronizer.service.js';
import { WS_OPEN_STATE, connectedClients } from '@/modules/websocket/index.js';
import { canViewerSeeProject } from '@/shared/project-visibility.js';
import type { LLMProvider } from '@/shared/types.js';
import { generateDisplayName } from '@/modules/projects/index.js';

type WatcherEventType = 'add' | 'change';

const PROVIDER_WATCH_PATHS: Array<{ provider: LLMProvider; rootPath: string }> = [
  {
    provider: 'claude',
    rootPath: path.join(os.homedir(), '.claude', 'projects'),
  },
];

/**
 * Values that turn a `PRISM_*` boolean env var on. Anything else — including
 * the empty string a bare `PRISM_WATCH_POLL=` line in .env produces — leaves it
 * off.
 */
const TRUTHY_ENV_VALUES = new Set(['1', 'true', 'yes', 'on']);

const DEFAULT_POLL_INTERVAL_MS = 6_000;

/** Coalescing window for the expensive per-file reindex. */
const FILE_SYNC_DEBOUNCE_MS = 300;
const FILE_SYNC_MAX_WAIT_MS = 3_000;

/** Coalescing window for the outbound `session_upserted` broadcast. */
const PROJECTS_UPDATE_DEBOUNCE_MS = 500;
const PROJECTS_UPDATE_MAX_WAIT_MS = 2_000;

const watchers: FSWatcher[] = [];

type PendingWatcherUpdate = {
  /**
   * Provider-native session ids reported by the synchronizers. They are
   * translated back to app-facing session rows at flush time, because the
   * transcript file names on disk only ever contain provider ids.
   */
  updatedSessionIds: Set<string>;
};

let pendingWatcherUpdate: PendingWatcherUpdate | null = null;
let pendingWatcherUpdateStartedAt: number | null = null;
let pendingWatcherFlushTimer: ReturnType<typeof setTimeout> | null = null;
let watcherRefreshInFlight = false;
let watcherRescheduleAfterRefresh = false;

/**
 * Computes how long to wait before flushing work that started accumulating at
 * `firstEventAt`.
 *
 * Plain debouncing starves under a continuous event stream: a transcript being
 * appended by a running Claude session pushes the deadline forward on every
 * write, so the sidebar would not update until the run finished. Capping the
 * total wait at `maxWaitMs` bounds that — a busy file still flushes on a fixed
 * cadence, an idle one settles quickly.
 *
 * Exported because both coalescers below depend on this clamp and both fail
 * silently when it is wrong: too eager and every append re-reads history.jsonl,
 * too lazy and the UI stops updating mid-run.
 */
export function nextFlushDelay(
  now: number,
  firstEventAt: number,
  debounceMs: number,
  maxWaitMs: number
): number {
  const elapsed = Math.max(0, now - firstEventAt);
  return Math.min(debounceMs, Math.max(0, maxWaitMs - elapsed));
}

/**
 * Decides whether chokidar should skip a path entirely.
 *
 * This replaces a list of glob strings (`'**\/node_modules/**'` and friends).
 * chokidar 4 dropped glob support in `ignored` and now treats a plain string as
 * an *exact path*, so every one of those patterns had silently become inert.
 *
 * `subagents/` is the entry that earns its keep under ~/.claude/projects:
 * subagent transcripts repeat their parent's session id and are rejected by
 * ClaudeSessionSynchronizer.synchronizeFile anyway, so watching them buys
 * nothing and costs a watch descriptor per directory.
 *
 * chokidar calls this with no `stats` for paths it has not stat()ed yet. A
 * directory name is not reliably distinguishable from a file name (a project at
 * `/srv/my.app` encodes to a directory with a dot in it), so an unstat()ed path
 * is never rejected on extension — getting that wrong would prune a whole
 * subtree and the watcher would just go quiet with no error.
 */
export function shouldIgnoreWatchPath(
  watchedPath: string,
  stats?: { isDirectory(): boolean }
): boolean {
  if (path.normalize(watchedPath).split(path.sep).includes('subagents')) {
    return true;
  }
  if (!stats || stats.isDirectory()) {
    return false;
  }
  return !watchedPath.endsWith('.jsonl');
}

/**
 * Builds the chokidar options for a provider transcript root.
 *
 * Native filesystem events (inotify / FSEvents / ReadDirectoryChangesW) are the
 * default. This watcher used to hardcode `usePolling: true` with a 6 s tick,
 * which re-stat()s every file under ~/.claude/projects on every tick — a
 * constant syscall floor proportional to the user's entire project history —
 * and still took up to 6 s to notice an append.
 *
 * Polling stays available behind PRISM_WATCH_POLL because native events do not
 * reach every filesystem: NFS/SMB shares and some container bind mounts deliver
 * no inotify events at all, and there a non-polling watcher fails silently
 * rather than erroring.
 */
export function buildWatchOptions(env: NodeJS.ProcessEnv = process.env): ChokidarOptions {
  const usePolling = TRUTHY_ENV_VALUES.has((env.PRISM_WATCH_POLL ?? '').trim().toLowerCase());
  const configuredInterval = Number.parseInt(env.PRISM_WATCH_POLL_INTERVAL_MS ?? '', 10);
  const interval = Number.isFinite(configuredInterval) && configuredInterval > 0
    ? configuredInterval
    : DEFAULT_POLL_INTERVAL_MS;

  return {
    ignored: shouldIgnoreWatchPath,
    persistent: true,
    ignoreInitial: true,
    followSymlinks: false,
    depth: 6,
    usePolling,
    ...(usePolling ? { interval, binaryInterval: interval } : {}),
  };
}

/**
 * Filters watcher events to session artifact file types.
 */
function isWatcherTargetFile(filePath: string): boolean {
  return filePath.endsWith('.jsonl');
}

function clearPendingWatcherFlushTimer(): void {
  if (pendingWatcherFlushTimer) {
    clearTimeout(pendingWatcherFlushTimer);
    pendingWatcherFlushTimer = null;
  }
}

function schedulePendingWatcherFlush(): void {
  if (!pendingWatcherUpdate) {
    return;
  }

  const now = Date.now();
  if (pendingWatcherUpdateStartedAt === null) {
    pendingWatcherUpdateStartedAt = now;
  }

  clearPendingWatcherFlushTimer();
  pendingWatcherFlushTimer = setTimeout(
    () => {
      void flushPendingWatcherUpdate();
    },
    nextFlushDelay(
      now,
      pendingWatcherUpdateStartedAt,
      PROJECTS_UPDATE_DEBOUNCE_MS,
      PROJECTS_UPDATE_MAX_WAIT_MS
    )
  );
}

function queuePendingWatcherUpdate(updatedSessionId: string | null): void {
  if (!pendingWatcherUpdate) {
    pendingWatcherUpdate = { updatedSessionIds: new Set<string>() };
  }

  if (updatedSessionId) {
    pendingWatcherUpdate.updatedSessionIds.add(updatedSessionId);
  }

  schedulePendingWatcherFlush();
}

/**
 * Builds one `session_upserted` delta event for a provider-native session id.
 *
 * The event carries everything a sidebar needs to upsert the session in place
 * (session summary plus owning-project metadata), so clients never need a full
 * project-list refetch when a transcript file changes on disk. Returns `null`
 * when the id cannot be resolved to an indexed session row.
 */
type ScopedEvent = { payload: string; ownerUserId: number | null };

async function buildSessionUpsertedEvent(updatedProviderSessionId: string): Promise<ScopedEvent | null> {
  const row = sessionsDb.getSessionByProviderSessionId(updatedProviderSessionId)
    ?? sessionsDb.getSessionById(updatedProviderSessionId);
  if (!row || row.isArchived) {
    return null;
  }

  const projectPath = row.project_path;
  const project = projectPath ? projectsDb.getProjectPath(projectPath) : null;
  const displayName = project?.custom_project_name?.trim()
    ? project.custom_project_name
    : await generateDisplayName(path.basename(projectPath ?? '') || (projectPath ?? ''), projectPath);

  const payload = JSON.stringify({
    kind: 'session_upserted',
    sessionId: row.session_id,
    provider: row.provider,
    session: {
      id: row.session_id,
      summary: row.custom_name || '',
      messageCount: 0,
      lastActivity: row.updated_at ?? row.created_at ?? new Date().toISOString(),
    },
    project: project
      ? {
        projectId: project.project_id,
        path: project.project_path,
        fullPath: project.project_path,
        displayName,
        isStarred: Boolean(project.isStarred),
      }
      : null,
    timestamp: new Date().toISOString(),
  });

  return { payload, ownerUserId: project?.owner_user_id ?? null };
}

async function flushPendingWatcherUpdate(): Promise<void> {
  clearPendingWatcherFlushTimer();

  if (!pendingWatcherUpdate) {
    return;
  }

  if (watcherRefreshInFlight) {
    watcherRescheduleAfterRefresh = true;
    return;
  }

  const queuedUpdate = pendingWatcherUpdate;
  pendingWatcherUpdate = null;
  pendingWatcherUpdateStartedAt = null;
  watcherRefreshInFlight = true;

  try {
    // Per-session deltas instead of full project snapshots: an upsert of one
    // session can never clobber unrelated client state, so the frontend needs
    // no "suppress updates while a run is active" protection logic.
    const events: ScopedEvent[] = [];
    for (const updatedSessionId of queuedUpdate.updatedSessionIds) {
      const event = await buildSessionUpsertedEvent(updatedSessionId);
      if (event) {
        events.push(event);
      }
    }

    if (events.length > 0) {
      // Per-recipient, not a blanket fan-out: each event carries a project
      // name and path, and the watcher fires for whoever happens to be
      // working — so an unfiltered broadcast puts one colleague's project in
      // everyone else's sidebar until the next refresh.
      connectedClients.forEach(client => {
        if (client.readyState !== WS_OPEN_STATE) return;
        for (const event of events) {
          if (!canViewerSeeProject({
            ownerUserId: event.ownerUserId,
            viewerUserId: client.prismUserId,
            viewerUsername: client.prismUsername,
          })) continue;

          client.send(event.payload);
        }
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Session watcher refresh failed while broadcasting session_upserted', { error: message });
  } finally {
    watcherRefreshInFlight = false;

    if (pendingWatcherUpdate || watcherRescheduleAfterRefresh) {
      watcherRescheduleAfterRefresh = false;
      schedulePendingWatcherFlush();
    }
  }
}

/**
 * Reindexes one transcript file and queues the resulting sidebar delta.
 */
async function syncWatchedFile(
  eventType: WatcherEventType,
  filePath: string,
  provider: LLMProvider
): Promise<void> {
  try {
    const result = await sessionSynchronizerService.synchronizeProviderFile(provider, filePath);
    if (!result.indexed) {
      return;
    }

    console.log(`Session synchronization triggered by ${eventType} event for provider "${provider}"`, {
      filePath,
      sessionId: result.sessionId,
    });
    queuePendingWatcherUpdate(result.sessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Session watcher sync failed for provider "${provider}"`, {
      eventType,
      filePath,
      error: message,
    });
  }
}

type PendingFileSync = {
  provider: LLMProvider;
  eventType: WatcherEventType;
  firstEventAt: number;
  timer: ReturnType<typeof setTimeout>;
};

const pendingFileSyncs = new Map<string, PendingFileSync>();

/**
 * Coalesces raw watcher events per file before reindexing.
 *
 * synchronizeProviderFile is not cheap: it reads and parses ~/.claude/history.jsonl
 * in full on every call, and that file grows without bound across every session
 * the user has ever run. Under the old 6 s polling that ran at most once per
 * file per tick, so the cost was invisible. Native events fire once per *write*,
 * and a running Claude session appends to its transcript continuously — without
 * this gate, switching to native events would turn one full history parse per
 * 6 s into one per append.
 *
 * The `add` event type wins over later `change`es for the same file so the log
 * line still reports how the file first arrived.
 */
function onWatcherEvent(
  eventType: WatcherEventType,
  filePath: string,
  provider: LLMProvider
): void {
  if (!isWatcherTargetFile(filePath)) {
    return;
  }

  const now = Date.now();
  const pending = pendingFileSyncs.get(filePath);
  if (pending) {
    clearTimeout(pending.timer);
  }

  const firstEventAt = pending?.firstEventAt ?? now;
  const timer = setTimeout(() => {
    const entry = pendingFileSyncs.get(filePath);
    pendingFileSyncs.delete(filePath);
    void syncWatchedFile(entry?.eventType ?? eventType, filePath, provider);
  }, nextFlushDelay(now, firstEventAt, FILE_SYNC_DEBOUNCE_MS, FILE_SYNC_MAX_WAIT_MS));

  pendingFileSyncs.set(filePath, {
    provider,
    eventType: pending?.eventType ?? eventType,
    firstEventAt,
    timer,
  });
}

/**
 * Starts provider filesystem watchers and performs initial DB synchronization.
 */
export async function initializeSessionsWatcher(): Promise<void> {
  console.log('Setting up session watchers');

  const initialSync = await sessionSynchronizerService.synchronizeSessions();
  console.log('Initial session synchronization complete', {
    processedByProvider: initialSync.processedByProvider,
    failures: initialSync.failures,
  });

  for (const { provider, rootPath } of PROVIDER_WATCH_PATHS) {
    try {
      await fsPromises.mkdir(rootPath, { recursive: true });

      const watcher = chokidar.watch(rootPath, buildWatchOptions());

      watcher
        .on('add', (filePath: string) => {
          onWatcherEvent('add', filePath, provider);
        })
        .on('change', (filePath: string) => {
          onWatcherEvent('change', filePath, provider);
        })
        .on('error', (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`Session watcher error for provider "${provider}"`, { error: message });
        });

      watchers.push(watcher);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to initialize session watcher for provider "${provider}"`, {
        rootPath,
        error: message,
      });
    }
  }
}

/**
 * Stops all active provider session watchers.
 */
export async function closeSessionsWatcher(): Promise<void> {
  clearPendingWatcherFlushTimer();

  // Pending per-file timers hold the event loop open, so a shutdown that leaves
  // them armed stalls for up to FILE_SYNC_MAX_WAIT_MS and then reindexes into a
  // database the shutdown path has already closed.
  for (const pending of pendingFileSyncs.values()) {
    clearTimeout(pending.timer);
  }
  pendingFileSyncs.clear();

  await Promise.all(
    watchers.map(async (watcher) => {
      try {
        await watcher.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('Failed to close session watcher', { error: message });
      }
    })
  );
  watchers.length = 0;
  pendingWatcherUpdate = null;
  pendingWatcherUpdateStartedAt = null;
  watcherRefreshInFlight = false;
  watcherRescheduleAfterRefresh = false;
}
