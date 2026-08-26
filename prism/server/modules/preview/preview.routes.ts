import { promises as fs } from 'node:fs';
import path from 'node:path';

import express, { type RequestHandler, type Router } from 'express';

import { projectsDb, resolveVisibleProjectRoot } from '@/modules/database/index.js';
import { validatePathInProject } from '@/modules/files/index.js';
import { readRequestViewer } from '@/shared/project-visibility.js';
import {
  PREVIEW_PAGE_CSP,
  contentTypeFor,
  normalizePublicSubPath,
} from '@/modules/preview/services/static-content.service.js';
import { issuePreviewTicket, readPreviewTicket } from '@/shared/preview-tickets.js';

type PreviewRouterDependencies = {
  authenticateToken: RequestHandler;
};

type PreviewPublicRouterDependencies = {
  /**
   * 必需,不是可选:这是 Prism 里仅剩的、不带凭据就能读到文件内容的路由,
   * 而一个不限流的公开读接口正是「顺手把文件服务器压垮」的形状。
   */
  rateLimiter: RequestHandler;
};

const TICKET_PATTERN = /^[a-f0-9]{64}$/;

/**
 * `POST /api/projects/:projectId/preview-ticket` (authenticated).
 *
 * Mints a 5-minute ticket for previewing one document. The ticket is scoped to
 * the document's *directory*, not the file, because an HTML page pulls in its
 * own stylesheet and images by relative path and those requests arrive on the
 * same ticket.
 */
export function createPreviewRouter(dependencies: PreviewRouterDependencies): Router {
  const { authenticateToken } = dependencies;
  const router = express.Router({ mergeParams: true });

  router.use(authenticateToken);

  router.post('/:projectId/preview-ticket', async (req, res) => {
    const projectId = String(req.params.projectId ?? '');
    // 归属校验:签出的票据由公开 /preview/:ticket/* 吐字节,所以铸票这一步必须
    // 确认调用者能看这个项目 —— 否则拿到别人的 projectId 就能预览其文件。
    const projectRoot = resolveVisibleProjectRoot(readRequestViewer(req), projectId);
    if (!projectRoot) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const body = (req.body ?? {}) as { relPath?: unknown };
    const relPath = normalizePublicSubPath(typeof body.relPath === 'string' ? body.relPath : '');
    if (relPath === null || relPath === '') {
      return res.status(400).json({ error: 'relPath is required and must stay inside the project' });
    }

    const validation = await validatePathInProject(projectRoot, relPath);
    if (!validation.valid) {
      return res.status(403).json({ error: validation.error });
    }

    try {
      const stats = await fs.stat(validation.resolved);
      if (!stats.isFile()) {
        return res.status(400).json({ error: 'Path is not a file' });
      }
    } catch {
      return res.status(404).json({ error: 'File not found' });
    }

    const relDir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '';
    const fileName = relPath.slice(relDir ? relDir.length + 1 : 0);
    const ticket = issuePreviewTicket({ projectId, relDir });

    res.json({
      success: true,
      ticket,
      url: `/preview/${ticket}/${encodeURIComponent(fileName)}`,
    });
  });

  return router;
}

/**
 * `GET /preview/:ticket/*` — reads for the sandboxed preview iframe.
 *
 * Mounted outside the `/api` gate on purpose: the iframe has no
 * `allow-same-origin`, so it sends no credentials and the ticket in the path is
 * the whole authorization story. Everything it can
 * reach is under the ticket's directory, checked by validatePathInProject
 * against the project root as well.
 */
export function createPreviewPublicRouter(dependencies: PreviewPublicRouterDependencies): Router {
  const { rateLimiter } = dependencies;
  const router = express.Router();

  router.use('/preview', rateLimiter);

  router.get(/^\/preview\/([^/]+)(?:\/(.*))?$/, async (req, res) => {
    const ticket = String(req.params[0] ?? '');
    if (!TICKET_PATTERN.test(ticket)) {
      return res.status(404).type('text/plain').send('Not found');
    }

    const scope = readPreviewTicket(ticket);
    if (!scope) {
      // Expired or unknown. Say so plainly — a stale preview tab showing a bare
      // 404 reads as a broken feature.
      return res.status(410).type('text/plain').send('Preview expired. Reopen the preview.');
    }

    const projectRoot = projectsDb.getProjectPathById(scope.projectId);
    if (!projectRoot) {
      return res.status(404).type('text/plain').send('Not found');
    }

    const subPath = normalizePublicSubPath(String(req.params[1] ?? ''));
    if (subPath === null || subPath === '') {
      return res.status(400).type('text/plain').send('Bad request');
    }

    const relPath = scope.relDir ? `${scope.relDir}/${subPath}` : subPath;
    const validation = await validatePathInProject(projectRoot, relPath);
    if (!validation.valid) {
      return res.status(403).type('text/plain').send('Forbidden');
    }

    try {
      const stats = await fs.stat(validation.resolved);
      if (!stats.isFile()) {
        return res.status(404).type('text/plain').send('Not found');
      }
    } catch {
      return res.status(404).type('text/plain').send('Not found');
    }

    const { contentType, forceDownload } = contentTypeFor(validation.resolved);

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', PREVIEW_PAGE_CSP);
    res.setHeader('Referrer-Policy', 'no-referrer');
    // Previews exist to show the file as it is right now.
    res.setHeader('Cache-Control', 'no-store');
    res.type(contentType);

    if (forceDownload) {
      // 文件名不能裸拼进头:非 Latin-1 字符(中文名是常态)会让 setHeader 抛
      // ERR_INVALID_CHAR,整个请求 500;引号本身也会破坏头部语法。照会话导出
      // (provider.routes.ts)的写法:ASCII 兜底 + RFC 5987 filename* 带真名。
      const baseName = path.basename(validation.resolved);
      const asciiName = baseName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download';
      const utf8Name = encodeURIComponent(baseName);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`,
      );
    }

    return res.sendFile(validation.resolved);
  });

  return router;
}
