/**
 * 模型映射管理(root):读/写 ~/.claude/settings.json 里的别名映射。
 *
 * 这一页消灭的是"改映射还得 SSH 上服务器"的最后一步:写回后 mtime 变化,
 * 已有的热感知(claude-sdk 的 runtimeForSend + 实测缓存 stale 标)自动让
 * 下一条消息用新映射,不需要重启任何东西。
 *
 * 安全红线:settings.json 里有网关 AUTH TOKEN。
 *   - 读接口白名单字段,token 只回"有没有"(hasAuthToken),永不回值;
 *   - 写路径只碰 "model" 顶层键和 env 里的四个 ANTHROPIC_DEFAULT_*_MODEL,
 *     其余字段(含 token、BASE_URL)原样保留;
 *   - 原子写:先写临时文件(0600)再 rename,写一半断电不会毁掉原文件。
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ALIAS_ENV_KEYS } from './claude-settings-mapping.service.js';

export const MANAGED_ALIASES = ['sonnet', 'opus', 'haiku', 'fable'] as const;
export type ManagedAlias = (typeof MANAGED_ALIASES)[number];

const settingsPath = (): string => path.join(os.homedir(), '.claude', 'settings.json');

export type ModelConfigView = {
  settingsPath: string;
  /** 文件不存在时 false(保存会创建)。 */
  exists: boolean;
  mtimeMs: number | null;
  /** settings 顶层 "model"(default 档走的键);null = 未设置。 */
  defaultModel: string | null;
  /** 各别名在 env 里的映射值;null = 未配置(CLI 用内置 ID,由网关决定)。 */
  mappings: Record<ManagedAlias, string | null>;
  /** env.ANTHROPIC_BASE_URL,只读展示。 */
  baseUrl: string | null;
  /** env 里是否存在 AUTH TOKEN(只报有无,永不回值)。 */
  hasAuthToken: boolean;
};

export type ModelConfigUpdate = {
  /** undefined = 不动;null/'' = 删除 "model" 键;其余 = 设置。 */
  defaultModel?: string | null;
  /** 每别名:undefined = 不动;null/'' = 删除对应 env 键;其余 = 设置。 */
  mappings?: Partial<Record<ManagedAlias, string | null>>;
};

type RawSettings = Record<string, unknown> & { env?: Record<string, unknown> };

const readString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

/** 结构视图(纯函数,单测钉字段白名单与 token 不外流)。 */
export function buildModelConfigView(
  settings: RawSettings,
  meta: { exists: boolean; mtimeMs: number | null },
): ModelConfigView {
  const env = settings.env && typeof settings.env === 'object' ? settings.env : {};
  const mappings = {} as Record<ManagedAlias, string | null>;
  for (const alias of MANAGED_ALIASES) {
    mappings[alias] = readString((env as Record<string, unknown>)[ALIAS_ENV_KEYS[alias]]);
  }
  return {
    settingsPath: settingsPath(),
    exists: meta.exists,
    mtimeMs: meta.mtimeMs,
    defaultModel: readString(settings.model),
    mappings,
    baseUrl: readString((env as Record<string, unknown>).ANTHROPIC_BASE_URL),
    hasAuthToken: readString((env as Record<string, unknown>).ANTHROPIC_AUTH_TOKEN) !== null,
  };
}

/**
 * 把更新合并进 settings(纯函数)。只碰 "model" 与四个映射 env 键,
 * 其余字段逐位保留 —— 这是"绝不弄丢 token"的机制本身,单测直接盯它。
 */
export function applyModelConfigUpdate(settings: RawSettings, update: ModelConfigUpdate): RawSettings {
  const next: RawSettings = { ...settings, env: { ...(settings.env ?? {}) } };

  if (update.defaultModel !== undefined) {
    const value = readString(update.defaultModel);
    if (value) next.model = value;
    else delete next.model;
  }

  if (update.mappings) {
    for (const alias of MANAGED_ALIASES) {
      if (!(alias in update.mappings)) continue;
      const envKey = ALIAS_ENV_KEYS[alias];
      const value = readString(update.mappings[alias] ?? null);
      if (value) (next.env as Record<string, unknown>)[envKey] = value;
      else delete (next.env as Record<string, unknown>)[envKey];
    }
  }

  // env 被清空时不留空对象包袱?留着 —— 保持文件形态稳定,diff 最小。
  return next;
}

async function readRawSettings(): Promise<{ settings: RawSettings; exists: boolean; mtimeMs: number | null }> {
  try {
    const [raw, stat] = await Promise.all([
      fs.readFile(settingsPath(), 'utf8'),
      fs.stat(settingsPath()),
    ]);
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('settings.json 不是 JSON 对象');
    }
    return { settings: parsed as RawSettings, exists: true, mtimeMs: stat.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { settings: {}, exists: false, mtimeMs: null };
    }
    throw error;
  }
}

/** 当前配置视图。 */
export async function readModelConfigView(): Promise<ModelConfigView> {
  const { settings, exists, mtimeMs } = await readRawSettings();
  return buildModelConfigView(settings, { exists, mtimeMs });
}

/** 合并 + 原子写回,返回写后的最新视图。 */
export async function writeModelConfig(update: ModelConfigUpdate): Promise<ModelConfigView> {
  const { settings } = await readRawSettings();
  const next = applyModelConfigUpdate(settings, update);
  const target = settingsPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  // 文件里有 token,临时文件也必须一出生就 0600。
  await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, target);
  return readModelConfigView();
}
