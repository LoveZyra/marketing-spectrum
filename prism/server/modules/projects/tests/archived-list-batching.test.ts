import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, test } from 'vitest';

import { closeConnection, getConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { getArchivedProjectsWithSessions } from '@/modules/projects/services/projects-with-sessions-fetch.service.js';

/**
 * 归档项目列表的批量化(审计 P2-8)。
 *
 * ## 之前是什么样
 *
 * 循环里两次按项目查库(该项目的会话 + 授权名单),**240 个归档项目 = 480 次查询**,
 * 全在同一次 HTTP 请求里。而 better-sqlite3 是同步的 —— 这 480 次期间事件循环整段停住,
 * 所有人的对话、终端、心跳一起卡。
 *
 * 活跃列表在 E7 轮已经改成"三次固定查询顶掉 3N 次"了,注释还专门写了理由。
 * **归档这条当时漏了** —— 同一个病,隔壁已经治好,这边没跟上。
 *
 * 外加不分页:`readProjectSessionsIncludingArchived` 把每个项目的**全部**会话读进内存,
 * `hasMore` 恒为 false。归档一个跑了半年、几千条会话的项目,光这一个响应就是几十兆,
 * 而界面只显示前几条。
 *
 * ## 这里测的是查询次数,不是耗时
 *
 * 和侧栏那条一样:计时断言在 CI 上必然不稳,红几次就会被加 skip。
 * 这里挂 better-sqlite3 的 `prepare` 计数,和机器快慢无关。
 */

const previousDatabasePath = process.env.DATABASE_PATH;
let tempDir: string | null = null;

afterEach(async () => {
  closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  if (tempDir) { await rm(tempDir, { recursive: true, force: true }); tempDir = null; }
});

async function seed(projectCount: number, sessionsEach: number): Promise<string[]> {
  tempDir = await mkdtemp(path.join(tmpdir(), 'archived-batch-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');
  await initializeDatabase();

  const paths: string[] = [];
  for (let p = 0; p < projectCount; p += 1) {
    const projectPath = path.join(tempDir, `proj-${p}`);
    paths.push(projectPath);
    projectsDb.createProjectPath(projectPath);
    for (let sIndex = 0; sIndex < sessionsEach; sIndex += 1) {
      sessionsDb.createSession(
        `p${p}-s${sIndex}`, 'claude', projectPath, `会话 ${sIndex}`,
        new Date(2026, 0, 1 + sIndex).toISOString(),
        new Date(2026, 0, 1 + sIndex).toISOString(),
      );
    }
    projectsDb.updateProjectIsArchived(projectPath, true);
  }
  return paths;
}

/**
 * 数 SQLite 真的执行了多少条语句。
 *
 * ⚠️ **必须先装探针再暖缓存,顺序反了这个测试就是废的。**
 *
 * `cachedPrepare` 用 `WeakMap<Database, Map<sql, Statement>>` 缓存 statement 对象。
 * 我第一版写成"先跑一次暖缓存 → 再装探针 → 再测",结果缓存里存的全是**没包过**的
 * statement,后续调用直接绕开探针 —— 两条计数断言在把实现回退成 N+1 之后**照样绿**。
 * 也就是说那一版什么都没证明。
 *
 * 现在的顺序是:装探针 → 暖缓存(此时缓存里存进去的是包过的)→ 清零 → 测。
 */
function withStatementCounter<T>(body: (readCount: () => number, reset: () => void) => T): T {
  const db = getConnection() as unknown as {
    prepare: (sql: string) => Record<string, unknown>;
  };
  const original = db.prepare.bind(db);
  let count = 0;
  const wrap = (statement: Record<string, unknown>) => new Proxy(statement, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === 'function' && (prop === 'run' || prop === 'get' || prop === 'all')) {
        return (...args: unknown[]) => { count += 1; return (value as (...a: unknown[]) => unknown).apply(target, args); };
      }
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  (db as unknown as { prepare: unknown }).prepare = (sql: string) => wrap(original(sql));
  try {
    return body(() => count, () => { count = 0; });
  } finally {
    (db as unknown as { prepare: unknown }).prepare = original;
  }
}

describe('归档项目列表:批量化与分页', () => {
  test('查询次数不随项目数增长', async () => {
    await seed(30, 5);

    const { projects, count } = await withStatementCounter(async (readCount, reset) => {
      // 暖一次缓存(探针已经装好了,所以缓存里存的是包过的 statement),再清零
      await getArchivedProjectsWithSessions({ skipSynchronization: true });
      reset();
      const result = await getArchivedProjectsWithSessions({ skipSynchronization: true });
      return { projects: result, count: readCount() };
    });
    assert.equal(projects.length, 30);
    const measured = { count };

    /*
     * 30 个项目。修之前是 1(项目行)+ 30×2 = **61 条**;
     * 现在是项目行 + 会话批量 + 计数批量 + 授权名单批量 = 个位数,**与项目数无关**。
     *
     * 上限放到 10 而不是钉死 4:`generateDisplayName` 之类的辅助路径将来可能多一两条
     * 固定查询,那不是回归。真正要挡的是"又变回按项目一条一条查"。
     */
    assert.ok(
      measured.count <= 10,
      `30 个归档项目应当只用个位数查询,实际 ${measured.count} 条 —— 看起来又回到 N+1 了`,
    );
  });

  test('翻倍项目数,查询次数不变(这条才真正区分 O(1) 和 O(n))', async () => {
    await seed(10, 3);
    const small = await withStatementCounter(async (readCount, reset) => {
      await getArchivedProjectsWithSessions({ skipSynchronization: true });
      reset();
      await getArchivedProjectsWithSessions({ skipSynchronization: true });
      return { count: readCount() };
    });

    await seed(40, 3);
    const large = await withStatementCounter(async (readCount, reset) => {
      await getArchivedProjectsWithSessions({ skipSynchronization: true });
      reset();
      const result = await getArchivedProjectsWithSessions({ skipSynchronization: true });
      return { count: readCount(), length: result.length };
    });
    assert.equal(large.length, 40);

    /*
     * 项目数 ×4,查询次数应当**一模一样**。
     *
     * 只测一个规模的话,"61 条 vs 上限"这种断言在项目数变了之后就失去意义;
     * 两个规模一比,N+1 无处可藏。
     */
    assert.equal(
      large.count, small.count,
      `10 个项目用了 ${small.count} 条、40 个用了 ${large.count} 条 —— 次数跟着项目数走就是 N+1`,
    );
  });

  test('会话分页:只带首页,total 和 hasMore 如实上报', async () => {
    // 一个项目 40 条会话,远超默认页大小
    await seed(1, 40);
    const [project] = await getArchivedProjectsWithSessions({ skipSynchronization: true });

    assert.ok(project, '应当有一个归档项目');
    assert.equal(project.sessionMeta?.total, 40, 'total 要是真实总数,不是这一页的条数');
    assert.ok(
      project.sessions.length < 40,
      `不该把 40 条会话全塞进列表响应,实际 ${project.sessions.length} 条`,
    );
    assert.equal(
      project.sessionMeta?.hasMore, true,
      'hasMore 之前恒为 false —— 界面据此认为"就这些了",而实际还有几十条没给',
    );
  });

  test('归档项目里已归档的会话也要算进来', async () => {
    /*
     * 这条是**防止我把病治过头**。批量方法默认带 `AND isArchived = 0`,
     * 归档列表必须显式传 includeArchived —— 漏传的话归档项目里的会话会全部消失,
     * 而这在"查询次数少了"的测试里完全看不出来。
     */
    await seed(1, 6);
    const paths = await getArchivedProjectsWithSessions({ skipSynchronization: true });
    const projectPath = paths[0]!.path;

    const all = sessionsDb.getSessionsByProjectPathIncludingArchived(projectPath);
    sessionsDb.updateSessionIsArchived(all[0]!.session_id, true);
    sessionsDb.updateSessionIsArchived(all[1]!.session_id, true);

    const [project] = await getArchivedProjectsWithSessions({ skipSynchronization: true });
    assert.equal(
      project?.sessionMeta?.total, 6,
      '归档项目的会话总数要含已归档的会话 —— 少了就是用户在归档视图里看不到自己的历史',
    );
  });
});
