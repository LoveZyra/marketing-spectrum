import express from 'express';

import { auditLogDb, projectsDb, userDb } from '@/modules/database/index.js';
import { createProject, updateProjectDisplayName } from '@/modules/projects/services/project-management.service.js';
import { getProjectTaskMaster } from '@/modules/projects/services/projects-has-taskmaster.service.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';
import { getArchivedProjectsWithSessions, getProjectSessionsPage, getProjectsWithSessions } from '@/modules/projects/services/projects-with-sessions-fetch.service.js';
import { deleteOrArchiveProject, restoreArchivedProject } from '@/modules/projects/services/project-delete.service.js';
import { applyLegacyStarredProjectIds, toggleProjectStar } from '@/modules/projects/services/project-star.service.js';

const router = express.Router();

type AuthenticatedUser = {
  id?: number;
  username?: string;
  isRoot?: boolean;
};

const readUser = (req: express.Request): AuthenticatedUser | undefined =>
  (req as express.Request & { user?: AuthenticatedUser }).user;

/**
 * Which owner scope this caller's list should use.
 *
 * `null` means "no filter" and is returned for root — and also when there is no
 * user on the request at all, which is the platform-mode path. Erring towards
 * the unfiltered list there is deliberate: platform deployments authenticate
 * upstream and have always shown every project.
 */
const visibilityScopeFor = (req: express.Request): number | null => {
  const user = readUser(req);
  if (!user || user.isRoot || typeof user.id !== 'number') {
    return null;
  }
  return user.id;
};

function readQueryStringValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }

  return '';
}

function readOptionalNumericQueryValue(value: unknown): number | null {
  const rawValue = readQueryStringValue(value).trim();
  if (!rawValue) {
    return null;
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  return Number.isNaN(parsedValue) ? null : parsedValue;
}

function parseNonNegativeIntQuery(value: unknown, name: string, fallback: number): number {
  const rawValue = readQueryStringValue(value).trim();
  if (!rawValue) {
    return fallback;
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  if (Number.isNaN(parsedValue) || parsedValue < 0) {
    throw new AppError(`${name} must be a non-negative integer`, {
      code: 'INVALID_QUERY_PARAMETER',
      statusCode: 400,
    });
  }

  return parsedValue;
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const skipSynchronization =
      readQueryStringValue(req.query.skipSynchronization).trim() === '1' ||
      readQueryStringValue(req.query.skipSync).trim() === '1';
    const sessionsLimit = readOptionalNumericQueryValue(req.query.sessionsLimit) ?? undefined;
    const sessionsOffset = readOptionalNumericQueryValue(req.query.sessionsOffset) ?? undefined;
    const projects = await getProjectsWithSessions({
      skipSynchronization,
      sessionsLimit,
      sessionsOffset,
      visibleTo: visibilityScopeFor(req),
    });
    res.json(projects);
  }),
);

router.get(
  '/archived',
  asyncHandler(async (req, res) => {
    const projects = await getArchivedProjectsWithSessions({ visibleTo: visibilityScopeFor(req) });
    res.json(createApiSuccessResponse({ projects }));
  }),
);

router.get(
  '/:projectId/sessions',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    const limit = parseNonNegativeIntQuery(req.query.limit, 'limit', 20);
    const offset = parseNonNegativeIntQuery(req.query.offset, 'offset', 0);
    const sessionsPage = await getProjectSessionsPage(projectId, { limit, offset });
    res.json(sessionsPage);
  }),
);

router.post(
  '/create-project',
  asyncHandler(async (req, res) => {
    const requestBody = req.body as Record<string, unknown>;
    const projectPath = typeof requestBody.path === 'string' ? requestBody.path : '';
    const customName = typeof requestBody.customName === 'string' ? requestBody.customName : null;

    if (requestBody.workspaceType !== undefined) {
      throw new AppError('workspaceType is no longer supported. Use the single create-project flow.', {
        code: 'LEGACY_WORKSPACE_TYPE_UNSUPPORTED',
        statusCode: 400,
      });
    }

    if (requestBody.githubUrl || requestBody.githubTokenId || requestBody.newGithubToken) {
      throw new AppError('Repository cloning is no longer supported', {
        code: 'CLONE_NOT_SUPPORTED',
        statusCode: 400,
        details: 'Create the project from a directory that already exists on the server.',
      });
    }

    const projectCreationResult = await createProject({
      projectPath,
      customName,
      ownerUserId: readUser(req)?.id ?? null,
    });

    res.json({
      success: true,
      project: projectCreationResult.project,
      message:
        projectCreationResult.outcome === 'reactivated_archived'
          ? 'Archived project path reused successfully'
          : 'Project created successfully',
    });
  }),
);

/**
 * One-time (or idempotent) migration: apply legacy `localStorage` starred projectIds to the DB, then clear client storage.
 */
router.post(
  '/migrate-legacy-stars',
  asyncHandler(async (req, res) => {
    const projectIds = Array.isArray((req.body as { projectIds?: unknown })?.projectIds)
      ? ((req.body as { projectIds: unknown[] }).projectIds as unknown[]).map((x) => String(x))
      : [];
    const { updated } = applyLegacyStarredProjectIds(projectIds);
    res.json({ success: true, updated });
  }),
);

router.get(
  '/:projectId/taskmaster',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    const taskMasterDetails = await getProjectTaskMaster(projectId);
    res.json(taskMasterDetails);
  }),
);

/**
 * Reassign a project, or make it public with `{ "ownerUserId": null }`.
 *
 * Root only. Ownership is what the sidebar filters on, so letting a
 * non-owner rewrite it would make the filter meaningless.
 */
router.patch(
  '/:projectId/owner',
  asyncHandler(async (req, res) => {
    const actor = readUser(req);
    if (!actor?.isRoot) {
      throw new AppError('Administrator access required', {
        code: 'ROOT_REQUIRED',
        statusCode: 403,
      });
    }

    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    const rawOwner = (req.body as { ownerUserId?: unknown })?.ownerUserId;

    let ownerUserId: number | null;
    if (rawOwner === null) {
      ownerUserId = null;
    } else if (typeof rawOwner === 'number' && Number.isInteger(rawOwner) && rawOwner > 0) {
      if (!userDb.getUserById(rawOwner)) {
        throw new AppError('Target user does not exist', {
          code: 'OWNER_NOT_FOUND',
          statusCode: 400,
        });
      }
      ownerUserId = rawOwner;
    } else {
      throw new AppError('ownerUserId must be a positive integer or null', {
        code: 'INVALID_OWNER',
        statusCode: 400,
      });
    }

    if (!projectsDb.setProjectOwner(projectId, ownerUserId)) {
      throw new AppError(`Project "${projectId}" was not found.`, {
        code: 'PROJECT_NOT_FOUND',
        statusCode: 404,
      });
    }

    auditLogDb.record({
      userId: actor.id ?? null,
      username: actor.username ?? null,
      event: 'project_owner_changed',
      detail: `${projectId} -> ${ownerUserId === null ? 'public' : `user ${ownerUserId}`}`,
    });

    res.json({ success: true, projectId, ownerUserId });
  }),
);

router.put('/:projectId/rename', (req, res) => {
  try {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    const { displayName } = req.body as { displayName?: unknown };
    updateProjectDisplayName(projectId, displayName);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to rename project' });
  }
});

router.post(
  '/:projectId/toggle-star',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    const { isStarred } = toggleProjectStar(projectId);
    res.json({ success: true, isStarred });
  }),
);

router.post(
  '/:projectId/restore',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    restoreArchivedProject(projectId);
    res.json(createApiSuccessResponse({ projectId, isArchived: false }));
  }),
);

/**
 * - `force` not set / false: archive project in DB only (`isArchived` = 1; hidden from active list).
 * - `force=true`: remove DB row, delete session rows for that path, remove all `*.jsonl` under the Claude project dir.
 */
router.delete(
  '/:projectId',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    const force = req.query.force === 'true';
    await deleteOrArchiveProject(projectId, force);
    res.json({ success: true });
  }),
);

export default router;
