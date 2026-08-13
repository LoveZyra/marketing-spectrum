#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
本地 orc/parquet 文件推送到 Hive 表。

需在有 Spark + Hadoop 客户端的服务器环境运行（依赖 findspark/pyspark）。
目标表不存在时可用 --create-table 按文件 schema 自动建表（STORED AS ORC）。
--file 也可传目录（如 hdfs_get --where 产出的 parquet 目录）：fast 整目录上传，chunk 逐文件分块。

用法示例：
    # 最常用：覆盖写入指定分区，列自动取目标表 schema（剔除分区列）
    python hdfs_push.py --file pred.orc --table tmp_dm.tmp_ctj_xxx --partition dt=20260404

    # 目标表不存在，按文件 schema 自动建表后写入
    python hdfs_push.py --file pred.orc --table tmp_dm.tmp_ctj_new --partition dt=20260404 --create-table

    # 动态分区：--partition 只给列名不给值，分区值取文件里的同名列（文件须含该列）
    python hdfs_push.py --file pred.parquet --table tmp_dm.tmp_ctj_xxx --partition dt

    # 追加写入非分区表
    python hdfs_push.py --file feats.parquet --table tmp_dm.tmp_ctj_xxx --mode append

    # 无 HDFS 写权限时用 chunk 方案（流式分块，parquet 按行数、orc 按 stripe）
    python hdfs_push.py --file pred.orc --table tmp_dm.tmp_ctj_xxx --partition dt=20260404 --method chunk

    # 只导指定列（文件与表列不一致的特殊场景）
    python hdfs_push.py --file pred.orc --table tmp_dm.tmp_ctj_xxx --cols-file cols.txt

同目录 hdfs_data_conf.json 可配置默认值（hdfs_tmp_dir / chunk_size），参考 hdfs_data_conf.example.json。
"""
import argparse
import json
import os
import uuid

import pandas as pd
import pyarrow as pa
from tqdm import tqdm
from pyspark.sql import SparkSession
from pyspark.sql import functions as F

# pandas 2.0 兼容补丁：iteritems() 已被移除，spark.createDataFrame 旧版本还在用
if not hasattr(pd.DataFrame, 'iteritems'):
    pd.DataFrame.iteritems = pd.DataFrame.items


def load_conf():
    """同目录 hdfs_data_conf.json：个人默认值（hdfs_tmp_dir 等），CLI 显式传参优先"""
    conf_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'hdfs_data_conf.json')
    if os.path.isfile(conf_path):
        try:
            with open(conf_path, 'r', encoding='utf-8') as f:
                conf = json.load(f)
            print('[conf] 已加载 {}'.format(conf_path))
            return conf
        except Exception as e:
            print('[conf] 配置文件解析失败，忽略: {}'.format(e))
    return {}


def resolve_hdfs_tmp_dir(cli_value, conf, table):
    """fast 方案 HDFS 临时目录解析：CLI 显式传参 > 配置 hdfs_tmp_dir_map 按库名匹配 > 配置默认 > 内置兜底"""
    if cli_value:
        return cli_value
    db = table.split('.')[0] if '.' in table else ''
    tmp_map = conf.get('hdfs_tmp_dir_map', {})
    if db and db in tmp_map:
        print('[conf] 库名 {} 匹配到 hdfs_tmp_dir: {}'.format(db, tmp_map[db]))
        return tmp_map[db]
    return conf.get('hdfs_tmp_dir', '/ns-dcbi/dm/tmp/ctj')


def build_spark():
    # lazy import：让 --help 等不需要 Spark 的路径在没装 findspark 时也能跑
    import findspark
    findspark.init()
    return SparkSession.builder.appName("hdfs_push") \
        .config("spark.io.compression.codec", "snappy") \
        .config("spark.sql.execution.arrow.pyspark.enabled", "true") \
        .enableHiveSupport() \
        .getOrCreate()


def detect_format(file_path):
    lower = file_path.lower()
    if lower.endswith('.parquet'):
        return 'parquet'
    if lower.endswith('.orc'):
        return 'orc'
    with open(file_path, 'rb') as f:
        head = f.read(4)
    if head[:4] == b'PAR1':
        return 'parquet'
    if head[:3] == b'ORC':
        return 'orc'
    raise ValueError('无法识别文件格式（仅支持 orc/parquet）: {}'.format(file_path))


def read_file_schema(file_path, fmt):
    """读文件的 arrow schema（只读元数据，不载入数据）"""
    if fmt == 'orc':
        import pyarrow.orc as orc
        return orc.ORCFile(file_path).schema
    import pyarrow.parquet as pq
    return pq.ParquetFile(file_path).schema_arrow


def collect_input_files(path):
    """--file 支持目录（如 hdfs_get --where 产出的 parquet 目录）：递归收集数据文件，
    跳过 _SUCCESS/.crc/隐藏文件。单文件原样返回；不存在返回空列表。"""
    if os.path.isfile(path):
        return [path]
    if not os.path.isdir(path):
        return []
    out = []
    for root, dirs, files in os.walk(path):
        dirs[:] = [d for d in dirs if not d.startswith(('_', '.'))]
        for fn in files:
            if fn.startswith(('_', '.')) or fn.lower().endswith('.crc'):
                continue
            out.append(os.path.join(root, fn))
    return sorted(out)


# ---------- 建表 ----------
def arrow_to_hive_type(t):
    """arrow 类型 -> Hive 类型（建表用）；未知类型兜底 string"""
    if pa.types.is_dictionary(t):
        t = t.value_type
    if pa.types.is_decimal(t):
        return 'decimal({},{})'.format(t.precision, t.scale)
    if pa.types.is_int8(t):
        return 'tinyint'
    if pa.types.is_int16(t) or pa.types.is_uint8(t):
        return 'smallint'
    if pa.types.is_int32(t) or pa.types.is_uint16(t):
        return 'int'
    if pa.types.is_int64(t) or pa.types.is_uint32(t) or pa.types.is_uint64(t):
        return 'bigint'
    if pa.types.is_float32(t):
        return 'float'
    if pa.types.is_float64(t):
        return 'double'
    if pa.types.is_boolean(t):
        return 'boolean'
    if pa.types.is_date(t):
        return 'date'
    if pa.types.is_timestamp(t):
        return 'timestamp'
    return 'string'


def build_create_sql(result_tbl, file_schema, part_keys):
    """按文件 schema 生成建表 DDL；分区列若在文件里则用文件类型，否则 string"""
    part_keys_lower = [k.lower() for k in part_keys]
    file_types = {f.name.lower(): arrow_to_hive_type(f.type) for f in file_schema}
    data_defs = ['`{}` {}'.format(f.name.lower(), arrow_to_hive_type(f.type))
                 for f in file_schema if f.name.lower() not in part_keys_lower]
    sql = 'create table {} (\n  {}\n)'.format(result_tbl, ',\n  '.join(data_defs))
    if part_keys:
        part_defs = ['`{}` {}'.format(k, file_types.get(k.lower(), 'string')) for k in part_keys]
        sql += '\npartitioned by ({})'.format(', '.join(part_defs))
    sql += '\nstored as orc'
    return sql


def table_exists(spark, tbl_name):
    """仅"表不存在"返回 False；metastore/权限等其他异常抛出——否则连接故障会被当成
    "表不存在"，误导用户去 --create-table 或报错方向排查错。"""
    try:
        spark.sql("desc {}".format(tbl_name))
        return True
    except Exception as e:
        low = str(e).lower()
        if ('table or view not found' in low or 'nosuchtable' in low
                or 'table_or_view_not_found' in low or 'table not found' in low):
            return False
        raise RuntimeError('检查目标表 {} 失败（非"表不存在"，疑似 metastore 连接/权限问题）: {}'.format(
            tbl_name, str(e).splitlines()[0][:300]))


def get_table_cols(spark, tbl_name):
    """desc formatted 解析：返回 (非分区字段, 分区字段)。失败时回退 limit 1（视为无分区）。"""
    try:
        rows = spark.sql("desc formatted {}".format(tbl_name)).collect()
        all_cols, part_cols = [], []
        section = 'cols'
        for r in rows:
            col_name = (r.col_name or '').strip()
            if col_name == '# Partition Information':
                section = 'part'
                continue
            if col_name in ('# Detailed Table Information', '# Storage Information'):
                break
            if not col_name or col_name.startswith('#'):
                continue
            if section == 'cols':
                all_cols.append(col_name)
            elif col_name not in part_cols:
                part_cols.append(col_name)
        if all_cols:
            return [c for c in all_cols if c not in part_cols], part_cols
    except Exception as e:
        print("[meta] desc formatted 解析失败，回退 limit 1 取列名: {}".format(e))
    df = spark.sql("select * from {} limit 1".format(tbl_name)).toPandas()
    return df.columns.to_list(), []


def load_cols_file(path):
    """列清单文件：每行一列，也支持逗号分隔；# 开头为注释"""
    cols = []
    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            cols.extend([c.strip() for c in line.split(',') if c.strip()])
    return cols


# ---------- 写入 ----------
def select_with_cast(spark_df, target_types, res_cols, dynamic_parts, verbose=True):
    """全列显式 cast 到目标表类型（避免 insert 隐式转换静默产生 NULL）：
    存在的列 cast 后选择（大小写不敏感匹配），缺失列按目标类型填 NULL，动态分区列排在最后"""
    available = {c.lower(): c for c in spark_df.columns}
    src_types = dict(spark_df.dtypes)
    exprs, missing, casted = [], [], []
    for col in list(res_cols) + list(dynamic_parts):
        ttype = target_types.get(col.lower())
        if col.lower() in available:
            src = available[col.lower()]
            if ttype is not None:
                exprs.append(F.col(src).cast(ttype).alias(col))
                if src_types.get(src) != ttype.simpleString():
                    casted.append('{}: {} -> {}'.format(col, src_types.get(src), ttype.simpleString()))
            else:
                exprs.append(F.col(src).alias(col))
        elif col in dynamic_parts:
            raise RuntimeError('动态分区列 {} 在文件中不存在，无法写入'.format(col))
        else:
            missing.append(col)
            exprs.append(F.lit(None).cast(ttype if ttype is not None else 'string').alias(col))
    if verbose:
        if casted:
            print('    显式类型转换 {} 列（string->数值 转不动的值会变 NULL，注意检查）:'.format(len(casted)))
            for c in casted[:20]:
                print('      {}'.format(c))
            if len(casted) > 20:
                print('      ... 共 {} 列'.format(len(casted)))
        if missing:
            print('    警告: 以下列文件中不存在，按目标表类型填充 NULL: {}'.format(missing))
    return spark_df.select(exprs)


def write_spark_df_to_table(spark, spark_df, result_tbl, is_insert_overwrite,
                            static_parts, dynamic_parts):
    """已对齐列序的 Spark DataFrame 写入 Hive 表（静态/动态/多级分区）"""
    tmp_name = "tmp_view_{}".format(os.getpid())
    spark_df.createOrReplaceTempView(tmp_name)

    insert_type = 'overwrite' if is_insert_overwrite else 'into'
    # 分区值转义单引号，与 get 侧一致
    part_items = ["{} = '{}'".format(k, str(v).replace("'", "''"))
                  for k, v in static_parts.items()] + list(dynamic_parts)
    if part_items:
        sql = "insert {} table {} partition({}) select * from {}".format(
            insert_type, result_tbl, ', '.join(part_items), tmp_name)
    else:
        sql = "insert {} table {} select * from {}".format(insert_type, result_tbl, tmp_name)

    try:
        spark.sql(sql)
    finally:
        try:
            spark.catalog.dropTempView(tmp_name)
        except Exception:
            pass
    return sql


def count_target(spark, result_tbl, static_parts):
    if static_parts:
        cond = ' and '.join(["{} = '{}'".format(k, v) for k, v in static_parts.items()])
        return spark.sql("select count(*) from {} where {}".format(result_tbl, cond)).collect()[0][0]
    return spark.sql("select count(*) from {}".format(result_tbl)).collect()[0][0]


def report_count(spark, result_tbl, static_parts, dynamic_parts, is_overwrite, src_cnt):
    """行数校验：静态分区/非分区 + overwrite 时严格对比；动态分区/append 只报告"""
    if dynamic_parts:
        # 纯动态分区时目标范围 = 全表，count(*) 对大历史表代价可能远超推送本身，跳过
        if static_parts:
            tgt_cnt = count_target(spark, result_tbl, static_parts)
            print("    静态分区范围现有行数: {:,}（动态分区不做严格校验）".format(tgt_cnt))
        else:
            print("    动态分区写入：跳过目标行数统计（全表 count 代价大，不校验）")
        return
    tgt_cnt = count_target(spark, result_tbl, static_parts)
    scope = '分区' if static_parts else '表'
    print("    目标{}行数: {:,}".format(scope, tgt_cnt))
    if is_overwrite and src_cnt is not None and tgt_cnt != src_cnt:
        # overwrite + 静态分区/非分区表：目标行数必须等于源行数，不一致即写入异常
        # （并发写入/覆盖失败），必须非零退出，不能让调度方误判成功
        raise RuntimeError("行数校验不一致: 源 {:,} vs 目标{} {:,}".format(src_cnt, scope, tgt_cnt))
    elif is_overwrite:
        print("    行数校验通过")


def sink_fast_hdfs(spark, file_path, fmt, result_tbl, res_cols, target_types,
                   is_insert_overwrite, static_parts, dynamic_parts, hdfs_tmp_dir):
    """推荐方案：本地文件/目录上传 HDFS -> Spark 原生读取 -> 写入 Hive（全程分布式）。

    HDFS 临时路径带 pid+uuid 唯一后缀：共享 hdfs_tmp_dir 下多人/多任务并发推送同名文件
    不再互删；目录输入（hdfs_get --where 产出）整体上传，Spark 读目录自动跳过 _SUCCESS。
    """
    local_file = os.path.abspath(file_path)
    file_name = os.path.basename(local_file.rstrip('/'))
    hdfs_path = "{}/push_{}_{}_{}".format(
        hdfs_tmp_dir.rstrip('/'), os.getpid(), uuid.uuid4().hex[:8], file_name)

    # Step 1: 上传本地文件到 HDFS（Hadoop JVM API，不依赖 hdfs 命令）
    print("[1/4] 上传本地文件到HDFS: {} -> {}".format(local_file, hdfs_path))
    sc = spark.sparkContext
    hadoop_conf = sc._jsc.hadoopConfiguration()
    fs = sc._jvm.org.apache.hadoop.fs.FileSystem.get(hadoop_conf)
    fs.mkdirs(sc._jvm.org.apache.hadoop.fs.Path(hdfs_tmp_dir))
    target = sc._jvm.org.apache.hadoop.fs.Path(hdfs_path)
    if fs.exists(target):
        fs.delete(target, True)   # recursive=True：目录输入时非递归删除会失败
    fs.copyFromLocalFile(sc._jvm.org.apache.hadoop.fs.Path(local_file), target)
    print("    上传完成")

    try:
        # Step 2: Spark 原生读取（自动分布式分片）
        print("[2/4] Spark读取HDFS {}: {}".format(fmt, hdfs_path))
        spark_df = spark.read.orc(hdfs_path) if fmt == 'orc' else spark.read.parquet(hdfs_path)
        src_cnt = spark_df.count()
        print("    源文件行数: {:,}".format(src_cnt))

        # Step 3: 列映射 + 全列显式 cast
        print("[3/4] 处理列映射与类型转换...")
        spark_df = select_with_cast(spark_df, target_types, res_cols, dynamic_parts)

        # Step 4: 写入 Hive
        print("[4/4] 写入Hive表: {}".format(result_tbl))
        sql = write_spark_df_to_table(spark, spark_df, result_tbl,
                                      is_insert_overwrite, static_parts, dynamic_parts)
        print("    完成! SQL: {}".format(sql))
        report_count(spark, result_tbl, static_parts, dynamic_parts, is_insert_overwrite, src_cnt)
    finally:
        try:
            if fs.exists(target):
                fs.delete(target, True)
                print("    HDFS临时文件已清理: {}".format(hdfs_path))
        except Exception as e:
            print("    警告: 临时文件清理失败: {}".format(e))
    return 'done'


def iter_file_batches(file_path, fmt, read_cols, chunk_size):
    """流式分块读取：parquet 按 chunk_size 行、orc 按 stripe。返回 (总行数, 块数, 迭代器)"""
    cols = read_cols or None
    if fmt == 'parquet':
        import pyarrow.parquet as pq
        pf = pq.ParquetFile(file_path)
        total = pf.metadata.num_rows
        n_chunks = max(1, (total + chunk_size - 1) // chunk_size)
        return total, n_chunks, pf.iter_batches(batch_size=chunk_size, columns=cols)
    import pyarrow.orc as orc
    of = orc.ORCFile(file_path)

    def gen():
        for i in range(of.nstripes):
            yield of.read_stripe(i, columns=cols)
    return of.nrows, of.nstripes, gen()


def sink_chunk(spark, file_paths, fmt, result_tbl, res_cols, target_types,
               is_insert_overwrite, static_parts, dynamic_parts, chunk_size):
    """备选方案：pyarrow 流式分块 -> Spark -> Hive（无需 HDFS 写权限，全程单块内存）。

    支持多文件（--file 传目录时）：全局首块 overwrite，其余块统一 into 语义。
    """
    file_schema = read_file_schema(file_paths[0], fmt)
    lower_map = {n.lower(): n for n in file_schema.names}
    wanted = list(res_cols) + list(dynamic_parts)
    read_cols = [lower_map[c.lower()] for c in wanted if c.lower() in lower_map]
    if not read_cols:
        # 一个同名列都没有 → 后续会写入整块全 NULL 数据，几乎必是推错文件，直接报错
        raise RuntimeError('文件与目标表没有任何同名列（文件列: {} ...），疑似推错文件'.format(
            list(file_schema.names)[:10]))

    if dynamic_parts and is_insert_overwrite:
        print('[warn] 动态分区 + overwrite + chunk：只有首块出现过的分区会被清空，'
              '后续块新出现的分区是追加语义，建议动态分区覆盖场景用 --method fast')

    metas = [iter_file_batches(fp, fmt, read_cols, chunk_size) for fp in file_paths]
    total = sum(m[0] for m in metas)
    n_chunks = sum(m[1] for m in metas)
    print("总数据量: {:,} 行（{} 个文件），分 {} 块（{}）".format(
        total, len(file_paths), n_chunks,
        'parquet 按 {:,} 行'.format(chunk_size) if fmt == 'parquet' else 'orc 按 stripe'))
    if total == 0:
        # 0 行时循环体一次都不进：overwrite 时 INSERT OVERWRITE 根本没发出，
        # 目标保留旧数据，静默 exit 0 会让下游误以为已用"今天的空结果"覆盖
        if is_insert_overwrite:
            raise RuntimeError('源文件 0 行：chunk 模式不会执行 INSERT OVERWRITE，目标数据保持原样。'
                               '若确要清空目标分区，用 --method fast（0 行也会执行覆盖）')
        print('[warn] 源文件 0 行，append 无事可做')
        return 'done'

    done_rows = 0
    idx = 0
    bar = tqdm(total=n_chunks, desc="导入进度")
    for _, _, batches in metas:
        for batch in batches:
            df_chunk = batch.to_pandas()
            spark_df = spark.createDataFrame(df_chunk)
            # 缺失列/类型 cast 统一走 select_with_cast，全局首块打印详情
            spark_df = select_with_cast(spark_df, target_types, res_cols, dynamic_parts,
                                        verbose=(idx == 0))
            tmp_overwrite = is_insert_overwrite if idx == 0 else False
            sql = write_spark_df_to_table(spark, spark_df, result_tbl,
                                          tmp_overwrite, static_parts, dynamic_parts)
            done_rows += batch.num_rows
            if idx == 0:
                print("\n块 1 完成: {}".format(sql))
            idx += 1
            bar.update(1)
    bar.close()

    print("\n导入完成，共处理 {:,} 行".format(done_rows))
    report_count(spark, result_tbl, static_parts, dynamic_parts, is_insert_overwrite, done_rows)
    return 'done'


def main():
    conf = load_conf()
    parser = argparse.ArgumentParser(description='本地 orc/parquet 文件推送到 Hive 表')
    parser.add_argument('--file', required=True, help='本地 orc/parquet 文件路径')
    parser.add_argument('--table', required=True, help='目标 Hive 表名')
    parser.add_argument('--partition', action='append', default=[], metavar='K=V|K',
                        help="分区：K=V 静态（如 dt=20260404），只给 K 为动态（分区值取文件同名列）；可重复指定多级")
    parser.add_argument('--mode', choices=['overwrite', 'append'], default='overwrite',
                        help='overwrite=覆盖写入（默认，注意非分区表是全表覆盖），append=追加')
    parser.add_argument('--method', choices=['fast', 'chunk'], default='fast',
                        help='fast=上传HDFS后Spark分布式导入（默认，最快）；chunk=pyarrow流式分块（无HDFS写权限时用）')
    parser.add_argument('--create-table', action='store_true',
                        help='目标表不存在时按文件 schema 自动建表（STORED AS ORC）')
    parser.add_argument('--hdfs-tmp-dir', default=None,
                        help='fast 方案的 HDFS 临时目录（需有写权限）；不传时按配置文件 '
                             'hdfs_tmp_dir_map 以目标表库名匹配，无匹配用 hdfs_tmp_dir 默认值')
    parser.add_argument('--cols-file', default=None,
                        help='列清单文件（每行一列或逗号分隔）；默认自动取目标表全部非分区列')
    parser.add_argument('--chunk-size', type=int, default=int(conf.get('chunk_size', 500000)),
                        help='chunk 方案每块行数（仅 parquet 生效，orc 按 stripe 分块）')
    args = parser.parse_args()

    data_files = collect_input_files(args.file)
    if not data_files:
        parser.error('文件/目录不存在，或目录内无数据文件: {}'.format(args.file))
    if len(data_files) > 1:
        print('输入为目录: {} 个数据文件（fast 整目录上传，chunk 逐文件分块）'.format(len(data_files)))
    fmt = detect_format(data_files[0])
    file_schema = read_file_schema(data_files[0], fmt)
    hdfs_tmp_dir = resolve_hdfs_tmp_dir(args.hdfs_tmp_dir, conf, args.table)

    static_parts = {}
    dynamic_parts = []
    for p in args.partition:
        if '=' in p:
            k, v = p.split('=', 1)
            static_parts[k.strip()] = v.strip()
        else:
            dynamic_parts.append(p.strip())
    dup = set(static_parts) & set(dynamic_parts)
    if dup:
        parser.error('分区列 {} 同时按静态和动态指定，请二选一'.format(sorted(dup)))

    spark = build_spark()

    # 建表 / 存在性检查
    if not table_exists(spark, args.table):
        if not args.create_table:
            parser.error('目标表 {} 不存在；加 --create-table 可按文件 schema 自动建表'.format(args.table))
        ddl = build_create_sql(args.table, file_schema, list(static_parts) + dynamic_parts)
        print('自动建表 DDL:\n{}'.format(ddl))
        spark.sql(ddl)
        print('建表完成: {}'.format(args.table))
    elif args.create_table:
        print('表 {} 已存在，跳过建表'.format(args.table))

    data_cols, part_cols = get_table_cols(spark, args.table)

    # 分区参数校验：分区表必须给全所有分区列；静态必须在动态之前（Hive 语法要求）
    given = list(static_parts) + dynamic_parts
    if part_cols:
        if not given:
            parser.error('目标表是分区表（分区字段 {}），必须指定 --partition：'
                         'K=V 静态 或 K 动态'.format(part_cols))
        missing = [c for c in part_cols if c not in given]
        extra = [k for k in given if k not in part_cols]
        if missing:
            parser.error('分区列未指定: {}（表分区字段 {}）'.format(missing, part_cols))
        if extra:
            parser.error('--partition 中 {} 不是表的分区字段（表分区字段 {}）'.format(extra, part_cols))
        seen_dynamic = False
        for c in part_cols:
            if c in dynamic_parts:
                seen_dynamic = True
            elif seen_dynamic:
                parser.error('静态分区必须排在动态分区之前（表分区顺序 {}）'.format(part_cols))
        # 按表分区顺序重排
        static_parts = {c: static_parts[c] for c in part_cols if c in static_parts}
        dynamic_parts = [c for c in part_cols if c in dynamic_parts]
    elif given:
        parser.error('目标表 {} 不是分区表，但传了 --partition {}'.format(args.table, given))

    # 动态分区列必须在文件里
    file_names_lower = {n.lower() for n in file_schema.names}
    for k in dynamic_parts:
        if k.lower() not in file_names_lower:
            parser.error('动态分区列 {} 在文件中不存在（文件列: {} ...）'.format(
                k, file_schema.names[:10]))

    res_cols = load_cols_file(args.cols_file) if args.cols_file else data_cols
    if args.cols_file:
        # INSERT 按位置映射到目标表列：必须全量覆盖非分区列并按表列序重排，
        # 否则同类型列会静默错位写入（行数校验发现不了）
        lower_data = {c.lower(): c for c in data_cols}
        unknown = [c for c in res_cols if c.lower() not in lower_data]
        if unknown:
            parser.error('--cols-file 中以下列不在目标表非分区列中: {}'.format(unknown))
        if len({c.lower() for c in res_cols}) != len(data_cols):
            parser.error('--cols-file 必须覆盖目标表全部非分区列（共 {} 列，文件给了 {} 列）；'
                         'INSERT 按位置映射，缺列会错位或报错'.format(len(data_cols), len(res_cols)))
        res_cols = list(data_cols)
    target_types = {f.name.lower(): f.dataType for f in spark.table(args.table).schema.fields}
    print('目标表 {}：写入 {} 列，静态分区 {}，动态分区 {}'.format(
        args.table, len(res_cols), static_parts or '无', dynamic_parts or '无'))

    if dynamic_parts:
        spark.sql("set hive.exec.dynamic.partition=true")
        spark.sql("set hive.exec.dynamic.partition.mode=nonstrict")
        # Spark 走 datasource writer（convertMetastoreOrc/Parquet）时，INSERT OVERWRITE 的
        # 覆盖范围由该参数决定：默认 STATIC 会清空目标表**全部**分区（数据丢失事故），
        # dynamic 才是"只覆盖本次写入出现过的分区"
        spark.conf.set("spark.sql.sources.partitionOverwriteMode", "dynamic")

    is_overwrite = args.mode == 'overwrite'
    if args.method == 'fast':
        sink_fast_hdfs(spark, args.file, fmt, args.table, res_cols, target_types,
                       is_overwrite, static_parts, dynamic_parts, hdfs_tmp_dir)
    else:
        sink_chunk(spark, data_files, fmt, args.table, res_cols, target_types,
                   is_overwrite, static_parts, dynamic_parts, args.chunk_size)


if __name__ == '__main__':
    main()
