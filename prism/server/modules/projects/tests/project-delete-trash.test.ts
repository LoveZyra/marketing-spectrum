import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * gk:永久删除项目 —— 会话逐条进最近删除、整体预检、权限、审计。
 *
 * 此前 force 删项目是"unlink 全部 transcript + DELETE 全部会话行",完全不看有没有在跑。
 * 现在:任何一条在用 → 整个拒绝、一条不动;否则逐条走单条删除同一条路(可恢复)。
 */
let tempDir: string;
let db: typeof import('@/modules/database/index.js');
let providers: typeof import('@/modules/providers/index.js');
let projects: typeof import('@/modules/projects/services/project-delete.service.js');
let bulk: typeof import('@/modules/projects/services/project-bulk.service.js');
let websocket: typeof import('@/modules/websocket/index.js');

const previousEnv = {
  DATABASE_PATH: process.env.DATABASE_PATH,
  PRISM_DATA_DIR: process.env.PRISM_DATA_DIR,
  PRISM_ROOT_USERS: process.env.PRISM_ROOT_USERS,
  PRISM_PUBLIC_WORKSPACE: process.env.PRISM_PUBLIC_WORKSPACE,
};

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-project-trash-'));
  process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');
  process.env.PRISM_DATA_DIR = path.join(tempDir, 'data');
  process.env.PRISM_ROOT_USERS = 'boss';
  delete process.env.PRISM_PUBLIC_WORKSPACE;
  db = await import('@/modules/database/index.js');
  db.initializeDatabase();
  providers = await import('@/modules/providers/index.js');
  projects = await import('@/modules/projects/services/project-delete.service.js');
  bulk = await import('@/modules/projects/services/project-bulk.service.js');
  websocket = await import('@/modules/websocket/index.js');
  providers.setSessionRuntimeReleaser(async () => ({ released: true }));
});

afterAll(() => {
  providers?.setSessionRuntimeReleaser(null);
  try { db?.closeConnection?.(); } catch { /* ignore */ }
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

let owner: number;
let colleague: number;
let projectPath: string;
let projectId: string;

beforeEach(() => {
  const conn = db.getConnection();
  for (const table of ['session_trash_messages', 'session_trash', 'session_display_messages', 'sessions', 'project_shares', 'projects', 'audit_log', 'users']) {
    conn.prepare(`DELETE FROM ${table}`).run();
  }
  owner = Number(db.userDb.createUser('owner', 'h').id);
  colleague = Number(db.userDb.createUser('colleague', 'h').id);
  projectPath = path.join(tempDir, 'ws', `p-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(projectPath, { recursive: true });
  projectId = db.projectsDb.createProjectPath(projectPath, '报告', owner).project!.project_id;
  db.projectsDb.setProjectShares(projectId, [colleague], owner);
  db.sessionsDb.createAppSession('s1', 'claude', projectPath, owner);
  db.sessionsDb.createAppSession('s2', 'claude', projectPath, owner);
  conn.prepare("UPDATE sessions SET custom_name = '甲' WHERE session_id = 's1'").run();
  conn.prepare("UPDATE sessions SET custom_name = '乙', isArchived = 1 WHERE session_id = 's2'").run();
});

const audit = () => db.getConnection().prepare('SELECT event, detail, target_user_id FROM audit_log ORDER BY id').all() as Array<{ event: string; detail: string; target_user_id: number | null }>;

describe('永久删除项目', () => {
  it('所有会话(含归档的)进最近删除,项目行删掉,审计一条 project_deleted 带 owner', async () => {
    await projects.deleteOrArchiveProject(projectId, true, { userId: owner, username: 'owner' });

    expect(db.projectsDb.getProjectById(projectId)).toBeNull();
    expect(db.sessionsDb.getSessionById('s1')).toBeNull();
    expect(db.sessionsDb.getSessionById('s2')).toBeNull();
    expect(db.sessionTrashDb.get('s1')?.deleted_via).toBe('project');
    expect(db.sessionTrashDb.get('s2')?.isArchived).toBe(1);
    expect(db.sessionTrashDb.get('s2')?.project_owner_user_id).toBe(owner);

    const events = audit().map((row) => row.event);
    expect(events.filter((event) => event === 'session_deleted')).toHaveLength(2);
    const projectRow = audit().find((row) => row.event === 'project_deleted')!;
    expect(projectRow.target_user_id).toBe(owner);
    expect(JSON.parse(projectRow.detail)).toMatchObject({ entry: 'project', count: 2, names: ['甲', '乙'] });
  });

  it('有会话正在跑 → 整个拒绝(409),一条会话、项目行都不动', async () => {
    const run = websocket.chatRunRegistry.startRun({
      appSessionId: 's1', provider: 'claude', providerSessionId: null, connection: null, userId: owner,
    });
    expect(run).not.toBeNull();
    try {
      await expect(projects.deleteOrArchiveProject(projectId, true, { userId: owner, username: 'owner' }))
        .rejects.toMatchObject({ code: 'PROJECT_HAS_ACTIVE_SESSIONS' });
      expect(db.projectsDb.getProjectById(projectId)).not.toBeNull();
      expect(db.sessionsDb.getSessionById('s1')).not.toBeNull();
      expect(db.sessionsDb.getSessionById('s2')).not.toBeNull();
      expect(db.sessionTrashDb.count()).toBe(0);
      expect(audit()).toEqual([]);
    } finally {
      websocket.chatRunRegistry.completeRunIfCurrent(run!, { exitCode: 0 });
    }
  });

  it('归档项目只翻标记,记 project_archived', async () => {
    await projects.deleteOrArchiveProject(projectId, false, { userId: owner, username: 'owner' });
    expect(db.projectsDb.getProjectById(projectId)?.isArchived).toBe(1);
    expect(db.sessionsDb.getSessionById('s1')).not.toBeNull();
    expect(audit().map((row) => row.event)).toEqual(['project_archived']);
  });

  /**
   * 预检之后、循环当中才开始的新回合(每条都 await,中间有真空)。
   * 这一条钉住:**不许把它硬删掉**。上一版靠后面的 `deleteSessionsByProjectPath`
   * 兜底,那等于连显示日志一起删 —— 回收站里没副本、没审计、runtime 没收,
   * 正是 gk 要消灭的那种"东西凭空没了"。现在停下来报 409,已进回收站的可恢复。
   */
  it('循环中途一条会话开始新回合 → 停下来报 409,不硬删它,项目行留着', async () => {
    const conn = db.getConnection();
    db.sessionsDb.createAppSession('s3', 'claude', projectPath, owner);
    conn.prepare("UPDATE sessions SET custom_name = '丙' WHERE session_id = 's3'").run();
    conn.prepare("INSERT INTO session_display_messages (session_id, message_id, kind, timestamp, payload) VALUES ('s3', 'm1', 'text', 't', '{}')").run();

    // 预检看的是删除之前的状态;这里让 s3 在 s1 删到"收 runtime"那一步时才变成"在跑"
    // (收 runtime 只在这条会话有 provider id 时才走,所以给 s1 补一个)。
    conn.prepare("UPDATE sessions SET provider_session_id = 'prov-s1' WHERE session_id = 's1'").run();
    let started: ReturnType<typeof websocket.chatRunRegistry.startRun> = null;
    const releaser = providers.setSessionRuntimeReleaser;
    releaser(async () => {
      if (!started) {
        started = websocket.chatRunRegistry.startRun({
          appSessionId: 's3', provider: 'claude', providerSessionId: null, connection: null, userId: owner,
        });
      }
      return { released: true };
    });

    try {
      await expect(projects.deleteOrArchiveProject(projectId, true, { userId: owner, username: 'owner' }))
        .rejects.toMatchObject({ code: 'PROJECT_HAS_ACTIVE_SESSIONS' });
      // 跑着的那条完好无损:行、显示日志都在,回收站里没有它
      expect(db.sessionsDb.getSessionById('s3')).not.toBeNull();
      expect(db.sessionTrashDb.get('s3')).toBeNull();
      expect(conn.prepare("SELECT COUNT(*) AS n FROM session_display_messages WHERE session_id = 's3'").get()).toEqual({ n: 1 });
      // 项目行留着,先删掉的那些在回收站里可恢复
      expect(db.projectsDb.getProjectById(projectId)).not.toBeNull();
      expect(db.sessionTrashDb.get('s1')).not.toBeNull();
      expect(audit().some((row) => row.event === 'project_deleted')).toBe(false);
    } finally {
      if (started) websocket.chatRunRegistry.completeRunIfCurrent(started, { exitCode: 0 });
      releaser(async () => ({ released: true }));
    }
  });

  /**
   * gn:**归档也跳过了。**
   *
   * gk 这条原来断言的是"删除跳过、**归档照常**" —— 归档当时是"看得见就能做",
   * 与会话归档同口径。2026-09-15 用非 root 账号实测才看清:项目归档和会话归档
   * 不是一回事,归档一个项目它会从**所有人**的活跃侧栏里消失,而按钮上没有任何
   * "这不是你的项目"的提示。收紧到与永久删除同一条规则之后,这条断言跟着改。
   *
   * 无主项目不受影响(没有"负责人"这一档,看得见就能归档),那一条在
   * projects-authz.test.ts 里钉着。
   */
  it('批量:被共享过来的项目,删除与归档都跳过(not-manageable)', async () => {
    const asColleague = { userId: colleague, username: 'colleague' };
    const actor = { id: colleague, username: 'colleague', isRoot: false };
    const del = await bulk.bulkProjectAction({ action: 'delete', projectIds: [projectId] }, asColleague, actor);
    expect(del.skipped).toEqual([{ projectId, reason: 'not-manageable' }]);
    expect(db.projectsDb.getProjectById(projectId)).not.toBeNull();

    const arc = await bulk.bulkProjectAction({ action: 'archive', projectIds: [projectId] }, asColleague, actor);
    expect(arc.succeeded).toEqual([]);
    expect(arc.skipped).toEqual([{ projectId, reason: 'not-manageable' }]);
    // 项目仍在活跃列表里 —— 没被别人归档掉
    expect(db.projectsDb.getProjectById(projectId)?.isArchived).toBeFalsy();
  });
});
