import { authenticatedFetch } from '../../../../../utils/api';

/**
 * hn(B1/B2):模型目录的管理接口(root)—— 与服务端 `provider.routes.ts` 的 `/:provider/model-catalog*` 对应。
 */

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

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
  /** 生效的厂商(手动指定优先,否则自动识别)。 */
  vendor: string | null;
  /** root 手动指定的;null = 自动。 */
  vendorOverride: string | null;
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
  /** hq:走哪个网关;0 = 默认网关(settings.json)。老服务端没有这个字段 → 按 0。 */
  gatewayId?: number;
  /** hq:可用人员(用户 id);null = 所有人(root 始终可用)。 */
  allowedUsers?: number[] | null;
  /** hq:私有模型的主人(目录条目为 null)。 */
  ownerUserId?: number | null;
};

export type CatalogInput = {
  modelId?: string;
  label?: string;
  vendor?: string | null;
  description?: string | null;
  contextWindow?: number | null;
  effortLevels?: EffortLevel[];
  effortDefault?: EffortLevel | null;
  recommended?: boolean;
  sortOrder?: number;
  enabled?: boolean;
  isDefault?: boolean;
  /** hq:0 / null = 默认网关;目录条目只能挂共享网关,私有模型只能挂自己的私有网关。 */
  gatewayId?: number | null;
  /** hq:null = 所有人;数组 = 只有这些用户(目录条目专用)。 */
  allowedUsers?: number[] | null;
};

/** ho:每模型回合健康度(服务端 `model_turn_stats` 汇总;`model` 是网关真名,别名会话记的是它解析到的那个)。 */
export type ModelTurnStats = {
  model: string;
  turns: number;
  errors: number;
  /** 0..1 */
  errorRate: number;
  ttftP50Ms: number | null;
  ttftP90Ms: number | null;
  /** 按次数降序 */
  reasons: Array<{ reason: string; count: number }>;
};

export type ModelStatsReport = { days: number; models: ModelTurnStats[] };

/** ho:子代理模型(全局一份)。model = null → 跟随主模型;force 只在选了模型时有意义。 */
export type SubagentModelPolicy = { model: string | null; force: boolean };

/**
 * 带上服务端的错误码 —— 子代理那张卡要按 `SUBAGENT_MODEL_NOT_ALLOWED` 换成本地化文案;
 * 其余调用方只读 `message`,与原来的 `Error` 等价。
 */
export class CatalogApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = 'CatalogApiError';
    this.status = status;
    this.code = code;
  }
}

const BASE = '/api/providers/claude/model-catalog';

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

/** ho:最近 N 天每模型的回合数 / 失败率 / 失败原因 / 首字延迟(服务端把 N 夹在 1..30)。 */
export async function fetchModelStats(days: number): Promise<ModelStatsReport> {
  return call<ModelStatsReport>(`${BASE}/stats?days=${encodeURIComponent(String(days))}`);
}

/** 目录一变就广播 —— 对话页据此重拉模型列表(选择器、输入框 chip)。 */
export const MODEL_CATALOG_CHANGED_EVENT = 'prism:model-catalog-changed';
const announce = () => {
  try {
    window.dispatchEvent(new CustomEvent(MODEL_CATALOG_CHANGED_EVENT));
  } catch {
    // 非浏览器环境(测试)忽略
  }
};

export const modelCatalogApi = {
  list: async (): Promise<CatalogEntry[]> => (await call<{ entries: CatalogEntry[] }>(BASE)).entries,
  create: async (input: CatalogInput): Promise<CatalogEntry> => {
    const { entry } = await call<{ entry: CatalogEntry }>(BASE, { method: 'POST', body: JSON.stringify(input) });
    announce();
    return entry;
  },
  update: async (id: number, input: CatalogInput): Promise<CatalogEntry> => {
    const { entry } = await call<{ entry: CatalogEntry }>(`${BASE}/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
    announce();
    return entry;
  },
  remove: async (id: number): Promise<void> => {
    await call<{ removed: number }>(`${BASE}/${id}`, { method: 'DELETE' });
    announce();
  },
  probe: async (id: number): Promise<{ entry: CatalogEntry; probe: CatalogProbeResult }> =>
    call<{ entry: CatalogEntry; probe: CatalogProbeResult }>(`${BASE}/${id}/probe`, { method: 'POST' }),
  stats: fetchModelStats,
  /** 子代理模型不进选择器,改了不用广播 MODEL_CATALOG_CHANGED_EVENT。 */
  subagent: async (): Promise<SubagentModelPolicy> =>
    (await call<{ policy: SubagentModelPolicy }>(`${BASE}/subagent`)).policy,
  setSubagent: async (policy: SubagentModelPolicy): Promise<SubagentModelPolicy> =>
    (await call<{ policy: SubagentModelPolicy }>(`${BASE}/subagent`, { method: 'PUT', body: JSON.stringify(policy) })).policy,
};
