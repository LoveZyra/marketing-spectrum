/**
 * Claude SDK Integration
 *
 * This module provides SDK-based integration with Claude using the @anthropic-ai/claude-agent-sdk.
 * It mirrors the interface of claude-cli.js but uses the SDK internally for better performance
 * and maintainability.
 *
 * Key features:
 * - Direct SDK integration without child processes
 * - Session management with abort capability
 * - Options mapping between CLI and SDK formats
 * - WebSocket message streaming
 */

import crypto from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { buildClaudeUserContent, normalizeImageDescriptors } from './shared/image-attachments.js';
import {
  changedFilesSince,
  createCheckpoint,
  isGitRepository,
  pruneCheckpoints,
  updateCheckpointSession
} from './services/git-checkpoint.js';
import {
  detectTestCommand,
  parseLoopCommand,
  runTestCommand
} from './services/agent-loop.js';
import { CLAUDE_FALLBACK_MODELS } from './modules/providers/list/claude/claude-models.provider.js';
import { providerModelsService } from './modules/providers/services/provider-models.service.js';
import { resolveClaudeCodeExecutablePath } from './shared/claude-cli-path.js';
import {
  createNotificationEvent,
  notifyRunFailed,
  notifyRunStopped,
  notifyUserIfEnabled
} from './services/notification-orchestrator.js';
import { sessionsService } from './modules/providers/services/sessions.service.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { createCompleteMessage, createNormalizedMessage } from './shared/utils.js';

const activeSessions = new Map();
const pendingToolApprovals = new Map();
// Sessions cancelled via abort-session. The abort handler already sent the
// terminal `complete` (aborted: true) to the client, so the run loop must not
// emit a second one when its generator winds down.
const abortedSessionIds = new Set();

/**
 * 审批请求等多久。
 *
 * **0 = 一直等**,这是现在的默认值,而且是有意的。
 *
 * 原来这里是 55 秒,到点返回 `{ behavior: 'deny' }`。问题不在于 55 秒短,而在于
 * 这个钟是从「把帧 send 出去」开始走的,而 send 到底有没有送达**没有人知道** ——
 * `ChatSessionWriter.forward()` 在 socket 不是 OPEN 时静默丢弃。于是掉线、切标签页、
 * 或者审批帧发到了另一个抢走 writer 的浏览器时,55 秒后系统**替用户拒绝了一个
 * 用户从来没看见过的请求**,而聊天里只留下一句 "Permission request timed out"。
 *
 * 更糟的是时间对不上:客户端要沉默 60 秒才开始重连,服务端心跳 30 秒一轮、
 * 通常两轮才判定 socket 是僵的 —— **两个恢复机制都比 55 秒长**,补发这条路
 * 结构上就赢不了这场竞速。
 *
 * 所以改成一直等。中止的责任回到本来就该负责的地方:用户点停止(turn 的
 * AbortSignal)、turn 看门狗(PRISM_TURN_TIMEOUT_MS,默认 1 小时)、以及会话被
 * 销毁。这三条都会走 `signal` 分支返回 `{ cancelled: true }`,和超时不同的是
 * **它们都是有人真的做了决定**。
 *
 * 想退回旧行为就设 CLAUDE_TOOL_APPROVAL_TIMEOUT_MS=55000。
 */
const TOOL_APPROVAL_TIMEOUT_MS = parseInt(process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS, 10) || 0;

/**
 * 一次性路径上的审批上限。
 *
 * 常驻 runtime 有 turn 看门狗兜底(`PRISM_TURN_TIMEOUT_MS`),所以那边可以真的
 * 一直等 —— 卡死的那一轮会被看门狗以**取消**的形式收掉,而不是被悄悄拒绝。
 * 一次性路径没有看门狗,真无限等会把 SDK 进程和它占的 one-shot 名额永久钉住,
 * 所以这里保留一个上限,并且刻意取同一个值,免得两条路的行为悄悄分叉。
 */
const ONESHOT_APPROVAL_TIMEOUT_MS = (() => {
  const parsed = parseInt(process.env.PRISM_TURN_TIMEOUT_MS, 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  if (Number.isFinite(parsed) && parsed === 0) return 0; // 看门狗关掉了,这里也跟着不限
  return 3600000; // 1 小时,与 TURN_TIMEOUT_MS 的默认值一致
})();

/**
 * 「跳过权限」档位在 root 下会被 CLI 拒掉 —— 提前说清楚,而不是让它 exit 1。
 *
 * CLI 里的硬检查逐字是这样的:
 *
 * ```js
 * if (mode === "bypassPermissions" || flag) {
 *   if (process.getuid?.() === 0 && process.env.IS_SANDBOX !== "1" && !CLAUDE_CODE_BUBBLEWRAP) {
 *     console.error("--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons");
 *     process.exit(1);
 *   }
 * }
 * ```
 *
 * 也就是说:**只有这一个档位受影响**,其余四个档位在 root 下照常工作。
 * 而它失败的方式是子进程立刻退出,退出码 1,没有任何其它信息 —— 在接上 stderr
 * 回调之前,这在服务端看起来和"CLI 没装""认证过期""磁盘满"完全一样。
 *
 * 返回一段人话说明,或者 null(表示没问题)。
 *
 * @param {string} permissionMode 本轮实际生效的权限模式
 * @returns {string|null}
 */
export function describeBypassUnderRoot(permissionMode) {
  if (permissionMode !== 'bypassPermissions') return null;
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return null;
  if (process.env.IS_SANDBOX === '1' || process.env.CLAUDE_CODE_BUBBLEWRAP) return null;

  return '当前服务以 root 运行，而「跳过权限」这个执行档位被 Claude CLI 拒绝'
    + '（原话：--dangerously-skip-permissions cannot be used with root/sudo privileges）。\n\n'
    + '两个办法：\n'
    + '· 换一个执行档位 —— 默认 / 计划 / 接受编辑 / 自动 这四个在 root 下都正常。\n'
    + '· 或者让运维在 Prism 的 .env 里设 `IS_SANDBOX=1` 后重启，'
    + '这会放行该档位（代价见 .env.example 里的说明）。';
}

/** 审批没等到回答时的说法 —— 说清楚是"没人回答",而不是含糊的"超时"。 */
const APPROVAL_UNANSWERED_MESSAGE =
  '这条工具权限请求一直没有人回应，已按拒绝处理。'
  + '（如果你从没见过这个确认框：它只在你正**在看**该会话时才会弹出，'
  + '侧栏该会话左侧的红点就是它在等你的提示。）';

const TOOLS_REQUIRING_INTERACTION = new Set(['AskUserQuestion', 'ExitPlanMode']);

/**
 * 发一条审批请求,并说清楚它到底送到了几个浏览器。
 *
 * 审批请求和普通内容帧不一样:内容帧丢了有补发游标兜底,审批请求没有第二次机会
 * —— 它是一个**在等人回答的问题**。所以这里要知道有没有人收到。
 *
 * 送到 0 个人不再是灾难(超时已经改成"一直等",不会再替用户拒绝),但它是一个
 * 值得记一笔的事实:用户当下看不到这个框,要等他重连或切回这个会话,由
 * `chat_subscribed` 的 pendingPermissions 补上。日志里有这一行,下次再有人问
 * "为什么没弹窗"时就不用靠猜。
 *
 * @returns {number} 送达的订阅者数量;拿不到投递信息时返回 -1(未知)
 */
function sendPermissionRequest(writer, message, { toolName, sessionId }) {
  if (typeof writer?.sendAndCountDelivered === 'function') {
    const delivered = writer.sendAndCountDelivered(message);
    if (delivered === 0) {
      console.warn(
        `[Claude SDK] 审批请求没有送达任何浏览器 (tool=${toolName}, session=${sessionId || 'none'}) —— `
        + '会一直挂着,等用户重连或切回该会话时由 pendingPermissions 补上。',
      );
    }
    return delivered;
  }

  // 内部路径(prewarm、agent loop)拿到的可能是别的 writer,退回即发即忘。
  writer.send(message);
  return -1;
}

/** claude CLI stderr 只留最后这么多行。 */
const STDERR_TAIL_LINES = 40;

/**
 * 收集 claude CLI 子进程的 stderr。
 *
 * SDK 起的是一个子进程。子进程一起来就失败时,SDK 抛的是
 * `Claude Code process exited with code 1` —— 一个退出码,没有原因。而真正的原因
 * (CLI 没装、认证过期、`~/.claude/settings.json` 语法坏了、磁盘满、CLI 自动升级
 * 到了和 SDK 不兼容的版本)**全都在 stderr 里**。SDK 提供了 `stderr` 回调,
 * 不接就直接进黑洞。
 *
 * 这一条空着的代价是实打实的:线上所有人都发不出消息,而服务端日志里除了那句
 * 退出码什么都没有,只能靠绕开 Prism 手动跑一次 CLI 才能看到真实报错。
 *
 * 只留最后几十行 —— CLI 在 debug 模式下会往 stderr 刷大量内容,全量转发会淹掉
 * 日志,而失败原因总在最后几行。
 */
function createStderrTail() {
  /** @type {string[]} */
  const lines = [];

  const onData = (chunk) => {
    const text = typeof chunk === 'string' ? chunk : String(chunk ?? '');
    if (!text) return;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      lines.push(line);
      if (lines.length > STDERR_TAIL_LINES) lines.shift();
    }
  };

  return {
    onData,
    text: () => lines.join('\n'),
    /**
     * 把 stderr 尾巴贴到错误消息后面。聊天里的那条 error 是用户唯一看得到的
     * 地方,让它带上真实原因,而不是只有一个退出码。
     */
    describe(error) {
      const base = error instanceof Error ? error.message : String(error);
      if (!lines.length) return base;
      return `${base}\n\n--- claude CLI stderr(最后 ${lines.length} 行)---\n${lines.join('\n')}`;
    },
  };
}

function resolveClaudeEffort(model, effort, modelsDefinition = CLAUDE_FALLBACK_MODELS) {
  const selectedModel = modelsDefinition?.OPTIONS?.find((option) => option.value === model) || null;
  const allowedEfforts = selectedModel?.effort?.values
    ?.map((value) => value.value) || [];
  return typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
    ? effort
    : undefined;
}

function createRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function waitForToolApproval(requestId, options = {}) {
  const { timeoutMs = TOOL_APPROVAL_TIMEOUT_MS, signal, onCancel, metadata } = options;

  return new Promise(resolve => {
    let settled = false;

    const finalize = (decision) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(decision);
    };

    let timeout;

    const cleanup = () => {
      pendingToolApprovals.delete(requestId);
      if (timeout) clearTimeout(timeout);
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    // timeoutMs 0 = wait indefinitely (interactive tools)
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        onCancel?.('timeout');
        finalize(null);
      }, timeoutMs);
    }

    const abortHandler = () => {
      onCancel?.('cancelled');
      finalize({ cancelled: true });
    };

    if (signal) {
      if (signal.aborted) {
        onCancel?.('cancelled');
        finalize({ cancelled: true });
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const resolver = (decision) => {
      finalize(decision);
    };
    // Attach metadata for getPendingApprovalsForSession lookup
    if (metadata) {
      Object.assign(resolver, metadata);
    }
    pendingToolApprovals.set(requestId, resolver);
  });
}

/**
 * 某个待批准请求挂在哪个 provider 会话上。
 *
 * 存在的理由是鉴权:`chat.permission-response` 只带一个 requestId,不带会话,
 * 所以在没有这个反查之前,任何已登录的 socket 都能替别人的会话点"允许"。
 * 返回 null 表示这个 requestId 已经不在(超时/已回答/根本没有过)。
 */
function getToolApprovalSessionId(requestId) {
  const resolver = pendingToolApprovals.get(requestId);
  if (!resolver) return null;
  return typeof resolver._sessionId === 'string' ? resolver._sessionId : null;
}

function resolveToolApproval(requestId, decision) {
  const resolver = pendingToolApprovals.get(requestId);
  if (resolver) {
    resolver(decision);
  }
}

// Match stored permission entries against a tool + input combo.
// This only supports exact tool names and the Bash(command:*) shorthand
// used by the UI; it intentionally does not implement full glob semantics,
// introduced to stay consistent with the UI's "Allow rule" format.
function matchesToolPermission(entry, toolName, input) {
  if (!entry || !toolName) {
    return false;
  }

  if (entry === toolName) {
    return true;
  }

  const bashMatch = entry.match(/^Bash\((.+):\*\)$/);
  if (toolName === 'Bash' && bashMatch) {
    const allowedPrefix = bashMatch[1];
    let command = '';

    if (typeof input === 'string') {
      command = input.trim();
    } else if (input && typeof input === 'object' && typeof input.command === 'string') {
      command = input.command.trim();
    }

    if (!command) {
      return false;
    }

    return command.startsWith(allowedPrefix);
  }

  return false;
}

function mapCliOptionsToSDK(options = {}, stderrTail = null) {
  const { sessionId, cwd, toolsSettings, permissionMode, effort } = options;

  const sdkOptions = {};

  // Forward all host env vars (e.g. ANTHROPIC_BASE_URL) to the subprocess.
  // Since SDK 0.2.113, options.env replaces process.env instead of overlaying it.
  sdkOptions.env = { ...process.env };

  // 子进程的 stderr —— 不接这个回调,CLI 起不来时就只剩一个退出码。
  if (stderrTail) {
    sdkOptions.stderr = stderrTail.onData;
  }

  // Resolve the executable eagerly on Windows because the SDK uses raw child_process.spawn,
  // which does not reliably follow npm's shell wrappers like cross-spawn does.
  sdkOptions.pathToClaudeCodeExecutable = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);

  if (cwd) {
    sdkOptions.cwd = cwd;
  }

  if (permissionMode && permissionMode !== 'default') {
    sdkOptions.permissionMode = permissionMode;
  }

  const settings = toolsSettings || {
    allowedTools: [],
    disallowedTools: [],
    skipPermissions: false
  };

  if (settings.skipPermissions && permissionMode !== 'plan') {
    sdkOptions.permissionMode = 'bypassPermissions';
  }

  let allowedTools = [...(settings.allowedTools || [])];

  if (permissionMode === 'plan') {
    const planModeTools = ['Read', 'Task', 'exit_plan_mode', 'TodoRead', 'TodoWrite', 'WebFetch', 'WebSearch'];
    for (const tool of planModeTools) {
      if (!allowedTools.includes(tool)) {
        allowedTools.push(tool);
      }
    }
  }

  sdkOptions.allowedTools = allowedTools;

  // Use the tools preset to make all default built-in tools available (including AskUserQuestion).
  // This was introduced in SDK 0.1.57. Omitting this preserves existing behavior (all tools available),
  // but being explicit ensures forward compatibility and clarity.
  sdkOptions.tools = { type: 'preset', preset: 'claude_code' };

  sdkOptions.disallowedTools = settings.disallowedTools || [];

  sdkOptions.model = options.model || CLAUDE_FALLBACK_MODELS.DEFAULT;

  const resolvedEffort = resolveClaudeEffort(
    sdkOptions.model,
    effort,
    options.effortModels || CLAUDE_FALLBACK_MODELS,
  );
  if (resolvedEffort) {
    sdkOptions.effort = resolvedEffort;
  }

  sdkOptions.systemPrompt = {
    type: 'preset',
    preset: 'claude_code'
  };

  sdkOptions.settingSources = ['project', 'user', 'local'];

  if (sessionId) {
    sdkOptions.resume = sessionId;
  }

  return sdkOptions;
}

/**
 * Adds a session to the active sessions map
 * @param {string} sessionId - Session identifier
 * @param {Object} queryInstance - SDK query instance
 * @param {Object} writer - WebSocket writer for reconnect support
 */
function addSession(sessionId, queryInstance, writer = null) {
  activeSessions.set(sessionId, {
    instance: queryInstance,
    startTime: Date.now(),
    status: 'active',
    writer
  });
}

/**
 * Removes a session from the active sessions map
 * @param {string} sessionId - Session identifier
 */
function removeSession(sessionId) {
  activeSessions.delete(sessionId);
}

/**
 * Gets a session from the active sessions map
 * @param {string} sessionId - Session identifier
 * @returns {Object|undefined} Session data or undefined
 */
function getSession(sessionId) {
  return activeSessions.get(sessionId);
}

/**
 * Gets all active session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getAllSessions() {
  return Array.from(activeSessions.keys());
}

/**
 * Transforms SDK messages to WebSocket format expected by frontend
 * @param {Object} sdkMessage - SDK message object
 * @returns {Object} Transformed message ready for WebSocket
 */
function transformMessage(sdkMessage) {
  // Extract parent_tool_use_id for subagent tool grouping
  if (sdkMessage.parent_tool_use_id) {
    return {
      ...sdkMessage,
      parentToolUseId: sdkMessage.parent_tool_use_id
    };
  }
  return sdkMessage;
}

function readNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Per-model context-window fallbacks used when no exact reading exists. */
const MODEL_CONTEXT_WINDOWS = [
  { pattern: /^claude-/i, total: 200000 },
];
/** Legacy flat default, kept as the last resort for unrecognized models. */
const LEGACY_CONTEXT_WINDOW = 160000;

/**
 * Resolves the context-window denominator for mid-turn token estimates.
 * Precedence: CONTEXT_WINDOW env (explicit operator override) → the last
 * EXACT total reported by getContextUsage() for this runtime → a per-model
 * default map → the legacy 160000 fallback.
 * @param {Object|null} runtime - Persistent runtime (null on the one-shot path)
 * @param {Object|null} sdkMessage - SDK message (assistant messages carry `message.model`)
 * @returns {number} Context window size in tokens
 */
function resolveContextWindowTokens(runtime, sdkMessage) {
  const envWindow = parseInt(process.env.CONTEXT_WINDOW, 10);
  if (Number.isFinite(envWindow) && envWindow > 0) return envWindow;

  const exactTotal = runtime?.lastContextUsage?.maxTokens;
  if (Number.isFinite(exactTotal) && exactTotal > 0) return exactTotal;

  const model = sdkMessage?.message?.model || runtime?.currentModel || '';
  if (typeof model === 'string' && model) {
    for (const entry of MODEL_CONTEXT_WINDOWS) {
      if (entry.pattern.test(model)) return entry.total;
    }
  }
  return LEGACY_CONTEXT_WINDOW;
}

/**
 * Extracts token usage from SDK messages.
 * Prefers per-step `message.usage` (Claude message payload), then falls back
 * to result-level usage/modelUsage for compatibility across SDK versions.
 * @param {Object} sdkMessage - SDK stream message
 * @param {Object|null} runtime - Persistent runtime whose exact context total refines the estimate denominator
 * @returns {Object|null} Token budget object or null
 */
function extractTokenBudget(sdkMessage, runtime = null) {
  if (!sdkMessage || typeof sdkMessage !== 'object') {
    return null;
  }

  const messageUsage = sdkMessage.message?.usage || sdkMessage.usage;
  if (messageUsage && typeof messageUsage === 'object') {
    const directInputTokens = readNumber(messageUsage.input_tokens ?? messageUsage.inputTokens);
    const cacheCreationTokens = readNumber(messageUsage.cache_creation_input_tokens ?? messageUsage.cacheCreationInputTokens ?? messageUsage.cacheCreationTokens);
    const cacheReadTokens = readNumber(messageUsage.cache_read_input_tokens ?? messageUsage.cacheReadInputTokens ?? messageUsage.cacheReadTokens);
    const cacheTokens = cacheCreationTokens + cacheReadTokens;
    const inputTokens = directInputTokens + cacheTokens;
    const outputTokens = readNumber(messageUsage.output_tokens ?? messageUsage.outputTokens);
    const totalUsed = inputTokens + outputTokens;
    const contextWindow = resolveContextWindowTokens(runtime, sdkMessage);

    return {
      used: totalUsed,
      total: contextWindow,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      cacheTokens,
      breakdown: {
        input: inputTokens,
        output: outputTokens,
      },
    };
  }

  if (!sdkMessage.modelUsage || typeof sdkMessage.modelUsage !== 'object') {
    return null;
  }

  // Fallback for older SDK messages with only modelUsage
  const modelKey = Object.keys(sdkMessage.modelUsage)[0];
  const modelData = sdkMessage.modelUsage[modelKey];

  if (!modelData || typeof modelData !== 'object') {
    return null;
  }

  const inputTokens = readNumber(modelData.cumulativeInputTokens ?? modelData.inputTokens);
  const outputTokens = readNumber(modelData.cumulativeOutputTokens ?? modelData.outputTokens);
  const totalUsed = inputTokens + outputTokens;
  const contextWindow = resolveContextWindowTokens(runtime, sdkMessage);

  return {
    used: totalUsed,
    total: contextWindow,
    inputTokens,
    outputTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}

/**
 * Builds the SDK `prompt` payload for one turn.
 *
 * Plain text turns pass the string through unchanged. Turns with image
 * attachments use the SDK's streaming-input mode: a single SDKUserMessage
 * whose content carries the prompt text plus one base64 `image` block per
 * attachment (read from the global `~/.prism/assets` folder).
 *
 * @param {string} command - User prompt
 * @param {Array} images - Image descriptors ({ path, name?, mimeType? })
 * @param {string} cwd - Project working directory image paths resolve against
 * @returns {Promise<string|AsyncIterable>} SDK prompt payload
 */
async function buildPromptPayload(command, images, cwd) {
  if (normalizeImageDescriptors(images).length === 0) {
    return command;
  }

  const content = await buildClaudeUserContent(command, images, cwd);
  return (async function* () {
    yield {
      type: 'user',
      message: {
        role: 'user',
        content
      },
      parent_tool_use_id: null,
      timestamp: new Date().toISOString()
    };
  })();
}

/**
 * Loads MCP server configurations from ~/.claude.json
 * @param {string} cwd - Current working directory for project-specific configs
 * @returns {Object|null} MCP servers object or null if none found
 */
async function loadMcpConfig(cwd) {
  try {
    const claudeConfigPath = path.join(os.homedir(), '.claude.json');

    // Check if config file exists
    try {
      await fs.access(claudeConfigPath);
    } catch (error) {
      // File doesn't exist, return null
      // No config file
      return null;
    }

    // Read and parse config file
    let claudeConfig;
    try {
      const configContent = await fs.readFile(claudeConfigPath, 'utf8');
      claudeConfig = JSON.parse(configContent);
    } catch (error) {
      console.error('Failed to parse ~/.claude.json:', error.message);
      return null;
    }

    // Extract MCP servers (merge global and project-specific)
    let mcpServers = {};

    // Add global MCP servers
    if (claudeConfig.mcpServers && typeof claudeConfig.mcpServers === 'object') {
      mcpServers = { ...claudeConfig.mcpServers };
      // Global MCP servers loaded
    }

    // Add/override with project-specific MCP servers
    if (claudeConfig.claudeProjects && cwd) {
      const projectConfig = claudeConfig.claudeProjects[cwd];
      if (projectConfig && projectConfig.mcpServers && typeof projectConfig.mcpServers === 'object') {
        mcpServers = { ...mcpServers, ...projectConfig.mcpServers };
        // Project MCP servers merged
      }
    }

    // Return null if no servers found
    if (Object.keys(mcpServers).length === 0) {
      return null;
    }
    return mcpServers;
  } catch (error) {
    console.error('Error loading MCP config:', error.message);
    return null;
  }
}

/**
 * Executes a one-shot Claude query using the SDK (legacy per-turn mode).
 * Each call spins up a fresh SDK query and resumes via session id.
 * @param {string} command - User prompt/command
 * @param {Object} options - Query options
 * @param {Object} ws - WebSocket connection
 * @param {Object|null} runEntry - Gateway run registry entry (abort-by-runId)
 * @returns {Promise<void>}
 */
async function queryClaudeSDKOnce(command, options = {}, ws, runEntry = null) {
  const { sessionId, sessionSummary } = options;
  let capturedSessionId = sessionId;
  let sessionCreatedSent = false;
  const stderrTail = createStderrTail();

  const emitNotification = (event) => {
    notifyUserIfEnabled({
      userId: ws?.userId || null,
      writer: ws,
      event
    });
  };

  try {
    const resolvedModel = await providerModelsService.resolveResumeModel(
      'claude',
      sessionId,
      options.model,
    );
    let effortModels = CLAUDE_FALLBACK_MODELS;
    try {
      effortModels = (await providerModelsService.getProviderModels('claude')).models;
    } catch (error) {
      console.warn('[Claude SDK] Unable to load provider models for effort validation:', error);
    }

    const sdkOptions = mapCliOptionsToSDK({
      ...options,
      model: resolvedModel || options.model,
      effortModels,
    }, stderrTail);

    const mcpServers = await loadMcpConfig(options.cwd);
    if (mcpServers) {
      sdkOptions.mcpServers = mcpServers;
    }

    // Turns with image attachments switch to streaming input so the images
    // ride along as real content blocks. Built per query attempt because an
    // async generator cannot be replayed once consumed.
    const createPrompt = () => buildPromptPayload(command, options.images, options.cwd);

    sdkOptions.hooks = {
      Notification: [{
        matcher: '',
        hooks: [async (input) => {
          const message = typeof input?.message === 'string' ? input.message : 'Claude requires your attention.';
          emitNotification(createNotificationEvent({
            provider: 'claude',
            sessionId: capturedSessionId || sessionId || null,
            kind: 'action_required',
            code: 'agent.notification',
            meta: { message, sessionName: sessionSummary },
            severity: 'warning',
            requiresUserAction: true,
            dedupeKey: `claude:hook:notification:${capturedSessionId || sessionId || 'none'}:${message}`
          }));
          return {};
        }]
      }]
    };

    // Caveat: in 'auto' and 'bypassPermissions' modes the SDK resolves approval
    // at the permission-mode step and skips this callback, so interactive tools
    // (AskUserQuestion, ExitPlanMode) won't reach the UI — the classifier/bypass
    // auto-approves them and the model acts on a generated answer. Move these
    // tools to a PreToolUse hook (runs before the mode check) if we need them
    // to work in those modes.
    sdkOptions.canUseTool = async (toolName, input, context) => {
      const requiresInteraction = TOOLS_REQUIRING_INTERACTION.has(toolName);

      if (!requiresInteraction) {
        if (sdkOptions.permissionMode === 'bypassPermissions') {
          return { behavior: 'allow', updatedInput: input };
        }

        const isDisallowed = (sdkOptions.disallowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isDisallowed) {
          return { behavior: 'deny', message: 'Tool disallowed by settings' };
        }

        const isAllowed = (sdkOptions.allowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isAllowed) {
          return { behavior: 'allow', updatedInput: input };
        }
      }

      const requestId = createRequestId();
      sendPermissionRequest(
        ws,
        createNormalizedMessage({ kind: 'permission_request', requestId, toolName, input, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }),
        { toolName, sessionId: capturedSessionId || sessionId || null },
      );
      emitNotification(createNotificationEvent({
        provider: 'claude',
        sessionId: capturedSessionId || sessionId || null,
        kind: 'action_required',
        code: 'permission.required',
        meta: { toolName, sessionName: sessionSummary },
        severity: 'warning',
        requiresUserAction: true,
        dedupeKey: `claude:permission:${capturedSessionId || sessionId || 'none'}:${requestId}`
      }));

      const decision = await waitForToolApproval(requestId, {
        // 一次性路径没有 turn 看门狗(常驻 runtime 那边有),所以这里不能真的
        // 无限等 —— 一个永远没人回答的审批会把这个 SDK 进程和它占的
        // one-shot 名额永久钉住。用和看门狗同一个上限兜底:够长到任何重连、
        // 切页、午休都赢得了这场竞速,又不会真的泄漏。
        timeoutMs: requiresInteraction ? 0 : ONESHOT_APPROVAL_TIMEOUT_MS,
        signal: context?.signal,
        metadata: {
          _sessionId: capturedSessionId || sessionId || null,
          // app 会话 id —— 补发时用它兜底,provider 原生 id 开局是 null。
          _appSessionId: typeof options.runId === 'string' ? options.runId : null,
          _toolName: toolName,
          _input: input,
          _receivedAt: new Date(),
        },
        onCancel: (reason) => {
          ws.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
        }
      });
      if (!decision) {
        return { behavior: 'deny', message: APPROVAL_UNANSWERED_MESSAGE };
      }

      if (decision.cancelled) {
        return { behavior: 'deny', message: 'Permission request cancelled' };
      }

      if (decision.allow) {
        if (decision.rememberEntry && typeof decision.rememberEntry === 'string') {
          if (!sdkOptions.allowedTools.includes(decision.rememberEntry)) {
            sdkOptions.allowedTools.push(decision.rememberEntry);
          }
          if (Array.isArray(sdkOptions.disallowedTools)) {
            sdkOptions.disallowedTools = sdkOptions.disallowedTools.filter(entry => entry !== decision.rememberEntry);
          }
        }
        return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
      }

      return { behavior: 'deny', message: decision.message ?? 'User denied tool use' };
    };

    // Query constructor reads this synchronously.
    const prevStreamTimeout = process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
    process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = '300000';

    let queryInstance;
    try {
      queryInstance = query({
        prompt: await createPrompt(),
        options: sdkOptions
      });
    } catch (hookError) {
      // Older/newer SDK versions may not accept hook shapes yet.
      // Keep notification behavior operational via runtime events even if hook registration fails.
      console.warn('Failed to initialize Claude query with hooks, retrying without hooks:', hookError?.message || hookError);
      delete sdkOptions.hooks;
      queryInstance = query({
        prompt: await createPrompt(),
        options: sdkOptions
      });
    }

    // Restore immediately — Query constructor already captured the value
    if (prevStreamTimeout !== undefined) {
      process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = prevStreamTimeout;
    } else {
      delete process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
    }

    // Track the query instance for abort capability — both by session id and
    // on the gateway run entry (abort-by-runId before the id is known).
    if (runEntry) {
      runEntry.queryInstance = queryInstance;
    }
    if (capturedSessionId) {
      addSession(capturedSessionId, queryInstance, ws);
    }

    // Process streaming messages
    console.log('Starting async generator loop for session:', capturedSessionId || 'NEW');
    for await (const message of queryInstance) {
      // Capture session ID from first message
      if (message.session_id && !capturedSessionId) {

        capturedSessionId = message.session_id;
        addSession(capturedSessionId, queryInstance, ws);

        // Set session ID on writer
        if (ws.setSessionId && typeof ws.setSessionId === 'function') {
          ws.setSessionId(capturedSessionId);
        }

        // Send session-created event only once for new sessions
        if (!sessionId && !sessionCreatedSent) {
          sessionCreatedSent = true;
          ws.send(createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, sessionId: capturedSessionId, provider: 'claude' }));
        }
      } else {
        // session_id already captured
      }

      // Transform and normalize message via adapter
      const transformedMessage = transformMessage(message);
      const sid = capturedSessionId || sessionId || null;

      // Use adapter to normalize SDK events into NormalizedMessage[]
      const normalized = sessionsService.normalizeMessage('claude', transformedMessage, sid);
      for (const msg of normalized) {
        // Preserve parentToolUseId from SDK wrapper for subagent tool grouping
        if (transformedMessage.parentToolUseId && !msg.parentToolUseId) {
          msg.parentToolUseId = transformedMessage.parentToolUseId;
        }
        ws.send(msg);
      }

      // Extract and send token budget updates from assistant/result usage payloads
      const tokenBudgetData = extractTokenBudget(message);
      if (tokenBudgetData) {
        ws.send(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget: tokenBudgetData, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      }
    }

    // Clean up session on completion
    if (capturedSessionId) {
      removeSession(capturedSessionId);
    }

    // Send the terminal completion event — skipped for aborted runs, whose
    // terminal `complete` (aborted: true) was already sent by abort-session
    // (or by the runId abort route for runs without a native id yet).
    const wasAborted = (capturedSessionId ? abortedSessionIds.delete(capturedSessionId) : false)
      || Boolean(runEntry?.aborted);
    if (!wasAborted) {
      ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 0 }));
    }
    notifyRunStopped({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: capturedSessionId || sessionId || null,
      sessionName: sessionSummary,
      stopReason: wasAborted ? 'aborted' : 'completed'
    });
    // Complete

  } catch (error) {
    // stderr 一起打出来 —— 单独一句 "exited with code 1" 在日志里定位不了任何东西。
    console.error('SDK query error:', stderrTail.describe(error));

    // Clean up session on error
    if (capturedSessionId) {
      removeSession(capturedSessionId);
    }

    const wasAborted = (capturedSessionId ? abortedSessionIds.delete(capturedSessionId) : false)
      || Boolean(runEntry?.aborted);
    if (wasAborted) {
      // The abort already produced the terminal complete; a generator throw
      // caused by interrupt() is expected noise, not a user-facing error.
      return;
    }

    // Check if Claude CLI is installed for a clearer error message
    const installed = await providerAuthService.isProviderInstalled('claude');
    const errorContent = !installed
      ? 'Claude Code is not installed. Please install it first: https://docs.anthropic.com/en/docs/claude-code'
      : stderrTail.describe(error);

    // Send error to WebSocket, then the terminal complete
    ws.send(createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
    ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 1 }));
    notifyRunFailed({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: capturedSessionId || sessionId || null,
      sessionName: sessionSummary,
      error
    });
  }
}

/**
 * Aborts an active SDK session
 * @param {string} sessionId - Session identifier (provider-native id)
 * @param {Object} [context] - Optional gateway context
 * @param {string} [context.runId] - Gateway runId fallback: aborts the run
 *   registered under this id when no session matches (a brand-new
 *   conversation's first turn has no provider-native id yet)
 * @returns {boolean} True if session was aborted, false if not found
 */
async function abortClaudeSDKSession(sessionId, context = {}) {
  const session = sessionId ? getSession(sessionId) : null;

  if (!session) {
    if (context && typeof context.runId === 'string' && context.runId) {
      return abortClaudeSDKRun(context.runId);
    }
    console.log(`Session ${sessionId} not found`);
    return false;
  }

  const runEntry = context && typeof context.runId === 'string' && context.runId
    ? activeChatRuns.get(context.runId) || null
    : null;

  try {
    console.log(`Aborting SDK session: ${sessionId}`);

    // Mark before interrupting so the run loop knows not to emit its own
    // terminal complete (the abort handler sends the aborted one). The
    // gateway run entry gets the same flag so teardown rejections are
    // classified as aborts rather than failures.
    abortedSessionIds.add(sessionId);
    if (runEntry) runEntry.aborted = true;

    // Call interrupt() on the query instance
    await session.instance.interrupt();

    // Update session status
    session.status = 'aborted';

    // Clean up session
    removeSession(sessionId);

    return true;
  } catch (error) {
    console.error(`Error aborting session ${sessionId}:`, error);
    // The run keeps going; let it emit its own terminal complete.
    abortedSessionIds.delete(sessionId);
    if (runEntry) runEntry.aborted = false;
    return false;
  }
}

/**
 * Checks if an SDK session is currently active
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session is active
 */
function isClaudeSDKSessionActive(sessionId) {
  const session = getSession(sessionId);
  return session && session.status === 'active';
}

/**
 * Gets all active SDK session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getActiveClaudeSDKSessions() {
  return getAllSessions();
}

/**
 * 一条待批审批算不算挂在这个会话上。
 *
 * provider 原生 id **或** app 会话 id 命中都算。
 *
 * 原来只比 `_sessionId`(provider 原生 id),而那个 id 在一轮对话的开头是 null ——
 * `canUseTool` 可能在流里第一条消息回来之前就触发,于是这条待批请求被永久打上
 * `_sessionId: null`,而查询方永远拿着一个非空 id 来问。结果是这条请求
 * **再也不可能被补发**:刷新、重连、切走再切回来,全都捞不出来,用户只能等到超时。
 * app 会话 id 从第一轮开始就存在,拿它兜底就没有这个空窗。
 *
 * 空的 sessionId 一律不命中 —— 否则 `null === null` 会让一条还没拿到任何 id 的
 * 请求被当成"属于每一个还没拿到 id 的会话"。
 *
 * @param {{_sessionId?: unknown, _appSessionId?: unknown}} resolver
 * @param {string} sessionId provider 原生 id 或 app 会话 id
 */
export function approvalBelongsToSession(resolver, sessionId) {
  if (!sessionId || !resolver) return false;
  return resolver._sessionId === sessionId || resolver._appSessionId === sessionId;
}

/**
 * Get pending tool approvals for a specific session.
 * @param {string} sessionId - app 会话 id 或 provider 原生 id
 * @returns {Array} Array of pending permission request objects
 */
function getPendingApprovalsForSession(sessionId) {
  const pending = [];
  if (!sessionId) return pending;
  for (const [requestId, resolver] of pendingToolApprovals.entries()) {
    if (approvalBelongsToSession(resolver, sessionId)) {
      pending.push({
        requestId,
        toolName: resolver._toolName || 'UnknownTool',
        input: resolver._input,
        context: resolver._context,
        sessionId,
        receivedAt: resolver._receivedAt || new Date(),
      });
    }
  }
  return pending;
}

/*
 * `reconnectSessionWriter` 删掉了。
 *
 * 它是"重连时把 writer 换到新 socket 上"的旧实现,而这件事早已由网关侧的
 * `chatRunRegistry.attachConnection` 接管,整个 server/ 里没有任何地方 import
 * 过它。留着的实际危害是它依赖 `writer.updateWebSocket` —— 而那个方法本身就是
 * 抢流问题的来源,现在已经被 `addConnection` 取代。留着一个调用不存在方法的
 * 死函数,只会在下一个人照着它写重连逻辑时把问题带回来。
 */

/* ===================================================================== */
/*  Persistent runtime layer (ported from claude-web-ui 2.0 daemon.mjs)   */
/*                                                                        */
/*  One resident SDK `query()` per conversation, fed by an async input    */
/*  queue. Each turn pushes ONLY the current user message — the SDK owns  */
/*  the conversation history, so nothing is replayed and the native       */
/*  session id stays stable across turns, /compact included.              */
/* ===================================================================== */

const PERSISTENT_ENABLED = process.env.PRISM_PERSISTENT_SESSIONS !== '0';
const CHECKPOINTS_ENABLED = process.env.PRISM_CHECKPOINTS !== '0';
const AUTO_COMPACT_ENABLED = process.env.PRISM_AUTO_COMPACT !== '0';
const AUTO_COMPACT_RATIO = (() => {
  const parsed = parseFloat(process.env.PRISM_AUTO_COMPACT_RATIO);
  return Number.isFinite(parsed) && parsed > 0 && parsed < 1 ? parsed : 0.8;
})();
/**
 * 常驻运行时上限 —— **整台服务器**的,不是每人的。
 *
 * 一个常驻运行时就是一个 Claude SDK 进程。到顶之后 `enforceRuntimeLimit` 先淘汰
 * 空闲的,淘不动就直接让这一轮失败。原来的 8 是单人使用时代的数,多人部署下它是
 * 实打实的容量天花板:八个人各挂着一个活跃对话,第九个人发消息要么把别人的运行时
 * 挤掉(那个人下一轮重建、变慢),要么直接收到 runtime limit 错误。
 *
 * 20 是按多人日常并发定的。内存是主要成本,每个进程的占用随上下文长度走,内存紧张
 * 时用 PRISM_MAX_RUNTIMES 往下调。
 */
const MAX_RUNTIMES = parseInt(process.env.PRISM_MAX_RUNTIMES, 10) || 20;
const IDLE_RUNTIME_MS = parseInt(process.env.PRISM_RUNTIME_IDLE_MS, 10) || 30 * 60 * 1000;
const CONTEXT_USAGE_TIMEOUT_MS = 5000;
/** Extra one-shot fallback slots beyond the resident pool (0 disables overflow). */
const MAX_ONESHOT_OVERFLOW = (() => {
  const parsed = parseInt(process.env.PRISM_MAX_ONESHOT_OVERFLOW, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2;
})();
/** Per-turn watchdog: fail + dispose a runtime whose result never arrives (0 disables). */
const TURN_TIMEOUT_MS = (() => {
  const parsed = parseInt(process.env.PRISM_TURN_TIMEOUT_MS, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 60 * 60 * 1000;
})();

/** Resident runtimes keyed by provider-native session id (or pending:<uuid>). */
const claudeRuntimes = new Map();

/**
 * Live chat runs keyed by gateway runId (the app session id today). This is
 * what lets `chat.abort` reach a run BEFORE the provider-native session id
 * exists — the first turn of a new conversation only gets its native id
 * mid-stream, so the session-id abort route is a no-op until then.
 * Entry shape: { aborted, runtime, queryInstance }.
 */
const activeChatRuns = new Map();

/** One-shot fallback queries currently running because the persistent path failed. */
let activeOneShotFallbacks = 0;

let runtimeMutationChain = Promise.resolve();
/** Serializes runtime create/rebuild/dispose so concurrent sends can't race. */
function withRuntimeMutation(fn) {
  const next = runtimeMutationChain.then(fn, fn);
  runtimeMutationChain = next.then(() => undefined, () => undefined);
  return next;
}

/** Minimal async queue implementing the SDK's streaming-input protocol. */
function createInputQueue() {
  const values = [];
  const waiters = [];
  let closed = false;
  return {
    push(value) {
      if (closed) throw new Error('runtime input is closed');
      const waiter = waiters.shift();
      if (waiter) waiter({ value, done: false });
      else values.push(value);
    },
    close() {
      if (closed) return;
      closed = true;
      while (waiters.length) waiters.shift()({ value: undefined, done: true });
    },
    async next() {
      if (values.length) return { value: values.shift(), done: false };
      if (closed) return { value: undefined, done: true };
      return new Promise((resolveNext) => waiters.push(resolveNext));
    },
    [Symbol.asyncIterator]() { return this; },
  };
}

function isTurnResult(message) {
  return message?.type === 'result' && !message?.parent_tool_use_id;
}

function normalizedPermissionMode(options, settings) {
  if (settings?.skipPermissions && options.permissionMode !== 'plan') {
    return 'bypassPermissions';
  }
  return options.permissionMode && options.permissionMode !== 'default'
    ? options.permissionMode
    : 'default';
}

function runtimeSettingsFromOptions(options) {
  const toolsSettings = options.toolsSettings || {
    allowedTools: [],
    disallowedTools: [],
    skipPermissions: false,
  };
  const permissionMode = normalizedPermissionMode(options, toolsSettings);
  const allowedTools = [...(toolsSettings.allowedTools || [])];
  if (permissionMode === 'plan') {
    for (const tool of ['Read', 'Task', 'exit_plan_mode', 'TodoRead', 'TodoWrite', 'WebFetch', 'WebSearch']) {
      if (!allowedTools.includes(tool)) allowedTools.push(tool);
    }
  }
  return {
    permissionMode,
    allowedTools,
    disallowedTools: [...(toolsSettings.disallowedTools || [])],
  };
}

/** Config axes that force a runtime rebuild (everything else is dynamic). */
function persistentRuntimeSignature(options, settings) {
  return JSON.stringify({
    cwd: options.cwd ? path.resolve(options.cwd) : '',
    effort: options.resolvedEffort || '',
    bypass: settings.permissionMode === 'bypassPermissions',
  });
}

/**
 * SDK options for a resident runtime. Unlike the one-shot path, `canUseTool`
 * and hooks read the runtime's CURRENT turn at call time, so a single query
 * instance serves every turn of the conversation with the right websocket.
 */
function buildPersistentSdkOptions(options, runtime) {
  const sdkOptions = {};
  sdkOptions.env = { ...process.env };
  sdkOptions.pathToClaudeCodeExecutable = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
  // 常驻 runtime 的子进程活很久,stderr 挂在 runtime 上,任何一轮出错都能拿到尾巴。
  if (runtime?.stderrTail) sdkOptions.stderr = runtime.stderrTail.onData;
  if (options.cwd) sdkOptions.cwd = options.cwd;

  // Real cancellation handle: the SDK's `Options.abortController` ("Controller
  // for cancelling the query") tears the query + subprocess down when aborted.
  // Dispose falls back to it when `query.close` is unavailable, and the turn
  // watchdog aborts it so a hung subprocess cannot outlive its runtime.
  runtime.abortController = new AbortController();
  sdkOptions.abortController = runtime.abortController;

  const mode = runtime.settings.permissionMode;
  if (mode && mode !== 'default') sdkOptions.permissionMode = mode;

  sdkOptions.allowedTools = [...runtime.settings.allowedTools];
  sdkOptions.disallowedTools = [...runtime.settings.disallowedTools];
  sdkOptions.tools = { type: 'preset', preset: 'claude_code' };
  sdkOptions.model = options.model || CLAUDE_FALLBACK_MODELS.DEFAULT;
  if (options.resolvedEffort) sdkOptions.effort = options.resolvedEffort;
  sdkOptions.systemPrompt = { type: 'preset', preset: 'claude_code' };
  sdkOptions.settingSources = ['project', 'user', 'local'];
  sdkOptions.includePartialMessages = false;
  sdkOptions.maxTurns = 100;

  if (options.resumeSessionId) sdkOptions.resume = options.resumeSessionId;

  // Prism fork: brand-new conversation branched off an existing native
  // session, optionally truncated at a specific assistant message uuid.
  if (!options.resumeSessionId && options.forkFrom?.providerSessionId) {
    sdkOptions.resume = options.forkFrom.providerSessionId;
    sdkOptions.forkSession = true;
    if (options.forkFrom.resumeSessionAt) {
      sdkOptions.resumeSessionAt = options.forkFrom.resumeSessionAt;
    }
  }

  sdkOptions.hooks = {
    Notification: [{
      matcher: '',
      hooks: [async (input) => {
        const turn = runtime.turn;
        if (!turn) return {};
        const message = typeof input?.message === 'string' ? input.message : 'Claude requires your attention.';
        notifyUserIfEnabled({
          userId: turn.ws?.userId || null,
          writer: turn.ws,
          event: createNotificationEvent({
            provider: 'claude',
            sessionId: runtime.sessionId || null,
            kind: 'action_required',
            code: 'agent.notification',
            meta: { message, sessionName: turn.sessionSummary },
            severity: 'warning',
            requiresUserAction: true,
            dedupeKey: `claude:hook:notification:${runtime.sessionId || 'none'}:${message}`
          })
        });
        return {};
      }]
    }]
  };

  sdkOptions.canUseTool = async (toolName, input, context) => {
    const turn = runtime.turn;
    const settings = runtime.settings;
    const requiresInteraction = TOOLS_REQUIRING_INTERACTION.has(toolName);

    if (!requiresInteraction) {
      if (settings.permissionMode === 'bypassPermissions') {
        return { behavior: 'allow', updatedInput: input };
      }
      const isDisallowed = (settings.disallowedTools || []).some(entry =>
        matchesToolPermission(entry, toolName, input));
      if (isDisallowed) {
        return { behavior: 'deny', message: 'Tool disallowed by settings' };
      }
      const isAllowed = (settings.allowedTools || []).some(entry =>
        matchesToolPermission(entry, toolName, input));
      if (isAllowed) {
        return { behavior: 'allow', updatedInput: input };
      }
    }

    if (!turn) {
      return { behavior: 'deny', message: 'No active turn owns this permission request' };
    }

    const requestId = createRequestId();
    const sid = runtime.sessionId || null;
    sendPermissionRequest(
      turn.ws,
      createNormalizedMessage({ kind: 'permission_request', requestId, toolName, input, sessionId: sid, provider: 'claude' }),
      { toolName, sessionId: sid || runtime.appSessionId },
    );
    notifyUserIfEnabled({
      userId: turn.ws?.userId || null,
      writer: turn.ws,
      event: createNotificationEvent({
        provider: 'claude',
        sessionId: sid,
        kind: 'action_required',
        code: 'permission.required',
        meta: { toolName, sessionName: turn.sessionSummary },
        severity: 'warning',
        requiresUserAction: true,
        dedupeKey: `claude:permission:${sid || 'none'}:${requestId}`
      })
    });

    const decision = await waitForToolApproval(requestId, {
      timeoutMs: requiresInteraction ? 0 : undefined,
      signal: context?.signal,
      metadata: {
        _sessionId: sid,
        // app 会话 id —— 补发时用它兜底,`runtime.sessionId` 在一轮对话开局是 null。
        _appSessionId: runtime.appSessionId || null,
        _toolName: toolName,
        _input: input,
        _receivedAt: new Date(),
      },
      onCancel: (reason) => {
        turn.ws.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: sid, provider: 'claude' }));
      }
    });

    if (!decision) return { behavior: 'deny', message: APPROVAL_UNANSWERED_MESSAGE };
    if (decision.cancelled) return { behavior: 'deny', message: 'Permission request cancelled' };
    if (decision.allow) {
      if (decision.rememberEntry && typeof decision.rememberEntry === 'string') {
        if (!settings.allowedTools.includes(decision.rememberEntry)) {
          settings.allowedTools.push(decision.rememberEntry);
        }
        settings.disallowedTools = settings.disallowedTools.filter(entry => entry !== decision.rememberEntry);
      }
      return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
    }
    return { behavior: 'deny', message: decision.message ?? 'User denied tool use' };
  };

  return sdkOptions;
}

/**
 * The shared reader: consumes the resident query's event stream for the whole
 * conversation, routing each event to whichever turn is currently active.
 */
async function readPersistentRuntime(runtime) {
  try {
    for await (const message of runtime.query) {
      runtime.lastUsed = Date.now();

      // Capture / track the provider-native session id.
      if (message.session_id && runtime.sessionId !== message.session_id) {
        runtime.sessionId = message.session_id;
        rekeyRuntime(runtime);
      }

      const turn = runtime.turn;
      if (!turn) continue; // stray events between turns

      if (message.session_id && !turn.capturedSessionId) {
        turn.capturedSessionId = message.session_id;
        addSession(turn.capturedSessionId, runtime.query, turn.ws);
        if (turn.ws.setSessionId && typeof turn.ws.setSessionId === 'function') {
          turn.ws.setSessionId(turn.capturedSessionId);
        }
        if (turn.isNewSession && !turn.sessionCreatedSent) {
          turn.sessionCreatedSent = true;
          turn.ws.send(createNormalizedMessage({ kind: 'session_created', newSessionId: turn.capturedSessionId, sessionId: turn.capturedSessionId, provider: 'claude' }));
        }
      }

      // Surface native compaction to the UI as a transient status. Internal
      // turns skip it — the auto-compact flow posts its own single notice.
      if (message.type === 'system' && message.subtype === 'compact_boundary') {
        turn.sawCompactBoundary = true;
        if (!turn.internal) {
          turn.ws.send(createNormalizedMessage({
            kind: 'status',
            text: 'Compacting context…',
            canInterrupt: false,
            sessionId: runtime.sessionId || null,
            provider: 'claude'
          }));
        }
      }

      const transformedMessage = transformMessage(message);
      const sid = runtime.sessionId || null;
      const normalized = sessionsService.normalizeMessage('claude', transformedMessage, sid);
      for (const msg of normalized) {
        // Internal turns (the auto-/compact turn) stay invisible to the UI:
        // only errors may surface. Session-id capture, context/token
        // bookkeeping, and result handling still run for these turns.
        if (turn.internal && msg.kind !== 'error') continue;
        if (transformedMessage.parentToolUseId && !msg.parentToolUseId) {
          msg.parentToolUseId = transformedMessage.parentToolUseId;
        }
        turn.streamed = true;
        turn.ws.send(msg);
      }

      const tokenBudgetData = extractTokenBudget(message, runtime);
      if (tokenBudgetData && !turn.internal) {
        turn.ws.send(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget: tokenBudgetData, sessionId: sid, provider: 'claude' }));
      }

      if (isTurnResult(message)) {
        finishPersistentTurn(runtime, { resultMessage: message });
      }
    }
    failActiveTurn(runtime, new Error('Claude SDK runtime ended unexpectedly'));
  } catch (error) {
    failActiveTurn(runtime, error);
    if (!runtime.disposed) {
      // 带上 CLI 的 stderr —— 子进程起不来时,退出码本身说明不了任何问题。
      console.error(
        `[Claude SDK] Persistent runtime ${runtime.key} failed:`,
        runtime.stderrTail ? runtime.stderrTail.describe(error) : (error?.message || error),
      );
    }
  } finally {
    if (claudeRuntimes.get(runtime.key) === runtime) claudeRuntimes.delete(runtime.key);
    runtime.input.close();
    runtime.disposed = true;
  }
}

function rekeyRuntime(runtime) {
  if (!runtime.sessionId || runtime.key === runtime.sessionId) return;
  if (claudeRuntimes.get(runtime.key) === runtime) {
    claudeRuntimes.delete(runtime.key);
  }
  runtime.key = runtime.sessionId;
  claudeRuntimes.set(runtime.key, runtime);
}

function finishPersistentTurn(runtime, { resultMessage }) {
  const turn = runtime.turn;
  if (!turn) return;
  runtime.turn = null;
  runtime.lastUsed = Date.now();
  if (turn.watchdog) clearTimeout(turn.watchdog);
  if (turn.capturedSessionId) removeSession(turn.capturedSessionId);
  turn.resolve({ resultMessage, sessionId: runtime.sessionId || turn.capturedSessionId || null });
}

function failActiveTurn(runtime, error) {
  const turn = runtime.turn;
  if (!turn) return;
  runtime.turn = null;
  if (turn.watchdog) clearTimeout(turn.watchdog);
  if (turn.capturedSessionId) removeSession(turn.capturedSessionId);
  // Mark whether the client already saw partial output for this turn — the
  // dispatcher only replays the turn on the one-shot path when nothing
  // streamed yet (a replay after partial output would duplicate content).
  if (error && typeof error === 'object') {
    error.prismStreamed = Boolean(turn.streamed);
    // 子进程的 stderr 跟着错误一起往上走 —— 分发器那边会把它拼进用户看到的
    // 那条 error 里,否则用户只拿到一个退出码。
    const tail = runtime.stderrTail?.text();
    if (tail) error.prismStderr = tail;
  }
  turn.reject(error);
}

async function disposePersistentRuntime(runtime) {
  if (!runtime || runtime.disposed) return;
  runtime.disposed = true;
  failActiveTurn(runtime, new Error('Claude SDK runtime disposed'));
  runtime.input.close();
  try {
    if (typeof runtime.query?.close === 'function') runtime.query.close();
    else runtime.abortController?.abort();
  } catch (error) {
    console.warn(`[Claude SDK] Runtime close failed:`, error?.message || error);
  }
  if (claudeRuntimes.get(runtime.key) === runtime) claudeRuntimes.delete(runtime.key);
}

/**
 * Aborts the live chat run registered under a gateway runId.
 *
 * Unlike `abortClaudeSDKSession` this works BEFORE the provider-native session
 * id exists (the first turn of a brand-new conversation only learns its id
 * mid-stream), so the stop button is never a no-op. The interrupted turn's
 * result event clears `runtime.turn` via the shared reader, leaving the
 * runtime reusable; if the interrupt itself fails, the runtime is disposed so
 * nothing stays stuck in "running".
 * @param {string} runId - Gateway run identifier (app session id)
 * @returns {Promise<boolean>} True when an abort was delivered or recorded
 */
async function abortClaudeSDKRun(runId) {
  const entry = runId ? activeChatRuns.get(runId) : null;
  if (!entry) return false;
  entry.aborted = true;

  const runtime = entry.runtime;
  const sessionId = runtime?.sessionId || runtime?.turn?.capturedSessionId || null;
  // Mirror abortClaudeSDKSession: the abort handler owns the terminal
  // `complete`, so the run loop must not emit its own.
  if (sessionId) abortedSessionIds.add(sessionId);

  try {
    if (runtime && !runtime.disposed && runtime.turn) {
      console.log(`[Claude SDK] Aborting run ${runId} via runtime interrupt`);
      await runtime.query.interrupt();
      return true;
    }
    if (entry.queryInstance) {
      console.log(`[Claude SDK] Aborting run ${runId} via one-shot interrupt`);
      await entry.queryInstance.interrupt();
      return true;
    }
  } catch (error) {
    console.error(`[Claude SDK] Abort by runId ${runId} failed, disposing runtime:`, error?.message || error);
    if (runtime && !runtime.disposed) {
      try {
        runtime.abortController?.abort();
      } catch { /* best effort */ }
      await disposePersistentRuntime(runtime).catch(() => {});
    }
    return true;
  }
  // No live turn yet: the aborted flag is recorded and the dispatcher will
  // finish the run as aborted before (or instead of) starting the turn.
  return true;
}

async function enforceRuntimeLimit(exceptKey) {
  const idle = [...claudeRuntimes.values()]
    .filter((runtime) => runtime.key !== exceptKey && !runtime.turn)
    .sort((left, right) => left.lastUsed - right.lastUsed);
  while (claudeRuntimes.size >= MAX_RUNTIMES && idle.length) {
    await disposePersistentRuntime(idle.shift());
  }
  if (claudeRuntimes.size >= MAX_RUNTIMES && !claudeRuntimes.has(exceptKey)) {
    const error = new Error(`Claude runtime limit reached (${MAX_RUNTIMES}); close an active conversation and retry`);
    // The dispatcher routes this into the BUDGETED one-shot fallback instead
    // of spawning an uncounted extra SDK process.
    error.prismRuntimeLimit = true;
    throw error;
  }
}

async function createPersistentRuntime(key, options, settings) {
  await enforceRuntimeLimit(key);
  const input = createInputQueue();
  const runtime = {
    key,
    signature: persistentRuntimeSignature(options, settings),
    settings,
    input,
    sessionId: options.resumeSessionId || null,
    initialSessionId: options.resumeSessionId || null,
    turn: null,
    lastUsed: Date.now(),
    disposed: false,
    currentModel: options.model || null,
    currentPermissionMode: settings.permissionMode,
    lastContextUsage: null,
    contextBackfillStarted: false,
    query: null,
    abortController: null,
    stderrTail: createStderrTail(),
    // 网关侧的 app 会话 id。provider 原生 id 要等流里第一条消息才知道,而补发
    // 待批审批需要一个**从第一轮开始就存在**的键。
    appSessionId: typeof options.runId === 'string' ? options.runId : null,
  };

  const sdkOptions = buildPersistentSdkOptions(options, runtime);
  const mcpServers = await loadMcpConfig(options.cwd);
  if (mcpServers) sdkOptions.mcpServers = mcpServers;

  // Keep the streaming-input channel open across long idle gaps between turns;
  // the idle reaper (not this timeout) owns runtime lifecycle.
  const prevStreamTimeout = process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
  process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = String(24 * 60 * 60 * 1000);
  try {
    runtime.query = query({ prompt: input, options: sdkOptions });
  } finally {
    if (prevStreamTimeout !== undefined) {
      process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = prevStreamTimeout;
    } else {
      delete process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
    }
  }

  claudeRuntimes.set(key, runtime);
  runtime.reader = readPersistentRuntime(runtime);
  return runtime;
}

/**
 * Get or build the runtime for one send. Signature changes (cwd/effort/bypass)
 * rebuild the runtime but RESUME the same native conversation, mirroring
 * daemon.mjs `runtimeForSendLocked`.
 */
async function runtimeForSend(options) {
  const settings = runtimeSettingsFromOptions(options);
  const requestedSessionId = options.sessionId || null;
  const key = requestedSessionId || `pending:${createRequestId()}`;
  const signature = persistentRuntimeSignature(options, settings);

  return withRuntimeMutation(async () => {
    let runtime = requestedSessionId ? claudeRuntimes.get(requestedSessionId) : null;

    if (runtime && runtime.disposed) {
      claudeRuntimes.delete(runtime.key);
      runtime = null;
    }

    if (runtime && runtime.turn) {
      throw new Error('A turn is already running for this session');
    }

    if (runtime && runtime.signature !== signature) {
      const resumeSessionId = runtime.sessionId || requestedSessionId;
      await disposePersistentRuntime(runtime);
      runtime = await createPersistentRuntime(key, { ...options, resumeSessionId }, settings);
      return runtime;
    }

    if (runtime) {
      // Dynamic controls: model + permission mode without a rebuild.
      runtime.settings.permissionMode = settings.permissionMode;
      runtime.settings.allowedTools = settings.allowedTools;
      runtime.settings.disallowedTools = settings.disallowedTools;
      // 复用已有 runtime 时也刷一下 —— 它对一段对话是稳定的,但第一次创建
      // 若走的是没有 runId 的内部路径(prewarm、agent loop),这里是补上的机会。
      if (typeof options.runId === 'string' && options.runId) {
        runtime.appSessionId = options.runId;
      }

      if (runtime.currentPermissionMode !== settings.permissionMode) {
        if (typeof runtime.query?.setPermissionMode === 'function') {
          try {
            await runtime.query.setPermissionMode(settings.permissionMode === 'default' ? 'default' : settings.permissionMode);
            runtime.currentPermissionMode = settings.permissionMode;
          } catch (error) {
            console.warn('[Claude SDK] setPermissionMode failed, rebuilding runtime:', error?.message);
            const resumeSessionId = runtime.sessionId || requestedSessionId;
            await disposePersistentRuntime(runtime);
            return createPersistentRuntime(key, { ...options, resumeSessionId }, settings);
          }
        } else {
          const resumeSessionId = runtime.sessionId || requestedSessionId;
          await disposePersistentRuntime(runtime);
          return createPersistentRuntime(key, { ...options, resumeSessionId }, settings);
        }
      }

      const targetModel = options.model || null;
      if (targetModel && runtime.currentModel !== targetModel) {
        if (typeof runtime.query?.setModel === 'function') {
          try {
            await runtime.query.setModel(targetModel);
            runtime.currentModel = targetModel;
          } catch (error) {
            console.warn('[Claude SDK] setModel failed, rebuilding runtime:', error?.message);
            const resumeSessionId = runtime.sessionId || requestedSessionId;
            await disposePersistentRuntime(runtime);
            return createPersistentRuntime(key, { ...options, resumeSessionId }, settings);
          }
        } else {
          const resumeSessionId = runtime.sessionId || requestedSessionId;
          await disposePersistentRuntime(runtime);
          return createPersistentRuntime(key, { ...options, resumeSessionId }, settings);
        }
      }

      return runtime;
    }

    // No live runtime: create one, resuming when the conversation exists.
    return createPersistentRuntime(key, { ...options, resumeSessionId: requestedSessionId }, settings);
  });
}

/** Runs one turn on a resident runtime and resolves when its result arrives. */
async function runPersistentTurn(runtime, { command, images, cwd, ws, sessionSummary, isNewSession, internal = false }) {
  if (runtime.turn) throw new Error('A turn is already running for this session');

  let content;
  if (normalizeImageDescriptors(images).length > 0) {
    content = await buildClaudeUserContent(command, images, cwd);
  } else {
    content = [{ type: 'text', text: command }];
  }

  const turn = {
    ws,
    sessionSummary,
    isNewSession,
    internal,
    capturedSessionId: runtime.sessionId || null,
    sessionCreatedSent: false,
    sawCompactBoundary: false,
    watchdog: null,
    resolve: null,
    reject: null,
  };
  turn.promise = new Promise((resolve, reject) => {
    turn.resolve = resolve;
    turn.reject = reject;
  });

  runtime.turn = turn;
  runtime.lastUsed = Date.now();
  if (runtime.sessionId) addSession(runtime.sessionId, runtime.query, ws);

  try {
    runtime.input.push({
      type: 'user',
      session_id: runtime.sessionId || '',
      parent_tool_use_id: null,
      message: { role: 'user', content },
    });
  } catch (error) {
    runtime.turn = null;
    throw error;
  }

  // Turn watchdog: a result that never arrives would otherwise wedge the
  // runtime in "running" forever. On timeout the turn fails (rejection reaches
  // the UI), the runtime is torn down — its subprocess aborted via the real
  // AbortController — and the next turn resumes on a fresh runtime.
  if (TURN_TIMEOUT_MS > 0) {
    turn.watchdog = setTimeout(() => {
      if (runtime.turn !== turn) return; // result arrived in the meantime
      const timeoutError = new Error(`Claude turn timed out after ${Math.round(TURN_TIMEOUT_MS / 60000)} minutes; the session runtime was restarted`);
      timeoutError.prismTurnTimeout = true;
      console.error(`[Claude SDK] Turn watchdog fired for runtime ${runtime.key}: ${timeoutError.message}`);
      failActiveTurn(runtime, timeoutError);
      try {
        runtime.abortController?.abort();
      } catch { /* best effort */ }
      disposePersistentRuntime(runtime).catch(() => {});
    }, TURN_TIMEOUT_MS);
    turn.watchdog.unref?.();
  }

  return turn.promise;
}

/** Reads native context usage off a resident runtime (best effort). */
async function readRuntimeContextUsage(runtime) {
  if (!runtime || runtime.disposed || typeof runtime.query?.getContextUsage !== 'function') {
    return null;
  }
  try {
    const usage = await Promise.race([
      runtime.query.getContextUsage(),
      new Promise((resolve) => setTimeout(() => resolve(null), CONTEXT_USAGE_TIMEOUT_MS)),
    ]);
    if (!usage || typeof usage !== 'object') return null;
    const totalTokens = readNumber(usage.totalTokens ?? usage.total_tokens);
    const maxTokens = readNumber(usage.maxTokens ?? usage.max_tokens);
    if (!totalTokens || !maxTokens) return null;
    const normalized = { totalTokens, maxTokens, ratio: totalTokens / maxTokens, at: Date.now() };
    runtime.lastContextUsage = normalized;
    return normalized;
  } catch (error) {
    console.warn('[Claude SDK] getContextUsage failed:', error?.message || error);
    return null;
  }
}

function sendContextUsageEvent(ws, sessionId, usage) {
  if (!usage) return;
  ws.send(createNormalizedMessage({
    kind: 'status',
    text: 'token_budget',
    tokenBudget: {
      used: usage.totalTokens,
      total: usage.maxTokens,
      inputTokens: usage.totalTokens,
      outputTokens: 0,
      contextExact: true,
      breakdown: { input: usage.totalTokens, output: 0 },
    },
    sessionId: sessionId || null,
    provider: 'claude',
  }));
}

/**
 * Backfills `runtime.lastContextUsage` after a runtime is (re)created for an
 * EXISTING conversation. Without it the context ring stays blank until a turn
 * completes and the auto-compact check is blind on the first turn after a
 * rebuild/restart. Non-blocking and best-effort: skipped when a turn is
 * already active so it can never race one, and the result is pushed through
 * the usual token_budget channel to whatever socket started the send.
 * @param {Object} runtime - Persistent runtime (resume path only has a sessionId)
 * @param {Object} ws - Writer for the current send
 */
function scheduleContextUsageBackfill(runtime, ws) {
  if (!runtime || runtime.disposed || runtime.turn) return;
  if (!runtime.sessionId || runtime.lastContextUsage || runtime.contextBackfillStarted) return;
  runtime.contextBackfillStarted = true;
  (async () => {
    const usage = await readRuntimeContextUsage(runtime);
    if (usage && !runtime.disposed) {
      sendContextUsageEvent(ws, runtime.sessionId, usage);
    }
  })().catch((error) => {
    console.warn('[Claude SDK] Context usage backfill failed:', error?.message || error);
  });
}

/**
 * Persistent-mode implementation of one chat turn, including 80% high-water
 * auto-compact. The native session id never changes across compaction.
 */
async function queryClaudeSDKPersistent(command, options = {}, ws, runEntry = null) {
  const { sessionId, sessionSummary } = options;

  const resolvedModel = await providerModelsService.resolveResumeModel('claude', sessionId, options.model);
  let effortModels = CLAUDE_FALLBACK_MODELS;
  try {
    effortModels = (await providerModelsService.getProviderModels('claude')).models;
  } catch {
    // fall back to static defaults
  }
  const model = resolvedModel || options.model;
  const resolvedEffort = resolveClaudeEffort(model, options.effort, effortModels);

  const runtimeOptions = { ...options, model, resolvedEffort };
  let runtime = await runtimeForSend(runtimeOptions);
  if (runEntry) runEntry.runtime = runtime;

  // Rebuilt runtime for an existing conversation: probe real context usage in
  // the background so the ring isn't blank and auto-compact isn't blind.
  scheduleContextUsageBackfill(runtime, ws);

  /** Abort state for THIS run, whichever route recorded it (runId or session id). */
  const wasRunAborted = () => Boolean(
    (runEntry && runEntry.aborted)
    || (runtime.sessionId && abortedSessionIds.has(runtime.sessionId))
    || (sessionId && abortedSessionIds.has(sessionId))
  );

  /** Finish like a normal user abort: the abort handler already sent the terminal complete. */
  const finishAborted = () => {
    if (runtime.sessionId) abortedSessionIds.delete(runtime.sessionId);
    if (sessionId) abortedSessionIds.delete(sessionId);
    const sid = runtime.sessionId || sessionId || null;
    notifyRunStopped({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: sid,
      sessionName: sessionSummary,
      stopReason: 'aborted',
    });
    return { sessionId: sid };
  };

  // ---- 80% high-water auto-compact (before pushing the user's message) ----
  const shouldAutoCompact = AUTO_COMPACT_ENABLED
    && !options.skipAutoCompact
    && typeof command === 'string'
    && !command.trimStart().startsWith('/')
    && runtime.lastContextUsage
    && runtime.lastContextUsage.ratio >= AUTO_COMPACT_RATIO;

  if (shouldAutoCompact) {
    ws.send(createNormalizedMessage({
      kind: 'status',
      text: `Context at ${Math.round(runtime.lastContextUsage.ratio * 100)}% — compacting before sending…`,
      canInterrupt: false,
      sessionId: runtime.sessionId || sessionId || null,
      provider: 'claude',
    }));
    try {
      await runPersistentTurn(runtime, {
        command: '/compact',
        images: [],
        cwd: options.cwd,
        ws,
        sessionSummary,
        isNewSession: false,
        internal: true,
      });
      if (!wasRunAborted()) {
        const usage = await readRuntimeContextUsage(runtime);
        sendContextUsageEvent(ws, runtime.sessionId || sessionId || null, usage);
        // The single user-visible auto-compact notice (the internal turn's own
        // output is suppressed by the reader, so this cannot double up).
        ws.send(createNormalizedMessage({
          kind: 'text',
          role: 'assistant',
          content: usage
            ? `🗜️ Context auto-compacted — now at ${Math.round(usage.ratio * 100)}% of the window.`
            : '🗜️ Context auto-compacted.',
          sessionId: runtime.sessionId || sessionId || null,
          provider: 'claude',
        }));
      }
    } catch (error) {
      console.warn('[Claude SDK] Auto-compact failed, continuing with the user turn:', error?.message || error);
    }
    // A user abort that landed DURING the internal /compact turn cancels the
    // whole run — never silently proceed to the real turn.
    if (wasRunAborted()) {
      return finishAborted();
    }
    if (runtime.disposed) {
      runtime = await runtimeForSend({ ...runtimeOptions, sessionId: runtime.sessionId || sessionId });
      if (runEntry) runEntry.runtime = runtime;
    }
  }

  // Abort may also land between chat.send and the first input push (the
  // runId registry makes that window abortable) — bail out before running.
  if (wasRunAborted()) {
    return finishAborted();
  }

  // ---- the user's actual turn ----
  const wasNewSession = !sessionId;
  const { resultMessage, sessionId: finalSessionId } = await runPersistentTurn(runtime, {
    command,
    images: options.images,
    cwd: options.cwd,
    ws,
    sessionSummary,
    isNewSession: wasNewSession,
  });

  const wasAborted = (finalSessionId ? abortedSessionIds.delete(finalSessionId) : false)
    || Boolean(runEntry?.aborted);
  if (!wasAborted) {
    ws.send(createCompleteMessage({ provider: 'claude', sessionId: finalSessionId || sessionId || null, exitCode: resultMessage?.is_error ? 1 : 0 }));
  }
  notifyRunStopped({
    userId: ws?.userId || null,
    provider: 'claude',
    sessionId: finalSessionId || sessionId || null,
    sessionName: sessionSummary,
    stopReason: wasAborted ? 'aborted' : 'completed',
  });

  // ---- post-turn native context usage → exact ring on the client ----
  const usage = await readRuntimeContextUsage(runtime);
  sendContextUsageEvent(ws, finalSessionId || sessionId || null, usage);

  return { sessionId: finalSessionId || sessionId || null };
}

/* ------------------------------------------------------------------ */
/*  /loop — autonomous execute→test→fix loop (Prism)                   */
/* ------------------------------------------------------------------ */

/**
 * Runs `/loop <goal>`: repeated persistent turns against the SAME native
 * conversation, running the project's verification command between rounds
 * and feeding failures back until tests pass or rounds run out.
 */
async function runAgentLoop(loopSpec, options = {}, ws, runEntry = null) {
  const { sessionId, sessionSummary } = options;
  const sendStatus = (text) => ws.send(createNormalizedMessage({
    kind: 'status', text, canInterrupt: true, sessionId: sessionId || null, provider: 'claude',
  }));
  const sendNote = (content) => ws.send(createNormalizedMessage({
    kind: 'text', role: 'assistant', content, sessionId: sessionId || null, provider: 'claude',
  }));

  const resolvedModel = await providerModelsService.resolveResumeModel('claude', sessionId, options.model);
  let effortModels = CLAUDE_FALLBACK_MODELS;
  try {
    effortModels = (await providerModelsService.getProviderModels('claude')).models;
  } catch { /* static fallback */ }
  const model = resolvedModel || options.model;
  const resolvedEffort = resolveClaudeEffort(model, options.effort, effortModels);
  const runtimeOptions = { ...options, model, resolvedEffort };

  const testCommand = loopSpec.testCommand || await detectTestCommand(options.cwd);
  const totalRounds = loopSpec.rounds;

  sendNote([
    `🔁 **Agent Loop 启动**`,
    `目标：${loopSpec.goal}`,
    `最大轮数：${totalRounds} · 验证命令：${testCommand ? `\`${testCommand}\`` : '未检测到（将只执行 1 轮）'}`,
  ].join('\n'));

  let runtime = await runtimeForSend(runtimeOptions);
  if (runEntry) runEntry.runtime = runtime;
  scheduleContextUsageBackfill(runtime, ws);
  let finalSessionId = sessionId || null;
  let passed = false;
  let aborted = false;
  let lastTestOutput = '';
  let round = 0;
  const effectiveRounds = testCommand ? totalRounds : 1;

  for (round = 1; round <= effectiveRounds; round += 1) {
    sendStatus(`Loop ${round}/${effectiveRounds} · Claude 执行中…`);

    const prompt = round === 1
      ? `${loopSpec.goal}\n\n[Agent Loop 第 ${round}/${effectiveRounds} 轮] 完成目标后确保代码可运行${testCommand ? `，验证命令为 \`${testCommand}\`` : ''}。`
      : `[Agent Loop 第 ${round}/${effectiveRounds} 轮] 上一轮的验证命令 \`${testCommand}\` 未通过，输出如下：\n\`\`\`\n${lastTestOutput}\n\`\`\`\n请分析失败原因并继续修复，直到验证通过。`;

    let turnResult;
    try {
      turnResult = await runPersistentTurn(runtime, {
        command: prompt,
        images: [],
        cwd: options.cwd,
        ws,
        sessionSummary,
        isNewSession: !finalSessionId && round === 1 && !sessionId,
      });
    } catch (error) {
      sendNote(`⚠️ Loop 第 ${round} 轮执行失败：${error?.message || error}`);
      break;
    }

    finalSessionId = turnResult.sessionId || finalSessionId;

    // User pressed stop: the abort handler already sent the terminal complete.
    if ((finalSessionId && abortedSessionIds.delete(finalSessionId)) || runEntry?.aborted) {
      aborted = true;
      break;
    }
    if (turnResult.resultMessage?.is_error) {
      sendNote(`⚠️ Loop 第 ${round} 轮的执行返回了错误，循环终止。`);
      break;
    }
    if (runtime.disposed) {
      runtime = await runtimeForSend({ ...runtimeOptions, sessionId: finalSessionId || sessionId });
      if (runEntry) runEntry.runtime = runtime;
    }

    if (!testCommand) break;

    sendStatus(`Loop ${round}/${effectiveRounds} · 运行验证：${testCommand}`);
    const test = await runTestCommand(options.cwd, testCommand);
    lastTestOutput = test.output || '(无输出)';

    if (test.ok) {
      passed = true;
      sendNote(`✅ **Loop 第 ${round} 轮验证通过**\n\`\`\`\n${lastTestOutput.slice(-1500)}\n\`\`\``);
      break;
    }
    sendNote(`❌ Loop 第 ${round} 轮验证未通过${round < effectiveRounds ? '，继续下一轮修复…' : ''}`);
  }

  if (!aborted) {
    const summary = passed
      ? `🏁 Agent Loop 完成：目标达成，验证通过（共 ${round} 轮）。`
      : testCommand
        ? `🏁 Agent Loop 结束：${Math.min(round, effectiveRounds)} 轮后验证仍未通过，请人工检查。`
        : `🏁 Agent Loop 结束：无验证命令，已执行 1 轮。可用 --test "命令" 指定验证方式。`;
    sendNote(summary);
    ws.send(createCompleteMessage({ provider: 'claude', sessionId: finalSessionId || sessionId || null, exitCode: passed || !testCommand ? 0 : 1 }));
  }
  notifyRunStopped({
    userId: ws?.userId || null,
    provider: 'claude',
    sessionId: finalSessionId || sessionId || null,
    sessionName: sessionSummary,
    stopReason: aborted ? 'aborted' : 'completed',
  });

  const usage = await readRuntimeContextUsage(runtime);
  sendContextUsageEvent(ws, finalSessionId || sessionId || null, usage);

  return { sessionId: finalSessionId || sessionId || null };
}

/* ------------------------------------------------------------------ */
/*  Checkpoint wrapper + dispatcher                                    */
/* ------------------------------------------------------------------ */

let pruneCounter = 0;

/**
 * Budgeted one-shot fallback for a failed persistent turn.
 *
 * Global concurrency invariant: resident runtimes + active one-shot fallbacks
 * never exceed MAX_RUNTIMES + MAX_ONESHOT_OVERFLOW. Beyond that the run fails
 * fast with a clear error instead of silently spawning an uncounted SDK
 * process per rejected send (previously unbounded).
 * @param {string} command - User prompt/command
 * @param {Object} options - Query options
 * @param {Object} ws - WebSocket writer
 * @param {Object|null} runEntry - Gateway run registry entry
 * @param {boolean} degradeNotice - True when the fallback is due to the runtime limit (tells the user)
 */
async function runOneShotFallback(command, options, ws, runEntry, degradeNotice) {
  const budget = MAX_RUNTIMES + MAX_ONESHOT_OVERFLOW;
  if (claudeRuntimes.size + activeOneShotFallbacks >= budget) {
    ws.send(createNormalizedMessage({
      kind: 'error',
      content: '并发会话已满，请稍候再试',
      sessionId: options.sessionId || null,
      provider: 'claude',
    }));
    ws.send(createCompleteMessage({ provider: 'claude', sessionId: options.sessionId || null, exitCode: 1 }));
    return;
  }
  if (degradeNotice) {
    // Same channel as the auto-compact notice: a transient one-line status.
    ws.send(createNormalizedMessage({
      kind: 'status',
      text: '已临时降级为一次性会话模式（常驻池已满）',
      canInterrupt: false,
      sessionId: options.sessionId || null,
      provider: 'claude',
    }));
  }
  activeOneShotFallbacks += 1;
  try {
    await queryClaudeSDKOnce(command, options, ws, runEntry);
  } finally {
    activeOneShotFallbacks -= 1;
  }
}

/**
 * Public entry point for one Claude chat turn.
 *
 * Registers the run under the gateway runId (options.runId, the app session
 * id) BEFORE anything else so `chat.abort` can reach the turn even while the
 * provider-native session id is still unknown, then dispatches.
 */
async function queryClaudeSDK(command, options = {}, ws) {
  const runId = typeof options.runId === 'string' && options.runId.length > 0 ? options.runId : null;
  const runEntry = { aborted: false, runtime: null, queryInstance: null };
  if (runId) activeChatRuns.set(runId, runEntry);
  try {
    await queryClaudeSDKDispatch(command, options, ws, runEntry);
  } finally {
    // Identity-checked: never delete a newer run's registration.
    if (runId && activeChatRuns.get(runId) === runEntry) activeChatRuns.delete(runId);
  }
}

/**
 * Dispatches one Claude chat turn.
 *
 * - Persistent mode (default): resident SDK query per conversation.
 * - `options.oneShot` or PRISM_PERSISTENT_SESSIONS=0: legacy per-turn path.
 * - Git checkpoints wrap every non-slash chat turn when the project is a repo.
 */
async function queryClaudeSDKDispatch(command, options, ws, runEntry) {
  // 「跳过权限」+ root 的组合会被 CLI 直接拒掉。在这里拦,而不是让两条路径
  // 各撞一次 —— 一次性回退会用同样的参数再试一遍,同样失败,只是多烧一次进程。
  const bypassProblem = describeBypassUnderRoot(runtimeSettingsFromOptions(options).permissionMode);
  if (bypassProblem) {
    ws.send(createNormalizedMessage({
      kind: 'error',
      content: bypassProblem,
      sessionId: options.sessionId || null,
      provider: 'claude',
    }));
    ws.send(createCompleteMessage({ provider: 'claude', sessionId: options.sessionId || null, exitCode: 1 }));
    return;
  }

  const usePersistent = PERSISTENT_ENABLED && !options.oneShot;

  // /loop runs on the persistent runtime only.
  const loopSpec = usePersistent ? parseLoopCommand(command) : null;
  if (loopSpec && !loopSpec.goal) {
    ws.send(createNormalizedMessage({
      kind: 'error',
      content: '用法：/loop <目标> [--rounds N] [--test "验证命令"]',
      sessionId: options.sessionId || null,
      provider: 'claude',
    }));
    ws.send(createCompleteMessage({ provider: 'claude', sessionId: options.sessionId || null, exitCode: 1 }));
    return;
  }

  // -------- pre-turn checkpoint --------
  let checkpoint = null;
  const trimmedCommand = typeof command === 'string' ? command.trimStart() : '';
  const wantCheckpoint = CHECKPOINTS_ENABLED
    && !options.oneShot
    && options.cwd
    && typeof command === 'string'
    && (!trimmedCommand.startsWith('/') || Boolean(loopSpec));

  if (wantCheckpoint) {
    try {
      if (await isGitRepository(options.cwd)) {
        checkpoint = await createCheckpoint(options.cwd, {
          sessionId: options.sessionId || null,
          prompt: command,
        });
        if (checkpoint) {
          ws.send(createNormalizedMessage({
            kind: 'checkpoint_created',
            checkpoint: {
              id: checkpoint.id,
              createdAt: checkpoint.createdAt,
              cwd: checkpoint.cwd,
            },
            sessionId: options.sessionId || null,
            provider: 'claude',
          }));
        }
      }
    } catch (error) {
      console.warn('[Claude SDK] Checkpoint creation failed:', error?.message || error);
    }
  }

  // -------- run the turn --------
  let turnOutcome = null;
  if (loopSpec) {
    try {
      turnOutcome = await runAgentLoop(loopSpec, options, ws, runEntry);
    } catch (error) {
      const message = error?.message || String(error);
      console.error('[Claude SDK] Agent loop failed:', message);
      ws.send(createNormalizedMessage({ kind: 'error', content: `Agent Loop 失败: ${message}`, sessionId: options.sessionId || null, provider: 'claude' }));
      ws.send(createCompleteMessage({ provider: 'claude', sessionId: options.sessionId || null, exitCode: 1 }));
    }
  } else if (usePersistent) {
    try {
      turnOutcome = await queryClaudeSDKPersistent(command, options, ws, runEntry);
    } catch (error) {
      // 分支判断只看原始 message —— stderr 里可能恰好出现 'already running'
      // 之类的字样,拿拼接过的串去 includes 会把错误路由到错误的分支。
      const message = error?.message || String(error);
      // 而用户在聊天里看到的是这条:把 CLI 的 stderr 拼进去,只有
      // "exited with code 1" 的话,用户和运维都无从下手。
      const displayMessage = error?.prismStderr
        ? `${message}\n\n--- claude CLI stderr ---\n${error.prismStderr}`
        : message;
      if (runEntry?.aborted) {
        // chat.abort already completed the run; the teardown throw is noise.
        // Never replay an aborted turn through the one-shot fallback.
        console.log('[Claude SDK] Persistent turn ended by abort:', message);
        // Consume the abort flag so it cannot bleed into the session's next run.
        if (options.sessionId) abortedSessionIds.delete(options.sessionId);
        if (runEntry.runtime?.sessionId) abortedSessionIds.delete(runEntry.runtime.sessionId);
        notifyRunStopped({
          userId: ws?.userId || null,
          provider: 'claude',
          sessionId: options.sessionId || null,
          sessionName: options.sessionSummary,
          stopReason: 'aborted',
        });
      } else if (message.includes('already running')) {
        ws.send(createNormalizedMessage({ kind: 'error', content: displayMessage, sessionId: options.sessionId || null, provider: 'claude' }));
        ws.send(createCompleteMessage({ provider: 'claude', sessionId: options.sessionId || null, exitCode: 1 }));
      } else if (error?.prismStreamed || error?.prismTurnTimeout) {
        // Partial output already reached the client (or the watchdog killed
        // the turn after a long run) — do NOT replay the turn.
        console.error('[Claude SDK] Persistent turn failed mid-stream:', displayMessage);
        ws.send(createNormalizedMessage({ kind: 'error', content: displayMessage, sessionId: options.sessionId || null, provider: 'claude' }));
        ws.send(createCompleteMessage({ provider: 'claude', sessionId: options.sessionId || null, exitCode: 1 }));
        notifyRunFailed({
          userId: ws?.userId || null,
          provider: 'claude',
          sessionId: options.sessionId || null,
          sessionName: options.sessionSummary,
          error,
        });
      } else if (error?.prismRuntimeLimit) {
        // Resident pool full of busy runtimes: degrade WITHIN the overflow
        // budget (with a visible notice) or fail fast when it is exhausted.
        console.warn('[Claude SDK] Runtime pool full, attempting budgeted one-shot fallback:', message);
        await runOneShotFallback(command, options, ws, runEntry, true);
      } else {
        console.warn('[Claude SDK] Persistent turn failed, falling back to one-shot mode:', message);
        await runOneShotFallback(command, options, ws, runEntry, false);
      }
    }
  } else {
    await queryClaudeSDKOnce(command, options, ws, runEntry);
  }

  // -------- post-turn changed-files summary --------
  if (checkpoint) {
    try {
      const finalSessionId = turnOutcome?.sessionId || options.sessionId || null;
      if (finalSessionId && !checkpoint.sessionId) {
        await updateCheckpointSession(checkpoint.id, finalSessionId);
      }
      const changes = await changedFilesSince(checkpoint.id);
      if (changes.files.length > 0) {
        ws.send(createNormalizedMessage({
          kind: 'changed_files',
          checkpointId: checkpoint.id,
          files: changes.files.map(({ diff, ...rest }) => ({
            ...rest,
            diff: diff && diff.length > 20_000 ? `${diff.slice(0, 20_000)}\n… (truncated)` : diff,
          })),
          truncated: changes.truncated,
          sessionId: finalSessionId,
          provider: 'claude',
        }));
      }
    } catch (error) {
      console.warn('[Claude SDK] Changed-files summary failed:', error?.message || error);
    }

    pruneCounter += 1;
    if (pruneCounter % 20 === 1) {
      pruneCheckpoints().catch(() => {});
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Runtime lifecycle upkeep                                           */
/* ------------------------------------------------------------------ */

const idleReaper = setInterval(() => {
  const now = Date.now();
  for (const runtime of claudeRuntimes.values()) {
    if (!runtime.turn && now - runtime.lastUsed > IDLE_RUNTIME_MS) {
      disposePersistentRuntime(runtime).catch(() => {});
    }
  }
}, 60 * 1000);
idleReaper.unref?.();

/** Look up a resident runtime by provider-native session id. */
function getPersistentRuntime(sessionId) {
  if (!sessionId) return null;
  const runtime = claudeRuntimes.get(sessionId);
  return runtime && !runtime.disposed ? runtime : null;
}

/** REST helper: current native context usage for a conversation. */
async function getClaudeContextUsage(sessionId) {
  const runtime = getPersistentRuntime(sessionId);
  if (!runtime) return null;
  return readRuntimeContextUsage(runtime);
}

/**
 * REST helper: the CLI's real slash-command list, straight from the live
 * runtime's `supportedCommands()`. Cached per runtime (the SDK captures the
 * list at initialize). Returns null when no live runtime exists.
 */
async function getClaudeSlashCommands(sessionId) {
  const runtime = getPersistentRuntime(sessionId);
  if (!runtime || typeof runtime.query?.supportedCommands !== 'function') return null;
  if (runtime.slashCommands) return runtime.slashCommands;
  try {
    const commands = await Promise.race([
      runtime.query.supportedCommands(),
      new Promise((resolve) => setTimeout(() => resolve(null), 4000)),
    ]);
    if (!Array.isArray(commands)) return null;
    runtime.slashCommands = commands
      .map((entry) => ({
        name: `/${String(entry?.name || '').replace(/^\//, '')}`,
        description: entry?.description || '',
        argumentHint: entry?.argumentHint || '',
      }))
      .filter((entry) => entry.name.length > 1);
    return runtime.slashCommands;
  } catch (error) {
    console.warn('[Claude SDK] supportedCommands failed:', error?.message || error);
    return null;
  }
}

// Export public API
/**
 * Build this conversation's resident runtime ahead of the first message.
 *
 * The runtime is otherwise created lazily inside the first send, so launching
 * the Claude subprocess, initialising the SDK and starting any configured MCP
 * servers all land on the user's first turn. Running `claude` in a terminal
 * pays exactly the same cost, but pays it while you watch it boot and before
 * you start typing — which is why the chat felt slower than the shell for the
 * same work.
 *
 * Deliberately best-effort and silent: a failed pre-warm must leave the lazy
 * path untouched, because the only thing worse than a slow first turn is a
 * first turn that fails for a reason the user never asked for. A turn already
 * in flight is left alone (runtimeForSend throws on that) and so is an
 * already-resident runtime, which returns immediately.
 *
 * The options must match what the first real send will pass: the runtime is
 * keyed by a signature over cwd, effort and bypass, so a mismatch just
 * disposes this runtime and builds another, wasting the work.
 */
/**
 * 放开一段对话的常驻 runtime,把所有权让给别人(目前是终端接管)。
 *
 * 两件事同时发生:进程退出让出对 transcript 的写入权,dispose 的收尾让最后一轮
 * 完整落盘 —— 终端随后 `claude --resume` 读到的才是完整记录。不 dispose 直接起
 * 第二个进程,就是现在"shell 少一截"的成因。
 *
 * 正在跑的轮次不打断:那会丢掉用户已经等了半天的回答。调用方拿到 false 时应当
 * 告诉用户"当前有对话正在进行,稍后再接管"。
 *
 * @param {string} sessionId provider-native session id(runtime map 的键)
 * @returns {Promise<{released: boolean, reason: string}>}
 */
async function releaseClaudeSession(sessionId) {
  if (!sessionId) return { released: true, reason: 'no_session' };

  const runtime = claudeRuntimes.get(sessionId);
  if (!runtime || runtime.disposed) return { released: true, reason: 'not_resident' };
  if (runtime.turn) return { released: false, reason: 'turn_in_flight' };

  try {
    await disposePersistentRuntime(runtime);
    return { released: true, reason: 'disposed' };
  } catch (error) {
    console.warn('[Claude SDK] Release failed:', error?.message || error);
    return { released: false, reason: 'error' };
  }
}

async function prewarmClaudeSession(options = {}) {
  if (!PERSISTENT_ENABLED) return { warmed: false, reason: 'persistent_disabled' };
  if (!options.sessionId) return { warmed: false, reason: 'no_session_id' };

  const existing = claudeRuntimes.get(options.sessionId);
  if (existing && !existing.disposed) return { warmed: true, reason: 'already_resident' };

  try {
    let effortModels = CLAUDE_FALLBACK_MODELS;
    try {
      effortModels = (await providerModelsService.getProviderModels('claude')).models;
    } catch {
      // static fallback
    }
    const model = (await providerModelsService.resolveResumeModel('claude', options.sessionId, options.model))
      || options.model;
    const resolvedEffort = resolveClaudeEffort(model, options.effort, effortModels);

    await runtimeForSend({ ...options, model, resolvedEffort });
    return { warmed: true, reason: 'created' };
  } catch (error) {
    console.warn('[Claude SDK] Pre-warm skipped:', error?.message || error);
    return { warmed: false, reason: 'error' };
  }
}

export {
  queryClaudeSDK,
  prewarmClaudeSession,
  releaseClaudeSession,
  queryClaudeSDKOnce,
  abortClaudeSDKSession,
  abortClaudeSDKRun,
  isClaudeSDKSessionActive,
  getActiveClaudeSDKSessions,
  getToolApprovalSessionId,
  resolveToolApproval,
  getPendingApprovalsForSession,
  getClaudeContextUsage,
  getClaudeSlashCommands,
  getPersistentRuntime
};
