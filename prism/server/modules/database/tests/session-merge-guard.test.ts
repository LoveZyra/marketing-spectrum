import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * provider 会话映射的合并只允许发生在同一个项目里。
 *
 * 合并只为一种情况存在:文件监视器先索引了同一份 transcript,那一行与本行必然同项目。
 * 不校验的话,`assignProviderSessionId` 里的 DELETE 就是越权删除的落点:伪造的会话 id
 * 被运行时回灌上来,别人那行被删掉,其 transcript 路径和名字并进攻击者自己那行。
 * 跨项目正是这种攻击的必要条件(同项目会被 CLI 的 "already in use" 挡掉)。
 */
let tempDir: string;
let db: typeof import('@/modules/database/index.js');

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-merge-guard-'));
  process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');
  db = await import('@/modules/database/index.js');
  db.initializeDatabase();
});

afterAll(() => {
  try { db?.closeConnection?.(); } catch { /* ignore */ }
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const ensureProject = (projectPath: string | null) => {
  if (!projectPath) return;
  db.getConnection()
    .prepare('INSERT OR IGNORE INTO projects (project_id, project_path) VALUES (?, ?)')
    .run(projectPath, projectPath);
};
const insertSession = (sessionId: string, projectPath: string | null, providerId: string | null, name: string | null) => {
  ensureProject(projectPath);
  db.getConnection()
    .prepare('INSERT INTO sessions (session_id, provider, provider_session_id, project_path, jsonl_path, custom_name) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sessionId, 'claude', providerId, projectPath, providerId ? `/t/${providerId}.jsonl` : null, name);
};
const rows = () => db.getConnection()
  .prepare('SELECT session_id, provider_session_id, project_path, custom_name FROM sessions ORDER BY session_id')
  .all() as Array<{ session_id: string; provider_session_id: string | null; project_path: string | null; custom_name: string | null }>;

describe('assignProviderSessionId 的合并守卫', () => {
  it('跨项目:一行都不许删,也不许认领(这就是那个越权)', () => {
    insertSession('victim-uuid', '/projects/victim', 'victim-uuid', '受害者的对话');
    insertSession('attacker', '/projects/attacker', null, null);

    db.sessionsDb.assignProviderSessionId('attacker', 'victim-uuid');

    const after = rows();
    // 受害者那一行还在,名字和 transcript 都没被搬走
    const victim = after.find((r) => r.session_id === 'victim-uuid');
    expect(victim).toBeDefined();
    expect(victim?.custom_name).toBe('受害者的对话');
    expect(victim?.project_path).toBe('/projects/victim');
    // 攻击者那一行也没拿到这个映射
    expect(after.find((r) => r.session_id === 'attacker')?.provider_session_id).toBeNull();
  });

  it('同项目:监视器先索引的那一行照常合并(真正的用途没被误伤)', () => {
    insertSession('watcher-uuid', '/projects/same', 'watcher-uuid', '监视器抄的名字');
    insertSession('app-row', '/projects/same', null, null);

    db.sessionsDb.assignProviderSessionId('app-row', 'watcher-uuid');

    const after = rows();
    expect(after.find((r) => r.session_id === 'watcher-uuid')).toBeUndefined();  // 重复行被并掉
    const merged = after.find((r) => r.session_id === 'app-row');
    expect(merged?.provider_session_id).toBe('watcher-uuid');
    expect(merged?.custom_name).toBe('监视器抄的名字');       // 名字继承过来
  });

  it('没有撞号的行 → 正常写映射', () => {
    insertSession('plain', '/projects/plain', null, null);
    db.sessionsDb.assignProviderSessionId('plain', 'fresh-uuid');
    expect(rows().find((r) => r.session_id === 'plain')?.provider_session_id).toBe('fresh-uuid');
  });

  it('一边有项目一边没有 → 也不合并(宁可不认领,不要把两段无关的对话缝一起)', () => {
    insertSession('orphan-uuid', null, 'orphan-uuid', '没有项目的那条');
    insertSession('has-project', '/projects/x', null, null);

    expect(db.sessionsDb.assignProviderSessionId('has-project', 'orphan-uuid')).toBe(false);

    const after = rows();
    expect(after.find((r) => r.session_id === 'orphan-uuid')).toBeDefined();
    expect(after.find((r) => r.session_id === 'has-project')?.provider_session_id).toBeNull();
  });

  /**
   * 两边都没有项目也不合并:null 与 null 不算同一项目,否则两个还没归属的行会因为
   * "都是空"被并成一行、其中一行被 DELETE。客户端不能指定 newSessionId(白名单),
   * 要触发只能靠原生 id 的自然碰撞,但守卫自己的判据不该有这个洞。
   */
  it('两边都没有项目 → 不合并、不删行', () => {
    insertSession('null-a', null, 'shared-uuid', '第一条');
    insertSession('null-b', null, null, null);

    expect(db.sessionsDb.assignProviderSessionId('null-b', 'shared-uuid')).toBe(false);

    const after = rows();
    expect(after.find((r) => r.session_id === 'null-a')).toBeDefined();
    expect(after.find((r) => r.session_id === 'null-b')?.provider_session_id).toBeNull();
  });

  /**
   * 软链会让同一个项目写成两个不同的字符串:app 那一行存的是调用方给的路径,
   * 监视器那一行取的是 CLI 子进程的 `process.cwd()`,符号链接已被内核解析掉。
   * 原样字符串比会把真正的监视器合并判成跨项目,`provider_session_id` 一直是 NULL,
   * 每一轮都是没有上文的新对话。
   *
   * 所以这条用真的软链跑:两行写不同的字符串、指向同一个目录。
   * 判据若退回原样字符串比,这一条立刻红。
   */
  it('软链指向同一个目录 → 照常合并(这是最常见的误挡)', () => {
    const realProject = path.join(tempDir, 'real-workspace');
    const linkedProject = path.join(tempDir, 'linked-workspace');
    fs.mkdirSync(realProject, { recursive: true });
    fs.symlinkSync(realProject, linkedProject, 'dir');
    // 监视器那一行:内核解析过的真实路径。app 那一行:用户配置里的软链路径。
    insertSession('symlink-watcher-uuid', realProject, 'symlink-watcher-uuid', '监视器抄的名字');
    insertSession('symlink-app-row', linkedProject, null, null);

    expect(db.sessionsDb.assignProviderSessionId('symlink-app-row', 'symlink-watcher-uuid')).toBe(true);

    const after = rows();
    expect(after.find((r) => r.session_id === 'symlink-watcher-uuid')).toBeUndefined();
    const merged = after.find((r) => r.session_id === 'symlink-app-row');
    expect(merged?.provider_session_id).toBe('symlink-watcher-uuid');
    expect(merged?.custom_name).toBe('监视器抄的名字');
  });

  it('两个真的不同的目录(都存在)→ 仍然不合并 —— 解软链没有把判据放松', () => {
    const projectA = path.join(tempDir, 'ws-a');
    const projectB = path.join(tempDir, 'ws-b');
    fs.mkdirSync(projectA, { recursive: true });
    fs.mkdirSync(projectB, { recursive: true });
    insertSession('real-victim-uuid', projectA, 'real-victim-uuid', '别人的对话');
    insertSession('real-attacker', projectB, null, null);

    expect(db.sessionsDb.assignProviderSessionId('real-attacker', 'real-victim-uuid')).toBe(false);

    const after = rows();
    expect(after.find((r) => r.session_id === 'real-victim-uuid')?.custom_name).toBe('别人的对话');
    expect(after.find((r) => r.session_id === 'real-attacker')?.provider_session_id).toBeNull();
  });

  it('写映射成功时返回 true —— 调用方靠这个返回值决定要不要改内存', () => {
    insertSession('reports-true', '/projects/reports', null, null);
    expect(db.sessionsDb.assignProviderSessionId('reports-true', 'reports-true-uuid')).toBe(true);
  });

  /**
   * 只吞"监视器裸行"。监视器抢先建的那一行长相固定:`session_id = provider_session_id`、
   * 没有显示日志;不长这样的一律不删不并不认领,否则同项目里任何一条被认领 id 的会话
   * 都会被连行删掉,显示日志留成孤儿。判据若放宽成"是另一行就删",下面两条立刻红。
   */
  it('同项目、但那一行已经有人聊过(有显示日志)→ 不合并、不删行', () => {
    insertSession('lived-uuid', '/projects/same', 'lived-uuid', '有人聊过的');
    db.getConnection()
      .prepare("INSERT INTO session_display_messages (session_id, message_id, kind, timestamp, payload) VALUES (?, ?, ?, ?, ?)")
      .run('lived-uuid', 'm1', 'text', '2026-09-14T10:00:00Z', '{}');
    insertSession('claimer', '/projects/same', null, null);

    expect(db.sessionsDb.assignProviderSessionId('claimer', 'lived-uuid')).toBe(false);

    const after = rows();
    expect(after.find((r) => r.session_id === 'lived-uuid')?.custom_name).toBe('有人聊过的');
    expect(after.find((r) => r.session_id === 'claimer')?.provider_session_id).toBeNull();
  });

  it('同项目、但那一行是 app 行(session_id ≠ provider_session_id)→ 不合并、不删行', () => {
    insertSession('app-victim', '/projects/same', 'victim-provider', '另一段对话');
    insertSession('claimer-2', '/projects/same', null, null);

    expect(db.sessionsDb.assignProviderSessionId('claimer-2', 'victim-provider')).toBe(false);

    const after = rows();
    expect(after.find((r) => r.session_id === 'app-victim')?.provider_session_id).toBe('victim-provider');
    expect(after.find((r) => r.session_id === 'claimer-2')?.provider_session_id).toBeNull();
  });
});
