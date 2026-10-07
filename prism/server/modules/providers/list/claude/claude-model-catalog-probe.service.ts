import { promises as fs } from 'node:fs';
import path from 'node:path';

import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { sdkExecutableOption } from '@/shared/claude-cli-path.js';
import { buildClaudeSdkEnv } from '@/shared/claude-runtime-env.js';
import { getDataDir } from '@/utils/runtime-paths.js';

import type { CatalogProbeResult } from './claude-model-catalog.service.js';
import type { TurnGateway } from './claude-gateways.service.js';
import { PROBE_DIR_MARKER, cleanupProbeTranscripts, extractActualModel } from './claude-model-probe.service.js';
import { readClaudeSettingsParseProblem } from './claude-settings-selfcheck.js';
import { removeFlagSettingsFile, writeFlagSettingsFile } from './claude-flag-settings-file.js';

/**
 * 模型目录里单条模型的「实测」:一次一致性检查,不只是"网关认不认这个名字"。
 *
 * 一次 SDK 调用(maxTurns 3),带一个进程内 MCP 工具 `probe_echo`,提示模型"调用它再回 DONE"。
 * 一次就能看出这个模型经网关后能不能在 Claude Code 里正常干活:
 *
 * | 项 | 判据 |
 * |---|---|
 * | 名字被接受 | 没有 error result、拿到了 assistant 回复 |
 * | 工具往返 | `probe_echo` 真的被调用、且之后还有最终回复 |
 * | 档位 / thinking 字段 | CLI 对非 Claude 名总会带 `thinking: adaptive` + `output_config.effort`,请求成功即说明网关容忍 |
 * | usage 可信 | `input_tokens > 0`(网关不回 usage,CLI 就永远不自动压缩) |
 * | 回复模型名 | 与请求一致;不一致时说明网关在改写 |
 *
 * 不复用整组别名探测(`probeModelMappings`):那个是单飞的,并发时会把整组的结果当成这一条的结果。
 * 这里按条目各自单飞。cwd 与 transcript 清理沿用它的标记(sessions-watcher 按标记忽略)。
 */

const PROBE_TIMEOUT_MS = 60_000;
const inFlight = new Map<string, Promise<CatalogProbeResult>>();

/**
 * `gateway` = 这次实测走哪个网关、用哪把 key(claude-gateways.service 的 resolveTurnGateway 解析好的)。
 * 单飞按"模型 + 网关指纹"分:root 与私有模型的主人测同名模型时各测各的,不会串结果。
 */
export async function probeCatalogModel(
  modelId: string,
  contextWindow: number | null,
  gateway: Pick<TurnGateway, 'settingsPatch' | 'fingerprint'> | null = null,
): Promise<CatalogProbeResult> {
  const key = `${modelId}\u0000${gateway?.fingerprint ?? ''}`;
  const running = inFlight.get(key);
  if (running) return running;
  const promise = runProbe(modelId, contextWindow, gateway).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

async function runProbe(
  modelId: string,
  contextWindow: number | null,
  gateway: Pick<TurnGateway, 'settingsPatch' | 'fingerprint'> | null,
): Promise<CatalogProbeResult> {
  const startedAt = Date.now();
  const probeCwd = path.join(getDataDir(), PROBE_DIR_MARKER, 'catalog');
  await fs.mkdir(probeCwd, { recursive: true });

  // 工具回调里写 —— 用对象装,TS 的流分析不追踪回调里的赋值。
  const tool_ = { echoed: null as string | null };
  let respondedModel: string | null = null;
  let finalText: string | null = null;
  let inputTokens: number | null = null;
  let resultError: string | null = null;
  let streamError: unknown = null;
  let timedOut = false;

  const probeServer = createSdkMcpServer({
    name: 'prism_probe',
    version: '1.0.0',
    tools: [
      tool('probe_echo', 'Echo the given text back. Used by Prism to check that tool calls work.', { text: z.string() }, async ({ text }) => {
        tool_.echoed = text;
        return { content: [{ type: 'text', text: `echo:${text}` }] };
      }),
    ],
  });

  const abort = new AbortController();
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, PROBE_TIMEOUT_MS);
  // 带 key 的设置写进 0600 文件、只传路径,不进命令行(见 claude-flag-settings-file.ts)
  let flagSettingsFile: string | null = null;

  try {
    if (gateway?.settingsPatch) flagSettingsFile = writeFlagSettingsFile({ ...gateway.settingsPatch });
    // 进程内 MCP 工具要求 streaming input,所以 prompt 给成一个只吐一条的异步迭代器。
    const prompt = (async function* () {
      yield {
        type: 'user' as const,
        parent_tool_use_id: null,
        message: {
          role: 'user' as const,
          content: 'Call the probe_echo tool with text "ok". After you get its result, reply with exactly: DONE',
        },
      };
    })();
    const stream = query({
      prompt,
      options: {
        systemPrompt: 'You are a connectivity probe. Follow the instruction exactly and keep replies minimal.',
        model: modelId,
        maxTurns: 3,
        cwd: probeCwd,
        // 只读 user 级 settings —— 网关鉴权在那里(见 claude-model-probe.service 的说明)。
        settingSources: ['user'],
        // 与真实会话同一份 env 与窗口(见 claude-sdk.js 的 modelWindowEnv)。
        env: buildClaudeSdkEnv(process.env, {
          CLAUDE_CODE_MAX_CONTEXT_TOKENS: contextWindow ? String(contextWindow) : undefined,
        }),
        pathToClaudeCodeExecutable: sdkExecutableOption(),
        // 不给内置工具,只给这一个探针工具,并预先放行。
        tools: [],
        mcpServers: { prism_probe: probeServer },
        allowedTools: ['mcp__prism_probe__probe_echo'],
        abortController: abort,
        // 网关与 key 走 flag 层(压得过 settings.json 的 env;怎么防串见 buildGatewaySettingsPatch)
        ...(flagSettingsFile ? { settings: flagSettingsFile } : {}),
      },
    });

    for await (const message of stream) {
      const found = extractActualModel(message);
      if (found && !respondedModel) respondedModel = found;
      const record = message as {
        type?: string;
        subtype?: string;
        is_error?: boolean;
        result?: unknown;
        errors?: unknown;
        usage?: { input_tokens?: unknown; cache_read_input_tokens?: unknown; cache_creation_input_tokens?: unknown };
      };
      if (record.type === 'result') {
        const usage = record.usage ?? {};
        const total = [usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens]
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value))
          .reduce((sum, value) => sum + value, 0);
        inputTokens = total;
        if (record.is_error || (record.subtype && record.subtype !== 'success')) {
          resultError = typeof record.result === 'string' && record.result.trim()
            ? record.result.trim()
            : Array.isArray(record.errors) && record.errors.length > 0
              ? record.errors.map(String).join('; ')
              : String(record.subtype ?? 'error');
        } else if (typeof record.result === 'string') {
          finalText = record.result;
        }
        break;
      }
    }
  } catch (error) {
    streamError = error;
  } finally {
    clearTimeout(timer);
    abort.abort();
    removeFlagSettingsFile(flagSettingsFile);
    await cleanupProbeTranscripts().catch(() => {});
  }

  const accepted = Boolean(respondedModel) && !resultError;
  const toolRoundTrip = tool_.echoed === 'ok' && typeof finalText === 'string' && finalText.trim().length > 0;
  const error = timedOut
    ? `超时(${PROBE_TIMEOUT_MS / 1000}s)`
    : resultError ?? (streamError ? (streamError instanceof Error ? streamError.message : String(streamError)) : null)
      ?? (!respondedModel ? '响应里没有模型名(网关未按 Anthropic 响应格式返回?)' : null)
      ?? (!toolRoundTrip ? '模型没有按要求调用工具(工具往返没走通)' : null)
      ?? (!inputTokens ? '网关没有回 usage(input_tokens 为 0)—— CLI 将无法按用量自动压缩' : null);

  /*
   * 「Not logged in · Please run /login」= CLI 根本没拿到网关配置。最常见的原因是 ~/.claude/settings.json 不是合法 JSON
   * (抄了带 // 注释的片段,CLI 整份忽略),其次是 env 里没有网关地址 / 令牌 —— 把原因直接写进实测结果。
   */
  let explained = error;
  if (error && /not logged in|please run \/login/i.test(error)) {
    const parseProblem = await readClaudeSettingsParseProblem().catch(() => null);
    explained = parseProblem
      ?? `${error}(CLI 没拿到网关配置:检查 ~/.claude/settings.json 的 env 里有没有 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN)`;
  }

  return {
    at: new Date().toISOString(),
    ok: accepted && toolRoundTrip && Boolean(inputTokens),
    accepted,
    toolRoundTrip,
    inputTokens,
    respondedModel,
    latencyMs: Date.now() - startedAt,
    error: explained ? explained.slice(0, 500) : null,
  };
}
