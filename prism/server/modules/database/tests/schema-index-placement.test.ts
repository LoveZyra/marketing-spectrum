import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { INDEX_SCHEMA_SQL, INIT_SCHEMA_SQL, RETIRED_INDEXES } from '@/modules/database/schema.js';

/**
 * 建表在 `INIT_SCHEMA_SQL`,建索引在 `INDEX_SCHEMA_SQL`,两者不许混。
 *
 * `INIT_SCHEMA_SQL` 由 `initializeDatabase` 在 `runMigrations` 之前用一句 `db.exec` 整体执行,
 * 而 `CREATE TABLE IF NOT EXISTS` 对老库是空操作:这一步看到的表可能还缺着迁移才补的列。
 * 写在建表旁边的索引一旦引用这样的列,老库升级时整句 `db.exec` 就会抛(exec 非原子,
 * 前面的 DDL 已经落库),服务起不来,重启也只会在同一处再失败。
 *
 * 所以规矩是"INIT 里一条 CREATE INDEX 都不许有",由这条测试守着:让不一致写不出来,
 * 而不是靠人记得。
 */
describe('schema:建表与建索引分开', () => {
  test('INIT_SCHEMA_SQL 里一条 CREATE INDEX 都没有', () => {
    const offenders = INIT_SCHEMA_SQL.split('\n')
      .map((line) => line.trim())
      .filter((line) => /^CREATE\s+(UNIQUE\s+)?INDEX/i.test(line));

    assert.deepEqual(
      offenders,
      [],
      '索引必须放进 INDEX_SCHEMA_SQL(由迁移在最后执行),否则老库升级时会因为列还不存在而起不来:\n  '
        + offenders.join('\n  '),
    );
  });

  test('INDEX_SCHEMA_SQL 里只有 CREATE INDEX,没有建表/改表', () => {
    const statements = INDEX_SCHEMA_SQL.split(';')
      .map((chunk) => chunk.replace(/--[^\n]*/g, '').trim())
      .filter(Boolean);
    assert.ok(statements.length > 5, `只解析出 ${statements.length} 条语句,判据可能已失效`);
    for (const statement of statements) {
      assert.match(
        statement,
        /^CREATE\s+(UNIQUE\s+)?INDEX/i,
        `INDEX_SCHEMA_SQL 里出现了非建索引语句:${statement.slice(0, 80)}`,
      );
    }
  });

  test('退役索引不许还留在建索引清单里', () => {
    for (const name of RETIRED_INDEXES) {
      assert.ok(
        !INDEX_SCHEMA_SQL.includes(name),
        `${name} 已列入 RETIRED_INDEXES(迁移会 DROP 它),不该同时又被建出来`,
      );
    }
  });
});
