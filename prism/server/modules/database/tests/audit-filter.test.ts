import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, test } from 'vitest';

import { auditLogDb, closeConnection, initializeDatabase } from '@/modules/database/index.js';

/**
 * 审计日志筛选(审计报告功能项 9)。
 *
 * 报告里的原话:现在能回答"有没有别人登进来过",答不了"上周三谁把那个模型文件
 * 覆盖了"。事件类型有 27 种,而列表是纯倒序分页 —— 只能一页页翻。
 *
 * ## 这个文件里真正要紧的是第三条
 *
 * 筛选本身是便利功能,写错了顶多是筛不准。但 `userId` 那个参数**不是筛选条件,
 * 是权限边界**:非 root 只能看见自己的行,因为这些行带着用户名、登录时间和
 * 客户端 IP —— 不设防的话任何账号都能把同事的作息拉一遍。
 *
 * 加筛选最容易犯的错,就是让某个 filter 把这道闸门顶掉(比如 `username` 传谁
 * 就查谁)。那不是"筛选没做好",那是把一个只读自己的接口变成了全员目录。
 */

const previousDatabasePath = process.env.DATABASE_PATH;
let tempDir: string | null = null;

afterEach(async () => {
  closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  if (tempDir) { await rm(tempDir, { recursive: true, force: true }); tempDir = null; }
});

async function seed(): Promise<void> {
  tempDir = await mkdtemp(path.join(tmpdir(), 'audit-filter-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');
  await initializeDatabase();

  const rows = [
    { userId: 1, username: 'alice', event: 'login' as const, outcome: 'success' as const },
    { userId: 1, username: 'alice', event: 'login_failed' as const, outcome: 'failure' as const },
    { userId: 1, username: 'alice', event: 'skill_removed' as const, outcome: 'success' as const, detail: 'claude: demo' },
    { userId: 2, username: 'bob', event: 'login' as const, outcome: 'success' as const },
    { userId: 2, username: 'bob', event: 'projects_bulk_deleted' as const, outcome: 'success' as const },
    { userId: 2, username: 'bob', event: 'skill_installed' as const, outcome: 'success' as const },
    { userId: 3, username: 'alice_2', event: 'login' as const, outcome: 'success' as const },
  ];
  for (const row of rows) auditLogDb.record(row);
}

describe('审计日志筛选', () => {
  test('按事件类型筛(这是"谁把项目删了"能查出来的前提)', async () => {
    await seed();

    const deletions = auditLogDb.list(100, 0, null, { events: ['projects_bulk_deleted'] });
    assert.equal(deletions.length, 1);
    assert.equal(deletions[0]!.username, 'bob');

    // 多选:技能的装和卸一起看
    const skills = auditLogDb.list(100, 0, null, { events: ['skill_installed', 'skill_removed'] });
    assert.equal(skills.length, 2);
    assert.equal(auditLogDb.count(null, { events: ['skill_installed', 'skill_removed'] }), 2);

    // 空数组 = 不筛,不能当成"什么都不匹配"
    assert.equal(auditLogDb.list(100, 0, null, { events: [] }).length, 7);
  });

  test('按结果筛:只看失败', async () => {
    await seed();
    const failures = auditLogDb.list(100, 0, null, { outcome: 'failure' });
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.event, 'login_failed');
    assert.equal(auditLogDb.count(null, { outcome: 'failure' }), 1);
  });

  test('⚠️ 用户名筛选**不能**越过可见范围', async () => {
    await seed();

    /*
     * bob(user_id = 2,非 root)带着 `username=alice` 来查。
     *
     * 正确结果是**空** —— 因为 `user_id = 2` 这道闸门先拼上去,
     * `username LIKE '%alice%'` 只是在 bob 自己那三行里再缩小。
     *
     * 如果哪天有人"优化"成 username 传谁就查谁,这条会立刻红。
     * 那个改动看起来只是让筛选更好用,实际是把一个只读自己的接口
     * 变成了全员目录:用户名、登录时间、客户端 IP,任何账号都能拉。
     */
    const bobLooksForAlice = auditLogDb.list(100, 0, 2, { usernameLike: 'alice' });
    assert.deepEqual(
      bobLooksForAlice, [],
      'bob 用 username=alice 查到了 alice 的行 —— 筛选把可见范围闸门顶掉了',
    );
    assert.equal(auditLogDb.count(2, { usernameLike: 'alice' }), 0);

    // 同时确认 bob 自己的行还查得到(闸门不能矫枉过正到什么都查不出来)
    assert.equal(auditLogDb.list(100, 0, 2, {}).length, 3);
    assert.equal(auditLogDb.list(100, 0, 2, { usernameLike: 'bob' }).length, 3);

    // root(userId = null)才看得到全部
    assert.equal(auditLogDb.list(100, 0, null, { usernameLike: 'alice' }).length, 4);
  });

  test('用户名里的 LIKE 元字符要当字面量,不能当通配符', async () => {
    await seed();

    /*
     * `alice_2` 里的 `_` 在 LIKE 里是"任意一个字符"。不转义的话,
     * 搜 `alice_2` 会把 `aliceX2` 之类一起捞出来。
     *
     * 这个仓库在 P0-6 上正是栽在这里:附件台账的 `LIKE prefix%` 因为路径里的
     * `_` 被当成通配符,删一个项目连带删了兄弟目录的台账(实测 4 行删 3 行)。
     * 当时那句注释还写着"附件绝对路径里不会出现 %_"—— 所以这次直接钉住。
     */
    const exact = auditLogDb.list(100, 0, null, { usernameLike: 'alice_2' });
    assert.equal(exact.length, 1, '带下划线的用户名要精确匹配到它自己');
    assert.equal(exact[0]!.username, 'alice_2');

    // % 同理:搜 "%" 不该匹配所有行
    assert.equal(
      auditLogDb.list(100, 0, null, { usernameLike: '%' }).length, 0,
      '把 % 当通配符的话,搜一个百分号会返回全表',
    );
  });

  test('筛选与分页、计数一致', async () => {
    await seed();
    const filters = { events: ['login'] };
    assert.equal(auditLogDb.count(null, filters), 3);

    const page1 = auditLogDb.list(2, 0, null, filters);
    const page2 = auditLogDb.list(2, 2, null, filters);
    assert.equal(page1.length, 2);
    assert.equal(page2.length, 1);
    // 分页不能重复或漏行
    const ids = [...page1, ...page2].map((row) => row.id);
    assert.equal(new Set(ids).size, 3, '两页之间出现了重复行');
  });

  test('不传 filters 时行为和升级前一模一样', async () => {
    await seed();
    // 老调用签名(三个参数)必须继续可用 —— 这是个被 route 直接调的方法
    assert.equal(auditLogDb.list(100, 0, null).length, 7);
    assert.equal(auditLogDb.list(100, 0, 1).length, 3);
    assert.equal(auditLogDb.count(null), 7);
    assert.equal(auditLogDb.count(1), 3);
  });
});
