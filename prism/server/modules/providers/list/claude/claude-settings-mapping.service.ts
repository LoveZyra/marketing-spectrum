import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 别名 → **配置层**的模型解析(不发任何请求的那一层)。
 *
 * 这套部署的映射方式是 CLI 环境变量:settings.json 的 env 块里
 * `ANTHROPIC_DEFAULT_<别名>_MODEL` 决定各别名实际发出去的名字;顶层 `"model"`
 * 决定 default 档(它可以又是一个别名,递归解析一层);`ANTHROPIC_MODEL` 是
 * 没配 `"model"` 时的兜底。这一层**读文件就能算出来** —— 零成本、随改随新,
 * /models 卡片的「配置」行、输入框 chip 的回退显示都用它,不需要实测。
 *
 * 实测(probe)依然保留,因为它验证的是配置层看不见的**网关**那一跳:CLI 发出的
 * 名字网关认不认、会不会改写(比如把陌生名字兜底到别的模型),只有真发一次请求
 * 才知道。两层一致 → 放心;不一致 → 网关在改写,这本身就是重要信号。
 */

export type AliasConfigMapping = {
  /** 配置层解析出的模型名;null = 本地没配(将用 CLI 内置 ID,最终由网关决定)。 */
  configuredModel: string | null;
  /** 解析来源,给 UI 的 tooltip 用,如 "env.ANTHROPIC_DEFAULT_SONNET_MODEL"。 */
  source: string | null;
};

/** CLI 各别名对应的默认模型覆盖变量。[1m] 变体与基础别名共用同一个。
 *  导出给模型映射管理页(claude-model-config.service)复用同一张表。 */
export const ALIAS_ENV_KEYS: Record<string, string> = {
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
};

const baseAlias = (alias: string): string => alias.replace(/\[1m\]$/, '').trim();

export type ClaudeUserSettings = {
  model?: unknown;
  env?: Record<string, unknown>;
};

const readUserSettingsFile = async (): Promise<ClaudeUserSettings> => {
  try {
    const raw = await fs.readFile(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8');
    const parsed = JSON.parse(raw) as ClaudeUserSettings;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // 没有 settings.json:所有别名都没有本地覆盖,交给 CLI 内置 + 网关。
    return {};
  }
};

/**
 * settings.env 优先,进程 env 兜底 —— CLI 子进程实际生效的就是这两处的并集,
 * settings 的 env 块在 CLI 启动时注入。
 */
const readEnvValue = (settings: ClaudeUserSettings, key: string): string | null => {
  const fromSettings =
    settings.env && typeof settings.env[key] === 'string' ? (settings.env[key] as string).trim() : '';
  if (fromSettings) return fromSettings;
  const fromProcess = typeof process.env[key] === 'string' ? process.env[key]!.trim() : '';
  return fromProcess || null;
};

/** 纯解析,单测钉规则。 */
export function resolveAliasMapping(settings: ClaudeUserSettings, alias: string): AliasConfigMapping {
  const base = baseAlias(alias);

  const envKey = ALIAS_ENV_KEYS[base];
  if (envKey) {
    const value = readEnvValue(settings, envKey);
    return value
      ? { configuredModel: value, source: `env.${envKey}` }
      : { configuredModel: null, source: null };
  }

  if (base === 'default') {
    // default 档 = Prism 不传 model,CLI 走自己的配置链(与 claude-sdk.js 的
    // toSdkModel 语义一致):settings "model" → (若是别名再经它的 env 覆盖) →
    // ANTHROPIC_MODEL → CLI 内置。
    const configured = typeof settings.model === 'string' ? settings.model.trim() : '';
    if (configured) {
      const nestedKey = ALIAS_ENV_KEYS[baseAlias(configured)];
      if (nestedKey) {
        const value = readEnvValue(settings, nestedKey);
        if (value) {
          return { configuredModel: value, source: `"model": ${configured} → env.${nestedKey}` };
        }
        return { configuredModel: configured, source: `"model"(别名 ${configured},无 env 覆盖)` };
      }
      return { configuredModel: configured, source: '"model"' };
    }

    const envModel = readEnvValue(settings, 'ANTHROPIC_MODEL');
    if (envModel) return { configuredModel: envModel, source: 'env.ANTHROPIC_MODEL' };
    return { configuredModel: null, source: null };
  }

  // 不认识的别名:CLI 会原样发出去,配置层没有映射可言。
  return { configuredModel: null, source: null };
}

/** 每次调用都重读 settings.json —— 这正是"改完配置立即反映"的实现方式。 */
export async function readAliasConfigMappings(
  aliases: string[],
): Promise<Record<string, AliasConfigMapping>> {
  const settings = await readUserSettingsFile();
  const result: Record<string, AliasConfigMapping> = {};
  for (const alias of aliases) {
    result[alias] = resolveAliasMapping(settings, alias);
  }
  return result;
}
