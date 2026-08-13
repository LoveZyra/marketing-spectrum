#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
通过 pyspark SparkSession.sql() 直接执行 SELECT，DataFrame 直写本地 parquet。

xxx.sql 里只放一条 SELECT（或 WITH ... SELECT）查询语句：本脚本读取它、
执行、把结果以本地 parquet 目录的形式写出。

不再走 spark-sql CLI 的 CTAS（CREATE TABLE ... AS SELECT）路径：CTAS 会命中
InsertIntoHiveTable -> SessionState.setupAuth() 向 Waggle Dance 联邦 metastore
请求 delegation token，这台机器上该调用直接抛 NullPointerException（已用
spark-sql -f 分别测试 SELECT / 纯 CREATE TABLE / CTAS 三种语句定位，前两者
都成功，只有 CTAS 失败）。纯查询 + Spark 原生 write.parquet 完全不经过这条
Hive 写入鉴权路径，不需要建 Hive 临时表，也不需要 hadoop fs -get + orc 转
parquet 这一圈。

用法（必须带 PYSPARK_PYTHON 环境变量前缀，否则 worker 找不到 python —— 当前
环境 PYSPARK_PYTHON 默认是集群相对路径 python3env/pyspark/bin/python，本地
没有该目录）：

    PYSPARK_PYTHON=/opt/conda/envs/pyspark/bin/python \
    PYSPARK_DRIVER_PYTHON=/opt/conda/envs/pyspark/bin/python \
    spark-submit onesql.py -f=xxx.sql

    # 指定输出目录（默认 {当前工作目录}/onesql_{requestid}）
    PYSPARK_PYTHON=/opt/conda/envs/pyspark/bin/python \
    PYSPARK_DRIVER_PYTHON=/opt/conda/envs/pyspark/bin/python \
    spark-submit onesql.py -f=xxx.sql --output-dir ./out
"""
from __future__ import annotations

import argparse
import datetime
import os
import random
import sys
from typing import List, Optional

from pyspark.sql import SparkSession


def generate_requestid() -> str:
    timestamp = datetime.datetime.now().strftime("%Y%m%d%H%M%S")
    suffix = f"{random.randint(0, 99_999):05d}"
    return f"{timestamp}_{suffix}"


def read_sql_file(path: str) -> str:
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def validate_select(sql: str) -> None:
    """xxx.sql 里必须是一条 SELECT（或 WITH ... SELECT）。"""
    stripped = sql.strip().lstrip(";").strip().lower()
    if not (stripped.startswith("select") or stripped.startswith("with")):
        preview = sql.strip().splitlines()[0] if sql.strip() else "<empty>"
        raise ValueError(
            f"SQL 文件里必须是 SELECT（或 WITH ... SELECT）。Got: {preview[:80]!r}"
        )


def build_spark():
    # 参考 test.py：这台机器上 spark-submit 实测可用的 SparkSession 配置。
    # 不用 findspark（conda 环境没装，且 spark-submit 已把 pyspark 配进 PYTHONPATH）。
    return SparkSession.builder.appName("onesql") \
        .config("hive.metastore.local", "false") \
        .config("hive.exec.dynamic.partition", "true") \
        .config("hive.exec.dynamic.partition.mode", "nonstrict") \
        .config("spark.io.compression.codec", "snappy") \
        .config("spark.sql.execution.arrow.enabled", "true") \
        .config("spark.sql.execution.arrow.pyspark.enabled", "true") \
        .enableHiveSupport() \
        .getOrCreate()


def sanitize_types(spark, df):
    """decimal -> double，void(全 NULL) -> string。

    decimal 落 pandas 后是 object/Decimal，读回来很麻烦，统一转 double；
    void 列（如 SELECT NULL AS x）Spark 能 count 但写 parquet 会直接报
    Unsupported data type，须提前转 string。
    """
    from pyspark.sql import functions as F
    from pyspark.sql.types import DecimalType, NullType

    casts = {}
    null_cols = []
    for f in df.schema.fields:
        if isinstance(f.dataType, DecimalType):
            casts[f.name] = "double"
        elif isinstance(f.dataType, NullType):
            casts[f.name] = "string"
            null_cols.append(f.name)
    if casts:
        df = df.select([
            F.col(c).cast(casts[c]).alias(c) if c in casts else F.col(c)
            for c in df.columns
        ])
        print("[cast] {} 列 decimal -> double".format(
            len([c for c in casts if c not in null_cols])))
    if null_cols:
        print("[cast] void(全NULL)列已转 string: {}".format(", ".join(null_cols[:8])))
    return df


def write_local_parquet(spark, df, output_dir: str) -> int:
    """DataFrame 直写本地 parquet 目录（Spark 原生 write，不经过 Hive 写入路径）。

    本地路径在 viewfs defaultFS 下要加 file:// 前缀，否则会被当成 HDFS 路径。
    """
    n = df.count()
    print("行数: {:,}  列数: {}".format(n, len(df.columns)))
    if n == 0:
        raise RuntimeError("查询未命中任何行，不写出空文件")

    out = output_dir
    if "://" not in out:
        out = "file://" + os.path.abspath(out)

    # 老 Hive 数据常见的哨兵日期（0001-01-01 等）在 Spark3 默认
    # datetimeRebaseModeInWrite=EXCEPTION 下逐行报错，LEGACY 按旧历法写，
    # 行为与老 Hive 一致。
    spark.conf.set("spark.sql.parquet.datetimeRebaseModeInWrite", "LEGACY")
    spark.conf.set("spark.sql.parquet.int96RebaseModeInWrite", "LEGACY")

    nparts = 1 if n <= 2_000_000 else min(16, (n - 1) // 2_000_000 + 1)
    if nparts > 1:
        print("行数较大，分 {} 个文件写出".format(nparts))
    df.repartition(nparts).write.mode("overwrite") \
        .option("compression", "zstd").parquet(out)
    print("写出完成: {}".format(output_dir))
    return n


def run(sql: str, output_dir: str, show: int = 100) -> int:
    validate_select(sql)
    spark = build_spark()
    try:
        df = spark.sql(sql.strip().rstrip(";"))
        df = sanitize_types(spark, df)
        os.makedirs(output_dir, exist_ok=True)
        n = write_local_parquet(spark, df, output_dir)
        if show > 0:
            # 读回刚写出的本地 parquet 打印预览：COUNT/小聚合时这就是完整答案，
            # 大结果集时是前 N 行样例（完整数据在 parquet 目录里）。读本地文件很便宜，
            # 不会对原 SELECT 造成额外全表扫描。
            read_path = output_dir if "://" in output_dir else "file://" + output_dir
            print("=== 结果预览（前{}行）===".format(show))
            spark.read.parquet(read_path).show(show, truncate=False)
        return n
    finally:
        spark.stop()


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="读取一个只含 SELECT 的 .sql 文件，执行并把结果写成本地 parquet 目录。")
    parser.add_argument(
        "-f", "--file", dest="file", required=True,
        help="只含一条 SELECT（或 WITH ... SELECT）的 .sql 文件路径。"
             "支持 -f=xxx.sql / -f xxx.sql / --file=xxx.sql 等写法。",
    )
    parser.add_argument(
        "--output-dir", default=None,
        help="parquet 输出目录（默认 {当前工作目录}/onesql_{requestid}）",
    )
    parser.add_argument(
        "--show", type=int, default=100,
        help="写出后打印前 N 行结果预览到 stdout（默认 100；0 = 只写 parquet 不预览）",
    )
    args = parser.parse_args(argv)

    if not os.path.isfile(args.file):
        print(f"SQL 文件不存在: {args.file}", file=sys.stderr)
        return 2

    output_dir = args.output_dir
    if output_dir is None:
        output_dir = os.path.join(os.getcwd(), f"onesql_{generate_requestid()}")
    output_dir = os.path.abspath(os.path.expanduser(output_dir))

    sql = read_sql_file(args.file)

    try:
        run(sql, output_dir, show=args.show)
    except ValueError as e:
        print(str(e), file=sys.stderr)
        return 2

    print(output_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
