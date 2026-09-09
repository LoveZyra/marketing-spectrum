import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import express from 'express';
import type { RequestHandler } from 'express';
import { describe, test } from 'vitest';

import {
  closeConnection,
  initializeDatabase,
  projectsDb,
  scheduledTasksDb,
  userDb,
} from '@/modules/database/index.js';

import { createTasksRouter } from '../tasks.routes.js';

/**
 * 定时任务路由的两道门:`canTouch`(能不能碰这个任务)与 `checkProjectPath`
 * (能不能拿这个路径建任务)。
 *
 * ## 为什么必须在**路由层**测,而不是只测那两个函数
 *
 * 覆盖率报告里 `tasks.routes.ts` 是 **0.0%** —— 全仓 165 个测试文件里只有 5 个真正
 * 起过 express 实例,而 tasks 不在其中。它自己的注释写着「权限模式默认跳过确认、
 * 且可见者全权可改 —— 这条校验因此是**唯一的边界**」,而这条唯一的边界一行测试都没有。
 *
 * 只测函数证明不了路由**调没调**它。历史上这个仓库正是这么破的:`usage.routes.ts`
 * 从 index.js 迁出来时漏挂了 `canViewerSeeSession`,而那个函数本身好好的。
 *
 * ## 判据:用文案区分"被闸门挡下"与"过闸后的正常失败"
 *
 * 与 `usage-visibility.test.ts` 同一策略。只断言状态码会把"闸门放行了但后面报错"
 * 误判成"闸门挡住了" —— 那样以后有人把闸门改成一刀切也测不出来。
 *
 * ## 注意:定时任务「可见即可改」是**有意设计**
 *
 * 审计里提过"可见即可改指令、以 bypassPermissions 定时执行"的风险,用户明确答复
 * 这是设计如此、不调整。所以这里钉的是**当前语义**:可见者可改、不可见者一律 404。
 * 哪天要收紧成 owner-only,是改这些断言,不是改实现去迁就它们。
 */

type TestUser = { id: number; username: string };

async function withTasksServer(
  runTest: (ctx: {
    baseUrl: string;
    users: Record<string, TestUser>;
    alicePath: string;
    bobPath: string;
    publicPath: string;
    aliceTaskId: string;
    tempDirectory: string;
  }) => Promise<void>,
): Promise<void> {
  const prev = {
    db: process.env.DATABASE_PATH,
    root: process.env.PRISM_ROOT_USERS,
    pub: process.env.PRISM_PUBLIC_WORKSPACE,
    ws: process.env.WORKSPACES_ROOT,
  };
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'tasks-authz-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  process.env.PRISM_ROOT_USERS = 'boss';
  process.env.WORKSPACES_ROOT = tempDirectory;
  process.env.PRISM_PUBLIC_WORKSPACE = path.join(tempDirectory, 'public');
  await initializeDatabase();

  let server: Server | null = null;
  try {
    const users: Record<string, TestUser> = {};
    for (const name of ['alice', 'bob', 'boss']) {
      users[name] = { id: Number(userDb.createUser(name, 'hash').id), username: name };
    }

    const alicePath = path.join(tempDirectory, 'alice-proj');
    const bobPath = path.join(tempDirectory, 'bob-proj');
    const publicPath = path.join(tempDirectory, 'public', 'shared-proj');
    for (const dir of [alicePath, bobPath, publicPath]) await mkdir(dir, { recursive: true });
    projectsDb.createProjectPath(alicePath, null, users.alice.id);
    projectsDb.createProjectPath(bobPath, null, users.bob.id);
    projectsDb.createProjectPath(publicPath, null, null);

    const aliceTaskId = 'task-alice-0001';
    scheduledTasksDb.insert({
      id: aliceTaskId,
      name: 'alice 的任务',
      instructions: '跑个回归',
      project_path: alicePath,
      session_mode: 'new',
      fixed_session_id: null,
      frequency: 'manual',
      run_at_hour: null, run_at_minute: null, run_at_weekday: null, run_at_day: null,
      model: null, permission_mode: 'acceptEdits',
      enabled: 1, owner_user_id: users.alice.id, next_run_at: null,
    });

    const fakeAuth: RequestHandler = (req, _res, next) => {
      const name = String(req.headers['x-test-user'] ?? '');
      (req as unknown as { user?: TestUser }).user = users[name];
      next();
    };

    const app = express();
    app.use(express.json());
    app.use('/api/tasks', createTasksRouter({ authenticateToken: fakeAuth }));

    server = app.listen(0);
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address !== 'object') throw new Error('no listen address');

    await runTest({
      baseUrl: `http://127.0.0.1:${address.port}`,
      users, alicePath, bobPath, publicPath,
      aliceTaskId, tempDirectory,
    });
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    closeConnection();
    for (const [key, value] of [
      ['DATABASE_PATH', prev.db], ['PRISM_ROOT_USERS', prev.root],
      ['PRISM_PUBLIC_WORKSPACE', prev.pub], ['WORKSPACES_ROOT', prev.ws],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const call = async (
  baseUrl: string, asUser: string, method: string, url: string, body?: unknown,
) => {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-user': asUser },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: { error?: string; success?: boolean; task?: unknown } = {};
  try { parsed = JSON.parse(text) as typeof parsed; } catch { /* 非 JSON 就留空 */ }
  return { status: response.status, body: parsed, text };
};

describe('定时任务路由的鉴权闸门', () => {
  test('看不见项目的人:读/改/删/立即运行 一律 404 同形', async () => {
    await withTasksServer(async ({ baseUrl, aliceTaskId }) => {
      // bob 看不见 alice 的项目 → 这个任务对他应当"不存在"。
      // 四条路都要验:少挂一条就是一个洞,而它们是分别写的。
      for (const [method, url, body] of [
        ['GET', `/api/tasks/${aliceTaskId}`, undefined],
        ['GET', `/api/tasks/${aliceTaskId}/runs`, undefined],
        ['PATCH', `/api/tasks/${aliceTaskId}`, { name: '改成我的' }],
        ['DELETE', `/api/tasks/${aliceTaskId}`, undefined],
        ['POST', `/api/tasks/${aliceTaskId}/run`, undefined],
      ] as const) {
        const asBob = await call(baseUrl, 'bob', method, url, body);
        assert.equal(asBob.status, 404, `${method} ${url} 没有挡住 bob`);
        assert.equal(asBob.body.error, 'Task not found', `${method} ${url} 的文案泄漏了存在性`);
      }

      // 真的没改动:PATCH 被挡之后任务名必须原样
      const asAlice = await call(baseUrl, 'alice', 'GET', `/api/tasks/${aliceTaskId}`);
      assert.equal(asAlice.status, 200);
      assert.equal((asAlice.body.task as { name: string }).name, 'alice 的任务');
    });
  });

  test('本人与 root 过闸(文案不同,证明不是一刀切)', async () => {
    await withTasksServer(async ({ baseUrl, aliceTaskId }) => {
      for (const who of ['alice', 'boss']) {
        const got = await call(baseUrl, who, 'GET', `/api/tasks/${aliceTaskId}`);
        assert.equal(got.status, 200, `${who} 被误挡`);
        assert.equal(got.body.success, true);
      }
    });
  });

  test('列表只列得出自己看得见的', async () => {
    await withTasksServer(async ({ baseUrl }) => {
      const bobList = await call(baseUrl, 'bob', 'GET', '/api/tasks/');
      assert.equal(bobList.status, 200);
      assert.deepEqual((bobList.body as { tasks?: unknown[] }).tasks, []);

      const aliceList = await call(baseUrl, 'alice', 'GET', '/api/tasks/');
      assert.equal((aliceList.body as { tasks: unknown[] }).tasks.length, 1);
    });
  });

  /**
   * 下面两条**顺带钉住了 A-2 那个漂移**。
   *
   * 路由原来那份内联判据**无条件**先跑 `validateWorkspacePath`,而 service 那份对
   * **已登记的项目**显式跳过工作区重验(注释写明理由:免得 WORKSPACES_ROOT 后来
   * 改窄时把老项目也拦住)。差别的后果是:同一个已登记项目**开会话可以、建定时任务
   * 被 400 挡掉**。
   *
   * 这个测试的临时目录在 tmpdir 下,而 tmpdir 会被 validateWorkspacePath 判成
   * "system directory" —— 于是换回旧实现时,下面这两条会立刻红。实测过。
   */
  test('建任务:拿别人的项目路径建不出来', async () => {
    await withTasksServer(async ({ baseUrl, bobPath }) => {
      const asAlice = await call(baseUrl, 'alice', 'POST', '/api/tasks/', {
        name: '偷跑', instructions: '干点什么', projectPath: bobPath,
        sessionMode: 'new', frequency: 'manual',
      });
      assert.equal(asAlice.status, 400);
      assert.match(String(asAlice.body.error), /项目不存在|没有权限/);
    });
  });

  test('建任务失败时**只给同形文案**,不透露是哪道检查没过', async () => {
    await withTasksServer(async ({ baseUrl }) => {
      const asAlice = await call(baseUrl, 'alice', 'POST', '/api/tasks/', {
        name: '越界', instructions: '干点什么', projectPath: '/',
        sessionMode: 'new', frequency: 'manual',
      });
      assert.equal(asAlice.status, 400);
      /*
       * 这条钉的是**反探针性质**。
       *
       * 路由原来内联了自己那份路径校验,失败时把 `validateWorkspacePath` 的**原始错误串**
       * 直接回给客户端,而那些串是会说话的:
       *   "Cannot create workspace in system directory: /tmp"
       *   "Workspace path must be within the allowed workspace root: <WORKSPACES_ROOT>"
       * 第一句告诉你这条路径存在但被判成系统目录,第二句直接**把服务端配置的工作区根
       * 读给了任意登录用户**。两句都在回答"这个路径到底怎么了" —— 那正是探针。
       *
       * 会话路由那份(assertViewerMayCreateSessionAt)对两种失败一律返回同形文案,
       * 注释写明"不给一个这个路径存不存在的探针"。fa 轮把 tasks 换成了共用那一份。
       *
       * 判据写成"不许出现任何一句会说话的原文",而不是"必须等于某句话" ——
       * 后者会被将来的文案调整误伤,前者盯的是性质。
       */
      const message = `${asAlice.body.error ?? ''}${asAlice.text}`;
      for (const leak of [
        'workspace root',
        'system directory',
        'system-critical',
        String(process.env.WORKSPACES_ROOT ?? '\u0000never'),
      ]) {
        assert.ok(!message.includes(leak), `错误响应泄漏了「${leak}」:${asAlice.text}`);
      }
    });
  });

  test('建任务:公共目录下的项目谁都能用(反向确认闸门不是一刀切)', async () => {
    await withTasksServer(async ({ baseUrl, publicPath }) => {
      const asBob = await call(baseUrl, 'bob', 'POST', '/api/tasks/', {
        name: '公共项目上的任务', instructions: '跑一下', projectPath: publicPath,
        sessionMode: 'new', frequency: 'manual',
      });
      assert.equal(asBob.status, 201, `公共项目被误挡:${asBob.text}`);
    });
  });

  test('未登录(中间件没挂上 user)一律挡下', async () => {
    await withTasksServer(async ({ baseUrl, aliceTaskId }) => {
      // x-test-user 给一个不存在的名字 → req.user 为 undefined,等价于未认证。
      const anon = await call(baseUrl, 'nobody', 'GET', `/api/tasks/${aliceTaskId}`);
      assert.equal(anon.status, 404);
    });
  });
});
