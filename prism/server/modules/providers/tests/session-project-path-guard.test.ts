import { mkdirSync, mkdtempSync, rmdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * dz:`POST /api/providers/sessions` 的 projectPath 两道门。
 *
 * 实测(修前,非 root 用户):POST {projectPath:"/"} → 201,`projects` 表多出
 * 一行 owner = 调用者的 `/`,文件树接口随即列出服务器根目录。这里把四种路径
 * × 两种身份钉死。
 *
 * WORKSPACES_ROOT / PRISM_PUBLIC_WORKSPACE / PRISM_ROOT_USERS 都是模块加载时读的,
 * 所以必须在 import 之前设好 —— vi.hoisted 就是干这个的。
 */
const env = vi.hoisted(() => {
  const { mkdtempSync, mkdirSync } = require('node:fs') as typeof import('node:fs');
  const { homedir } = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');
  // 不能放 /tmp、/root 这类 FORBIDDEN_WORKSPACE_PATHS 里的目录:放那儿所有路径
  // 都会被"系统目录"这一条挡掉,测不到后面的可见性判定。按候选顺序挑第一个
  // 不在禁区里的(仓库自己的目录 → 家目录 → /home 下兜底),像真实部署那样。
  const forbidden = ['/tmp', '/root', '/var', '/opt', '/usr', '/etc', '/run'];
  const notForbidden = (candidate: string) =>
    !forbidden.some((prefix) => candidate === prefix || candidate.startsWith(`${prefix}/`));
  const candidates = [
    path.join(process.cwd(), '.vitest-ws'),
    path.join(homedir(), '.prism-test-ws'),
    '/home/prism-vitest-ws',
  ];
  const base = candidates.find(notForbidden) ?? candidates[0];
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, 'ws-root-'));
  const publicDir = path.join(root, 'public');
  const privateDir = path.join(root, 'private');
  mkdirSync(publicDir);
  mkdirSync(privateDir);
  process.env.WORKSPACES_ROOT = root;
  process.env.PRISM_PUBLIC_WORKSPACE = publicDir;
  process.env.PRISM_ROOT_USERS = 'admin';
  return { base, root, publicDir, privateDir };
});

import { closeConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';
import { assertViewerMayCreateSessionAt } from '@/modules/providers/services/session-project-path-guard.service.js';

const mallory = { userId: 2, username: 'mallory' };
const admin = { userId: 1, username: 'admin' };

let dbDir: string;

beforeAll(async () => {
  dbDir = mkdtempSync(path.join(tmpdir(), 'guard-db-'));
  process.env.DATABASE_PATH = path.join(dbDir, 'auth.db');
  await initializeDatabase();
});

afterAll(() => {
  closeConnection();
  rmSync(dbDir, { recursive: true, force: true });
  rmSync(env.root, { recursive: true, force: true });
  // base 目录只在空了的时候才拆(别的测试文件可能并行用着同一个 base)。
  try { rmdirSync(env.base); } catch { /* 非空或不存在都无所谓 */ }
});

const rejects = (viewer: { userId: number; username: string }, target: string) =>
  expect(assertViewerMayCreateSessionAt(viewer, target)).rejects.toMatchObject({ statusCode: 404 });

describe('会话建在哪个目录 —— 非 root', () => {
  it('根目录 / 与工作区外的路径:404(修前 201 且成为 owner)', async () => {
    await rejects(mallory, '/');
    await rejects(mallory, tmpdir());
  });

  it('工作区内、未登记、不在公共目录:404(否则登记成他名下的私有项目)', async () => {
    await rejects(mallory, env.privateDir);
  });

  it('工作区内、未登记、在公共目录下:放行', async () => {
    await expect(assertViewerMayCreateSessionAt(mallory, path.join(env.publicDir, 'demo'))).resolves.toBeUndefined();
  });

  it('已登记且是自己的项目:放行(不再重验工作区)', async () => {
    const mine = path.join(env.privateDir, 'mine');
    mkdirSync(mine, { recursive: true });
    projectsDb.createProjectPath(mine, null, mallory.userId);
    await expect(assertViewerMayCreateSessionAt(mallory, mine)).resolves.toBeUndefined();
  });

  it('已登记但是别人的私有项目:404', async () => {
    const theirs = path.join(env.privateDir, 'theirs');
    mkdirSync(theirs, { recursive: true });
    projectsDb.createProjectPath(theirs, null, 99);
    await rejects(mallory, theirs);
  });

  it('空路径:400', async () => {
    await expect(assertViewerMayCreateSessionAt(mallory, '   ')).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('会话建在哪个目录 —— root', () => {
  it('别人的私有项目也放行(root 全可见)', async () => {
    const theirs = path.join(env.privateDir, 'theirs');
    await expect(assertViewerMayCreateSessionAt(admin, theirs)).resolves.toBeUndefined();
  });

  it('但未登记的系统目录仍挡(validateWorkspacePath 对谁都生效)', async () => {
    await rejects(admin, '/etc');
  });
});
