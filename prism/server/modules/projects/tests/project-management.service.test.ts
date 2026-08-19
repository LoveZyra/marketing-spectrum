import assert from 'node:assert/strict';
import { test } from 'vitest';

import { createProject } from '@/modules/projects/services/project-management.service.js';
import { AppError } from '@/shared/utils.js';

const projectRow = {
  project_id: 'project-1',
  project_path: '/workspace/my-project',
  custom_project_name: 'my-project',
  isStarred: 0,
  isArchived: 0,
  owner_user_id: null,
  visibility: null as string | null,
};

const noShares = (): void => undefined;

test('createProject throws when project path is missing', async () => {
  await assert.rejects(
    async () => createProject({ projectPath: '' }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'PROJECT_PATH_REQUIRED');
      assert.equal(error.statusCode, 400);
      return true;
    },
  );
});

test('createProject throws when path validation fails', async () => {
  await assert.rejects(
    async () =>
      createProject(
        { projectPath: '/invalid/path' },
        {
          validatePath: async () => ({ valid: false, error: 'blocked path' }),
          ensureWorkspaceDirectory: async () => undefined,
          persistProjectPath: () => ({ outcome: 'created', project: projectRow }),
          getProjectByPath: () => projectRow,
          setProjectShares: noShares,
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'INVALID_PROJECT_PATH');
      assert.equal(error.statusCode, 400);
      assert.equal(error.details, 'blocked path');
      return true;
    },
  );
});

test('createProject throws conflict when active project path already exists', async () => {
  await assert.rejects(
    async () =>
      createProject(
        { projectPath: '/workspace/my-project' },
        {
          validatePath: async () => ({ valid: true, resolvedPath: '/workspace/my-project' }),
          ensureWorkspaceDirectory: async () => undefined,
          persistProjectPath: () => ({ outcome: 'active_conflict', project: projectRow }),
          getProjectByPath: () => projectRow,
          setProjectShares: noShares,
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'PROJECT_ALREADY_EXISTS');
      assert.equal(error.statusCode, 409);
      assert.equal(error.details, 'Project path already exists: /workspace/my-project');
      return true;
    },
  );
});

test('createProject falls back to directory name when custom name is not provided', async () => {
  let capturedCustomName: string | null = null;

  const result = await createProject(
    { projectPath: '/workspace/my-project', customName: '' },
    {
      validatePath: async () => ({ valid: true, resolvedPath: '/workspace/my-project' }),
      ensureWorkspaceDirectory: async () => undefined,
      persistProjectPath: (_projectPath, customName) => {
        capturedCustomName = customName;
        return {
          outcome: 'created' as const,
          project: {
            ...projectRow,
            custom_project_name: customName,
          },
        };
      },
      getProjectByPath: () => projectRow,
      setProjectShares: noShares,
    },
  );

  assert.equal(capturedCustomName, 'my-project');
  assert.equal(result.outcome, 'created');
  assert.equal(result.project.displayName, 'my-project');
});

test('createProject returns archived reuse outcome when archived row is reused', async () => {
  const result = await createProject(
    { projectPath: '/workspace/my-project' },
    {
      validatePath: async () => ({ valid: true, resolvedPath: '/workspace/my-project' }),
      ensureWorkspaceDirectory: async () => undefined,
      persistProjectPath: () => ({
        outcome: 'reactivated_archived',
        project: {
          ...projectRow,
          isArchived: 1,
          owner_user_id: null,
        },
      }),
      getProjectByPath: () => projectRow,
      setProjectShares: noShares,
    },
  );

  assert.equal(result.outcome, 'reactivated_archived');
  assert.equal(result.project.isArchived, true);
});

test('createProject:「指定用户」新建时写入授权,复活归档路径时不写', async () => {
  const sharesWritten: Array<{ projectId: string; userIds: number[]; grantedBy: number | null }> = [];
  const deps = (outcome: 'created' | 'reactivated_archived') => ({
    validatePath: async () => ({ valid: true, resolvedPath: '/workspace/my-project' }),
    ensureWorkspaceDirectory: async () => undefined,
    persistProjectPath: () => ({ outcome, project: projectRow }),
    getProjectByPath: () => projectRow,
    setProjectShares: (projectId: string, userIds: number[], grantedBy: number | null) => {
      sharesWritten.push({ projectId, userIds, grantedBy });
    },
  });

  await createProject(
    { projectPath: '/workspace/my-project', ownerUserId: 7, sharedUserIds: [3, 5] },
    deps('created'),
  );
  assert.deepEqual(sharesWritten, [{ projectId: 'project-1', userIds: [3, 5], grantedBy: 7 }]);

  // 复活归档路径:权限不动(与 owner/visibility 同规),不追加授权。
  await createProject(
    { projectPath: '/workspace/my-project', ownerUserId: 7, sharedUserIds: [3] },
    deps('reactivated_archived'),
  );
  assert.equal(sharesWritten.length, 1);
});
