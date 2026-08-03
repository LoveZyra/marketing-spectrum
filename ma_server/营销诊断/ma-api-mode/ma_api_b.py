#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
营销诊断 API —— 方案 B:全程 Claude Code

  一次 claude -p,把整条链路(读数 → 诊断 → 圈人 → 出报告)整个交给模型自己跑。
  服务侧只做四件事:校验入参、限时、把过程记进任务日志、按契约收结果。

和方案 C 的分工差别只有一句话:C 是"代码编排、模型润色",B 是"模型编排、代码收口"。
HTTP 出入参两边完全一致(都由 ma_core 提供),所以同一套回归脚本可以直接压 B,
出参也能逐字段和 C 对比 —— 这正是分成两个文件的意义。

服务侧对 B 的三条硬约束(不靠提示词,靠代码):

  1) 契约由服务保证。模型写出来的 result.json 只是原料:推送规则按 finding_id 前缀
     重新筛一遍(和 C 用的是同一个 pick_push_rules),push_sql 用同一个 build_push_sql
     重新生成,三条口径说明缺了就补。模型漏写、写错、写多,出参形状都不会变。
  2) 结果从文件读,不从 stdout 猜。stdout 只作兜底。
  3) 不给 --allow-dangerously-skip-permissions。B 确实需要工具权限(它得跑 skill、写文件),
     但用 --allowedTools 点名给,而不是一把全开。工作目录锁死在这一单的 rundir 里。

代价照实说:B 的错误码只能是粗粒度的 E_LLM_FAILED / E_LLM_TIMEOUT —— 模型在哪一步崩的,
服务侧无从分辨,只能把 stdout 尾巴附在 detail 里。这就是 C 存在的理由。

环境变量(除 ma_core / ma_pipeline 那些之外)
  MA_B_TIMEOUT     一次 claude -p 的超时秒数,默认 1500
  MA_B_TOOLS       --allowedTools 的值,默认 Bash,Read,Write,Edit,Glob,Grep
  MA_B_PROMPT      自定义提示词模板文件;不给就用本文件内置的
  MA_B_MAX_TURNS   传给 --max-turns;默认不传
"""

import json
import os
import shutil
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

import threading

import ma_core
import ma_pipeline
from ma_core import (CLAUDE_BIN, JobError, STORE, call_claude, extract_json,
                     looks_like_auth_problem, probe_cli, serve)
from ma_pipeline import build_push_sql, pick_push_rules, publish_html, resolve_runtime

MODE = "B"

B_TIMEOUT = ma_core._env_int("MA_B_TIMEOUT", 1500)
B_TOOLS = os.environ.get("MA_B_TOOLS", "Bash,Read,Write,Edit,Glob,Grep")
B_PROMPT_FILE = os.environ.get("MA_B_PROMPT")
B_MAX_TURNS = os.environ.get("MA_B_MAX_TURNS")

# B 一单就是十几分钟、满负荷烧 token,并行两单在轻量机上只会互相拖慢。
# 没显式设 MA_MAX_CONCURRENCY 就默认串行 —— 这是方案文档对 B 的建议。
if not os.environ.get("MA_MAX_CONCURRENCY"):
    ma_core.MAX_CONCURRENCY = 1
    ma_core._SEM = threading.Semaphore(1)


# --------------------------------------------------------------------------- 提示词

PROMPT_TEMPLATE = """你要为一个营销活动做一次完整的投放前诊断,并产出两样东西:
一份 HTML 诊断报告,和一份"这次该推给谁"的人群规则 JSON。

这是无人值守的自动化调用,没有人会回答你的问题。遇到拿不准的地方,按下面的口径自己定,
并把不确定的部分写进 result.json 的 notes 里,不要停下来等确认。

## 你的工作目录

{rundir}

所有产物都写在这个目录下,用相对路径。不要写到别的地方去。

## 输入数据

{data_desc}

## 可用工具

{skill_desc}

## 活动参数

  activity_id : {activity_id}
  date        : {date}
  push_source : {push_source}     # model=只用模型结论圈人 / rule=只用规则 / both=都要
  campaign_type: {campaign_type}

## 必须遵守的口径(这几条会被服务侧校验,写错会被改回去)

1. 这个接口只输出"需要推送"的人群。要排除的人群不进出参,也不做任何表写入 ——
   一行 insert / create table 都不要执行。
2. **只把 direction="push" 的人群规则放进 crowd_spec.rules。**
   direction="exclude" 的规则一条都不要放进去,也不要把它们 OR 进 push_sql,
   更不要拿它们对推送人群做 AND NOT 反向过滤 —— 排除人群在这个接口里就是不存在。
   这一条最容易错:排除规则的覆盖面往往极大(有的能盖住九成样本),
   一旦混进 push_sql,出参圈出来的就基本全是"诊断结论说别推"的那批人。
3. 每条规则的 population_size 之间是互相重叠的,不能相加。权威人数只有一个:
   size.push,即所有推送规则取并集、按主键去重之后的人数。
4. 人群池里主键不唯一,取数必须按主键去重;一个主键可能对应多个 unionid,
   保留哪一条是不确定的,unionid 不能当主键用。
5. 规则分"模型产出"还是"规则产出",只看 finding_id 前缀,不看 direction:
     fnd_model_*         → 模型产出
     fnd_r* / fnd_pos_*  → 规则产出
   这是和第 2 条正交的另一个轴:前缀决定归谁,direction 决定推不推,两个都要满足。
   push_source 就是按这个前缀来筛的。finding_id 照抄 skill 给的原值,
   **不要自己编**;skill 没给 finding_id 的规则就是不参与圈人,不要为了让它通过而补一个。
6. 每条参与圈人的规则都必须有能直接执行的 sql_filter(SQL 的 WHERE 片段),
   并且 source 字段照抄 skill 的原值。只有 source="audience_segment" 的才圈人;
   source="diagnostic_rule" 的是诊断发现,不是投放包,**不要把它改写成 audience_segment**。
7. sql_filter 里只能引用输入数据里真实存在的列名。写之前先确认列名对得上。

## 产出

**A. diagnosis_report.html** —— 写在工作目录下,文件名就叫这个。
   一份能直接给业务看的诊断报告:数据概览、关键发现、每个发现对应的人群与建议动作。
   不要留任何 "[待润色]" 之类的占位符。

**B. result.json** —— 写在工作目录下,文件名就叫这个,严格按这个形状:

```json
{{
  "activity_id": "{activity_id}",
  "date": "{date}",
  "report_url": null,
  "crowd_spec": {{
    "version": "1.0",
    "placeholder": false,
    "activity_id": "{activity_id}",
    "push_source": "{push_source}",
    "source_table": "数据来源的表名或文件名",
    "dedup_key": "去重主键的列名",
    "dedup_strategy": "min_unionid",
    "columns": ["主键列", "unionid 列"],
    "push_sql": "把所有推送规则并起来、按主键去重的取数 SQL",
    "sql": "对应的计数 SQL",
    "rules": [
      {{
        "name": "规则名",
        "direction": "push",
        "finding_id": "fnd_model_01",
        "source": "audience_segment",
        "sql_filter": "col_a >= 3 AND col_b > 0",
        "population_size": 1234,
        "basis": "这条规则是怎么来的,阈值取自哪里"
      }}
    ],
    "dropped_rules": [],
    "size": {{"push": 5678}},
    "notes": ["你想补充的说明"]
  }},
  "size": {{"push": 5678}},
  "data_overview": {{"rows": 0, "columns": 0}}
}}
```

  - population_size:这条规则单独命中多少人(去重后)。
  - size.push:所有推送规则并集、去重后的人数。它必须小于等于各条 population_size 之和。
  - 人数要真算,别估。数据就在工作目录里,用 python / duckdb / sqlite 跑一遍。
  - report_url 留 null,服务侧会填。

## 最后

干完之后,在最后一行只打印一个 JSON,不要有别的内容:

{{"ok": true, "activity_id": "{activity_id}", "size_push": <人数>, "rules": <推送规则条数>}}

如果哪一步没干成,把这一行打成 {{"ok": false, "reason": "……"}},并且照样把
result.json 写出来(能填多少填多少),不要什么都不留。
"""


def build_prompt(params, rundir, staged):
    data, skill = resolve_runtime()

    if staged.get("csv"):
        data_desc = (
            "工作目录下的 population.csv 就是人群池,一行一个人。\n"
            "  原始文件:{}\n"
            "  大小:{} 字节\n"
            "  列名是中文的,先读表头确认,再写 sql_filter。\n"
            "  这份数据是本次的唯一数据源,不要去连 Hive,这台机器上连不了。"
        ).format(staged["csv_origin"], staged["csv_bytes"])
    elif data == "hive":
        data_desc = (
            "人群池表:{}\n  特征表:{}\n"
            "  取数用 {}(hdfs-data skill)。只读,不要写任何表。"
        ).format(ma_pipeline.POP_TABLE, ma_pipeline.FEAT_TABLE, ma_pipeline.HDFS_GET)
    else:
        data_desc = ("工作目录下的 population.csv 是合成的测试数据(不是真实人群),"
                     "形状对齐即可,人数不具业务含义。")

    if skill == "skill" and os.path.exists(ma_pipeline.MA_CLI):
        skill_desc = (
            "机器上已经装好了 marketing-audit skill:{}\n"
            "  先跑 `python3 {} --help` 看它有哪些子命令,能用它就用它,\n"
            "  它产出的 state / crowd_rules 形状和离线流程是一致的。\n"
            "  它跑不通的步骤,你自己用 python 补上,不要卡住。"
        ).format(ma_pipeline.MA_CLI, ma_pipeline.MA_CLI)
    else:
        skill_desc = "没有现成的 skill 可用,整条链路你自己用 python 实现。"

    tmpl = PROMPT_TEMPLATE
    if B_PROMPT_FILE and os.path.exists(B_PROMPT_FILE):
        with open(B_PROMPT_FILE, encoding="utf-8") as f:
            tmpl = f.read()

    return tmpl.format(
        rundir=rundir,
        data_desc=data_desc,
        skill_desc=skill_desc,
        activity_id=params["activity_id"],
        date=params.get("date") or "今天",
        push_source=params.get("push_source") or "model",
        campaign_type=params.get("campaign_type") or "未指定",
    )


# --------------------------------------------------------------------------- 输入落地


def stage_inputs(job_id, rundir):
    """把模型需要的原料放进它的工作目录。

    这不是"帮它做诊断",只是把料递到它手边:工作目录锁死在 rundir,
    模型就不需要去读目录外的绝对路径,也就不会撞上工具权限。
    """
    data, _ = resolve_runtime()
    staged = {}
    if data == "csv":
        src = ma_pipeline.CSV_PATH
        if not os.path.exists(src):
            raise JobError("E_CSV_NOT_FOUND", "找不到数据文件:{}".format(src))
        dst = os.path.join(rundir, "population.csv")
        shutil.copyfile(src, dst)
        staged = {"csv": dst, "csv_origin": src, "csv_bytes": os.path.getsize(dst)}
        STORE.append_log(job_id, "已把 {} 拷进工作目录({} 字节)".format(
            os.path.basename(src), staged["csv_bytes"]))
    elif data == "synth":
        rows = ma_pipeline.gen_rows(job_id)
        dst = os.path.join(rundir, "population.csv")
        ma_pipeline.write_rows_csv(dst, rows)
        staged = {"csv": dst, "csv_origin": "synth", "csv_bytes": os.path.getsize(dst)}
        STORE.append_log(job_id, "已生成合成数据 {} 行".format(len(rows)))
    return staged


# --------------------------------------------------------------------------- 收口


MUST_NOTES = [
    ("不做任何表写入", "本接口只输出需要推送的人群,排除人群不在出参内,也不做任何表写入"),
    ("不可相加", "population_size 之间互相重叠,不可相加;权威人数以 size.push 为准"),
    ("去重", "{id} 在样本池中不唯一,取数必须按 {id} 去重"),
    ("不可作主键", "一个 {id} 命中多个 {un} 时保留哪一条是不确定的,{un} 不可作主键"),
]


def _as_list(v):
    return v if isinstance(v, list) else []


def normalize_result(raw, params, rundir, staged, repairs):
    """模型写的 result.json → 接口契约。缺什么补什么,错什么改什么,改了都记进 repairs。

    这里刻意用和方案 C 同一套 pick_push_rules / build_push_sql:
    两个方案的 push_sql 生成规则必须逐字一致,否则拿它们做对比就没有意义了。
    """
    if not isinstance(raw, dict):
        raw = {}
    spec = raw.get("crowd_spec")
    if not isinstance(spec, dict):
        spec = {}
        repairs.append("模型没给出 crowd_spec,按空规则集收口")

    data, skill = resolve_runtime()
    # 和方案 C 同一套口径:SQL 的 FROM 永远写人群池表(可直接拿去生产跑),
    # 人数实际算在哪份数据上另用 data_source 说明。
    sql_table = ma_pipeline.POP_TABLE
    # data_source 的写法必须和方案 C 的 BaseSource.label 逐字一致(csv:/路径、synth:memory、表名),
    # 否则同一份数据在 B 和 C 的出参里长得不一样,两个方案就没法逐字段对比了。
    origin = staged.get("csv_origin")
    if data == "csv" and origin:
        data_source = "csv:{}".format(origin)
    elif data == "hive":
        data_source = ma_pipeline.POP_TABLE
    else:
        data_source = "synth:memory"

    id_col = str(spec.get("dedup_key") or os.environ.get("MA_ID_COL") or "mapid")
    cols = spec.get("columns")
    union_col = None
    if isinstance(cols, list) and len(cols) > 1:
        union_col = str(cols[1])
    union_col = union_col or os.environ.get("MA_UNION_COL") or "unionid"

    # 规则:按口径重新筛一遍,不看模型自己挑成什么样
    rules_in = _as_list(spec.get("rules"))
    for r in rules_in:
        if isinstance(r, dict) and not r.get("source"):
            r["source"] = "audience_segment"
    segs, picked, excluded, fixes = pick_push_rules(
        [r for r in rules_in if isinstance(r, dict)],
        params.get("push_source") or "model")
    repairs.extend(fixes)
    if excluded:
        repairs.append("模型给的规则里有 {} 条 direction=exclude,已挡在推送包外"
                       "(见 excluded_rules)".format(len(excluded)))
    dropped = _as_list(spec.get("dropped_rules"))
    # 已经进了 excluded_rules 的不要再记一遍 dropped_rules,两个字段语义不同:
    # excluded = 方向不对,本来就不该推;dropped = 想推但这条规则不合格。
    ex_keys = {(e.get("name"), e.get("finding_id")) for e in excluded}
    for r in rules_in:
        if not isinstance(r, dict) or any(r is p for p in picked):
            continue
        if (r.get("name"), r.get("finding_id")) in ex_keys:
            continue
        dropped.append({"name": r.get("name"), "finding_id": r.get("finding_id"),
                        "reason": "不符合 push_source={} 的口径(按 finding_id 前缀筛)或缺 sql_filter".format(
                            params.get("push_source") or "model")})
    if len(picked) != len(rules_in):
        repairs.append("模型给了 {} 条规则,按口径筛出 {} 条参与推送".format(len(rules_in), len(picked)))

    push_sql, count_sql = build_push_sql(picked, table=sql_table,
                                         id_col=id_col, union_col=union_col)
    model_sql = spec.get("push_sql")
    if model_sql and model_sql != push_sql:
        spec["model_push_sql"] = model_sql
        repairs.append("模型自己写的 push_sql 与统一生成的不一致,已换成统一版本(原文留在 model_push_sql)")

    size = spec.get("size")
    push_size = None
    if isinstance(size, dict):
        push_size = size.get("push")
    if push_size is None and isinstance(raw.get("size"), dict):
        push_size = raw["size"].get("push")
    try:
        push_size = int(push_size) if push_size is not None else None
    except (TypeError, ValueError):
        repairs.append("模型给的 size.push 不是数字,置空")
        push_size = None
    if push_size is None and picked:
        repairs.append("模型没给出去重后的推送人数,size.push 为空(B 模式下服务侧不代算)")
    if not picked:
        push_size = None

    notes = [n for n in _as_list(spec.get("notes")) if isinstance(n, str)]
    for frag, tmpl in MUST_NOTES:
        text = tmpl.format(id=id_col, un=union_col)
        if not any(frag in n for n in notes):
            notes.append(text)
            repairs.append("补上口径说明:{}".format(frag))
    if not any("finding_id 前缀" in n for n in notes):
        notes.append("模型/规则的划分只看 finding_id 前缀(fnd_model_* vs fnd_r*/fnd_pos_*),"
                     "与离线流程一致;direction 是另一个轴,只决定推不推")
    if not any("direction=push" in n for n in notes):
        notes.append("只有 source=audience_segment 且 direction=push 的规则参与圈人;"
                     "排除规则既不圈人,也不用于对推送人群做反向过滤")
    if excluded:
        notes.append("有 {} 条 direction=exclude 的人群规则未参与推送"
                     "(只在 excluded_rules 里留名备查,不含 sql_filter,不计入 size.push)".format(
                         len(excluded)))
    if data == "csv":
        notes.insert(0, "⚠ 人数是在本地 CSV({}) 上算的,不是生产人群池;"
                        "push_sql 的 FROM 已按 {} 写好,但列名要和线上表对齐后才能直接跑".format(
                            os.path.basename(str(data_source)), sql_table))
    elif data == "synth":
        notes.insert(0, "⚠ 人群池是本地合成的假数据,人数与 SQL 结果不可用于生产决策")
    if not picked:
        notes.append("本次没有任何可用的推送规则,push_sql 与 size.push 均为空")

    spec.update({
        "version": "1.0",
        "placeholder": False,
        "activity_id": params["activity_id"],
        "push_source": params.get("push_source") or "model",
        "source_table": sql_table,
        "data_source": data_source,
        "dedup_key": id_col,
        "dedup_strategy": "min_unionid",
        "columns": [id_col] if union_col == id_col else [id_col, union_col],
        "push_sql": push_sql,
        "sql": count_sql,
        "rules": [dict(r, crowd="push") for r in picked],
        "dropped_rules": dropped,
        "excluded_rules": excluded,
        "size": {"push": push_size},
        "notes": notes,
    })

    return {
        "activity_id": params["activity_id"],
        "date": params.get("date"),
        "mode": MODE,
        "runtime": ma_pipeline.RUNTIME,
        "backend": {"data": data, "steps": skill, "source": data_source,
                    "orchestrator": "claude"},
        "degraded": False,
        "report_url": None,
        "crowd_spec": spec,
        "size": {"push": push_size},
        "data_overview": raw.get("data_overview"),
        "artifacts": {"rundir": rundir},
    }


def _read_result_json(job_id, rundir, call, repairs):
    """先读文件,读不到再从 stdout 抠。两条都空才算这一单失败。"""
    p = os.path.join(rundir, "result.json")
    if os.path.exists(p):
        try:
            with open(p, encoding="utf-8") as f:
                raw = json.load(f)
            STORE.append_log(job_id, "读到模型写的 result.json")
            return raw
        except ValueError as exc:
            repairs.append("result.json 不是合法 JSON({}),改从 stdout 兜底".format(exc))
            STORE.append_log(job_id, "result.json 解析失败:{}".format(exc))

    parsed = extract_json(call.get("stdout") or "")
    if isinstance(parsed, dict) and parsed.get("crowd_spec"):
        repairs.append("模型没落地 result.json,结果是从 stdout 里抠出来的")
        return parsed
    return None


# --------------------------------------------------------------------------- runner


def runner(job_id, params):
    rundir = STORE.rundir(job_id)
    version = probe_cli(job_id)
    repairs = []

    staged = stage_inputs(job_id, rundir)

    prompt = build_prompt(params, rundir, staged)
    with open(os.path.join(rundir, "full_flow_prompt.md"), "w", encoding="utf-8") as f:
        f.write(prompt)

    argv = [CLAUDE_BIN, "-p", prompt, "--allowedTools", B_TOOLS]
    if B_MAX_TURNS:
        argv += ["--max-turns", str(B_MAX_TURNS)]

    STORE.update(job_id, phase="llm_full_flow")
    STORE.append_log(job_id, "方案 B:一次 claude -p 跑完整条链路,提示词 {} 字,超时 {}s,工具 {}".format(
        len(prompt), B_TIMEOUT, B_TOOLS))

    call = call_claude(argv, B_TIMEOUT, cwd=rundir)
    STORE.append_log(job_id, "claude 返回 exit={} 耗时 {}s".format(
        call.get("exit_code"), call.get("elapsed_sec")))
    with open(os.path.join(rundir, "llm_stdout.txt"), "w", encoding="utf-8") as f:
        f.write(call.get("stdout") or "")
    for line in (call.get("stdout") or "").strip().splitlines()[-15:]:
        STORE.append_log(job_id, "  | " + line[:300])

    auth_hint = looks_like_auth_problem(call)
    if call.get("exit_code") == 0:
        authed = True
    elif auth_hint:
        authed = False
    else:
        authed = None                      # 非零退出但不像鉴权问题,不下断言
    cli = {"bin": CLAUDE_BIN, "version": version, "invoked": True, "calls": 1,
           "authenticated": authed,
           "auth_hint": auth_hint, "exit_code": call.get("exit_code"),
           "elapsed_sec": call.get("elapsed_sec"), "timed_out": call.get("timed_out"),
           "stdout_head": (call.get("stdout") or "")[:300]}

    if call.get("timed_out"):
        raise JobError("E_LLM_TIMEOUT", "模型跑满 {}s 还没结束,这一单作废".format(B_TIMEOUT),
                       {"elapsed_sec": call.get("elapsed_sec"), "stderr": call.get("stderr")})

    STORE.update(job_id, phase="collect")
    raw = _read_result_json(job_id, rundir, call, repairs)
    if raw is None:
        # B 的粒度只能到这儿:模型在哪一步崩的,服务侧看不出来
        raise JobError("E_LLM_FAILED",
                       "模型没产出可用结果(既没有 result.json,stdout 里也抠不出 crowd_spec)",
                       {"exit_code": call.get("exit_code"),
                        "auth_hint": auth_hint,
                        "stdout_tail": (call.get("stdout") or "")[-2000:],
                        "stderr_tail": (call.get("stderr") or "")[-1000:]})

    result = normalize_result(raw, params, rundir, staged, repairs)
    result["cli"] = cli
    result["contract_repairs"] = repairs

    warnings = []
    html = os.path.join(rundir, "diagnosis_report.html")
    if os.path.exists(html):
        ctx = ma_pipeline.Ctx(params, rundir, log=lambda s: STORE.append_log(job_id, s))
        result["report_url"] = publish_html(ctx, html)
        result["artifacts"]["report_html"] = "diagnosis_report.html"
        warnings.extend(ctx.warnings)
    else:
        warnings.append("模型没产出 diagnosis_report.html,本次没有报告链接")
        result["degraded"] = True

    if call.get("exit_code") not in (0, None):
        warnings.append("claude 非零退出(exit={}),结果按已落地的产物收口".format(call.get("exit_code")))
        result["degraded"] = True
    if auth_hint:
        result["degraded"] = True
        result["auth_hint"] = auth_hint
        msg = "Claude Code CLI 未鉴权(命中「{}」):B 模式下模型就是编排者,没鉴权等于整条链路没跑".format(auth_hint)
        warnings.append(msg)
        result["crowd_spec"]["notes"].append(msg)
    # 契约收口本身不算降级 —— 它恰恰是 B 能给出稳定出参的原因,但要留痕
    warnings.extend("契约收口:" + r for r in repairs)

    result["warnings"] = warnings
    return result


# --------------------------------------------------------------------------- 探活


def extra_health():
    data, skill = resolve_runtime()
    info = {
        "runtime": ma_pipeline.RUNTIME,
        "backend": {"data": data, "steps": skill, "orchestrator": "claude"},
        "llm_timeout": B_TIMEOUT,
        "allowed_tools": B_TOOLS,
        "public_dir": ma_pipeline.PUBLIC_DIR,
        "public_dir_exists": os.path.isdir(ma_pipeline.PUBLIC_DIR),
        "url_base": ma_pipeline.URL_BASE,
        "prompt_override": B_PROMPT_FILE or None,
    }
    if data == "csv":
        p = ma_pipeline.CSV_PATH
        exists = os.path.exists(p)
        info["csv"] = {"path": p, "exists": exists,
                       "bytes": os.path.getsize(p) if exists else None}
    if skill == "skill":
        info["skill_cli"] = {"path": ma_pipeline.MA_CLI,
                             "exists": os.path.exists(ma_pipeline.MA_CLI)}
    # 与方案 C 同一份体检(check_env 在 ma_pipeline 里,两个方案共用),口径必须一致 ——
    # 否则同一台机器上 B 说环境没问题、C 说有问题,谁都不知道该信哪个。
    info["env_check"] = {
        "on_ma_server": ma_pipeline.ON_MA_SERVER,
        "allow_bad_env": ma_pipeline.ALLOW_BAD_ENV,
        "fatal": list(ma_pipeline.ENV_FATAL),
        "warn": list(ma_pipeline.ENV_WARN),
    }
    return info


# --------------------------------------------------------------------------- 入口


def main():
    if "--print-prompt" in sys.argv:
        params = {"activity_id": "demo_activity", "date": None, "push_source": "model",
                  "campaign_type": None}
        staged = {}
        if resolve_runtime()[0] == "csv" and os.path.exists(ma_pipeline.CSV_PATH):
            staged = {"csv": "population.csv", "csv_origin": ma_pipeline.CSV_PATH,
                      "csv_bytes": os.path.getsize(ma_pipeline.CSV_PATH)}
        print(build_prompt(params, "<rundir>", staged))
        return

    if "--check" in sys.argv:
        payload = {"mode": MODE, "claude_bin": CLAUDE_BIN, "auth": bool(ma_core.API_KEY),
                   "max_concurrency": ma_core.MAX_CONCURRENCY,
                   "listen": "{}:{}".format(ma_core.HOST, ma_core.PORT)}
        payload.update(extra_health())
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        for line in ma_pipeline.format_env_report(ma_pipeline.ENV_FATAL, ma_pipeline.ENV_WARN):
            sys.stderr.write(line + "\n")
        sys.exit(2 if (ma_pipeline.ENV_FATAL and not ma_pipeline.ALLOW_BAD_ENV) else 0)

    if not ma_pipeline.env_gate():
        sys.exit(2)

    data, skill = resolve_runtime()
    banner = [
        "方案 B:一次 claude -p 跑完整条链路,服务侧只做校验/限时/收口",
        "工具白名单:{}(不开 --allow-dangerously-skip-permissions)".format(B_TOOLS),
        "单次超时 {}s / 并发 {}".format(B_TIMEOUT, ma_core.MAX_CONCURRENCY),
        "数据源:{}".format(ma_pipeline.CSV_PATH if data == "csv" else ma_pipeline.POP_TABLE),
        "机器识别:{}".format("ma_server(存在 {})".format(ma_pipeline._MA_SERVER_MARK)
                             if ma_pipeline.ON_MA_SERVER else "非 ma_server"),
    ] + ma_pipeline.format_env_report(ma_pipeline.ENV_FATAL, ma_pipeline.ENV_WARN)
    serve(MODE, runner, extra_health=extra_health, banner=banner)


if __name__ == "__main__":
    main()
