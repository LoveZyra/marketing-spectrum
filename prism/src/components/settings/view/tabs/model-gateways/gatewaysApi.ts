import { authenticatedFetch } from '../../../../../utils/api';
import {
  CatalogApiError,
  MODEL_CATALOG_CHANGED_EVENT,
  type CatalogEntry,
  type CatalogInput,
  type CatalogProbeResult,
} from '../model-catalog/modelCatalogApi';

/**
 * hq:模型网关与 key 的前端接口 —— 与服务端 `claude-gateways.routes.ts` 一一对应。
 *
 * - `gatewaysAdminApi`(root):共享网关增删改、默认 key、替人填 key、私有网关总开关;
 * - `myGatewaysApi`(任何登录用户):自己的个人 key、私有网关、私有模型。
 *
 * **key 只进不出**:请求里会带明文 key(PUT / 测试),响应里最多是末四位。
 * 任何改动都广播 `MODEL_CATALOG_CHANGED_EVENT` —— 对话页的模型选择器据此重拉(哪些模型能用变了);
 * root 的网关改动另外广播 `MODEL_GATEWAYS_CHANGED_EVENT`,让模型目录里的「网关」下拉跟着刷新。
 */

export type GatewayAuthType = 'bearer' | 'x-api-key';
export const GATEWAY_AUTH_TYPES: readonly GatewayAuthType[] = ['bearer', 'x-api-key'];

export type GatewayScope = 'default' | 'shared' | 'private';

export type GatewayView = {
  /** 0 = 默认网关(settings.json) */
  id: number;
  scope: GatewayScope;
  name: string;
  /** 完整地址只给 root(共享)/ 主人(私有);其他人为 null */
  baseUrl: string | null;
  host: string | null;
  authType: GatewayAuthType;
  /** 默认网关:settings.json 里有 token;私有网关:主人填了 key */
  hasDefaultKey: boolean;
  defaultKeyLast4: string | null;
  enabled: boolean;
  ownerUserId: number | null;
  ownerUsername: string | null;
  modelCount: number;
  updatedAt: string | null;
};

/** 这个人的回合在这个网关上用哪把 key。 */
export type KeySource = 'personal' | 'gateway_default' | 'settings' | 'none';

export type MyGatewayView = GatewayView & {
  source: KeySource;
  personalLast4: string | null;
  /** 谁填的我的个人 key(我自己或 root)—— 用户名 */
  personalSetBy: string | null;
  /** 默认 + 共享为 true;私有网关为 false(它的 key 走 private-key 接口) */
  canSetPersonalKey: boolean;
  models: Array<{ modelId: string; label: string }>;
};

export type GatewayTestResult = {
  ok: boolean;
  status: number | null;
  latencyMs: number;
  modelCount: number | null;
  sampleModels: string[];
  error: string | null;
};

export type GatewayKeyHolder = {
  userId: number;
  username: string;
  keyLast4: string | null;
  setBy: string | null;
  updatedAt: string | null;
};

export type BasicUser = { id: number; username: string };

export type AdminGatewaysPayload = {
  defaultGateway: GatewayView;
  gateways: GatewayView[];
  privateGateways: GatewayView[];
  allowPrivate: boolean;
  users: BasicUser[];
};

export type MyGatewaysPayload = {
  gateways: MyGatewayView[];
  /** 我的私有模型(与目录条目同形) */
  models: CatalogEntry[];
  allowPrivate: boolean;
};

export type GatewayInput = {
  name?: string;
  baseUrl?: string;
  authType?: GatewayAuthType;
  enabled?: boolean;
};

export type UnsavedGatewayTest = { baseUrl: string; authType: GatewayAuthType; key: string };

const BASE = '/api/providers/claude';

/** root 的网关列表变了(增删改 / 开关)—— 模型目录的「网关」下拉据此重拉。 */
export const MODEL_GATEWAYS_CHANGED_EVENT = 'prism:model-gateways-changed';

const dispatch = (name: string) => {
  try {
    window.dispatchEvent(new CustomEvent(name));
  } catch {
    // 非浏览器环境(测试)忽略
  }
};

/** 模型能不能用变了 → 对话页重拉选择器。 */
const announceModels = () => dispatch(MODEL_CATALOG_CHANGED_EVENT);
/** 共享网关本身变了 → 目录的网关下拉也重拉(同时也影响能不能用)。 */
const announceGateways = () => {
  dispatch(MODEL_GATEWAYS_CHANGED_EVENT);
  announceModels();
};

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await authenticatedFetch(url, init);
  const body = (await response.json().catch(() => ({}))) as { success?: boolean; data?: T; error?: unknown; code?: unknown };
  if (!response.ok || !body.data) {
    throw new CatalogApiError(
      typeof body.error === 'string' && body.error ? body.error : `HTTP ${response.status}`,
      response.status,
      typeof body.code === 'string' && body.code ? body.code : null,
    );
  }
  return body.data;
}

const send = (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', body?: unknown): RequestInit => (
  body === undefined ? { method } : { method, body: JSON.stringify(body) }
);

/** 测试时 key 留空 = 用"现在会用的那把";有值才放进请求体。 */
const testBody = (key?: string) => (key && key.trim() ? { key: key.trim() } : {});

export const gatewaysAdminApi = {
  list: (): Promise<AdminGatewaysPayload> => call<AdminGatewaysPayload>(`${BASE}/gateways`),

  create: async (input: GatewayInput & { defaultKey?: string }): Promise<GatewayView> => {
    const { gateway } = await call<{ gateway: GatewayView }>(`${BASE}/gateways`, send('POST', input));
    announceGateways();
    return gateway;
  },

  update: async (id: number, input: GatewayInput): Promise<GatewayView> => {
    const { gateway } = await call<{ gateway: GatewayView }>(`${BASE}/gateways/${id}`, send('PATCH', input));
    announceGateways();
    return gateway;
  },

  remove: async (id: number): Promise<void> => {
    await call<{ removed: number }>(`${BASE}/gateways/${id}`, send('DELETE'));
    announceGateways();
  },

  setDefaultKey: async (id: number, key: string): Promise<GatewayView> => {
    const { gateway } = await call<{ gateway: GatewayView }>(`${BASE}/gateways/${id}/default-key`, send('PUT', { key: key.trim() }));
    announceGateways();
    return gateway;
  },

  clearDefaultKey: async (id: number): Promise<GatewayView> => {
    const { gateway } = await call<{ gateway: GatewayView }>(`${BASE}/gateways/${id}/default-key`, send('DELETE'));
    announceGateways();
    return gateway;
  },

  /** id 0 = 默认网关。不给 key → 用 root 自己会用的那把。 */
  test: async (id: number, key?: string): Promise<GatewayTestResult> =>
    (await call<{ result: GatewayTestResult }>(`${BASE}/gateways/${id}/test`, send('POST', testBody(key)))).result,

  /** 还没保存的网关(普通用户在允许私有网关时也能用)。 */
  testUnsaved: async (input: UnsavedGatewayTest): Promise<GatewayTestResult> =>
    (await call<{ result: GatewayTestResult }>(`${BASE}/gateways-test`, send('POST', { ...input, key: input.key.trim() }))).result,

  keys: async (id: number): Promise<GatewayKeyHolder[]> =>
    (await call<{ keys: GatewayKeyHolder[] }>(`${BASE}/gateways/${id}/keys`)).keys,

  setMemberKey: async (id: number, userId: number, key: string): Promise<GatewayKeyHolder[]> => {
    const { keys } = await call<{ keys: GatewayKeyHolder[] }>(`${BASE}/gateways/${id}/keys/${userId}`, send('PUT', { key: key.trim() }));
    announceModels();
    return keys;
  },

  clearMemberKey: async (id: number, userId: number): Promise<GatewayKeyHolder[]> => {
    const { keys } = await call<{ keys: GatewayKeyHolder[] }>(`${BASE}/gateways/${id}/keys/${userId}`, send('DELETE'));
    announceModels();
    return keys;
  },

  setAllowPrivate: async (allowPrivate: boolean): Promise<boolean> => {
    const result = await call<{ allowPrivate: boolean }>(`${BASE}/gateways-settings`, send('PUT', { allowPrivate }));
    announceModels();
    return result.allowPrivate;
  },
};

export const myGatewaysApi = {
  list: (): Promise<MyGatewaysPayload> => call<MyGatewaysPayload>(`${BASE}/my-gateways`),

  /** 我在默认网关 / 共享网关上的个人 key。 */
  setKey: async (id: number, key: string): Promise<MyGatewayView[]> => {
    const { gateways } = await call<{ gateways: MyGatewayView[] }>(`${BASE}/my-gateways/${id}/key`, send('PUT', { key: key.trim() }));
    announceModels();
    return gateways;
  },

  clearKey: async (id: number): Promise<MyGatewayView[]> => {
    const { gateways } = await call<{ gateways: MyGatewayView[] }>(`${BASE}/my-gateways/${id}/key`, send('DELETE'));
    announceModels();
    return gateways;
  },

  /** 带 key 测这把;不带测我现在会用的那把。 */
  test: async (id: number, key?: string): Promise<GatewayTestResult> =>
    (await call<{ result: GatewayTestResult }>(`${BASE}/my-gateways/${id}/test`, send('POST', testBody(key)))).result,

  createPrivate: async (input: GatewayInput & { key?: string }): Promise<MyGatewayView[]> => {
    const { gateways } = await call<{ gateway: GatewayView; gateways: MyGatewayView[] }>(`${BASE}/my-gateways`, send('POST', input));
    announceModels();
    return gateways;
  },

  updatePrivate: async (id: number, input: GatewayInput): Promise<MyGatewayView[]> => {
    const { gateways } = await call<{ gateway: GatewayView; gateways: MyGatewayView[] }>(`${BASE}/my-gateways/${id}`, send('PATCH', input));
    announceModels();
    return gateways;
  },

  /** 空串 / null 清掉。 */
  setPrivateKey: async (id: number, key: string | null): Promise<MyGatewayView[]> => {
    const { gateways } = await call<{ gateway: GatewayView; gateways: MyGatewayView[] }>(
      `${BASE}/my-gateways/${id}/private-key`,
      send('PUT', { key: key === null ? null : key.trim() }),
    );
    announceModels();
    return gateways;
  },

  /** 连同挂在上面的私有模型一起删。 */
  removePrivate: async (id: number): Promise<{ gateways: MyGatewayView[]; models: CatalogEntry[] }> => {
    const result = await call<{ removed: number; gateways: MyGatewayView[]; models: CatalogEntry[] }>(`${BASE}/my-gateways/${id}`, send('DELETE'));
    announceModels();
    return { gateways: result.gateways, models: result.models };
  },

  createModel: async (input: CatalogInput): Promise<CatalogEntry[]> => {
    const { models } = await call<{ model: CatalogEntry; models: CatalogEntry[] }>(`${BASE}/my-models`, send('POST', input));
    announceModels();
    return models;
  },

  updateModel: async (id: number, input: CatalogInput): Promise<CatalogEntry[]> => {
    const { models } = await call<{ model: CatalogEntry; models: CatalogEntry[] }>(`${BASE}/my-models/${id}`, send('PATCH', input));
    announceModels();
    return models;
  },

  removeModel: async (id: number): Promise<CatalogEntry[]> => {
    const { models } = await call<{ removed: number; models: CatalogEntry[] }>(`${BASE}/my-models/${id}`, send('DELETE'));
    announceModels();
    return models;
  },

  /** 实测(不落库,只回给本人)。 */
  probeModel: async (id: number): Promise<CatalogProbeResult> =>
    (await call<{ probe: CatalogProbeResult }>(`${BASE}/my-models/${id}/probe`, send('POST'))).probe,
};

export const errorMessage = (caught: unknown): string => (caught instanceof Error ? caught.message : String(caught));
