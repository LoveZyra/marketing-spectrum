import { getConnection } from '@/modules/database/connection.js';

/**
 * hn(B1):模型目录(表结构与语义见 `schema.ts` 的 `MODEL_CATALOG_TABLE_SCHEMA_SQL`)。
 *
 * 只做存取;校验、缓存、别名解析、播种在 providers 模块的 claude-model-catalog.service 里。
 * 写入口全是 root 的管理动作(路由里判)。
 */
export type ModelCatalogRow = {
  id: number;
  model_id: string;
  label: string;
  vendor: string | null;
  description: string | null;
  context_window: number | null;
  effort_levels: string | null;
  effort_default: string | null;
  recommended: number;
  sort_order: number;
  enabled: number;
  is_default: number;
  last_probe: string | null;
  created_at: string;
  updated_at: string;
  updated_by: number | null;
  /** hq:走哪个网关;NULL = settings.json 那一套(网关 0)。 */
  gateway_id: number | null;
  /** hq:可用人员(用户 id 的 JSON 数组);NULL = 所有人。 */
  allowed_users: string | null;
};

/** 写入用的形状 —— 已经过服务层校验。 */
export type ModelCatalogWrite = {
  modelId: string;
  label: string;
  vendor: string | null;
  description: string | null;
  contextWindow: number | null;
  effortLevels: string[] | null;
  effortDefault: string | null;
  recommended: boolean;
  sortOrder: number;
  enabled: boolean;
  isDefault: boolean;
  /** hq:null = 网关 0(settings.json)。 */
  gatewayId: number | null;
  /** hq:null = 所有人;数组 = 只有这些用户 id(空数组 = 只有 root)。 */
  allowedUsers: number[] | null;
};

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

const toParams = (input: ModelCatalogWrite) => ({
  model_id: input.modelId,
  label: input.label,
  vendor: input.vendor,
  description: input.description,
  context_window: input.contextWindow,
  effort_levels: input.effortLevels && input.effortLevels.length > 0 ? JSON.stringify(input.effortLevels) : null,
  effort_default: input.effortDefault,
  recommended: input.recommended ? 1 : 0,
  sort_order: input.sortOrder,
  enabled: input.enabled ? 1 : 0,
  is_default: input.isDefault ? 1 : 0,
  gateway_id: input.gatewayId && input.gatewayId > 0 ? input.gatewayId : null,
  allowed_users: input.allowedUsers ? JSON.stringify(input.allowedUsers) : null,
});

export const modelCatalogDb = {
  list(): ModelCatalogRow[] {
    return getConnection()
      .prepare('SELECT * FROM model_catalog ORDER BY sort_order ASC, id ASC')
      .all() as ModelCatalogRow[];
  },

  get(id: number): ModelCatalogRow | null {
    return (getConnection().prepare('SELECT * FROM model_catalog WHERE id = ?').get(id) as ModelCatalogRow | undefined) ?? null;
  },

  getByModelId(modelId: string): ModelCatalogRow | null {
    return (getConnection().prepare('SELECT * FROM model_catalog WHERE model_id = ?').get(modelId) as ModelCatalogRow | undefined) ?? null;
  },

  /** 新建一条;`isDefault` 为真时同一个事务里把别的默认清掉(部分唯一索引只许一条)。 */
  insert(input: ModelCatalogWrite, updatedBy: number | null): ModelCatalogRow {
    const db = getConnection();
    const run = db.transaction(() => {
      if (input.isDefault) db.prepare('UPDATE model_catalog SET is_default = 0 WHERE is_default = 1').run();
      const params = { ...toParams(input), updated_by: updatedBy, now: nowIso() };
      const result = db.prepare(`
        INSERT INTO model_catalog (model_id, label, vendor, description, context_window, effort_levels, effort_default,
          recommended, sort_order, enabled, is_default, created_at, updated_at, updated_by, gateway_id, allowed_users)
        VALUES (@model_id, @label, @vendor, @description, @context_window, @effort_levels, @effort_default,
          @recommended, @sort_order, @enabled, @is_default, @now, @now, @updated_by, @gateway_id, @allowed_users)
      `).run(params);
      return Number(result.lastInsertRowid);
    });
    return this.get(run())!;
  },

  /** 整行覆盖(服务层先合并好再调);`isDefault` 同上。 */
  update(id: number, input: ModelCatalogWrite, updatedBy: number | null): ModelCatalogRow | null {
    const db = getConnection();
    const run = db.transaction(() => {
      if (input.isDefault) db.prepare('UPDATE model_catalog SET is_default = 0 WHERE is_default = 1 AND id <> ?').run(id);
      const params = { ...toParams(input), id, updated_by: updatedBy, now: nowIso() };
      return db.prepare(`
        UPDATE model_catalog SET model_id = @model_id, label = @label, vendor = @vendor, description = @description,
          context_window = @context_window, effort_levels = @effort_levels, effort_default = @effort_default,
          recommended = @recommended, sort_order = @sort_order, enabled = @enabled, is_default = @is_default,
          gateway_id = @gateway_id, allowed_users = @allowed_users,
          updated_at = @now, updated_by = @updated_by
        WHERE id = @id
      `).run(params).changes;
    });
    return run() > 0 ? this.get(id) : null;
  },

  remove(id: number): boolean {
    return getConnection().prepare('DELETE FROM model_catalog WHERE id = ?').run(id).changes > 0;
  },

  /** 「实测」结果单独写,不动 updated_at / updated_by(那两个记的是人的编辑)。 */
  setProbe(id: number, probe: unknown): void {
    getConnection().prepare('UPDATE model_catalog SET last_probe = ? WHERE id = ?').run(JSON.stringify(probe), id);
  },

  /** hq:挂在某个网关上的目录条目数(删网关前要看)。 */
  countByGateway(gatewayId: number): number {
    return (getConnection().prepare('SELECT COUNT(*) AS c FROM model_catalog WHERE gateway_id = ?').get(gatewayId) as { c: number }).c;
  },

  count(): number {
    return (getConnection().prepare('SELECT COUNT(*) AS c FROM model_catalog').get() as { c: number }).c;
  },
};
