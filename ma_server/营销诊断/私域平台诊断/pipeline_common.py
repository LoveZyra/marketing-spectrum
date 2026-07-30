#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""私域诊断 pipeline 公共工具:run_one_activity / finalize_one_activity 共用。

包含:运行日志 tee、子进程流式执行、Spark 会话、分区结构探测、
report 表幂等写(分区结构自适应:单级 dt / 二级 dt+task_id)。
"""
import datetime
import os
import subprocess
import sys

# write_report_row 的"保留现值"哨兵:url=KEEP 表示不改动表里已有 url
KEEP = object()


class Tee(object):
    """把写入同时转发到多个流(终端 + run.log)。单个流写失败不影响其他流。"""

    def __init__(self, *streams):
        self._streams = streams

    def write(self, s):
        for st in self._streams:
            try:
                st.write(s)
            except Exception:
                pass

    def flush(self):
        for st in self._streams:
            try:
                st.flush()
            except Exception:
                pass


def setup_run_log(rundir, name="run.log"):
    """stdout/stderr 同时写终端与 <rundir>/run.log(追加,带会话时间戳分隔)。

    子进程输出经 run() 流式并入;本进程内 Spark 的 JVM 日志仍走原生 stderr,
    只在终端可见(py4j 直写 fd,tee 不到,属预期)。
    """
    os.makedirs(rundir, exist_ok=True)
    path = os.path.join(rundir, name)
    f = open(path, "a", encoding="utf-8", errors="replace")
    f.write("\n===== {} | {} =====\n".format(
        datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"), " ".join(sys.argv)))
    sys.stdout = Tee(sys.__stdout__, f)
    sys.stderr = Tee(sys.__stderr__, f)
    return path


def run(cmd):
    """流式执行子进程,输出并入当前 stdout(经 Tee 落 run.log),失败抛异常。"""
    print("  $", " ".join(cmd[:6]), "..." if len(cmd) > 6 else "")
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         universal_newlines=True, errors="replace")
    for line in p.stdout:
        sys.stdout.write(line)
    p.stdout.close()
    ret = p.wait()
    if ret != 0:
        raise RuntimeError("命令失败 exit={}: {}".format(ret, " ".join(cmd)))


def get_spark(app_name):
    import findspark
    findspark.init()
    from pyspark.sql import SparkSession
    return SparkSession.builder.appName(app_name).enableHiveSupport().getOrCreate()


def partition_cols(spark, table):
    """解析 `desc <table>` 的 Partition Information 段,返回分区列名(小写)列表。

    环境 quirk:desc 偶发把 task_id 误显为 task_id_id(流程.md 有记),按前缀归一化。
    """
    rows = spark.sql("desc {}".format(table)).collect()
    cols, in_part = [], False
    for r in rows:
        name = (r["col_name"] or "").strip()
        if name.lower().startswith("# partition"):
            in_part = True
            continue
        if in_part:
            if not name or name.startswith("#"):
                continue
            c = name.lower()
            if c.startswith("task_id"):
                c = "task_id"
            cols.append(c)
    return cols


def sql_lit(v):
    """Python 值 → Spark SQL 字符串字面量(None → NULL;反斜杠先于单引号转义)。"""
    if v is None:
        return "NULL"
    return "'" + str(v).replace("\\", "\\\\").replace("'", "''") + "'"


def write_report_row(spark, table, dt, task_id, url=KEEP, org_json=KEEP):
    """幂等写 report 表一行 (task_id, url, org_json),未指定的字段保留表里现值。

    分区结构自适应:
      (dt, task_id) 二级分区 → 直接 OVERWRITE 本活动分区,无并发问题(推荐,迁移见 流程.md)
      (dt) 单级分区          → 方案1:读同分区其他 task_id UNION 本行再 OVERWRITE。
                               ⚠ 同分区多活动并发跑会互相丢数据;且依赖表为 text 格式
                               (orc/parquet 下 Spark 禁止自读自写)。
    """
    tid = int(task_id)
    cur = spark.sql("SELECT url, org_json FROM {t} WHERE dt='{dt}' AND task_id={tid}".format(
        t=table, dt=dt, tid=tid)).collect()
    if cur:
        print("  现有行: url={} org_json_len={}".format(
            cur[0]["url"], len(cur[0]["org_json"]) if cur[0]["org_json"] else 0))
    else:
        print("  ⚠ (dt={}, task_id={}) 无现有行,将新建。若期望是补字段,请确认 --dt 与 driver 跑批时一致".format(dt, tid))
    new_url = (cur[0]["url"] if cur else None) if url is KEEP else url
    new_oj = (cur[0]["org_json"] if cur else None) if org_json is KEEP else org_json

    pcols = partition_cols(spark, table)
    if pcols == ["dt", "task_id"]:
        spark.sql(
            "INSERT OVERWRITE TABLE {t} PARTITION(dt='{dt}', task_id={tid}) "
            "SELECT {u} AS url, {o} AS org_json".format(
                t=table, dt=dt, tid=tid, u=sql_lit(new_url), o=sql_lit(new_oj)))
    else:
        print("  ⚠ 单级分区幂等写(方案1):同分区多活动请勿并发跑(建议迁 (dt,task_id) 二级分区,见 流程.md)")
        spark.sql(
            "INSERT OVERWRITE TABLE {t} PARTITION(dt='{dt}') "
            "SELECT task_id, url, org_json FROM {t} WHERE dt='{dt}' AND task_id <> {tid} "
            "UNION ALL "
            "SELECT {tid} AS task_id, {u} AS url, {o} AS org_json".format(
                t=table, dt=dt, tid=tid, u=sql_lit(new_url), o=sql_lit(new_oj)))

    chk = spark.sql(
        "SELECT task_id, url, length(org_json) AS oj_len FROM {t} WHERE dt='{dt}' AND task_id={tid}".format(
            t=table, dt=dt, tid=tid)).collect()
    for x in chk:
        print("  回读: task_id={} url={} org_json_len={}".format(x["task_id"], x["url"], x["oj_len"]))
