#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""报告收尾 driver:润色完成后一键 self_critique → render → 发布 HTML → 幂等补 report 表 url。

用法:
    python3 finalize_one_activity.py <activity_id> --dt 20260727 [--task-id ...]

前置: runs/<aid>/state_full.json 已润色完成(_stage="full",无 [待润色])。
⚠ --dt 必须与 run_one_activity.py 写 org_json 用的分区一致,否则会新建行而不是补 url
  (write_report_row 发现无现有行时会打印警告)。

报告阶段 5 步里只有"润色"需要 Agent/人工,其余 4 步(质检/渲染/发布/补url)本脚本全自动。
"""
import argparse
import datetime
import json
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pipeline_common import get_spark, run, setup_run_log, write_report_row  # noqa: E402

MA_SKILL = "/home/jovyan/.claude/skills/marketing-audit"
MA_CLI = os.path.join(MA_SKILL, "cli.py")
RUN_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "runs")
REPORT_TABLE = "tmp_dm.tmp_ctj_sy_report"
# Friday pod 公开目录与对应外网地址(/html-files/ 路径已坏不用)
DEF_PUBLIC_DIR = "/home/jovyan/prism/public"
DEF_URL_BASE = "https://friday_deployment_14540_algo_agent.gw.friday.17usoft.com"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("activity_id")
    ap.add_argument("--dt", default=datetime.datetime.now().strftime("%Y%m%d"),
                    help="report 表分区,必须与 driver 跑批时的 --dt 一致")
    ap.add_argument("--task-id", default=None, help="默认=activity_id")
    ap.add_argument("--report-table", default=REPORT_TABLE)
    ap.add_argument("--public-dir", default=DEF_PUBLIC_DIR,
                    help="HTML 发布目录(Friday pod 公开目录)")
    ap.add_argument("--url-base", default=DEF_URL_BASE)
    ap.add_argument("--hdfs-backup-dir", default=None,
                    help="可选:HTML 同时备份到 HDFS 目录(hadoop fs -put -f;public 目录随 pod 重建会丢)")
    ap.add_argument("--skip-critique", action="store_true", help="跳过 self_critique 质检")
    ap.add_argument("--skip-render", action="store_true",
                    help="diagnosis_report.html 已存在且无需重渲染时跳过 render")
    ap.add_argument("--force", action="store_true", help="state_full 仍有 [待润色] 时强制继续")
    args = ap.parse_args()
    aid = args.activity_id
    task_id = args.task_id or aid
    rundir = os.path.join(RUN_ROOT, aid)
    if not os.path.isdir(rundir):
        raise SystemExit("运行目录不存在: {}(先跑 run_one_activity.py)".format(rundir))
    setup_run_log(rundir)
    sf = os.path.join(rundir, "state_full.json")

    print("=" * 60)
    print("活动 {}  报告收尾  task_id={}  dt={}".format(aid, task_id, args.dt))
    print("=" * 60)

    # ── Step 1: 前置校验 ──
    print("\n[1/5] 校验 state_full.json")
    if not os.path.exists(sf):
        raise SystemExit("缺 {}:请先润色 state_draft.json 另存为 state_full.json".format(sf))
    with open(sf, encoding="utf-8") as f:
        raw = f.read()
    state = json.loads(raw)
    if state.get("_stage") != "full":
        raise SystemExit("state_full._stage={!r},应为 'full':润色未完成".format(state.get("_stage")))
    n_pending = raw.count("[待润色]")
    if n_pending:
        msg = "state_full.json 仍有 {} 处 [待润色]".format(n_pending)
        if args.force:
            print("  ⚠ {},--force 继续".format(msg))
        else:
            raise SystemExit(msg + "(润色完再跑,或 --force 强制)")
    print("  ✓ _stage=full,无 [待润色]")

    # ── Step 2: self_critique(可选质检)──
    print("\n[2/5] self_critique" + ("(跳过)" if args.skip_critique else ""))
    if not args.skip_critique:
        run(["python3", MA_CLI, "run-tools", "--tools", "self_critique",
             "--state", sf, "--out", rundir])

    # ── Step 3: render ──
    html = os.path.join(rundir, "diagnosis_report.html")
    print("\n[3/5] render" + ("(跳过)" if args.skip_render and os.path.exists(html) else ""))
    if not (args.skip_render and os.path.exists(html)):
        run(["python3", MA_CLI, "render", "--state", sf, "--out", rundir])
    if not os.path.exists(html):
        raise SystemExit("render 未产出 {}".format(html))

    # ── Step 4: 发布 HTML(+ 可选 HDFS 备份)──
    pub_name = "diagnosis-report-{}.html".format(aid)
    url = args.url_base.rstrip("/") + "/" + pub_name
    print("\n[4/5] 发布 HTML → {}/{}".format(args.public_dir, pub_name))
    shutil.copyfile(html, os.path.join(args.public_dir, pub_name))
    with open(os.path.join(rundir, "report_url.txt"), "w", encoding="utf-8") as f:
        f.write(url + "\n")
    if args.hdfs_backup_dir:
        d = args.hdfs_backup_dir.rstrip("/")
        run(["hadoop", "fs", "-mkdir", "-p", d])
        run(["hadoop", "fs", "-put", "-f", html, d + "/" + pub_name])
        print("  ✓ HDFS 备份: {}/{}".format(d, pub_name))
    else:
        print("  ℹ 未传 --hdfs-backup-dir:public 目录随 pod 重建会丢,重要报告建议备份")

    # ── Step 5: 幂等补 report 表 url(保留 org_json)──
    print("\n[5/5] 补 {} url(保留 org_json)".format(args.report_table))
    spark = get_spark("repurl_{}".format(task_id))
    write_report_row(spark, args.report_table, args.dt, task_id, url=url)  # org_json 保留现值
    spark.stop()

    print("\n" + "=" * 60)
    print("✅ 报告收尾完成")
    print("   URL: {}".format(url))
    print("   (也写入 {}/report_url.txt)".format(rundir))
    print("=" * 60)


if __name__ == "__main__":
    main()
