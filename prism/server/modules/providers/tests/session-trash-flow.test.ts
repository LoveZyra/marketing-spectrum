import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * gk:永久删除的整条链 —— 收 runtime → 行 + 显示日志进回收站 → transcript 搬走 →
 * 审计(带 target_user_id)→ 给看得见的人推 `session_removed` → 恢复原样搬回。
 *
 * 用真库、真文件、真的 websocket 连接集合(塞一个假 socket 进 `connectedClients`),
 * 只有 runtime 释放是注入的。每一条都对应 2026-09-14 事故链上的一个断点:
 *   - 删的时候 runtime 还活着 → 这里先收,收不掉就拒绝
 *   - 删了找不回 → 回收站里全在,恢复后逐字相同
 *   - 谁删的查不出来 → 审计行 + 回收站行都记了操作者
 *   - 开着的页面不知道 → session_removed 帧
 *   - 谁都能删 → 共享用户 403、批量跳过
 */
let tempDir: string;
let db: typeof import('@/modules/database/index.js');
let providers: typeof import('@/modules/providers/index.js');
let websocket: typeof import('@/modules/websocket/index.js');

const previousEnv = {
  DATABASE_PATH: process.env.DATABASE_PATH,
  PRISM_DATA_DIR: process.env.PRISM_DATA_DIR,
  PRISM_ROOT_USERS: process.env.PRISM_ROOT_USERS,
};

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-trash-flow-'));
  process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');
  process.env.PRISM_DATA_DIR = path.join(tempDir, 'data');
  process.env.PRISM_ROOT_USERS = 'boss';
  db = await import('@/modules/database/index.js');
  db.initializeDatabase();
  providers = await import('@/modules/providers/index.js');
  websocket = await import('@/modules/websocket/index.js');
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

let owner: { id: number; username: string };
let sharedUser: { id: number; username: string };
let deleter: { id: number; username: string };
let projectPath: string;
let transcriptPath: string;

const viewerOf = (user: { id: number; username: string }) => ({ userId: user.id, username: user.username });

beforeEach(() => {
  const conn = db.getConnection();
  for (const table of ['session_trash_messages', 'session_trash', 'session_display_messages', 'session_display_log_state', 'sessions', 'project_shares', 'projects', 'audit_log', 'users']) {
    conn.prepare(`DELETE FROM ${table}`).run();
  }
  websocket.connectedClients.clear();
  providers.setSessionRuntimeReleaser(null);

  owner = { id: Number(db.userDb.createUser('owner', 'hash').id), username: 'owner' };
  sharedUser = { id: Number(db.userDb.createUser('colleague', 'hash').id), username: 'colleague' };
  deleter = owner;

  projectPath = path.join(tempDir, 'workspace', `proj-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(projectPath, { recursive: true });
  db.projectsDb.createProjectPath(projectPath, '国庆报告', owner.id);
  const project = db.projectsDb.getProjectPath(projectPath)!;
  db.projectsDb.setProjectShares(project.project_id, [sharedUser.id], owner.id);

  // 一条跑过的会话:app id ≠ provider id,transcript 与同名目录都在
  db.sessionsDb.createAppSession('s1', 'claude', projectPath, owner.id);
  const claudeDir = path.join(tempDir, 'claude-projects', path.basename(projectPath));
  fs.mkdirSync(path.join(claudeDir, 'p1', 'tool-results'), { recursive: true });
  transcriptPath = path.join(claudeDir, 'p1.jsonl');
  fs.writeFileSync(transcriptPath, `{"type":"user","cwd":"${projectPath}","sessionId":"p1"}\n{"type":"assistant","sessionId":"p1"}\n`);
  fs.writeFileSync(path.join(claudeDir, 'p1', 'tool-results', 'x.txt'), 'big output');
  conn.prepare('UPDATE sessions SET provider_session_id = ?, jsonl_path = ?, custom_name = ? WHERE session_id = ?')
    .run('p1', transcriptPath, '胡萍', 's1');
  const insert = conn.prepare('INSERT INTO session_display_messages (session_id, message_id, kind, timestamp, payload) VALUES (?, ?, ?, ?, ?)');
  insert.run('s1', 'u1', 'text', '2026-09-14T10:00:00Z', JSON.stringify({ role: 'user', content: '生成报告' }));
  insert.run('s1', 'a1', 'text', '2026-09-14T10:00:05Z', JSON.stringify({ role: 'assistant', content: '好的' }));
});

const fakeSocket = (user: { id: number; username: string }) => {
  const frames: Array<Record<string, unknown>> = [];
  const socket = {
    readyState: 1,
    prismUserId: user.id,
    prismUsername: user.username,
    send: (data: string) => { frames.push(JSON.parse(data) as Record<string, unknown>); },
  };
  websocket.connectedClients.add(socket);
  return frames;
};

const auditRows = () => db.getConnection()
  .prepare('SELECT event, user_id, username, target_user_id, detail FROM audit_log ORDER BY id')
  .all() as Array<{ event: string; user_id: number | null; username: string | null; target_user_id: number | null; detail: string | null }>;

describe('永久删除 → 最近删除', () => {
  it('整条链:收 runtime、行与日志进回收站、transcript 搬走、审计带 target、推 session_removed', async () => {
    const released: string[] = [];
    providers.setSessionRuntimeReleaser(async (providerSessionId) => { released.push(providerSessionId); return { released: true }; });
    const ownerFrames = fakeSocket(owner);
    const strangerFrames = fakeSocket({ id: 999, username: 'stranger' });

    const result = await providers.sessionsService.deleteOrArchiveSessionById('s1', {
      force: true, deletedFromDisk: true, actor: { ...viewerOf(deleter), ip: '10.0.0.1', userAgent: 'vitest' }, via: 'session',
    });

    expect(result).toEqual({ sessionId: 's1', action: 'deleted', deletedFromDisk: true });
    expect(released).toEqual(['p1']);

    // 活表空了,回收站里全在
    expect(db.sessionsDb.getSessionById('s1')).toBeNull();
    const trashed = db.sessionTrashDb.get('s1')!;
    expect(trashed.deleted_by_username).toBe('owner');
    expect(trashed.message_count).toBe(2);
    expect(trashed.project_owner_user_id).toBe(owner.id);

    // transcript 与同名目录都在回收站目录里,原地没有了
    expect(fs.existsSync(transcriptPath)).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(transcriptPath), 'p1'))).toBe(false);
    expect(trashed.trash_jsonl_path).toMatch(new RegExp(`^${path.join(tempDir, 'data', 'trash').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    expect(fs.readFileSync(trashed.trash_jsonl_path!, 'utf8')).toContain('"sessionId":"p1"');
    expect(fs.existsSync(path.join(trashed.trash_dir_path!, 'tool-results', 'x.txt'))).toBe(true);

    // 审计:谁、对谁、删了什么
    const audit = auditRows().find((row) => row.event === 'session_deleted')!;
    expect(audit.username).toBe('owner');
    expect(audit.target_user_id).toBe(owner.id);
    const detail = JSON.parse(audit.detail!) as Record<string, unknown>;
    expect(detail.sessionName).toBe('胡萍');
    expect(detail.entry).toBe('session');
    expect(detail.transcriptMoved).toBe(true);

    // 看得见的人收到帧,陌生人没有
    expect(ownerFrames.filter((frame) => frame.kind === 'session_removed')).toEqual([
      expect.objectContaining({ sessionId: 's1', reason: 'deleted', deletedBy: 'owner', sessionName: '胡萍', restorable: true }),
    ]);
    expect(strangerFrames).toEqual([]);
  });

  it('runtime 收不掉(回合在飞)→ 409,行、文件、审计一样都不动', async () => {
    providers.setSessionRuntimeReleaser(async () => ({ released: false, reason: 'turn_in_flight' }));
    await expect(providers.sessionsService.deleteOrArchiveSessionById('s1', { force: true, actor: viewerOf(owner) }))
      .rejects.toMatchObject({ code: 'SESSION_RUN_IN_PROGRESS' });
    expect(db.sessionsDb.getSessionById('s1')).not.toBeNull();
    expect(db.sessionTrashDb.get('s1')).toBeNull();
    expect(fs.existsSync(transcriptPath)).toBe(true);
    expect(auditRows()).toEqual([]);
  });

  /**
   * **收不掉 ≠ 在跑。** dispose 自己抛错时(传输已经关了之类)releaseClaudeSession
   * 也返回 `released:false`,reason 是 `error`。把这一类也当 409 的后果是:一个
   * dispose 坏掉的 runtime 让这条会话**永远删不掉**,而用户看到的是"它没在跑啊"。
   */
  it('runtime 收不掉但不是回合在飞(dispose 抛错)→ 照常删除,只记一行', async () => {
    providers.setSessionRuntimeReleaser(async () => ({ released: false, reason: 'error' }));
    const result = await providers.sessionsService.deleteOrArchiveSessionById('s1', {
      force: true, deletedFromDisk: true, actor: viewerOf(owner), via: 'session',
    });
    expect(result.action).toBe('deleted');
    expect(db.sessionTrashDb.get('s1')).not.toBeNull();
    expect(fs.existsSync(transcriptPath)).toBe(false);
  });

  it('归档不进回收站,但也记一条审计', async () => {
    const result = await providers.sessionsService.deleteOrArchiveSessionById('s1', { force: false, actor: viewerOf(owner) });
    expect(result.action).toBe('archived');
    expect(db.sessionsDb.getSessionById('s1')?.isArchived).toBe(1);
    expect(auditRows().map((row) => row.event)).toEqual(['session_archived']);
  });

  it('恢复:行、显示日志、transcript 全部回到原位,侧栏收到 session_upserted', async () => {
    providers.setSessionRuntimeReleaser(async () => ({ released: true }));
    await providers.sessionsService.deleteOrArchiveSessionById('s1', { force: true, actor: viewerOf(owner), via: 'session' });
    const ownerFrames = fakeSocket(owner);

    const result = await providers.sessionsService.restoreTrashedSession('s1', viewerOf(owner));
    expect(result).toEqual({ sessionId: 's1', restored: true, transcriptRestored: true });

    const row = db.sessionsDb.getSessionById('s1');
    expect(row?.custom_name).toBe('胡萍');
    expect(row?.provider_session_id).toBe('p1');
    expect(db.sessionMessagesDb.countForSession('s1')).toBe(2);
    expect(fs.existsSync(transcriptPath)).toBe(true);
    expect(fs.existsSync(path.join(path.dirname(transcriptPath), 'p1', 'tool-results', 'x.txt'))).toBe(true);
    expect(db.sessionTrashDb.get('s1')).toBeNull();
    expect(auditRows().map((row) => row.event)).toEqual(['session_deleted', 'session_trash_restored']);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ownerFrames.some((frame) => frame.kind === 'session_upserted' && frame.sessionId === 's1')).toBe(true);
  });

  /**
   * gl:**归档态的会话恢复后,前端也要收到"它回来了"。**
   *
   * gk 这里只发 `session_upserted`,而那条广播带着 `if (row.isArchived) return`
   * 的闸门(侧栏不该让归档会话弹回活跃列表)—— 于是归档态的会话恢复时一帧都不发,
   * 页面永远停在「这条会话已被删除」,输入框回不来,只能刷新
   * (2026-09-15 测试环境实测,稳定复现)。
   *
   * 这一条钉的正是那个分水岭:**活跃态能收到、归档态也必须能收到**。
   */
  it('恢复归档态的会话:照样推 session_restored(gk 在这里一帧都不发)', async () => {
    const conn = db.getConnection();
    providers.setSessionRuntimeReleaser(async () => ({ released: true }));
    // 先归档,再永久删除 —— 回收站行里 isArchived = 1
    conn.prepare("UPDATE sessions SET isArchived = 1 WHERE session_id = 's1'").run();
    await providers.sessionsService.deleteOrArchiveSessionById('s1', {
      force: true, deletedFromDisk: true, actor: viewerOf(owner), via: 'empty_archived',
    });
    expect(db.sessionTrashDb.get('s1')?.isArchived).toBe(1);

    const ownerFrames = fakeSocket(owner);
    const strangerFrames = fakeSocket({ id: 4242, username: 'stranger' });

    await providers.sessionsService.restoreTrashedSession('s1', viewerOf(owner));
    await new Promise((resolve) => setTimeout(resolve, 30));

    // 恢复回来仍是归档态(gk 的正确行为,不动)
    expect(db.sessionsDb.getSessionById('s1')?.isArchived).toBe(1);
    // 侧栏那条照旧被闸门挡住 —— 这正是为什么需要一条独立的帧
    expect(ownerFrames.filter((frame) => frame.kind === 'session_upserted')).toEqual([]);
    // 而「它回来了」必须送到
    expect(ownerFrames.filter((frame) => frame.kind === 'session_restored')).toEqual([
      expect.objectContaining({ sessionId: 's1' }),
    ]);
    // 看不见这条会话的人一帧都不该收到
    expect(strangerFrames.filter((frame) => frame.kind === 'session_restored')).toEqual([]);
  });

  it('删项目之后恢复:项目行按快照建回来,owner 不丢', async () => {
    providers.setSessionRuntimeReleaser(async () => ({ released: true }));
    await providers.sessionsService.deleteOrArchiveSessionById('s1', { force: true, actor: viewerOf(owner), via: 'project' });
    db.getConnection().prepare('DELETE FROM projects WHERE project_path = ?').run(projectPath);

    await providers.sessionsService.restoreTrashedSession('s1', viewerOf(owner));

    const project = db.projectsDb.getProjectPath(projectPath);
    expect(project?.owner_user_id).toBe(owner.id);
    expect(project?.custom_project_name).toBe('国庆报告');
    expect(db.canViewerSeeSession('s1', viewerOf(owner))).toBe(true);
  });

  /**
   * 建回来的项目行**连 visibility 一起**按快照来。丢了它,一个 `public` 项目会
   * 变回默认语义:原来看得见这条会话的人(以及被共享的同事)当场看不到恢复出来的那条。
   * 共享关系随项目行 CASCADE 掉、找不回来 —— 所以至少 public 这一档不能再丢。
   */
  it('删项目之后恢复:visibility=public 的项目照旧是 public(别人还看得见)', async () => {
    const conn = db.getConnection();
    const project = db.projectsDb.getProjectPath(projectPath)!;
    db.projectsDb.setProjectVisibility(project.project_id, 'public');
    providers.setSessionRuntimeReleaser(async () => ({ released: true }));
    await providers.sessionsService.deleteOrArchiveSessionById('s1', { force: true, actor: viewerOf(owner), via: 'project' });
    expect(db.sessionTrashDb.get('s1')?.project_visibility).toBe('public');
    conn.prepare('DELETE FROM projects WHERE project_path = ?').run(projectPath);

    await providers.sessionsService.restoreTrashedSession('s1', viewerOf(owner));

    expect(db.projectsDb.getProjectPath(projectPath)?.visibility).toBe('public');
    expect(db.canViewerSeeSession('s1', { userId: 4242, username: 'passerby' })).toBe(true);
  });

  /**
   * **文件先搬回来,再动库。** 反过来的话,回收站行一提交就没了,而搬运失败时那份
   * transcript 留在 `<trash>/…` 里再没有任何记录指向它(连清扫器都找不到),
   * 而接口回的却是 `restored: true`。
   */
  it('恢复:transcript 搬不回去 → 409,库里一切不动,东西全留在回收站', async () => {
    providers.setSessionRuntimeReleaser(async () => ({ released: true }));
    await providers.sessionsService.deleteOrArchiveSessionById('s1', {
      force: true, deletedFromDisk: true, actor: viewerOf(owner), via: 'session',
    });
    const trashed = db.sessionTrashDb.get('s1')!;
    // 老路径被一个非空目录占住:rename 与复制都必然失败
    fs.mkdirSync(transcriptPath, { recursive: true });
    fs.writeFileSync(path.join(transcriptPath, 'blocker'), 'x');

    await expect(providers.sessionsService.restoreTrashedSession('s1', viewerOf(owner)))
      .rejects.toMatchObject({ code: 'SESSION_RESTORE_FILE_FAILED' });

    expect(db.sessionsDb.getSessionById('s1')).toBeNull();
    expect(db.sessionTrashDb.get('s1')).not.toBeNull();
    expect(fs.existsSync(trashed.trash_jsonl_path!)).toBe(true);
    expect(db.getConnection().prepare("SELECT COUNT(*) AS n FROM session_trash_messages WHERE session_id = 's1'").get()).toEqual({ n: 2 });
  });

  it('权限:共享用户看得见但不能永久删(403);批量删除时被跳过;归档照常', async () => {
    expect(db.canViewerSeeSession('s1', viewerOf(sharedUser))).toBe(true);
    expect(() => providers.sessionsService.assertViewerMayPermanentlyDelete('s1', viewerOf(sharedUser)))
      .toThrow(expect.objectContaining({ code: 'SESSION_DELETE_FORBIDDEN' }));
    expect(() => providers.sessionsService.assertViewerMayPermanentlyDelete('s1', viewerOf(owner))).not.toThrow();
    expect(() => providers.sessionsService.assertViewerMayPermanentlyDelete('s1', { userId: 42, username: 'boss' })).not.toThrow();

    const bulk = await providers.sessionsService.bulkSessionAction(['s1'], 'delete', viewerOf(sharedUser));
    expect(bulk.skipped).toEqual(['s1']);
    expect(db.sessionsDb.getSessionById('s1')).not.toBeNull();

    const archived = await providers.sessionsService.bulkSessionAction(['s1'], 'archive', viewerOf(sharedUser));
    expect(archived.succeeded).toEqual(['s1']);
  });

  it('最近删除列表:owner 与共享用户都看得见,canRestore 只给 owner / root / 删除者', async () => {
    providers.setSessionRuntimeReleaser(async () => ({ released: true }));
    await providers.sessionsService.deleteOrArchiveSessionById('s1', { force: true, actor: viewerOf(owner), via: 'session' });

    const forOwner = providers.sessionsService.listTrashedSessions(viewerOf(owner));
    expect(forOwner.sessions).toHaveLength(1);
    expect(forOwner.sessions[0]).toMatchObject({ sessionId: 's1', sessionTitle: '胡萍', deletedBy: 'owner', canRestore: true, transcriptKept: true, messageCount: 2 });
    expect(forOwner.retentionDays).toBe(30);
    expect(forOwner.sessions[0].purgeAt).not.toBeNull();

    const forShared = providers.sessionsService.listTrashedSessions(viewerOf(sharedUser));
    expect(forShared.sessions).toHaveLength(1);
    expect(forShared.sessions[0].canRestore).toBe(false);
    await expect(providers.sessionsService.restoreTrashedSession('s1', viewerOf(sharedUser)))
      .rejects.toMatchObject({ code: 'SESSION_RESTORE_FORBIDDEN' });

    expect(providers.sessionsService.listTrashedSessions({ userId: 777, username: 'nobody' }).sessions).toEqual([]);
  });
});
