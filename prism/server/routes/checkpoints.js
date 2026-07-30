/**
 * Checkpoint REST API (ported from claude-web-ui 2.0).
 *
 * GET    /api/checkpoints?sessionId=&cwd=      list checkpoints
 * GET    /api/checkpoints/:id                  checkpoint metadata
 * GET    /api/checkpoints/:id/changes          changed files + diffs vs now
 * POST   /api/checkpoints/:id/restore          transactional full rollback
 *          409 { code: 'DIRECTORY_BUSY', sessionId }        another live run in this cwd
 *          409 { code: 'COMMITS_AFTER_CHECKPOINT', commits } unless ?force=1
 *          409 { code: 'CHECKPOINT_INCOMPLETE', reason }     unless ?force=1
 *          (force NEVER re-enables deletion of untracked files for an
 *           incomplete checkpoint — the service skips that phase and reports
 *           `skippedUntrackedCleanup` in the response)
 * POST   /api/checkpoints/:id/revert-file      revert one file ({ path })
 */

import express from 'express';

import {
  changedFilesSince,
  listCheckpoints,
  readCheckpoint,
  resolveRealPath,
  restoreCheckpoint,
  revertFile,
} from '../services/git-checkpoint.js';
import { isClaudeSDKSessionActive } from '../claude-sdk.js';
import { chatRunRegistry } from '../modules/websocket/services/chat-run-registry.service.js';
import { sessionsDb } from '../modules/database/index.js';

const router = express.Router();

/**
 * Cross-session directory guard: find ANY live run (any session, any
 * provider) whose working directory resolves to the same real path as the
 * checkpoint's cwd. Uses the chat-run registry (the in-memory source of truth
 * for "is something running"), with cwds resolved from the sessions table by
 * the registry accessor. This complements — not replaces — the same-session
 * `isClaudeSDKSessionActive` check below.
 */
async function findActiveRunForCwd(cwd) {
  if (!cwd) return null;
  let activeRuns = [];
  try {
    activeRuns = chatRunRegistry.getActiveRunsInfo();
  } catch {
    return null;
  }
  if (activeRuns.length === 0) return null;
  const target = await resolveRealPath(cwd);
  for (const activeRun of activeRuns) {
    if (!activeRun.cwd) continue;
    if ((await resolveRealPath(activeRun.cwd)) === target) return activeRun;
  }
  return null;
}

function parseForceFlag(req) {
  const force = req.query?.force;
  return force === '1' || force === 'true';
}

router.get('/', async (req, res) => {
  try {
    const { sessionId, cwd } = req.query;
    // Checkpoints are stored under the provider-native session id; the client
    // only knows app session ids, so resolve through the DB when possible.
    let resolvedSessionId = typeof sessionId === 'string' && sessionId ? sessionId : undefined;
    if (resolvedSessionId) {
      try {
        const row = sessionsDb.getSessionById(resolvedSessionId);
        if (row?.provider_session_id) resolvedSessionId = row.provider_session_id;
      } catch { /* fall back to the raw id */ }
    }
    const checkpoints = await listCheckpoints({
      sessionId: resolvedSessionId,
      cwd: typeof cwd === 'string' && cwd ? cwd : undefined,
    });
    // Strip bulky fields for the list view.
    res.json({
      checkpoints: checkpoints.map(({ untrackedStored, untracked, ...meta }) => ({
        ...meta,
        untrackedCount: untracked?.length || 0,
      })),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const meta = await readCheckpoint(req.params.id);
    if (!meta) return res.status(404).json({ error: 'Checkpoint not found' });
    res.json({ checkpoint: meta });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id/changes', async (req, res) => {
  try {
    const meta = await readCheckpoint(req.params.id);
    if (!meta) return res.status(404).json({ error: 'Checkpoint not found' });
    const changes = await changedFilesSince(req.params.id);
    res.json(changes);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id/restore', async (req, res) => {
  try {
    const meta = await readCheckpoint(req.params.id);
    if (!meta) return res.status(404).json({ error: 'Checkpoint not found' });

    // A running turn writing to the same tree must not race a rollback.
    if (meta.sessionId && isClaudeSDKSessionActive(meta.sessionId)) {
      return res.status(409).json({
        code: 'DIRECTORY_BUSY',
        sessionId: meta.sessionId,
        error: 'This session is still running. Stop the current turn before rolling back.',
      });
    }

    // Nor may a rollback race a live run from ANY other session in the same
    // directory (force does not bypass this — stop the run instead).
    const activeRun = await findActiveRunForCwd(meta.cwd);
    if (activeRun) {
      return res.status(409).json({
        code: 'DIRECTORY_BUSY',
        sessionId: activeRun.sessionId,
        error: `Another session (${activeRun.sessionId}) is actively running in this directory. Stop it before rolling back.`,
      });
    }

    const result = await restoreCheckpoint(req.params.id, { force: parseForceFlag(req) });
    if (!result.ok) {
      return res.status(result.status || 500).json(result);
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id/revert-file', async (req, res) => {
  try {
    const relPath = typeof req.body?.path === 'string' ? req.body.path : '';
    if (!relPath) return res.status(400).json({ error: 'path is required' });

    const meta = await readCheckpoint(req.params.id);
    if (!meta) return res.status(404).json({ error: 'Checkpoint not found' });
    if (meta.sessionId && isClaudeSDKSessionActive(meta.sessionId)) {
      return res.status(409).json({
        code: 'DIRECTORY_BUSY',
        sessionId: meta.sessionId,
        error: 'This session is still running. Stop the current turn before reverting files.',
      });
    }

    const activeRun = await findActiveRunForCwd(meta.cwd);
    if (activeRun) {
      return res.status(409).json({
        code: 'DIRECTORY_BUSY',
        sessionId: activeRun.sessionId,
        error: `Another session (${activeRun.sessionId}) is actively running in this directory. Stop it before reverting files.`,
      });
    }

    const result = await revertFile(req.params.id, relPath);
    if (!result.ok) return res.status(422).json(result);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
