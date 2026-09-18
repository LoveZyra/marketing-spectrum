import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import express from 'express';
import type { RequestHandler } from 'express';
import { describe, test } from 'vitest';

import { closeConnection, initializeDatabase, projectsDb, userDb } from '@/modules/database/index.js';
import { isRootUser } from '@/shared/root-users.js';

import projectsRouter from '../projects.routes.js';

/**
 * 项目路由的可见性闸门。
 *
 * ## 覆盖率上这个文件是 0.0%
 *
 * 14 条端点,其中 `DELETE /:projectId?force=true` 会 `rm -rf <项目>/attachments/`
 * 加删掉这个项目所有会话的 jsonl —— **不可逆**。而它的闸门是
 * `assertVisibleProject`,靠每条路由自己记得调。逐条挂就意味着**漏一条就是一个洞**,
 * 而这件事在 diff 里看不出来。
 *
 * 这个仓库正是这么破过一次:`usage.routes.ts` 从 index.js 迁出来时漏挂了
 * `canViewerSeeSession`,邻居端点都有,就它没有。
 *
 * ## 这里钉的是**当前语义**,不是我认为对的语义
 *
 * 审计里提过"看得见就能硬删别人的项目"(读写不分)这个风险,用户明确答复分享项目
 * 这条不用管。所以下面钉的是:
 *   - **看不见的人** → 一律 404 同形(这条是真闸门,必须严);
 *   - 看得见的人可读可写(当前设计,不在这里评判);
 *   - 改属主 → 仅 root(这条路由自己另有 requireRoot 式判定)。
 *
 * 哪天要把"可见"拆成"可读/可写",是改这些断言,不是改实现去迁就它们。
 */

type TestUser = { id: number; username: string; isRoot?: boolean };

async function withProjectsServer(
  runTest: (ctx: {
    baseUrl: string;
    users: Record<string, TestUser>;
    aliceProjectId: string;
    publicProjectId: string;
    /** 在公共目录下、但**有主**(alice)的项目:所有人都看得见,只有 alice 是负责人。 */
    ownedPublicProjectId: string;
  }) => Promise<void>,
): Promise<void> {
  const prev = {
    db: process.env.DATABASE_PATH,
    root: process.env.PRISM_ROOT_USERS,
    pub: process.env.PRISM_PUBLIC_WORKSPACE,
  };
  const dir = await mkdtemp(path.join(tmpdir(), 'projects-authz-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  process.env.PRISM_ROOT_USERS = 'boss';
  process.env.PRISM_PUBLIC_WORKSPACE = path.join(dir, 'public');
  await initializeDatabase();

  let server: Server | null = null;
  try {
    const users: Record<string, TestUser> = {};
    for (const name of ['alice', 'bob', 'boss']) {
      users[name] = {
        id: Number(userDb.createUser(name, 'hash').id),
        username: name,
        isRoot: isRootUser(name),
      };
    }

    const alicePath = path.join(dir, 'alice-proj');
    const publicPath = path.join(dir, 'public', 'shared-proj');
    /*
      gn:要测"看得见但不是负责人"就必须有这么一个 —— **有主 + visibility=public**。
      只有 alice-proj(bob 看不见)与无主的 shared-proj(没有负责人这一档)的话,
      "非 owner 归档别人的项目"这个组合根本构造不出来。
      注意公共目录这件事只对**无主**项目起作用:有主项目要靠 visibility 列才对外可见
      (实测里那个 lqm 就是 owner=2 且 isPublic=true)。
    */
    const ownedPublicPath = path.join(dir, 'alice-public');
    for (const p of [alicePath, publicPath, ownedPublicPath]) await mkdir(p, { recursive: true });
    const aliceProjectId = projectsDb.createProjectPath(alicePath, null, users.alice.id).project!.project_id;
    const publicProjectId = projectsDb.createProjectPath(publicPath, null, null).project!.project_id;
    const ownedPublicProjectId = projectsDb.createProjectPath(ownedPublicPath, null, users.alice.id, 'public').project!.project_id;

    const fakeAuth: RequestHandler = (req, _res, next) => {
      const name = String(req.headers['x-test-user'] ?? '');
      (req as unknown as { user?: TestUser }).user = users[name];
      next();
    };

    const app = express();
    app.use(express.json());
    app.use('/api/projects', fakeAuth, projectsRouter);
    // 路由里用了 asyncHandler + AppError,需要一个和生产同形的错误出口
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const status = (error as { statusCode?: number })?.statusCode ?? 500;
      res.status(status).json({ error: (error as Error)?.message ?? 'error' });
    });

    server = app.listen(0);
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address !== 'object') throw new Error('no listen address');

    await runTest({ baseUrl: `http://127.0.0.1:${address.port}`, users, aliceProjectId, publicProjectId, ownedPublicProjectId });
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    closeConnection();
    for (const [key, value] of [
      ['DATABASE_PATH', prev.db], ['PRISM_ROOT_USERS', prev.root], ['PRISM_PUBLIC_WORKSPACE', prev.pub],
    ] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

const call = async (baseUrl: string, asUser: string, method: string, url: string, body?: unknown) => {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-user': asUser },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* 非 JSON */ }
  return { status: response.status, body: parsed, text };
};

describe('项目路由的可见性闸门', () => {
  test('看不见的人:改名 / 收藏 / 恢复 / 删除 全部挡下', async () => {
    await withProjectsServer(async ({ baseUrl, aliceProjectId }) => {
      /*
       * 四条写路径分别写着自己的 `assertVisibleProject` 调用 —— 逐条验,
       * 因为它们是分别写的,漏一条就是一个洞。
       * 删除那条尤其要紧:`?force=true` 会 rm -rf 附件目录并删光会话,不可逆。
       */
      for (const [method, url, body] of [
        ['PUT', `/api/projects/${aliceProjectId}/rename`, { displayName: '我的了' }],
        ['POST', `/api/projects/${aliceProjectId}/toggle-star`, {}],
        ['POST', `/api/projects/${aliceProjectId}/restore`, {}],
        ['DELETE', `/api/projects/${aliceProjectId}?force=true`, undefined],
      ] as const) {
        const asBob = await call(baseUrl, 'bob', method, url, body);
        assert.ok(
          asBob.status === 403 || asBob.status === 404,
          `${method} ${url} 对看不见的人返回了 ${asBob.status}(应当 403/404)`,
        );
      }

      // 项目必须还在、名字没被改
      const still = projectsDb.getProjectById(aliceProjectId);
      assert.ok(still, '项目被看不见的人删掉了');
      assert.notEqual(still?.custom_project_name, '我的了');
    });
  });

  test('看得见的人过闸(证明不是一刀切)', async () => {
    await withProjectsServer(async ({ baseUrl, aliceProjectId }) => {
      const asAlice = await call(baseUrl, 'alice', 'PUT', `/api/projects/${aliceProjectId}/rename`, {
        displayName: '我的项目',
      });
      assert.equal(asAlice.status, 200, `本人被误挡:${asAlice.text}`);
      assert.equal(projectsDb.getProjectById(aliceProjectId)?.custom_project_name, '我的项目');
    });
  });

  test('公共目录下的项目对所有人可见(反向确认)', async () => {
    await withProjectsServer(async ({ baseUrl, publicProjectId }) => {
      const asBob = await call(baseUrl, 'bob', 'POST', `/api/projects/${publicProjectId}/toggle-star`, {});
      assert.equal(asBob.status, 200, `公共项目被误挡:${asBob.text}`);
    });
  });

  /**
   * gn:**归档整个项目也要负责人权限。**
   *
   * 2026-09-15 实测:非 root 的 test 账号把 root 名下的 lqm 项目整个归档了 ——
   * 项目从**所有人**的活跃侧栏消失(可一键还原、没丢数据,但当场谁都看不见它)。
   * 归档以前是"看得见就能做",与会话归档同口径;而项目归档影响的是所有人,
   * 不是只影响自己那一份列表。收紧到与永久删除同一条规则。
   */
  test('归档整个项目:看得见但不是负责人 → 403', async () => {
    await withProjectsServer(async ({ baseUrl, ownedPublicProjectId, publicProjectId }) => {
      // bob 看得见这个项目(它在公共目录下),但负责人是 alice
      const bobArchive = await call(baseUrl, 'bob', 'DELETE', `/api/projects/${ownedPublicProjectId}`);
      assert.equal(bobArchive.status, 403, `归档别人的项目应当 403,实际 ${bobArchive.status}`);
      assert.match(String(bobArchive.body.error ?? ''), /归档/, '403 要说清楚是归档这件事被拦了');

      // 永久删除照旧 403(gk 就有的规则,别被这次改动带坏)
      const bobDelete = await call(baseUrl, 'bob', 'DELETE', `/api/projects/${ownedPublicProjectId}?force=true`);
      assert.equal(bobDelete.status, 403);

      // 负责人自己可以归档
      const aliceArchive = await call(baseUrl, 'alice', 'DELETE', `/api/projects/${ownedPublicProjectId}`);
      assert.equal(aliceArchive.status, 200, `负责人归档自己的项目应当放行,实际 ${aliceArchive.status}`);

      // **无主**项目没有"负责人"这一档 —— 看得见就能归档,这一条不许被收紧掉,
      // 否则普通用户连自己在终端里开出来的项目都归档不了(监视器建的行都是无主的)。
      const bobArchivesUnowned = await call(baseUrl, 'bob', 'DELETE', `/api/projects/${publicProjectId}`);
      assert.equal(bobArchivesUnowned.status, 200, `无主项目应当仍可归档,实际 ${bobArchivesUnowned.status}`);
    });
  });

  test('批量归档走同一条闸门 —— 否则批量入口就是同一件事的后门', async () => {
    await withProjectsServer(async ({ baseUrl, ownedPublicProjectId }) => {
      const response = await call(baseUrl, 'bob', 'POST', '/api/projects/bulk', {
        action: 'archive',
        projectIds: [ownedPublicProjectId],
      });
      assert.equal(response.status, 200, '批量入口逐条鉴权,整体仍是 200');
      const skipped = (response.body.data as { skipped?: Array<{ projectId: string; reason: string }> } | undefined)?.skipped
        ?? (response.body as { skipped?: Array<{ projectId: string; reason: string }> }).skipped
        ?? [];
      assert.equal(skipped.length, 1, `别人的项目应当被跳过,实际 skipped=${JSON.stringify(skipped)}`);
      assert.equal(skipped[0].reason, 'not-manageable');
    });
  });

  test('改属主仅 root', async () => {
    await withProjectsServer(async ({ baseUrl, aliceProjectId, users }) => {
      const asAlice = await call(baseUrl, 'alice', 'PATCH', `/api/projects/${aliceProjectId}/owner`, {
        ownerUserId: users.bob.id,
      });
      assert.equal(asAlice.status, 403, '非 root 改动了项目属主');
      assert.equal(projectsDb.getProjectById(aliceProjectId)?.owner_user_id, users.alice.id);

      const asBoss = await call(baseUrl, 'boss', 'PATCH', `/api/projects/${aliceProjectId}/owner`, {
        ownerUserId: users.bob.id,
      });
      assert.equal(asBoss.status, 200, `root 被误挡:${asBoss.text}`);
      assert.equal(projectsDb.getProjectById(aliceProjectId)?.owner_user_id, users.bob.id);
    });
  });

  test('批量操作逐条鉴权 —— 混进别人的 id 只跳过那一条', async () => {
    await withProjectsServer(async ({ baseUrl, aliceProjectId, publicProjectId }) => {
      /*
       * `bulkProjectAction` 的语义是"看不见的跳过并计数",不是"整批失败"。
       * 这条钉住它:bob 批量收藏 [公共项目, alice 的项目] → 公共那条成功、
       * alice 那条被跳过,而**不是**两条都成功(那就是越权)或两条都失败。
       */
      const asBob = await call(baseUrl, 'bob', 'POST', '/api/projects/bulk', {
        action: 'star',
        projectIds: [publicProjectId, aliceProjectId],
      });
      assert.equal(asBob.status, 200, `批量接口异常:${asBob.text}`);
      // 两个坑:响应包在 `createApiSuccessResponse` 的 `{ success, data }` 里,
      // 而 `succeeded` 是**项目 id 数组**不是计数。断言写错会一直红,
      // 看起来像越权 —— 我第一版就是这么误报的。
      const result = (asBob.body as { data?: { succeeded?: string[]; skipped?: Array<{ reason?: string }> } }).data ?? {};
      assert.deepEqual(result.succeeded, [publicProjectId], '越权:动到了看不见的那个项目');
      assert.equal((result.skipped ?? []).length, 1, '看不见的那条没有被跳过计数');
      assert.equal(result.skipped?.[0]?.reason, 'not-visible');
    });
  });

  test('这个路由本身不做认证 —— 认证在挂载点,必须钉住那一句', () => {
    /*
     * 这条不起服务器,读 index.js 的源码。
     *
     * `projects.routes.ts` 是个 `export default router`,里面**一处认证都没有** ——
     * 它整体依赖挂载时的那一句:
     *
     *     app.use('/api/projects', authenticateToken, projectModuleRoutes);
     *
     * 也就是说,谁把中间件从这一句里拿掉(或者新加一个不带它的挂载点),
     * 14 条端点会一起对匿名请求敞开,而**这个路由文件本身的任何测试都发现不了**
     * —— 我一开始就写错了一条用例:在测试里绕过挂载点直接打路由,得到 200,
     * 差点当成越权报出去。真正该钉的是挂载点。
     */
    const here = path.dirname(new URL(import.meta.url).pathname);
    const indexPath = path.resolve(here, '../../../index.js');
    const source = require('node:fs').readFileSync(indexPath, 'utf8') as string;
    const mount = source.match(/app\.use\(\s*'\/api\/projects'\s*,([^)]*)\)/);
    assert.ok(mount, '在 index.js 里找不到 /api/projects 的挂载点,这条判据已失效');
    assert.match(
      mount[1],
      /authenticateToken/,
      '/api/projects 的挂载点没有 authenticateToken —— 14 条端点会对匿名请求敞开',
    );
  });
});
