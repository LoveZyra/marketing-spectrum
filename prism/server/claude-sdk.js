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

const TOOL_APPROVAL_TIMEOUT_MS = parseInt(process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS, 10) || 55000;

const TOOLS_REQUIRING_INTERACTION = new Set(['AskUserQuestion', 'ExitPlanMode']);

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

function mapCliOptionsToSDK(options = {}) {
  const { sessionId, cwd, toolsSettings, permissionMode, effort } = options;

  const sdkOptions = {};

  // Forward all host env vars (e.g. ANTHROPIC_BASE_URL) to the subprocess.
  // Since SDK 0.2.113, options.env replaces process.env instead of overlaying it.
  sdkOptions.env = { ...process.env };

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
    });

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
      ws.send(createNormalizedMessage({ kind: 'permission_request', requestId, toolName, input, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
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
        timeoutMs: requiresInteraction ? 0 : undefined,
        signal: context?.signal,
        metadata: {
          _sessionId: capturedSessionId || sessionId || null,
          _toolName: toolName,
          _input: input,
          _receivedAt: new Date(),
        },
        onCancel: (reason) => {
          ws.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
        }
      });
      if (!decision) {
        return { behavior: 'deny', message: 'Permission request timed out' };
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
    console.error('SDK query error:', error);

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
      : error.message;

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
 * Get pending tool approvals for a specific session.
 * @param {string} sessionId - The session ID
 * @returns {Array} Array of pending permission request objects
 */
function getPendingApprovalsForSession(sessionId) {
  const pending = [];
  for (const [requestId, resolver] of pendingToolApprovals.entries()) {
    if (resolver._sessionId === sessionId) {
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

/**
 * Reconnect a session's WebSocketWriter to a new raw WebSocket.
 * Called when client reconnects (e.g. page refresh) while SDK is still running.
 * @param {string} sessionId - The session ID
 * @param {Object} newRawWs - The new raw WebSocket connection
 * @returns {boolean} True if writer was successfully reconnected
 */
function reconnectSessionWriter(sessionId, newRawWs) {
  const session = getSession(sessionId);
  if (!session?.writer?.updateWebSocket) return false;
  session.writer.updateWebSocket(newRawWs);
  console.log(`[RECONNECT] Writer swapped for session ${sessionId}`);
  return true;
}

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
const MAX_RUNTIMES = parseInt(process.env.PRISM_MAX_RUNTIMES, 10) || 8;
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
    turn.ws.send(createNormalizedMessage({ kind: 'permission_request', requestId, toolName, input, sessionId: sid, provider: 'claude' }));
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
        _toolName: toolName,
        _input: input,
        _receivedAt: new Date(),
      },
      onCancel: (reason) => {
        turn.ws.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: sid, provider: 'claude' }));
      }
    });

    if (!decision) return { behavior: 'deny', message: 'Permission request timed out' };
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
      console.error(`[Claude SDK] Persistent runtime ${runtime.key} failed:`, error?.message || error);
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
      const message = error?.message || String(error);
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
        ws.send(createNormalizedMessage({ kind: 'error', content: message, sessionId: options.sessionId || null, provider: 'claude' }));
        ws.send(createCompleteMessage({ provider: 'claude', sessionId: options.sessionId || null, exitCode: 1 }));
      } else if (error?.prismStreamed || error?.prismTurnTimeout) {
        // Partial output already reached the client (or the watchdog killed
        // the turn after a long run) — do NOT replay the turn.
        console.error('[Claude SDK] Persistent turn failed mid-stream:', message);
        ws.send(createNormalizedMessage({ kind: 'error', content: message, sessionId: options.sessionId || null, provider: 'claude' }));
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
  queryClaudeSDKOnce,
  abortClaudeSDKSession,
  abortClaudeSDKRun,
  isClaudeSDKSessionActive,
  getActiveClaudeSDKSessions,
  resolveToolApproval,
  getPendingApprovalsForSession,
  reconnectSessionWriter,
  getClaudeContextUsage,
  getClaudeSlashCommands,
  getPersistentRuntime
};
