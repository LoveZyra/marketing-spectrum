import { projectsDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

type ToggleProjectStarResult = {
  isStarred: boolean;
};

type ApplyLegacyStarredProjectIdsResult = {
  updated: number;
};

function normalizeProjectId(projectId: string): string {
  return projectId.trim();
}

function uniqueProjectIds(projectIds: string[]): string[] {
  const uniqueIds = new Set<string>();
  for (const projectId of projectIds) {
    const normalizedProjectId = normalizeProjectId(projectId);
    if (!normalizedProjectId) {
      continue;
    }
    uniqueIds.add(normalizedProjectId);
  }
  return [...uniqueIds];
}

/**
 * Applies legacy `localStorage` stars keyed by DB `projectId`.
 *
 * 收藏现在按用户隔离(project_stars):有 userId 时写该用户自己的行;
 * userId 为 null(平台模式,无账号体系)时退回旧的全局 isStarred 列。
 * The operation is idempotent: already-starred projects are ignored, unknown ids are skipped.
 */
export function applyLegacyStarredProjectIds(
  projectIds: string[],
  userId: number | null = null,
): ApplyLegacyStarredProjectIdsResult {
  const normalizedProjectIds = uniqueProjectIds(projectIds);
  let updated = 0;

  for (const projectId of normalizedProjectIds) {
    const project = projectsDb.getProjectById(projectId);
    if (!project) {
      continue;
    }

    if (userId != null) {
      if (projectsDb.isProjectStarredByUser(projectId, userId)) {
        continue;
      }
      projectsDb.setProjectStarForUser(projectId, userId, true);
      updated += 1;
      continue;
    }

    if (Boolean(project.isStarred)) {
      continue;
    }

    projectsDb.updateProjectIsStarredById(projectId, true);
    updated += 1;
  }

  return { updated };
}

/**
 * Flips the caller's star for one project and returns the new state.
 *
 * 有 userId → 只动 project_stars 里 (project, user) 这一行,别人的收藏和
 * root 视角互不影响;userId 为 null(平台模式)→ 旧全局列行为不变。
 */
export function toggleProjectStar(projectId: string, userId: number | null = null): ToggleProjectStarResult {
  const normalizedProjectId = normalizeProjectId(projectId);
  if (!normalizedProjectId) {
    throw new AppError('projectId is required', {
      code: 'PROJECT_ID_REQUIRED',
      statusCode: 400,
    });
  }

  const project = projectsDb.getProjectById(normalizedProjectId);
  if (!project) {
    throw new AppError('Project not found', {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }

  if (userId != null) {
    const nextStarredState = !projectsDb.isProjectStarredByUser(normalizedProjectId, userId);
    projectsDb.setProjectStarForUser(normalizedProjectId, userId, nextStarredState);
    return { isStarred: nextStarredState };
  }

  const nextStarredState = !Boolean(project.isStarred);
  projectsDb.updateProjectIsStarredById(normalizedProjectId, nextStarredState);

  return { isStarred: nextStarredState };
}
