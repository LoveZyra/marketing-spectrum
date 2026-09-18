/**
 * 会话产出的直传下载(`/api/downloads/session-output`)。
 *
 * 这是本次新增的第三条**不带登录态**的路由。它比项目文件那两条更值得单测:
 * 会话产出**不一定落在项目目录里** —— agent 把计划写进 `~/.claude/plans/`、
 * 临时脚本写进 `/tmp` 都很常见,所以这条通道的边界不是"项目根以内",而是
 * **"这段会话自己成功写出来过"**。边界换了一种,就得单独钉。
 *
 * 三道闸(会话可见 → 路径在本会话写入集合里 → 是个真文件)由
 * `checkSessionOutputAccess` 统一提供,**签票和直传各跑一遍**。下面最后一条测试
 * 钉的就是这个"各跑一遍":票签出来之后把会话删掉,同一张票必须立刻失效 ——
 * 票证明的是"是谁在下",不是"现在还能下"。
 */
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import express from 'express';
import type { RequestHandler } from 'express';
import { describe, test, expect } from 'vitest';

import {
  closeConnection,
  initializeDatabase,
  projectsDb,
  sessionMessagesDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';

import {
  createSessionOutputDownloadRouter,
  createSessionOutputsRouter,
} from '../session-outputs.routes.js';

type TestUser = { id: number; username: string };

type Ctx = {
  baseUrl: string;
  sessionId: string;
  /** 会话产出的真实路径 —— 故意放在**项目目录之外**。 */
  outputPath: string;
  /** 项目内的一个文件,这段会话从没写过它。 */
  notAnOutput: string;
};

const displayMessage = (over: Record<string, unknown>) => ({
  id: 'm1',
  sessionId: 's1',
  kind: 'text',
  role: 'assistant',
  content: '',
  timestamp: '2026-09-16T10:00:00.000Z',
  provider: 'claude',
  ...over,
}) as never;

async function withServer(runTest: (ctx: Ctx) => Promise<void>): Promise<void> {
  const prev = { db: process.env.DATABASE_PATH, pub: process.env.PRISM_PUBLIC_WORKSPACE };
  const dir = await mkdtemp(path.join(tmpdir(), 'session-output-dl-'));

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

    const projectRoot = path.join(dir, 'alice-proj');
    const outsideDir = path.join(dir, 'agent-scratch');
    await mkdir(projectRoot, { recursive: true });
    await mkdir(outsideDir, { recursive: true });

    // 产出在项目**外**:这正是这条通道存在的理由(项目文件接口只服务项目根以内)。
    const outputPath = path.join(outsideDir, '计划 v2.md');
    await writeFile(outputPath, '# 计划\n'.repeat(100), 'utf8');
    const notAnOutput = path.join(projectRoot, 'secret.txt');
    await writeFile(notAnOutput, 'not written by this session', 'utf8');

    projectsDb.createProjectPath(projectRoot, null, users.alice.id);
    const sessionId = sessionsDb.createSession('provider-1', 'claude', projectRoot);

    // 一次成功的 Write:工具帧 + 非错的结果帧。少了结果帧就不算"成功写出"。
    sessionMessagesDb.appendMany(sessionId, [
      displayMessage({
        id: 'w1', sessionId, kind: 'tool_use',
        toolName: 'Write', toolId: 't1', toolInput: { file_path: outputPath },
      }),
      displayMessage({ id: 'r1', sessionId, kind: 'tool_result', toolId: 't1', isError: false }),
    ]);

    const fakeAuth: RequestHandler = (req, _res, next) => {
      (req as unknown as { user?: TestUser }).user = users[String(req.headers['x-test-user'] ?? '')];
      next();
    };

    const app = express();
    app.use(express.json());
    app.use('/api/providers', createSessionOutputsRouter({ authenticateToken: fakeAuth }));
    // 直传口:连 authenticateToken 的注入口都没有。
    app.use('/api/downloads', createSessionOutputDownloadRouter());

    server = app.listen(0);
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address !== 'object') throw new Error('no listen address');

    await runTest({ baseUrl: `http://127.0.0.1:${address.port}`, sessionId, outputPath, notAnOutput });
  } finally {
    if (server) {
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

const issue = async (baseUrl: string, asUser: string, sessionId: string, filePath: string) => {
  const response = await fetch(
    `${baseUrl}/api/providers/sessions/${encodeURIComponent(sessionId)}/output-download-ticket`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': asUser },
      body: JSON.stringify({ path: filePath }),
    },
  );
  const text = await response.text();
  let body: Record<string, string> = {};
  try { body = JSON.parse(text) as Record<string, string>; } catch { /* 非 JSON */ }
  return { status: response.status, body };
};

describe('会话产出直传:签票这一步', () => {
  test('看不见这段会话的人签不出票', async () => {
    await withServer(async ({ baseUrl, sessionId, outputPath }) => {
      expect((await issue(baseUrl, 'bob', sessionId, outputPath)).status).toBe(404);
    });
  });

  test('不是本会话产出的路径签不出票 —— 边界是"写过",不是"在项目里"', async () => {
    await withServer(async ({ baseUrl, sessionId, notAnOutput }) => {
      // notAnOutput 就在项目根里,但这段会话从没写过它。
      expect((await issue(baseUrl, 'alice', sessionId, notAnOutput)).status).toBe(403);
    });
  });

  test('签出来的 URL 挂在 /api/downloads 下,且不含路径', async () => {
    await withServer(async ({ baseUrl, sessionId, outputPath }) => {
      const { body } = await issue(baseUrl, 'alice', sessionId, outputPath);
      expect(body.url.startsWith('/api/downloads/session-output?ticket=')).toBe(true);
      expect(body.url).not.toContain('计划');
      expect(body.url).not.toContain(encodeURIComponent('计划'));
    });
  });
});

describe('会话产出直传:取字节这一步', () => {
  test('项目外的产出照样下得到,长度和中文名都对', async () => {
    await withServer(async ({ baseUrl, sessionId, outputPath }) => {
      const { body } = await issue(baseUrl, 'alice', sessionId, outputPath);
      // 不带任何认证头 —— 这条路由就是给浏览器裸导航用的。
      const response = await fetch(`${baseUrl}${body.url}`);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text.startsWith('# 计划')).toBe(true);
      expect(response.headers.get('content-length')).toBe(String(Buffer.byteLength(text)));
      const disposition = response.headers.get('content-disposition') ?? '';
      expect(decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(disposition)![1])).toBe('计划 v2.md');
    });
  });

  test('乱填 / 缺票一律 401', async () => {
    await withServer(async ({ baseUrl }) => {
      for (const query of ['', '?ticket=', '?ticket=deadbeef']) {
        const response = await fetch(`${baseUrl}/api/downloads/session-output${query}`);
        expect(response.status).toBe(401);
      }
    });
  });

  test('票签出来之后会话被删 —— 同一张票立刻失效', async () => {
    await withServer(async ({ baseUrl, sessionId, outputPath }) => {
      const { body } = await issue(baseUrl, 'alice', sessionId, outputPath);
      // 先确认这张票本来是能用的,否则下面那个 404 证明不了任何事。
      expect((await fetch(`${baseUrl}${body.url}`)).status).toBe(200);

      sessionsDb.deleteSessionById(sessionId);

      // 票还在有效期内(5 分钟),但三道闸在直传口重跑了一遍。
      const after = await fetch(`${baseUrl}${body.url}`);
      expect(after.status).toBe(404);
    });
  });
});
