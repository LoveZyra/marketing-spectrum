import fsSync from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { spawn } from 'cross-spawn';

import { resolveRipgrepPath } from '@/shared/ripgrep-path.js';
import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { canViewerSeeProject } from '@/shared/project-visibility.js';
import { isInternalContent } from '@/modules/providers/list/claude/transcript-provenance.js';

type AnyRecord = Record<string, any>;
type SearchableProvider = 'claude';

type SearchSnippetHighlight = {
  start: number;
  end: number;
};

type SessionConversationMatch = {
  role: string;
  snippet: string;
  highlights: SearchSnippetHighlight[];
  timestamp: string | null;
  provider: SearchableProvider;
  messageUuid?: string | null;
};

type SessionConversationResult = {
  sessionId: string;
  provider: SearchableProvider;
  sessionSummary: string;
  matches: SessionConversationMatch[];
};

type ProjectConversationResult = {
  projectId: string | null;
  projectName: string;
  projectDisplayName: string;
  sessions: SessionConversationResult[];
};

export type SessionConversationSearchProgressUpdate = {
  projectResult: ProjectConversationResult | null;
  totalMatches: number;
  scannedProjects: number;
  totalProjects: number;
};

type SearchViewer = {
  userId?: number | string | null;
  username?: string | null;
};

type SearchSessionConversationsInput = {
  query: string;
  limit: number;
  signal?: AbortSignal;
  onProgress?: (update: SessionConversationSearchProgressUpdate) => void;
  /**
   * Who is searching. Omitted means unscoped — every session on the server.
   * The route always passes it; the default exists for internal callers that
   * legitimately need the full corpus.
   */
  viewer?: SearchViewer;
};

type SessionRepositoryRow = ReturnType<typeof sessionsDb.getAllSessions>[number];
type SearchableSessionRow = SessionRepositoryRow & {
  provider: SearchableProvider;
  jsonl_path: string;
};

type SearchRuntime = {
  matchesQuery: (text: string) => boolean;
  buildSnippet: (text: string) => { snippet: string; highlights: SearchSnippetHighlight[] };
  limit: number;
  totalMatches: number;
  isAborted: () => boolean;
  matchedSessionKeys: Set<string>;
  claudeSessionsByFileKey: Map<string, SearchableSessionRow[]>;
  claudeFileResultsCache: Map<string, Map<string, SessionConversationResult>>;
};

type SearchablePathEntry = {
  normalizedPath: string;
  absolutePath: string;
};

type ProjectBucket = {
  key: string;
  projectId: string | null;
  projectName: string;
  projectDisplayName: string;
  sessions: SearchableSessionRow[];
};

const SUPPORTED_PROVIDERS = new Set<SearchableProvider>(['claude']);
const MAX_MATCHES_PER_SESSION = 2;
const RIPGREP_FILE_CHUNK_SIZE = 40;
const RIPGREP_CHUNK_CONCURRENCY = 6;
const UNKNOWN_PROJECT_KEY = '__unknown_project__';


function normalizeComparablePath(inputPath: string): string {
  if (!inputPath || typeof inputPath !== 'string') {
    return '';
  }

  const withoutLongPathPrefix = inputPath.startsWith('\\\\?\\')
    ? inputPath.slice(4)
    : inputPath;
  const normalized = path.normalize(withoutLongPathPrefix.trim());
  if (!normalized) {
    return '';
  }

  const resolved = path.resolve(normalized);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function chunkArray<TItem>(items: TItem[], size: number): TItem[][] {
  if (size <= 0) {
    return [items];
  }

  const chunks: TItem[][] = [];
  for (let idx = 0; idx < items.length; idx += size) {
    chunks.push(items.slice(idx, idx + size));
  }
  return chunks;
}

function getSessionKey(session: Pick<SessionRepositoryRow, 'provider' | 'session_id'>): string {
  return `${session.provider}:${session.session_id}`;
}

function makeProjectKey(projectPath: string | null): string {
  const normalized = typeof projectPath === 'string' ? projectPath.trim() : '';
  return normalized.length > 0 ? normalized : UNKNOWN_PROJECT_KEY;
}

function toSummaryText(customName: string | null, fallback: string | null | undefined, emptyLabel: string): string {
  const trimmedCustomName = typeof customName === 'string' ? customName.trim() : '';
  if (trimmedCustomName) {
    return trimmedCustomName;
  }

  const trimmedFallback = typeof fallback === 'string' ? fallback.trim() : '';
  if (!trimmedFallback) {
    return emptyLabel;
  }

  return trimmedFallback.length > 50 ? `${trimmedFallback.slice(0, 50)}...` : trimmedFallback;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createWordMatcher(
  rawQuery: string,
  words: string[],
): Pick<SearchRuntime, 'matchesQuery' | 'buildSnippet'> {
  const normalizedQuery = rawQuery.trim().replace(/\s+/g, ' ');
  const requireExactPhrase = words.length > 1 && normalizedQuery.length > 0;
  const wordPatterns = words.map((word) => new RegExp(`(?<!\\p{L})${escapeRegex(word)}(?!\\p{L})`, 'u'));
  const phrasePattern = words.map((word) => escapeRegex(word)).join('\\s+');
  const phraseRegex = new RegExp(phrasePattern, 'iu');

  const allWordsMatch = (textLower: string): boolean =>
    wordPatterns.every((pattern) => pattern.test(textLower));

  const matchesQuery = (text: string): boolean => {
    if (typeof text !== 'string' || text.length === 0) {
      return false;
    }

    if (requireExactPhrase) {
      return phraseRegex.test(text);
    }

    if (phraseRegex.test(text)) {
      return true;
    }

    if (words.length === 1) {
      return allWordsMatch(text.toLowerCase());
    }

    return allWordsMatch(text.toLowerCase());
  };

  const buildSnippet = (
    text: string,
    snippetLen = 150,
  ): { snippet: string; highlights: SearchSnippetHighlight[] } => {
    const textLower = text.toLowerCase();
    let firstIndex = -1;
    let firstWordLen = 0;
    let phraseStart = -1;
    let phraseLength = 0;

    const phraseMatch = phraseRegex.exec(text);
    if (phraseMatch) {
      phraseStart = phraseMatch.index;
      phraseLength = phraseMatch[0].length;
      firstIndex = phraseStart;
      firstWordLen = phraseLength;
    }

    if (firstIndex === -1) {
      for (const word of words) {
        const regex = new RegExp(`(?<!\\p{L})${escapeRegex(word)}(?!\\p{L})`, 'u');
        const match = regex.exec(textLower);
        if (match && (firstIndex === -1 || match.index < firstIndex)) {
          firstIndex = match.index;
          firstWordLen = word.length;
        }
      }
    }

    if (firstIndex === -1) {
      firstIndex = 0;
    }

    const halfLen = Math.floor(snippetLen / 2);
    const start = Math.max(0, firstIndex - halfLen);
    const end = Math.min(text.length, firstIndex + halfLen + firstWordLen);
    const prefix = start > 0 ? '...' : '';
    const suffix = end < text.length ? '...' : '';
    const snippetBody = text.slice(start, end).replace(/\n/g, ' ');
    const snippet = `${prefix}${snippetBody}${suffix}`;

    const snippetLower = snippet.toLowerCase();
    const highlights: SearchSnippetHighlight[] = [];

    if (phraseStart >= start && phraseStart + phraseLength <= end) {
      const phraseOffset = prefix.length + (phraseStart - start);
      highlights.push({
        start: phraseOffset,
        end: phraseOffset + phraseLength,
      });
    }

    if (!requireExactPhrase) {
      for (const word of words) {
        const regex = new RegExp(`(?<!\\p{L})${escapeRegex(word)}(?!\\p{L})`, 'gu');
        let match = regex.exec(snippetLower);
        while (match) {
          highlights.push({ start: match.index, end: match.index + word.length });
          match = regex.exec(snippetLower);
        }
      }
    }

    highlights.sort((left, right) => left.start - right.start);
    const merged: SearchSnippetHighlight[] = [];
    for (const highlight of highlights) {
      const previous = merged[merged.length - 1];
      if (previous && highlight.start <= previous.end) {
        previous.end = Math.max(previous.end, highlight.end);
      } else {
        merged.push({ ...highlight });
      }
    }

    return { snippet, highlights: merged };
  };

  return { matchesQuery, buildSnippet };
}

function extractClaudeText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .filter((part: AnyRecord) => part?.type === 'text' && typeof part?.text === 'string')
    .map((part: AnyRecord) => String(part.text))
    .join(' ');
}

function extractTaggedContent(content: string, tagName: string): string | null {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${escapedTagName}>([\\s\\S]*?)<\\/${escapedTagName}>`).exec(content);
  return match ? match[1] : null;
}

type ClaudeLocalCommandPayload = {
  commandName: string;
  commandMessage: string;
  commandArgs: string;
};

function parseClaudeLocalCommandPayload(content: string): ClaudeLocalCommandPayload | null {
  const commandName = extractTaggedContent(content, 'command-name');
  const commandMessage = extractTaggedContent(content, 'command-message');
  const commandArgs = extractTaggedContent(content, 'command-args');

  if (commandName === null && commandMessage === null && commandArgs === null) {
    return null;
  }

  return {
    commandName: commandName ?? '',
    commandMessage: commandMessage ?? '',
    commandArgs: commandArgs ?? '',
  };
}

function buildClaudeLocalCommandDisplayText(payload: ClaudeLocalCommandPayload): string {
  const commandName = payload.commandName.trim();
  const commandMessage = payload.commandMessage.trim();
  const commandArgs = payload.commandArgs.trim();
  const baseCommand = commandName || commandMessage;

  if (!baseCommand) {
    return '';
  }

  return commandArgs ? `${baseCommand} ${commandArgs}` : baseCommand;
}

function stripAnsiFormatting(text: string): string {
  return text.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '');
}

type ClaudeSearchableMessage = {
  text: string;
  role: 'user' | 'assistant';
};

/**
 * Claude mixes visible chat, compact summaries, and local command wrappers into
 * the same transcript stream. Search should operate on the user-visible meaning
 * of those rows rather than the raw wrapper syntax.
 */
function extractClaudeSearchableMessage(entry: AnyRecord): ClaudeSearchableMessage | null {
  if (!entry.message?.content || entry.isApiErrorMessage) {
    return null;
  }

  const rawRole = entry.message.role;
  if (rawRole !== 'user' && rawRole !== 'assistant') {
    return null;
  }

  if (typeof entry.message.content === 'string') {
    const content = String(entry.message.content);

    if (entry.isCompactSummary === true && content.trim()) {
      return {
        text: content,
        role: 'assistant',
      };
    }

    const localCommand = parseClaudeLocalCommandPayload(content);
    if (localCommand) {
      const displayText = buildClaudeLocalCommandDisplayText(localCommand);
      return displayText
        ? {
            text: displayText,
            role: 'user',
          }
        : null;
    }

    const localCommandStdout = extractTaggedContent(content, 'local-command-stdout');
    if (localCommandStdout !== null) {
      const stdoutText = stripAnsiFormatting(localCommandStdout).trim();
      return stdoutText
        ? {
            text: stdoutText,
            role: 'assistant',
          }
        : null;
    }

    if (!content || isInternalContent(content)) {
      return null;
    }

    return {
      text: content,
      role: rawRole,
    };
  }

  const text = extractClaudeText(entry.message.content);
  if (!text) {
    return null;
  }

  if (entry.isCompactSummary === true) {
    return {
      text,
      role: 'assistant',
    };
  }

  if (isInternalContent(text)) {
    return null;
  }

  return {
    text,
    role: rawRole,
  };
}

function normalizeSearchableSessions(rows: SessionRepositoryRow[]): SearchableSessionRow[] {
  const normalizedRows: SearchableSessionRow[] = [];
  const projectArchiveStateByPath = new Map<string, boolean>();

  for (const row of rows) {
    const provider = row.provider as SearchableProvider;
    if (!SUPPORTED_PROVIDERS.has(provider)) {
      continue;
    }

    const rawJsonlPath = typeof row.jsonl_path === 'string' ? row.jsonl_path.trim() : '';
    if (!rawJsonlPath) {
      continue;
    }

    // 不再逐条 existsSync —— 那是一个同步 fs 调用 × 全部会话数,直接卡事件循环、
    // 拖慢所有用户。ripgrep 用 `--no-messages` + 显式文件列表跑,天生跳过不存在
    // 的文件;而解析(parseClaudeSessionMatches)只碰 rg 命中的文件,那些必然存在。
    // 所以这个预检是纯冗余,删掉即可。
    const absoluteJsonlPath = path.resolve(rawJsonlPath);

    /**
     * Active session rows can still belong to an archived project because
     * project archiving intentionally preserves the underlying session data.
     * Global conversation search should follow the visible workspace model,
     * which means excluding any session whose owning project is archived.
     *
     * Cache the archive lookup per normalized project path so one search pass
     * does not re-query the same project row for every session in that folder.
     */
    const normalizedProjectPath = typeof row.project_path === 'string' ? row.project_path.trim() : '';
    if (normalizedProjectPath) {
      if (!projectArchiveStateByPath.has(normalizedProjectPath)) {
        const projectRow = projectsDb.getProjectPath(normalizedProjectPath);
        projectArchiveStateByPath.set(normalizedProjectPath, Boolean(projectRow?.isArchived));
      }

      if (projectArchiveStateByPath.get(normalizedProjectPath) === true) {
        continue;
      }
    }

    normalizedRows.push({
      ...row,
      provider,
      jsonl_path: absoluteJsonlPath,
    });
  }

  return normalizedRows;
}

function buildProjectBuckets(searchableSessions: SearchableSessionRow[]): ProjectBucket[] {
  const projectBuckets = new Map<string, ProjectBucket>();
  const projectMetadataCache = new Map<string, { projectId: string | null; projectDisplayName: string }>();

  for (const session of searchableSessions) {
    const key = makeProjectKey(session.project_path);
    if (!projectBuckets.has(key)) {
      if (!projectMetadataCache.has(key)) {
        if (key === UNKNOWN_PROJECT_KEY) {
          projectMetadataCache.set(key, {
            projectId: null,
            projectDisplayName: 'Unknown Project',
          });
        } else {
          const projectRow = projectsDb.getProjectPath(key);
          const customProjectName = typeof projectRow?.custom_project_name === 'string'
            ? projectRow.custom_project_name.trim()
            : '';
          const displayName = customProjectName || path.basename(key) || key;

          projectMetadataCache.set(key, {
            projectId: projectRow?.project_id ?? null,
            projectDisplayName: displayName,
          });
        }
      }

      const metadata = projectMetadataCache.get(key) as { projectId: string | null; projectDisplayName: string };
      projectBuckets.set(key, {
        key,
        projectId: metadata.projectId,
        projectName: key,
        projectDisplayName: metadata.projectDisplayName,
        sessions: [],
      });
    }

    const bucket = projectBuckets.get(key) as ProjectBucket;
    bucket.sessions.push(session);
  }

  const buckets = Array.from(projectBuckets.values());
  for (const bucket of buckets) {
    bucket.sessions.sort((left, right) => {
      const leftTs = new Date(left.updated_at || left.created_at || 0).getTime();
      const rightTs = new Date(right.updated_at || right.created_at || 0).getTime();
      return rightTs - leftTs;
    });
  }

  return buckets;
}

/**
 * Executes ripgrep with the file list explicitly provided from sessionsDb jsonl paths.
 *
 * This avoids recursive directory walks and uses a fixed known candidate list.
 */
async function runRipgrepFilesWithMatches(
  pattern: string,
  filePaths: string[],
  signal?: AbortSignal,
): Promise<Set<string>> {
  if (!pattern || filePaths.length === 0 || signal?.aborted) {
    return new Set();
  }

  return new Promise((resolve, reject) => {
    const args = [
      '--files-with-matches',
      '--no-messages',
      '--ignore-case',
      '--fixed-strings',
      '--',
      pattern,
      ...filePaths,
    ];
    // 自带二进制可能根本没下载下来(内网安装 / --ignore-scripts),回落到 PATH 里的 rg。
    const rg = spawn(resolveRipgrepPath() ?? 'rg', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let aborted = false;

    const abortListener = () => {
      aborted = true;
      rg.kill();
    };

    if (signal) {
      signal.addEventListener('abort', abortListener, { once: true });
    }

    rg.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    rg.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    rg.on('error', (error) => {
      if (signal) {
        signal.removeEventListener('abort', abortListener);
      }

      if (aborted || signal?.aborted) {
        resolve(new Set());
        return;
      }

      reject(error);
    });

    rg.on('close', (code) => {
      if (signal) {
        signal.removeEventListener('abort', abortListener);
      }

      if (aborted || signal?.aborted) {
        resolve(new Set());
        return;
      }

      if (code !== 0 && code !== 1) {
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
        reject(new Error(`ripgrep failed with code ${String(code)}: ${stderr}`));
        return;
      }

      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const matchedPaths = new Set<string>();

      for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        matchedPaths.add(normalizeComparablePath(trimmed));
      }

      resolve(matchedPaths);
    });
  });
}

async function findMatchedFileKeys(
  searchablePathEntries: SearchablePathEntry[],
  rawQuery: string,
  words: string[],
  signal?: AbortSignal,
): Promise<Set<string>> {
  if (searchablePathEntries.length === 0 || words.length === 0 || signal?.aborted) {
    return new Set();
  }

  const normalizedQuery = rawQuery.trim().replace(/\s+/g, ' ');
  const requireExactPhrase = words.length > 1 && normalizedQuery.length > 0;

  if (requireExactPhrase) {
    let matchedForPhrase = searchablePathEntries.slice();

    // Keep ripgrep as an over-approximation for exact phrase mode by requiring
    // each word to appear somewhere in the file, then defer strict phrase
    // validation to the in-memory matcher.
    for (const word of words) {
      if (signal?.aborted) {
        return new Set();
      }

      const matchedForWord = new Set<string>();
      const fileChunks = chunkArray(
        matchedForPhrase.map((entry) => entry.absolutePath),
        RIPGREP_FILE_CHUNK_SIZE,
      );

      let nextChunkIndex = 0;
      const workerCount = Math.min(RIPGREP_CHUNK_CONCURRENCY, fileChunks.length);
      const workers = Array.from({ length: workerCount }, async () => {
        while (nextChunkIndex < fileChunks.length && !signal?.aborted) {
          const currentIndex = nextChunkIndex;
          nextChunkIndex += 1;
          const chunkMatches = await runRipgrepFilesWithMatches(word, fileChunks[currentIndex], signal);
          for (const matchedPath of chunkMatches) {
            matchedForWord.add(matchedPath);
          }
        }
      });

      await Promise.all(workers);
      if (signal?.aborted) {
        return new Set();
      }

      matchedForPhrase = matchedForPhrase.filter((entry) => matchedForWord.has(entry.normalizedPath));
      if (matchedForPhrase.length === 0) {
        break;
      }
    }

    return new Set(matchedForPhrase.map((entry) => entry.normalizedPath));
  }

  let remainingEntries = searchablePathEntries.slice();

  // Run one ripgrep pass per term and intersect by keeping only files that
  // matched every query word.
  for (const word of words) {
    if (signal?.aborted) {
      return new Set();
    }

    const matchedForWord = new Set<string>();
    const fileChunks = chunkArray(
      remainingEntries.map((entry) => entry.absolutePath),
      RIPGREP_FILE_CHUNK_SIZE,
    );

    let nextChunkIndex = 0;
    const workerCount = Math.min(RIPGREP_CHUNK_CONCURRENCY, fileChunks.length);

    const workers = Array.from({ length: workerCount }, async () => {
      while (nextChunkIndex < fileChunks.length && !signal?.aborted) {
        const currentIndex = nextChunkIndex;
        nextChunkIndex += 1;
        const chunkMatches = await runRipgrepFilesWithMatches(word, fileChunks[currentIndex], signal);
        for (const matchedPath of chunkMatches) {
          matchedForWord.add(matchedPath);
        }
      }
    });

    await Promise.all(workers);
    if (signal?.aborted) {
      return new Set();
    }

    remainingEntries = remainingEntries.filter((entry) => matchedForWord.has(entry.normalizedPath));
    if (remainingEntries.length === 0) {
      break;
    }
  }

  return new Set(remainingEntries.map((entry) => entry.normalizedPath));
}

function addSessionMatch(
  runtime: SearchRuntime,
  matches: SessionConversationMatch[],
  match: SessionConversationMatch,
): void {
  if (runtime.totalMatches >= runtime.limit || matches.length >= MAX_MATCHES_PER_SESSION) {
    return;
  }

  matches.push(match);
  runtime.totalMatches += 1;
}

async function parseClaudeSessionMatches(
  session: SearchableSessionRow,
  runtime: SearchRuntime,
): Promise<SessionConversationResult | null> {
  const fileKey = normalizeComparablePath(session.jsonl_path);
  if (!fileKey) {
    return null;
  }

  if (!runtime.claudeFileResultsCache.has(fileKey)) {
    const sessionsForFile = runtime.claudeSessionsByFileKey.get(fileKey) || [];
    const matchedSessionsForFile = sessionsForFile.filter((candidate) =>
      runtime.matchedSessionKeys.has(getSessionKey(candidate)),
    );

    const targetSessions = matchedSessionsForFile.length > 0
      ? matchedSessionsForFile
      : [session];

    const targetSessionIds = new Set(targetSessions.map((candidate) => candidate.session_id));
    const customNameBySessionId = new Map<string, string | null>();
    for (const candidate of targetSessions) {
      customNameBySessionId.set(candidate.session_id, candidate.custom_name ?? null);
    }

    type ClaudeSessionSearchState = {
      matches: SessionConversationMatch[];
      pendingSummaries: Map<string, string>;
      fallbackUserText: string | null;
      fallbackAssistantText: string | null;
      resolvedSummary: string | null;
    };

    const sessionStateById = new Map<string, ClaudeSessionSearchState>();
    const getSessionState = (sessionId: string): ClaudeSessionSearchState => {
      if (!sessionStateById.has(sessionId)) {
        sessionStateById.set(sessionId, {
          matches: [],
          pendingSummaries: new Map<string, string>(),
          fallbackUserText: null,
          fallbackAssistantText: null,
          resolvedSummary: null,
        });
      }
      return sessionStateById.get(sessionId) as ClaudeSessionSearchState;
    };

    let currentSessionId: string | null = null;

    try {
      const fileStream = fsSync.createReadStream(session.jsonl_path);
      const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

      for await (const line of rl) {
        if (runtime.totalMatches >= runtime.limit || runtime.isAborted()) {
          break;
        }
        if (!line.trim()) {
          continue;
        }

        let entry: AnyRecord;
        try {
          entry = JSON.parse(line) as AnyRecord;
        } catch {
          continue;
        }

        if (entry.sessionId) {
          currentSessionId = String(entry.sessionId);
        }
        const entrySessionId = entry.sessionId
          ? String(entry.sessionId)
          : currentSessionId;
        if (!entrySessionId || !targetSessionIds.has(entrySessionId)) {
          continue;
        }

        const state = getSessionState(entrySessionId);

        if (entry.type === 'summary' && entry.summary) {
          const summaryValue = String(entry.summary);
          if (entry.sessionId) {
            state.resolvedSummary = summaryValue;
          } else if (entry.leafUuid) {
            state.pendingSummaries.set(String(entry.leafUuid), summaryValue);
          }
        }

        if (!state.resolvedSummary && entry.parentUuid) {
          const pendingSummary = state.pendingSummaries.get(String(entry.parentUuid));
          if (pendingSummary) {
            state.resolvedSummary = pendingSummary;
          }
        }

        const searchableMessage = extractClaudeSearchableMessage(entry);
        if (!searchableMessage) {
          continue;
        }

        const { text, role } = searchableMessage;

        /**
         * Claude compact summaries are the most faithful session-summary source
         * after a `/compact` because they describe the post-compaction state that
         * the resumed session actually continues from. Prefer them over generic
         * fallback user text when present.
         */
        if (entry.isCompactSummary === true) {
          state.resolvedSummary = text;
        }

        if (role === 'user') {
          state.fallbackUserText = text;
        } else {
          state.fallbackAssistantText = text;
        }

        if (!runtime.matchesQuery(text)) {
          continue;
        }

        const { snippet, highlights } = runtime.buildSnippet(text);
        addSessionMatch(runtime, state.matches, {
          role,
          snippet,
          highlights,
          timestamp: entry.timestamp ? String(entry.timestamp) : null,
          provider: 'claude',
          messageUuid: entry.uuid ? String(entry.uuid) : null,
        });
      }
    } catch {
      runtime.claudeFileResultsCache.set(fileKey, new Map());
      return null;
    }

    const fileResults = new Map<string, SessionConversationResult>();
    for (const [sessionId, state] of sessionStateById.entries()) {
      if (state.matches.length === 0) {
        continue;
      }

      fileResults.set(sessionId, {
        sessionId,
        provider: 'claude',
        sessionSummary: toSummaryText(
          customNameBySessionId.get(sessionId) ?? null,
          state.resolvedSummary || state.fallbackUserText || state.fallbackAssistantText,
          'New Session',
        ),
        matches: state.matches,
      });
    }

    runtime.claudeFileResultsCache.set(fileKey, fileResults);
  }

  return runtime.claudeFileResultsCache.get(fileKey)?.get(session.session_id) ?? null;
}

async function parseSessionMatches(
  session: SearchableSessionRow,
  runtime: SearchRuntime,
): Promise<SessionConversationResult | null> {
  if (session.provider === 'claude') {
    return parseClaudeSessionMatches(session, runtime);
  }
  return null;
}

/**
 * Drop sessions whose project this viewer cannot see.
 *
 * Ownership lives on the project, and a session points at a project *path*, so
 * the owner is resolved through one lookup table built up front rather than a
 * query per session — a search already walks every transcript on disk and does
 * not need N more database round trips on top.
 *
 * A session with no project path is treated as public: those come from
 * transcripts discovered on disk before any project row existed, and they are
 * visible in the sidebar to everyone for the same reason.
 */
function restrictToViewer(
  sessions: SearchableSessionRow[],
  viewer: SearchViewer | null,
): SearchableSessionRow[] {
  if (!viewer) {
    return sessions;
  }

  // 每路径一次性取齐完整可见性输入(owner + 显式 visibility + 指定用户授权),
  // 授权列表按 project_id 惰性取并缓存,避免逐 session 重复查。
  type PathMeta = { ownerUserId: number | null; visibility: string | null; projectId: string };
  const metaByPath = new Map<string, PathMeta>();
  for (const project of projectsDb.getProjectPaths(null)) {
    metaByPath.set(normalizeComparablePath(project.project_path), {
      ownerUserId: project.owner_user_id ?? null,
      visibility: project.visibility ?? null,
      projectId: project.project_id,
    });
  }
  for (const project of projectsDb.getArchivedProjectPaths(null)) {
    metaByPath.set(normalizeComparablePath(project.project_path), {
      ownerUserId: project.owner_user_id ?? null,
      visibility: project.visibility ?? null,
      projectId: project.project_id,
    });
  }

  const sharesCache = new Map<string, number[]>();
  const sharedUserIdsFor = (projectId: string): number[] => {
    const cached = sharesCache.get(projectId);
    if (cached) return cached;
    const ids = projectsDb.getProjectSharedUserIds(projectId);
    sharesCache.set(projectId, ids);
    return ids;
  };

  return sessions.filter((session) => {
    const key = normalizeComparablePath(session.project_path ?? '');
    if (!key || !metaByPath.has(key)) {
      return true;
    }

    const meta = metaByPath.get(key)!;
    return canViewerSeeProject({
      ownerUserId: meta.ownerUserId,
      viewerUserId: viewer.userId,
      viewerUsername: viewer.username,
      projectPath: session.project_path ?? null,
      visibility: meta.visibility,
      sharedUserIds: sharedUserIdsFor(meta.projectId),
    });
  });
}

export async function searchConversations(
  query: string,
  limit = 50,
  onProjectResult: ((update: SessionConversationSearchProgressUpdate) => void) | null = null,
  signal: AbortSignal | null = null,
  viewer: SearchViewer | null = null,
): Promise<{ results: ProjectConversationResult[]; totalMatches: number; query: string }> {
  const safeQuery = typeof query === 'string' ? query.trim() : '';
  const safeLimit = Math.max(1, Math.min(Number.isFinite(limit) ? limit : 50, 200));
  const words = safeQuery.toLowerCase().split(/\s+/).filter((word) => word.length > 0);

  if (words.length === 0) {
    return { results: [], totalMatches: 0, query: safeQuery };
  }

  const isAborted = () => signal?.aborted === true;
  if (isAborted()) {
    return { results: [], totalMatches: 0, query: safeQuery };
  }

  // Scoped to what this account may see. Without it the search reads every
  // session on the server and returns other people's conversation snippets —
  // the same ownership gap the sidebar had, but leaking message text rather
  // than a project name.
  const searchableSessions = restrictToViewer(
    normalizeSearchableSessions(sessionsDb.getAllSessions()),
    viewer,
  );
  if (searchableSessions.length === 0) {
    return { results: [], totalMatches: 0, query: safeQuery };
  }

  const sessionsByPathKey = new Map<string, SearchableSessionRow[]>();
  const searchablePathEntries: SearchablePathEntry[] = [];

  for (const session of searchableSessions) {
    const normalizedPath = normalizeComparablePath(session.jsonl_path);
    if (!normalizedPath) {
      continue;
    }

    if (!sessionsByPathKey.has(normalizedPath)) {
      sessionsByPathKey.set(normalizedPath, []);
      searchablePathEntries.push({
        normalizedPath,
        absolutePath: session.jsonl_path,
      });
    }

    const pathSessions = sessionsByPathKey.get(normalizedPath) as SearchableSessionRow[];
    pathSessions.push(session);
  }

  const matchedFileKeys = await findMatchedFileKeys(
    searchablePathEntries,
    safeQuery,
    words,
    signal ?? undefined,
  );
  if (isAborted() || matchedFileKeys.size === 0) {
    return { results: [], totalMatches: 0, query: safeQuery };
  }

  const matchedSessionKeys = new Set<string>();
  for (const fileKey of matchedFileKeys) {
    const sessions = sessionsByPathKey.get(fileKey);
    if (!sessions) {
      continue;
    }

    for (const session of sessions) {
      matchedSessionKeys.add(getSessionKey(session));
    }
  }

  const projectBuckets = buildProjectBuckets(searchableSessions);
  const totalProjects = projectBuckets.length;
  const results: ProjectConversationResult[] = [];
  let scannedProjects = 0;

  const runtime: SearchRuntime = {
    ...createWordMatcher(safeQuery, words),
    limit: safeLimit,
    totalMatches: 0,
    isAborted,
    matchedSessionKeys,
    claudeSessionsByFileKey: new Map<string, SearchableSessionRow[]>(),
    claudeFileResultsCache: new Map<string, Map<string, SessionConversationResult>>(),
  };

  for (const [fileKey, sessions] of sessionsByPathKey.entries()) {
    const claudeSessions = sessions.filter((session) => session.provider === 'claude');
    if (claudeSessions.length > 0) {
      runtime.claudeSessionsByFileKey.set(fileKey, claudeSessions);
    }
  }

  for (const bucket of projectBuckets) {
    if (runtime.totalMatches >= runtime.limit || runtime.isAborted()) {
      break;
    }

    const projectResult: ProjectConversationResult = {
      projectId: bucket.projectId,
      projectName: bucket.projectName,
      projectDisplayName: bucket.projectDisplayName,
      sessions: [],
    };

    for (const session of bucket.sessions) {
      if (runtime.totalMatches >= runtime.limit || runtime.isAborted()) {
        break;
      }
      if (!matchedSessionKeys.has(getSessionKey(session))) {
        continue;
      }

      const sessionResult = await parseSessionMatches(session, runtime);
      if (sessionResult) {
        projectResult.sessions.push(sessionResult);
      }
    }

    scannedProjects += 1;
    if (projectResult.sessions.length > 0) {
      results.push(projectResult);
      onProjectResult?.({
        projectResult,
        totalMatches: runtime.totalMatches,
        scannedProjects,
        totalProjects,
      });
    } else if (onProjectResult && scannedProjects % 10 === 0) {
      onProjectResult({
        projectResult: null,
        totalMatches: runtime.totalMatches,
        scannedProjects,
        totalProjects,
      });
    }
  }

  return {
    results,
    totalMatches: runtime.totalMatches,
    query: safeQuery,
  };
}

/**
 * Application service for session-conversation search.
 *
 * Provider routes call this service so route handlers stay focused on
 * request parsing/response formatting, while search execution remains
 * centralized in one place.
 */
export const sessionConversationsSearchService = {
  /**
   * Streams progress updates while the search scans provider session logs.
   */
  async search(input: SearchSessionConversationsInput): Promise<void> {
    await searchConversations(
      input.query,
      input.limit,
      input.onProgress ?? null,
      input.signal ?? null,
      input.viewer ?? null,
    );
  },
};
