---
name: onesql
description: Execute a SELECT SQL query against Hive/Spark via spark-submit (pyspark), persist the result as a local parquet directory, and preview the first N result rows on stdout. Use this skill whenever the user wants to run a SELECT query, fetch query results, export SQL output to parquet, dump a Hive/Spark table to local parquet files, run a one-off ad-hoc SQL and save the data, asks to "run this SQL and save it as parquet", OR describes what they want in natural language (e.g. "how many rows does table X have") and wants Claude to generate the SELECT, run it, and relay the result. The skill runs the SELECT through a pyspark SparkSession, writes the resulting DataFrame directly to a local parquet directory via Spark's native write.parquet (no Hive temp table, no CTAS, no ORC download), prints a row-count + first-N-rows preview on stdout, and returns that directory path as the final stdout line.
license: Complete terms in LICENSE.txt
---

# onesql — run a SELECT and save as local parquet

A SELECT-only pipeline that runs a query through a pyspark `SparkSession`,
and writes the resulting `DataFrame` directly to a local parquet directory
via Spark's native `write.parquet()` — bypassing the Hive write path
entirely.

## When to use

Use this skill when the user asks for any of the following:

- "Run this SQL and save the result as parquet"
- "Execute this SELECT and dump it locally"
- "Pull a Hive/Spark query into a parquet file"
- "Query this table and export to parquet"
- "onesql <SQL>" / "用 onesql 跑一下" / "把这个 SQL 跑出来存 parquet"
- Natural-language data questions where Claude should generate the SELECT
  and relay the answer — e.g. "帮我看下 app_dm.recsys_apppublic_homepage_specialbanner_log
  有多少条数据" (→ `SELECT COUNT(*) AS cnt FROM ...`)

Do **not** use this skill for:

- INSERT / UPDATE / DELETE / DDL — only `SELECT` (or `WITH ... SELECT`) is supported
- Outputs that should stay in Hive (use the user's normal hive flow)
- Outputs that should be CSV/JSON/Excel (not parquet)

## How it works

The pipeline is implemented by `scripts/onesql.py` inside this skill's
directory. The skill is expected to be installed at `~/.claude/skills/onesql/`
on every machine — that's the only path assumption. The SQL lives in a
`.sql` file containing **only** a `SELECT` (or `WITH ... SELECT`) — no
`DROP/CREATE/INSERT`, no CTAS wrapper. Invoke it from a Bash block:

```bash
PYSPARK_PYTHON=/opt/conda/envs/pyspark/bin/python \
PYSPARK_DRIVER_PYTHON=/opt/conda/envs/pyspark/bin/python \
spark-submit ~/.claude/skills/onesql/scripts/onesql.py -f=path/to/query.sql
```

> **The `PYSPARK_PYTHON` / `PYSPARK_DRIVER_PYTHON` prefix is mandatory on this
> machine.** The shell default is `PYSPARK_PYTHON=python3env/pyspark/bin/python`,
> a *relative* path that only resolves on the cluster (where Spark unpacks
> `PYSPARK_ARCHIVES=viewfs://dcfs/ns-log/spark/pyspark/pyspark_3.11.zip#python3env`
> into a local `python3env/` dir). In a local `spark-submit` run that archive
> isn't fetched, so the worker can't find `python3env/pyspark/bin/python` and
> the job dies with `Cannot run program "python3env/pyspark/bin/python":
> No such file or directory`. Overriding to the conda python on `PATH` fixes
> it. `PYSPARK_DRIVER_PYTHON` must match (the driver python), otherwise
> `spark-submit` can't even start the Python driver.

If the skill is installed at a non-default location, substitute that path.

The script prints the absolute path of the output directory (the `{requestid}`
directory containing the parquet files) on stdout. Surface that path to the
user — that's the deliverable.

Steps performed by the script:

1. **requestid** — `{yyyyMMddHHmmss}_{XXXXX}` where `XXXXX` is five random
   digits. Used as the default output subdir name.
2. **Read & validate** — read the `-f` SQL file; reject anything that
   doesn't start with `SELECT` or `WITH` (case-insensitive, leading
   whitespace and trailing semicolons tolerated).
3. **Build SparkSession** — `enableHiveSupport()` so Hive tables are
   readable; configs copied from the proven-working `test.py` recipe on
   this machine. No `findspark` (not installed in the conda env, and
   `spark-submit` already puts `pyspark` on `PYTHONPATH`).
4. **Run SELECT** — `df = spark.sql(sql)`. Reading Hive tables works;
   the failure mode below is specific to *writing* via Hive.
5. **Sanitize types** — `decimal` → `double` (so downstream pandas reads
   are clean), `void`/all-NULL columns → `string` (Spark can `count` a
   void column but `write.parquet` rejects it with `Unsupported data type`).
6. **Write local parquet** — `df.repartition(nparts).write.mode("overwrite")
   .option("compression","zstd").parquet("file:///<abs path>")`. The
   `file://` prefix is required because the default FS is `viewfs://` —
   a bare local path would be interpreted as an HDFS path. Legacy
   datetime rebase mode is set so old-Hive sentinel dates (`0001-01-01`
   etc.) don't throw under Spark3's default `EXCEPTION` mode.
7. **Preview** — if `--show N > 0` (default 100), re-read the just-written
   local parquet and print `result.show(N, truncate=False)` to stdout.
   For a `COUNT`/small aggregation this **is** the full answer; for a
   large row-level result it's a sample (point the user at the parquet
   dir for the full data). Reading the local parquet is cheap and adds
   no extra scan of the source SELECT.
8. **Stop** — `spark.stop()` in a `finally`. No temp Hive table to drop
   (none was ever created).

> **Why not CTAS?** The earlier version of this skill wrapped the SELECT
> into `DROP/CREATE TABLE ... AS SELECT ... STORED AS ORC` and ran it via
> `spark-sql -f`, then pulled the ORC files off HDFS and converted them to
> parquet with pandas. On this machine `InsertIntoHiveTable` triggers
> `SessionState.setupAuth()`, which asks the Waggle Dance federated
> metastore for a delegation token and throws `NullPointerException`
> (verified: plain `SELECT`, plain `CREATE TABLE`, and `CTAS` were tested
> via `spark-sql -f`; the first two succeed, only CTAS fails). Pure
> `SELECT` + Spark-native `write.parquet` never touches that auth path,
> needs no Hive temp table, and skips the `hadoop fs -get` + ORC→parquet
> hop entirely.

## Natural-language → SQL

When the user describes what they want in words instead of handing you a
ready-made SELECT — e.g. "帮我看下
app_dm.recsys_apppublic_homepage_specialbanner_log 有多少条数据" — you
(Claude) generate the SELECT, run the skill, and relay the result back in
prose:

1. **Generate the SELECT** that answers the request. Common shapes:
   - "有多少条数据 / 行数" → `SELECT COUNT(*) AS cnt FROM <db>.<table>`
   - "看几条样例 / 长什么样" → `SELECT * FROM <db>.<table> LIMIT 10`
   - "某条件下有多少 / 聚合统计" →
     `SELECT <dims>, <aggs> FROM <db>.<table> WHERE <conds> GROUP BY <dims>`
2. **If you need the table schema** (column names / types / comments) to
   write the SELECT, inspect it first — it's a pure metadata query and
   works fine on this machine (only CTAS *writes* hit the NPE; see "Why
   not CTAS?" above):
   ```bash
   spark-sql -e "DESCRIBE <db>.<table>"
   ```
   No `PYSPARK_PYTHON` prefix needed (DESCRIBE launches no python
   workers). `SHOW CREATE TABLE <db>.<table>` also works.
3. **Write the SELECT to a temp `.sql` file** (e.g.
   `/tmp/onesql_<purpose>.sql`) and invoke the skill with `-f=that.sql`.
4. **Relay the result from stdout**: the `行数: N` line is the
   result-set row count, and the `=== 结果预览（前N行）===` block holds the
   actual values. For "有多少条数据" the preview's `cnt` value **is** the
   table's row count — answer e.g. "该表共有 27,356,006 条数据". For a
   row-level dump, surface the preview as a table and point the user at
   the printed parquet dir for the full data.

## Inputs

The script takes the SQL from a file via `-f` / `--file`:

```bash
spark-submit onesql.py -f=query.sql
# equivalent forms: -f query.sql | --file=query.sql | --file query.sql
```

The `.sql` file must contain a single `SELECT` (or `WITH ... SELECT`).
Trailing `;` is tolerated; anything else (INSERT/UPDATE/DDL/CTAS) is
rejected with a non-zero exit.

Flags:

- `--output-dir DIR` — where to write the parquet files. Defaults to
  `{cwd}/onesql_{requestid}` (an auto-generated subdir directly under the
  session's working directory — `cwd` is where `spark-submit` is invoked
  from). If set, the
  requestid is **not** appended — use the exact path you want (`~`
  expanded). Re-runs into the same `--output-dir` overwrite same-numbered
  parquet files.
- `--show N` — after writing, print the first N result rows to stdout
  (default 100; `0` = write parquet only, no preview). The total result
  row count is always printed on the `行数: N` line. For a `COUNT`/small
  aggregation the preview is the full result; for large results it's a
  sample.

## Output

- One directory (default `{cwd}/onesql_{requestid}`, where `cwd` is the
  directory `spark-submit` was invoked from — i.e. the session working
  directory) containing parquet files (`part-*.parquet` written by Spark's
  native parquet writer).
- On stdout: a `行数: N` line (result-set row count), the parquet dir
  path, and (by default) a `=== 结果预览 ===` block with the first
  `--show` rows — the dir path is the **final** stdout line.
- Non-zero exit on any failure; the SparkSession is stopped in a `finally`
  so no SparkContext leaks.

## Dependencies

- `spark-submit` on `PATH` (Spark 3.x) for running the SELECT.
- `spark-sql` CLI on `PATH` is **optional** — only used for `DESCRIBE` /
  `SHOW CREATE TABLE` when you need to inspect a table's schema before
  writing the SELECT (a metadata query; launches no python workers, so
  no `PYSPARK_PYTHON` prefix needed). The main run path no longer uses
  it for CTAS.
- `pyspark` importable from the Python at
  `/opt/conda/envs/pyspark/bin/python` (Spark's native parquet writer is
  used, so **no pandas / pyarrow needed anymore** — the old ORC-download
  + `pandas.read_orc` hop is gone).
- The `PYSPARK_PYTHON` / `PYSPARK_DRIVER_PYTHON` env override (see the
  mandatory-prefix note above).

## Example

```bash
# query.sql:
#   SELECT user_id, COUNT(*) AS n FROM events WHERE dt='2026-08-01' GROUP BY user_id

PYSPARK_PYTHON=/opt/conda/envs/pyspark/bin/python \
PYSPARK_DRIVER_PYTHON=/opt/conda/envs/pyspark/bin/python \
spark-submit ~/.claude/skills/onesql/scripts/onesql.py -f=query.sql
# -> /home/you/onesql_20260803140523_48291
```
