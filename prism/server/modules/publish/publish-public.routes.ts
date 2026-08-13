import { promises as fs } from 'node:fs';
import path from 'node:path';

import express, { type RequestHandler, type Router } from 'express';

import { projectsDb, publishedPagesDb } from '@/modules/database/index.js';
import { validatePathInProject } from '@/modules/files/index.js';
import {
  PUBLISHED_PAGE_CSP,
  contentTypeFor,
  injectBaseHref,
  isHtml,
  normalizePublicSubPath,
  publicBaseHref,
} from '@/modules/publish/services/publish.service.js';

type PublishPublicRouterDependencies = {
  /**
   * The API rate limiter. Required, not optional: this router is the one place
   * in Prism that answers without credentials, and an unmetered public read
   * endpoint is exactly the shape of an accidental file-serving DoS.
   */
  rateLimiter: RequestHandler;
};

const TOKEN_PATTERN = /^[a-f0-9]{32}$/;

/**
 * `GET /p/:token/*` — the unauthenticated read side of publishing.
 *
 * Mounted before the `/api` API-key gate and under its own `/p` prefix rather
 * than inside `/api`, so that middleware added to the API surface later cannot
 * accidentally start demanding credentials here (or, worse, accidentally stop).
 *
 * Every request re-reads the file from the workspace. Nothing is copied at
 * publish time, so a page is updated by editing it and reloading — and revoking
 * a token takes effect on the next request with no cache to clear.
 */
export function createPublishPublicRouter(dependencies: PublishPublicRouterDependencies): Router {
  const { rateLimiter } = dependencies;
  const router = express.Router();

  router.use('/p', rateLimiter);

  router.get(/^\/p\/([^/]+)(?:\/(.*))?$/, async (req, res) => {
    const token = String(req.params[0] ?? '');
    const rawTail = String(req.params[1] ?? '');

    // Shape check before touching the database: a token is 32 hex chars, and
    // anything else is a scan.
    if (!TOKEN_PATTERN.test(token)) {
      return res.status(404).type('text/plain').send('Not found');
    }

    const publication = publishedPagesDb.getByToken(token);
    if (!publication) {
      return res.status(404).type('text/plain').send('Not found');
    }

    const projectRoot = projectsDb.getProjectPathById(publication.project_id);
    if (!projectRoot) {
      return res.status(404).type('text/plain').send('Not found');
    }

    const subPath = normalizePublicSubPath(rawTail);
    if (subPath === null) {
      return res.status(400).type('text/plain').send('Bad request');
    }

    // A single published file ignores the tail entirely: /p/<token>/ and
    // /p/<token>/anything both serve that one file. That is what makes the
    // injected <base href="/p/<token>/"> safe — relative URLs in the document
    // cannot walk anywhere.
    let relPath: string;
    if (publication.kind === 'file') {
      relPath = publication.rel_path;
    } else {
      // Folder publications need the trailing slash, or the browser resolves
      // "assets/app.css" against the parent directory and every relative asset
      // 404s. Redirect rather than patch it up, so the address bar is right.
      if (subPath === '' && !req.path.endsWith('/')) {
        return res.redirect(301, `${req.baseUrl}${req.path}/`);
      }
      relPath = subPath ? `${publication.rel_path}/${subPath}` : publication.rel_path;
    }

    const validation = await validatePathInProject(projectRoot, relPath);
    if (!validation.valid) {
      return res.status(403).type('text/plain').send('Forbidden');
    }

    let target = validation.resolved;
    let stats;
    try {
      stats = await fs.stat(target);
    } catch {
      return res.status(404).type('text/plain').send('Not found');
    }

    if (stats.isDirectory()) {
      // Directory index. Re-validated because index.html could itself be a
      // symlink pointing outside the project.
      const indexValidation = await validatePathInProject(projectRoot, path.join(relPath, 'index.html'));
      if (!indexValidation.valid) {
        return res.status(403).type('text/plain').send('Forbidden');
      }
      target = indexValidation.resolved;
      try {
        await fs.access(target);
      } catch {
        return res.status(404).type('text/plain').send('Not found');
      }
    }

    const { contentType, forceDownload } = contentTypeFor(target);

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', PUBLISHED_PAGE_CSP);
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-cache');
    res.type(contentType);

    if (forceDownload) {
      res.setHeader('Content-Disposition', `attachment; filename="${path.basename(target)}"`);
      return res.sendFile(target);
    }

    if (isHtml(target)) {
      const html = await fs.readFile(target, 'utf-8');
      const baseHref = publicBaseHref(
        token,
        publication.kind,
        publication.kind === 'folder' ? (stats.isDirectory() ? `${subPath}/index.html` : subPath) : '',
      );
      return res.send(injectBaseHref(html, baseHref));
    }

    return res.sendFile(target);
  });

  return router;
}
