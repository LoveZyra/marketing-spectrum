/**
 * /api/jupyter/*(挂载时外面套 authenticateToken):
 *
 *   GET  /status   当前 lab 进程状态(装没装、跑没跑、就绪没有、上次错误)。
 *   POST /session  确保 lab 就绪,铸一张一次性入口票,返回 iframe 地址。
 *                  body.path 可选 —— 给了就深链到 /lab/tree/<相对工作区根>。
 *
 * 反代本体(/jupyter/*)不在这里 —— 它必须挂在 express.json 之前,由
 * index.js 直接组装(见 jupyter-proxy.service)。
 */

import express from 'express';

import { asyncHandler, createApiSuccessResponse, WORKSPACES_ROOT } from '@/shared/utils.js';

import {
  buildJupyterEntryUrl,
  ensureJupyterRunning,
  getJupyterStatus,
  issueJupyterEntryTicket,
} from './services/jupyter-manager.service.js';

const router = express.Router();

type AuthenticatedUser = {
  id?: number;
  userId?: number | string;
  username?: string;
};

const readUser = (req: express.Request): AuthenticatedUser | undefined =>
  (req as express.Request & { user?: AuthenticatedUser }).user;

router.get('/status', (_req, res) => {
  res.json(createApiSuccessResponse(getJupyterStatus()));
});

router.post(
  '/session',
  asyncHandler(async (req, res) => {
    const ensured = await ensureJupyterRunning();
    if (!ensured.ok) {
      // 200 + 结构化失败:前端据 reason 分流(未安装给安装指引,其余给重试)。
      res.json(
        createApiSuccessResponse({
          ready: false,
          reason: ensured.reason,
          detail: ensured.detail,
        }),
      );
      return;
    }

    const user = readUser(req);
    const ticket = issueJupyterEntryTicket(user?.id ?? user?.userId ?? 'user');
    const body = (req.body ?? {}) as { path?: unknown };
    const targetPath = typeof body.path === 'string' ? body.path : null;

    res.json(
      createApiSuccessResponse({
        ready: true,
        url: buildJupyterEntryUrl({ rootDir: WORKSPACES_ROOT, targetPath, ticket }),
      }),
    );
  }),
);

export default router;
