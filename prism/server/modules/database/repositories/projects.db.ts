import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { getConnection } from '@/modules/database/connection.js';
import type { CreateProjectPathResult, ProjectRepositoryRow } from '@/shared/types.js';
import { normalizeProjectPath } from '@/shared/utils.js';

/**
 * SQL 片段:一个无主项目的 `project_path` 算不算"公共目录下"。
 *
 * 必须和 JS 侧 `isPublicWorkspacePath` 逐字同义 —— 词法前缀判定:等于公共根,
 * 或以「根 + 分隔符」开头。公共目录未配置时返回恒假(`0`),于是无主项目对
 * 非 root 一个都不出现。用 resolve 归一化,和 JS 侧一致(DB 里的路径建项目时
 * 已 resolve,这里再归一一次以防万一)。
 *
 * LIKE 的通配符(% _)要转义:公共根路径里若含这些字符,不转义会变成通配。
 * 用 `\` 作转义符并在 SQL 里声明 `ESCAPE '\'`。
 */
function buildPublicPathClause(): { sql: string; params: string[] } {
    const configured = process.env.PRISM_PUBLIC_WORKSPACE;
    if (!configured || !configured.trim()) {
        return { sql: '0', params: [] };
    }
    const root = path.resolve(configured.trim());
    const escaped = root.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    // project_path = 根  或  project_path LIKE 根 + 分隔符 + '%'
    return {
        sql: `(project_path = ? OR project_path LIKE ? ESCAPE '\\')`,
        params: [root, `${escaped}${path.sep}%`],
    };
}

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
        visibility: 'public' | null = null,
    ): CreateProjectPathResult {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        const normalizedProjectName = normalizeProjectDisplayName(normalizedProjectPath, customProjectName);
        const attemptedId = randomUUID();
        // ON CONFLICT 分支不碰 owner_user_id / visibility:复活归档路径不得改归属与权限。
        const row = db.prepare(`
        INSERT INTO projects (project_id, project_path, custom_project_name, isArchived, owner_user_id, visibility)
            VALUES (?, ?, ?, 0, ?, ?)
            ON CONFLICT(project_path) DO UPDATE SET
            isArchived = 0
            WHERE projects.isArchived = 1
            RETURNING project_id, project_path, custom_project_name, isStarred, isArchived, owner_user_id, visibility
        `).get(attemptedId, normalizedProjectPath, normalizedProjectName, ownerUserId, visibility) as ProjectRepositoryRow | undefined;

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
            SELECT project_id, project_path, custom_project_name, isStarred, isArchived, owner_user_id, visibility
            FROM projects
            WHERE project_path = ?
        `).get(normalizedProjectPath) as ProjectRepositoryRow | undefined;

        return row ?? null;
    },

    getProjectById(projectId: string): ProjectRepositoryRow | null {
        const db = getConnection();
        const row = db.prepare(`
            SELECT project_id, project_path, custom_project_name, isStarred, isArchived, owner_user_id, visibility
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
     * `visibleTo` scopes the list to one account. Pass `null` for the
     * unfiltered list — that is what root gets, and what every caller with no
     * user context (the session watcher, maintenance jobs) gets.
     *
     * 无主项目的口径(2026-08-14 改)—— 不再一律公开:一个非 root 账号看到的
     * 无主项目**只有落在公共目录(PRISM_PUBLIC_WORKSPACE)之下的那些**,其余
     * 无主项目仅 root 可见。这必须和 JS 侧 `canViewerSeeProject` 逐字一致,
     * 否则列表和逐路由校验会漂移;`project-visibility-parity` 测试盯着这一点。
     * 公共目录未配置时,`buildPublicPathClause` 返回一个恒假条件,于是无主项目
     * 对非 root 完全不可见 —— 正是要的默认。
     */
    getProjectPaths(visibleTo: number | null = null): ProjectRepositoryRow[] {
        const db = getConnection();
        if (visibleTo === null) {
            return db.prepare(`
                SELECT project_id, project_path, custom_project_name, isStarred, isArchived, owner_user_id, visibility
                FROM projects
                WHERE isArchived = 0
            `).all() as ProjectRepositoryRow[];
        }

        // 与 JS 侧 canViewerSeeProject 逐字同义(parity 测试盯着):
        // 本人的 OR 显式公共 OR 被指定授权 OR (无主且在公共目录下)。
        const publicClause = buildPublicPathClause();
        return db.prepare(`
            SELECT project_id, project_path, custom_project_name, isStarred, isArchived, owner_user_id, visibility
            FROM projects
            WHERE isArchived = 0 AND (
                owner_user_id = ?
                OR visibility = 'public'
                OR project_id IN (SELECT project_id FROM project_shares WHERE user_id = ?)
                OR (owner_user_id IS NULL AND ${publicClause.sql})
            )
        `).all(visibleTo, visibleTo, ...publicClause.params) as ProjectRepositoryRow[];
    },

    /**
     * Archived rows are queried separately so archive-focused UIs can present
     * hidden workspaces without reintroducing them into the active sidebar list.
     * Same `visibleTo` contract as `getProjectPaths` (incl. the public-dir rule).
     */
    getArchivedProjectPaths(visibleTo: number | null = null): ProjectRepositoryRow[] {
        const db = getConnection();
        if (visibleTo === null) {
            return db.prepare(`
                SELECT project_id, project_path, custom_project_name, isStarred, isArchived, owner_user_id, visibility
                FROM projects
                WHERE isArchived = 1
            `).all() as ProjectRepositoryRow[];
        }

        const publicClause = buildPublicPathClause();
        return db.prepare(`
            SELECT project_id, project_path, custom_project_name, isStarred, isArchived, owner_user_id, visibility
            FROM projects
            WHERE isArchived = 1 AND (
                owner_user_id = ?
                OR visibility = 'public'
                OR project_id IN (SELECT project_id FROM project_shares WHERE user_id = ?)
                OR (owner_user_id IS NULL AND ${publicClause.sql})
            )
        `).all(visibleTo, visibleTo, ...publicClause.params) as ProjectRepositoryRow[];
    },

    /** 被指定授权可见这个项目的用户 id 列表(project_shares)。 */
    getProjectSharedUserIds(projectId: string): number[] {
        const db = getConnection();
        const rows = db.prepare(`
            SELECT user_id FROM project_shares WHERE project_id = ?
        `).all(projectId) as Array<{ user_id: number }>;
        return rows.map((row) => row.user_id);
    },

    /**
     * 整组替换一个项目的指定用户授权(创建「指定用户」项目时写入)。
     * 事务内先清后插,幂等;granted_by 记录授权人便于审计。
     */
    setProjectShares(projectId: string, userIds: number[], grantedBy: number | null = null): void {
        const db = getConnection();
        const uniqueIds = [...new Set(userIds)].filter((id) => Number.isInteger(id));
        const replace = db.transaction(() => {
            db.prepare('DELETE FROM project_shares WHERE project_id = ?').run(projectId);
            const insert = db.prepare(
                'INSERT INTO project_shares (project_id, user_id, granted_by) VALUES (?, ?, ?)',
            );
            for (const userId of uniqueIds) {
                insert.run(projectId, userId, grantedBy);
            }
        });
        replace();
    },

    /** 某用户收藏的全部项目 id(project_stars,按用户隔离)。 */
    getStarredProjectIdsForUser(userId: number): string[] {
        const db = getConnection();
        const rows = db.prepare(`
            SELECT project_id FROM project_stars WHERE user_id = ?
        `).all(userId) as Array<{ project_id: string }>;
        return rows.map((row) => row.project_id);
    },

    /** 该用户是否收藏了该项目。 */
    isProjectStarredByUser(projectId: string, userId: number): boolean {
        const db = getConnection();
        const row = db.prepare(`
            SELECT 1 AS present FROM project_stars WHERE project_id = ? AND user_id = ?
        `).get(projectId, userId);
        return row !== undefined;
    },

    /** 写该用户对该项目的收藏状态。幂等(重复收藏/取消都安全)。 */
    setProjectStarForUser(projectId: string, userId: number, starred: boolean): void {
        const db = getConnection();
        if (starred) {
            db.prepare(`
                INSERT OR IGNORE INTO project_stars (project_id, user_id) VALUES (?, ?)
            `).run(projectId, userId);
        } else {
            db.prepare(`
                DELETE FROM project_stars WHERE project_id = ? AND user_id = ?
            `).run(projectId, userId);
        }
    },

    /** Owner of a project, or null when it is public. Undefined = no such project. */
    getProjectOwner(projectId: string): number | null | undefined {
        const db = getConnection();
        const row = db.prepare(`
            SELECT owner_user_id FROM projects WHERE project_id = ?
        `).get(projectId) as { owner_user_id: number | null } | undefined;

        return row ? row.owner_user_id : undefined;
    },

    /** 显式可见性:'public' 或 null(默认语义)。false = 无此项目。 */
    setProjectVisibility(projectId: string, visibility: 'public' | null): boolean {
        const db = getConnection();
        const result = db.prepare(`
            UPDATE projects SET visibility = ? WHERE project_id = ?
        `).run(visibility, projectId);

        return result.changes > 0;
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
