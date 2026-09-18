import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * fz(安全回归):provider 会话映射的合并**只允许发生在同一个项目里**。
 *
 * 这段合并存在的唯一理由是"文件监视器先索引了同一份 transcript" —— 那一行与
 * 本行必然同项目。而它原来的 DELETE 不带任何校验,成了越权删除的落点:
 * 攻击者把 `newSessionId` 塞成别人的会话 id,运行时回灌上来,这里就把别人那行
 * 删掉、并把它的 transcript 路径和名字并进攻击者自己那行。跨项目正是攻击必需的
 * 条件(同项目会被 CLI 的 "already in use" 挡掉)。
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
  it('**跨项目:一行都不许删,也不许认领**(这就是那个越权)', () => {
    insertSession('victim-uuid', '/projects/victim', 'victim-uuid', '受害者的对话');
    insertSession('attacker', '/projects/attacker', null, null);

    db.sessionsDb.assignProviderSessionId('attacker', 'victim-uuid');

    const after = rows();
    // 受害者那一行**还在**,名字和 transcript 都没被搬走
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
   * gh:**两边都没有项目 → 也不合并。**
   *
   * `isSameProjectPath` 原来第一句是 `if (a === b) return true`,于是 null 与 null
   * 相等 —— 两个还没归属的行会因为"都是空"被并成一行、其中一行被 DELETE。
   * 客户端已不能指定 newSessionId(fz 白名单),要触发得靠原生 id 的自然碰撞,
   * 但守卫自己的判据不该有这个洞。
   */
  it('gh:两边都没有项目 → 不合并、不删行', () => {
    insertSession('null-a', null, 'shared-uuid', '第一条');
    insertSession('null-b', null, null, null);

    expect(db.sessionsDb.assignProviderSessionId('null-b', 'shared-uuid')).toBe(false);

    const after = rows();
    expect(after.find((r) => r.session_id === 'null-a')).toBeDefined();
    expect(after.find((r) => r.session_id === 'null-b')?.provider_session_id).toBeNull();
  });

  /**
   * ga:**软链会让"同一个项目"写成两个不一样的字符串。**
   *
   * app 那一行存的是调用方给的路径,监视器那一行取的是 CLI 子进程的
   * `process.cwd()` —— 内核已经把符号链接解析掉了。原来的判据是原样字符串比,
   * 于是只要项目路径里有一段是软链,**真正的监视器合并就被判成跨项目攻击**:
   * `provider_session_id` 永远是 NULL → 每一轮都是一段全新对话,模型没有上文;
   * 工具审批、预热、终端接管、编辑重跑全部永久失效,用户侧零提示。
   *
   * 所以这条用**真的软链**跑:两行写不同的字符串、指向同一个目录。
   * 判据改回原样字符串比,这一条立刻红。
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
   * gk:**只吞"监视器裸行"。**
   *
   * 2026-09-14 生产排查时把这条 DELETE 列成了"理论上能吞掉真会话"的路:同项目里
   * 任何一条会话,只要它的 id 被这次映射认领,就会被连行删掉,显示日志留成孤儿。
   * 监视器抢先建的那一行长相固定 —— `session_id = provider_session_id`、没有显示日志;
   * 不长这样的一律不删不并不认领。改回"是另一行就删",下面两条立刻红。
   */
  it('gk:同项目、但那一行已经有人聊过(有显示日志)→ 不合并、不删行', () => {
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

  it('gk:同项目、但那一行是 app 行(session_id ≠ provider_session_id)→ 不合并、不删行', () => {
    insertSession('app-victim', '/projects/same', 'victim-provider', '另一段对话');
    insertSession('claimer-2', '/projects/same', null, null);

    expect(db.sessionsDb.assignProviderSessionId('claimer-2', 'victim-provider')).toBe(false);

    const after = rows();
    expect(after.find((r) => r.session_id === 'app-victim')?.provider_session_id).toBe('victim-provider');
    expect(after.find((r) => r.session_id === 'claimer-2')?.provider_session_id).toBeNull();
  });
});
