import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { getConnection } from '@/modules/database/connection.js';
import type { CreateProjectPathResult, ProjectRepositoryRow } from '@/shared/types.js';
import { normalizeProjectPath } from '@/shared/utils.js';

function normalizeProjectDisplayName(projectPath: string, customProjectName: string | null): string {
    const trimmedCustomName = typeof customProjectName === 'string' ? customProjectName.trim() : '';
    if (trimmedCustomName.length > 0) {
        return trimmedCustomName;
    }

    const directoryName = path.basename(projectPath);
    return directoryName || projectPath;
}

export const projectsDb = {
    /**
     * `ownerUserId` defaults to NULL, i.e. public. That default is what the
     * session watcher gets when it registers a path it found on disk — such a
     * project was already sitting in a shared filesystem and belongs to nobody
     * in particular. The create-project route passes the caller's id instead.
     *
     * The ON CONFLICT branch deliberately leaves `owner_user_id` alone:
     * re-registering an archived path must not silently reassign it.
     */
    createProjectPath(
        projectPath: string,
        customProjectName: string | null = null,
        ownerUserId: number | null = null,
    ): CreateProjectPathResult {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        const normalizedProjectName = normalizeProjectDisplayName(normalizedProjectPath, customProjectName);
        const attemptedId = randomUUID();
        const row = db.prepare(`
        INSERT INTO projects (project_id, project_path, custom_project_name, isArchived, owner_user_id)
            VALUES (?, ?, ?, 0, ?)
            ON CONFLICT(project_path) DO UPDATE SET
            isArchived = 0
            WHERE projects.isArchived = 1
            RETURNING project_id, project_path, custom_project_name, isStarred, isArchived, owner_user_id
        `).get(attemptedId, normalizedProjectPath, normalizedProjectName, ownerUserId) as ProjectRepositoryRow | undefined;

        if (row) {
            return {
                outcome: row.project_id === attemptedId ? 'created' : 'reactivated_archived',
                project: row,
            };
        }

        const existingProject = projectsDb.getProjectPath(normalizedProjectPath);
        return {
            outcome: 'active_conflict',
            project: existingProject,
        };
    },

    getProjectPath(projectPath: string): ProjectRepositoryRow | null {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        const row = db.prepare(`
            SELECT project_id, project_path, custom_project_name, isStarred, isArchived, owner_user_id
            FROM projects
            WHERE project_path = ?
        `).get(normalizedProjectPath) as ProjectRepositoryRow | undefined;

        return row ?? null;
    },

    getProjectById(projectId: string): ProjectRepositoryRow | null {
        const db = getConnection();
        const row = db.prepare(`
            SELECT project_id, project_path, custom_project_name, isStarred, isArchived, owner_user_id
            FROM projects
            WHERE project_id = ?
        `).get(projectId) as ProjectRepositoryRow | undefined;

        return row ?? null;
    },

    /**
     * Resolve the absolute project directory from a database project_id.
     *
     * This is the canonical lookup used after the projectName → projectId migration:
     * API routes receive the DB-assigned `projectId` and must resolve the real folder
     * path through this helper before touching the filesystem. Returns `null` when the
     * project row does not exist so callers can respond with a 404.
     */
    getProjectPathById(projectId: string): string | null {
        const db = getConnection();
        const row = db.prepare(`
            SELECT project_path
            FROM projects
            WHERE project_id = ?
        `).get(projectId) as Pick<ProjectRepositoryRow, 'project_path'> | undefined;

        return row?.project_path ?? null;
    },

    /**
     * `visibleTo` scopes the list to one account: its own projects plus the
     * public ones (`owner_user_id IS NULL`). Pass `null` for the unfiltered
     * list — that is what root gets, and what every caller that has no user
     * context (the session watcher, maintenance jobs) gets.
     */
    getProjectPaths(visibleTo: number | null = null): ProjectRepositoryRow[] {
        const db = getConnection();
        if (visibleTo === null) {
            return db.prepare(`
                SELECT project_id, project_path, custom_project_name, isStarred, isArchived, owner_user_id
                FROM projects
                WHERE isArchived = 0
            `).all() as ProjectRepositoryRow[];
        }

        return db.prepare(`
            SELECT project_id, project_path, custom_project_name, isStarred, isArchived, owner_user_id
            FROM projects
            WHERE isArchived = 0 AND (owner_user_id = ? OR owner_user_id IS NULL)
        `).all(visibleTo) as ProjectRepositoryRow[];
    },

    /**
     * Archived rows are queried separately so archive-focused UIs can present
     * hidden workspaces without reintroducing them into the active sidebar list.
     * Same `visibleTo` contract as `getProjectPaths`.
     */
    getArchivedProjectPaths(visibleTo: number | null = null): ProjectRepositoryRow[] {
        const db = getConnection();
        if (visibleTo === null) {
            return db.prepare(`
                SELECT project_id, project_path, custom_project_name, isStarred, isArchived, owner_user_id
                FROM projects
                WHERE isArchived = 1
            `).all() as ProjectRepositoryRow[];
        }

        return db.prepare(`
            SELECT project_id, project_path, custom_project_name, isStarred, isArchived, owner_user_id
            FROM projects
            WHERE isArchived = 1 AND (owner_user_id = ? OR owner_user_id IS NULL)
        `).all(visibleTo) as ProjectRepositoryRow[];
    },

    /** Owner of a project, or null when it is public. Undefined = no such project. */
    getProjectOwner(projectId: string): number | null | undefined {
        const db = getConnection();
        const row = db.prepare(`
            SELECT owner_user_id FROM projects WHERE project_id = ?
        `).get(projectId) as { owner_user_id: number | null } | undefined;

        return row ? row.owner_user_id : undefined;
    },

    /** Reassigns a project. `null` makes it public. False when the id matches nothing. */
    setProjectOwner(projectId: string, ownerUserId: number | null): boolean {
        const db = getConnection();
        const result = db.prepare(`
            UPDATE projects SET owner_user_id = ? WHERE project_id = ?
        `).run(ownerUserId, projectId);

        return result.changes > 0;
    },

    /**
     * One-shot backfill: hand every unowned project to the given account.
     *
     * Runs at startup rather than in the migration because the root account may
     * not exist yet when migrations run. Guarded by an app_config flag at the
     * call site, so a project later made public is not clawed back on the next
     * boot. Returns how many rows changed hands.
     */
    assignUnownedProjectsTo(ownerUserId: number): number {
        const db = getConnection();
        const result = db.prepare(`
            UPDATE projects SET owner_user_id = ? WHERE owner_user_id IS NULL
        `).run(ownerUserId);

        return result.changes;
    },

    getCustomProjectName(projectPath: string): string | null {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        const row = db.prepare(`
            SELECT custom_project_name
            FROM projects
            WHERE project_path = ?
        `).get(normalizedProjectPath) as Pick<ProjectRepositoryRow, 'custom_project_name'> | undefined;

        return row?.custom_project_name ?? null;
    },

    updateCustomProjectName(projectPath: string, customProjectName: string | null): void {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        db.prepare(`
            INSERT INTO projects (project_id, project_path, custom_project_name)
            VALUES (?, ?, ?)
            ON CONFLICT(project_path) DO UPDATE SET custom_project_name = excluded.custom_project_name
        `).run(randomUUID(), normalizedProjectPath, customProjectName);
    },

    updateCustomProjectNameById(projectId: string, customProjectName: string | null): void {
        const db = getConnection();
        db.prepare(`
            UPDATE projects
            SET custom_project_name = ?
            WHERE project_id = ?
        `).run(customProjectName, projectId);
    },

    updateProjectIsStarred(projectPath: string, isStarred: boolean): void {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        db.prepare(`
            UPDATE projects
            SET isStarred = ?
            WHERE project_path = ?
        `).run(isStarred ? 1 : 0, normalizedProjectPath);
    },

    updateProjectIsStarredById(projectId: string, isStarred: boolean): void {
        const db = getConnection();
        db.prepare(`
            UPDATE projects
            SET isStarred = ?
            WHERE project_id = ?
        `).run(isStarred ? 1 : 0, projectId);
    },

    updateProjectIsArchived(projectPath: string, isArchived: boolean): void {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        db.prepare(`
            UPDATE projects
            SET isArchived = ?
            WHERE project_path = ?
        `).run(isArchived ? 1 : 0, normalizedProjectPath);
    },

    updateProjectIsArchivedById(projectId: string, isArchived: boolean): void {
        const db = getConnection();
        db.prepare(`
            UPDATE projects
            SET isArchived = ?
            WHERE project_id = ?
        `).run(isArchived ? 1 : 0, projectId);
    },

    deleteProjectPath(projectPath: string): void {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        db.prepare(`
            DELETE FROM projects
            WHERE project_path = ?
        `).run(normalizedProjectPath);
    },

    deleteProjectById(projectId: string): void {
        const db = getConnection();
        db.prepare(`
            DELETE FROM projects
            WHERE project_id = ?
        `).run(projectId);
    },
};
