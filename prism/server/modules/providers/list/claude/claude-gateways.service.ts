import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  gatewayUserKeysDb,
  modelCatalogDb,
  modelGatewaysDb,
  userDb,
  userModelsDb,
  type ModelGatewayRow,
  type ModelGatewayWrite,
} from '@/modules/database/index.js';
import type { ProviderModelsDefinition } from '@/shared/types.js';
import { createLogger } from '@/shared/logger.js';

import {
  claudeModelCatalog,
  invalidateCatalogCache,
  isModelAlias,
  privateGatewaysEnabled,
  userModelToEntry,
  validateUserModelInput,
  CatalogValidationError,
  type CatalogEntry,
  type CatalogInput,
  type ModelViewer,
} from './claude-model-catalog.service.js';

const log = createLogger('providers');

/**
 * 模型网关与 key:哪个模型走哪个网关、这一轮用谁的 key。
 *
 * ## 网关
 * - 网关 0 = `~/.claude/settings.json`(或进程环境)里的 `ANTHROPIC_BASE_URL` + token,不进库;
 * - 共享网关(root 管):地址、鉴权方式、可选的默认 key;目录条目可以挂上去;
 * - 私有网关(每个人自己加,root 可整体关掉):只有本人看得到,只能挂本人的私有模型。
 *
 * ## 这一轮用谁的 key(`resolveTurnGateway`)
 * 「这一轮的人」= 发这条消息的人 / 定时任务的主人 / 调 API 的账号。按顺序:
 * 1. 本人在这个网关上的个人 key(本人填的,或 root 代填的);
 * 2. 网关的默认 key(共享网关;私有网关的 key 就是主人自己的);
 * 3. 网关 0:settings.json 里的 token(什么都不传,CLI 自己读)。
 * 都没有 → 这一轮直接拒(`GATEWAY_KEY_MISSING`),选择器里这个模型置灰。
 *
 * ## 怎么交给 CLI
 * SDK 的 `options.settings` 是 flag 层,压得过 settings.json 的 env(进程环境压不过),按键合并。
 * 所以 Prism 不改 settings.json,终端里的 claude 不受影响。但合并是逐键的,不清就会串:
 * - 转到别的网关只给 `ANTHROPIC_API_KEY` 时,settings.json 里的 `ANTHROPIC_AUTH_TOKEN` 会一起发过去(反之亦然);
 * - settings.json 的 `apiKeyHelper` 会把它的 key 也塞进请求(`apiKeyHelper: null` 会让整份 flag 设置失效,只能给空串);
 * - settings.json 的 `ANTHROPIC_CUSTOM_HEADERS` 同样会跟过去。
 * 所以补丁里另一种鉴权变量与 apiKeyHelper 一律清成空串,转到别的网关时自定义头也清空
 * (`buildGatewaySettingsPatch`,单测钉着)。
 */

export const DEFAULT_GATEWAY_ID = 0;
export type GatewayAuthType = 'bearer' | 'x-api-key';
export type KeySource = 'personal' | 'gateway_default' | 'settings' | 'none';

const AUTH_VAR: Record<GatewayAuthType, string> = {
  bearer: 'ANTHROPIC_AUTH_TOKEN',
  'x-api-key': 'ANTHROPIC_API_KEY',
};
const OTHER_AUTH_VAR: Record<GatewayAuthType, string> = {
  bearer: 'ANTHROPIC_API_KEY',
  'x-api-key': 'ANTHROPIC_AUTH_TOKEN',
};

/** 别名映射 —— 转到别的网关时全部指向这一轮的模型(CLI 的后台小请求用 haiku 别名,指到默认网关的模型名上只会 404)。 */
const ALIAS_MODEL_VARS = [
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
];

export class GatewayError extends Error {
  code: string;
  status: number;
  /** claude-sdk 的调度器据此直接报错、不退回一次性路径再试。 */
  prismModelRejected = true;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/* ------------------------------ 网关 0 ------------------------------ */

export type DefaultGatewayInfo = {
  baseUrl: string | null;
  host: string | null;
  authType: GatewayAuthType;
  /** settings.json / 进程环境里有 token、API key 或 apiKeyHelper。 */
  hasKey: boolean;
};

type DefaultGatewaySecrets = DefaultGatewayInfo & { key: string | null };

const settingsPath = (): string => path.join(os.homedir(), '.claude', 'settings.json');
const readStr = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

export const hostOf = (url: string | null): string | null => {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return url;
  }
};

/** settings.json 的 env 优先、进程环境兜底 —— 与 CLI 实际生效的来源一致。含明文 key,只在本文件里用。 */
async function readDefaultGatewaySecrets(): Promise<DefaultGatewaySecrets> {
  let env: Record<string, unknown> = {};
  let apiKeyHelper: string | null = null;
  try {
    const parsed = JSON.parse(await fs.readFile(settingsPath(), 'utf8')) as { env?: Record<string, unknown>; apiKeyHelper?: unknown };
    if (parsed.env && typeof parsed.env === 'object') env = parsed.env;
    apiKeyHelper = readStr(parsed.apiKeyHelper);
  } catch {
    // 没有 / 不是合法 JSON:CLI 同样读不到,按进程环境
  }
  const pick = (name: string): string | null => readStr(env[name]) ?? readStr(process.env[name]);
  const baseUrl = pick('ANTHROPIC_BASE_URL');
  const token = pick('ANTHROPIC_AUTH_TOKEN');
  const apiKey = pick('ANTHROPIC_API_KEY');
  const authType: GatewayAuthType = !token && apiKey ? 'x-api-key' : 'bearer';
  return {
    baseUrl,
    host: hostOf(baseUrl),
    authType,
    hasKey: Boolean(token || apiKey || apiKeyHelper),
    key: token ?? apiKey,
  };
}

export async function describeDefaultGateway(): Promise<DefaultGatewayInfo> {
  const { key: _key, ...info } = await readDefaultGatewaySecrets();
  return info;
}

/* ------------------------------ 校验 ------------------------------ */

const KEY_MAX = 4096;

/** key:去首尾空白;不能有空白 / 控制字符(多半是粘错了)。 */
export function normalizeKey(raw: unknown): string {
  if (typeof raw !== 'string') throw new GatewayError('BAD_KEY', 'key 必须是字符串');
  const key = raw.trim();
  if (!key) throw new GatewayError('BAD_KEY', 'key 不能为空');
  if (key.length > KEY_MAX) throw new GatewayError('BAD_KEY', `key 不能超过 ${KEY_MAX} 个字符`);
  if (/[\s\x00-\x1f\x7f]/.test(key)) throw new GatewayError('BAD_KEY', 'key 里有空格或换行 —— 多半是粘贴时带进来的,去掉再保存');
  return key;
}

/** 网关地址:http(s);不许带账号密码 / #;去掉末尾的 `/`(CLI 自己拼 /v1/messages)。 */
export function normalizeBaseUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new GatewayError('BAD_BASE_URL', '网关地址不能为空');
  const text = raw.trim();
  if (text.length > 500) throw new GatewayError('BAD_BASE_URL', '网关地址不能超过 500 个字符');
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new GatewayError('BAD_BASE_URL', '网关地址不是合法的 URL(要以 http:// 或 https:// 开头)');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new GatewayError('BAD_BASE_URL', '网关地址只能是 http:// 或 https://');
  }
  if (url.username || url.password) {
    throw new GatewayError('BAD_BASE_URL', '网关地址里不要带账号密码 —— key 单独填');
  }
  // `https://host/#` 的 hash 是空串,只看 url.hash 会放过去(CLI 再拼 /v1/messages 就打到网关根上)
  if (url.hash || text.includes('#')) throw new GatewayError('BAD_BASE_URL', '网关地址不能带 #');
  let normalized = url.toString();
  while (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  // 常见手误:把 /v1 也填进来 → CLI 会拼成 /v1/v1/messages
  if (/\/v1$/i.test(normalized)) normalized = normalized.slice(0, -3);
  return normalized;
}

export function validateGatewayInput(
  input: { name?: unknown; baseUrl?: unknown; authType?: unknown; enabled?: unknown },
  base: ModelGatewayRow | null,
): ModelGatewayWrite {
  const nameRaw = input.name !== undefined ? input.name : base?.name;
  const name = typeof nameRaw === 'string' ? nameRaw.trim() : '';
  if (!name) throw new GatewayError('BAD_NAME', '网关名不能为空');
  if (name.length > 60) throw new GatewayError('BAD_NAME', '网关名不能超过 60 个字符');
  const baseUrl = normalizeBaseUrl(input.baseUrl !== undefined ? input.baseUrl : base?.base_url);
  const authRaw = input.authType !== undefined ? input.authType : (base?.auth_type ?? 'bearer');
  if (authRaw !== 'bearer' && authRaw !== 'x-api-key') {
    throw new GatewayError('BAD_AUTH_TYPE', '鉴权方式只能是 bearer(Authorization: Bearer)或 x-api-key');
  }
  let enabled = base ? base.enabled === 1 : true;
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') throw new GatewayError('BAD_FIELD', 'enabled 必须是 true / false');
    enabled = input.enabled;
  }
  return { name, baseUrl, authType: authRaw, enabled };
}

/* ------------------------------ 视图 ------------------------------ */

export type GatewayScope = 'default' | 'shared' | 'private';

export type GatewayView = {
  id: number;
  scope: GatewayScope;
  name: string;
  /** root 与私有网关的主人看完整地址;其他人只看 host(路径里可能带租户 id)。 */
  baseUrl: string | null;
  host: string | null;
  authType: GatewayAuthType;
  hasDefaultKey: boolean;
  defaultKeyLast4: string | null;
  enabled: boolean;
  ownerUserId: number | null;
  ownerUsername: string | null;
  /** 挂在上面的模型数(共享 = 目录条目,私有 = 私有模型)。 */
  modelCount: number;
  updatedAt: string | null;
};

const asAuthType = (value: string): GatewayAuthType => (value === 'x-api-key' ? 'x-api-key' : 'bearer');

function rowToView(row: ModelGatewayRow, { fullUrl }: { fullUrl: boolean }): GatewayView {
  const scope: GatewayScope = row.owner_user_id === null ? 'shared' : 'private';
  return {
    id: row.id,
    scope,
    name: row.name,
    baseUrl: fullUrl ? row.base_url : null,
    host: hostOf(row.base_url),
    authType: asAuthType(row.auth_type),
    hasDefaultKey: row.has_default_key === 1,
    defaultKeyLast4: fullUrl ? row.default_key_last4 : null,
    enabled: row.enabled === 1,
    ownerUserId: row.owner_user_id,
    ownerUsername: row.owner_user_id !== null ? (userDb.getUserById(row.owner_user_id)?.username ?? null) : null,
    modelCount: scope === 'shared' ? modelCatalogDb.countByGateway(row.id) : userModelsDb.countByGateway(row.id),
    updatedAt: row.updated_at,
  };
}

export async function defaultGatewayView(viewer: ModelViewer): Promise<GatewayView> {
  const info = await describeDefaultGateway();
  return {
    id: DEFAULT_GATEWAY_ID,
    scope: 'default',
    name: '默认网关',
    baseUrl: viewer.isRoot ? info.baseUrl : null,
    host: info.host,
    authType: info.authType,
    hasDefaultKey: info.hasKey,
    defaultKeyLast4: null,
    enabled: true,
    ownerUserId: null,
    ownerUsername: null,
    modelCount: claudeModelCatalog.listAll().filter((entry) => entry.gatewayId === DEFAULT_GATEWAY_ID).length,
    updatedAt: null,
  };
}

/* ------------------------------ key 解析 ------------------------------ */

export type KeyStatus = { source: KeySource; personalLast4: string | null; personalSetBy: string | null };

/** 这个人在这个网关上用哪把 key(不给明文)。私有网关只有主人能用。 */
export function keyStatusFor(gateway: ModelGatewayRow | null, gatewayId: number, userId: number | null): KeyStatus {
  if (gatewayId !== DEFAULT_GATEWAY_ID && gateway && gateway.owner_user_id !== null) {
    const isOwner = userId !== null && gateway.owner_user_id === userId;
    return {
      source: isOwner && gateway.has_default_key === 1 ? 'personal' : 'none',
      personalLast4: isOwner ? gateway.default_key_last4 : null,
      personalSetBy: null,
    };
  }
  const own = userId !== null
    ? gatewayUserKeysDb.listForUser(userId).find((row) => row.gateway_id === gatewayId) ?? null
    : null;
  if (own) return { source: 'personal', personalLast4: own.key_last4, personalSetBy: own.set_by_username };
  if (gatewayId === DEFAULT_GATEWAY_ID) return { source: 'settings', personalLast4: null, personalSetBy: null };
  if (gateway?.has_default_key === 1) return { source: 'gateway_default', personalLast4: null, personalSetBy: null };
  return { source: 'none', personalLast4: null, personalSetBy: null };
}

/** 明文 key(没有为 null)。网关 0 没有个人 key 时返回 null —— 交给 CLI 读 settings.json。 */
function readKeyFor(gateway: ModelGatewayRow | null, gatewayId: number, userId: number | null): { source: KeySource; key: string | null } {
  if (gatewayId !== DEFAULT_GATEWAY_ID && gateway && gateway.owner_user_id !== null) {
    if (userId === null || gateway.owner_user_id !== userId) return { source: 'none', key: null };
    const key = modelGatewaysDb.readDefaultKey(gatewayId);
    return key ? { source: 'personal', key } : { source: 'none', key: null };
  }
  if (userId !== null) {
    const personal = gatewayUserKeysDb.readKey(gatewayId, userId);
    if (personal) return { source: 'personal', key: personal };
  }
  if (gatewayId === DEFAULT_GATEWAY_ID) return { source: 'settings', key: null };
  const fallback = modelGatewaysDb.readDefaultKey(gatewayId);
  return fallback ? { source: 'gateway_default', key: fallback } : { source: 'none', key: null };
}

/* ------------------------------ 给 CLI 的补丁 ------------------------------ */

export type GatewaySettingsPatch = { env: Record<string, string>; apiKeyHelper: string };

/**
 * flag 层的设置补丁(见文件头「怎么交给 CLI」)。
 * - 网关 0 + 个人 key:只换 key(地址、自定义头沿用 settings.json),另一种鉴权变量与 apiKeyHelper 清空;
 * - 别的网关:地址 + key,另一种鉴权变量、apiKeyHelper、自定义头清空,别名映射都指向这一轮的模型。
 */
export function buildGatewaySettingsPatch(input: {
  gatewayId: number;
  baseUrl: string | null;
  authType: GatewayAuthType;
  key: string;
  model: string | null;
}): GatewaySettingsPatch {
  const env: Record<string, string> = {
    [AUTH_VAR[input.authType]]: input.key,
    [OTHER_AUTH_VAR[input.authType]]: '',
  };
  if (input.gatewayId !== DEFAULT_GATEWAY_ID) {
    env.ANTHROPIC_BASE_URL = input.baseUrl ?? '';
    env.ANTHROPIC_CUSTOM_HEADERS = '';
    if (input.model) for (const name of ALIAS_MODEL_VARS) env[name] = input.model;
  }
  return { env, apiKeyHelper: '' };
}

/**
 * runtime 签名用:同一网关 + 地址 + 鉴权方式 + key → 同一个指纹。
 *
 * 别的网关上连模型一起算:补丁把别名映射(ANTHROPIC_DEFAULT_*_MODEL / SMALL_FAST)都钉在这一轮的模型上,
 * 只在进程启动时生效;不算模型的话,同网关内换模型会复用进程,子代理点名的别名、CLI 的后台小请求
 * 仍落在上一个模型上(共享会话里甚至落在别人的限人模型上)。代价:别的网关上换模型要 resume 重建一次。
 * 网关 0 不算模型(别名映射走 settings.json,补丁不碰它们;换模型照常 setModel)。
 */
export function gatewayFingerprint(input: {
  gatewayId: number;
  baseUrl: string | null;
  authType: GatewayAuthType;
  key: string;
  model?: string | null;
}): string {
  const model = input.gatewayId !== DEFAULT_GATEWAY_ID ? (input.model ?? '') : '';
  return createHash('sha256')
    .update(JSON.stringify([input.gatewayId, input.baseUrl ?? '', input.authType, input.key, model]))
    .digest('hex')
    .slice(0, 16);
}

export type TurnGateway = {
  gatewayId: number;
  gatewayName: string;
  keySource: KeySource;
  /** null = 什么都不传(网关 0、没有个人 key:CLI 读 settings.json)。 */
  settingsPatch: GatewaySettingsPatch | null;
  /** null 同上。进 runtime 签名。别的网关上含模型(见 gatewayFingerprint)。 */
  fingerprint: string | null;
  /**
   * 不含模型的那一份(网关 + 地址 + 鉴权方式 + key)。后台任务在跑时,只有它变了(换网关 / 换 key / 换人)
   * 才必须拒;只是同网关换模型就不重建,就地 setModel。
   */
  credentialFingerprint: string | null;
};

const DEFAULT_TURN_GATEWAY: TurnGateway = {
  gatewayId: DEFAULT_GATEWAY_ID,
  gatewayName: '默认网关',
  keySource: 'settings',
  settingsPatch: null,
  fingerprint: null,
  credentialFingerprint: null,
};

/** 这个模型走哪个网关(别名 / 不认识的 → 0)。 */
export function gatewayIdForModel(model: string | null | undefined, viewer: ModelViewer | null): number {
  if (isModelAlias(model)) return DEFAULT_GATEWAY_ID;
  return claudeModelCatalog.lookupFor(model, viewer)?.gatewayId ?? DEFAULT_GATEWAY_ID;
}

/**
 * 这一轮的网关与 key。不可用时抛 GatewayError(带 prismModelRejected,调度器直接报错)。
 * 网关 0 且没有个人 key → 不传任何东西,CLI 照常读 settings.json。
 */
export async function resolveTurnGateway(input: { model: string | null | undefined; viewer: ModelViewer | null }): Promise<TurnGateway> {
  try {
    return await resolveTurnGatewayUnchecked(input);
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    /*
     * 读库 / 解密失败(库坏了、PRISM_ENCRYPTION_KEY 换了)时不退回 settings.json 的 key
     * (那等于悄悄用公用 token 记账),也不让它变成调度器眼里的"进程问题"去走一次性路径重试一遍。
     */
    log.error('[网关] 解析这一轮的网关 / key 失败:', error instanceof Error ? error.message : error);
    throw new GatewayError(
      'GATEWAY_KEY_UNREADABLE',
      '读不到这一轮的网关配置或 key(数据库读取或解密失败)—— 请管理员检查服务端日志、数据库与 PRISM_ENCRYPTION_KEY;这一条没有发出去。',
      500,
    );
  }
}

async function resolveTurnGatewayUnchecked(input: { model: string | null | undefined; viewer: ModelViewer | null }): Promise<TurnGateway> {
  const model = typeof input.model === 'string' && input.model.trim() ? input.model.trim() : null;
  const viewer = input.viewer;
  const gatewayId = gatewayIdForModel(model, viewer);
  const userId = viewer?.userId ?? null;

  if (gatewayId === DEFAULT_GATEWAY_ID) {
    const { source, key } = readKeyFor(null, DEFAULT_GATEWAY_ID, userId);
    if (!key) return DEFAULT_TURN_GATEWAY;
    const info = await readDefaultGatewaySecrets();
    return {
      gatewayId: DEFAULT_GATEWAY_ID,
      gatewayName: '默认网关',
      keySource: source,
      settingsPatch: buildGatewaySettingsPatch({ gatewayId: DEFAULT_GATEWAY_ID, baseUrl: null, authType: info.authType, key, model }),
      fingerprint: gatewayFingerprint({ gatewayId: DEFAULT_GATEWAY_ID, baseUrl: null, authType: info.authType, key }),
      credentialFingerprint: gatewayFingerprint({ gatewayId: DEFAULT_GATEWAY_ID, baseUrl: null, authType: info.authType, key }),
    };
  }

  const gateway = modelGatewaysDb.get(gatewayId);
  if (!gateway) {
    throw new GatewayError('GATEWAY_MISSING', `模型「${model}」挂的网关已经不存在了 —— 换一个模型,或请管理员在 设置 → 模型 里重新指定网关。`);
  }
  if (gateway.enabled !== 1) {
    throw new GatewayError('GATEWAY_DISABLED', `模型「${model}」走的网关「${gateway.name}」已停用 —— 换一个模型,或请管理员启用这个网关。`);
  }
  if (gateway.owner_user_id !== null && gateway.owner_user_id !== userId) {
    throw new GatewayError('GATEWAY_FORBIDDEN', `模型「${model}」在别人的私有网关上,你不能用。`, 403);
  }
  const { source, key } = readKeyFor(gateway, gatewayId, userId);
  if (!key) {
    throw new GatewayError(
      'GATEWAY_KEY_MISSING',
      gateway.owner_user_id !== null
        ? `你的私有网关「${gateway.name}」还没有 key —— 在 设置 → 模型网关 里填上再发。`
        : `模型「${model}」走网关「${gateway.name}」,这个网关没有默认 key,你也还没填自己的 key —— 在 设置 → 模型网关 里填上再发。`,
    );
  }
  const authType = asAuthType(gateway.auth_type);
  return {
    gatewayId,
    gatewayName: gateway.name,
    keySource: source,
    settingsPatch: buildGatewaySettingsPatch({ gatewayId, baseUrl: gateway.base_url, authType, key, model }),
    fingerprint: gatewayFingerprint({ gatewayId, baseUrl: gateway.base_url, authType, key, model }),
    credentialFingerprint: gatewayFingerprint({ gatewayId, baseUrl: gateway.base_url, authType, key }),
  };
}

/* ------------------------------ 选择器:能不能用 ------------------------------ */

/**
 * 给选择器的定义标上"能不能用":挂在别的网关上的模型带 `gatewayName`;这个人在那个网关上没有可用的 key
 * (或网关停用 / 不见了)→ `available: false` + 一句原因。DEFAULT 若不可用,换成第一个可用的。
 */
export function annotateModelAvailability(definition: ProviderModelsDefinition, viewer: ModelViewer | null): ProviderModelsDefinition {
  const userId = viewer?.userId ?? null;
  const gateways = new Map<number, ModelGatewayRow | null>();
  const gatewayOf = (id: number): ModelGatewayRow | null => {
    if (!gateways.has(id)) gateways.set(id, modelGatewaysDb.get(id));
    return gateways.get(id) ?? null;
  };
  const OPTIONS = definition.OPTIONS.map((option) => {
    const gatewayId = option.gatewayId ?? DEFAULT_GATEWAY_ID;
    if (gatewayId === DEFAULT_GATEWAY_ID) return { ...option, available: true };
    const gateway = gatewayOf(gatewayId);
    if (!gateway) return { ...option, available: false, unavailableCode: 'gateway_missing' as const, unavailableReason: '挂的网关已经不存在了' };
    const annotated = { ...option, gatewayName: gateway.name };
    if (gateway.enabled !== 1) return { ...annotated, available: false, unavailableCode: 'gateway_disabled' as const, unavailableReason: `网关「${gateway.name}」已停用` };
    const status = keyStatusFor(gateway, gatewayId, userId);
    if (status.source === 'none') {
      return {
        ...annotated,
        available: false,
        unavailableCode: 'no_key' as const,
        unavailableReason: gateway.owner_user_id !== null
          ? `私有网关「${gateway.name}」还没有 key`
          : `网关「${gateway.name}」需要你自己的 key —— 在 设置 → 模型网关 里填`,
      };
    }
    return { ...annotated, available: true };
  });
  let DEFAULT = definition.DEFAULT;
  const current = OPTIONS.find((option) => option.value === DEFAULT);
  if (current && current.available === false) {
    const fallback = OPTIONS.find((option) => option.group === 'catalog' && option.available !== false && option.recommended)
      ?? OPTIONS.find((option) => option.group === 'catalog' && option.available !== false);
    DEFAULT = fallback?.value ?? 'default';
  }
  return { OPTIONS, DEFAULT };
}

/** 选择器的完整定义(按人过滤 + 私有模型 + 能不能用)。 */
export function modelsDefinitionFor(viewer: ModelViewer | null): ProviderModelsDefinition {
  return annotateModelAvailability(claudeModelCatalog.buildModelsDefinition(viewer), viewer);
}

/* ------------------------------ 管理:共享网关(root) ------------------------------ */

export function listSharedGatewayViews(): GatewayView[] {
  return modelGatewaysDb.listShared().map((row) => rowToView(row, { fullUrl: true }));
}

/** root 看全部私有网关(只看名字、host、主人、模型数 —— 不看 key)。 */
export function listAllPrivateGatewayViews(): GatewayView[] {
  return modelGatewaysDb.listAll()
    .filter((row) => row.owner_user_id !== null)
    .map((row) => ({ ...rowToView(row, { fullUrl: false }), defaultKeyLast4: null }));
}

function requireShared(id: number): ModelGatewayRow {
  const row = modelGatewaysDb.get(id);
  if (!row || row.owner_user_id !== null) throw new GatewayError('NOT_FOUND', '这个共享网关不存在', 404);
  return row;
}

export function createSharedGateway(
  input: { name?: unknown; baseUrl?: unknown; authType?: unknown; enabled?: unknown; defaultKey?: unknown },
  actorId: number | null,
): GatewayView {
  const write = validateGatewayInput(input, null);
  if (modelGatewaysDb.findByName(write.name, null)) throw new GatewayError('DUPLICATE_NAME', `已经有叫「${write.name}」的共享网关了`, 409);
  const key = input.defaultKey !== undefined && input.defaultKey !== null && input.defaultKey !== '' ? normalizeKey(input.defaultKey) : null;
  const row = modelGatewaysDb.insert(write, null, actorId);
  if (key) modelGatewaysDb.setDefaultKey(row.id, key, actorId);
  invalidateCatalogCache();
  return rowToView(modelGatewaysDb.get(row.id)!, { fullUrl: true });
}

export function updateSharedGateway(
  id: number,
  input: { name?: unknown; baseUrl?: unknown; authType?: unknown; enabled?: unknown },
  actorId: number | null,
): { before: GatewayView; after: GatewayView } {
  const base = requireShared(id);
  const write = validateGatewayInput(input, base);
  const clash = modelGatewaysDb.findByName(write.name, null);
  if (clash && clash.id !== id) throw new GatewayError('DUPLICATE_NAME', `已经有叫「${write.name}」的共享网关了`, 409);
  const before = rowToView(base, { fullUrl: true });
  modelGatewaysDb.update(id, write, actorId);
  invalidateCatalogCache();
  return { before, after: rowToView(modelGatewaysDb.get(id)!, { fullUrl: true }) };
}

export function setSharedGatewayDefaultKey(id: number, rawKey: unknown, actorId: number | null): GatewayView {
  requireShared(id);
  const key = rawKey === null || rawKey === '' ? null : normalizeKey(rawKey);
  modelGatewaysDb.setDefaultKey(id, key, actorId);
  return rowToView(modelGatewaysDb.get(id)!, { fullUrl: true });
}

export function deleteSharedGateway(id: number): GatewayView {
  const row = requireShared(id);
  const used = modelCatalogDb.countByGateway(id);
  if (used > 0) {
    throw new GatewayError('GATEWAY_IN_USE', `还有 ${used} 个目录模型挂在「${row.name}」上 —— 先把它们改到别的网关或删掉`, 409);
  }
  const view = rowToView(row, { fullUrl: true });
  modelGatewaysDb.remove(id);
  invalidateCatalogCache();
  return view;
}

/* ------------------------------ 个人 key ------------------------------ */

/**
 * 个人 key 只能填在网关 0 与共享网关上(私有网关的 key 是网关本身的)。
 * 别人的私有网关一律当"不存在"(404)—— 回 400 就等于告诉调用方"这个 id 是某人的私有网关"。
 */
function requireKeyableGateway(gatewayId: number, callerId: number | null = null): ModelGatewayRow | null {
  if (gatewayId === DEFAULT_GATEWAY_ID) return null;
  const row = modelGatewaysDb.get(gatewayId);
  if (!row) throw new GatewayError('NOT_FOUND', '这个网关不存在', 404);
  if (row.owner_user_id !== null) {
    if (callerId === null || row.owner_user_id !== callerId) throw new GatewayError('NOT_FOUND', '这个网关不存在', 404);
    throw new GatewayError('PRIVATE_GATEWAY', '私有网关的 key 在网关本身上改');
  }
  return row;
}

export function setPersonalKey(gatewayId: number, userId: number, rawKey: unknown, setBy: number | null): void {
  requireKeyableGateway(gatewayId, setBy);
  if (!userDb.getUserById(userId)) throw new GatewayError('NOT_FOUND', '这个用户不存在', 404);
  gatewayUserKeysDb.upsert(gatewayId, userId, normalizeKey(rawKey), setBy);
}

export function clearPersonalKey(gatewayId: number, userId: number, callerId: number | null = userId): boolean {
  requireKeyableGateway(gatewayId, callerId);
  return gatewayUserKeysDb.remove(gatewayId, userId);
}

export function listGatewayKeyHolders(gatewayId: number) {
  requireKeyableGateway(gatewayId);
  return gatewayUserKeysDb.listForGateway(gatewayId).map((row) => ({
    userId: row.user_id,
    username: row.username,
    keyLast4: row.key_last4,
    setBy: row.set_by_username,
    updatedAt: row.updated_at,
  }));
}

/* ------------------------------ 本人视角 ------------------------------ */

export type MyGatewayView = GatewayView & KeyStatus & { canSetPersonalKey: boolean; models: Array<{ modelId: string; label: string }> };

/**
 * 「我的模型网关」页:网关 0 + 共享网关(启用的)+ 我的私有网关,各自我用哪把 key、上面有哪些我看得见的模型。
 */
export async function myGatewayViews(viewer: ModelViewer): Promise<MyGatewayView[]> {
  const userId = viewer.userId;
  const visible = claudeModelCatalog.buildModelsDefinition(viewer).OPTIONS.filter((option) => option.group === 'catalog');
  const modelsOn = (gatewayId: number) => visible
    .filter((option) => (option.gatewayId ?? 0) === gatewayId)
    .map((option) => ({ modelId: option.value, label: option.label }));
  const views: MyGatewayView[] = [];
  const zero = await defaultGatewayView(viewer);
  views.push({ ...zero, ...keyStatusFor(null, DEFAULT_GATEWAY_ID, userId), canSetPersonalKey: true, models: modelsOn(DEFAULT_GATEWAY_ID) });
  for (const row of modelGatewaysDb.listShared()) {
    if (row.enabled !== 1) continue;
    const view = rowToView(row, { fullUrl: viewer.isRoot });
    views.push({ ...view, ...keyStatusFor(row, row.id, userId), canSetPersonalKey: true, models: modelsOn(row.id) });
  }
  if (userId !== null) {
    for (const row of modelGatewaysDb.listOwnedBy(userId)) {
      const view = rowToView(row, { fullUrl: true });
      views.push({ ...view, ...keyStatusFor(row, row.id, userId), canSetPersonalKey: false, models: modelsOn(row.id) });
    }
  }
  return views;
}

/* ------------------------------ 私有网关(本人) ------------------------------ */

function assertPrivateAllowed(): void {
  if (!privateGatewaysEnabled()) throw new GatewayError('PRIVATE_GATEWAYS_DISABLED', '管理员关掉了私有网关', 403);
}

function requireOwnPrivate(id: number, userId: number): ModelGatewayRow {
  const row = modelGatewaysDb.get(id);
  if (!row || row.owner_user_id !== userId) throw new GatewayError('NOT_FOUND', '这个私有网关不存在', 404);
  return row;
}

const MAX_PRIVATE_GATEWAYS = 10;
const MAX_PRIVATE_MODELS = 50;

export function createPrivateGateway(
  userId: number,
  input: { name?: unknown; baseUrl?: unknown; authType?: unknown; enabled?: unknown; key?: unknown },
): GatewayView {
  assertPrivateAllowed();
  if (modelGatewaysDb.listOwnedBy(userId).length >= MAX_PRIVATE_GATEWAYS) {
    throw new GatewayError('TOO_MANY', `私有网关最多 ${MAX_PRIVATE_GATEWAYS} 个`);
  }
  const write = validateGatewayInput(input, null);
  if (modelGatewaysDb.findByName(write.name, userId)) throw new GatewayError('DUPLICATE_NAME', `你已经有叫「${write.name}」的网关了`, 409);
  const key = input.key !== undefined && input.key !== null && input.key !== '' ? normalizeKey(input.key) : null;
  const row = modelGatewaysDb.insert(write, userId, userId);
  if (key) modelGatewaysDb.setDefaultKey(row.id, key, userId);
  return rowToView(modelGatewaysDb.get(row.id)!, { fullUrl: true });
}

export function updatePrivateGateway(
  userId: number,
  id: number,
  input: { name?: unknown; baseUrl?: unknown; authType?: unknown; enabled?: unknown },
): GatewayView {
  assertPrivateAllowed();
  const base = requireOwnPrivate(id, userId);
  const write = validateGatewayInput(input, base);
  const clash = modelGatewaysDb.findByName(write.name, userId);
  if (clash && clash.id !== id) throw new GatewayError('DUPLICATE_NAME', `你已经有叫「${write.name}」的网关了`, 409);
  modelGatewaysDb.update(id, write, userId);
  return rowToView(modelGatewaysDb.get(id)!, { fullUrl: true });
}

export function setPrivateGatewayKey(userId: number, id: number, rawKey: unknown): GatewayView {
  assertPrivateAllowed();
  requireOwnPrivate(id, userId);
  const key = rawKey === null || rawKey === '' ? null : normalizeKey(rawKey);
  modelGatewaysDb.setDefaultKey(id, key, userId);
  return rowToView(modelGatewaysDb.get(id)!, { fullUrl: true });
}

/** 删私有网关:连同挂在上面的私有模型(不受开关限制 —— 关掉之后也要能清掉自己的东西)。 */
export function deletePrivateGateway(userId: number, id: number): GatewayView {
  const row = requireOwnPrivate(id, userId);
  const view = rowToView(row, { fullUrl: true });
  modelGatewaysDb.remove(id);
  return view;
}

/* ------------------------------ 私有模型(本人) ------------------------------ */

export function listMyModels(userId: number): CatalogEntry[] {
  return userModelsDb.listForUser(userId).map(userModelToEntry);
}

export function createMyModel(userId: number, input: CatalogInput): CatalogEntry {
  assertPrivateAllowed();
  const write = validateUserModelInput(input, null);
  requireOwnPrivate(write.gatewayId, userId);
  if (userModelsDb.listForUser(userId).length >= MAX_PRIVATE_MODELS) {
    throw new GatewayError('TOO_MANY', `私有模型最多 ${MAX_PRIVATE_MODELS} 个`);
  }
  if (userModelsDb.findForUser(userId, write.modelId)) {
    throw new CatalogValidationError('DUPLICATE_MODEL_ID', `你已经有「${write.modelId}」了`, 409);
  }
  return userModelToEntry(userModelsDb.insert(userId, write));
}

export function updateMyModel(userId: number, id: number, input: CatalogInput): CatalogEntry {
  assertPrivateAllowed();
  const row = userModelsDb.get(id);
  if (!row || row.user_id !== userId) throw new GatewayError('NOT_FOUND', '这个私有模型不存在', 404);
  const write = validateUserModelInput(input, userModelToEntry(row));
  requireOwnPrivate(write.gatewayId, userId);
  const clash = userModelsDb.findForUser(userId, write.modelId);
  if (clash && clash.id !== id) throw new CatalogValidationError('DUPLICATE_MODEL_ID', `你已经有「${write.modelId}」了`, 409);
  return userModelToEntry(userModelsDb.update(id, write)!);
}

export function deleteMyModel(userId: number, id: number): CatalogEntry {
  const row = userModelsDb.get(id);
  if (!row || row.user_id !== userId) throw new GatewayError('NOT_FOUND', '这个私有模型不存在', 404);
  userModelsDb.remove(id);
  return userModelToEntry(row);
}

/* ------------------------------ 测试连接 ------------------------------ */

export type GatewayTestResult = {
  ok: boolean;
  status: number | null;
  latencyMs: number;
  modelCount: number | null;
  sampleModels: string[];
  error: string | null;
};

const TEST_TIMEOUT_MS = 10_000;

/**
 * `GET {baseUrl}/v1/models` 带 key 打一次。只说明"地址通、key 被接受";某个模型能不能干活看模型的「实测」。
 * 有的网关只实现了 /v1/messages(404)—— 照实说,不算 key 有问题。
 */
export async function testGatewayConnection(input: { baseUrl: string | null; authType: GatewayAuthType; key: string | null }): Promise<GatewayTestResult> {
  const startedAt = Date.now();
  const result = (partial: Partial<GatewayTestResult>): GatewayTestResult => ({
    ok: false, status: null, latencyMs: Date.now() - startedAt, modelCount: null, sampleModels: [], error: null, ...partial,
  });
  if (!input.baseUrl) return result({ error: '没有网关地址' });
  if (!input.key) return result({ error: '没有可用的 key —— 填一个再测' });
  const headers: Record<string, string> = { 'anthropic-version': '2023-06-01', accept: 'application/json' };
  if (input.authType === 'x-api-key') headers['x-api-key'] = input.key;
  else headers.authorization = `Bearer ${input.key}`;
  try {
    const response = await fetch(`${input.baseUrl}/v1/models?limit=200`, { headers, signal: AbortSignal.timeout(TEST_TIMEOUT_MS) });
    const latencyMs = Date.now() - startedAt;
    if (response.status === 401 || response.status === 403) {
      return result({ status: response.status, latencyMs, error: `网关拒绝了这个 key(HTTP ${response.status})` });
    }
    if (response.status === 404) {
      return result({ status: 404, latencyMs, error: '地址通了,但网关没有 /v1/models(有的网关只实现了 /v1/messages)—— 对具体模型点「实测」确认' });
    }
    if (!response.ok) return result({ status: response.status, latencyMs, error: `网关返回 HTTP ${response.status}` });
    let ids: string[] = [];
    try {
      const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
      ids = (body.data ?? []).map((item) => (typeof item?.id === 'string' ? item.id : '')).filter(Boolean);
    } catch {
      ids = [];
    }
    return result({ ok: true, status: response.status, latencyMs, modelCount: ids.length, sampleModels: ids.slice(0, 50) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const timedOut = /timeout|aborted/i.test(message);
    return result({ error: timedOut ? `超时(${TEST_TIMEOUT_MS / 1000}s 没有回应)` : `连不上:${message}` });
  }
}

/**
 * 测某个网关:给了 key 就用给的(保存前先测);没给就用"这个人现在会用的那把"。
 * 网关 0 没有个人 key 时用 settings.json 里的 token(只在服务端用,不回给前端)。
 */
export async function testGatewayFor(gatewayId: number, viewer: ModelViewer, rawKey?: unknown): Promise<GatewayTestResult> {
  const provided = rawKey !== undefined && rawKey !== null && rawKey !== '' ? normalizeKey(rawKey) : null;
  if (gatewayId === DEFAULT_GATEWAY_ID) {
    const info = await readDefaultGatewaySecrets();
    const key = provided ?? readKeyFor(null, DEFAULT_GATEWAY_ID, viewer.userId).key ?? info.key;
    return testGatewayConnection({ baseUrl: info.baseUrl, authType: info.authType, key });
  }
  const row = modelGatewaysDb.get(gatewayId);
  if (!row) throw new GatewayError('NOT_FOUND', '这个网关不存在', 404);
  if (row.owner_user_id !== null && row.owner_user_id !== viewer.userId) throw new GatewayError('NOT_FOUND', '这个网关不存在', 404);
  // 非 root 只能测启用的共享网关:停用网关上的模型本来就用不了,不该借它的默认 key 去探
  if (row.owner_user_id === null && row.enabled !== 1 && !viewer.isRoot) throw new GatewayError('GATEWAY_DISABLED', `网关「${row.name}」已停用`);
  const key = provided ?? readKeyFor(row, gatewayId, viewer.userId).key;
  return testGatewayConnection({ baseUrl: row.base_url, authType: asAuthType(row.auth_type), key });
}

/** 未保存的新网关(地址 + key 直接测)。 */
export async function testUnsavedGateway(input: { baseUrl?: unknown; authType?: unknown; key?: unknown }): Promise<GatewayTestResult> {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const authType: GatewayAuthType = input.authType === 'x-api-key' ? 'x-api-key' : 'bearer';
  return testGatewayConnection({ baseUrl, authType, key: normalizeKey(input.key) });
}

export function logGatewayResolution(turn: TurnGateway, model: string | null): void {
  if (turn.gatewayId === DEFAULT_GATEWAY_ID && turn.keySource === 'settings') return;
  log.info(`[网关] ${model ?? 'default'} → ${turn.gatewayName}(#${turn.gatewayId},key 来源 ${turn.keySource})`);
}
