import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import express, { type RequestHandler, type Router } from 'express';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';

type UsageRouterDependencies = {
  authenticateToken: RequestHandler;
};

function readUsageNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// ── Token-usage transcript cache ─────────────────────────────────────────────
// The endpoint used to re-read the entire Claude JSONL transcript on every
// request. Transcripts only ever grow via appends, so a (mtimeMs, size) pair
// is a reliable freshness key: parse once, then serve from memory until the
// file changes. Plain Map insertion order gives LRU semantics — delete+set on
// hit refreshes recency, evict the oldest entry past the cap.

type TokenUsageTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};

type TokenUsageCacheEntry = {
  mtimeMs: number;
  size: number;
  totals: TokenUsageTotals;
};

const TOKEN_USAGE_CACHE_MAX_ENTRIES = 50;
const tokenUsageCache = new Map<string, TokenUsageCacheEntry>();

/**
 * Extracts the latest assistant-message usage counters from raw JSONL text.
 * Logic is identical to the historical inline implementation in index.js
 * (scan from the end, first assistant entry with usage data wins).
 */
function parseTokenUsageTotals(fileContent: string): TokenUsageTotals {
  const lines = fileContent.trim().split('\n');

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;

  // Find the latest assistant message with usage data (scan from end)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);

      // Only count assistant messages which have usage data
      if (entry.type === 'assistant' && entry.message?.usage) {
        const usage = entry.message.usage;

        // Use token counts from latest assistant message only
        const directInputTokens = readUsageNumber(usage.input_tokens ?? usage.inputTokens);
        cacheReadTokens = readUsageNumber(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? usage.cacheReadTokens);
        cacheCreationTokens = readUsageNumber(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? usage.cacheCreationTokens);
        inputTokens = directInputTokens + cacheReadTokens + cacheCreationTokens;
        outputTokens = readUsageNumber(usage.output_tokens ?? usage.outputTokens);

        break; // Stop after finding the latest assistant message
      }
    } catch {
      // Skip lines that can't be parsed
      continue;
    }
  }

  return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens };
}

/**
 * Stat-validated cached read of a transcript's token totals. Re-parses only
 * when the file's (mtimeMs, size) changed since the cached parse.
 *
 * Throws the fs error (e.g. ENOENT) exactly like the old direct readFile did
 * so the route's error mapping stays byte-identical.
 */
async function getTokenUsageTotals(jsonlPath: string): Promise<TokenUsageTotals> {
  const stats = await fsPromises.stat(jsonlPath);

  const cached = tokenUsageCache.get(jsonlPath);
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    // Refresh recency for LRU ordering.
    tokenUsageCache.delete(jsonlPath);
    tokenUsageCache.set(jsonlPath, cached);
    return cached.totals;
  }

  const fileContent = await fsPromises.readFile(jsonlPath, 'utf8');
  const totals = parseTokenUsageTotals(fileContent);

  tokenUsageCache.delete(jsonlPath);
  tokenUsageCache.set(jsonlPath, { mtimeMs: stats.mtimeMs, size: stats.size, totals });
  while (tokenUsageCache.size > TOKEN_USAGE_CACHE_MAX_ENTRIES) {
    const oldestKey = tokenUsageCache.keys().next().value;
    if (oldestKey === undefined) break;
    tokenUsageCache.delete(oldestKey);
  }

  return totals;
}

/**
 * Session usage endpoints moved verbatim from server/index.js:
 * - POST /api/claude/fork-point
 * - GET  /api/projects/:projectId/sessions/:sessionId/token-usage
 *
 * Note: GET /api/claude/context-usage and /api/claude/slash-commands stayed in
 * index.js — they call server/claude-sdk.js, which the eslint boundaries
 * config does not allow modules to import.
 */
export function createUsageRouter(dependencies: UsageRouterDependencies): Router {
  const { authenticateToken } = dependencies;
  const router = express.Router();

  // Prism: resolve fork inputs for "fork here" / "edit and re-run".
  // Given an APP session id and any message id from its transcript, returns the
  // provider session id plus the native assistant-message uuid to fork at.
  router.post('/api/claude/fork-point', authenticateToken, async (req, res) => {
    try {
      const appSessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : '';
      const messageId = typeof req.body?.messageId === 'string' ? req.body.messageId : '';
      if (!appSessionId) return res.status(400).json({ error: 'sessionId is required' });

      const row = sessionsDb.getSessionById(appSessionId);
      if (!row?.provider_session_id) {
        return res.status(404).json({ error: 'Session has no provider transcript yet' });
      }

      // The web message id derives from the native uuid, sometimes with a
      // display suffix (`<uuid>_text`, `<uuid>_tr_<id>`, `<uuid>_images`).
      // uuids never contain underscores, so the part before the first "_"
      // is the native uuid.
      const targetUuid = messageId ? messageId.split('_')[0] : '';

      let resumeSessionAt = null;
      if (targetUuid && row.jsonl_path) {
        try {
          const raw = await fsPromises.readFile(row.jsonl_path, 'utf8');
          const lines = raw.split('\n').filter(Boolean);
          let lastAssistantUuid = null;
          for (const line of lines) {
            let entry;
            try { entry = JSON.parse(line); } catch { continue; }
            // Reached the target (usually a user message): fork at the
            // most recent assistant turn before it, so the edited turn
            // replaces this one.
            if (entry?.uuid === targetUuid || entry?.message?.id === targetUuid) {
              resumeSessionAt = lastAssistantUuid;
              break;
            }
            if (entry?.type === 'assistant' && entry.uuid) {
              lastAssistantUuid = entry.uuid;
            }
          }
        } catch (error) {
          console.warn('[Fork] Transcript scan failed:', (error as Error).message);
        }
      }

      res.json({
        providerSessionId: row.provider_session_id,
        projectPath: row.project_path || null,
        resumeSessionAt,
      });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // Get token usage for a specific session. `projectId` is the DB primary key;
  // the Claude branch below resolves it to an absolute path via the DB.
  router.get('/api/projects/:projectId/sessions/:sessionId/token-usage', authenticateToken, async (req, res) => {
    try {
      // Named route params are always plain strings at runtime; the express
      // typings widen them to string | string[] (repeatable params).
      const { projectId, sessionId } = req.params as { projectId: string; sessionId: string };
      const homeDir = os.homedir();

      // Allow only safe characters in sessionId
      const safeSessionId = String(sessionId).replace(/[^a-zA-Z0-9._-]/g, '');
      if (!safeSessionId || safeSessionId !== String(sessionId)) {
        return res.status(400).json({ error: 'Invalid sessionId' });
      }

      // Provider artifacts on disk (Claude JSONL file names) are keyed by the
      // provider-native session id, while the caller sends the app-facing id.
      // Resolve the id mapping from the indexed session row so the frontend
      // does not construct provider-specific paths.
      const sessionRow = sessionsDb.getSessionById(safeSessionId);
      if (!sessionRow) {
        return res.status(404).json({ error: 'Session not found', sessionId: safeSessionId });
      }

      const providerNativeSessionId = sessionRow?.provider_session_id || safeSessionId;

      // Claude sessions (the only provider)
      // Resolve the project path through the DB using the caller-supplied
      // `projectId`. Legacy code here called extractProjectDirectory with a
      // folder-encoded project name; the migration centralizes that lookup
      // in the projects table.
      const projectPath = await projectsDb.getProjectPathById(projectId);
      if (!projectPath) {
        return res.status(404).json({ error: 'Project not found' });
      }

      // Construct the JSONL file path
      // Claude stores session files in ~/.claude/projects/[encoded-project-path]/[session-id].jsonl
      // The encoding replaces any non-alphanumeric character (except -) with -
      const encodedPath = projectPath.replace(/[^a-zA-Z0-9-]/g, '-');
      const projectDir = path.join(homeDir, '.claude', 'projects', encodedPath);

      // Prefer the indexed transcript path (already produced by the trusted
      // session synchronizer); fall back to the conventional location
      // derived from the provider-native session id.
      let jsonlPath = sessionRow?.jsonl_path;
      if (!jsonlPath) {
        jsonlPath = path.join(projectDir, `${providerNativeSessionId}.jsonl`);

        // Constrain the constructed path to projectDir (the id is
        // caller-influenced in this fallback branch).
        const rel = path.relative(path.resolve(projectDir), path.resolve(jsonlPath));
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          return res.status(400).json({ error: 'Invalid path' });
        }
      }

      // Read the parsed totals through the mtime/size-validated cache instead
      // of re-reading the whole transcript on every request.
      let totals: TokenUsageTotals;
      try {
        totals = await getTokenUsageTotals(jsonlPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return res.status(404).json({ error: 'Session file not found', path: jsonlPath });
        }
        throw error; // Re-throw other errors to be caught by outer try-catch
      }

      const parsedContextWindow = parseInt(process.env.CONTEXT_WINDOW ?? '', 10);
      const contextWindow = Number.isFinite(parsedContextWindow) ? parsedContextWindow : 160000;
      const { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens } = totals;

      const totalUsed = inputTokens + outputTokens;
      const cacheTokens = cacheReadTokens + cacheCreationTokens;

      res.json({
        used: totalUsed,
        total: contextWindow,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        cacheTokens,
        breakdown: {
          input: inputTokens,
          output: outputTokens
        }
      });
    } catch (error) {
      console.error('Error reading session token usage:', error);
      res.status(500).json({ error: 'Failed to read session token usage' });
    }
  });

  return router;
}
