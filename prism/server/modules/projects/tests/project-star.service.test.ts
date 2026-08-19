import assert from 'node:assert/strict';

import { test } from 'vitest';

import { projectsDb } from '@/modules/database/index.js';
import { applyLegacyStarredProjectIds, toggleProjectStar } from '@/modules/projects/services/project-star.service.js';
import { AppError } from '@/shared/utils.js';

type ProjectRow = {
  project_id: string;
  project_path: string;
  custom_project_name: string | null;
  isStarred: number;
  isArchived: number;
  owner_user_id: number | null;
  visibility: string | null;
};

test('toggleProjectStar throws when projectId is missing', () => {
  assert.throws(
    () => toggleProjectStar('   '),
    (error: unknown) =>
      error instanceof AppError
      && error.code === 'PROJECT_ID_REQUIRED'
      && error.statusCode === 400,
  );
});

test('toggleProjectStar throws when project does not exist', () => {
  const originalGetProjectById = projectsDb.getProjectById;
  try {
    projectsDb.getProjectById = () => null;
    assert.throws(
      () => toggleProjectStar('project-1'),
      (error: unknown) =>
        error instanceof AppError
        && error.code === 'PROJECT_NOT_FOUND'
        && error.statusCode === 404,
    );
  } finally {
    projectsDb.getProjectById = originalGetProjectById;
  }
});

test('toggleProjectStar flips star state and persists it', () => {
  const originalGetProjectById = projectsDb.getProjectById;
  const originalUpdateProjectIsStarredById = projectsDb.updateProjectIsStarredById;

  let capturedProjectId = '';
  let capturedState = false;

  try {
    projectsDb.getProjectById = () =>
      ({
        project_id: 'project-1',
        project_path: '/workspace/project-1',
        custom_project_name: 'project-1',
        isStarred: 0,
        isArchived: 0,
        owner_user_id: null,
      }) as ProjectRow;
    projectsDb.updateProjectIsStarredById = (projectId: string, isStarred: boolean) => {
      capturedProjectId = projectId;
      capturedState = isStarred;
    };

    const result = toggleProjectStar('project-1');

    assert.equal(result.isStarred, true);
    assert.equal(capturedProjectId, 'project-1');
    assert.equal(capturedState, true);
  } finally {
    projectsDb.getProjectById = originalGetProjectById;
    projectsDb.updateProjectIsStarredById = originalUpdateProjectIsStarredById;
  }
});

test('applyLegacyStarredProjectIds stars only valid, unstarred projects', () => {
  const originalGetProjectById = projectsDb.getProjectById;
  const originalUpdateProjectIsStarredById = projectsDb.updateProjectIsStarredById;

  const updatedProjectIds: string[] = [];

  try {
    projectsDb.getProjectById = (projectId: string) => {
      if (projectId === 'project-a') {
        return {
          project_id: 'project-a',
          project_path: '/workspace/project-a',
          custom_project_name: 'A',
          isStarred: 0,
          isArchived: 0,
          owner_user_id: null,
        } as ProjectRow;
      }

      if (projectId === 'project-b') {
        return {
          project_id: 'project-b',
          project_path: '/workspace/project-b',
          custom_project_name: 'B',
          isStarred: 1,
          isArchived: 0,
          owner_user_id: null,
        } as ProjectRow;
      }

      return null;
    };
    projectsDb.updateProjectIsStarredById = (projectId: string) => {
      updatedProjectIds.push(projectId);
    };

    const result = applyLegacyStarredProjectIds([
      'project-a',
      'project-b',
      'missing-project',
      'project-a',
      '',
      '   ',
    ]);

    assert.equal(result.updated, 1);
    assert.deepEqual(updatedProjectIds, ['project-a']);
  } finally {
    projectsDb.getProjectById = originalGetProjectById;
    projectsDb.updateProjectIsStarredById = originalUpdateProjectIsStarredById;
  }
});

test('toggleProjectStar 带 userId 时只动该用户的 project_stars 行', () => {
  const originalGetProjectById = projectsDb.getProjectById;
  const originalIsStarredByUser = projectsDb.isProjectStarredByUser;
  const originalSetStarForUser = projectsDb.setProjectStarForUser;
  const originalUpdateProjectIsStarredById = projectsDb.updateProjectIsStarredById;

  const perUserCalls: Array<{ projectId: string; userId: number; starred: boolean }> = [];
  let globalColumnTouched = false;

  try {
    projectsDb.getProjectById = () =>
      ({
        project_id: 'project-1',
        project_path: '/workspace/project-1',
        custom_project_name: 'project-1',
        isStarred: 1, // 全局旧列即便是 1,per-user 判定也不该被它影响
        isArchived: 0,
        owner_user_id: 7,
        visibility: null,
      }) as ProjectRow;
    projectsDb.isProjectStarredByUser = () => false;
    projectsDb.setProjectStarForUser = (projectId: string, userId: number, starred: boolean) => {
      perUserCalls.push({ projectId, userId, starred });
    };
    projectsDb.updateProjectIsStarredById = () => {
      globalColumnTouched = true;
    };

    const result = toggleProjectStar('project-1', 42);
    assert.equal(result.isStarred, true);
    assert.deepEqual(perUserCalls, [{ projectId: 'project-1', userId: 42, starred: true }]);
    assert.equal(globalColumnTouched, false); // 全局列不能再被有账号的调用碰
  } finally {
    projectsDb.getProjectById = originalGetProjectById;
    projectsDb.isProjectStarredByUser = originalIsStarredByUser;
    projectsDb.setProjectStarForUser = originalSetStarForUser;
    projectsDb.updateProjectIsStarredById = originalUpdateProjectIsStarredById;
  }
});

test('applyLegacyStarredProjectIds 带 userId 时写调用者自己的行且幂等', () => {
  const originalGetProjectById = projectsDb.getProjectById;
  const originalIsStarredByUser = projectsDb.isProjectStarredByUser;
  const originalSetStarForUser = projectsDb.setProjectStarForUser;

  const written: Array<{ projectId: string; userId: number }> = [];

  try {
    projectsDb.getProjectById = (projectId: string) =>
      projectId === 'missing'
        ? null
        : ({
            project_id: projectId,
            project_path: `/workspace/${projectId}`,
            custom_project_name: projectId,
            isStarred: 0,
            isArchived: 0,
            owner_user_id: null,
            visibility: null,
          }) as ProjectRow;
    projectsDb.isProjectStarredByUser = (projectId: string) => projectId === 'already';
    projectsDb.setProjectStarForUser = (projectId: string, userId: number) => {
      written.push({ projectId, userId });
    };

    const { updated } = applyLegacyStarredProjectIds(['p1', 'already', 'missing', 'p1'], 9);
    assert.equal(updated, 1); // already 跳过、missing 跳过、p1 去重后一次
    assert.deepEqual(written, [{ projectId: 'p1', userId: 9 }]);
  } finally {
    projectsDb.getProjectById = originalGetProjectById;
    projectsDb.isProjectStarredByUser = originalIsStarredByUser;
    projectsDb.setProjectStarForUser = originalSetStarForUser;
  }
});
