import express from 'express';

import { getConnection } from '@/modules/database/index.js';
import {
  formatBytes,
  getAttachmentQuotaBytes,
  getAttachmentTtlDays,
} from '@/shared/attachment-storage.js';
import { readRequestViewer } from '@/shared/project-visibility.js';

const router = express.Router();

type UsageRow = { kind: string; count: number; bytes: number };
type ProjectRow = { project_path: string | null; count: number; bytes: number };
type SoonRow = { abs_path: string; bytes: number; created_at: string };

/**
 * 「我的附件占了多少」。
 *
 * 配额是按用户算的,所以用户得看得见自己占了多少、都占在哪儿、以及**哪些快到期了**
 * —— 只给一个总数,超限时用户除了发牢骚做不了别的。这里按类型、按项目各切一份,
 * 再列出最近就要被清掉的几个,让"该删哪个"有据可依。
 */
router.get('/usage', (req, res) => {
  const viewer = readRequestViewer(req);
  // F6:配额可以按账号覆盖,所以这里必须带 userId 去问 —— 否则用户看到的是
  // 全局默认,和实际拦他的那个数不是一回事。
  const viewerId = typeof viewer.userId === 'number' ? viewer.userId : null;
  const quotaBytes = getAttachmentQuotaBytes(viewerId);
  const ttlDays = getAttachmentTtlDays();

  if (viewer.userId == null) {
    return res.json({
      usedBytes: 0, quotaBytes, ttlDays, count: 0, byKind: [], byProject: [], expiringSoon: [],
    });
  }

  try {
    const db = getConnection();
    const byKind = db.prepare(`
      SELECT kind, COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes
      FROM attachments WHERE user_id = ? GROUP BY kind ORDER BY bytes DESC
    `).all(viewer.userId) as UsageRow[];

    const byProject = db.prepare(`
      SELECT project_path, COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes
      FROM attachments WHERE user_id = ? GROUP BY project_path ORDER BY bytes DESC LIMIT 20
    `).all(viewer.userId) as ProjectRow[];

    // 最近 7 天内就要到期的,按最老的排前面 —— 用户最该先看这几个。
    const expiringSoon = db.prepare(`
      SELECT abs_path, bytes, created_at FROM attachments
      WHERE user_id = ? AND created_at < datetime('now', ?)
      ORDER BY created_at ASC LIMIT 20
    `).all(viewer.userId, `-${Math.max(0, ttlDays - 7)} days`) as SoonRow[];

    const usedBytes = byKind.reduce((sum, row) => sum + (Number(row.bytes) || 0), 0);
    const count = byKind.reduce((sum, row) => sum + (Number(row.count) || 0), 0);

    res.json({
      usedBytes,
      usedLabel: formatBytes(usedBytes),
      quotaBytes,
      quotaLabel: formatBytes(quotaBytes),
      percent: quotaBytes > 0 ? Math.min(100, Math.round((usedBytes / quotaBytes) * 100)) : 0,
      ttlDays,
      count,
      byKind: byKind.map((row) => ({ ...row, label: formatBytes(row.bytes) })),
      byProject: byProject.map((row) => ({
        projectPath: row.project_path,
        count: row.count,
        bytes: row.bytes,
        label: formatBytes(row.bytes),
      })),
      expiringSoon: expiringSoon.map((row) => ({
        path: row.abs_path,
        name: row.abs_path.split(/[\\/]/).pop() || row.abs_path,
        bytes: row.bytes,
        label: formatBytes(row.bytes),
        createdAt: row.created_at,
      })),
    });
  } catch (error) {
    console.error('[attachments] 用量查询失败:', (error as Error).message);
    res.status(500).json({ error: '读取附件用量失败' });
  }
});

export default router;
