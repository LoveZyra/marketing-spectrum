import type { Database, Statement } from 'better-sqlite3';

/**
 * 按连接缓存 prepared statement。
 *
 * ## 为什么需要
 *
 * `db.prepare(sql)` 每次都会**重新编译**这条 SQL。仓库层里几乎所有方法都是
 * `getConnection().prepare('…').get(…)` 一气呵成 —— 也就是说侧栏每刷新一次、
 * 每条消息落库一次,都在重编译同一句。实测热路径上约 4.6×。
 *
 * `session-messages.db.ts` 早就为自己那几句做了缓存(还写了很长的理由),
 * 只是没人把它推广到 sessions / projects 这两个更热的仓库。这个模块就是那份
 * 逻辑的通用版。
 *
 * ## 为什么用 WeakMap 按连接键,而不是"记住上次那个 db"
 *
 * prepared statement **绑在具体连接上**,而这个库在每日备份、关停时会 close + reopen
 * (见 connection.ts)。换了连接,旧 statement 就失效,用它会抛。
 *
 * `session-messages` 那份的做法是记一个 `prepared.db`,发现不是上次那个就整体重建。
 * 可行,但每个仓库都要自己维护一份那样的结构体。这里改成 `WeakMap<Database, …>`:
 * 键就是连接对象本身,新连接自然拿到空缓存,旧连接连同它的 statement 一起被 GC ——
 * 不需要任何显式失效逻辑,也不可能把旧连接的 statement 发给新连接。
 *
 * ## 为什么必须有上限
 *
 * 仓库里有一类 SQL 是**按参数个数拼出来**的:
 *
 *     SELECT … WHERE project_id IN (${placeholders})
 *
 * 每种 id 数量就是一个不同的 SQL 串。不设上限的话,这一类会把缓存撑成一个
 * 只增不减的 Map —— 修性能问题的同时造一个内存泄漏,不划算。
 *
 * 上限 200,超了就**整体清空**而不是 LRU 淘汰:一来这个规模下真正的热 SQL
 * 只有几十条,清空后立刻会被重新填上;二来 LRU 要维护访问顺序,那点开销和复杂度
 * 换不回什么 —— 而"简单到不会写错"在缓存这种东西上比理论最优重要。
 *
 * 撑爆本身也是个信号:真到了频繁清空的地步,说明有 SQL 应该改成固定占位符
 * (比如把 IN 列表换成 json_each 或临时表),那是该修的地方,不是该调大上限的地方。
 */
const MAX_CACHED_STATEMENTS = 200;

const caches = new WeakMap<Database, Map<string, Statement>>();

export function cachedPrepare(db: Database, sql: string): Statement {
  let cache = caches.get(db);
  if (!cache) {
    cache = new Map();
    caches.set(db, cache);
  }

  const hit = cache.get(sql);
  if (hit) return hit;

  const statement = db.prepare(sql);
  if (cache.size >= MAX_CACHED_STATEMENTS) cache.clear();
  cache.set(sql, statement);
  return statement;
}

/** 测试用:看一眼某个连接缓存了多少条。 */
export function cachedStatementCount(db: Database): number {
  return caches.get(db)?.size ?? 0;
}
