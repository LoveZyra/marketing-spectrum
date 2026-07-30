#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""单活动私域营销诊断→人群抽取 driver(自动阶段)。

用法:
    python3 run_one_activity.py <activity_id> [--dt 20260727] [--task-id 562499]
                                [--pull-partition date=20260720]

自动跑完: 拉特征(hdfs_get --where) → prepare/compute-thresholds/draft →
cli crowd-rules(state_draft) → 人群表 dry-run 校验+抽 push/exclude → 幂等写 crowd_test →
写 report 表 org_json(口径=实际写入 crowd_test 的规则,url 留空)。

报告阶段: Agent/人工润色 state_draft→state_full 后,跑 finalize_one_activity.py
一键 self_critique → render → 发布 HTML → 幂等补 report 表 url(见 流程.md)。

幂等写法(分区结构自动探测):
  (dt, task_id) 二级分区 → 直接 OVERWRITE 本活动分区(推荐,无并发问题)
  (dt) 单级分区          → 方案1:保留同分区其他 task_id 再 OVERWRITE(同分区勿并发跑)
"""
import argparse
import datetime
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pipeline_common import get_spark, partition_cols, run, setup_run_log, write_report_row  # noqa: E402

MA_SKILL = "/home/jovyan/.claude/skills/marketing-audit"
MA_CLI = os.path.join(MA_SKILL, "cli.py")
HDFS_GET = "/home/jovyan/.claude/skills/hdfs-data/scripts/hdfs_get.py"

FEAT_TABLE = "tmp_dm.tmp_ctj_mktv2_feature_day_v2_sy"
POP_TABLE = "tmp_dm.tmp_ctj_mktv2_sy_sample"
CROWD_TABLE = "tmp_dm.tmp_ctj_sy_crowd_test"
REPORT_TABLE = "tmp_dm.tmp_ctj_sy_report"
RUN_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "runs")


def print_meta_summary(rundir):
    """prepare 后打印 auto-meta 推断结果,供人工复核(target_products 误判会连累 Rule 11 等)。"""
    sp = os.path.join(rundir, "state_partial.json")
    try:
        with open(sp, encoding="utf-8") as f:
            meta = (json.load(f).get("campaign_meta") or {})
    except Exception as e:
        print("  (meta 摘要读取失败: {})".format(e))
        return
    keys = ["campaign_name", "campaign_type", "target_products", "channel",
            "inferred_platform", "start_date", "end_date"]
    print("  ── auto-meta 推断结果(请复核)──")
    for k in keys:
        if meta.get(k) is not None:
            print("    {} = {}".format(k, meta[k]))
    print("  ⚠ 重点核对 target_products:activity_product_name 有时是页面名而非品类名,")
    print("    错了会使 Rule 11(跨品类推送错配)等全部误判;不对就 --meta 显式传入后重跑。")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("activity_id")
    ap.add_argument("--feat-table", default=FEAT_TABLE)
    ap.add_argument("--pop-table", default=POP_TABLE)
    ap.add_argument("--crowd-table", default=CROWD_TABLE)
    ap.add_argument("--report-table", default=REPORT_TABLE)
    ap.add_argument("--dt", default=datetime.datetime.now().strftime("%Y%m%d"))
    ap.add_argument("--task-id", default=None, help="默认=activity_id")
    ap.add_argument("--meta", default='{"campaign_type":"社群进群"}')
    ap.add_argument("--filter-col", default="task_id",
                    help="特征表按哪列过滤拉取(默认 task_id 新版特征表;旧版用 activity_id)")
    ap.add_argument("--pull-partition", action="append", default=[], metavar="K=V",
                    help="拉取时的分区裁剪(透传 hdfs_get --partition,可重复)。特征表按 date 分区,"
                         "已知活动日期时强烈建议传,避免全分区扫描,如 --pull-partition date=20260720")
    ap.add_argument("--push-source", choices=["model", "rule", "both"], default="model",
                    help="建议推送人群来源(均来自 audience_segment): model=只模型输出seg(fnd_model_*,默认); rule=只规则产出seg(fnd_rN/fnd_pos_*); both=两者")
    ap.add_argument("--exclude-source", choices=["model", "rule", "both"], default="both",
                    help="建议排除人群来源(均来自 audience_segment): model=只模型输出; rule=只规则产出; both=规则+模型(默认)")
    ap.add_argument("--skip-pull", action="store_true", help="data.parquet 已存在则跳过拉取")
    args = ap.parse_args()
    aid = args.activity_id
    task_id = args.task_id or aid
    rundir = os.path.join(RUN_ROOT, aid)
    os.makedirs(rundir, exist_ok=True)
    setup_run_log(rundir)
    data_path = os.path.join(rundir, "data.parquet")

    print("=" * 60)
    print("活动 {}  诊断→人群抽取  task_id={}  dt={}".format(aid, task_id, args.dt))
    print("=" * 60)

    # ── Step 1: 拉特征(hdfs_get --where,绕过整分区下载)──
    print("\n[1/7] 拉取活动特征数据 → {}".format(data_path))
    if args.skip_pull and os.path.exists(data_path):
        print("  skip_pull: data.parquet 已存在,跳过")
    else:
        cmd = ["python3", HDFS_GET, "--table", args.feat_table,
               "--where", "{}='{}'".format(args.filter_col, aid),
               "--output", data_path]
        for p in args.pull_partition:
            cmd += ["--partition", p]
        if not args.pull_partition:
            print("  ℹ 未传 --pull-partition,将按 {} 全分区扫描;已知活动日期时建议传 date=... 裁剪".format(args.filter_col))
        run(cmd)

    # ── Step 2-4: prepare / compute-thresholds / draft ──
    print("\n[2/7] prepare")
    run(["python3", MA_CLI, "prepare",
         "--data", data_path, "--meta", args.meta, "--auto-meta", "--out", rundir])
    print_meta_summary(rundir)
    sp = os.path.join(rundir, "state_partial.json")
    print("\n[3/7] compute-thresholds")
    run(["python3", MA_CLI, "compute-thresholds",
         "--data", data_path, "--state", sp, "--out", rundir])
    print("\n[4/7] draft")
    run(["python3", MA_CLI, "draft", "--state", sp, "--out", rundir])
    sd = os.path.join(rundir, "state_draft.json")

    # ── Step 5: crowd_rules(cli 子命令,从 state_draft,无需 polish/render)──
    print("\n[5/7] 构建 crowd_rules(cli crowd-rules,从 state_draft)")
    run(["python3", MA_CLI, "crowd-rules", "--state", sd, "--out", rundir])
    cr_path = os.path.join(rundir, "crowd_rules.json")
    with open(cr_path, encoding="utf-8") as f:
        rules = json.load(f)
    # 人群只从 audience_segment 产出(不用 diagnostic_rule);按 finding_id 分模型/规则
    # fnd_model_* = 模型输出(model_interpreter/lightgbm); fnd_rN + fnd_pos_* = 规则产出(diagnostic_rules agent,其中 fnd_pos 是正向阈值 finding)
    # 注意:direction(push/exclude)不决定模型/规则,只按 finding_id 分
    segs = [r for r in rules if r.get("source") == "audience_segment" and r.get("sql_filter")]

    def _by_fid(rs, kind):
        if kind == "model":
            return [r for r in rs if (r.get("finding_id") or "").startswith("fnd_model")]
        if kind == "rule":
            return [r for r in rs if (r.get("finding_id") or "").startswith(("fnd_r", "fnd_pos"))]
        return rs

    push = _by_fid(segs, args.push_source)     # 默认 model
    excl = _by_fid(segs, args.exclude_source)  # 默认 both(规则+模型)
    print("  crowd_rules 共 {} 条, audience_segment seg {} 条: 候选 push({})={}, excl({})={}".format(
        len(rules), len(segs), args.push_source, len(push), args.exclude_source, len(excl)))

    # ── Step 6: 人群表校验+抽取 + 幂等写 crowd_test ──
    print("\n[6/7] 抽取 push/exclude 人群 + 写 {}".format(args.crowd_table))
    push_ok, excl_ok, stats = write_crowds(
        args.pop_table, args.crowd_table, push, excl, task_id, args.dt)

    # ── Step 7: 写 report 表 org_json(口径=Step 6 实际写入的规则;url 留空待 finalize 补)──
    print("\n[7/7] 写 {} org_json(实际应用的人群规则),url 待 finalize 补".format(args.report_table))
    # org_json = rules 数组(每条加 crowd 标签 push/exclude),无 wrapper;
    # 只含通过 dry-run 校验、真正参与写 crowd_test 的规则,并带人群表实际命中数 population_size
    org_rules = ([dict(r, crowd="push") for r in push_ok]
                 + [dict(r, crowd="exclude") for r in excl_ok])
    oj = json.dumps(org_rules, ensure_ascii=False, separators=(",", ":"))
    spark = get_spark("reporg_{}".format(task_id))
    write_report_row(spark, args.report_table, args.dt, task_id, org_json=oj)  # url 保留现值
    spark.stop()

    # 汇总落盘(下游/审计看总量不用翻日志)
    summary = dict(stats, activity_id=aid, task_id=str(task_id), dt=args.dt,
                   push_rules=[r.get("name") for r in push_ok],
                   exclude_rules=[r.get("name") for r in excl_ok])
    with open(os.path.join(rundir, "crowd_summary.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    print("\n" + "=" * 60)
    print("✅ 自动阶段完成:人群 + org_json 已入库。产物目录: {}".format(rundir))
    print("   crowd_rules.json / crowd_summary.json / state_draft.json / run.log")
    print("\n📌 报告阶段(仅润色需 Agent/人工,其余已自动化):")
    print("   1. 润色 state_draft.json → state_full.json(填 [待润色]、删 _draft、_stage=full、")
    print("      headline≤60;方法见 marketing-audit SKILL.md 第 6 步与 methodology/03..08)")
    print("   2. python3 {}/finalize_one_activity.py {} --dt {}".format(
        os.path.dirname(os.path.abspath(__file__)), aid, args.dt))
    print("      (自动 self_critique → render → 发布 HTML → 幂等补 report 表 url)")
    print("=" * 60)


def write_crowds(pop_table, crowd_table, push_rules, excl_rules, task_id, dt):
    """人群抽取与落库。返回 (push_ok, excl_ok, stats):

    push_ok/excl_ok = 通过人群表 dry-run 校验、实际参与写入的规则(供 org_json 保持口径一致),
    每条已补 population_size(人群表实际命中数)。
    """
    from pyspark.sql import functions as F
    spark = get_spark("crowd_{}".format(task_id))
    spark.conf.set("spark.sql.shuffle.partitions", "64")

    # dry-run 校验:LIMIT 0 只走 analyzer,缺列/语法错误一次拿到;单条失败只跳过该条,
    # 不会让 pred() 的 OR 大谓词整体失败
    def usable(rules_):
        ok, dropped = [], []
        for r in rules_:
            try:
                spark.sql("SELECT 1 FROM {} WHERE ({}) LIMIT 0".format(pop_table, r["sql_filter"]))
                ok.append(r)
            except Exception as e:
                dropped.append((r.get("name"), str(e).splitlines()[0][:200]))
        return ok, dropped

    push_ok, push_drop = usable(push_rules)
    excl_ok, excl_drop = usable(excl_rules)
    for nm, why in push_drop + excl_drop:
        print("  ⚠ 跳过规则 {}: {}".format(nm, why))
    print("  可用 push 规则 {} 条, exclude 规则 {} 条".format(len(push_ok), len(excl_ok)))

    # 每条规则在人群表上的实际命中数:一趟聚合(model seg 同对象出现在 push+excl,只算一次)
    uniq, seen = [], set()
    for r in push_ok + excl_ok:
        if id(r) not in seen:
            seen.add(id(r))
            uniq.append(r)
    if uniq:
        agg = ", ".join("SUM(CASE WHEN ({}) THEN 1 ELSE 0 END) AS c{}".format(r["sql_filter"], i)
                        for i, r in enumerate(uniq))
        row = spark.sql("SELECT {} FROM {}".format(agg, pop_table)).collect()[0]
        for i, r in enumerate(uniq):
            r["population_size"] = int(row["c{}".format(i)] or 0)
            print("  规则命中(人群表): {} → {:,}".format(r.get("name"), r["population_size"]))

    def pred(rules_):
        return " OR ".join("({})".format(r["sql_filter"]) for r in rules_) if rules_ else "1=0"

    df = spark.table(pop_table)
    push_df = (df.filter(pred(push_ok)).select("mapid", "unionid")
               .dropDuplicates(["mapid"]).cache()) if push_ok else None
    excl_df = (df.filter(pred(excl_ok)).select("mapid", "unionid")
               .dropDuplicates(["mapid"]).cache()) if excl_ok else None

    push_n = push_df.count() if push_df is not None else 0
    if push_df is not None and excl_df is not None:
        excl_only = excl_df.join(push_df, "mapid", "left_anti")
    else:
        excl_only = excl_df
    excl_n = excl_df.count() if excl_df is not None else 0
    excl_only_n = excl_only.count() if excl_only is not None else 0
    print("  push(去重mapid)={}  excl(去重)={}  重叠(归push)={}  excl_only={}".format(
        push_n, excl_n, excl_n - excl_only_n, excl_only_n))
    print("  >>> 写入总行数 = {}".format(push_n + excl_only_n))

    stats = {"push_n": push_n, "excl_n": excl_n,
             "overlap_to_push": excl_n - excl_only_n, "excl_only_n": excl_only_n,
             "dropped_rules": [{"name": nm, "reason": why} for nm, why in push_drop + excl_drop]}

    parts = []
    if push_df is not None:
        parts.append(push_df.withColumn("is_pull", F.lit("1")))
    if excl_only is not None and excl_only_n > 0:
        parts.append(excl_only.withColumn("is_pull", F.lit("0")))
    if not parts:
        print("  ⚠ 无人群可写(保留表中既有数据不动)")
        spark.stop()
        return push_ok, excl_ok, stats
    out = parts[0]
    for p in parts[1:]:
        out = out.unionByName(p)
    out = out.withColumn("task_id", F.lit(int(task_id))) \
             .select("task_id", "mapid", "unionid", "is_pull")
    out.createOrReplaceTempView("crowd_out")

    # 幂等写:分区结构自适应
    pcols = partition_cols(spark, crowd_table)
    stats["partition_mode"] = "+".join(pcols) or "none"
    if pcols == ["dt", "task_id"]:
        spark.sql(
            "INSERT OVERWRITE TABLE {ct} PARTITION(dt='{dt}', task_id={tid}) "
            "SELECT mapid, unionid, is_pull FROM crowd_out".format(
                ct=crowd_table, dt=dt, tid=int(task_id)))
        print("  ✅ 写入完成(二级分区,直接覆盖本活动分区)")
    else:
        # 方案1: OVERWRITE 分区 + 保留同分区其他 task_id。
        # ⚠ 同分区多活动并发跑会互相丢数据;且依赖表为 text 格式(orc/parquet 下 Spark 禁止自读自写)。
        #   建议迁 (dt, task_id) 二级分区,见 流程.md
        print("  ⚠ 单级分区幂等写(方案1):同分区多活动请勿并发跑")
        spark.sql(
            "INSERT OVERWRITE TABLE {ct} PARTITION(dt='{dt}') "
            "SELECT task_id, mapid, unionid, is_pull FROM {ct} WHERE dt='{dt}' AND task_id <> {tid} "
            "UNION ALL "
            "SELECT task_id, mapid, unionid, is_pull FROM crowd_out".format(
                ct=crowd_table, dt=dt, tid=int(task_id)))
        print("  ✅ 写入完成(幂等:保留同分区其他 task_id)")

    # 回读校验
    chk = spark.sql(
        "select is_pull, count(*) c from {ct} where dt='{dt}' and task_id={tid} group by is_pull".format(
            ct=crowd_table, dt=dt, tid=int(task_id))).collect()
    for r in chk:
        print("  回读: is_pull={} → {:,}".format(r["is_pull"], r["c"]))
    spark.stop()
    return push_ok, excl_ok, stats


if __name__ == "__main__":
    main()
