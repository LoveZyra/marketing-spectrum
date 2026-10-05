import { getConnection } from '@/modules/database/connection.js';
import { appConfigDb } from '@/modules/database/repositories/app-config.js';
import { decrypt, encrypt, getEncryptionKey } from '@/shared/crypto-box.js';

/**
 * hq:**模型网关 / 个人 key / 私有模型**(表结构见 schema.ts 的三张 hq 表)。
 *
 * 只做存取 + 加解密;校验、解析、权限在 providers 模块的 claude-gateways.service 里。
 *
 * **key 只以密文落库**(与 user_credentials 同一把 AES 密钥,见 shared/crypto-box.js)。
 * 读接口分两类:`list*` / `get*` 返回的行**不带明文**;明文只有 `read*Key` 两个函数给,
 * 调用方只有「这一轮该用哪把 key」那一处(claude-gateways.service 的 resolveTurnGateway)和「测试连接」。
 */

const ENCRYPTION_KEY_CONFIG = 'credential_encryption_key';

function aesKey(): Buffer {
  return getEncryptionKey({
    loadPersistedKey: () => appConfigDb.get(ENCRYPTION_KEY_CONFIG),
    savePersistedKey: (hex: string) => appConfigDb.set(ENCRYPTION_KEY_CONFIG, hex),
  });
}

const last4 = (value: string): string => value.slice(-4);
const nowSql = () => new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');

export type ModelGatewayRow = {
  id: number;
  name: string;
  base_url: string;
  auth_type: string;
  /** 只告诉调用方"有没有";密文本身不出这个文件。 */
  has_default_key: number;
  default_key_last4: string | null;
  owner_user_id: number | null;
  enabled: number;
  created_at: string;
  updated_at: string;
  updated_by: number | null;
};

export type ModelGatewayWrite = {
  name: string;
  baseUrl: string;
  authType: 'bearer' | 'x-api-key';
  enabled: boolean;
};

export type GatewayUserKeyRow = {
  gateway_id: number;
  user_id: number;
  username: string | null;
  key_last4: string | null;
  set_by: number | null;
  set_by_username: string | null;
  updated_at: string;
};

export type UserModelRow = {
  id: number;
  user_id: number;
  gateway_id: number;
  model_id: string;
  label: string;
  vendor: string | null;
  context_window: number | null;
  effort_levels: string | null;
  effort_default: string | null;
  enabled: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export type UserModelWrite = {
  gatewayId: number;
  modelId: string;
  label: string;
  vendor: string | null;
  contextWindow: number | null;
  effortLevels: string[] | null;
  effortDefault: string | null;
  enabled: boolean;
  sortOrder: number;
};

const GATEWAY_COLUMNS = `id, name, base_url, auth_type, (default_key IS NOT NULL) AS has_default_key, default_key_last4,
  owner_user_id, enabled, created_at, updated_at, updated_by`;

export const modelGatewaysDb = {
  /** 全部网关(共享 + 所有人的私有)。只给 root 的管理页与解析用。 */
  listAll(): ModelGatewayRow[] {
    return getConnection()
      .prepare(`SELECT ${GATEWAY_COLUMNS} FROM model_gateways ORDER BY owner_user_id IS NOT NULL, id`)
      .all() as ModelGatewayRow[];
  },

  listShared(): ModelGatewayRow[] {
    return getConnection()
      .prepare(`SELECT ${GATEWAY_COLUMNS} FROM model_gateways WHERE owner_user_id IS NULL ORDER BY id`)
      .all() as ModelGatewayRow[];
  },

  listOwnedBy(userId: number): ModelGatewayRow[] {
    return getConnection()
      .prepare(`SELECT ${GATEWAY_COLUMNS} FROM model_gateways WHERE owner_user_id = ? ORDER BY id`)
      .all(userId) as ModelGatewayRow[];
  },

  get(id: number): ModelGatewayRow | null {
    return (getConnection()
      .prepare(`SELECT ${GATEWAY_COLUMNS} FROM model_gateways WHERE id = ?`)
      .get(id) as ModelGatewayRow | undefined) ?? null;
  },

  /** 同一归属(共享 / 某人的私有)下按名字查重。 */
  findByName(name: string, ownerUserId: number | null): ModelGatewayRow | null {
    const sql = ownerUserId === null
      ? `SELECT ${GATEWAY_COLUMNS} FROM model_gateways WHERE owner_user_id IS NULL AND name = ? COLLATE NOCASE`
      : `SELECT ${GATEWAY_COLUMNS} FROM model_gateways WHERE owner_user_id = ? AND name = ? COLLATE NOCASE`;
    const params = ownerUserId === null ? [name] : [ownerUserId, name];
    return (getConnection().prepare(sql).get(...params) as ModelGatewayRow | undefined) ?? null;
  },

  insert(input: ModelGatewayWrite, ownerUserId: number | null, updatedBy: number | null): ModelGatewayRow {
    const result = getConnection().prepare(`
      INSERT INTO model_gateways (name, base_url, auth_type, owner_user_id, enabled, created_at, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.name, input.baseUrl, input.authType, ownerUserId, input.enabled ? 1 : 0, nowSql(), nowSql(), updatedBy);
    return this.get(Number(result.lastInsertRowid))!;
  },

  update(id: number, input: ModelGatewayWrite, updatedBy: number | null): ModelGatewayRow | null {
    const changes = getConnection().prepare(`
      UPDATE model_gateways SET name = ?, base_url = ?, auth_type = ?, enabled = ?, updated_at = ?, updated_by = ? WHERE id = ?
    `).run(input.name, input.baseUrl, input.authType, input.enabled ? 1 : 0, nowSql(), updatedBy, id).changes;
    return changes > 0 ? this.get(id) : null;
  },

  /** null = 清掉默认 key。 */
  setDefaultKey(id: number, key: string | null, updatedBy: number | null): void {
    getConnection().prepare(`
      UPDATE model_gateways SET default_key = ?, default_key_last4 = ?, updated_at = ?, updated_by = ? WHERE id = ?
    `).run(key ? encrypt(key, aesKey()) : null, key ? last4(key) : null, nowSql(), updatedBy, id);
  },

  /** 明文默认 key(没有为 null)。只给解析与测试连接用。 */
  readDefaultKey(id: number): string | null {
    const row = getConnection().prepare('SELECT default_key FROM model_gateways WHERE id = ?').get(id) as { default_key: string | null } | undefined;
    if (!row?.default_key) return null;
    return decrypt(row.default_key, aesKey());
  },

  /** 删网关:连同它上面的个人 key、私有模型一起删(一个事务)。目录条目是否还挂着由服务层先判。 */
  remove(id: number): boolean {
    const db = getConnection();
    return db.transaction(() => {
      db.prepare('DELETE FROM gateway_user_keys WHERE gateway_id = ?').run(id);
      db.prepare('DELETE FROM user_models WHERE gateway_id = ?').run(id);
      return db.prepare('DELETE FROM model_gateways WHERE id = ?').run(id).changes > 0;
    })();
  },
};

export const gatewayUserKeysDb = {
  /** 某个网关上谁填了 key(不带明文)。 */
  listForGateway(gatewayId: number): GatewayUserKeyRow[] {
    return getConnection().prepare(`
      SELECT k.gateway_id, k.user_id, u.username AS username, k.key_last4, k.set_by, s.username AS set_by_username, k.updated_at
      FROM gateway_user_keys k
      LEFT JOIN users u ON u.id = k.user_id
      LEFT JOIN users s ON s.id = k.set_by
      WHERE k.gateway_id = ?
      ORDER BY u.username COLLATE NOCASE
    `).all(gatewayId) as GatewayUserKeyRow[];
  },

  /** 某个人在各网关上的 key(不带明文)。 */
  listForUser(userId: number): GatewayUserKeyRow[] {
    return getConnection().prepare(`
      SELECT k.gateway_id, k.user_id, u.username AS username, k.key_last4, k.set_by, s.username AS set_by_username, k.updated_at
      FROM gateway_user_keys k
      LEFT JOIN users u ON u.id = k.user_id
      LEFT JOIN users s ON s.id = k.set_by
      WHERE k.user_id = ?
      ORDER BY k.gateway_id
    `).all(userId) as GatewayUserKeyRow[];
  },

  has(gatewayId: number, userId: number): boolean {
    return Boolean(getConnection().prepare('SELECT 1 FROM gateway_user_keys WHERE gateway_id = ? AND user_id = ?').get(gatewayId, userId));
  },

  upsert(gatewayId: number, userId: number, key: string, setBy: number | null): void {
    getConnection().prepare(`
      INSERT INTO gateway_user_keys (gateway_id, user_id, key_enc, key_last4, set_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(gateway_id, user_id) DO UPDATE SET
        key_enc = excluded.key_enc, key_last4 = excluded.key_last4, set_by = excluded.set_by, updated_at = excluded.updated_at
    `).run(gatewayId, userId, encrypt(key, aesKey()), last4(key), setBy, nowSql());
  },

  remove(gatewayId: number, userId: number): boolean {
    return getConnection().prepare('DELETE FROM gateway_user_keys WHERE gateway_id = ? AND user_id = ?').run(gatewayId, userId).changes > 0;
  },

  /** 明文个人 key(没有为 null)。只给解析与测试连接用。 */
  readKey(gatewayId: number, userId: number): string | null {
    const row = getConnection()
      .prepare('SELECT key_enc FROM gateway_user_keys WHERE gateway_id = ? AND user_id = ?')
      .get(gatewayId, userId) as { key_enc: string } | undefined;
    if (!row?.key_enc) return null;
    return decrypt(row.key_enc, aesKey());
  },
};

const userModelParams = (input: UserModelWrite) => ({
  gateway_id: input.gatewayId,
  model_id: input.modelId,
  label: input.label,
  vendor: input.vendor,
  context_window: input.contextWindow,
  effort_levels: input.effortLevels && input.effortLevels.length > 0 ? JSON.stringify(input.effortLevels) : null,
  effort_default: input.effortDefault,
  enabled: input.enabled ? 1 : 0,
  sort_order: input.sortOrder,
});

export const userModelsDb = {
  listAll(): UserModelRow[] {
    return getConnection().prepare('SELECT * FROM user_models ORDER BY user_id, sort_order, id').all() as UserModelRow[];
  },

  listForUser(userId: number): UserModelRow[] {
    return getConnection()
      .prepare('SELECT * FROM user_models WHERE user_id = ? ORDER BY sort_order, id')
      .all(userId) as UserModelRow[];
  },

  get(id: number): UserModelRow | null {
    return (getConnection().prepare('SELECT * FROM user_models WHERE id = ?').get(id) as UserModelRow | undefined) ?? null;
  },

  findForUser(userId: number, modelId: string): UserModelRow | null {
    return (getConnection()
      .prepare('SELECT * FROM user_models WHERE user_id = ? AND model_id = ?')
      .get(userId, modelId) as UserModelRow | undefined) ?? null;
  },

  insert(userId: number, input: UserModelWrite): UserModelRow {
    const params = { ...userModelParams(input), user_id: userId, now: nowSql() };
    const result = getConnection().prepare(`
      INSERT INTO user_models (user_id, gateway_id, model_id, label, vendor, context_window, effort_levels, effort_default,
        enabled, sort_order, created_at, updated_at)
      VALUES (@user_id, @gateway_id, @model_id, @label, @vendor, @context_window, @effort_levels, @effort_default,
        @enabled, @sort_order, @now, @now)
    `).run(params);
    return this.get(Number(result.lastInsertRowid))!;
  },

  update(id: number, input: UserModelWrite): UserModelRow | null {
    const params = { ...userModelParams(input), id, now: nowSql() };
    const changes = getConnection().prepare(`
      UPDATE user_models SET gateway_id = @gateway_id, model_id = @model_id, label = @label, vendor = @vendor,
        context_window = @context_window, effort_levels = @effort_levels, effort_default = @effort_default,
        enabled = @enabled, sort_order = @sort_order, updated_at = @now
      WHERE id = @id
    `).run(params).changes;
    return changes > 0 ? this.get(id) : null;
  },

  remove(id: number): boolean {
    return getConnection().prepare('DELETE FROM user_models WHERE id = ?').run(id).changes > 0;
  },

  countByGateway(gatewayId: number): number {
    return (getConnection().prepare('SELECT COUNT(*) AS c FROM user_models WHERE gateway_id = ?').get(gatewayId) as { c: number }).c;
  },
};
