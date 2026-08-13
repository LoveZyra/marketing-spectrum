import { randomBytes, randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';

export type PublicationKind = 'file' | 'folder';

export type PublishedPageRow = {
  id: string;
  token: string;
  project_id: string;
  rel_path: string;
  kind: PublicationKind;
  created_at: string;
  updated_at: string;
};

/**
 * Publication tokens.
 *
 * 16 bytes of CSPRNG output, hex-encoded — 128 bits, which is the whole of the
 * access control on a published page. There is no expiry: a publication is
 * revoked by deleting its row, which is why `unpublish` is a hard DELETE
 * rather than a flag.
 *
 * Deliberately distinct from the short-lived preview tokens used by the
 * editor's HTML preview. Sharing one token type between the two would mean
 * either that opening a preview leaves a permanently reachable URL behind, or
 * that a link you shared with a colleague dies five minutes later.
 */
const newToken = (): string => randomBytes(16).toString('hex');

export const publishedPagesDb = {
  /** Everything published from one project, newest first. */
  listByProject(projectId: string): PublishedPageRow[] {
    const db = getConnection();
    return db
      .prepare(
        `SELECT id, token, project_id, rel_path, kind, created_at, updated_at
         FROM published_pages
         WHERE project_id = ?
         ORDER BY created_at DESC`,
      )
      .all(projectId) as PublishedPageRow[];
  },

  /** The public route's only lookup. Undefined for an unknown or revoked token. */
  getByToken(token: string): PublishedPageRow | undefined {
    const db = getConnection();
    return db
      .prepare(
        `SELECT id, token, project_id, rel_path, kind, created_at, updated_at
         FROM published_pages
         WHERE token = ?`,
      )
      .get(token) as PublishedPageRow | undefined;
  },

  /**
   * Publish a path, or return the existing publication for it.
   *
   * Re-publishing the same path keeps the original token on purpose: someone
   * has already shared that URL, and minting a new one would break it while
   * looking like success. `updated_at` moves so the list can show recency.
   */
  publish(projectId: string, relPath: string, kind: PublicationKind): PublishedPageRow {
    const db = getConnection();
    db.prepare(
      `INSERT INTO published_pages (id, token, project_id, rel_path, kind)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_id, rel_path) DO UPDATE SET
         kind = excluded.kind,
         updated_at = CURRENT_TIMESTAMP`,
    ).run(randomUUID(), newToken(), projectId, relPath, kind);

    return db
      .prepare(
        `SELECT id, token, project_id, rel_path, kind, created_at, updated_at
         FROM published_pages
         WHERE project_id = ? AND rel_path = ?`,
      )
      .get(projectId, relPath) as PublishedPageRow;
  },

  /** Revoke. Returns false when the id does not belong to this project. */
  unpublish(projectId: string, id: string): boolean {
    const db = getConnection();
    const result = db
      .prepare('DELETE FROM published_pages WHERE id = ? AND project_id = ?')
      .run(id, projectId);
    return result.changes > 0;
  },

  /** Drops every publication of a project. Called when the project is deleted. */
  deleteByProject(projectId: string): number {
    const db = getConnection();
    return db.prepare('DELETE FROM published_pages WHERE project_id = ?').run(projectId).changes;
  },
};
