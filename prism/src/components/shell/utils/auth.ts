import type { ProjectSession } from '../../../types/app';

// Cursor sessions carried a `name` and everything else a `summary`, so this
// used to branch on the provider. Claude only ever writes a summary.
export function getSessionDisplayName(session: ProjectSession | null | undefined): string | null {
  if (!session) {
    return null;
  }

  return session.summary || 'New Session';
}
