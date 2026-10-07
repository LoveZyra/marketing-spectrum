import type { Database, Statement } from 'better-sqlite3';

/**
 * 按连接缓存 prepared statement。
 *
 * 为什么需要:`db.prepare(sql)` 每次都会重新编译 SQL,而仓库层的方法大多是
 * `getConnection().prepare('…').get(…)` 一气呵成 —— 侧栏每刷新一次、每条消息落库一次,
 * 都在重编译同一句。热路径上缓存后约快 4.6 倍。
 *
 * 为什么用 WeakMap 按连接作键:prepared statement 绑在具体连接上,连接被 close 后重开
 * (关停、测试切库,见 connection.ts),旧 statement 就失效,用它会抛。以连接对象为键,
 * 新连接自然拿到空缓存,旧连接连同它的 statement 一起被 GC —— 不需要显式失效逻辑,
 * 也不可能把旧连接的 statement 发给新连接(session-messages.db.ts 用的是"记住上次那个 db、
 * 换了就整体重建"的做法,效果相同,但要每个仓库各维护一份)。
 *
 * 为什么必须有上限:有一类 SQL 是按参数个数拼出来的
 * (`SELECT … WHERE project_id IN (${placeholders})`),每种 id 数量就是一个不同的 SQL 串,
 * 不设上限缓存会只增不减。上限 200,超了整体清空而不是 LRU:真正的热 SQL 只有几十条,
 * 清空后立刻会被重新填上;LRU 的开销和复杂度换不回什么。
 *
 * 真到了频繁清空的地步,说明有 SQL 应该改成固定占位符(比如把 IN 列表换成 json_each
 * 或临时表),那是该修的地方,不是该调大上限的地方。
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
