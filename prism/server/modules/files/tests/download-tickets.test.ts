/**
 * 「交给浏览器自己下」的两条路由。
 *
 * 这套东西存在的理由只有一个:**一次普通导航设不了 `Authorization` 头**。
 * 页面自己 fetch 再拼 blob 没有这个问题,但整份文件要先进内存 —— 没有进度条、
 * 切页就断、大文件把标签页撑崩。要把下载交回浏览器的下载管理器,凭据只能进 URL。
 *
 * 所以这里新增了一条**不挂 `authenticateToken` 的路由**。这是本次唯一的安全面
 * 变化,下面的断言按"这条路由能被任何人打到"来写:
 *   - 票必须限定到**一个目标**(泄了只泄那一个文件,不是那个账号);
 *   - 票**跨项目、跨用途都不认**;
 *   - 票只证明"是谁在下",可见性和路径在直传口**重跑一遍**;
 *   - 路径**不进查询串**(所以也不进反代日志)。
 *
 * 另外两条是"进度条到底成不成立"的硬前提,一样在这里钉:
 *   - 单文件直传**必须**有 `Content-Length`,否则浏览器画不出百分比;
 *   - 流式打包**必须没有** `Content-Length` —— 边压边发算不出总长度,
 *     写一个猜的值会让浏览器提前判定完成,用户拿到截断的包。
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import express from 'express';
import type { RequestHandler } from 'express';
import JSZip from 'jszip';
import { describe, test, expect } from 'vitest';

import { closeConnection, initializeDatabase, projectsDb, userDb } from '@/modules/database/index.js';

import { createFileDownloadRouter, createFilesRouter } from '../files.routes.js';

type TestUser = { id: number; username: string };

type Ctx = {
  baseUrl: string;
  aliceProjectId: string;
  bobProjectId: string;
  /** alice 项目根的绝对路径。 */
  aliceRoot: string;
};

async function withFilesServer(runTest: (ctx: Ctx) => Promise<void>): Promise<void> {
  const prev = { db: process.env.DATABASE_PATH, pub: process.env.PRISM_PUBLIC_WORKSPACE };
  const dir = await mkdtemp(path.join(tmpdir(), 'download-tickets-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'dl.db');
  process.env.PRISM_PUBLIC_WORKSPACE = path.join(dir, 'public');
  await initializeDatabase();

  let server: Server | null = null;
  try {
    const users: Record<string, TestUser> = {};
    for (const name of ['alice', 'bob']) {
      users[name] = { id: Number(userDb.createUser(name, 'hash').id), username: name };
    }

    const aliceRoot = path.join(dir, 'alice-proj');
    const bobRoot = path.join(dir, 'bob-proj');
    await mkdir(path.join(aliceRoot, 'docs', 'deep', 'deeper'), { recursive: true });
    await mkdir(path.join(aliceRoot, 'other'), { recursive: true });
    await mkdir(bobRoot, { recursive: true });

    // 中文名 + 空格:直传口的 Content-Disposition 要靠 RFC 5987 才传得出去。
    await writeFile(path.join(aliceRoot, '季度报告 2026.txt'), '中文内容'.repeat(64), 'utf8');
    await writeFile(path.join(aliceRoot, 'plain.bin'), Buffer.alloc(4096, 7));
    // 同名不同目录 —— 打包时 basename 会撞车,必须靠相对路径区分。
    await writeFile(path.join(aliceRoot, 'docs', 'same.txt'), 'from-docs', 'utf8');
    await writeFile(path.join(aliceRoot, 'other', 'same.txt'), 'from-other', 'utf8');
    // 深到旧的前端打包会漏掉的位置。
    await writeFile(path.join(aliceRoot, 'docs', 'deep', 'deeper', 'buried.txt'), 'buried', 'utf8');

    const aliceProjectId = projectsDb.createProjectPath(aliceRoot, null, users.alice.id).project!.project_id;
    const bobProjectId = projectsDb.createProjectPath(bobRoot, null, users.bob.id).project!.project_id;

    const fakeAuth: RequestHandler = (req, _res, next) => {
      const name = String(req.headers['x-test-user'] ?? '');
      (req as unknown as { user?: TestUser }).user = users[name];
      next();
    };

    const app = express();
    app.use(express.json());

    /**
     * **这一行是故意照抄 `server/index.js:502` 的。**
     *
     * 那句 `app.use('/api/projects', authenticateToken, projectModuleRoutes)` 是
     * 前缀中间件,排在文件路由**前面** —— 任何 `/api/projects/...` 的请求都要先过它。
     *
     * 第一版实现把直传口挂在 `/api/projects/:id/files/download` 上,隔离测试里
     * **全绿**,真实 app 里**每一次下载都是 401**,而且和"票过期"同形。测试harness
     * 不复刻这道前缀中间件,就复刻不出这个坑。所以它留在这里:哪天有人把直传口挪回
     * `/api/projects` 下面,下面那些测试会立刻红。
     */
    const blanketAuth: RequestHandler = (req, res, next) => {
      if (!users[String(req.headers['x-test-user'] ?? '')]) {
        return res.status(401).json({ error: '被 /api/projects 的前缀鉴权挡下了' });
      }
      return next();
    };
    app.use('/api/projects', blanketAuth, express.Router());

    // authenticateToken 是**注入**的,路由各自决定挂不挂。
    app.use(createFilesRouter({ authenticateToken: fakeAuth }));
    // 直传口:连 authenticateToken 的注入口都没有,挂在另一个前缀下。
    app.use('/api/downloads', createFileDownloadRouter());

    server = app.listen(0);
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address !== 'object') throw new Error('no listen address');

    await runTest({ baseUrl: `http://127.0.0.1:${address.port}`, aliceProjectId, bobProjectId, aliceRoot });
  } finally {
    if (server) {
      // undici(global fetch)会把连接留在 keep-alive 池里,close() 就得干等它超时。
      // 这是测试宿主的行为,不是路由没把响应收掉 —— 但等 3 秒 × N 条也是白等。
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    closeConnection();
    for (const [key, value] of [['DATABASE_PATH', prev.db], ['PRISM_PUBLIC_WORKSPACE', prev.pub]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

const issue = async (baseUrl: string, asUser: string, projectId: string, paths: string[]) => {
  const response = await fetch(`${baseUrl}/api/projects/${projectId}/files/download-ticket`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': asUser },
    body: JSON.stringify({ paths }),
  });
  const text = await response.text();
  let body: Record<string, string> = {};
  try { body = JSON.parse(text) as Record<string, string>; } catch { /* 非 JSON */ }
  return { status: response.status, body, text };
};

describe('下载票:签发这一步', () => {
  test('看不见这个项目的人签不出票 —— 挡在 fetch 语境里,不是挡在下载栏里', async () => {
    await withFilesServer(async ({ baseUrl, aliceProjectId }) => {
      const asBob = await issue(baseUrl, 'bob', aliceProjectId, ['plain.bin']);
      expect(asBob.status).toBe(404);
      expect(asBob.body.url).toBeUndefined();
    });
  });

  test('路径越界签不出票', async () => {
    await withFilesServer(async ({ baseUrl, aliceProjectId }) => {
      const escaped = await issue(baseUrl, 'alice', aliceProjectId, ['../bob-proj']);
      expect(escaped.status).toBe(403);
    });
  });

  test('文件不存在签不出票 —— 失败必须发生在用户按下去的那一瞬间', async () => {
    await withFilesServer(async ({ baseUrl, aliceProjectId }) => {
      const missing = await issue(baseUrl, 'alice', aliceProjectId, ['nope.txt']);
      expect(missing.status).toBe(404);
    });
  });

  test('单个文件 → 直传;目录或多选 → 打包', async () => {
    await withFilesServer(async ({ baseUrl, aliceProjectId }) => {
      const one = await issue(baseUrl, 'alice', aliceProjectId, ['plain.bin']);
      expect(one.body.kind).toBe('file');
      expect(one.body.url).toContain('/api/downloads/file?ticket=');

      const dir = await issue(baseUrl, 'alice', aliceProjectId, ['docs']);
      expect(dir.body.kind).toBe('zip');
      expect(dir.body.name).toBe('docs.zip');

      const many = await issue(baseUrl, 'alice', aliceProjectId, ['plain.bin', 'docs/same.txt']);
      expect(many.body.kind).toBe('zip');
      expect(many.body.url).toContain('/api/downloads/zip?ticket=');
    });
  });

  test('目标路径不进 URL —— 反代日志里只该留下一串随机数', async () => {
    await withFilesServer(async ({ baseUrl, aliceProjectId }) => {
      const one = await issue(baseUrl, 'alice', aliceProjectId, ['docs/same.txt']);
      expect(one.body.url).not.toContain('same.txt');
      expect(one.body.url).not.toContain('path=');
    });
  });
});

describe('下载票:直传这一步', () => {
  test('字节原样、长度对得上 —— Content-Length 是进度条唯一的硬前提', async () => {
    await withFilesServer(async ({ baseUrl, aliceProjectId }) => {
      const { body } = await issue(baseUrl, 'alice', aliceProjectId, ['plain.bin']);
      // 故意不带任何认证头 —— 这条路由就是给浏览器裸导航用的。
      const response = await fetch(`${baseUrl}${body.url}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-length')).toBe('4096');
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(bytes.length).toBe(4096);
      expect(bytes.every((b) => b === 7)).toBe(true);
    });
  });

  test('中文名走 RFC 5987,同时留一份 ASCII 回落', async () => {
    await withFilesServer(async ({ baseUrl, aliceProjectId }) => {
      const { body } = await issue(baseUrl, 'alice', aliceProjectId, ['季度报告 2026.txt']);
      const response = await fetch(`${baseUrl}${body.url}`);
      const disposition = response.headers.get('content-disposition') ?? '';
      expect(disposition).toContain('attachment;');
      expect(disposition).toContain("filename*=UTF-8''");
      expect(decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(disposition)![1])).toBe('季度报告 2026.txt');
      expect(disposition).toMatch(/filename="[\x20-\x7e]*"/);
      await response.arrayBuffer();
    });
  });

  test('这条口永远是附件 —— 和 files/content 的 inline 白名单不是一回事', async () => {
    await withFilesServer(async ({ baseUrl, aliceProjectId, aliceRoot }) => {
      await writeFile(path.join(aliceRoot, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const { body } = await issue(baseUrl, 'alice', aliceProjectId, ['pic.png']);
      const response = await fetch(`${baseUrl}${body.url}`);
      // files/content 对 image/* 是允许 inline 的;这条口的存在理由就是"存到硬盘",
      // 一个 MP4 在标签页里播起来是彻底的答非所问。
      expect(response.headers.get('content-disposition')).toContain('attachment');
      await response.arrayBuffer();
    });
  });

  test('直传口挂在 /api/downloads 下,不会被 /api/projects 的前缀鉴权吃掉', async () => {
    await withFilesServer(async ({ baseUrl, aliceProjectId }) => {
      const { body } = await issue(baseUrl, 'alice', aliceProjectId, ['plain.bin']);
      expect(body.url.startsWith('/api/downloads/')).toBe(true);

      // 同一张票,换回旧位置就会被前缀鉴权挡下 —— 这正是第一版实现踩的坑。
      const ticket = new URL(body.url, 'http://x').searchParams.get('ticket');
      const oldShape = await fetch(
        `${baseUrl}/api/projects/${aliceProjectId}/files/download?ticket=${ticket}`,
      );
      expect(oldShape.status).toBe(401);
      expect((await oldShape.json()).error).toContain('前缀鉴权');
    });
  });

  test('单文件票打不了打包口,反之亦然', async () => {
    await withFilesServer(async ({ baseUrl, aliceProjectId }) => {
      const file = await issue(baseUrl, 'alice', aliceProjectId, ['plain.bin']);
      const fileTicket = new URL(file.body.url, 'http://x').searchParams.get('ticket');
      const asZip = await fetch(`${baseUrl}/api/downloads/zip?ticket=${fileTicket}`);
      expect(asZip.status).toBe(401);

      const zip = await issue(baseUrl, 'alice', aliceProjectId, ['docs']);
      const zipTicket = new URL(zip.body.url, 'http://x').searchParams.get('ticket');
      const asFile = await fetch(`${baseUrl}/api/downloads/file?ticket=${zipTicket}`);
      expect(asFile.status).toBe(401);
    });
  });

  test('乱填 / 缺票 一律 401,不泄露任何区别', async () => {
    await withFilesServer(async ({ baseUrl }) => {
      for (const query of ['', '?ticket=', '?ticket=deadbeef']) {
        const response = await fetch(`${baseUrl}/api/downloads/file${query}`);
        expect(response.status).toBe(401);
      }
    });
  });
});

describe('下载票:流式打包', () => {
  test('不写 Content-Length —— 写一个猜的值会让浏览器提前判完成', async () => {
    await withFilesServer(async ({ baseUrl, aliceProjectId }) => {
      const { body } = await issue(baseUrl, 'alice', aliceProjectId, ['docs']);
      const response = await fetch(`${baseUrl}${body.url}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-length')).toBeNull();
      expect(response.headers.get('content-type')).toContain('application/zip');
      await response.arrayBuffer();
    });
  });

  test('深层子目录也在包里 —— 旧的前端打包会把它们静默吞掉', async () => {
    await withFilesServer(async ({ baseUrl, aliceProjectId }) => {
      const { body } = await issue(baseUrl, 'alice', aliceProjectId, ['docs']);
      const response = await fetch(`${baseUrl}${body.url}`);
      const zip = await JSZip.loadAsync(Buffer.from(await response.arrayBuffer()));
      const names = Object.keys(zip.files).filter((n) => !n.endsWith('/'));
      expect(names).toContain('docs/deep/deeper/buried.txt');
      expect(await zip.file('docs/deep/deeper/buried.txt')!.async('string')).toBe('buried');
    });
  });

  test('多选到两个同名文件时,包里不撞车', async () => {
    await withFilesServer(async ({ baseUrl, aliceProjectId }) => {
      const { body } = await issue(baseUrl, 'alice', aliceProjectId, ['docs/same.txt', 'other/same.txt']);
      const response = await fetch(`${baseUrl}${body.url}`);
      const zip = await JSZip.loadAsync(Buffer.from(await response.arrayBuffer()));
      expect(await zip.file('docs/same.txt')!.async('string')).toBe('from-docs');
      expect(await zip.file('other/same.txt')!.async('string')).toBe('from-other');
    });
  });

  test('打包口同样在 /api/downloads 下', async () => {
    await withFilesServer(async ({ baseUrl, aliceProjectId }) => {
      const { body } = await issue(baseUrl, 'alice', aliceProjectId, ['docs']);
      expect(body.url.startsWith('/api/downloads/zip?')).toBe(true);
    });
  });
});

/**
 * 上面那些跑的是**这个测试自己搭的 app**。真实装配在 `server/index.js` 里,
 * 而第一版实现正是**装配顺序**上出的问题 —— 隔离测试全绿、真实 app 全 401。
 * 所以这里再钉一道:真实装配文件里,这两个 router 必须挂在 `/api/downloads` 上,
 * 并且**不许**有人给这个前缀套上 authenticateToken(套上就等于这条路彻底失效,
 * 而表现只是"下载点了没反应",不会有任何报错)。
 */
describe('真实装配', () => {
  const indexSource = readFileSync(
    new URL('../../../index.js', import.meta.url),
    'utf8',
  );

  test('两个直传 router 都挂在 /api/downloads 下', () => {
    expect(indexSource).toContain("app.use('/api/downloads', createFileDownloadRouter());");
    expect(indexSource).toContain("app.use('/api/downloads', createSessionOutputDownloadRouter());");
  });

  test('没人给 /api/downloads 套登录中间件', () => {
    expect(indexSource).not.toMatch(/app\.use\('\/api\/downloads',\s*authenticateToken/);
  });

  test('/api/projects 的前缀鉴权仍然排在文件路由前面 —— 这正是不能挂那儿的原因', () => {
    const blanket = indexSource.indexOf("app.use('/api/projects', authenticateToken");
    const files = indexSource.indexOf('app.use(createFilesRouter(');
    expect(blanket).toBeGreaterThan(-1);
    expect(files).toBeGreaterThan(blanket);
  });
});
