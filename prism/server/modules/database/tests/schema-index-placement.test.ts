import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { INDEX_SCHEMA_SQL, INIT_SCHEMA_SQL, RETIRED_INDEXES } from '@/modules/database/schema.js';

/**
 * **建表在 `INIT_SCHEMA_SQL`,建索引在 `INDEX_SCHEMA_SQL`,两者不许混。**
 *
 * ## 为什么钉这条
 *
 * `INIT_SCHEMA_SQL` 由 `initializeDatabase` 在 `runMigrations` **之前**用一句
 * `db.exec` 整体执行。而 `CREATE TABLE IF NOT EXISTS` 对老库是空操作 —— 这一步看到的
 * 表可能还是迁移前的形状,缺着后来才加的列。
 *
 * 于是"顺手在建表旁边建个索引"是一个**反复出事**的形状:索引引用了一个迁移才补上的列,
 * 老库升级时整句 `db.exec` 抛(exec 非原子,前面的 DDL 已经落库了),
 * `initializeDatabase` 把异常往上抛 —— **服务起不来**,重启只会在同一处再炸。
 *
 * projects / sessions / api_keys 三处各自踩过一次,当时的修法是逐个挪进迁移、
 * 留一行 NOTE 注释。但那治不了病:只要建索引还允许写在建表旁边,下一个人还会那么写 ——
 * 事实上直到这一轮,`users`、`audit_log`、`user_credentials`、`attachments` 等
 * **7 张表的索引仍然留在 INIT 里**。
 *
 * 所以规矩改成"INIT 里一条 CREATE INDEX 都不许有",由这条测试守着。
 * 这和 i18n 的 `resource-registry`、`.gitignore` 的源码可见性测试是同一个思路:
 * 让不一致**不可表示**,而不是每次靠人记得。
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
