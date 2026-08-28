#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
营销诊断 API —— 方案 C:驱动器 + Claude 混合

  取数 / 诊断 / 圈人 由确定性代码做(ma_pipeline.py),
  只有"报告润色"这一步调 claude -p。

为什么是这个切法:整条链路里真正需要模型的只有润色。其余每一步都是可复现的计算,
交给模型做只会引入抖动、拖长耗时、烧 token,还拿不到结构化的错误码。
所以 C 的错误是分步的(E_PULL_FAILED / E_PREPARE_FAILED / E_CROWD_RULES_FAILED …),
润色挂了也只是 degraded,报告照出、人群照圈 —— 这是 C 相对 B 最大的价值。

HTTP 出入参与 ma_api_b.py 完全一致(都由 ma_core 提供),两个方案可以用同一套
回归脚本压,出参也能逐字段对比。差别只在"谁来编排"。

  POST /api/ma/diagnose      下单,202 返回 job_id
  GET  /api/ma/jobs/{id}     看状态与日志尾巴
  GET  /api/ma/jobs/{id}/result  取结果(report_url + crowd_spec)
  GET  /healthz              探活,顺带自报当前后端

环境变量见 ma_core.py(服务侧)与 ma_pipeline.py(链路侧)的模块注释。
常用两条:
  MA_RUNTIME=csv MA_CSV=/home/ubuntu/特价机票-正式.csv   有 skill、没取数能力的机器
  MA_RUNTIME=real                                        ma_server 上的全真链路
"""

import json
import os
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

import ma_core
import ma_pipeline
from ma_core import (CLAUDE_BIN, JobError, STORE, call_claude, extract_json,
                     looks_like_auth_problem, probe_cli, serve)
from ma_pipeline import StepError, resolve_runtime, run_pipeline

MODE = "C"


# --------------------------------------------------------------------------- CLI 注入


def _make_cli(job_id, cli):
    """给 polish_state / run_report_agent 用的 call_cli。顺手把这次调用的结果记到
    cli 字典里,好让出参里的 cli 块是真实发生过的事,而不是启动时探测的快照。

    两种用法共用一个入口:
      · 润色(argv_extra=None):不给工具,模型只负责把空槽写实 —— 它拿不到工具也不需要;
      · 报告产出(argv_extra=["--allowedTools", ...], cwd=rundir):给点名的工具权限,
        让它自己去读 SKILL.md、自己跑 marketing-audit 的子命令。
    仍旧不传 --allow-dangerously-skip-permissions:要什么工具就点名什么,不一把全开。
    """

    def _call(prompt, timeout, argv_extra=None, cwd=None):
        agent = bool(argv_extra)
        # 子进程一律在固定目录里跑:Claude Code 按 cwd 建"项目",per-job 的 rundir
        # 当 cwd 会让 Prism 侧边栏每单多一个「run」项目。cwd 参数保留作任务上下文
        # (回归的假 CLI 靠它定位 rundir),真实进程的工作目录固定为 LLM_HOME。
        workdir = ma_pipeline.LLM_HOME
        try:
            os.makedirs(workdir, exist_ok=True)
        except OSError:
            workdir = cwd    # 建不出来就退回旧行为,别让整单死在这

        # 分模型:agent 全量活走强模型,润色/修复这类轻量文本调用走快模型。
        # 在这里注入而不是在流水线各处拼,是因为这儿本来就是"哪类调用"的分叉口。
        model = ma_pipeline.AGENT_MODEL if agent else ma_pipeline.POLISH_MODEL
        model_argv = ["--model", model] if model else []
        cli["invoked"] = True
        cli["calls"] += 1
        STORE.update(job_id, phase="report_agent_cli" if agent else "polish_cli")
        if agent:
            cli["agent_calls"] = cli.get("agent_calls", 0) + 1
            STORE.append_log(job_id, "claude -p 报告产出(带工具 {},model={}),提示词 {} 字,超时 {}s,"
                             "cwd={}(固定目录,会话统一归 llm_sessions 项目)"
                             .format(" ".join(argv_extra), model or "网关默认",
                                     len(prompt), timeout, workdir))
        else:
            STORE.append_log(job_id, "claude -p 润色(model={}),提示词 {} 字,超时 {}s".format(
                model or "网关默认", len(prompt), timeout))

        call = call_claude([CLAUDE_BIN, "-p", prompt] + model_argv + list(argv_extra or []),
                           timeout, cwd=workdir)
        cli["exit_code"] = call.get("exit_code")
        cli["timed_out"] = bool(call.get("timed_out"))
        if call.get("timed_out"):
            cli["timeouts"] = cli.get("timeouts", 0) + 1
        # 润色会分轮补漏,可能调好几次 —— 耗时要累加,不能被最后一次覆盖掉
        cli["elapsed_sec"] = round((cli.get("elapsed_sec") or 0)
                                   + (call.get("elapsed_sec") or 0), 2)
        cli["stdout_head"] = (call.get("stdout") or "")[:300]
        # 完整 stdout 已经落在 rundir 里,出参里只留个指路的
        cli["stdout_files"] = ("rundir/agent_stdout.txt、"
                               "rundir/polish_stdout_r<轮>_<批>.txt")
        STORE.append_log(job_id, "{} CLI 返回 exit={} 耗时 {}s{}".format(
            "报告产出" if agent else "润色", call.get("exit_code"), call.get("elapsed_sec"),
            "(超时被杀)" if call.get("timed_out") else ""))

        if call.get("exit_code") == 0:
            cli["authenticated"] = True
        else:
            hint = looks_like_auth_problem(call)
            if hint:
                cli["authenticated"] = False
                cli["auth_hint"] = hint
                STORE.append_log(job_id, "CLI 像是没鉴权(命中「{}」),这一步降级".format(hint))
            else:
                cli["authenticated"] = None
                cli["stderr_tail"] = (call.get("stderr") or "")[-300:]
                STORE.append_log(job_id, "CLI 非零退出但不像鉴权问题,按普通降级处理")
        return call

    # 给 run_report_agent 认的标记:没有它,流水线宁可跳过报告产出 Agent,
    # 也不会拿一个不带工具的调用去冒充「模型自己用了 skill」。
    _call.supports_tools = True
    return _call


# --------------------------------------------------------------------------- runner


def runner(job_id, params):
    """worker 线程真正干的活。异常语义:
       StepError → JobError(原样带错误码),其余异常由 ma_core._run_job 兜成 E_INTERNAL。"""
    rundir = STORE.rundir(job_id)
    version = probe_cli(job_id)          # CLI 都调不起就没必要往下跑,直接 E_CLI_NOT_AVAILABLE

    cli = {"bin": CLAUDE_BIN, "version": version, "invoked": False, "calls": 0,
           "authenticated": None, "auth_hint": None, "exit_code": None, "elapsed_sec": None,
           "timed_out": None, "timeouts": 0}

    data, skill = resolve_runtime()
    STORE.append_log(job_id, "方案 C:runtime={} 数据源={} 诊断步骤={}".format(
        ma_pipeline.RUNTIME, data, skill))

    try:
        result = run_pipeline(
            params, rundir,
            log=lambda s: STORE.append_log(job_id, s),
            set_phase=lambda p: STORE.update(job_id, phase=p),
            call_cli=_make_cli(job_id, cli),
            extract_json=extract_json,
            job_id=job_id,          # 报告发布文件名靠它做到一单一份
        )
    except StepError as exc:
        raise JobError(exc.code, exc.message, exc.detail)

    result["cli"] = cli
    warnings = result.setdefault("warnings", [])
    notes = (result.get("crowd_spec") or {}).get("notes")

    # 「链路通、鉴权缺」要能一眼看出来,而不是混在一堆 degraded 里
    if cli["authenticated"] is False:
        result["degraded"] = True
        result["auth_hint"] = cli["auth_hint"]
        msg = "Claude Code CLI 未鉴权(命中「{}」):除报告润色外,取数/诊断/圈人全部正常完成".format(
            cli["auth_hint"])
        warnings.append(msg)
        if isinstance(notes, list):
            notes.append(msg)
    elif cli["invoked"] and cli["authenticated"] is None:
        warnings.append("润色 CLI 非零退出(exit={}),但不像鉴权问题,报告可能仍含 [待润色]".format(
            cli["exit_code"]))

    return result


# --------------------------------------------------------------------------- 探活附加信息


def extra_health():
    """/healthz 里自报当前后端。部署到新机器上第一件事就是看这一段对不对。"""
    data, skill = resolve_runtime()
    info = {
        "runtime": ma_pipeline.RUNTIME,
        "push_source": ma_core.PUSH_SOURCE,   # 已从入参挪到服务端,healthz 里亮出来好核对
        "models": {"agent": ma_pipeline.AGENT_MODEL or "(网关默认)",
                   "polish": ma_pipeline.POLISH_MODEL or "(网关默认)"},
        "llm_home": ma_pipeline.LLM_HOME,   # claude 子进程固定工作目录(Prism 单项目)
        "backend": {"data": data, "steps": skill},
        "pop_table": ma_pipeline.POP_TABLE,
        "public_dir": ma_pipeline.PUBLIC_DIR,
        "public_dir_exists": os.path.isdir(ma_pipeline.PUBLIC_DIR),
        "url_base": ma_pipeline.URL_BASE,
        "polish_timeout": ma_pipeline.POLISH_TIMEOUT,
    }
    if data == "csv":
        p = ma_pipeline.CSV_PATH
        exists = os.path.exists(p)
        info["csv"] = {"path": p, "exists": exists,
                       "bytes": os.path.getsize(p) if exists else None,
                       "max_rows": ma_pipeline.CSV_MAX_ROWS}
    elif data == "hive":
        info["hive"] = {"feat_table": ma_pipeline.FEAT_TABLE,
                        "hdfs_get": ma_pipeline.HDFS_GET,
                        "hdfs_get_exists": os.path.exists(ma_pipeline.HDFS_GET)}
    if skill == "skill":
        info["skill_cli"] = {"path": ma_pipeline.MA_CLI,
                             "exists": os.path.exists(ma_pipeline.MA_CLI),
                             "strict": ma_pipeline.SKILL_STRICT}
    # 环境体检的结论。放进 /healthz 是因为"报告链接指着测试机"这种错在别处一点症状都没有:
    # 接口 200、报告也生成了,只是那个 URL 谁都打不开。探活里能直接看见,就不用等人来问。
    info["env_check"] = {
        "on_ma_server": ma_pipeline.ON_MA_SERVER,
        "allow_bad_env": ma_pipeline.ALLOW_BAD_ENV,
        "fatal": list(ma_pipeline.ENV_FATAL),
        "warn": list(ma_pipeline.ENV_WARN),
    }
    return info


# --------------------------------------------------------------------------- 入口


def main():
    if "--check" in sys.argv:
        # 不起服务,只把 healthz 会说的话打出来。服务器上没有 curl 也能自查。
        payload = {"mode": MODE, "claude_bin": CLAUDE_BIN,
                   "auth": bool(ma_core.API_KEY), "listen": "{}:{}".format(ma_core.HOST, ma_core.PORT)}
        payload.update(extra_health())
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        # --check 是给人看的自查,体检结论也顺手排版打一遍(退出码跟着体检走,
        # 好让 CI / 启动脚本能 `python3 ma_api_c.py --check || exit` 直接卡住)
        for line in ma_pipeline.format_env_report(ma_pipeline.ENV_FATAL, ma_pipeline.ENV_WARN):
            sys.stderr.write(line + "\n")
        sys.exit(2 if (ma_pipeline.ENV_FATAL and not ma_pipeline.ALLOW_BAD_ENV) else 0)

    # 环境闸门在起 HTTP 之前。宁可这里退出码 2,也不要起一个"每单都出死链"的服务。
    if not ma_pipeline.env_gate():
        sys.exit(2)

    data, skill = resolve_runtime()
    banner = [
        "方案 C:驱动器编排,只有润色调模型",
        "后端:数据源={} 诊断步骤={}(MA_RUNTIME={})".format(data, skill, ma_pipeline.RUNTIME),
        "模型:agent={} 润色/修复={}(MA_AGENT_MODEL / MA_POLISH_MODEL,空=网关默认)".format(
            ma_pipeline.AGENT_MODEL or "网关默认", ma_pipeline.POLISH_MODEL or "网关默认"),
        "人群池:{}".format(ma_pipeline.CSV_PATH if data == "csv" else ma_pipeline.POP_TABLE),
        "报告发布:{} → {}".format(ma_pipeline.PUBLIC_DIR, ma_pipeline.URL_BASE),
        "机器识别:{}".format("ma_server(存在 {})".format(ma_pipeline._MA_SERVER_MARK)
                             if ma_pipeline.ON_MA_SERVER else "非 ma_server"),
    ] + ma_pipeline.format_env_report(ma_pipeline.ENV_FATAL, ma_pipeline.ENV_WARN)
    serve(MODE, runner, extra_health=extra_health, banner=banner)


if __name__ == "__main__":
    main()
