import { createRequire } from 'node:module';

import express, { type RequestHandler, type Router } from 'express';

import { auditLogDb, getConnection, userDb, type ApprovalStatus } from '@/modules/database/index.js';
import { collectServerStatus } from '@/modules/admin/services/server-status.service.js';
import { collectRuntimeStats, type RuntimePoolSnapshot } from '@/modules/admin/services/runtime-stats.service.js';
import { formatBytes, getAttachmentQuotaBytes } from '@/shared/attachment-storage.js';
import { broadcastPendingApprovalCount } from '@/modules/websocket/index.js';

// bcrypt 不带类型声明(auth.js 是纯 JS 无所谓,这里是 TS)。只用到 hash 一个
// 方法,自己给个最小签名,别为一个函数引 @types 依赖。
const require = createRequire(import.meta.url);
const bcrypt = require('bcrypt') as { hash(data: string, saltOrRounds: number): Promise<string> };

type AdminRouterDependencies = {
  authenticateToken: RequestHandler;
  requireRoot: RequestHandler;
  /** 运行中代码的版本号(index.js 启动时取一次),状态面板展示。 */
  runningVersion?: string | null;
  /**
   * 常驻 Claude 池的只读快照来源(F6)。由组合根注入 —— admin 模块不直接
   * import claude-sdk.js,与 shell 模块注入 `releaseConversation` 同一套约定。
   */
  runtimePool?: () => RuntimePoolSnapshot;
};

type RequestUser = { id: number; username: string };

const readUserId = (raw: unknown): number | null => {
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

/**
 * Root-only account administration: list accounts, approve, reject.
 *
 * Every route sits behind `requireRoot`, which derives rootness from
 * `PRISM_ROOT_USERS` at request time rather than from a database column — so
 * revoking someone's admin rights is an env change and a restart, with no row
 * left behind claiming otherwise.
 */
export function createAdminRouter(dependencies: AdminRouterDependencies): Router {
  const { authenticateToken, requireRoot } = dependencies;
  const router = express.Router();

  router.use(authenticateToken, requireRoot);

  router.get('/users', (req, res) => {
    res.json({ success: true, users: userDb.listUsersForAdmin() });
  });

  const decide = (status: Extract<ApprovalStatus, 'approved' | 'rejected'>): RequestHandler =>
    (req, res) => {
      const targetUserId = readUserId(req.params.id);
      if (targetUserId === null) {
        return res.status(400).json({ error: 'Invalid user id' });
      }

      const reviewer = (req as typeof req & { user?: RequestUser }).user ?? null;

      // Reviewing yourself is not a decision anyone should be able to record.
      if (reviewer && reviewer.id === targetUserId) {
        return res.status(400).json({ error: 'You cannot review your own account' });
      }

      const changed = userDb.setApprovalStatus(targetUserId, status, reviewer?.id ?? null);
      if (!changed) {
        return res.status(404).json({ error: 'User not found' });
      }

      auditLogDb.record({
        userId: reviewer?.id ?? null,
        username: reviewer?.username ?? null,
        event: status === 'approved' ? 'user_approved' : 'user_rejected',
        detail: `target user id ${targetUserId}`,
      });

      // 审批落定即推最新待审数 —— 所有在线 root 的红色角标立刻消/更新。
      broadcastPendingApprovalCount();

      res.json({ success: true, userId: targetUserId, approvalStatus: status });
    };

  router.post('/users/:id/approve', decide('approved'));
  router.post('/users/:id/reject', decide('rejected'));

  /**
   * root 重置任意账号密码。走 updatePassword,顺带 token_version+1 ——
   * 该账号所有设备的旧令牌立即作废,持新密码重新登录。
   */
  router.post('/users/:id/reset-password', (req, res) => {
    void (async () => {
      const targetUserId = readUserId(req.params.id);
      if (targetUserId === null) {
        return res.status(400).json({ error: 'Invalid user id' });
      }
      const newPassword = String((req.body as { newPassword?: unknown })?.newPassword ?? '');
      if (newPassword.length < 6) {
        return res.status(400).json({ error: '新密码至少 6 位' });
      }
      const target = userDb.listUsersForAdmin().find((user) => user.id === targetUserId);
      if (!target) {
        return res.status(404).json({ error: 'User not found' });
      }

      const passwordHash = await bcrypt.hash(newPassword, 12);
      userDb.updatePassword(targetUserId, passwordHash);

      const actor = (req as typeof req & { user?: RequestUser }).user ?? null;
      auditLogDb.record({
        userId: actor?.id ?? null,
        username: actor?.username ?? null,
        event: 'password_reset_by_admin',
        detail: `target user ${target.username} (id ${targetUserId})`,
      });
      res.json({ success: true, userId: targetUserId });
    })().catch(() => {
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    });
  });

  /** 停用/启用账号。停用即时生效:is_active 拦新登录,版本号作废存量令牌。 */
  const setActive = (active: boolean): RequestHandler =>
    (req, res) => {
      const targetUserId = readUserId(req.params.id);
      if (targetUserId === null) {
        return res.status(400).json({ error: 'Invalid user id' });
      }
      const actor = (req as typeof req & { user?: RequestUser }).user ?? null;
      // 不许停用自己 —— 会当场把自己踢下线,root 全灭后没人能再进管理页。
      if (!active && actor && actor.id === targetUserId) {
        return res.status(400).json({ error: '不能停用自己的账号' });
      }
      const changed = userDb.setActive(targetUserId, active);
      if (!changed) {
        return res.status(404).json({ error: 'User not found' });
      }
      auditLogDb.record({
        userId: actor?.id ?? null,
        username: actor?.username ?? null,
        event: active ? 'user_activated' : 'user_deactivated',
        detail: `target user id ${targetUserId}`,
      });
      res.json({ success: true, userId: targetUserId, isActive: active });
    };

  router.post('/users/:id/deactivate', setActive(false));
  router.post('/users/:id/activate', setActive(true));

  /** 服务器状态面板:负载/内存/磁盘/版本 + Jupyter + 网关连通(不带 token 的探测)。 */
  router.get('/server-status', (req, res) => {
    void collectServerStatus({ appVersion: dependencies.runningVersion ?? null })
      .then((status) => res.json({ success: true, status }))
      .catch(() => {
        if (!res.headersSent) res.status(500).json({ error: 'Failed to collect server status' });
      });
  });

  /**
   * F6:进程内资源快照 —— 常驻池 / 在飞回合 / 待审批 / PTY / 缓存。
   *
   * **只读**。没有"一键回收"按钮:能一键杀掉别人正在跑的回合,风险远大于它
   * 省下的事;真要收,重启服务是更诚实的动作。
   */
  router.get('/stats', (req, res) => {
    try {
      res.json({ success: true, stats: collectRuntimeStats({ runtimePool: dependencies.runtimePool }) });
    } catch (error) {
      console.error('[admin] 运行时统计失败:', (error as Error).message);
      res.status(500).json({ error: 'Failed to collect runtime stats' });
    }
  });

  /**
   * F6:每个账号的附件用量与配额。
   *
   * 配额是**按账号**的,可逐人覆盖(users.attachment_quota_mb,NULL = 跟随全局)。
   * 没有这张表,root 只能靠用户自己来报"我传不上去了",而且无从判断该调谁的。
   */
  router.get('/attachment-usage', (req, res) => {
    try {
      const db = getConnection();
      const rows = db.prepare(`
        SELECT user_id, COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes
        FROM attachments WHERE user_id IS NOT NULL GROUP BY user_id
      `).all() as Array<{ user_id: number; count: number; bytes: number }>;
      const usageByUser = new Map(rows.map((row) => [row.user_id, row]));

      const users = userDb.listUsersForAdmin().map((user) => {
        const usage = usageByUser.get(user.id);
        const usedBytes = Number(usage?.bytes ?? 0);
        const quotaBytes = getAttachmentQuotaBytes(user.id);
        return {
          userId: user.id,
          username: user.username,
          isActive: Boolean(user.is_active),
          count: Number(usage?.count ?? 0),
          usedBytes,
          usedLabel: formatBytes(usedBytes),
          quotaBytes,
          quotaLabel: formatBytes(quotaBytes),
          quotaMbOverride: user.attachment_quota_mb ?? null,
          percent: quotaBytes > 0 ? Math.min(100, Math.round((usedBytes / quotaBytes) * 100)) : 0,
        };
      }).sort((left, right) => right.usedBytes - left.usedBytes);

      res.json({ success: true, users, defaultQuotaBytes: getAttachmentQuotaBytes(null) });
    } catch (error) {
      console.error('[admin] 附件用量汇总失败:', (error as Error).message);
      res.status(500).json({ error: 'Failed to collect attachment usage' });
    }
  });

  /**
   * F6:设置/清除某账号的附件配额覆盖。`quotaMb: null` = 回到全局默认。
   *
   * 上限 1024 GB 只是防手滑(打成 100000000 之后配额等于没有);下限 1 MB
   * 同理 —— 0 会让那个账号一个字节都传不了,想禁用附件应该是另一个开关。
   */
  router.put('/users/:id/attachment-quota', (req, res) => {
    const targetUserId = readUserId(req.params.id);
    if (targetUserId === null) {
      return res.status(400).json({ error: 'Invalid user id' });
    }

    const raw = (req.body as { quotaMb?: unknown })?.quotaMb;
    let quotaMb: number | null = null;
    if (raw !== null && raw !== undefined && raw !== '') {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1 || parsed > 1024 * 1024) {
        return res.status(400).json({ error: 'quotaMb 必须是 1 ~ 1048576 之间的整数,或 null(跟随全局默认)' });
      }
      quotaMb = parsed;
    }

    const changed = userDb.setAttachmentQuotaMb(targetUserId, quotaMb);
    if (!changed) {
      return res.status(404).json({ error: 'User not found' });
    }

    const actor = (req as typeof req & { user?: RequestUser }).user ?? null;
    auditLogDb.record({
      userId: actor?.id ?? null,
      username: actor?.username ?? null,
      event: 'attachment_quota_changed',
      detail: `target user id ${targetUserId} → ${quotaMb === null ? '跟随全局默认' : `${quotaMb} MB`}`,
    });

    res.json({
      success: true,
      userId: targetUserId,
      quotaMb,
      quotaBytes: getAttachmentQuotaBytes(targetUserId),
    });
  });

  return router;
}
