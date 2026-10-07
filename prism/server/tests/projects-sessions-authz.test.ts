import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, test } from 'vitest';

import {
  apiKeysDb, auditLogDb, canViewerManageSession, closeConnection, getConnection, initializeDatabase,
  messageFeedbackDb, notificationPreferencesDb, projectsDb, sessionMessagesDb, sessionsDb, userDb,
} from '@/modules/database/index.js';
import { runMigrations } from '@/modules/database/migrations.js';
import {
  canArchiveProject, canDeleteProject, canManageProject, canRestoreProject, transferProjectOwner,
} from '@/modules/projects/services/project-permissions.service.js';
import { PROJECT_DISPLAY_NAME_MAX_LENGTH, updateProjectDisplayName } from '@/modules/projects/services/project-management.service.js';
import { resolveFeedbackTarget } from '@/modules/providers/services/feedback-target.service.js';
import { broadcastProjectChange, prepareProjectChangeBroadcast } from '@/modules/websocket/services/project-broadcast.service.js';
import { connectedClients } from '@/shared/websocket-state.js';
import type { NormalizedMessage, RealtimeClientConnection } from '@/shared/types.js';

/**
 * 项目 / 账号 / 侧栏 / 会话 / 反馈的权限与一致性回归测试。
 * 每个 describe 钉住一条约束,实现被改回不安全的写法时对应断言就会变红。
 */

const repoRoot = path.resolve(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

async function withIsolatedDatabase(run: () => void | Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'hl-b-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  try {
    await initializeDatabase();
    await run();
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

const withEnv = async (vars: Record<string, string | undefined>, run: () => void | Promise<void>) => {
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    before[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { await run(); } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
};

const mkUser = (name: string) => userDb.createUser(name, 'x', 'approved') as { id: number };
const mkProject = (p: string, owner: number | null, visibility: 'public' | null = null) =>
  projectsDb.createProjectPath(p, null, owner, visibility).project!;

const userMessage = (id: string, sender?: number, origin: 'web' | 'api' = 'web'): NormalizedMessage => ({
  id, sessionId: 's', timestamp: new Date().toISOString(), provider: 'claude', kind: 'text', role: 'user',
  content: 'hi', ...(sender === undefined ? {} : { senderUserId: sender, origin }),
});
const assistantMessage = (id: string): NormalizedMessage => ({
  id, sessionId: 's', timestamp: new Date().toISOString(), provider: 'claude', kind: 'text', role: 'assistant', content: 'ok',
});
const skillFrame = (id: string, skill: string): NormalizedMessage => ({
  id, sessionId: 's', timestamp: new Date().toISOString(), provider: 'claude', kind: 'tool_use',
  toolName: 'Skill', toolInput: { skill },
} as NormalizedMessage);

describe('非 owner 改别人项目显示名', () => {
  test('canManageProject:共享接收方 / 公共项目路人都不能;owner 与 root 能', async () => {
    await withEnv({ PRISM_ROOT_USERS: 'boss', PRISM_PUBLIC_WORKSPACE: undefined }, async () => {
      await withIsolatedDatabase(() => {
        const ann = mkUser('ann');
        const ben = mkUser('ben');
        const p = mkProject('/ws/ann-proj', ann.id);
        projectsDb.setProjectShares(p.project_id, [ben.id], ann.id);
        assert.equal(canManageProject(p.project_id, { id: ben.id, username: 'ben' }), false);
        assert.equal(canManageProject(p.project_id, { id: ann.id, username: 'ann' }), true);
        assert.equal(canManageProject(p.project_id, { id: 99, username: 'boss', isRoot: true }), true);
        const pub = mkProject('/ws/pub', ann.id, 'public');
        assert.equal(canManageProject(pub.project_id, { id: ben.id, username: 'ben' }), false);
      });
    });
  });

  test('rename 路由过 canManageProject;displayName 限长限型', async () => {
    const src = read('server/modules/projects/projects.routes.ts');
    const renameBlock = src.slice(src.indexOf("'/:projectId/rename'"), src.indexOf("'/:projectId/toggle-star'"));
    assert.match(renameBlock, /canManageProject\(req, projectId\)/, 'rename 必须与权限 / 归档同门');
    await withIsolatedDatabase(() => {
      const ann = mkUser('ann');
      const p = mkProject('/ws/x', ann.id);
      assert.throws(() => updateProjectDisplayName(p.project_id, { evil: 1 }), /must be a string/);
      assert.throws(() => updateProjectDisplayName(p.project_id, 'x'.repeat(PROJECT_DISPLAY_NAME_MAX_LENGTH + 1)), /must not exceed/);
      updateProjectDisplayName(p.project_id, '  好名字  ');
      assert.equal(projectsDb.getProjectById(p.project_id)?.custom_project_name, '好名字');
      updateProjectDisplayName(p.project_id, '');
      assert.equal(projectsDb.getProjectById(p.project_id)?.custom_project_name, null);
    });
  });
});

describe('API key 领会话号 & 跑回合的门', () => {
  test('POST /api/agent/sessions 在建行之前过 assertViewerMayCreateSessionAt,不存在的路径回 404 同形', () => {
    const src = read('server/routes/agent.js');
    const block = src.slice(src.indexOf("router.post('/sessions', validateExternalApiKey"), src.indexOf("router.get('/sessions', validateExternalApiKey"));
    const guard = block.indexOf('assertViewerMayCreateSessionAt(readRequestViewer(req), finalProjectPath)');
    const create = block.indexOf('createAppSession(');
    assert.ok(guard > 0 && create > guard, '归属门要在建行之前');
    assert.match(block, /res\.status\(404\)\.json\(\{ error: '项目不存在或你没有权限' \}\)/, '存在性探针要堵住');
    assert.doesNotMatch(block, /error: `Project path does not exist/);
  });

  test('跑回合那支:4xx 的 AppError 在响应头发出之前按状态码回,而不是 500', () => {
    const src = read('server/routes/agent.js');
    assert.match(src, /!res\.headersSent && !writer && Number\.isInteger\(error\?\.statusCode\)/);
    // API 发起的回合把发起人记进显示日志(会话归档 / 删除要认"这是不是我开的")
    assert.equal((src.match(/senderUserId: req\.user\.id,\s*\n\s*origin: 'api'/g) ?? []).length, 2, '异步 + 同步两处都要记');
  });
});

describe('转移属主后原 owner 看不到自己的会话', () => {
  test('transferProjectOwner:非公开项目把原 owner 写进 shares;公开项目不写;审计带 targetUserId', async () => {
    await withEnv({ PRISM_ROOT_USERS: 'boss' }, async () => {
      await withIsolatedDatabase(() => {
        const ann = mkUser('ann');
        const ben = mkUser('ben');
        const boss = mkUser('boss');
        const p = mkProject('/ws/ann', ann.id);
        const result = transferProjectOwner(p.project_id, ben.id, { id: boss.id, username: 'boss', isRoot: true });
        assert.deepEqual(result, { previousOwner: ann.id, grantedPreviousOwner: true });
        assert.equal(projectsDb.getProjectOwner(p.project_id), ben.id);
        assert.deepEqual(projectsDb.getProjectSharedUserIds(p.project_id), [ann.id]);

        const pub = mkProject('/ws/pub', ann.id, 'public');
        assert.equal(transferProjectOwner(pub.project_id, ben.id, { id: boss.id, username: 'boss', isRoot: true })?.grantedPreviousOwner, false);
        assert.deepEqual(projectsDb.getProjectSharedUserIds(pub.project_id), []);

        const rows = getConnection().prepare("SELECT target_user_id FROM audit_log WHERE event = 'project_owner_changed' ORDER BY id").all() as Array<{ target_user_id: number | null }>;
        assert.deepEqual(rows.map((r) => r.target_user_id), [ben.id, ben.id]);
        assert.equal(transferProjectOwner('no-such', ben.id, { id: boss.id, username: 'boss', isRoot: true }), null);
      });
    });
  });
});

describe('会话归档 / 还原 / 永久删:发起人、owner、root', () => {
  test('canViewerManageSession:协作者只能动自己发起的会话;owner 全能;被移出共享后发起人也不能', async () => {
    await withEnv({ PRISM_ROOT_USERS: 'boss', PRISM_PUBLIC_WORKSPACE: undefined }, async () => {
      await withIsolatedDatabase(() => {
        const ann = mkUser('ann');
        const ben = mkUser('ben');
        const carl = mkUser('carl');
        mkProject('/ws/shared', ann.id);
        const pid = projectsDb.getProjectPath('/ws/shared')!.project_id;
        projectsDb.setProjectShares(pid, [ben.id, carl.id], ann.id);

        sessionsDb.createAppSession('s-ben', 'claude', '/ws/shared', ann.id);
        sessionMessagesDb.append('s-ben', userMessage('u1', ben.id));
        sessionMessagesDb.append('s-ben', assistantMessage('a1_text'));
        sessionsDb.createAppSession('s-ann', 'claude', '/ws/shared', ann.id);
        sessionMessagesDb.append('s-ann', userMessage('u2', ann.id));

        assert.equal(sessionsDb.getSessionInitiatorUserId('s-ben'), ben.id);
        const asBen = { userId: ben.id, username: 'ben' };
        const asCarl = { userId: carl.id, username: 'carl' };
        const asAnn = { userId: ann.id, username: 'ann' };
        assert.equal(canViewerManageSession('s-ben', asBen), true, '发起人');
        assert.equal(canViewerManageSession('s-ben', asCarl), false, '别的协作者');
        assert.equal(canViewerManageSession('s-ann', asBen), false, 'owner 的会话协作者不能动');
        assert.equal(canViewerManageSession('s-ben', asAnn), true, 'owner');
        assert.equal(canViewerManageSession('s-ben', { userId: 999, username: 'boss' }), true, 'root');

        projectsDb.setProjectShares(pid, [carl.id], ann.id);
        assert.equal(canViewerManageSession('s-ben', asBen), false, '被移出共享名单后不能再动');

        // 日志被裁剪过 → 剩下的"第一条用户消息"不可信,发起人未知(只剩 owner / root 能管)
        projectsDb.setProjectShares(pid, [ben.id, carl.id], ann.id);
        sessionsDb.createAppSession('s-trim', 'claude', '/ws/shared', ann.id);
        sessionMessagesDb.append('s-trim', userMessage('u3', carl.id));
        assert.equal(sessionsDb.getSessionInitiatorUserId('s-trim'), carl.id);
        getConnection().prepare('INSERT INTO session_display_log_state (session_id, trimmed) VALUES (?, 1) ON CONFLICT(session_id) DO UPDATE SET trimmed = 1').run('s-trim');
        assert.equal(sessionMessagesDb.isTrimmed('s-trim'), true);
        assert.equal(sessionsDb.getSessionInitiatorUserId('s-trim'), null);
        assert.equal(canViewerManageSession('s-trim', asCarl), false, '裁剪后协作者不能凭"剩下的首条"拿到删除权');
        assert.equal(canViewerManageSession('s-trim', asAnn), true);
      });
    });
  });

  test('路由:归档与还原都过 assertViewerMayArchiveOrRestore;批量三种动作同门', () => {
    const routes = read('server/modules/providers/provider.routes.ts');
    assert.match(routes, /else sessionsService\.assertViewerMayArchiveOrRestore\(sessionId, viewer, 'archive'\)/);
    assert.match(routes, /assertViewerMayArchiveOrRestore\(sessionId, readRequestViewer\(req\), 'restore'\)/);
    const service = read('server/modules/providers/services/sessions.service.ts');
    const bulk = service.slice(service.indexOf('async bulkSessionAction('), service.indexOf('async emptyArchivedSessions('));
    assert.match(bulk, /if \(!this\.canViewerManageSession\(sessionId, viewer\)\) \{/, '批量不再只对 delete 过门');
    assert.doesNotMatch(bulk, /action === 'delete' && !this\.canViewerManageSession/);
  });
});

describe('无主项目与还原对称', () => {
  test('无主项目归档 / 永久删 / 还原只给 root;有主项目 owner 可', async () => {
    await withEnv({ PRISM_ROOT_USERS: 'boss', PRISM_PUBLIC_WORKSPACE: '/ws/public' }, async () => {
      await withIsolatedDatabase(() => {
        const ann = mkUser('ann');
        const unowned = mkProject('/ws/public/orphan', null);
        const asAnn = { id: ann.id, username: 'ann' };
        const asRoot = { id: 42, username: 'boss', isRoot: true };
        assert.equal(canDeleteProject(unowned.project_id, asAnn), false);
        assert.equal(canArchiveProject(unowned.project_id, asAnn), false);
        assert.equal(canRestoreProject(unowned.project_id, asAnn), false);
        assert.equal(canDeleteProject(unowned.project_id, asRoot), true);
        const owned = mkProject('/ws/ann', ann.id);
        assert.equal(canArchiveProject(owned.project_id, asAnn), true);
        assert.equal(canRestoreProject(owned.project_id, asAnn), true);
        assert.equal(canRestoreProject(owned.project_id, { id: 7, username: 'ben' }), false);
        assert.equal(canDeleteProject('nope', asRoot), true, 'root 不查行(路由先过可见性)');
      });
    });
    const routes = read('server/modules/projects/projects.routes.ts');
    const restore = routes.slice(routes.indexOf("'/:projectId/restore'"), routes.indexOf("router.delete("));
    assert.match(restore, /canActorRestoreProject\(projectId, readUser\(req\)\)/);
  });
});

describe('创建项目命中已归档路径', () => {
  test('路由先 realpath 再判可见性;复活应用所选权限并回 revived:true', () => {
    const src = read('server/modules/projects/projects.routes.ts');
    const block = src.slice(src.indexOf("'/create-project'"), src.indexOf("'/migrate-legacy-stars'"));
    assert.ok(block.indexOf('validateWorkspacePath(projectPath)') < block.indexOf('resolveVisibleProjectRoot(readRequestViewer(req), existing.project_id)'));
    assert.match(block, /pathValidation\.resolvedPath/);
    assert.match(block, /canActorRestoreProject\(existing\.project_id, readUser\(req\)\)/, '复活别人归档的项目要按还原的门');
    assert.match(block, /const explicitVisibility = typeof requestBody\.visibility === 'string';/);
    assert.match(block, /if \(revived && explicitVisibility\) \{[\s\S]*applyProjectPermissions\(/,
      '复活时只有显式带 visibility 才改权限 —— 缺省的 personal 不许覆盖原共享设置');
    const wizard = read('src/components/project-creation-wizard/ProjectCreationWizard.tsx');
    assert.match(wizard, /\.\.\.\(permissionTouched\s*\n\s*\? \{\s*\n\s*visibility: formState\.visibility/,
      '向导没动过权限选择器就不发 visibility');
    assert.doesNotMatch(wizard, /^\s{8}visibility: formState\.visibility,\n\s{8}sharedUserIds/m);
    assert.match(block, /revived,\n/);
  });
});

describe('项目 / 会话变更实时推送', () => {
  const fakeSocket = (userId: number | null, username: string): RealtimeClientConnection & { frames: Array<Record<string, unknown>> } => {
    const frames: Array<Record<string, unknown>> = [];
    return { readyState: 1, prismUserId: userId, prismUsername: username, frames, send: (data: string) => { frames.push(JSON.parse(data)); } };
  };
  afterEach(() => { connectedClients.clear(); });

  test('改权限:新看见的收 upserted(带自己视角的 sharedWithViewer),被收回的收 removed;归档后 before 名单全收 removed', async () => {
    await withEnv({ PRISM_ROOT_USERS: 'boss', PRISM_PUBLIC_WORKSPACE: undefined }, async () => {
      await withIsolatedDatabase(() => {
        const ann = mkUser('ann');
        const ben = mkUser('ben');
        const carl = mkUser('carl');
        const p = mkProject('/ws/ann', ann.id);
        projectsDb.setProjectShares(p.project_id, [ben.id], ann.id);
        const sAnn = fakeSocket(ann.id, 'ann');
        const sBen = fakeSocket(ben.id, 'ben');
        const sCarl = fakeSocket(carl.id, 'carl');
        const sRoot = fakeSocket(9, 'boss');
        for (const s of [sAnn, sBen, sCarl, sRoot]) connectedClients.add(s);

        const announce = prepareProjectChangeBroadcast(p.project_id);
        projectsDb.setProjectShares(p.project_id, [carl.id], ann.id); // ben 出、carl 进
        assert.equal(announce('permissions'), 4);
        assert.equal(sBen.frames[0]?.kind, 'project_removed');
        assert.equal(sCarl.frames[0]?.kind, 'project_upserted');
        assert.equal((sCarl.frames[0]?.project as { sharedWithViewer: boolean }).sharedWithViewer, true);
        assert.equal((sAnn.frames[0]?.project as { sharedWithViewer: boolean }).sharedWithViewer, false);
        assert.equal((sAnn.frames[0]?.project as { sharedUserCount: number }).sharedUserCount, 1);
        assert.equal(sRoot.frames[0]?.kind, 'project_upserted');

        for (const s of [sAnn, sBen, sCarl, sRoot]) s.frames.length = 0;
        const announceArchive = prepareProjectChangeBroadcast(p.project_id);
        projectsDb.updateProjectIsArchivedById(p.project_id, true);
        assert.equal(announceArchive('archived'), 3);
        assert.deepEqual([sAnn, sCarl, sRoot].map((s) => s.frames[0]?.kind), ['project_removed', 'project_removed', 'project_removed']);
        assert.equal(sBen.frames.length, 0);

        projectsDb.deleteProjectById(p.project_id);
        assert.equal(broadcastProjectChange(p.project_id, 'deleted'), 0, '行没了又没有 before 名单 → 一帧都不发,但不抛');
      });
    });
  });

  test('路由 / 批量 / 会话改名与新建都接了推送', () => {
    const routes = read('server/modules/projects/projects.routes.ts');
    for (const reason of ['created', 'revived', 'renamed', 'permissions', 'owner', 'archived', 'restored', 'deleted']) {
      assert.match(routes, new RegExp(`'${reason}'( : |\\))`), `项目路由缺 ${reason} 的推送`);
    }
    const bulk = read('server/modules/projects/services/project-bulk.service.ts');
    assert.match(bulk, /prepareProjectChangeBroadcast\(projectId\)/);
    const service = read('server/modules/providers/services/sessions.service.ts');
    assert.equal((service.match(/chatRunRegistry\.announceSessionUpsert\(sessionId\)/g) ?? []).length, 4, '新建 / 回收站恢复(gl 已有)/ 归档还原 / 改名四处');
    assert.match(read('server/shared/types.ts'), /'project_upserted'\n\s*\| 'project_removed'/);
  });
});

describe('管理类审计补 targetUserId / ip / user-agent', () => {
  test('admin.routes 五处 record 全走 adminAuditBase', () => {
    const src = read('server/modules/admin/admin.routes.ts');
    assert.equal((src.match(/auditLogDb\.record\(\{/g) ?? []).length, (src.match(/\.\.\.adminAuditBase\(req, targetUserId\)/g) ?? []).length);
    assert.ok((src.match(/\.\.\.adminAuditBase\(req, targetUserId\)/g) ?? []).length >= 4);
    assert.match(src, /targetUserId,\n\s*\};/);
    assert.match(src, /ip: clientIp\(req\)/);
  });
});

describe('技能列表校验 workspacePath', () => {
  test('带 workspacePath 时与 MCP 同门', () => {
    const src = read('server/modules/providers/provider.routes.ts');
    const block = src.slice(src.indexOf("'/:provider/skills',"), src.indexOf('const readSkillActor'));
    assert.match(block, /if \(workspacePath\) \{\s*\n\s*await assertViewerMayCreateSessionAt\(readRequestViewer\(req\), workspacePath\)/);
  });
});

describe('反馈接口核对消息归属,skill 服务端反查', () => {
  test('resolveFeedbackTarget:陌生 id / 用户消息不算;skill 取本轮第一帧', () => {
    const log = [
      userMessage('u1', 1), skillFrame('t1', 'pdf'), skillFrame('t2', 'docx'), assistantMessage('a1_text'),
      userMessage('u2', 1), assistantMessage('a2_text'),
    ];
    assert.deepEqual(resolveFeedbackTarget(log, 'a1_text'), { found: true, skill: 'pdf' });
    assert.deepEqual(resolveFeedbackTarget(log, 'a2_text'), { found: true, skill: null });
    assert.deepEqual(resolveFeedbackTarget(log, 'u1'), { found: false, skill: null });
    assert.deepEqual(resolveFeedbackTarget(log, 'forged'), { found: false, skill: null });
  });

  test('路由:查不到消息 404;服务端 skill 优先于客户端;upsert 同步 session_id', async () => {
    const src = read('server/modules/providers/provider.routes.ts');
    assert.match(src, /FEEDBACK_MESSAGE_NOT_IN_SESSION/);
    assert.match(src, /const skillHint = target\?\.skill \?\? parsed\.skillHint;/);
    // 日志被裁剪过时查不到不回 404,回落到客户端给的值
    assert.match(src, /if \(target && !target\.found && !sessionMessagesDb\.isTrimmed\(sessionId\)\) \{/);
    await withIsolatedDatabase(() => {
      const ann = mkUser('ann');
      messageFeedbackDb.upsert({ sessionId: 's-old', projectId: null, messageId: 'm1', userId: ann.id, source: 'vote', verdict: -1, status: 'answered', skillHint: 'pdf' });
      messageFeedbackDb.upsert({ sessionId: 's-new', projectId: null, messageId: 'm1', userId: ann.id, source: 'vote', verdict: 1, status: 'answered' });
      const rows = messageFeedbackDb.listForSessionAndUser('s-new', ann.id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].skill_hint, 'pdf');
      assert.equal(messageFeedbackDb.listForSessionAndUser('s-old', ann.id).length, 0);
    });
  });
});

describe('账号杂项', () => {
  test('API key 随 token_version 作废:退出所有设备 / 改密后失效,列表标 revoked,启用可重签;迁移回填老 key', async () => {
    await withIsolatedDatabase(() => {
      const ann = mkUser('ann');
      const { apiKey, id } = apiKeysDb.createApiKey(ann.id, 'k');
      assert.ok(apiKeysDb.validateApiKey(apiKey));
      userDb.bumpTokenVersion(ann.id); // 退出所有设备 / 改密 / 重置密码都走这里(或 updatePassword 的 +1)
      assert.equal(apiKeysDb.validateApiKey(apiKey), undefined, '版本变了 key 必须失效');
      const listed = apiKeysDb.getApiKeys(ann.id)[0];
      assert.equal(listed.is_active, 0);
      assert.equal(listed.revoked, 1);
      assert.ok(apiKeysDb.toggleApiKey(ann.id, Number(id), true));
      assert.ok(apiKeysDb.validateApiKey(apiKey), '明确「启用」= 重新签到当前版本');
      assert.equal(apiKeysDb.getApiKeys(ann.id)[0].revoked, 0);
      apiKeysDb.toggleApiKey(ann.id, Number(id), false);
      assert.equal(apiKeysDb.validateApiKey(apiKey), undefined);

      // 老库的 key(token_version 为 NULL)由迁移回填成用户当前版本
      const db = getConnection();
      db.prepare('UPDATE api_keys SET token_version = NULL, is_active = 1 WHERE id = ?').run(Number(id));
      assert.ok(apiKeysDb.validateApiKey(apiKey), 'NULL 视为有效(迁移未跑时不锁人)');
      runMigrations(db);
      const after = db.prepare('SELECT token_version FROM api_keys WHERE id = ?').get(Number(id)) as { token_version: number };
      assert.equal(after.token_version, userDb.getTokenVersion(ann.id));
    });
  });

  test('停用账号登录审计写 inactive user;通知偏好只收白名单键', async () => {
    await withIsolatedDatabase(() => {
      const ann = mkUser('ann');
      userDb.setActive(ann.id, false);
      assert.equal(userDb.getUserByUsername('ann'), undefined);
      assert.equal(userDb.findUserByUsernameIncludingInactive('ann')?.id, ann.id);
      assert.equal(userDb.findUserByUsernameIncludingInactive('nobody'), undefined);
      const src = read('server/routes/auth.js');
      assert.match(src, /detail: inactive \? 'inactive user' : 'unknown user'/);

      const prefs = notificationPreferencesDb.updatePreferences(ann.id, { channels: { inApp: true, sound: false, evil: true, x: false }, events: { stop: false, y: true } });
      assert.deepEqual(prefs, { channels: { inApp: true, sound: false }, events: { actionRequired: true, stop: false, error: true } });
      const stored = getConnection().prepare('SELECT preferences_json FROM user_notification_preferences WHERE user_id = ?').get(ann.id) as { preferences_json: string };
      assert.doesNotMatch(stored.preferences_json, /evil|"y"/);
    });
  });

  test('账号页 root 自己那行不画「驳回」;登录后不再重跑一遍状态核验(首屏请求不双发)', () => {
    const tab = read('src/components/settings/view/tabs/accounts-settings/AccountsSettingsTab.tsx');
    assert.match(tab, /user\.approval_status !== 'rejected' && user\.id !== Number\(currentUser\?\.id\) && \(/);
    const auth = read('src/components/auth/context/AuthContext.tsx');
    assert.match(auth, /skipNextStatusCheckRef\.current = true;\s*\n\s*setUser\(nextUser\)/);
    // 登出只清草稿与时间戳(同步键由主人标记兜底),避免再登录时必须整页重载一次
    assert.match(auth, /clearLocalAccountStateOnLogout\(\);\s*\n\s*clearSession\(\);/, '登出要清本机草稿与时间戳');
  });
});

describe('审计事件 targetUserId 落库(辅助)', () => {
  test('record 带 targetUserId 时能按 target 查到', async () => {
    await withIsolatedDatabase(() => {
      const ann = mkUser('ann');
      auditLogDb.record({ userId: 1, username: 'boss', event: 'user_approved', detail: 'x', targetUserId: ann.id });
      const row = getConnection().prepare('SELECT target_user_id FROM audit_log WHERE event = ?').get('user_approved') as { target_user_id: number };
      assert.equal(row.target_user_id, ann.id);
    });
  });
});
