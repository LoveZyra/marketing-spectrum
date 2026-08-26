import os from 'node:os';
import path from 'node:path';
import { open, readFile, stat } from 'node:fs/promises';

import { sessionsDb } from '@/modules/database/index.js';
import {
  buildLookupMap,
  extractFirstValidJsonlData,
  findFilesRecursivelyCreatedAfter,
  normalizeSessionName,
  readFileTimestamps,
} from '@/shared/utils.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';

type ParsedSession = {
  sessionId: string;
  projectPath: string;
  sessionName?: string;
};

const TAIL_BYTES = 64 * 1024;

/**
 * 尾部内容的 (mtimeMs, size) 指纹缓存。
 *
 * 一次同步里,同一个文件的尾部会被读两遍:`extractLastActivityFromEnd`(取最后
 * 活动时间)和 `extractSessionAiTitleFromEnd`(取 AI 标题,会话还叫 Untitled 时
 * 每 3s 一次)。两次都是 stat+open+read(64KB)+切首行,读的是**同一段 64KB**。
 * 用指纹缓存把这一趟同步里的第二次读省掉;文件一变(mtime/size 变)即失效。
 * 只留很小的容量 —— 它是同一 pass 内的短时复用,不是长期缓存。
 */
const jsonlTailCache = new Map<string, { mtimeMs: number; size: number; content: string }>();
const JSONL_TAIL_CACHE_MAX = 16;

async function readJsonlTailCached(filePath: string): Promise<string> {
  const stats = await stat(filePath);
  const hit = jsonlTailCache.get(filePath);
  if (hit && hit.mtimeMs === stats.mtimeMs && hit.size === stats.size) {
    return hit.content;
  }

  let content: string;
  if (stats.size > TAIL_BYTES) {
    const handle = await open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(TAIL_BYTES);
      await handle.read(buffer, 0, TAIL_BYTES, stats.size - TAIL_BYTES);
      const tail = buffer.toString('utf8');
      content = tail.slice(tail.indexOf('\n') + 1); // 首行大概率被截断,丢掉
    } finally {
      await handle.close();
    }
  } else {
    content = await readFile(filePath, 'utf8');
  }

  jsonlTailCache.set(filePath, { mtimeMs: stats.mtimeMs, size: stats.size, content });
  while (jsonlTailCache.size > JSONL_TAIL_CACHE_MAX) {
    const oldest = jsonlTailCache.keys().next().value;
    if (oldest === undefined) break;
    jsonlTailCache.delete(oldest);
  }
  return content;
}

/**
 * Session indexer for Claude transcript artifacts.
 */
export class ClaudeSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'claude' as const;
  private readonly claudeHome = path.join(os.homedir(), '.claude');

  /**
   * Returns true when a JSONL file is a subagent transcript rather than a
   * top-level session.
   *
   * Claude stores subagent transcripts under a `subagents/` directory, e.g.
   * `~/.claude/projects/<encoded-cwd>/<session-id>/subagents/agent-<id>.jsonl`.
   * Those files repeat the parent session's `sessionId`, so indexing them as
   * standalone sessions overwrites the parent row's `jsonl_path` and corrupts
   * the main session record. The recursive scan in `synchronize()` reaches
   * them, so both entry points must skip them.
   */
  private isSubagentTranscript(filePath: string): boolean {
    return path.normalize(filePath).split(path.sep).includes('subagents');
  }

  /**
   * Scans ~/.claude/projects and upserts discovered sessions into DB.
   */
  async synchronize(since?: Date): Promise<number> {
    const nameMap = await this.cachedHistoryNameMap();
    const files = await findFilesRecursivelyCreatedAfter(
      path.join(this.claudeHome, 'projects'),
      '.jsonl',
      since ?? null
    );

    let processed = 0;
    for (const filePath of files) {
      if (this.isSubagentTranscript(filePath)) {
        continue;
      }

      const parsed = await this.processSessionFile(filePath, nameMap);
      if (!parsed) {
        continue;
      }

      const timestamps = await readFileTimestamps(filePath);
      const lastActivity = await this.extractLastActivityFromEnd(filePath);
      sessionsDb.createSession(
        parsed.sessionId,
        this.provider,
        parsed.projectPath,
        parsed.sessionName,
        timestamps.createdAt,
        lastActivity ?? timestamps.updatedAt,
        filePath
      );
      processed += 1;
    }

    return processed;
  }

  /**
   * Parses and upserts one Claude session JSONL file.
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('.jsonl')) {
      return null;
    }
    if (this.isSubagentTranscript(filePath)) {
      return null;
    }

    const nameMap = await this.cachedHistoryNameMap();
    const parsed = await this.processSessionFile(filePath, nameMap);
    if (!parsed) {
      return null;
    }

    const timestamps = await readFileTimestamps(filePath);
    const lastActivity = await this.extractLastActivityFromEnd(filePath);
    return sessionsDb.createSession(
      parsed.sessionId,
      this.provider,
      parsed.projectPath,
      parsed.sessionName,
      timestamps.createdAt,
      lastActivity ?? timestamps.updatedAt,
      filePath
    );
  }

  /**
   * Extracts session metadata from one Claude JSONL session file.
   */
  private async processSessionFile(
    filePath: string,
    nameMap: Map<string, string>
  ): Promise<ParsedSession | null> {
    const parsed = await extractFirstValidJsonlData(filePath, (rawData) => {
      const data = rawData as Record<string, unknown>;
      const sessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined;
      const projectPath = typeof data.cwd === 'string' ? data.cwd : undefined;

      if (!sessionId || !projectPath) {
        return null;
      }

      return {
        sessionId,
        projectPath,
      };
    });

    if (!parsed) {
      return null;
    }

    // App-created sessions are keyed by an app id, so disk-discovered provider
    // ids must be resolved through the provider-id mapping first.
    const existingSession = sessionsDb.getSessionByProviderSessionId(parsed.sessionId)
      ?? sessionsDb.getSessionById(parsed.sessionId);
    const existingSessionName = existingSession?.custom_name;
    if (existingSessionName && existingSessionName !== 'Untitled Claude Session') {
      return {
        ...parsed,
        sessionName: normalizeSessionName(existingSessionName, 'Untitled Claude Session'),
      };
    }

    let sessionName = nameMap.get(parsed.sessionId);
    if (!sessionName) {
      sessionName = await this.extractSessionAiTitleFromEnd(filePath, parsed.sessionId);
    }

    return {
      ...parsed,
      sessionName: normalizeSessionName(sessionName, 'Untitled Claude Session'),
    };
  }

  /**
   * `~/.claude/history.jsonl` 的 sessionId -> 显示名映射,按文件指纹缓存。
   *
   * 这个文件随用户全部历史无界增长,而同步器每个文件事件都会调一次(去抖后最长
   * 3 秒一轮),原来每次都是全量读 + 逐行 JSON.parse。它只在有新会话被命名时才变,
   * mtime+size 足以判定。
   */
  private historyNameMapCache: { fingerprint: string; map: Map<string, string> } | null = null;

  private async cachedHistoryNameMap(): Promise<Map<string, string>> {
    const historyPath = path.join(this.claudeHome, 'history.jsonl');

    let fingerprint = 'missing';
    try {
      const stats = await stat(historyPath);
      fingerprint = `${stats.mtimeMs}:${stats.size}`;
    } catch {
      // 文件不存在:指纹固定,缓存一个空 map,不必每次重试。
    }

    if (this.historyNameMapCache?.fingerprint === fingerprint) {
      return this.historyNameMapCache.map;
    }

    const map = await buildLookupMap(historyPath, 'sessionId', 'display');
    this.historyNameMapCache = { fingerprint, map };
    return map;
  }

  /**
   * 会话的「真实最后活动时间」= transcript 里最后一条真实消息(user/assistant)的
   * timestamp,而不是文件 mtime。
   *
   * 为什么不能用 mtime(即 readFileTimestamps().updatedAt):点开一个会话会触发
   * 预热(`claude --resume`),SDK 会**碰一下这个 JSONL 的 mtime 却不追加任何消息**
   * (实测行数不变、mtime 变成点击时刻)。侧栏按 updated_at 排序,于是"只是点一下、
   * 没说话"也会把会话顶到最前 —— 这正是用户报的乱序。改用最后一条 user/assistant
   * 消息的时间后:预热碰 mtime 不影响排序,真正发过话才会前移。
   *
   * 只读尾部 64KB(消息在文件末尾),从后往前找第一条 user/assistant 且带合法
   * timestamp 的行。找不到(空会话 / 尾部无对话行)就回 undefined,调用方回落到 mtime。
   */
  private async extractLastActivityFromEnd(filePath: string): Promise<string | undefined> {
    try {
      return pickLastActivityTimestamp(await readJsonlTailCached(filePath));
    } catch {
      // 读不了就交给调用方回落到 mtime。
    }
    return undefined;
  }

  private async extractSessionAiTitleFromEnd(
    filePath: string,
    sessionId: string
  ): Promise<string | undefined> {
    try {
      // 只读文件尾部(标题事件总在末尾附近)。这个尾读与 extractLastActivityFromEnd
      // 读的是同一段 64KB,共用 readJsonlTailCached 的指纹缓存,一次同步里不会把
      // 同一段读两遍。原来是把整份 transcript 读进来切行全 parse,24MB 会话每 3s
      // 135ms + 上万临时数组元素。
      const content = await readJsonlTailCached(filePath);
      const lines = content.split(/\r?\n/);

      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]?.trim();
        if (!line) {
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }

        const data = parsed as Record<string, unknown>;
        const eventType = typeof data.type === 'string' ? data.type : undefined;
        const eventSessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined;
        const aiTitle = typeof data.aiTitle === 'string' ? data.aiTitle : undefined;
        const lastPrompt = typeof data.lastPrompt === 'string' ? data.lastPrompt : undefined;
        const claudeRenamedTitle = typeof data.customTitle === 'string' ? data.customTitle : undefined;

        if (
          (eventType === 'ai-title' && eventSessionId === sessionId && aiTitle?.trim()) ||
          (eventType === 'last-prompt' && eventSessionId === sessionId && lastPrompt?.trim()) ||
          (eventType === "custom-title" && eventSessionId === sessionId && claudeRenamedTitle?.trim())
        ) {
          return aiTitle || lastPrompt || claudeRenamedTitle;
        }
      }
    } catch {
      // Ignore missing/unreadable files so sync can continue.
    }

    return undefined;
  }
}


/**
 * 从一段 JSONL 文本里挑出「最后一条真实对话消息」的时间戳。
 *
 * 从后往前扫,第一条 `type` 为 user/assistant 且带合法 `timestamp` 的行即为所求。
 * 别的行(queue-operation / mode / custom-title / summary / system compact_boundary
 * 等)是元数据,不代表"发生了会话",一律跳过。找不到回 undefined。
 *
 * 抽成纯函数是为了能脱离文件 I/O 单测 —— 这正是「点一下不该改排序、真发过话才改」
 * 这条规则的核心判断。
 */
export function pickLastActivityTimestamp(content: string): string | undefined {
  const lines = content.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const data = parsed as Record<string, unknown>;
    const type = typeof data.type === 'string' ? data.type : undefined;
    const ts = typeof data.timestamp === 'string' ? data.timestamp : undefined;
    if ((type === 'user' || type === 'assistant') && ts) {
      const parsedTs = new Date(ts);
      if (!Number.isNaN(parsedTs.getTime())) {
        return parsedTs.toISOString();
      }
    }
  }
  return undefined;
}
