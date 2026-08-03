#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Hive/HDFS 表数据下载到本地 parquet/csv。

需在有 Spark + Hadoop 客户端的服务器环境运行（依赖 findspark/pyspark/hadoop 命令）。

默认流式合并：逐文件读取 -> 统一 schema（按 Hive 表类型）-> 追加写出，
内存峰值只有单个数据文件大小，适合大表；小表想用 reduce_mem 降内存可加 --in-memory。

用法示例：
    # 最简：只给表名（HDFS 路径自动从 metastore 获取，失败则回退 /ns-dcbi/tmp/{表名} 约定）
    python hdfs_get.py --table tmp_dm.tmp_ctj_xxx

    # 指定分区、只取部分列（列裁剪能显著降内存和耗时）
    python hdfs_get.py --table dm.some_table --partition dt=20260720 --columns memberid,label,o_c1

    # double/decimal 统一降为 float32 省一半空间（金额等高精度列慎用）
    python hdfs_get.py --table tmp_dm.tmp_xxx --float32

    # 旧版全内存模式（数据量小时可用，支持 reduce_mem 数据相关 downcast + category 转换）
    python hdfs_get.py --table tmp_dm.tmp_xxx --in-memory

同目录 hdfs_data_conf.json 可配置默认值（work_dir / output_dir），参考 hdfs_data_conf.example.json。
"""
import argparse
import datetime
import decimal
import gc
import io
import json
import os
import re
import shutil
import subprocess
import uuid
import zlib

import pandas as pd
import pyarrow as pa
import pyarrow.orc as pa_orc
import pyarrow.parquet as pq
from tqdm import tqdm
from pyspark.sql import SparkSession


def load_conf():
    """同目录 hdfs_data_conf.json：个人默认值，CLI 显式传参优先"""
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


def build_spark():
    # lazy import：让 --help 等不需要 Spark 的路径在没装 findspark 时也能跑
    import findspark
    findspark.init()
    return SparkSession.builder.appName("hdfs_get") \
        .config("hive.metastore.local", "false") \
        .config("spark.io.compression.codec", "snappy") \
        .config("spark.sql.execution.arrow.enabled", "true") \
        .config("spark.sql.execution.arrow.pyspark.enabled", "true") \
        .enableHiveSupport() \
        .getOrCreate()


def get_table_meta(spark, tbl_name):
    """desc formatted 解析：返回 (全部字段, 分区字段, {字段: hive类型}, HDFS location)。
    失败时回退 limit 1 取列名（无类型、无 location）。"""
    try:
        rows = spark.sql("desc formatted {}".format(tbl_name)).collect()
        all_cols, part_cols = [], []
        hive_types = {}
        location = None
        section = 'cols'
        for r in rows:
            col_name = (r.col_name or '').strip()
            data_type = (r.data_type or '').strip() if r.data_type else ''
            if col_name == '# Partition Information':
                section = 'part'
                continue
            if col_name in ('# Detailed Table Information', '# Storage Information'):
                section = 'detail'
                continue
            if col_name == 'Location' and section == 'detail':
                location = data_type
                continue
            if section == 'detail' or not col_name or col_name.startswith('#'):
                continue
            if section == 'cols':
                all_cols.append(col_name)
                hive_types[col_name] = data_type
            elif section == 'part' and col_name not in part_cols:
                part_cols.append(col_name)
                hive_types[col_name] = data_type
        if all_cols:
            return all_cols, part_cols, hive_types, location
    except Exception as e:
        print("[meta] desc formatted 解析失败，回退 limit 1 取列名: {}".format(e))
    df = spark.sql("select * from {} limit 1".format(tbl_name)).toPandas()
    return df.columns.to_list(), [], {}, None


# ---------- 格式嗅探 ----------
def sniff_format(file_path):
    """优先按扩展名判断，无扩展名时读 magic bytes 嗅探。返回 'parquet'/'orc'/'text'"""
    lower = file_path.lower()
    if lower.endswith('.parquet'):
        return 'parquet'
    if lower.endswith('.orc'):
        return 'orc'
    if lower.endswith(('.csv', '.txt', '.tsv', '.gz', '.deflate')):
        return 'text'
    try:
        with open(file_path, 'rb') as f:
            head = f.read(4)
            if head[:4] == b'PAR1':
                return 'parquet'
            if head[:3] == b'ORC':
                return 'orc'
            f.seek(-3, os.SEEK_END)
            if f.read(3) == b'ORC':
                return 'orc'
    except Exception as e:
        print("[sniff] 读取 magic bytes 失败 {}: {}".format(file_path, e))
    return 'text'


def read_text_with_fallback(file_path, names):
    """先按 utf-8 读，失败再用 gbk。Hive 默认分隔符 \\001；
    Hive 文本 NULL（\\N）识别为缺失值；.deflate（Hive DefaultCodec，zlib）先解压再读。"""
    kw = dict(sep='\001', names=names, na_values=[r'\N'], keep_default_na=True)
    buf = None
    if file_path.lower().endswith('.deflate'):
        with open(file_path, 'rb') as f:
            raw = f.read()
        try:
            buf = zlib.decompress(raw)                    # 带 zlib 头（Hive DefaultCodec）
        except zlib.error:
            buf = zlib.decompress(raw, -zlib.MAX_WBITS)   # raw deflate 兜底
    for enc in ('utf-8', 'gbk'):
        try:
            if buf is not None:
                return pd.read_csv(io.StringIO(buf.decode(enc)), **kw)
            return pd.read_csv(file_path, encoding=enc, **kw)
        except UnicodeDecodeError:
            continue
    if buf is not None:
        return pd.read_csv(io.StringIO(buf.decode('utf-8', errors='replace')), **kw)
    return pd.read_csv(file_path, encoding='utf-8', encoding_errors='replace', **kw)


# ---------- 流式合并（默认路径，arrow 层处理） ----------
def hive_to_arrow_type(hive_type):
    """Hive 类型 -> arrow 类型；decimal 统一 float64；未知/复杂类型返回 None（用文件自身类型）"""
    t = (hive_type or '').lower().strip()
    if not t:
        return None
    if t.startswith('decimal'):
        return pa.float64()
    base = t.split('(')[0].strip()
    mapping = {
        'tinyint': pa.int8(), 'smallint': pa.int16(), 'int': pa.int32(), 'integer': pa.int32(),
        'bigint': pa.int64(), 'float': pa.float32(), 'double': pa.float64(),
        'boolean': pa.bool_(), 'string': pa.string(), 'varchar': pa.string(), 'char': pa.string(),
        'date': pa.date32(), 'timestamp': pa.timestamp('us'),
    }
    return mapping.get(base)


def build_canonical_schema(sample_tbl, ordered_cols, hive_types, use_float32):
    """统一输出 schema：优先 Hive 表类型，取不到用首个文件的类型；decimal->float64"""
    fields = []
    for col in ordered_cols:
        t = hive_to_arrow_type(hive_types.get(col, ''))
        if t is None:
            if col in sample_tbl.column_names:
                t = sample_tbl.schema.field(col).type
            else:
                t = pa.string()
                print('[warn] 列 {} 无法确定类型，按 string 处理'.format(col))
        if pa.types.is_decimal(t):
            t = pa.float64()
        if use_float32 and t == pa.float64():
            t = pa.float32()
        fields.append(pa.field(col, t))
    return pa.schema(fields)


def read_arrow_file(file_path, data_cols, all_cols, want_cols):
    """单文件读成 arrow Table；parquet/orc 列名真实时做读取级列裁剪；处理 _col0 占位列名。

    列裁剪取 want_cols 与文件列的交集：--columns 里带分区列（物理上不在数据文件里）时
    仍能对其余列生效，缺的列（分区值/旧文件缺列）由调用方从路径找回或 align_cast 补 NULL。
    """
    fmt = sniff_format(file_path)
    if fmt == 'parquet':
        pf = pq.ParquetFile(file_path)
        sub = [c for c in (want_cols or []) if c in set(pf.schema_arrow.names)]
        tbl = pf.read(columns=sub) if sub else pf.read()
    elif fmt == 'orc':
        of = pa_orc.ORCFile(file_path)
        sub = [c for c in (want_cols or []) if c in set(of.schema.names)]
        tbl = of.read(columns=sub) if sub else of.read()
    else:
        df = read_text_with_fallback(file_path, data_cols)
        tbl = pa.Table.from_pandas(df, preserve_index=False)
    # _col0/_col1 占位列名 -> 表字段名。只有列名是占位符（_colN）或与表列完全无交集时才
    # 按位置重命名；列名真实但顺序/集合与表不一致的文件绝不能按位置改名（会静默列错位），
    # 交给 align_cast 按名对齐（缺列补 NULL 并警告）
    names = list(tbl.column_names)
    if names != list(data_cols):
        placeholder = bool(names) and all(re.match(r'_col\d+$', str(n)) for n in names)
        if placeholder or not (set(names) & set(data_cols)):
            if len(names) == len(data_cols):
                tbl = tbl.rename_columns(list(data_cols))
            elif len(names) == len(all_cols):
                tbl = tbl.rename_columns(list(all_cols))
    return tbl


def align_cast(tbl, schema):
    """对齐到统一 schema：缺列补 NULL、按列序选择、强转类型；失败时逐列定位报错（dtype 漂移防护）"""
    missing = [n for n in schema.names if n not in tbl.column_names]
    for n in missing:
        tbl = tbl.append_column(n, pa.nulls(tbl.num_rows, type=schema.field(n).type))
    if missing:
        print('[warn] 文件缺列，已补 NULL: {}{}'.format(
            missing[:10], ' ...' if len(missing) > 10 else ''))
    try:
        tbl = tbl.select(schema.names)
    except KeyError as e:
        raise RuntimeError('列对齐失败（文件列名可能是 _col0 占位且列数与表对不上）: {}'.format(e))
    try:
        return tbl.cast(schema)
    except Exception:
        cols = []
        for field in schema:
            col = tbl.column(field.name)
            try:
                cols.append(col.cast(field.type))
            except Exception as e:
                raise RuntimeError('[dtype] 列 {} 无法从 {} 转为 {}: {}'.format(
                    field.name, col.type, field.type, e))
        return pa.Table.from_arrays(cols, schema=schema)


def path_partition_values(file_path, local_dir):
    """从文件相对路径提取分区目录值（.../dt=20260720/part-00000 -> {'dt':'20260720'}）"""
    vals = {}
    rel = os.path.relpath(file_path, local_dir)
    for seg in rel.split(os.sep)[:-1]:
        if '=' in seg:
            k, v = seg.split('=', 1)
            vals[k] = v
    return vals


def stream_merge_save(files, local_dir, partitions, data_cols, all_cols, want_cols,
                      ordered_cols, hive_types, output, out_format, use_float32,
                      allow_skip=False):
    """逐文件：读 -> 补分区常量列 -> 对齐统一 schema -> 追加写出。内存峰值 = 单文件。

    读失败的文件默认整体报错（防静默缺数据）；--skip-bad-files 时跳过并在结尾醒目汇总。
    任何失败路径都会清掉半截输出文件（无 footer 的 parquet 会被误当成功产物）。
    """
    writer = None
    schema = None
    csv_started = False
    total = 0
    skipped = []
    try:
        for i, file_path in enumerate(tqdm(files)):
            try:
                tbl = read_arrow_file(file_path, data_cols, all_cols, want_cols)
            except Exception as e:
                print('[skip] 读取失败: {}: {}'.format(file_path, e))
                skipped.append(file_path)
                continue

            # 分区常量列：--partition 参数值 + 路径里的 k=v 目录（全表拉取时找回分区值）
            consts = path_partition_values(file_path, local_dir)
            consts.update(dict(partitions))
            for k, v in consts.items():
                if k in ordered_cols and k not in tbl.column_names:
                    tbl = tbl.append_column(k, pa.array([v] * tbl.num_rows, type=pa.string()))

            if schema is None:
                schema = build_canonical_schema(tbl, ordered_cols, hive_types, use_float32)
                print('统一输出 schema：\n{}'.format(schema))
            tbl = align_cast(tbl, schema)

            if out_format == 'parquet':
                if writer is None:
                    writer = pq.ParquetWriter(output, schema, compression='zstd')
                writer.write_table(tbl)
            else:
                tbl.to_pandas().to_csv(output, mode='a' if csv_started else 'w',
                                       header=not csv_started, index=False, encoding='utf-8')
                csv_started = True
            total += tbl.num_rows
            del tbl
            if (i + 1) % 20 == 0:   # full GC 每 20 个文件一次（逐文件做在小文件多时开销过大）
                gc.collect()

        if writer is not None:
            writer.close()
            writer = None
        if total == 0:
            raise RuntimeError('未从 {} 读到任何有效数据文件'.format(local_dir))
        if skipped:
            msg = '{} 个数据文件读取失败，输出不完整: {}{}'.format(
                len(skipped), [os.path.basename(p) for p in skipped[:5]],
                ' ...' if len(skipped) > 5 else '')
            if not allow_skip:
                raise RuntimeError(msg + '；确认可接受缺失时加 --skip-bad-files 重跑')
            print('[warn] ' + msg + '（--skip-bad-files 已启用，继续）')
        return total
    except BaseException:
        if writer is not None:
            try:
                writer.close()
            except Exception:
                pass
        try:
            if os.path.exists(output):
                os.remove(output)
                print('[cleanup] 已删除不完整输出文件: {}'.format(output))
        except Exception:
            pass
        raise


# ---------- 全内存模式（--in-memory，旧行为） ----------
def read_data_file(file_path, names):
    fmt = sniff_format(file_path)
    if fmt == 'parquet':
        return pd.read_parquet(file_path)
    if fmt == 'orc':
        return pd.read_orc(file_path)
    return read_text_with_fallback(file_path, names)


def cast_decimal_cols(df):
    """Hive decimal 列 toPandas/read_orc 后是 object 类型的 Decimal 对象，转 float64（训练必须）"""
    for col in df.columns:
        if pd.api.types.is_object_dtype(df[col]):
            s = df[col].dropna()
            if len(s) and isinstance(s.iloc[0], decimal.Decimal):
                df[col] = pd.to_numeric(df[col], errors='coerce')
                print("[decimal] {}: Hive decimal(object) -> float64".format(col))
    return df


def reduce_mem(df):
    for col in df.columns:
        c = df[col]
        if pd.api.types.is_integer_dtype(c):
            df[col] = pd.to_numeric(c, downcast='integer')
        elif pd.api.types.is_float_dtype(c):
            df[col] = pd.to_numeric(c, downcast='float')
        elif pd.api.types.is_object_dtype(c):
            if c.nunique(dropna=False) / max(len(c), 1) < 0.5:
                df[col] = c.astype('category')
    return df


def check_dtype_drift(df, hive_types):
    """数值型 Hive 列合并后仍是 object -> 跨文件类型漂移或脏数据，提示出来"""
    num_prefix = ('tinyint', 'smallint', 'int', 'bigint', 'float', 'double', 'decimal')
    for col in df.columns:
        ht = str(hive_types.get(col, '')).lower()
        if ht.startswith(num_prefix) and pd.api.types.is_object_dtype(df[col]):
            print('[warn][dtype] 列 {} Hive 类型是 {}，合并后却是 object，'
                  '可能跨文件类型漂移或脏数据'.format(col, ht))


def load_merge_in_memory(files, local_dir, data_cols, all_cols, allow_skip=False):
    df_list = []
    skipped = []
    for i, file_path in enumerate(tqdm(files)):
        try:
            df_tmp = read_data_file(file_path, data_cols)
        except Exception as e:
            print("[skip] 读取失败: {}: {}".format(file_path, e))
            skipped.append(file_path)
            continue
        df_list.append(df_tmp)
        del df_tmp
        if (i + 1) % 20 == 0:
            gc.collect()

    if not df_list:
        raise RuntimeError("未从 {} 读到任何有效数据文件".format(local_dir))
    if skipped:
        msg = '{} 个数据文件读取失败，结果不完整: {}{}'.format(
            len(skipped), [os.path.basename(p) for p in skipped[:5]],
            ' ...' if len(skipped) > 5 else '')
        if not allow_skip:
            raise RuntimeError(msg + '；确认可接受缺失时加 --skip-bad-files 重跑')
        print('[warn] ' + msg + '（--skip-bad-files 已启用，继续）')

    df = pd.concat(df_list, ignore_index=True)
    del df_list
    gc.collect()

    # 强制用 Hive 表字段名覆盖（解决 orc/parquet 落地成 _col0/_col1 丢字段名的问题）。
    # 只在列名是 _colN 占位或与表列完全无交集时按位置重命名；列名真实但与表列序/集合
    # 不一致时按位置盲改会静默列错位（concat 已按名对齐，多文件列序不同时更危险）
    print('原始文件列名：{}'.format(df.columns.tolist()[:10]))
    names = [str(c) for c in df.columns]
    if names == list(data_cols):
        pass
    elif (set(names) & set(data_cols)) and not all(re.match(r'_col\d+$', n) for n in names):
        print('[warn] 文件列名真实但与表列不完全一致，跳过按位置重命名（缺列/列序交由下游校验）')
    elif len(df.columns) == len(data_cols):
        df.columns = data_cols
    elif len(df.columns) == len(all_cols):
        df.columns = all_cols
    else:
        print("[warn] 列数不一致：文件 {} 列，表非分区字段 {} 列（全字段 {} 列），跳过重命名".format(
            len(df.columns), len(data_cols), len(all_cols)))
    return df


# ---------- 下载 ----------
def hdfs_download(hdfs_path, work_dir):
    """下载到 work_dir 下的**唯一子目录**（get_<pid>_<uuid>/<basename>）。

    HDFS 路径末段常是分区名（dt=20260720），不同表的同名分区在共享 work_dir 下会互相
    覆盖/误删；唯一子目录同时保证并发安全。调用方清理时删除该子目录（local_dir 的父目录）。
    """
    os.makedirs(work_dir, exist_ok=True)
    sub = os.path.join(work_dir, 'get_{}_{}'.format(os.getpid(), uuid.uuid4().hex[:8]))
    os.makedirs(sub)
    local_dir = os.path.join(sub, hdfs_path.rstrip('/').split('/')[-1])
    print("hadoop fs -get {} {}".format(hdfs_path, sub))
    ret = subprocess.run(['hadoop', 'fs', '-get', hdfs_path, sub])
    if ret.returncode != 0:
        shutil.rmtree(sub, ignore_errors=True)
        raise RuntimeError("hadoop fs -get 失败 (exit={}): {}".format(ret.returncode, hdfs_path))
    if not os.path.isdir(local_dir):
        shutil.rmtree(sub, ignore_errors=True)
        raise RuntimeError("下载完成但未找到本地目录: {}".format(local_dir))
    print("get from hdfs done")
    return local_dir


def collect_data_files(local_dir):
    """递归收集数据文件（分区表 get 下来带子目录），跳过 _SUCCESS/.crc/隐藏文件"""
    data_files = []
    for root, dirs, files in os.walk(local_dir):
        dirs[:] = [d for d in dirs if not d.startswith(('_', '.'))]
        for fn in files:
            if fn.startswith(('_', '.')) or fn.lower().endswith('.crc'):
                continue
            data_files.append(os.path.join(root, fn))
    return sorted(data_files)


def spark_sql_extract(spark, table, where, partitions, want_cols, output, fmt, use_float32=False):
    """--where 路径：用 SparkSession SELECT...WHERE... 直接写出，跳过 hadoop fs -get 整分区下载。

    适合从多活动/大分区表里按条件抽小子集（如单活动、列裁剪），下载量从整分区降到命中量。
    Spark 写 parquet 产出的是目录（pd.read_parquet 可读）；csv 带 header。
    decimal 统一转 double（与流式模式约定一致，避免 pandas 读回 object/Decimal）；
    --float32 时 double/decimal 降为 float。
    """
    # 列裁剪：安全起见用反引号包列名
    if want_cols:
        cols_sql = ", ".join("`{}`".format(c) for c in want_cols)
    else:
        cols_sql = "*"
    cond_parts = []
    if where:
        cond_parts.append("({})".format(where))
    for k, v in partitions:
        cond_parts.append("{}='{}'".format(k, v.replace("'", "''")))
    cond = " AND ".join(cond_parts) if cond_parts else "1=1"
    q = "SELECT {} FROM {} WHERE {}".format(cols_sql, table, cond)
    print("[where] Spark SQL: {}".format(q[:300]))
    df = spark.sql(q)
    # decimal → double（--float32 时连同 double 一起降 float），与流式模式 dtype 约定一致
    from pyspark.sql import functions as F
    from pyspark.sql.types import DecimalType, DoubleType, NullType
    casts = {}
    null_cols = []
    for f in df.schema.fields:
        if isinstance(f.dataType, DecimalType):
            casts[f.name] = 'float' if use_float32 else 'double'
        elif use_float32 and isinstance(f.dataType, DoubleType):
            casts[f.name] = 'float'
        elif isinstance(f.dataType, NullType):
            # 建表时 SELECT NULL AS xxx 会留下 void 类型列：读/count 都正常，
            # 写 parquet 直接炸（Unsupported data type）。统一转 string 落 null。
            casts[f.name] = 'string'
            null_cols.append(f.name)
    if casts:
        df = df.select([F.col(c).cast(casts[c]).alias(c) if c in casts else F.col(c)
                        for c in df.columns])
        print("[where] 类型统一: {} 列 decimal/double → {}".format(
            len(casts), 'float32' if use_float32 else 'double'))
    if null_cols:
        print("[where] void(全NULL)列已转 string: {}".format(", ".join(null_cols[:8])))
    n = df.count()
    print("[where] 命中行数: {:,}  列数: {}".format(n, len(df.columns)))
    if n == 0:
        raise RuntimeError("[where] WHERE 条件未命中任何行（{}），不写出空文件；"
                           "请检查条件与 --partition".format(cond[:200]))
    # 本地路径在 viewfs defaultFS 下要加 file://，否则被当 HDFS 路径
    out = output
    if "://" not in out:
        out = "file://" + os.path.abspath(out)
    print("[where] 写出: {}".format(out))
    # 老 Hive 数据常见 0001-01-01 / 0000-00-00 这类哨兵日期，Spark3 默认
    # datetimeRebaseModeInWrite=EXCEPTION：读和 count 都好好的，一写 parquet 就
    # 逐行抛错，栈全在 ParquetWriteSupport（2026-08-03 hebo 表 pull 实证）。
    # LEGACY = 按旧历法重写，行为与老 Hive 一致；int96 同理。
    spark.conf.set("spark.sql.parquet.datetimeRebaseModeInWrite", "LEGACY")
    spark.conf.set("spark.sql.parquet.int96RebaseModeInWrite", "LEGACY")
    # 按命中行数自适应写出文件数:小结果单文件方便;大结果多文件避免单 task 写出慢/压垮
    # executor(输出是目录,pd.read_parquet 目录读取不受文件数影响)
    nparts = 1 if n <= 2_000_000 else min(16, (n - 1) // 2_000_000 + 1)
    if nparts > 1:
        print("[where] 命中行数较大,分 {} 个文件写出".format(nparts))
    # fix15(2026-08-03):repartition 而非 coalesce。coalesce 是窄依赖,nparts=1 时会把
    # 上游扫描整个塌缩进 1 个 task 单核串行 —— 未分区大表实测 23GB 全列扫 30 分钟
    # 0 产出,被 1800s 超时杀掉(job_20260803_171733,activity 1000177)。repartition
    # 带 shuffle:扫描按源文件 split 并行(分区表下配合谓词剪裁只扫本活动分区),
    # 只有写出是 nparts 个 task;输出文件数与原来完全一致,消费侧无感。
    # count() 保留不动:它还承担"0 行命中不写空文件"的保护,且列裁剪+分区剪裁下秒级。
    w = df.repartition(nparts).write.mode("overwrite")
    if fmt == "parquet":
        w.option("compression", "zstd").parquet(out)
    else:
        w.option("header", "true").csv(out)
    print("[where] save finish: {}".format(out))
    return n


def main():
    conf = load_conf()
    parser = argparse.ArgumentParser(description='Hive/HDFS 表数据下载到本地 parquet/csv')
    parser.add_argument('--table', required=True, help='Hive 表名，如 tmp_dm.tmp_ctj_xxx')
    parser.add_argument('--hdfs-path', default=None,
                        help='HDFS 路径（默认从 metastore 取 location，失败回退 /ns-dcbi/tmp/{表名}）')
    parser.add_argument('--partition', action='append', default=[], metavar='K=V',
                        help='分区过滤，如 --partition dt=20260720，可重复指定多级分区')
    parser.add_argument('--columns', default=None,
                        help='只取部分列，逗号分隔，如 --columns memberid,label,o_c1')
    parser.add_argument('--where', default=None,
                        help='Spark SQL WHERE 过滤（绕过整分区下载）：如 --where "activity_id=\'562499\'"。'
                             '走 SparkSession SELECT...WHERE... 直接写出，不经过 hadoop fs -get；'
                             '与 --partition 叠加（分区过滤 AND 到 where 后），与 --columns 叠加（列裁剪）。')
    parser.add_argument('--output', default=None,
                        help='输出文件路径（默认 {output_dir}/{今天}_{表名}.parquet）')
    parser.add_argument('--format', choices=['parquet', 'csv'], default='parquet')
    parser.add_argument('--float32', action='store_true',
                        help='流式模式下 double/decimal 统一降为 float32（省一半空间，高精度金额列慎用）')
    parser.add_argument('--in-memory', action='store_true',
                        help='旧版全内存模式：concat 后 reduce_mem（数据相关 downcast + category），大表勿用')
    parser.add_argument('--no-reduce-mem', action='store_true',
                        help='仅 --in-memory 模式有效：跳过降内存，保留原始 dtype')
    parser.add_argument('--work-dir', default=conf.get('work_dir', './_hdfs_get_tmp'),
                        help='HDFS 文件落地临时目录（实际下载到其中的唯一子目录，并发安全）')
    parser.add_argument('--keep-work-dir', action='store_true', help='保留临时目录不清理')
    parser.add_argument('--skip-bad-files', action='store_true',
                        help='个别数据文件读取失败时跳过并继续（默认整体报错，防止静默缺数据）')
    args = parser.parse_args()

    partitions = []
    for p in args.partition:
        if '=' not in p:
            parser.error('--partition 格式必须是 K=V，收到: {}'.format(p))
        k, v = p.split('=', 1)
        partitions.append((k.strip(), v.strip()))

    tbl_base = args.table.split('.')[-1]
    output = args.output
    if output is None:
        dt = datetime.datetime.now().strftime('%Y%m%d')
        out_dir = conf.get('output_dir', './dataset')
        output = os.path.join(out_dir, '{}_{}.{}'.format(dt, tbl_base, args.format))
    os.makedirs(os.path.dirname(os.path.abspath(output)), exist_ok=True)

    spark = build_spark()
    all_cols, part_cols, hive_types, location = get_table_meta(spark, args.table)
    data_cols = [c for c in all_cols if c not in part_cols]
    print('表字段 {} 个，分区字段: {}，location: {}'.format(len(all_cols), part_cols, location))

    want_cols = None
    if args.columns:
        want_cols = [c.strip() for c in args.columns.split(',') if c.strip()]
        unknown = [c for c in want_cols if c not in all_cols]
        if unknown:
            parser.error('--columns 中以下列不在表 {} 中: {}'.format(args.table, unknown))

    # --where 路径：SparkSession SELECT...WHERE 直接写出，跳过 hadoop fs -get 整分区下载
    if args.where:
        if args.in_memory:
            parser.error('--where 与 --in-memory 不兼容（--where 走 Spark SQL 直接写出，'
                         '不经过本地合并/reduce_mem）')
        spark_sql_extract(spark, args.table, args.where, partitions, want_cols, output,
                          args.format, use_float32=args.float32)
        print('save finish:', output)
        spark.stop()
        return

    hdfs_path = args.hdfs_path or location or '/ns-dcbi/tmp/{}'.format(tbl_base)
    if not args.hdfs_path and not location:
        print('[warn] metastore 未解析到表 location，回退约定路径 {}；'
              '若该路径存在同名残留数据会被误拉，请核对或显式 --hdfs-path'.format(hdfs_path))
    for k, v in partitions:
        hdfs_path = hdfs_path.rstrip('/') + '/{}={}'.format(k, v)
    print('HDFS 路径: {}'.format(hdfs_path))

    local_dir = hdfs_download(hdfs_path, args.work_dir)
    try:
        files = collect_data_files(local_dir)
        print('数据文件 {} 个'.format(len(files)))

        if args.in_memory:
            df = load_merge_in_memory(files, local_dir, data_cols, all_cols,
                                      allow_skip=args.skip_bad_files)
            for k, v in partitions:
                if k not in df.columns:
                    df[k] = v
            if want_cols:
                missing = [c for c in want_cols if c not in df.columns]
                if missing:
                    raise RuntimeError('--columns 中以下列合并后不存在: {}'.format(missing))
                df = df[want_cols]
            df = cast_decimal_cols(df)
            if not args.no_reduce_mem:
                df = reduce_mem(df)
            check_dtype_drift(df, hive_types)
            print('data shape: {}'.format(df.shape))
            df.info()
            if args.format == 'parquet':
                df.to_parquet(output, engine='pyarrow', compression='zstd', index=False)
            else:
                df.to_csv(output, index=False, encoding='utf-8')
            del df
            gc.collect()
        else:
            # 流式模式：输出列 = --columns 指定列，或 全部数据列+分区列（分区值从参数/路径目录找回）
            ordered_cols = want_cols if want_cols else data_cols + part_cols
            total = stream_merge_save(files, local_dir, partitions, data_cols, all_cols, want_cols,
                                      ordered_cols, hive_types, output, args.format, args.float32,
                                      allow_skip=args.skip_bad_files)
            print('data rows: {:,}，columns: {}'.format(total, len(ordered_cols)))

        print('save finish:', output)
    finally:
        # 中途异常也清理下载目录（大表几十 GB 不能靠人想起来删）；唯一子目录 = local_dir 的父目录
        if args.keep_work_dir:
            print('[keep-work-dir] 保留下载目录: {}'.format(local_dir))
        else:
            shutil.rmtree(os.path.dirname(local_dir), ignore_errors=True)
            try:
                os.rmdir(args.work_dir)
            except OSError:
                pass


if __name__ == '__main__':
    main()
