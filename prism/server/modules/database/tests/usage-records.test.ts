import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, test } from 'vitest';

import { closeConnection, deriveCostDelta, initializeDatabase, usageRecordsDb } from '@/modules/database/index.js';

/**
 * 用量与费用台账。
 *
 * ## 这个文件里最要紧的是"累计 vs 增量"那两条
 *
 * SDK 的 `total_cost_usd` 是**会话累计**,不是这一轮的钱(前端也是当"最新值覆盖"
 * 用的,不是累加)。一轮一行地把它存进来再 `SUM()`,就是把第 N 轮的账算 N 遍 ——
 * 十轮对话的账单会变成真实值的五倍多。
 *
 * 而这个错**看起来完全正常**:数字递增、量级也对、界面上不会有任何异样,
 * 只有拿去和 Anthropic 的账单核对时才会发现对不上。这类错误一旦上线,
 * 之前所有的历史数据都是废的 —— 所以必须在写入的那一刻就是对的。
 */

const previousDatabasePath = process.env.DATABASE_PATH;
let tempDir: string | null = null;

afterEach(async () => {
  closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  if (tempDir) { await rm(tempDir, { recursive: true, force: true }); tempDir = null; }
});

async function freshDb(): Promise<void> {
  tempDir = await mkdtemp(path.join(tmpdir(), 'usage-records-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');
  await initializeDatabase();
}

describe('累计费用换算成增量', () => {
  test('正常递增:增量就是差值', () => {
    assert.equal(deriveCostDelta(0.10, 0), 0.10);
    assert.equal(Number(deriveCostDelta(0.25, 0.10).toFixed(10)), 0.15);
    assert.equal(Number(deriveCostDelta(1.00, 0.25).toFixed(10)), 0.75);
  });

  test('计数器重置(会话被 resume 到新 runtime):当前值本身就是增量', () => {
    /*
     * 判据只能是"比上一次小"。这时 `current` 本身就是新一段的花费。
     *
     * **不能钳成 0** —— 那会把重置之后的所有花费全部丢掉,账目单调偏小
     * 且没有任何迹象。宁可在极端情况下多算一点,也不要静默少算:
     * 多算了看得出来(和账单一对就发现),少算了看不出来。
     */
    assert.equal(deriveCostDelta(0.03, 0.25), 0.03);
  });

  test('没有费用信息:不编数字', () => {
    assert.equal(deriveCostDelta(0, 0.25), 0);
    assert.equal(deriveCostDelta(Number.NaN, 0.25), 0);
    assert.equal(deriveCostDelta(-1, 0.25), 0);
  });
});

describe('用量台账', () => {
  test('⚠️ 一个会话连打十轮,SUM 必须等于最后那个累计值', async () => {
    await freshDb();

    /*
     * 这条是整个功能的验收标准。
     *
     * 模拟十轮对话,SDK 报的累计费用逐轮递增到 1.00。
     * 台账 SUM 出来必须是 1.00,不是 1+2+…+10 那种把每轮累计值加起来的 5.5。
     */
    const cumulative = [0.10, 0.19, 0.27, 0.34, 0.42, 0.55, 0.66, 0.78, 0.89, 1.00];
    for (const value of cumulative) {
      usageRecordsDb.record({
        sessionId: 's1', provider: 'claude', userId: 1, username: 'alice',
        inputTokens: 1000, outputTokens: 200, costUsdCumulative: value,
      });
    }

    const totals = usageRecordsDb.totalsForSession('s1');
    assert.ok(totals);
    assert.equal(totals!.runs, 10);
    assert.equal(
      Number(totals!.cost_usd.toFixed(6)), 1.00,
      `十轮累计到 $1.00,台账求和应当也是 $1.00。得到 $${totals!.cost_usd.toFixed(4)} —— `
      + '如果是 5 块多,说明把每轮的累计值当增量存了(第 N 轮的账算了 N 遍)',
    );

    // token 是每轮各自的量,该照加不误
    assert.equal(totals!.input_tokens, 10000);
    assert.equal(totals!.output_tokens, 2000);
  });

  test('两个会话各算各的,互不影响', async () => {
    await freshDb();
    usageRecordsDb.record({ sessionId: 'a', provider: 'claude', costUsdCumulative: 0.50 });
    usageRecordsDb.record({ sessionId: 'b', provider: 'claude', costUsdCumulative: 0.30 });
    usageRecordsDb.record({ sessionId: 'a', provider: 'claude', costUsdCumulative: 0.80 });

    /*
     * 增量是拿"**同一会话**上一条"比出来的。要是漏了 session_id 这个条件,
     * b 的 0.30 会拿 a 的 0.50 当基准 → 判成重置 → 记 0.30(碰巧对),
     * 而 a 的 0.80 会拿 b 的 0.30 当基准 → 记 0.50(错,应该是 0.30)。
     * 所以这条要两个会话交叉着写才验得出来。
     */
    assert.equal(Number(usageRecordsDb.totalsForSession('a')!.cost_usd.toFixed(6)), 0.80);
    assert.equal(Number(usageRecordsDb.totalsForSession('b')!.cost_usd.toFixed(6)), 0.30);
  });

  test('按维度汇总', async () => {
    await freshDb();
    usageRecordsDb.record({ sessionId: 's1', provider: 'claude', username: 'alice', source: 'chat', model: 'sonnet', costUsdCumulative: 0.20, inputTokens: 100 });
    usageRecordsDb.record({ sessionId: 's2', provider: 'claude', username: 'bob', source: 'task', model: 'opus', costUsdCumulative: 0.50, inputTokens: 300 });
    usageRecordsDb.record({ sessionId: 's3', provider: 'claude', username: 'bob', source: 'compact', model: 'sonnet', costUsdCumulative: 0.05, inputTokens: 50 });

    const bySource = usageRecordsDb.summarize('source', null, null);
    const asMap = new Map(bySource.map((row) => [row.key, row]));
    assert.equal(Number(asMap.get('task')!.cost_usd.toFixed(6)), 0.50);
    assert.ok(asMap.has('compact'), '自动压缩要能单独看见 —— "这个月为什么贵了"很可能就是它');

    const byUser = usageRecordsDb.summarize('username', null, null);
    assert.equal(Number(byUser.find((row) => row.key === 'bob')!.cost_usd.toFixed(6)), 0.55);
  });

  test('可见范围:非 root 只看得到自己的行', async () => {
    await freshDb();
    usageRecordsDb.record({ sessionId: 's1', provider: 'claude', userId: 1, username: 'alice', costUsdCumulative: 0.20 });
    usageRecordsDb.record({ sessionId: 's2', provider: 'claude', userId: 2, username: 'bob', costUsdCumulative: 0.50 });

    /*
     * 和审计日志同一条规矩:费用行带着 project_path 和 model,
     * 不设防的话任何账号都能摸清别人在做什么项目、用什么模型。
     */
    assert.equal(usageRecordsDb.list(100, 0, 1).length, 1);
    assert.equal(usageRecordsDb.list(100, 0, 1)[0]!.username, 'alice');
    assert.equal(usageRecordsDb.count(1), 1);
    assert.equal(usageRecordsDb.list(100, 0, null).length, 2, 'root(传 null)看全量');

    const scoped = usageRecordsDb.summarize('username', 2, null);
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0]!.key, 'bob');
  });

  test('记账失败不能把对话带崩', async () => {
    /*
     * 台账是旁路数据,而它的写入点在对话的收尾路径上。
     * 一次磁盘满或 SQLITE_BUSY 就让整轮对话报错,代价远大于丢一行账。
     */
    closeConnection();
    process.env.DATABASE_PATH = '/nonexistent-dir-for-usage-test/auth.db';
    assert.doesNotThrow(() => {
      usageRecordsDb.record({ sessionId: 'x', provider: 'claude', costUsdCumulative: 1 });
    }, '记账失败必须被吞掉并打日志,不能往上抛');
  });

  test('summarize 的 groupBy 只认白名单(它会拼进 SQL)', async () => {
    await freshDb();
    assert.throws(
      () => usageRecordsDb.summarize('username; DROP TABLE usage_records' as never, null, null),
      /unsupported groupBy/,
      'groupBy 直接拼进 GROUP BY —— 类型只在编译期,运行期必须自己再挡一道',
    );
  });
});
