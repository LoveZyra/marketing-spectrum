import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import { getDataDir } from '@/utils/runtime-paths.js';

/**
 * 模型别名 → 真实模型的实测。
 *
 * /models 弹窗里的卡片写着 "Sonnet 4.6 · $3/$15 per Mtok" —— 那是 Anthropic 的
 * 官方口径。但部署把 ANTHROPIC_BASE_URL 指向自己的网关时,**选什么别名、实际由
 * 哪个模型来答,是网关说了算**。本部署就是活例子:界面上选 "sonnet",实际服务的
 * 是 deepseek-v4-flash。卡片文案在这种环境下不只是没用,是误导。
 *
 * 而"别名映射到什么"没有任何查询接口 —— 网关在**请求时**才做解析。所以唯一诚实
 * 的办法是实测:对每个别名发一次最小请求,读响应里的真实模型名。这个文件做三件事:
 *
 *  1. 逐别名探测(空 system prompt、只读 user 级 settings 拿鉴权;拿到第一条带
 *     model 的响应就立刻停,不等这一轮跑完 —— 每次探测的开销在几百 token 量级);
 *  2. 结果落盘缓存(dataDir/claude-model-mappings.json),带时间戳 ——
 *     映射是网关的配置,不会一天变八次,没必要每次打开弹窗都实测;
 *  3. 收拾残局:CLI 跑一次就会在 ~/.claude/projects 下留一份 transcript,
 *     probe 的 cwd 里带上 PROBE_DIR_MARKER,sessions-watcher 按这个标记忽略,
 *     探测完再把那些 transcript 目录整个删掉。这正是 getSupportedModels()
 *     被禁用的原因(见 claude-models.provider.ts 里的注释) —— 那个问题在这里
 *     用"标记 + 忽略 + 事后删除"解决,而不是靠不产生 transcript(CLI 做不到)。
 */

/**
 * probe cwd 的标记。sessions-watcher 的 shouldIgnoreWatchPath 按它忽略,
 * cleanup 按它定位要删的 transcript 目录。够独特:正常项目不会叫这个名字。
 */
export const PROBE_DIR_MARKER = 'prism-model-probe';

const PROBE_TIMEOUT_MS = 60_000;

export type ModelMapping = {
  /** 网关实际用来回答的模型,来自响应流里 assistant 消息的 `model` 字段。 */
  actualModel: string | null;
  /** 探测失败时的原因(超时、CLI 报错)。actualModel 与 error 互斥。 */
  error: string | null;
  /** ISO 时间戳。映射是网关配置,标注"多久之前测的"比反复实测更有用。 */
  checkedAt: string;
};

export type ModelMappingsFile = {
  version: 1;
  mappings: Record<string, ModelMapping>;
  /**
   * 实测落盘那一刻 ~/.claude/settings.json 的 mtime。模型映射就配置在那个文件里,
   * settings 一改,已缓存的"实际模型"就可能过期 —— 读取侧据此判 stale,前端提示
   * 重测、chip 停显过期真名。旧版缓存没有这个字段:视为未知、不判过期,下次实测补上。
   */
  settingsMtimeMs?: number;
};

const cachePath = (): string => path.join(getDataDir(), 'claude-model-mappings.json');

const userSettingsPath = (): string => path.join(os.homedir(), '.claude', 'settings.json');

async function readUserSettingsMtimeMs(): Promise<number> {
  try {
    return (await fs.stat(userSettingsPath())).mtimeMs;
  } catch {
    return 0;
  }
}

/** 纯判定,单测钉规则:无指纹不判过期;指纹与当前 mtime 不一致即过期。 */
export function computeMappingsStale(
  stampedMtimeMs: number | undefined,
  currentMtimeMs: number,
): boolean {
  if (typeof stampedMtimeMs !== 'number') return false;
  return stampedMtimeMs !== currentMtimeMs;
}

export async function readModelMappings(): Promise<Record<string, ModelMapping>> {
  try {
    const raw = await fs.readFile(cachePath(), 'utf8');
    const parsed = JSON.parse(raw) as ModelMappingsFile;
    if (parsed && parsed.version === 1 && parsed.mappings && typeof parsed.mappings === 'object') {
      return parsed.mappings;
    }
  } catch {
    // 没有缓存或缓存坏了都当作"还没测过"。探测会重写它。
  }
  return {};
}

async function writeModelMappings(mappings: Record<string, ModelMapping>): Promise<void> {
  const payload: ModelMappingsFile = {
    version: 1,
    mappings,
    settingsMtimeMs: await readUserSettingsMtimeMs(),
  };
  await fs.mkdir(getDataDir(), { recursive: true });
  await fs.writeFile(cachePath(), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

/**
 * 读实测缓存 + 过期判定。/models 弹窗与 chip 都应经这里拿数据:
 * settings.json 改过之后,旧实测的"实际模型"可能已不成立。
 */
export async function readModelMappingsMeta(): Promise<{
  mappings: Record<string, ModelMapping>;
  stale: boolean;
}> {
  try {
    const raw = await fs.readFile(cachePath(), 'utf8');
    const parsed = JSON.parse(raw) as ModelMappingsFile;
    if (parsed && parsed.version === 1 && parsed.mappings && typeof parsed.mappings === 'object') {
      return {
        mappings: parsed.mappings,
        stale: computeMappingsStale(parsed.settingsMtimeMs, await readUserSettingsMtimeMs()),
      };
    }
  } catch {
    // 与 readModelMappings 同口径:没有缓存或缓存坏了当"还没测过"。
  }
  return { mappings: {}, stale: false };
}

/**
 * 从一条 SDK 流消息里读真实模型名。
 *
 * assistant 消息带 `message.model`(就是 API 响应里的 model 字段,网关解析后的
 * 真名)。result 消息的 `modelUsage` 键作为兜底 —— 两者在正常流里都会出现,
 * 谁先来用谁。
 */
export function extractActualModel(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const record = message as {
    type?: unknown;
    message?: { model?: unknown };
    modelUsage?: Record<string, unknown>;
  };

  if (record.type === 'assistant' && typeof record.message?.model === 'string' && record.message.model) {
    return record.message.model;
  }
  if (record.type === 'result' && record.modelUsage && typeof record.modelUsage === 'object') {
    const keys = Object.keys(record.modelUsage);
    if (keys.length > 0) return keys[0];
  }
  return null;
}

/** 对单个别名做一次最小探测。 */
async function probeOneAlias(alias: string, probeCwd: string): Promise<ModelMapping> {
  const checkedAt = new Date().toISOString();
  const abort = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, PROBE_TIMEOUT_MS);

  let actual: string | null = null;
  let streamError: unknown = null;
  try {
    const options: Record<string, unknown> = {
      // 空 system prompt:默认的 claude_code preset 有上万 token,探测只要一个
      // 模型名,不该按完整会话的价格付费。
      systemPrompt: '',
      // maxTurns 只是兜底 —— 下面一拿到模型名就 break,根本不等这一轮跑完。
      maxTurns: 1,
      cwd: probeCwd,
      // 必须读 user 级 settings —— 否则探测报 "Not logged in · Please run /login"。
      // 原因:自定义网关部署把鉴权(ANTHROPIC_BASE_URL / AUTH_TOKEN,或 apiKeyHelper)
      // 放在 ~/.claude/settings.json 里,这份配置只有通过 settingSources 的 'user' 源
      // 才会加载。真实会话用的是 ['project','user','local'](见 claude-sdk.js),所以能答;
      // 之前这里写 [] 把鉴权也一并屏蔽了,于是"对话可用、实测全失败"。
      //
      // 只取 'user' 不取 'project'/'local':探测 cwd 是隔离目录(getDataDir()/probe),
      // 本就没有项目级 settings 可读,单 'user' 既拿到鉴权,又不受任何具体项目配置影响。
      settingSources: ['user'],
      env: { ...process.env },
      pathToClaudeCodeExecutable: resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH),
      abortController: abort,
    };
    // 与真实对话同口径(见 claude-sdk.js 的 toSdkModel):'default' 档**省略 model**,
    // 让 CLI 按 settings 配置链("model" → ANTHROPIC_MODEL → 内置默认)自选。
    // 实测过 `--model default`:CLI 会把 'default' 原样透传给网关、落进网关对陌生
    // 名字的兜底路由,和会话真实走的路无关 —— 所以两边都必须省略,才测得准。
    // 其余别名照发,和会话一致。
    if (alias !== 'default') options.model = alias;

    const stream = query({ prompt: '1', options: options as never });

    for await (const message of stream) {
      const found = extractActualModel(message);
      // 关键:第一条带 model 的消息(通常是模型刚开口的那条 assistant 消息)一到手
      // 就停 —— 不等这一轮把可能的工具调用/第二轮跑完。像 'default' 这类模型第一轮就
      // 发起工具调用时,SDK 会抛 "Reached maximum number of turns (1)";但真实模型名
      // 那时早已在 assistant 消息里给出了。提前 break 就拿到了,不会被这个错误盖掉 ——
      // 这正是"底层模型明明可用、实测却失败"的成因。
      if (found) {
        actual = found;
        break;
      }
    }
  } catch (error) {
    // 只有在"读到模型名之前"就抛错(鉴权失败、网关拒绝、超时…)才算失败。
    streamError = error;
  } finally {
    clearTimeout(timer);
    // 提前 break 后确保底层 CLI 子进程被拆掉,避免泄漏。abort 幂等,重复调用无害。
    abort.abort();
  }

  return resolveProbeOutcome({
    actualModel: actual,
    timedOut,
    streamError,
    checkedAt,
    timeoutMs: PROBE_TIMEOUT_MS,
  });
}

/**
 * 把探测三态归一成最终结果。单独抽出来是为了能单测那条最关键的规则:
 * **只要在出错前已经读到模型名,就算成功** —— 这正是 'default' 别名"底层模型可用、
 * 实测却报 Reached maximum number of turns 失败"的修复点(拿到模型名后这一轮才
 * 因工具调用/maxTurns 抛错,不该把已读到的模型名盖成失败)。
 */
export function resolveProbeOutcome(params: {
  actualModel: string | null;
  timedOut: boolean;
  streamError: unknown;
  checkedAt: string;
  timeoutMs: number;
}): ModelMapping {
  const { actualModel, timedOut, streamError, checkedAt, timeoutMs } = params;
  if (actualModel) {
    return { actualModel, error: null, checkedAt };
  }
  if (timedOut) {
    return { actualModel: null, error: `超时(${timeoutMs / 1000}s)`, checkedAt };
  }
  if (streamError) {
    const message = streamError instanceof Error ? streamError.message : String(streamError);
    return { actualModel: null, error: message, checkedAt };
  }
  return { actualModel: null, error: '响应里没有模型名(网关未按 Anthropic 响应格式返回?)', checkedAt };
}

/**
 * 删掉探测留下的 transcript 目录。
 *
 * CLI 每跑一次都在 ~/.claude/projects/<cwd 编码>/ 下写一份 jsonl。留着它们,
 * 迟早有工具(会话列表、搜索、备份)把这些"1"对话当真会话展示出来。按
 * PROBE_DIR_MARKER 定位 —— 和 watcher 的忽略规则用同一个标记,两边不会漂移。
 */
async function cleanupProbeTranscripts(): Promise<void> {
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
  let entries: string[] = [];
  try {
    entries = await fs.readdir(projectsRoot);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((name) => name.includes(PROBE_DIR_MARKER))
      .map((name) => fs.rm(path.join(projectsRoot, name), { recursive: true, force: true }).catch(() => {})),
  );
}

/** 进行中的探测。并发的第二个请求加入同一次,而不是再起一轮 CLI 进程。 */
let inFlight: Promise<Record<string, ModelMapping>> | null = null;

export function isProbeRunning(): boolean {
  return inFlight !== null;
}

/**
 * 探测一组别名,返回并落盘全量映射(旧结果保留,被探测的别名覆盖)。
 *
 * 串行而不是并行:每个探测都是一个完整的 CLI 子进程,7 个并行等于瞬间拉起
 * 7 个 node,而这台服务器同时还跑着真正的会话。串行慢十几秒,没人在乎 ——
 * 这是个点一下按钮的显式操作,不在任何热路径上。
 */
export async function probeModelMappings(aliases: string[]): Promise<Record<string, ModelMapping>> {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const probeCwd = path.join(getDataDir(), PROBE_DIR_MARKER);
    await fs.mkdir(probeCwd, { recursive: true });

    const mappings = await readModelMappings();
    for (const alias of aliases) {
      mappings[alias] = await probeOneAlias(alias, probeCwd);
    }

    await writeModelMappings(mappings);
    await cleanupProbeTranscripts();
    return mappings;
  })().finally(() => {
    inFlight = null;
  });

  return inFlight;
}
