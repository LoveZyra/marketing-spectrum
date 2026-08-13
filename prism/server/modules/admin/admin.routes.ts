import express, { type RequestHandler, type Router } from 'express';

import { auditLogDb, userDb, type ApprovalStatus } from '@/modules/database/index.js';

type AdminRouterDependencies = {
  authenticateToken: RequestHandler;
  requireRoot: RequestHandler;
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

      res.json({ success: true, userId: targetUserId, approvalStatus: status });
    };

  router.post('/users/:id/approve', decide('approved'));
  router.post('/users/:id/reject', decide('rejected'));

  return router;
}
