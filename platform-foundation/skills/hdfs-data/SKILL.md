---
name: hdfs-data
description: HDFS/Hive 数据获取与推送。当用户要"把 Hive 表拉到本地/下载 HDFS 数据/导出表数据"或"把本地 orc/parquet 推回 Hive/回写 Hive 表/导入数据到表"时使用。当前环境即 Spark/Hadoop 服务器（SparkSession 可连 Hive metastore via Waggle Dance、HDFS via viewfs、findspark 已装），直接执行脚本完成拉取/推送；缺关键参数先问，报错按"常见问题"诊断。
---

# HDFS 数据获取与推送

两个参数化脚本，位于本 skill 的 `scripts/` 目录：

- `hdfs_get.py`：Hive 表 → 本地 parquet/csv。默认**流式合并**（逐文件读取 → 按 Hive 表类型统一 schema → 追加写出），内存峰值只有单个数据文件大小，大表不会 OOM
- `hdfs_push.py`：本地 orc/parquet → Hive 表（上传 HDFS 后 Spark 分布式导入，或 pyarrow 流式分块导入；表不存在可自动建表）

## 工作模式（重要）

当前环境**就是** Spark/Hadoop 服务器：SparkSession 已可连 Hive metastore（经 Waggle Dance 联邦，`SHOW DATABASES` 可用，约 3925 库），HDFS 经 viewfs 访问（`hadoop fs -ls /ns-dcbi` 可用），findspark 已装。所以**直接在本机执行脚本完成拉取/推送，不要只产出命令交给用户手动跑**。本 skill 的职责：

1. 收集参数（见下），缺关键信息就问
2. 直接执行 `python3 /home/jovyan/.claude/skills/hdfs-data/scripts/hdfs_get.py ...` / `hdfs_push.py ...`，拉取结果落到本地路径、推送完成后查看行数校验输出
3. 报错时按"常见问题"节诊断并重试

脚本固定路径：`/home/jovyan/.claude/skills/hdfs-data/scripts/`。

## 本机环境约束（已验证 2026-07-27）

- **Hive 经 Waggle Dance 联邦**：`spark.catalog.listDatabases()` / `listTables()` 会因联邦库名解析失败报 `SCHEMA_NOT_FOUND`；但 SQL 层 `SHOW DATABASES` / `DESCRIBE DATABASE` / `desc formatted <表>` / `select ... limit 1` 均正常。本 skill 脚本取表 meta 走 `desc formatted` SQL（不依赖 catalog API），不受影响——排查时也用 SQL，别用 catalog API。
- **HDFS 是 viewfs 联邦**：路径形如 `viewfs://dcfs/ns-dcbi/...`。`hadoop fs -ls /` 列根目录有 UGI 报错（root + proxy 怪癖），列具体 namespace（如 `/ns-dcbi`）正常。
- **HDFS CLI 安全包装器**：`hadoop fs` 只允许 `copyToLocal/copyFromLocal/text/cat/ls/put/get/mkdir`，`rm/chmod/mv` 等危险操作被禁（需去 hmd 平台 bds.17usoft.com/hmd 操作）。get 用 `hadoop fs -get`（白名单内）安全；push 的 fast 方案走 Java API（`fs.copyFromLocalFile/fs.delete/fs.mkdirs`）绕过 CLI 包装器，但仍受目标路径 HDFS 写权限限制——若目标分区已存在且无权 delete，改用 `--method chunk`（不经 HDFS 写）或写到新分区。
- 当前 shell 用户为 root；表 owner 多为 dcadmin 等，跨用户写分区需注意权限。
- **本地路径要 `file://` 前缀**：Spark `fs.defaultFS` 是 viewfs，裸路径 `/home/jovyan/...` 会被当 HDFS 路径报 `FileNotFoundException: /home`。本 skill 的 get/push 脚本内部已处理；但若你用裸 SparkSession（如 `df.write.parquet("/home/...")`）须显式 `file:///home/...`。
- **单活动/条件抽取用 `hdfs_get --where`**：`hdfs_get` 默认 `hadoop fs -get` 整个分区/表（多活动分区会全量下载）。要从多活动分区取一个子集，用 `--where "activity_id='562499'"`（可与 `--partition`/`--columns`/`--float32` 叠加；与 `--in-memory` 互斥），走 SparkSession `SELECT...WHERE` 只读命中数据，下载量从整分区降到命中量。产出是 parquet 目录（`pd.read_parquet` 可读）；命中 ≤200万行单文件写出，更大自适应分多文件（不影响目录读取）；decimal 统一转 double（与流式模式一致）；**命中 0 行直接报错**（不产空文件，检查条件/分区）。⚠️ 分区表只传 `--where` 会全分区扫描，已知分区范围时**务必叠加 `--partition`** 裁剪扫描量。

## 参数收集

| 方向 | 必须 | 可选 |
|------|------|------|
| get（拉数据） | 表名 | 分区、列裁剪、输出路径、float32 压缩 |
| push（推数据） | 本地文件路径、目标表名 | 分区（分区表必填，静态/动态）、覆盖/追加、fast/chunk、自动建表 |

用户没说清方向或表名时先问；其余参数有合理默认值，不必逐个确认。

## get 用法

```bash
# 最简：HDFS 路径自动从 metastore 取 location，失败回退 /ns-dcbi/tmp/{表名} 约定
python hdfs_get.py --table tmp_dm.tmp_ctj_xxx

# 指定分区 + 列裁剪（训练只用部分特征列时强烈建议，显著降内存和耗时）
python hdfs_get.py --table dm.some_table --partition dt=20260720 --columns memberid,label,o_c1

# double/decimal 统一降为 float32（体积和内存省一半；金额等高精度列慎用）
python hdfs_get.py --table tmp_dm.tmp_xxx --float32

# 小表用旧版全内存模式（支持 reduce_mem 数据相关 downcast + category 转换）
python hdfs_get.py --table tmp_dm.tmp_xxx --in-memory
python hdfs_get.py --table tmp_dm.tmp_xxx --in-memory --no-reduce-mem
```

其他参数：`--hdfs-path`（显式指定路径）、`--output`、`--format csv`、`--work-dir`、`--keep-work-dir`、`--skip-bad-files`（个别数据文件损坏时跳过继续；**默认整体报错防静默缺数据**，并清掉半截输出文件）。

默认输出 `{output_dir}/{今天}_{表名}.parquet`（zstd 压缩，output_dir 默认 ./dataset）。

**流式 vs 全内存**：默认流式，schema 按 Hive 表类型统一（decimal→float64），跨文件类型漂移会被强转或明确报错；全表拉分区表时分区值会从目录名（dt=xxx）自动找回。`--in-memory` 保留旧行为，仅小表使用。

## push 用法

```bash
# 最常用：覆盖写入指定分区，列自动取目标表 schema（剔除分区列，缺失列按表类型填 NULL）
python hdfs_push.py --file pred.orc --table tmp_dm.tmp_ctj_xxx --partition dt=20260404

# --file 也可传目录（如 hdfs_get --where 产出的 parquet 目录）：fast 整目录上传，chunk 逐文件分块
python hdfs_push.py --file ./dataset/sub.parquet --table tmp_dm.tmp_ctj_xxx --partition dt=20260404

# 目标表不存在：按文件 schema 自动建表（STORED AS ORC）后写入
python hdfs_push.py --file pred.orc --table tmp_dm.tmp_ctj_new --partition dt=20260404 --create-table

# 动态分区：--partition 只给列名，分区值取文件里的同名列（文件须含该列，多日期数据一次写入）
python hdfs_push.py --file pred.parquet --table tmp_dm.tmp_ctj_xxx --partition dt

# 追加写入非分区表（注意：非分区表 overwrite 是全表覆盖！）
python hdfs_push.py --file feats.parquet --table tmp_dm.tmp_ctj_xxx --mode append

# 无 HDFS 写权限时切 chunk 方案（流式分块：parquet 按行数、orc 按 stripe，内存只占单块）
python hdfs_push.py --file pred.orc --table tmp_dm.tmp_ctj_xxx --partition dt=20260404 --method chunk

# 文件与表列对不上的特殊场景，用列清单文件（每行一列或逗号分隔，# 注释）
python hdfs_push.py --file pred.orc --table tmp_dm.tmp_ctj_xxx --cols-file cols.txt
```

其他参数：`--hdfs-tmp-dir`（fast 方案 HDFS 临时目录；不传时按配置文件 `hdfs_tmp_dir_map` 以目标表**库名**自动匹配，如 tmp_dm.xx → /ns-dcbi/dm/tmp/ctj，无匹配用 `hdfs_tmp_dir` 默认值；临时文件名带 pid+uuid 后缀，共享目录并发推送不互删）、`--chunk-size`（chunk 方案 parquet 每块行数，默认 50 万）。

`--file` 也可传**目录**（如 `hdfs_get --where` 产出的 parquet 目录）：fast 整目录上传，chunk 逐文件分块，get→push 闭环打通。纯动态分区写入跳过目标行数统计（全表 count 代价大）；文件与目标表无任何同名列直接报错（防整块 NULL 写入）。

写入前所有列会**显式 cast 到目标表类型**并打印转换清单（避免 Hive 隐式转换静默产生 NULL；注意 bigint→int 这类**收窄转换是静默截断**不是 NULL，建表时列类型要够宽）；导入后自动做行数校验（静态分区/非分区 + overwrite 时严格对比，**不一致直接报错非零退出**）。`--cols-file` 会校验必须全量覆盖目标表非分区列并按表列序重排（INSERT 按位置映射，缺列/乱序会静默错位）。overwrite + 0 行源文件：fast 会真清空目标分区，chunk 直接报错（避免"以为覆盖了实际没覆盖"）。

## 配置文件

`scripts/hdfs_data_conf.json`（与脚本同目录，参考 hdfs_data_conf.example.json）：

```json
{
  "hdfs_tmp_dir_map": {"tmp_dm": "/ns-dcbi/dm/tmp/ctj", "app_dm": "/ns-dcbi/dm/tmp/ctj"},
  "hdfs_tmp_dir": "/ns-dcbi/dm/tmp/ctj",
  "work_dir": "./_hdfs_get_tmp",
  "output_dir": "./dataset",
  "chunk_size": 500000
}
```

个人默认值配一次即可，CLI 显式传参优先。`hdfs_tmp_dir_map` 按 push 目标表的库名（表名点号前半段）匹配 HDFS 临时目录，不同库落在不同 namespace 时在这里配；无匹配回退 `hdfs_tmp_dir`。团队他人使用时改成自己有写权限的目录。

## 已内置处理的坑（不需要额外操作，但排查问题时要知道）

- **Hive decimal 坑**：decimal 列落到 pandas 是 object 类型的 Decimal 对象；流式模式在 arrow 层统一 cast float64，in-memory 模式自动 pd.to_numeric
- **_col0 列名丢失**：orc/parquet 落地后列名变 _col0/_col1，按表 schema 强制覆盖（列数一致才按位置重命名）
- **跨文件 dtype 漂移**：流式模式强制统一 schema，转不动会报错并指出是哪一列；in-memory 模式合并后校验并警告
- **text 格式**：Hive 默认分隔符 `\001`，utf-8 失败自动回退 gbk
- **pandas 2.0**：iteritems 已移除，push 脚本打了兼容补丁
- **分区表**：get 递归收集子目录文件、从目录名找回分区值；push 对分区表强制要求 --partition 且必须覆盖全部分区列，静态在前动态在后
- **列名大小写**：push 按小写不敏感匹配文件列与表列
- **schema 演进**：get 遇到旧文件缺列自动补 NULL 并警告

## 常见问题

- `hadoop fs -get 失败`：确认表 location 与权限；可显式传 `--hdfs-path`
- push 报 HDFS 权限错误（Permission denied）：换 `--hdfs-tmp-dir`，或直接 `--method chunk`
- push 打印了大量类型转换且结果有意外 NULL：源文件列类型与表不符（如 string 列转数值），检查文件生成逻辑
- push 行数校验不一致：append 模式属正常（目标表原有数据）；overwrite 模式需排查
- **动态分区 + overwrite + chunk 有语义坑**（只有首块出现的分区被清空，脚本会警告）：动态分区覆盖场景用 `--method fast`（脚本已设 `spark.sql.sources.partitionOverwriteMode=dynamic`，只覆盖本次写入出现过的分区，不会清整表）
- 非分区表 + overwrite = 全表覆盖，表里有要保留的数据用 `--mode append`
- 内存不够：get 确认没用 `--in-memory`，可加 `--columns` 列裁剪；push 用 `--method chunk` 并调小 `--chunk-size`
