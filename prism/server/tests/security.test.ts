import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, test } from 'vitest';

import { PREVIEW_PAGE_CSP } from '@/modules/preview/services/static-content.service.js';
import { validateEntryInProject, validatePathInProject } from '@/modules/files/services/path-validation.service.js';
import { closeConnection, getConnection, initializeDatabase, userDb, auditLogDb, apiKeysDb, usageRecordsDb } from '@/modules/database/index.js';
import { isRootUser, usernameKey, validateNewUsername } from '@/shared/root-users.js';
import { isAccountUsable } from '@/shared/account-usable.js';
import { clientIp } from '@/shared/client-ip.js';
import { issueSseTicket, SSE_TICKET_PATHS, __resetSseTicketsForTest } from '@/shared/sse-tickets.js';
import { issuePreviewTicket, readPreviewTicket } from '@/shared/preview-tickets.js';
import {
  issueJupyterEntryTicket,
  isJupyterSessionValid,
  redeemJupyterEntryTicket,
  setJupyterAccountCheck,
  __resetJupyterAuthForTest,
} from '@/modules/jupyter/services/jupyter-manager.service.js';

import { readBypassAllowlist, createUsageAccumulator, accumulateUsage, mergeResultUsage } from '../claude-sdk.js';

/**
 * 凭据与越权、用量台账 token 数的回归测试。
 * 每个 describe 钉住一条安全或记账约束,实现退回不安全的写法时对应断言就会变红。
 */

const repoRoot = path.resolve(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

async function withIsolatedDatabase(run: () => void | Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'hj-sec-'));
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

describe('预览口的 CSP 自带 sandbox', () => {
  test('响应头里有 sandbox,令牌集合与 iframe 属性逐字相同,且不给 allow-same-origin', () => {
    const directive = PREVIEW_PAGE_CSP.split(';').map((d) => d.trim()).find((d) => d.startsWith('sandbox'));
    assert.ok(directive, 'CSP 里必须有 sandbox 指令 —— 预览链接被直接打开时 iframe 属性不起作用');
    assert.ok(!directive!.includes('allow-same-origin'));
    const iframe = read('src/components/code-editor/view/subcomponents/HtmlPreview.tsx').match(/sandbox="([^"]+)"/)?.[1];
    assert.ok(iframe);
    assert.deepEqual(directive!.replace(/^sandbox\s+/, '').split(/\s+/).sort(), iframe!.split(/\s+/).sort());
  });
});

describe('用户名的比对键与注册校验', () => {
  test('开尔文符号 K 折不成 k:冒名账号判不成 root / 进不了 bypass 名单', () => {
    const kelvin = 'Kate';
    assert.equal(kelvin.toLowerCase(), 'kate', '前提:JS 的 toLowerCase 会把它折成 kate');
    assert.notEqual(usernameKey(kelvin), 'kate');
    assert.equal(isRootUser(kelvin, { PRISM_ROOT_USERS: 'kate' }), false);
    assert.equal(isRootUser(' Kate ', { PRISM_ROOT_USERS: 'kate' }), true, 'ASCII 大小写与空白照旧不敏感');
    assert.equal(readBypassAllowlist({ PRISM_ALLOW_BYPASS_USERS: 'kate' })!.has(usernameKey(kelvin)), false);
  });

  test('注册校验:兼容字符、空白控制字符、超长、与保留名 Unicode 撞车都拒;正常名与中文名放行', () => {
    const env = { PRISM_ROOT_USERS: 'kate', PRISM_ALLOW_BYPASS_USERS: 'ops' };
    assert.ok(validateNewUsername('Kate', env));
    assert.ok(validateNewUsername('ＫＡＴＥ', env), '全角字母');
    assert.ok(validateNewUsername('a b c', env));
    assert.ok(validateNewUsername('abc\u0000', env));
    assert.ok(validateNewUsername('x'.repeat(65), env));
    assert.equal(validateNewUsername('kate', env), null, 'root 本人照常注册');
    assert.equal(validateNewUsername('Kate', env), null, 'ASCII 大小写由 NOCASE 兜底判重,这里不拦');
    assert.equal(validateNewUsername('张三丰', env), null);
    assert.equal(validateNewUsername('tianji.chang', env), null);
  });

  test('注册路由接了这道校验', () => {
    assert.match(read('server/routes/auth.js'), /validateNewUsername\(username\)/);
  });
});

describe('凭据背后的账号现在还能不能用', () => {
  afterEach(() => { __resetSseTicketsForTest(); __resetJupyterAuthForTest(); setJupyterAccountCheck(null); });

  test('isAccountUsable:停用 / 驳回 / token_version 变了都不行;root 不受审批约束', async () => {
    await withEnv({ PRISM_ROOT_USERS: 'boss', PRISM_APPROVAL_REQUIRED: undefined }, () => {
      assert.equal(isAccountUsable({ username: 'a', is_active: 1, approval_status: 'approved', token_version: 2 }, { tokenVersion: 2 }), true);
      assert.equal(isAccountUsable({ username: 'a', is_active: 1, approval_status: 'approved', token_version: 3 }, { tokenVersion: 2 }), false);
      assert.equal(isAccountUsable({ username: 'a', is_active: 1, approval_status: 'rejected' }), false);
      assert.equal(isAccountUsable({ username: 'a', is_active: 0, approval_status: 'approved' }), false);
      assert.equal(isAccountUsable({ username: 'boss', is_active: 1, approval_status: 'rejected' }), true);
      assert.equal(isAccountUsable(undefined), false);
    });
  });

  test('搜索票只在搜索路径上认;退出所有设备后作废;驳回后 API key 失效', async () => {
    await withEnv({ JWT_SECRET: 'hj-test-secret', PRISM_ROOT_USERS: 'boss' }, async () => {
      await withIsolatedDatabase(async () => {
        const { authenticateToken } = await import('../middleware/auth.js');
        const alice = userDb.createUser('alice', 'x', 'approved') as { id: number };
        const run = (baseUrl: string, p: string, ticket: string) => new Promise<{ status: number; user?: { id: number } }>((resolve) => {
          const req = { headers: {}, query: { ticket }, method: 'GET', baseUrl, path: p } as Record<string, unknown>;
          const res = {
            status(code: number) { return { json: () => resolve({ status: code }) }; },
            setHeader() {},
          };
          void authenticateToken(req, res, () => resolve({ status: 200, user: req.user as { id: number } }));
        });

        assert.ok(SSE_TICKET_PATHS.has('/api/providers/search/sessions'));
        const ticket = issueSseTicket(alice.id, 0);
        assert.equal((await run('/api/settings', '/api-keys', ticket)).status, 401, '别的路由不认票');
        assert.equal((await run('/api/auth', '/ws-ticket', ticket)).status, 401);
        const ok = await run('/api/providers', '/search/sessions', ticket);
        assert.equal(ok.status, 200);
        assert.equal(ok.user?.id, alice.id);

        userDb.bumpTokenVersion(alice.id);
        assert.equal((await run('/api/providers', '/search/sessions', ticket)).status, 401, '退出所有设备之后票立刻作废');

        const { apiKey } = apiKeysDb.createApiKey(alice.id, 'k') as { apiKey: string };
        const viaKey = apiKeysDb.validateApiKey(apiKey);
        assert.ok(viaKey && isAccountUsable(viaKey));
        userDb.setApprovalStatus(alice.id, 'rejected', null);
        const afterReject = apiKeysDb.validateApiKey(apiKey);
        assert.equal(isAccountUsable(afterReject), false, '驳回之后 key 不能再用');
        assert.equal(userDb.getUsableUser(alice.id), undefined);
      });
    });
  });

  test('下载 / 预览 / 任务票的消费点都过 getUsableUser;预览票记下是谁', () => {
    const files = read('server/modules/files/files.routes.ts');
    assert.equal((files.match(/userDb\.getUsableUser\(payload\.viewer\.userId/g) ?? []).length, 2, '/file 与 /zip 两个直传口');
    assert.match(read('server/modules/providers/session-outputs.routes.ts'), /userDb\.getUsableUser\(payload\.viewer\.userId/);
    assert.match(read('server/modules/preview/preview.routes.ts'), /userDb\.getUsableUser\(holder\.userId/);
    assert.match(read('server/modules/tasks/tasks.routes.ts'), /userDb\.getUsableUser\(entry\.userId, entry\.tokenVersion/);
    const t = issuePreviewTicket({ projectId: 'p', relDir: '', viewer: { userId: 5, username: 'a', tokenVersion: 3 } });
    assert.deepEqual(readPreviewTicket(t), { projectId: 'p', relDir: '', viewer: { userId: 5, username: 'a', tokenVersion: 3 } });
  });

  test('Jupyter 会话 cookie 绑人:账号不能用了,cookie 立刻失效', () => {
    let usable = true;
    setJupyterAccountCheck((userId, tokenVersion) => usable && userId === 7 && tokenVersion === 2);
    const session = redeemJupyterEntryTicket(issueJupyterEntryTicket(7, 2));
    assert.equal(isJupyterSessionValid(session), true);
    usable = false;
    assert.equal(isJupyterSessionValid(session), false);
    usable = true;
    assert.equal(isJupyterSessionValid(session), false, '失效即删,不会因为账号恢复而复活');
  });
});

describe('悬空软链不能把写入带出项目', () => {
  test('指向项目外的悬空软链拒绝;指向项目内的放行;软链环拒绝', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'hj-link-'));
    try {
      const project = path.join(base, 'proj');
      await mkdir(project);
      await symlink(path.join(base, 'outside', 'pwned.txt'), path.join(project, 'evil.txt'));
      await symlink(path.join(project, 'later.txt'), path.join(project, 'fine.txt'));
      await symlink(path.join(project, 'loop-b'), path.join(project, 'loop-a'));
      await symlink(path.join(project, 'loop-a'), path.join(project, 'loop-b'));
      await writeFile(path.join(project, 'real.txt'), 'x');

      assert.equal((await validatePathInProject(project, 'evil.txt')).valid, false);
      assert.equal((await validatePathInProject(project, 'fine.txt')).valid, true);
      assert.equal((await validatePathInProject(project, 'loop-a')).valid, false);
      assert.equal((await validatePathInProject(project, 'real.txt')).valid, true);
      assert.equal((await validatePathInProject(project, 'new/dir/file.txt')).valid, true, '还不存在的路径照常');

      // 相对软链要按真实父目录解析:父路径里有软链时按字面算,会误以为还在项目里
      await mkdir(path.join(project, 'deep', 'a', 'b', 'c'), { recursive: true });
      await mkdir(path.join(project, 's'));
      await symlink(path.join(project, 's'), path.join(project, 'deep', 'a', 'b', 'c', 'sub'));
      await symlink('../../outside/pwned.txt', path.join(project, 's', 'evil'));
      assert.equal((await validatePathInProject(project, 'deep/a/b/c/sub/evil')).valid, false);
      assert.equal((await validatePathInProject(project, 'deep/a/b/c/sub/new.txt')).valid, true, '软链目录下新建文件照常');

      // 删除 / 改名作用在目录项本身:指向项目外的软链、软链环照样能删能改名
      assert.equal((await validateEntryInProject(project, 'evil.txt')).valid, true);
      assert.equal((await validateEntryInProject(project, 'loop-a')).valid, true);
      assert.equal((await validateEntryInProject(project, '../x')).valid, false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('客户端 IP 取 XFF 从右数第 N 项', () => {
  test('信任 1 层:取最右;信任 2 层:取倒数第二;不信任:用 socket 地址', async () => {
    const req = { headers: { 'x-forwarded-for': '6.6.6.6, 10.0.0.9, 203.0.113.7' }, ip: '127.0.0.1' };
    await withEnv({ PRISM_TRUST_PROXY: '1' }, () => assert.equal(clientIp(req), '203.0.113.7'));
    await withEnv({ PRISM_TRUST_PROXY: 'true' }, () => assert.equal(clientIp(req), '203.0.113.7'));
    await withEnv({ PRISM_TRUST_PROXY: '2' }, () => assert.equal(clientIp(req), '10.0.0.9'));
    await withEnv({ PRISM_TRUST_PROXY: '9' }, () => assert.equal(clientIp(req), '6.6.6.6'));
    await withEnv({ PRISM_TRUST_PROXY: undefined }, () => assert.equal(clientIp(req), '127.0.0.1'));
  });
});

describe('审计日志', () => {
  test('高频事件冲不掉管理类记录;超长用户名被截断', async () => {
    await withIsolatedDatabase(() => {
      auditLogDb.record({ userId: 1, username: 'boss', event: 'user_rejected' });
      auditLogDb.record({ userId: 1, username: 'boss', event: 'password_reset_by_admin' });
      auditLogDb.record({ userId: 2, username: 'u', event: 'api_key_toggled' });
      auditLogDb.record({ userId: null, username: 'x'.repeat(5000), event: 'login_failed' });
      const conn = getConnection();
      const insert = conn.prepare("INSERT INTO audit_log (user_id, username, event, outcome) VALUES (7, 'wjx', 'ws_ticket_issued', 'success')");
      conn.transaction(() => { for (let i = 0; i < 5100; i += 1) insert.run(); })();
      auditLogDb.trim();
      const rows = conn.prepare('SELECT event, COUNT(*) AS n FROM audit_log GROUP BY event').all() as Array<{ event: string; n: number }>;
      const byEvent = Object.fromEntries(rows.map((r) => [r.event, r.n]));
      assert.equal(byEvent.user_rejected, 1);
      assert.equal(byEvent.password_reset_by_admin, 1);
      assert.equal(byEvent.api_key_toggled, undefined, '普通用户能刷的事件留在常规档,不进耐久档');
      const longest = conn.prepare('SELECT MAX(LENGTH(username)) AS n FROM audit_log').get() as { n: number };
      assert.ok(longest.n <= 128);
    });
  });
});

describe('请求体上限与限流顺序', () => {
  test('/api 限流在解析请求体之前;大请求体只给带可验签凭据的请求', () => {
    const index = read('server/index.js');
    const limiter = index.indexOf("app.use('/api', apiRateLimiter);");
    const parser = index.indexOf('app.use((req, res, next) => (hasVerifiableCredential(req) ? largeJsonParser : smallJsonParser)');
    assert.ok(limiter > 0 && parser > limiter);
    assert.equal((index.match(/app\.use\('\/api', apiRateLimiter\)/g) ?? []).length, 1, '只挂一次,别被计两次');
    assert.match(index, /express\.json\(\{ limit: '1mb'/);
    assert.match(index, /\(req\.originalUrl \|\| ''\)\.startsWith\('\/api\/downloads\/'\) \? false : compression\.filter/,
      '必须用 originalUrl:filter 在写响应时才调,那时 req.path 已被挂载点剥掉');
  });
});

describe('用量台账:这一轮的 token 数以 result 帧的汇总为准', () => {
  test('逐条累加少记(网关把用量放在 message_delta)也多记(一次调用多个内容块)时,用 result.usage;子代理另加', () => {
    const acc = createUsageAccumulator();
    const block = { type: 'assistant', message: { model: 'm', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 900 } } };
    accumulateUsage(acc, block);
    accumulateUsage(acc, block);
    accumulateUsage(acc, { type: 'assistant', parent_tool_use_id: 't1', message: { usage: { input_tokens: 10, output_tokens: 5 } } });
    mergeResultUsage(acc, { type: 'result', usage: { input_tokens: 120, output_tokens: 340, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 } });
    assert.equal(acc.inputTokens, 130);
    assert.equal(acc.outputTokens, 345);
    assert.equal(acc.cacheReadTokens, 900, '同一次调用的两个内容块不能算两遍');
    assert.equal(acc.cacheCreationTokens, 50);
  });

  test('逐条累加按 message.id 去重(同一次调用的几个内容块只算一次)', () => {
    const acc = createUsageAccumulator();
    const block = { type: 'assistant', message: { id: 'msg_1', usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 100 } } };
    accumulateUsage(acc, block);
    accumulateUsage(acc, block);
    accumulateUsage(acc, { type: 'assistant', message: { id: 'msg_2', usage: { input_tokens: 1, output_tokens: 1 } } });
    assert.equal(acc.cacheReadTokens, 100);
    assert.equal(acc.inputTokens, 6);
  });

  test('按日期汇总:按日期倒序且不截天', async () => {
    await withIsolatedDatabase(() => {
      const conn = getConnection();
      const ins = conn.prepare("INSERT INTO usage_records (provider, source, cost_usd, created_at) VALUES ('claude','chat',?,datetime('now', ?))");
      for (let d = 0; d < 70; d += 1) ins.run(d === 5 ? 99 : 0.01, `-${d} days`);
      const rows = usageRecordsDb.summarize('day', null, 90);
      assert.equal(rows.length, 70, '90 天里 70 天都在,不会只剩最贵的 50 天');
      assert.ok(rows[0].key > rows[1].key, '日期倒序');
    });
  });

  test('result 帧没带用量时保留逐条累加的值', () => {
    const acc = createUsageAccumulator();
    accumulateUsage(acc, { type: 'assistant', message: { usage: { input_tokens: 7, output_tokens: 3 } } });
    mergeResultUsage(acc, { type: 'result' });
    mergeResultUsage(acc, { type: 'result', usage: { input_tokens: 0, output_tokens: 0 } });
    assert.equal(acc.inputTokens, 7);
    assert.equal(acc.outputTokens, 3);
  });

  test('记账函数真的调了 mergeResultUsage', () => {
    assert.match(read('server/claude-sdk.js'), /function recordTurnUsage\(accumulator, resultMessage, context\) \{\s*try \{\s*if \(!accumulator\) return;\s*mergeResultUsage\(accumulator, resultMessage\);/);
  });
});
