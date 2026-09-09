import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import type { RequestHandler } from 'express';
import { describe, test } from 'vitest';

import { auditLogDb, closeConnection, initializeDatabase, userDb } from '@/modules/database/index.js';

import providerRouter from '../provider.routes.js';

/**
 * 技能的装/卸要留痕。
 *
 * ## 为什么这条值得单独钉一个测试
 *
 * 技能目录是**服务进程自己的 home**(`~/.claude/skills`),一台机器上所有用户
 * 共用同一份。它没有 owner —— 这是产品设计(共享技能库),这里不改也不评判。
 *
 * 代价是:B 卸掉 A 装的技能之后,A 的所有会话行为会**静默**改变 —— 某个 `/xxx`
 * 命令突然不存在,或者同名技能换成了另一份内容 —— 而 A 收不到任何通知。
 *
 * 在 fd 之前,审计事件表里 25 个事件**一个 skill 都没有**,所以事后没人能回答
 * "这技能谁卸的"。补的是可追溯性,不是权限。
 *
 * ## 这个测试钉的是"记了没有",不是"挡没挡住"
 *
 * 共用技能库、谁都能装卸,是当前设计。哪天要改成有归属的,是改这些断言,不是
 * 改实现去迁就它们。但**无论怎么改,这两条审计不能消失** —— 记录能力一旦掉了,
 * 在 diff 里是看不出来的(少一行 `auditLogDb.record` 而已),只有事后查不到人
 * 的时候才发现,那时已经晚了。
 */

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => nextHomeDir;
  return () => {
    (os as unknown as { homedir: () => string }).homedir = original;
  };
};

type TestUser = { id: number; username: string; isRoot?: boolean };

async function withSkillServer(
  runTest: (ctx: {
    baseUrl: string;
    users: Record<string, TestUser>;
    skillsRoot: string;
  }) => Promise<void>,
): Promise<void> {
  const prevDb = process.env.DATABASE_PATH;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-audit-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  await initializeDatabase();

  const restoreHomeDir = patchHomeDir(dir);
  let server: Server | null = null;
  try {
    const users: Record<string, TestUser> = {};
    for (const name of ['alice', 'bob']) {
      users[name] = { id: Number(userDb.createUser(name, 'hash').id), username: name };
    }

    const skillsRoot = path.join(dir, '.claude', 'skills');
    await fs.mkdir(skillsRoot, { recursive: true });

    const fakeAuth: RequestHandler = (req, _res, next) => {
      const name = String(req.headers['x-test-user'] ?? '');
      (req as unknown as { user?: TestUser }).user = users[name];
      next();
    };

    const app = express();
    app.use(express.json());
    app.use('/api/providers', fakeAuth, providerRouter);
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const status = (error as { statusCode?: number })?.statusCode ?? 500;
      res.status(status).json({ error: (error as Error)?.message ?? 'error' });
    });

    server = app.listen(0);
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address !== 'object') throw new Error('no listen address');

    await runTest({ baseUrl: `http://127.0.0.1:${address.port}`, users, skillsRoot });
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    restoreHomeDir();
    closeConnection();
    if (prevDb === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = prevDb;
    await fs.rm(dir, { recursive: true, force: true });
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

/** 只看这一次调用产生的那条,不受同库里其它测试留下的行干扰。 */
const latest = (event: string) => auditLogDb.list(200).find((row) => row.event === event);

const SKILL_MD = '---\nname: shared-demo\ndescription: A shared demo skill\n---\n\n正文\n';

describe('技能装卸的审计留痕', () => {
  test('装技能:记 skill_installed,带操作人和实际落盘的目录名', async () => {
    await withSkillServer(async ({ baseUrl, users }) => {
      const installed = await call(baseUrl, 'alice', 'POST', '/api/providers/claude/skills', {
        entries: [{ content: SKILL_MD, directoryName: 'shared-demo' }],
      });
      assert.equal(installed.status, 200, `装技能应当成功:${installed.text}`);

      const row = latest('skill_installed');
      assert.ok(row, 'POST /skills 之后必须有一条 skill_installed —— 少了这条,事后查不到谁装的');
      assert.equal(row!.username, 'alice', '审计要能指到具体的人,不是匿名');
      assert.equal(row!.user_id, users.alice.id);
      assert.ok(
        String(row!.detail).includes('shared-demo'),
        `detail 里要有目录名,否则查到人也不知道装的是哪个:${row!.detail}`,
      );
      assert.ok(
        String(row!.detail).includes('claude'),
        `detail 里要有 provider —— 不同 provider 的技能根目录不是同一个:${row!.detail}`,
      );
    });
  });

  test('卸技能:记 skill_removed,而且记的是卸的人不是装的人', async () => {
    await withSkillServer(async ({ baseUrl, users }) => {
      await call(baseUrl, 'alice', 'POST', '/api/providers/claude/skills', {
        entries: [{ content: SKILL_MD, directoryName: 'shared-demo' }],
      });

      /*
       * 关键场景:alice 装的,bob 卸。这正是"共用技能库"最伤人的那一下 ——
       * alice 的会话行为静默变了,她自己不知道。审计至少要指得出是 bob。
       */
      const removed = await call(baseUrl, 'bob', 'DELETE', '/api/providers/claude/skills/shared-demo');
      assert.equal(removed.status, 200, `卸载应当成功:${removed.text}`);

      const row = latest('skill_removed');
      assert.ok(row, 'DELETE /skills/:directoryName 之后必须有一条 skill_removed');
      assert.equal(row!.username, 'bob', '记的必须是执行卸载的人');
      assert.equal(row!.user_id, users.bob.id);
      assert.notEqual(row!.user_id, users.alice.id, '别把装的人当成卸的人记进去');
      assert.ok(String(row!.detail).includes('shared-demo'), `detail 里要有被卸掉的目录名:${row!.detail}`);
      assert.equal(row!.outcome, 'success');
    });
  });

  test('卸一个不存在的目录:也要留痕,并且标成 failure', async () => {
    await withSkillServer(async ({ baseUrl }) => {
      /*
       * `removed: false` 不是"什么都没发生"。用户来报"我的技能怎么没了"的时候,
       * "有人点名要卸它但没卸成"和"根本没人碰过"是两种完全不同的结论。
       */
      const missing = await call(baseUrl, 'bob', 'DELETE', '/api/providers/claude/skills/never-existed');
      assert.equal(missing.status, 200);

      const row = latest('skill_removed');
      assert.ok(row, '卸载没命中也要记 —— 意图本身就是线索');
      assert.equal(row!.outcome, 'failure', '没卸成要标 failure,不能和真卸掉了混在一起');
      assert.ok(String(row!.detail).includes('never-existed'), `detail:${row!.detail}`);
    });
  });

  test('装/卸两条事件必须留在 AuditEvent 联合类型里', async () => {
    /*
     * 类型层面的守门。事件名是字符串联合,一旦有人"顺手清理"把它删掉,
     * 上面几个测试仍然可能因为别的原因先红/先绿,不够直接。这条直接读源码。
     */
    const source = await fs.readFile(
      path.join(process.cwd(), 'server/modules/database/repositories/audit-log.ts'),
      'utf8',
    );
    for (const event of ["'skill_installed'", "'skill_removed'"]) {
      assert.ok(
        source.includes(event),
        `AuditEvent 里必须保留 ${event} —— 删掉它就等于把技能操作变回查不到人的状态`,
      );
    }
  });

  test('卸载确认框里必须写着"这会影响所有用户"', async () => {
    /*
     * 后端留痕解决的是"事后查得到",这条解决的是"事前意识得到"。
     * 点卸载的人多半以为是"从我的列表里移除",而不是"把所有人的这个命令删掉"。
     */
    const source = await fs.readFile(
      path.join(process.cwd(), 'src/components/skills/view/ProviderSkills.tsx'),
      'utf8',
    );
    assert.ok(
      source.includes('skills.removeShared'),
      '确认框要有共用提示(skills.removeShared),否则用户是在不知情的情况下替别人做决定',
    );

    const zh = JSON.parse(
      await fs.readFile(path.join(process.cwd(), 'src/i18n/locales/zh-CN/settings.json'), 'utf8'),
    ) as { skills?: Record<string, string> };
    assert.ok(zh.skills?.removeShared, 'zh-CN 要有 skills.removeShared 文案');
    const en = JSON.parse(
      await fs.readFile(path.join(process.cwd(), 'src/i18n/locales/en/settings.json'), 'utf8'),
    ) as { skills?: Record<string, string> };
    assert.ok(en.skills?.removeShared, 'en 要有 skills.removeShared 文案');
  });
});
