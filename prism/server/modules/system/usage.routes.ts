import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import express, { type RequestHandler, type Router } from 'express';

import { canViewerSeeSession, projectsDb, sessionMessagesDb, sessionsDb, usageRecordsDb } from '@/modules/database/index.js';
import { nativeUuidFromMessageId } from '@/shared/fork-anchor.js';
import { readRequestViewer } from '@/shared/project-visibility.js';
import { createLogger } from '@/shared/logger.js';

const log = createLogger('system');

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
/**
 * F14:**从网页消息 id 里取出 provider 原生 uuid。**
 *
 * 网页那侧的 id 有两种来源,形状完全不同:
 *   - 从 transcript 读来的历史行:id 就是 jsonl 的 `uuid`,有时带展示后缀
 *     (`<uuid>_text` / `<uuid>_tr_<id>` / `<uuid>_images`)—— uuid 里没有下划线,
 *     所以第一个 `_` 之前就是它;
 *   - **fj 之后**显示日志成了权威来源,而它的 id 是应用自己生成的
 *     (`text_<时间戳>_<随机>` / `local_*` 之类)—— 切出来是 `text` 这种垃圾。
 *
 * 第二种情况下扫描必然扫不到,而端点此前照样返回 `resumeSessionAt: null` + 200,
 * 客户端拿着它开跑:**「编辑重跑」静默变成「整段历史从头重跑」**,而且没有任何提示。
 *
 * 所以先按形状判一次:不像 uuid 就直说定位不了,别拿一个注定扫不到的值去扫。
 */
/**
 * fy:形状解析搬到 `shared/fork-anchor.ts`,与落库那边共用同一份
 * (落库要用它算 assistant 行的锚点)。这里保留同名导出,老测试照旧钉得住。
 */
export const extractNativeUuid = nativeUuidFromMessageId;

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

      // 可见性闸门:同目录的 prewarm / context-usage / active-model 都有这道,
      // 这两个端点(fork-point / token-usage)当年从 index.js 迁出时漏挂了 ——
      // 少了它,任何登录用户拿会话 id 就能套出别人的 provider_session_id 与
      // 项目路径。不可见与不存在同形 404,不给存在性探针。
      if (!canViewerSeeSession(appSessionId, readRequestViewer(req))) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const row = sessionsDb.getSessionById(appSessionId);
      if (!row?.provider_session_id) {
        return res.status(404).json({ error: 'Session has no provider transcript yet' });
      }

      // The web message id derives from the native uuid, sometimes with a
      // display suffix (`<uuid>_text`, `<uuid>_tr_<id>`, `<uuid>_images`).
      // uuids never contain underscores, so the part before the first "_"
      // is the native uuid.
      /**
       * fy(F14):**先查显示日志里记下的分叉锚点。**
       *
       * 端点要的是"这条消息之前最后一个原生 assistant uuid"。此前只有一条路:
       * 从消息 id 的前缀反推 uuid、再扫 jsonl 往回找。而实时对话里用户气泡的 id
       * 是 `user_<随机>` —— **前缀根本不是 uuid**,那条路从一开始就走不通
       * (fp 把它从"静默重跑整段历史"改成了明确 409,但仍然做不成)。
       *
       * 根子在于用户说的那句话没有对应的出站 SDK 帧,写它的时候手里没有 uuid。
       * 但 assistant 帧**有**,而且是现成的 —— 所以 fy 起,assistant 侧的显示
       * 日志行落库时顺手记下自己的原生 uuid,这里按日志顺序往回取第一条即可。
       *
       * 三态要分开(见 `forkAnchorFor` 的注释):`undefined` 是"日志里没这一行"
       * (老会话 / 被 trim 掉),那才该退回扫 jsonl;`null` 是"确实没有前序
       * assistant",那是真的分不了叉。
       */
      if (messageId) {
        const anchor = sessionMessagesDb.forkAnchorFor(appSessionId, messageId);
        if (typeof anchor === 'string') {
          return res.json({
            providerSessionId: row.provider_session_id,
            projectPath: row.project_path || null,
            resumeSessionAt: anchor,
          });
        }
        if (anchor === null) {
          return res.status(409).json({
            error: '这条消息之前没有可分叉的回答(它是会话里的第一句)。',
            code: 'FORK_POINT_NOT_FOUND',
          });
        }
        // anchor === undefined → 显示日志里查不到这一行,退回下面扫 jsonl 的老路。
      }

      const targetUuid = messageId ? extractNativeUuid(messageId) : null;
      if (messageId && !targetUuid) {
        // 指名了消息却认不出它的原生 uuid —— 明确失败,别退回"从头重跑"。
        return res.status(409).json({
          error: '无法定位这条消息在原生 transcript 里的位置,这条会话可能只有显示日志。'
            + '请改用「新建会话」重新提问。',
          code: 'FORK_POINT_UNRESOLVED',
        });
      }

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
          log.warn('[Fork] Transcript scan failed:', (error as Error).message);
        }
      }

      /**
       * F14:**指名了消息却没扫到,同样是失败。**
       *
       * `resumeSessionAt: null` 只有一个合法含义:调用方**没有指名消息**,
       * 要从头分叉。指名了却扫不到还返回 null,等于把"定位失败"伪装成
       * "从头开始" —— 用户点的是「编辑重跑」,拿到的是整段历史重跑一遍。
       */
      if (messageId && !resumeSessionAt) {
        return res.status(409).json({
          error: '在原生 transcript 里找不到这条消息,无法从这里分叉。',
          code: 'FORK_POINT_NOT_FOUND',
        });
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

      // 可见性闸门(与 fork-point 同理,迁移时漏挂):token 用量也是会话数据,
      // 不可见一律 404 同形。
      if (!canViewerSeeSession(safeSessionId, readRequestViewer(req))) {
        return res.status(404).json({ error: 'Session not found', sessionId: safeSessionId });
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
      log.error('Error reading session token usage:', error);
      res.status(500).json({ error: 'Failed to read session token usage' });
    }
  });

  /**
   * fg:用量与费用台账。
   *
   * ## 和上面那条 token-usage 端点的区别(**别混**)
   *
   * 上面那条读 JSONL 里**最后一条** assistant 消息的 usage —— 它衡量的是
   * "当前上下文占了多少",给 `/cost` 的进度条用。名字里有 Totals,但它不是总和。
   *
   * 这条读 `usage_records` 表,是**累计花销**:一轮一行,逐条累加过的。
   * 两个数天然不一样,而且差可以是一个数量级 —— 谁把它们当同一个数用,
   * 得到的结论就是错的。
   *
   * ## 可见范围
   *
   * root 看全量,其他人只看自己的行。和审计日志同一条规矩:费用行带着
   * project_path 和 model,不设防的话任何账号都能摸清别人在做什么项目。
   */
  router.get('/api/usage/records', authenticateToken, (req, res) => {
    try {
      const user = (req as unknown as { user?: { id?: number; isRoot?: boolean } }).user;
      const scopeUserId = user?.isRoot ? null : (user?.id ?? -1);
      const limit = Number.parseInt(String(req.query.limit ?? ''), 10) || 50;
      const offset = Number.parseInt(String(req.query.offset ?? ''), 10) || 0;
      const days = Number.parseInt(String(req.query.days ?? ''), 10) || null;

      res.json({
        entries: usageRecordsDb.list(limit, offset, scopeUserId, days),
        total: usageRecordsDb.count(scopeUserId, days),
        scoped: scopeUserId !== null,
      });
    } catch (error) {
      log.error('读用量明细失败:', error);
      res.status(500).json({ error: 'Failed to read usage records' });
    }
  });

  /** 汇总。`by` 只接受白名单里的维度 —— 它会拼进 SQL 的 GROUP BY。 */
  router.get('/api/usage/summary', authenticateToken, (req, res) => {
    try {
      const user = (req as unknown as { user?: { id?: number; isRoot?: boolean } }).user;
      const scopeUserId = user?.isRoot ? null : (user?.id ?? -1);
      const requested = String(req.query.by ?? 'day');
      const allowed = ['username', 'project_path', 'model', 'source', 'day'] as const;
      const by = (allowed as readonly string[]).includes(requested)
        ? (requested as (typeof allowed)[number])
        : 'day';
      const days = Number.parseInt(String(req.query.days ?? ''), 10) || 30;

      res.json({
        by,
        days,
        rows: usageRecordsDb.summarize(by, scopeUserId, days),
        scoped: scopeUserId !== null,
      });
    } catch (error) {
      log.error('读用量汇总失败:', error);
      res.status(500).json({ error: 'Failed to read usage summary' });
    }
  });

  return router;
}
