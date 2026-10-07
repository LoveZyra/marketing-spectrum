import {
  appConfigDb,
  modelCatalogDb,
  modelGatewaysDb,
  userDb,
  userModelsDb,
  type ModelCatalogRow,
  type ModelCatalogWrite,
  type UserModelRow,
} from '@/modules/database/index.js';
import type { ProviderModelOption, ProviderModelsDefinition } from '@/shared/types.js';
import { createLogger } from '@/shared/logger.js';
import { isRootUser } from '@/shared/root-users.js';

import {
  CONTEXT_WINDOW_MAX,
  CONTEXT_WINDOW_MIN,
  MODEL_ID_MAX_LENGTH,
  detectModelVendor,
  getModelVendor,
  isValidModelId,
  type ModelVendorId,
} from '../../../../../shared/modelVendors.js';

import { CLAUDE_FALLBACK_MODELS } from './claude-model-aliases.js';
import { readAliasConfigMappings } from './claude-settings-mapping.service.js';

const log = createLogger('providers');

/**
 * 模型目录的服务层:校验、30 秒缓存、别名解析、闸口、播种、给选择器的定义。
 *
 * 目录是"选择器里能选什么";别名(经 settings.json 的 `ANTHROPIC_DEFAULT_*_MODEL` 映射)
 * 始终留在服务端的别名组里:档位解析与模型校验都靠它,存量会话 / 定时任务 / 外部调用方
 * 传的别名才能继续被接受。
 *
 * 按人区分:
 * - 目录条目可以限定「可用人员」(`allowed_users`,root 不受限);不在名单里的人看不到、发不出;
 * - 每个人可以有自己的私有模型(`user_models`,挂在本人的私有网关上),只有本人看得到、用得了;
 *   与目录条目同名时,对本人来说私有的那条优先;
 * - 网关与 key 的解析在 claude-gateways.service(这里只管"能不能选、长什么样")。
 */

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** 别名组:永远在服务端目录里(是否在选择器露出是前端的事)。 */
export const ALIAS_GROUP_VALUES: readonly string[] = Object.freeze(CLAUDE_FALLBACK_MODELS.OPTIONS.map((option) => option.value));
const ALIAS_SET = new Set(ALIAS_GROUP_VALUES);

export const isModelAlias = (model: string | null | undefined): boolean =>
  !model || ALIAS_SET.has(model.trim());

export type CatalogProbeResult = {
  at: string;
  ok: boolean;
  accepted: boolean;
  toolRoundTrip: boolean;
  inputTokens: number | null;
  respondedModel: string | null;
  latencyMs: number;
  error: string | null;
};

export type CatalogEntry = {
  id: number;
  modelId: string;
  label: string;
  /** 生效的厂商:手动指定的优先,否则按 model_id 自动识别;都没有为 null(首字母徽标)。 */
  vendor: ModelVendorId | null;
  /** root 手动指定的(可能为 null = 自动)。 */
  vendorOverride: ModelVendorId | null;
  description: string | null;
  contextWindow: number | null;
  effortLevels: EffortLevel[];
  effortDefault: EffortLevel | null;
  recommended: boolean;
  sortOrder: number;
  enabled: boolean;
  isDefault: boolean;
  lastProbe: CatalogProbeResult | null;
  createdAt: string;
  updatedAt: string;
  updatedBy: number | null;
  /** 走哪个网关;0 = settings.json 那一套。 */
  gatewayId: number;
  /** 可用人员(用户 id);null = 所有人。 */
  allowedUsers: number[] | null;
  /** 私有模型的主人(目录条目为 null)。 */
  ownerUserId: number | null;
};

/** 谁在看 / 谁在用:闸口与选择器按人。`isRoot` 不受「可用人员」限制。 */
export type ModelViewer = { userId: number | null; isRoot: boolean };

export class CatalogValidationError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** 闸口拒绝 —— `code` 进 400 响应;`prismModelRejected` 让 claude-sdk 的调度器不退回一次性路径。 */
export class ModelNotAllowedError extends Error {
  code = 'MODEL_NOT_ALLOWED';
  status = 400;
  prismModelRejected = true;
  model: string;
  constructor(model: string, message?: string) {
    super(message ?? `模型「${model}」不在模型目录里(或已下架)。请在 /models 里另选一个;要用新模型请找管理员在「模型目录」里上架。`);
    this.model = model;
  }
}

const parseJson = <T>(raw: string | null): T | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const toEntry = (row: ModelCatalogRow): CatalogEntry => {
  const override = getModelVendor(row.vendor)?.id ?? null;
  const levels = (parseJson<unknown[]>(row.effort_levels) ?? [])
    .filter((value): value is EffortLevel => (EFFORT_LEVELS as readonly string[]).includes(String(value)));
  const effortDefault = row.effort_default && levels.includes(row.effort_default as EffortLevel)
    ? (row.effort_default as EffortLevel)
    : null;
  return {
    id: row.id,
    modelId: row.model_id,
    label: row.label,
    vendor: override ?? detectModelVendor(row.model_id),
    vendorOverride: override,
    description: row.description,
    contextWindow: row.context_window,
    effortLevels: levels,
    effortDefault,
    recommended: row.recommended === 1,
    sortOrder: row.sort_order,
    enabled: row.enabled === 1,
    isDefault: row.is_default === 1,
    lastProbe: parseJson<CatalogProbeResult>(row.last_probe),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    gatewayId: row.gateway_id && row.gateway_id > 0 ? row.gateway_id : 0,
    allowedUsers: parseAllowedUsers(row.allowed_users),
    ownerUserId: null,
  };
};

function parseAllowedUsers(raw: string | null | undefined): number[] | null {
  const parsed = parseJson<unknown>(raw ?? null);
  if (!Array.isArray(parsed)) return null;
  return parsed.map(Number).filter((value) => Number.isInteger(value) && value > 0);
}

/** 私有模型 → 与目录条目同形(没有推荐 / 默认 / 可用人员)。 */
export const userModelToEntry = (row: UserModelRow): CatalogEntry => {
  const levels = (parseJson<unknown[]>(row.effort_levels) ?? [])
    .filter((value): value is EffortLevel => (EFFORT_LEVELS as readonly string[]).includes(String(value)));
  const override = getModelVendor(row.vendor)?.id ?? null;
  return {
    id: row.id,
    modelId: row.model_id,
    label: row.label,
    vendor: override ?? detectModelVendor(row.model_id),
    vendorOverride: override,
    description: null,
    contextWindow: row.context_window,
    effortLevels: levels,
    effortDefault: row.effort_default && levels.includes(row.effort_default as EffortLevel) ? (row.effort_default as EffortLevel) : null,
    recommended: false,
    sortOrder: row.sort_order,
    enabled: row.enabled === 1,
    isDefault: false,
    lastProbe: null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.user_id,
    gatewayId: row.gateway_id,
    allowedUsers: null,
    ownerUserId: row.user_id,
  };
};

/* ------------------------- 私有网关开关 ------------------------- */

export const PRIVATE_GATEWAYS_KEY = 'claude_private_gateways_enabled';

/** root 在 设置 → 模型 里关;没设 = 开。 */
export function privateGatewaysEnabled(): boolean {
  try {
    return appConfigDb.get(PRIVATE_GATEWAYS_KEY) !== '0';
  } catch {
    return true;
  }
}

/**
 * 这个人现在能用的私有模型(上架的、挂在他自己且启用的私有网关上的;私有网关被 root 关掉时一条都没有)。
 * 每次读库:一个人几条,索引命中,不值得为它加缓存再操心失效。
 */
export function privateEntriesFor(userId: number | null | undefined): CatalogEntry[] {
  if (!userId || !privateGatewaysEnabled()) return [];
  try {
    const gateways = new Map(modelGatewaysDb.listOwnedBy(userId).map((gateway) => [gateway.id, gateway]));
    return userModelsDb.listForUser(userId)
      .map(userModelToEntry)
      .filter((entry) => entry.enabled && gateways.get(entry.gatewayId)?.enabled === 1);
  } catch (error) {
    log.warn('[模型目录] 读私有模型失败,按没有处理:', error instanceof Error ? error.message : error);
    return [];
  }
}

/** 目录条目对这个人可见吗(「可用人员」;root 不受限;没给 viewer = 不按人过滤)。 */
export const entryVisibleTo = (entry: CatalogEntry, viewer?: ModelViewer | null): boolean => {
  if (!viewer || viewer.isRoot || entry.allowedUsers === null) return true;
  return viewer.userId !== null && entry.allowedUsers.includes(viewer.userId);
};

/** 由用户 id 拼 viewer(查不到的人按非 root)。 */
export function modelViewerFor(userId: number | null | undefined, username?: string | null): ModelViewer {
  const id = typeof userId === 'number' && userId > 0 ? userId : null;
  let name = typeof username === 'string' && username ? username : null;
  if (!name && id !== null) {
    try {
      name = userDb.getUserById(id)?.username ?? null;
    } catch {
      name = null;
    }
  }
  return { userId: id, isRoot: Boolean(name && isRootUser(name)) };
}

/* ------------------------------ 校验 ------------------------------ */

export type CatalogInput = {
  modelId?: unknown;
  label?: unknown;
  vendor?: unknown;
  description?: unknown;
  contextWindow?: unknown;
  effortLevels?: unknown;
  effortDefault?: unknown;
  recommended?: unknown;
  sortOrder?: unknown;
  enabled?: unknown;
  isDefault?: unknown;
  /** 0 / null = settings.json 那一套;其余 = 共享网关 id(存在性在 create / update 里查)。 */
  gatewayId?: unknown;
  /** null = 所有人;数组 = 用户 id。 */
  allowedUsers?: unknown;
};

const optionalText = (value: unknown, field: string, max: number): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new CatalogValidationError('BAD_FIELD', `${field} 必须是字符串`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new CatalogValidationError('BAD_FIELD', `${field} 不能超过 ${max} 个字符`);
  return trimmed || null;
};

/**
 * 把一次新建 / 修改的输入校验成写库的形状。`base` 是修改前的那一行(新建时为 null),
 * 输入里没给的字段沿用它。
 */
export function validateCatalogInput(input: CatalogInput, base: CatalogEntry | null): ModelCatalogWrite {
  const pick = <K extends keyof CatalogInput>(key: K) => (input[key] !== undefined ? input[key] : undefined);

  const modelIdRaw = pick('modelId') ?? base?.modelId;
  const modelId = typeof modelIdRaw === 'string' ? modelIdRaw.trim() : '';
  if (!isValidModelId(modelId)) {
    throw new CatalogValidationError(
      'BAD_MODEL_ID',
      `模型名要以字母或数字开头,只含字母、数字与 . _ : / @ - [ ],不超过 ${MODEL_ID_MAX_LENGTH} 个字符`,
    );
  }
  if (ALIAS_SET.has(modelId)) {
    throw new CatalogValidationError('MODEL_ID_IS_ALIAS', `「${modelId}」是内置别名,不能作为目录条目的模型名`);
  }

  const labelRaw = pick('label') ?? base?.label ?? modelId;
  const label = optionalText(labelRaw, '显示名', 80) ?? modelId;

  let vendor: string | null = base?.vendorOverride ?? null;
  if (input.vendor !== undefined) {
    if (input.vendor === null || input.vendor === '' || input.vendor === 'auto') vendor = null;
    else if (typeof input.vendor === 'string' && getModelVendor(input.vendor)) vendor = input.vendor;
    else throw new CatalogValidationError('BAD_VENDOR', `厂商「${String(input.vendor)}」不认识`);
  }

  const description = input.description !== undefined ? optionalText(input.description, '说明', 200) : (base?.description ?? null);

  let contextWindow: number | null = base?.contextWindow ?? null;
  if (input.contextWindow !== undefined) {
    if (input.contextWindow === null || input.contextWindow === '') {
      contextWindow = null;
    } else {
      const value = Number(input.contextWindow);
      if (!Number.isInteger(value) || value < CONTEXT_WINDOW_MIN || value > CONTEXT_WINDOW_MAX) {
        throw new CatalogValidationError(
          'BAD_CONTEXT_WINDOW',
          `上下文窗口要填 ${CONTEXT_WINDOW_MIN} 到 ${CONTEXT_WINDOW_MAX} 之间的整数,或留空(CLI 的自动压缩窗口最低 100000,再小的窗口跑不起来)`,
        );
      }
      contextWindow = value;
    }
  }

  let effortLevels: EffortLevel[] = base?.effortLevels ?? [];
  if (input.effortLevels !== undefined) {
    if (input.effortLevels === null) {
      effortLevels = [];
    } else if (!Array.isArray(input.effortLevels)) {
      throw new CatalogValidationError('BAD_EFFORT', '档位必须是数组');
    } else {
      const unknown = input.effortLevels.filter((level) => !(EFFORT_LEVELS as readonly unknown[]).includes(level));
      if (unknown.length > 0) {
        throw new CatalogValidationError('BAD_EFFORT', `档位只能是 ${EFFORT_LEVELS.join(' / ')}`);
      }
      // 去重、按固定顺序排
      effortLevels = EFFORT_LEVELS.filter((level) => (input.effortLevels as unknown[]).includes(level));
    }
  }
  let effortDefault: string | null = base?.effortDefault ?? null;
  if (input.effortDefault !== undefined) {
    effortDefault = input.effortDefault === null || input.effortDefault === '' ? null : String(input.effortDefault);
  }
  if (effortDefault && !effortLevels.includes(effortDefault as EffortLevel)) {
    if (input.effortDefault !== undefined) {
      throw new CatalogValidationError('BAD_EFFORT', '默认档位必须是已勾选的档位之一');
    }
    effortDefault = null; // 档位改了、旧默认不在里面了 → 清掉
  }

  const bool = (value: unknown, fallback: boolean): boolean => {
    if (value === undefined) return fallback;
    if (typeof value === 'boolean') return value;
    if (value === 1 || value === 0) return value === 1;
    throw new CatalogValidationError('BAD_FIELD', '开关字段必须是 true / false');
  };
  const recommended = bool(input.recommended, base?.recommended ?? false);
  const enabled = bool(input.enabled, base?.enabled ?? true);
  let isDefault = bool(input.isDefault, base?.isDefault ?? false);
  if (isDefault && !enabled) {
    if (input.isDefault === true) throw new CatalogValidationError('DEFAULT_MUST_BE_ENABLED', '下架的模型不能设为默认');
    isDefault = false; // 下架时顺手取消默认
  }

  let sortOrder = base?.sortOrder ?? 0;
  if (input.sortOrder !== undefined) {
    const value = Number(input.sortOrder);
    if (!Number.isInteger(value) || Math.abs(value) > 1_000_000) throw new CatalogValidationError('BAD_FIELD', '排序必须是整数');
    sortOrder = value;
  }

  let gatewayId: number | null = base && base.gatewayId > 0 ? base.gatewayId : null;
  if (input.gatewayId !== undefined) {
    if (input.gatewayId === null || input.gatewayId === '' || input.gatewayId === 0 || input.gatewayId === '0') {
      gatewayId = null;
    } else {
      const value = Number(input.gatewayId);
      if (!Number.isInteger(value) || value <= 0) throw new CatalogValidationError('BAD_GATEWAY', '网关 id 不对');
      gatewayId = value;
    }
  }

  let allowedUsers: number[] | null = base?.allowedUsers ?? null;
  if (input.allowedUsers !== undefined) {
    if (input.allowedUsers === null) {
      allowedUsers = null;
    } else if (!Array.isArray(input.allowedUsers)) {
      throw new CatalogValidationError('BAD_ALLOWED_USERS', '可用人员必须是用户 id 的数组,或 null(所有人)');
    } else {
      const ids = input.allowedUsers.map(Number);
      if (ids.some((value) => !Number.isInteger(value) || value <= 0)) {
        throw new CatalogValidationError('BAD_ALLOWED_USERS', '可用人员里有不认识的用户 id');
      }
      if (ids.length > 500) throw new CatalogValidationError('BAD_ALLOWED_USERS', '可用人员最多 500 个');
      allowedUsers = [...new Set(ids)].sort((a, b) => a - b);
    }
  }

  return {
    modelId, label, vendor, description, contextWindow, effortLevels, effortDefault, recommended, sortOrder, enabled, isDefault,
    gatewayId, allowedUsers,
  };
}

/**
 * 私有模型的校验:复用目录的字段规则(模型名、显示名、厂商、窗口、档位、上架),
 * 推荐 / 默认 / 可用人员 / 说明这些面向全员的字段不收。网关的归属在 claude-gateways.service 里查。
 */
export function validateUserModelInput(input: CatalogInput & { gatewayId?: unknown }, base: CatalogEntry | null) {
  const write = validateCatalogInput(
    { ...input, recommended: undefined, isDefault: undefined, allowedUsers: undefined, description: undefined },
    base,
  );
  const gatewayRaw = input.gatewayId !== undefined ? input.gatewayId : base?.gatewayId;
  const gatewayId = Number(gatewayRaw);
  if (!Number.isInteger(gatewayId) || gatewayId <= 0) {
    throw new CatalogValidationError('BAD_GATEWAY', '私有模型要挂在你自己的私有网关上');
  }
  return {
    gatewayId,
    modelId: write.modelId,
    label: write.label,
    vendor: write.vendor,
    contextWindow: write.contextWindow,
    effortLevels: write.effortLevels,
    effortDefault: write.effortDefault,
    enabled: write.enabled,
    sortOrder: write.sortOrder,
  };
}

/**
 * 目录条目引用的网关 / 人员必须存在(写库前查)。
 * 人员只查这次新加的:名单里有人被停用后(listBasicUsers 只列在用的),
 * 不能因此连"上架 / 下架"这种只改别的字段的写都被拒。
 */
function assertCatalogReferences(write: ModelCatalogWrite, before: CatalogEntry | null = null): void {
  if (write.gatewayId) {
    const gateway = modelGatewaysDb.get(write.gatewayId);
    if (!gateway || gateway.owner_user_id !== null) {
      throw new CatalogValidationError('BAD_GATEWAY', '选的网关不存在(目录条目只能挂共享网关)');
    }
  }
  const previous = new Set(before?.allowedUsers ?? []);
  const added = (write.allowedUsers ?? []).filter((id) => !previous.has(id));
  if (added.length > 0) {
    const known = new Set(userDb.listBasicUsers().map((user) => user.id));
    const unknown = added.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new CatalogValidationError('BAD_ALLOWED_USERS', `可用人员里有不存在的用户(id ${unknown.join(', ')})`);
    }
  }
}

/* ------------------------------ 缓存 ------------------------------ */

const CACHE_TTL_MS = 30_000;
let cache: { at: number; entries: CatalogEntry[] } | null = null;
/** 上一次成功读到的快照 —— 库读失败时档位解析与闸口退回它,而不是写死的别名表(否则目录模型的档位被静默丢掉)。 */
let lastGood: CatalogEntry[] = [];

const loadEntries = (): CatalogEntry[] => {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.entries;
  try {
    const entries = modelCatalogDb.list().map(toEntry);
    cache = { at: now, entries };
    lastGood = entries;
    return entries;
  } catch (error) {
    log.warn('[模型目录] 读库失败,沿用上一次的快照:', error instanceof Error ? error.message : error);
    return lastGood;
  }
};

export const invalidateCatalogCache = (): void => {
  cache = null;
  subagentPolicyCache = undefined;
};

/* ------------------------- 子代理模型 ------------------------- */

/**
 * 子代理用哪个模型。
 *
 * CLI 的默认:内置子代理(Explore / general-purpose)都是 `model: "inherit"`,跟主模型走;主模型派活时
 * 也可以在 Agent 工具里点名 `sonnet / opus / haiku / fable`(只收这四个别名),再经 settings.json 的映射落到网关模型。
 * 想固定用目录里某个模型:`CLAUDE_CODE_SUBAGENT_MODEL=<模型名>` 设成子代理的默认模型(不限别名);再加
 * `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` 则一律用它,点名的别名、agent 定义里写的 model 都不算(需要 CLI ≥ 2.1.251)。
 * 两个都是进程环境变量,起进程时生效,所以进 runtime 签名,改了之后下一条消息重建。
 *
 * 存 `app_config`(全局一份,root 在 设置 → 模型 里改);没设 = 跟随主模型。
 */
export const SUBAGENT_POLICY_KEY = 'claude_subagent_model';
export type SubagentModelPolicy = { model: string | null; force: boolean };
let subagentPolicyCache: SubagentModelPolicy | undefined;

export function readSubagentPolicy(): SubagentModelPolicy {
  if (subagentPolicyCache) return subagentPolicyCache;
  let policy: SubagentModelPolicy = { model: null, force: false };
  try {
    const raw = appConfigDb.get(SUBAGENT_POLICY_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SubagentModelPolicy>;
      const model = typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model.trim() : null;
      policy = { model, force: Boolean(model) && parsed.force === true };
    }
  } catch {
    // 坏数据按"跟随主模型"
  }
  subagentPolicyCache = policy;
  return policy;
}

/**
 * 给 SDK 的 env(没设就一个都不写,CLI 默认 inherit)。目录里下架了 → 也不写(别让子代理打到下架的模型上)。
 *
 * 给了 `scope` 时再按这一轮的人和网关筛两道:
 * - 子代理模型对这个人不可见(「可用人员」没他)→ 不写,跟随主模型;
 * - 子代理模型走的网关 ≠ 主模型的网关 → 不写:一个 CLI 进程同一时刻只有一套网关地址与 key,
 *   子代理打到另一个网关的模型名上只会 404。
 */
export function subagentModelEnv(
  policy: SubagentModelPolicy = readSubagentPolicy(),
  scope?: { viewer?: ModelViewer | null; gatewayId?: number },
): Record<string, string | undefined> {
  if (!policy.model) return {};
  if (!isModelAlias(policy.model)) {
    const entry = loadEntries().find((candidate) => candidate.modelId === policy.model);
    if (!entry?.enabled) return {};
    if (scope?.viewer && !entryVisibleTo(entry, scope.viewer)) return {};
    if (scope && scope.gatewayId !== undefined && entry.gatewayId !== scope.gatewayId) return {};
  } else if (scope && scope.gatewayId !== undefined && scope.gatewayId !== 0) {
    // 别名经 settings.json 的映射落到默认网关的模型 —— 主模型在别的网关上时同样不写
    return {};
  }
  return {
    CLAUDE_CODE_SUBAGENT_MODEL: policy.model,
    ...(policy.force ? { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' } : {}),
  };
}

/* ------------------------------ 查询 ------------------------------ */

const sortEntries = (entries: CatalogEntry[]): CatalogEntry[] =>
  [...entries].sort((a, b) => (a.sortOrder - b.sortOrder) || (a.id - b.id));

export const claudeModelCatalog = {
  listAll(): CatalogEntry[] {
    return sortEntries(loadEntries());
  },

  listEnabled(): CatalogEntry[] {
    return this.listAll().filter((entry) => entry.enabled);
  },

  /** 按网关模型名查目录条目(上不上架都返回;不看人、不含私有模型)。 */
  lookup(modelId: string | null | undefined): CatalogEntry | null {
    const name = typeof modelId === 'string' ? modelId.trim() : '';
    if (!name) return null;
    return loadEntries().find((entry) => entry.modelId === name) ?? null;
  },

  /**
   * 按人查:先看这个人能用的私有模型,再看目录(上不上架都返回,可见性不在这里判)。
   * 同名时私有的优先:本人在自己的网关上配了同名模型,意思就是"我用我自己的那个"。
   */
  lookupFor(modelId: string | null | undefined, viewer?: ModelViewer | null): CatalogEntry | null {
    const name = typeof modelId === 'string' ? modelId.trim() : '';
    if (!name) return null;
    if (viewer?.userId) {
      const own = privateEntriesFor(viewer.userId).find((entry) => entry.modelId === name);
      if (own) return own;
    }
    return this.lookup(name);
  },

  get(id: number): CatalogEntry | null {
    return loadEntries().find((entry) => entry.id === id) ?? null;
  },

  /**
   * 能不能拿这个模型发一轮:别名组 / 空(= default)/ 目录里上架的。
   * 给了 viewer 就按人:「可用人员」里没他的不行;他自己的私有模型可以。
   */
  isAllowed(model: string | null | undefined, viewer?: ModelViewer | null): boolean {
    if (isModelAlias(model)) return true;
    const entry = this.lookupFor(model, viewer);
    if (!entry?.enabled) return false;
    return entry.ownerUserId !== null || entryVisibleTo(entry, viewer);
  },

  /** 闸口:不允许就抛 ModelNotAllowedError(400 MODEL_NOT_ALLOWED)。 */
  assertAllowed(model: string | null | undefined, viewer?: ModelViewer | null): void {
    if (!this.isAllowed(model, viewer)) throw new ModelNotAllowedError(String(model));
  },

  /**
   * 连别名一起判的闸口:`isAllowed` 对别名一律放行(同步、读不了映射);
   * 别名映射到的目录模型限了人、这个人不在名单里 → 也不许(否则选择器里看不到的模型能经别名直通)。
   * 发起回合的所有入口(回合本身、/compact 回落、一次性预检、预热、定时任务的模型回落)都用这一个。
   */
  async isUsable(model: string | null | undefined, viewer?: ModelViewer | null): Promise<boolean> {
    if (!this.isAllowed(model, viewer)) return false;
    if (!viewer || !isModelAlias(model)) return true;
    const { entry } = await this.resolveEntry(model, viewer).catch(() => ({ entry: null }));
    return !entry || entryVisibleTo(entry, viewer);
  },

  async assertUsable(model: string | null | undefined, viewer?: ModelViewer | null): Promise<void> {
    if (!this.isAllowed(model, viewer)) throw new ModelNotAllowedError(String(model));
    if (!(await this.isUsable(model, viewer))) {
      const name = String(model || 'default');
      throw new ModelNotAllowedError(name, `「${name}」映射到的模型限定了可用人员,你不在名单里 —— 在 /models 里另选一个模型。`);
    }
  },

  /**
   * 新会话默认用哪个:`is_default` 那条(上架的)→ 第一条上架的推荐条目 → 别名 `default`。
   * 给了 viewer 就只在他看得见的里面挑(默认那条限了人、他不在名单里 → 往下找)。
   */
  defaultModel(viewer?: ModelViewer | null): string {
    const enabled = this.listEnabled().filter((entry) => entryVisibleTo(entry, viewer));
    const explicit = enabled.find((entry) => entry.isDefault);
    if (explicit) return explicit.modelId;
    const recommended = enabled.find((entry) => entry.recommended);
    return recommended?.modelId ?? CLAUDE_FALLBACK_MODELS.DEFAULT;
  },

  /**
   * 别名先换成真名再查目录:存量会话、定时任务、子代理大多用别名,
   * 生产里它们映射到的正是目录里的网关模型(sonnet → deepseek / kimi 之类)。解析链与 CLI 一致:
   * 别名 → `ANTHROPIC_DEFAULT_*_MODEL`;`default` → settings `"model"` →(再经别名一层)→ `ANTHROPIC_MODEL`。
   * 真名按人查(私有模型优先);别名只映射到目录条目(别名属于 settings.json 那一套网关)。
   */
  async resolveEntry(model: string | null | undefined, viewer?: ModelViewer | null): Promise<{ realModel: string | null; entry: CatalogEntry | null }> {
    const name = typeof model === 'string' ? model.trim() : '';
    let realModel: string | null = name || null;
    if (isModelAlias(name)) {
      const alias = name || 'default';
      try {
        const mappings = await readAliasConfigMappings([alias]);
        realModel = mappings[alias]?.configuredModel ?? null;
      } catch {
        realModel = null;
      }
      return { realModel, entry: realModel ? this.lookup(realModel) : null };
    }
    return { realModel, entry: realModel ? this.lookupFor(realModel, viewer) : null };
  },

  /** 这一轮该给 CLI 的窗口(目录 / 私有模型里填的;没填 / 不在目录里为 null)。 */
  async contextWindowFor(model: string | null | undefined, viewer?: ModelViewer | null): Promise<number | null> {
    const { entry } = await this.resolveEntry(model, viewer);
    return entry?.contextWindow ?? null;
  },

  /**
   * 给 `/models` 与选择器的定义:上架的目录条目 + 别名组(`group: 'alias'`)。
   * 别名组始终在里面:`resolveClaudeEffort` 靠它给别名带档位。
   *
   * 给了 viewer 就按人:目录条目只留他看得见的;他的私有模型排在目录条目前面(`private: true`),
   * 与目录同名的目录条目对他隐去(私有优先,见 lookupFor);DEFAULT 也在他看得见的里面挑。
   * 每条带 `gatewayId`(0 = settings.json 那一套);可不可用(有没有 key)由 claude-gateways.service 再标。
   */
  buildModelsDefinition(viewer?: ModelViewer | null): ProviderModelsDefinition {
    const toOption = (entry: CatalogEntry): ProviderModelOption => ({
      value: entry.modelId,
      label: entry.label,
      ...(entry.description ? { description: entry.description } : {}),
      ...(entry.effortLevels.length > 0
        ? {
            effort: {
              ...(entry.effortDefault ? { default: entry.effortDefault } : {}),
              values: entry.effortLevels.map((value) => ({ value })),
            },
          }
        : {}),
      group: 'catalog',
      vendor: entry.vendor,
      recommended: entry.recommended,
      contextWindow: entry.contextWindow,
      realModel: entry.modelId,
      gatewayId: entry.gatewayId,
      ...(entry.ownerUserId !== null ? { private: true } : {}),
    });
    const privateOptions = viewer?.userId ? privateEntriesFor(viewer.userId).map(toOption) : [];
    const privateNames = new Set(privateOptions.map((option) => option.value));
    const catalogOptions = this.listEnabled()
      .filter((entry) => entryVisibleTo(entry, viewer) && !privateNames.has(entry.modelId))
      .map(toOption);
    const aliasOptions: ProviderModelOption[] = CLAUDE_FALLBACK_MODELS.OPTIONS.map((option) => ({
      ...option,
      group: 'alias',
      gatewayId: 0,
    }));
    return { OPTIONS: [...privateOptions, ...catalogOptions, ...aliasOptions], DEFAULT: this.defaultModel(viewer) };
  },

  create(input: CatalogInput, actorId: number | null): CatalogEntry {
    const write = validateCatalogInput(input, null);
    assertCatalogReferences(write);
    if (modelCatalogDb.getByModelId(write.modelId)) {
      throw new CatalogValidationError('DUPLICATE_MODEL_ID', `目录里已经有「${write.modelId}」了`, 409);
    }
    const row = modelCatalogDb.insert(write, actorId);
    invalidateCatalogCache();
    return toEntry(row);
  },

  update(id: number, input: CatalogInput, actorId: number | null): { before: CatalogEntry; after: CatalogEntry } {
    const row = modelCatalogDb.get(id);
    if (!row) throw new CatalogValidationError('NOT_FOUND', '这条目录条目不存在', 404);
    const before = toEntry(row);
    const write = validateCatalogInput(input, before);
    assertCatalogReferences(write, before);
    const clash = modelCatalogDb.getByModelId(write.modelId);
    if (clash && clash.id !== id) {
      throw new CatalogValidationError('DUPLICATE_MODEL_ID', `目录里已经有「${write.modelId}」了`, 409);
    }
    const updated = modelCatalogDb.update(id, write, actorId);
    invalidateCatalogCache();
    return { before, after: toEntry(updated!) };
  },

  remove(id: number): CatalogEntry | null {
    const row = modelCatalogDb.get(id);
    if (!row) return null;
    modelCatalogDb.remove(id);
    invalidateCatalogCache();
    return toEntry(row);
  },

  /** 子代理模型(见 readSubagentPolicy)。 */
  subagentPolicy(): SubagentModelPolicy {
    return readSubagentPolicy();
  },

  setSubagentPolicy(input: { model?: unknown; force?: unknown }): SubagentModelPolicy {
    const model = typeof input.model === 'string' && input.model.trim() ? input.model.trim() : null;
    if (model && !this.isAllowed(model)) {
      throw new CatalogValidationError('SUBAGENT_MODEL_NOT_ALLOWED', `「${model}」不在模型目录里(或已下架),不能设成子代理模型`);
    }
    const policy: SubagentModelPolicy = { model, force: Boolean(model) && input.force === true };
    appConfigDb.set(SUBAGENT_POLICY_KEY, JSON.stringify(policy));
    subagentPolicyCache = policy;
    return policy;
  },

  setProbe(id: number, probe: CatalogProbeResult): void {
    modelCatalogDb.setProbe(id, probe);
    invalidateCatalogCache();
  },
};

/* ------------------------------ 播种 ------------------------------ */

export const MODEL_CATALOG_SEEDED_KEY = 'model_catalog_seeded_at';

/**
 * 首次启动时按 settings.json 播种:四个 `ANTHROPIC_DEFAULT_*_MODEL` 与顶层 `"model"` 解析出的
 * 不同网关名各一条(label 先等于 id,上架、推荐),`"model"` 那条设默认。
 *
 * 用 `app_config` 里的标记记"播过了",不用"表为空"判断:否则 root 故意清空目录后,
 * 下次重启又被播回来。settings.json 读不到也记标记(root 手动添加即可)。
 */
export async function seedModelCatalogOnce(): Promise<{ seeded: boolean; added: string[] }> {
  if (appConfigDb.get(MODEL_CATALOG_SEEDED_KEY)) return { seeded: false, added: [] };
  const aliases = ['default', 'fable', 'opus', 'sonnet', 'haiku'];
  const mappings = await readAliasConfigMappings(aliases);
  const defaultModel = mappings.default?.configuredModel ?? null;
  const seen = new Set<string>();
  const ordered: Array<{ modelId: string; alias: string }> = [];
  for (const alias of aliases) {
    const real = mappings[alias]?.configuredModel?.trim();
    if (!real || seen.has(real) || ALIAS_SET.has(real) || !isValidModelId(real)) continue;
    seen.add(real);
    ordered.push({ modelId: real, alias });
  }
  /**
   * 档位跟着"第一个映射到它的别名"走:播种前用户选 `default` / `opus` 时有档位 chip,
   * 播种后默认模型换成目录条目,不能因为条目没填档位就让 chip 消失。
   */
  const effortOf = (alias: string): { levels: EffortLevel[] | null; def: EffortLevel | null } => {
    const effort = CLAUDE_FALLBACK_MODELS.OPTIONS.find((option) => option.value === alias)?.effort;
    const levels = (effort?.values ?? [])
      .map((value) => value.value)
      .filter((value): value is EffortLevel => (EFFORT_LEVELS as readonly string[]).includes(value));
    const def = effort?.default && (levels as string[]).includes(effort.default) ? effort.default as EffortLevel : null;
    return { levels: levels.length > 0 ? levels : null, def };
  };
  const added: string[] = [];
  ordered.forEach(({ modelId, alias }, index) => {
    if (modelCatalogDb.getByModelId(modelId)) return;
    const effort = effortOf(alias);
    modelCatalogDb.insert({
      modelId,
      label: modelId,
      vendor: null,
      description: null,
      contextWindow: null,
      effortLevels: effort.levels,
      effortDefault: effort.def,
      recommended: true,
      sortOrder: (index + 1) * 10,
      enabled: true,
      isDefault: modelId === defaultModel,
      gatewayId: null,
      allowedUsers: null,
    }, null);
    added.push(modelId);
  });
  appConfigDb.set(MODEL_CATALOG_SEEDED_KEY, new Date().toISOString());
  invalidateCatalogCache();
  return { seeded: true, added };
}
