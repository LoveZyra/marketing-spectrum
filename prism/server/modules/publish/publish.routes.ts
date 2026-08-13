import { promises as fs } from 'node:fs';

import express, { type RequestHandler, type Router } from 'express';

import { projectsDb, publishedPagesDb, type PublicationKind } from '@/modules/database/index.js';
import { validatePathInProject } from '@/modules/files/index.js';
import { normalizePublicSubPath } from '@/modules/publish/services/publish.service.js';

type PublishRouterDependencies = {
  authenticateToken: RequestHandler;
};

const publicUrlFor = (token: string): string => `/p/${token}/`;

const readKind = (raw: unknown): PublicationKind | null => {
  if (raw === undefined || raw === 'file') return 'file';
  if (raw === 'folder') return 'folder';
  return null;
};

/**
 * Project-scoped publication management (authenticated).
 *
 * The public side lives in publish-public.routes.ts and mounts outside the
 * `/api` gate; these three routes only ever mint and revoke rows.
 */
export function createPublishRouter(dependencies: PublishRouterDependencies): Router {
  const { authenticateToken } = dependencies;
  const router = express.Router({ mergeParams: true });

  router.use(authenticateToken);

  router.get('/:projectId/publications', (req, res) => {
    const projectId = String(req.params.projectId ?? '');
    if (!projectsDb.getProjectPathById(projectId)) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const publications = publishedPagesDb.listByProject(projectId).map((row) => ({
      id: row.id,
      relPath: row.rel_path,
      kind: row.kind,
      token: row.token,
      url: publicUrlFor(row.token),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    res.json({ success: true, publications });
  });

  router.post('/:projectId/publish', async (req, res) => {
    const projectId = String(req.params.projectId ?? '');
    const projectRoot = projectsDb.getProjectPathById(projectId);
    if (!projectRoot) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const body = (req.body ?? {}) as { relPath?: unknown; kind?: unknown };
    const kind = readKind(body.kind);
    if (kind === null) {
      return res.status(400).json({ error: 'kind must be "file" or "folder"' });
    }

    const relPath = normalizePublicSubPath(typeof body.relPath === 'string' ? body.relPath : '');
    if (relPath === null || relPath === '') {
      return res.status(400).json({ error: 'relPath is required and must stay inside the project' });
    }

    const validation = await validatePathInProject(projectRoot, relPath);
    if (!validation.valid) {
      return res.status(403).json({ error: validation.error });
    }

    // Publishing a path that does not exist yields a link that 404s on the
    // first click. Catching it here means the person sharing it finds out, not
    // the person they shared it with.
    let stats;
    try {
      stats = await fs.stat(validation.resolved);
    } catch {
      return res.status(404).json({ error: 'File or folder not found' });
    }

    if (kind === 'folder' && !stats.isDirectory()) {
      return res.status(400).json({ error: 'Path is not a folder' });
    }
    if (kind === 'file' && !stats.isFile()) {
      return res.status(400).json({ error: 'Path is not a file' });
    }

    const row = publishedPagesDb.publish(projectId, relPath, kind);
    res.json({
      success: true,
      publication: {
        id: row.id,
        relPath: row.rel_path,
        kind: row.kind,
        token: row.token,
        url: publicUrlFor(row.token),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    });
  });

  router.delete('/:projectId/publish/:id', (req, res) => {
    const projectId = String(req.params.projectId ?? '');
    const id = String(req.params.id ?? '');

    if (!publishedPagesDb.unpublish(projectId, id)) {
      return res.status(404).json({ error: 'Publication not found' });
    }

    res.json({ success: true });
  });

  return router;
}
