import fs from 'node:fs';

import { getConnection } from '@/modules/database/connection.js';

/**
 * 聊天附件台账。
 *
 * 附件本体落在会话所属项目的 `attachments/` 下(没有项目时回落全局目录),
 * 这里只记账。配额与过期清理都只认这张表 —— **清理只删这张表记过的文件**,
 * 用户自己往 `attachments/` 里放的东西一个字节都不碰。
 */

export type AttachmentKind = 'image' | 'file';

export type AttachmentRecord = {
  userId: number | null;
  sessionId: string | null;
  projectPath: string | null;
  kind: AttachmentKind;
  absPath: string;
  bytes: number;
};

type SweepRow = { id: number; abs_path: string };

export const attachmentsDb = {
  /**
   * 记一笔。**永不抛异常** —— 记账失败不该把一次成功的上传变成失败。
   * 同一个绝对路径重复记走 `ON CONFLICT` 更新,不会长出两行。
   */
  record(entry: AttachmentRecord): boolean {
    if (!entry?.absPath) return false;
    try {
      getConnection()
        .prepare(`
          INSERT INTO attachments (user_id, session_id, project_path, kind, abs_path, bytes)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(abs_path) DO UPDATE SET
            bytes = excluded.bytes,
            user_id = excluded.user_id,
            session_id = excluded.session_id,
            project_path = excluded.project_path,
            created_at = CURRENT_TIMESTAMP
        `)
        .run(
          entry.userId ?? null,
          entry.sessionId ?? null,
          entry.projectPath ?? null,
          entry.kind,
          entry.absPath,
          Math.max(0, Math.trunc(entry.bytes) || 0),
        );
      return true;
    } catch (error) {
      console.warn('[attachments] 记账失败:', (error as Error).message);
      return false;
    }
  },

  /** 某个用户当前占用的总字节数。查不到、出错都回 0 —— 配额检查宁可放行。 */
  totalBytesForUser(userId: number | null | undefined): number {
    if (userId == null) return 0;
    try {
      const row = getConnection()
        .prepare('SELECT COALESCE(SUM(bytes), 0) AS total FROM attachments WHERE user_id = ?')
        .get(userId) as { total?: number } | undefined;
      return Number(row?.total) || 0;
    } catch {
      return 0;
    }
  },

  /** 删一行(用户在文件树里把文件删了、或清扫器收尾时调用)。 */
  forget(absPath: string): void {
    try {
      getConnection().prepare('DELETE FROM attachments WHERE abs_path = ?').run(absPath);
    } catch {
      /* 记账表的清理失败不值得打断任何事 */
    }
  },

  /**
   * 删掉某个目录下的所有台账行(用户在文件树里删了整个目录时调用)。
   *
   * 按 `abs_path` 前缀匹配。`dirPath` 末尾补上分隔符再拼 `%`,避免
   * `/a/attachments` 误伤 `/a/attachments-old/x`。LIKE 里的 `%_` 是通配元字符,
   * 但附件绝对路径里不会出现,且这里只删自己记过的行,不做转义也不会越删。
   */
  forgetUnder(dirPath: string): void {
    if (!dirPath) return;
    const prefix = dirPath.endsWith('/') ? dirPath : `${dirPath}/`;
    try {
      getConnection().prepare('DELETE FROM attachments WHERE abs_path LIKE ?').run(`${prefix}%`);
    } catch {
      /* 同上,记账清理失败不打断删除本身 */
    }
  },

  /**
   * 清掉超过 `ttlDays` 天的附件:先删文件,再删行。
   *
   * 文件已经不在了(用户自己删的)也照样把行收走 —— 否则那条行会一直占着配额。
   * 返回删掉的行数与释放的字节数,给调用方打日志用。
   */
  sweepExpired(ttlDays: number): { removed: number; bytes: number } {
    if (!Number.isFinite(ttlDays) || ttlDays <= 0) return { removed: 0, bytes: 0 };
    let removed = 0;
    let bytes = 0;
    try {
      const db = getConnection();
      const rows = db
        .prepare(`
          SELECT id, abs_path, bytes FROM attachments
          WHERE created_at < datetime('now', ?)
        `)
        .all(`-${Math.trunc(ttlDays)} days`) as (SweepRow & { bytes: number })[];

      const forgetOne = db.prepare('DELETE FROM attachments WHERE id = ?');
      for (const row of rows) {
        try {
          fs.rmSync(row.abs_path, { force: true });
        } catch (error) {
          // 删不掉(权限、占用)就把行留着,下一轮再试 —— 删行会让这个文件
          // 永远没人认领,既不占配额也再没人清。
          console.warn('[attachments] 删除过期附件失败,保留台账:', row.abs_path, (error as Error).message);
          continue;
        }
        forgetOne.run(row.id);
        removed += 1;
        bytes += Number(row.bytes) || 0;
      }
    } catch (error) {
      console.warn('[attachments] 过期清理失败:', (error as Error).message);
    }
    return { removed, bytes };
  },
};
