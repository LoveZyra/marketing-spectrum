import { getConnection } from '@/modules/database/connection.js';

/**
 * 账号级界面偏好(F11)。
 *
 * 权限清单、项目排序、编辑器偏好此前全在 localStorage —— 换台电脑、换个浏览器、
 * 清一次缓存就全部归零,而这些都是用户一条条调出来的。
 *
 * 存整份 JSON:这些偏好只有"整份读、整份写"一种用法,拆成键值表除了让读写各多
 * 一次 JOIN 之外没有好处,而未来加一项偏好时 blob 不需要迁移。
 *
 * `clientUpdatedAt` 由客户端声明,用来比新旧 —— 离线改过的一侧不该被另一侧的
 * 旧值覆盖。服务端不信任它做任何权限判断,只用来排序。
 */
export type UiSettingsRecord = {
  settings: Record<string, unknown>;
  clientUpdatedAt: string | null;
  updatedAt: string | null;
};

export const uiSettingsDb = {
  get(userId: number): UiSettingsRecord | null {
    const db = getConnection();
    const row = db
      .prepare('SELECT settings_json, client_updated_at, updated_at FROM user_ui_settings WHERE user_id = ?')
      .get(userId) as { settings_json: string; client_updated_at: string | null; updated_at: string | null } | undefined;
    if (!row) return null;

    try {
      const parsed = JSON.parse(row.settings_json) as unknown;
      return {
        settings: parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {},
        clientUpdatedAt: row.client_updated_at,
        updatedAt: row.updated_at,
      };
    } catch {
      // 存进去的不是合法 JSON(不该发生)。当作"没有偏好"而不是让整个设置页报错。
      return null;
    }
  },

  put(userId: number, settings: Record<string, unknown>, clientUpdatedAt: string | null): UiSettingsRecord {
    const db = getConnection();
    const payload = JSON.stringify(settings);
    db.prepare(`
      INSERT INTO user_ui_settings (user_id, settings_json, client_updated_at, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET
        settings_json = excluded.settings_json,
        client_updated_at = excluded.client_updated_at,
        updated_at = CURRENT_TIMESTAMP
    `).run(userId, payload, clientUpdatedAt);

    return { settings, clientUpdatedAt, updatedAt: new Date().toISOString() };
  },
};
