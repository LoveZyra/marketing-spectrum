"""marketing_audit_skill CLI — 四子命令稳定工程入口。

设计原则
========
CLI 只固化"可重复的工程动作"，不替代宿主 Agent 的业务判断和动态调度：

  prepare           读数据 → data_overview → 6 个 domain snippet
                    → state_partial.json（所有 LLM 步骤留空）

  compute-thresholds 读数据 → 按 CVR 计算每个特征的数据驱动阈值
                    → state["adaptive_thresholds"] + thresholds_report.md
                    必须在 prepare 之后、Agent 分析之前运行

  draft             从 compute-thresholds 产物自动装配 state_full 骨架
                    （findings/segments/narratives+typical_case/actions）
                    → state_draft.json；覆盖全部 effective 主题组、过 completeness。
                    宿主 Agent 只需润色 [待润色] 文案并置 _stage=full

  run-tools         以 state_partial 为入参，重跑指定确定性工具

  render            拿 state_full.json（Agent 补完 LLM 步骤后）→ schema 校验 → 落盘三件套

用法
====
    python -m marketing_audit_skill.cli prepare \\
        --data 测试数据.csv --meta meta.json --out ./out

    python -m marketing_audit_skill.cli compute-thresholds \\
        --data 测试数据.csv --state ./out/state_partial.json --out ./out

    python -m marketing_audit_skill.cli render \\
        --state ./out/state_full.json --out ./out

    python -m marketing_audit_skill.cli doctor    # 环境自检

详细 manifest 与方法论请阅读 TOOLS_MANIFEST.json + methodology/00_overview.md。
"""
from __future__ import annotations

import argparse
import importlib
import json
import sys
import time
from pathlib import Path
from typing import Any


# ── 公共工具 ──────────────────────────────────────────────────────────


def _load_dataframe(path: Path) -> "Any":
    """支持 .csv / .parquet，自动尝试 GBK/UTF-8。

    fix16-a(2026-08-03)：parquet 改走 pyarrow 直读 + to_pandas(self_destruct)。
    老读法 pd.read_parquet 在转换期会同时持有 Arrow 表和 pandas 帧两份内存 ——
    千万行×250 列实测稳态 ~60G、转换峰值 ~116G，在 128G 容器里被 OOM killer
    SIGKILL（job_20260803_214025，activity 1000344，两次均死于装载阶段）。
    self_destruct=True 让转换逐列释放 Arrow 缓冲，峰值 ≈ 稳态；split_blocks=True
    避免同 dtype 大块合并的额外拷贝。返回的仍是普通 numpy dtype 的 DataFrame，
    下游 snippets 无感。任何异常回退老读法，行为不会比现状更坏。
    """
    import pandas as pd
    if path.suffix.lower() in (".parquet", ".pq"):
        try:
            import pyarrow as pa
            import pyarrow.parquet as pq
            # fix16-a2:换系统分配器。arrow 默认 jemalloc 池会把 self_destruct 已释放的
            # 页攥在池里不还内核,RSS 不降、cgroup 照样记账 —— 22:33 单实测新读法仍以
            # 同样的 ~126s 撞顶被杀。system pool 的大块内存 free 即归还 OS,削峰才真生效。
            try:
                pa.set_memory_pool(pa.system_memory_pool())
            except Exception:  # noqa: BLE001 —— 老版本没有该 API 时保持默认池
                pass
            tbl = pq.read_table(str(path))
            return tbl.to_pandas(self_destruct=True, split_blocks=True)
        except Exception as e:  # noqa: BLE001 —— 削峰读取失败,退回老读法(顶多回到现状)
            print(f"[load] arrow 削峰读取失败,回退 pandas 默认: {e}", flush=True)
        return pd.read_parquet(path)
    try:
        return pd.read_csv(path, low_memory=False)
    except UnicodeDecodeError:
        for enc in ("gbk", "gb18030", "cp936"):
            try:
                return pd.read_csv(path, encoding=enc, low_memory=False)
            except UnicodeDecodeError:
                continue
        raise


def _load_meta(path: Path | None) -> dict:
    if path is None:
        return {}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _parse_meta_arg(meta_arg: str | None) -> dict:
    """--meta 同时接受 JSON 文件路径 和 内联 JSON 字符串。"""
    if not meta_arg:
        return {}
    stripped = meta_arg.strip()
    # 内联 JSON：以 { 开头
    if stripped.startswith("{"):
        try:
            return json.loads(stripped)
        except json.JSONDecodeError as e:
            raise SystemExit(f"[prepare] --meta 内联 JSON 解析失败: {e}")
    # 否则视为文件路径
    p = Path(stripped)
    if not p.exists():
        raise SystemExit(f"[prepare] --meta 文件不存在: {p}")
    return _load_meta(p)


def _auto_derive_meta(df: "pd.DataFrame") -> dict:
    """从数据文件自动推断 campaign_meta 中可推断字段。"""
    meta: dict = {}
    # campaign_name / activity_id
    for col in ("activity_name", "campaign_name"):
        if col in df.columns:
            val = df[col].dropna().mode()
            if len(val):
                meta["campaign_name"] = str(val.iloc[0])
                break
    for col in ("activity_id", "campaign_id"):
        if col in df.columns:
            val = df[col].dropna().mode()
            if len(val):
                meta["campaign_id"] = str(val.iloc[0])
                break
    # target_products：从 activity_product_name 推断
    for col in ("activity_product_name", "product_name"):
        if col in df.columns:
            prods = df[col].dropna().unique().tolist()
            if prods:
                meta["target_products"] = [str(p) for p in prods[:3]]
                break
    # target_channels
    for col in ("activity_channel_std", "activity_channel"):
        if col in df.columns:
            chans = df[col].dropna().unique().tolist()
            if chans:
                meta["target_channels"] = [str(c) for c in chans[:5]]
                break
    # 平台：写入 inferred_platform（仅信息展示），不写 target_platform，
    # 避免触发 cmd_prepare 的隐式数据过滤
    for col in ("pre_primary_platform",):
        if col in df.columns:
            plat = df[col].dropna().mode()
            if len(plat):
                meta["inferred_platform"] = str(plat.iloc[0])
                break
    # 日期范围
    for col in ("touch_date",):
        if col in df.columns:
            dates = df[col].dropna()
            if len(dates):
                meta["start_date"] = str(dates.min())
                meta["end_date"]   = str(dates.max())
                break
    return meta


def _sanitize_for_json(obj: Any) -> Any:
    """递归将 float NaN/Inf 替换为 None，避免 JSON 序列化产生非法值。"""
    import math
    if isinstance(obj, float):
        if math.isnan(obj) or math.isinf(obj):
            return None
        return obj
    if isinstance(obj, dict):
        return {k: _sanitize_for_json(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_sanitize_for_json(v) for v in obj]
    return obj


def _write_json(obj: Any, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(_sanitize_for_json(obj), f, ensure_ascii=False, indent=2, default=str)


# ── prepare ──────────────────────────────────────────────────────────


def cmd_prepare(args: argparse.Namespace) -> int:
    """跑确定性统计层；输出 state_partial.json 与 events.jsonl。"""
    from snippets import (
        attribution,
        data_fallback, data_overview, event_logger, funnel, model_analyst,
        model_interpreter, path_quality, platform_behavior, price_sensitivity,
        report_renderer, report_validator, user_segment,
    )
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    log = event_logger.open_event_log(str(out_dir), fresh=True)

    print(f"[prepare] reading {args.data}")
    df = _load_dataframe(Path(args.data))
    print(f"          shape: {df.shape}")

    meta = _parse_meta_arg(getattr(args, "meta", None))
    if getattr(args, "auto_meta", False):
        auto = _auto_derive_meta(df)
        # auto 的值仅填补 meta 里缺失的字段
        for k, v in auto.items():
            meta.setdefault(k, v)
        print(f"          [auto-meta] 自动推断: {list(auto.keys())}")
    campaign_id = (
        meta.get("campaign_id")
        or args.campaign_id
        or f"campaign_{int(time.time())}"
    )

    # 仅当用户显式提供 target_platform 时才过滤（auto-meta 推断写 inferred_platform，不过滤）
    target_platform = meta.get("target_platform")
    plat_col = "pre_primary_platform"
    filter_applied = None
    if target_platform and plat_col in df.columns:
        n0 = len(df)
        df = df[df[plat_col].fillna("") == target_platform].copy()
        n1 = len(df)
        print(f"          filtered by target_platform='{target_platform}': {n0:,} → {n1:,}")
        # 记录过滤条件，供 compute-thresholds 复用，保证数据一致性
        filter_applied = {"column": plat_col, "value": target_platform, "n_before": n0, "n_after": n1}

    state: dict[str, Any] = {
        "_stage": "partial",
        "campaign_id": campaign_id,
        "campaign_meta": meta,
        "_filter_applied": filter_applied,
        "agent_raw_stats": {},
        "agent_structured_stats": {},
        "findings": [],
        "audience_segments": [],
        "hypotheses": [],
        "data_caveats": [],
    }
    if filter_applied:
        state["data_caveats"].append({
            "field": "platform_filter",
            "issue": f"按 target_platform='{target_platform}' 过滤，删除 {filter_applied['n_before']-filter_applied['n_after']} 行",
            "impact": "跨平台对比失去其他平台对照组；规则与统计均基于过滤后数据",
        })

    # 1) data_fallback
    print("[prepare] data_fallback")
    t0 = time.time()
    df, fb_caveats = data_fallback.ensure_required_fields(df, mode="all")
    state["data_caveats"].extend(fb_caveats)
    for c in fb_caveats:
        log.log_decision(tool_id="data_fallback", kind="fallback",
                         reason=f"派生 {c.get('field')}",
                         fallback_used=c.get("fallback"),
                         elapsed_ms=int((time.time()-t0)*1000))
    print(f"          caveats: {len(fb_caveats)}")

    # 2) data_overview（diagnostic_engine 在 compute-thresholds 后注入，首次 prepare 时为 None）
    print("[prepare] data_overview")
    t0 = time.time()
    state["data_overview"] = data_overview.compute_data_overview(
        df, campaign_id=campaign_id,
        target_product=meta.get("target_product"),
        diagnostic_engine=None,  # 由 compute-thresholds 步骤填充后注入
    )
    log.log_decision(tool_id="data_overview", kind="invoke",
                     reason="must_run", elapsed_ms=int((time.time()-t0)*1000))

    # 3) model_analysis（preconditions 校验）—— 建模目标为 is_paid（最终支付成单）
    print("[prepare] model_analysis")
    model_target = model_analyst.TARGET_COL  # "is_paid"
    nuq = df[model_target].nunique() if model_target in df.columns else 0
    if getattr(args, "no_model", False):
        state["model_analysis"] = None
        reason = "--no-model：跳过模型训练（快速跑通模式）"
        state["data_caveats"].append({
            "field": "model_analysis",
            "issue": "model_analysis 已按 --no-model 跳过",
            "impact": "本次无模型衍生 finding/segment；诊断仅用统计规则与阈值",
        })
        log.log_decision(tool_id="model_analysis", kind="skip", reason=reason, preconditions_ok=False)
        print(f"          skipped: {reason}")
    elif nuq < 2 or len(df) < 100:
        state["model_analysis"] = None
        reason = f"precondition_fail · {model_target} nunique={nuq} or n_rows<100"
        state["data_caveats"].append({
            "field": model_target,
            "issue": "model_analysis 跳过",
            "impact": reason,
        })
        log.log_decision(tool_id="model_analysis", kind="skip",
                         reason=reason, preconditions_ok=False)
        print(f"          skipped: {reason}")
    else:
        t0 = time.time()
        try:
            ma = model_analyst.run_model_analysis(df)
            state["model_analysis"] = ma.to_dict() if ma else None
            log.log_decision(tool_id="model_analysis", kind="invoke",
                             reason="preconditions_ok",
                             elapsed_ms=int((time.time()-t0)*1000))
            print(f"          AUC={state['model_analysis'].get('auc') if state['model_analysis'] else 'N/A'}")
        except Exception as e:
            state["model_analysis"] = None
            # 失败原因写入 data_caveats，并给出环境修复提示
            err_msg = str(e)
            fix_hint = ""
            if "libomp" in err_msg or "libgomp" in err_msg:
                fix_hint = "macOS 请执行: brew install libomp；Linux 请执行: apt-get install libgomp1"
            elif "lightgbm" in err_msg.lower() or "xgboost" in err_msg.lower():
                fix_hint = "请执行: pip install lightgbm 或 pip install xgboost"
            state["data_caveats"].append({
                "field": "model_analysis",
                "issue": f"模型加载失败（{type(e).__name__}）",
                "impact": "model_quality=0，所有模型衍生结论不可信；仅使用统计规则诊断",
                "fix_hint": fix_hint or err_msg[:120],
            })
            log.log_decision(tool_id="model_analysis", kind="skip",
                             reason=f"exception: {type(e).__name__}: {e}")
            print(f"          failed: {type(e).__name__}: {e}")
            if fix_hint:
                print(f"          [提示] {fix_hint}")

    # 3.5) model_interpreter: AUC 门控 + 候选 finding/segment/caveat 生成
    if state.get("model_analysis"):
        print("[prepare] model_interpreter")
        t0 = time.time()
        auto = model_interpreter.interpret_model(state["model_analysis"])
        auc_quality = auto.get("auc_quality", "invalid")
        state["model_auc_quality"] = auc_quality   # 供渲染层读取

        if auc_quality == "invalid":
            # AUC < 0.5：findings 全丢弃，只写 caveats
            state["data_caveats"].extend(auto["auto_caveats"])
            print(f"          AUC<0.5 ({state['model_analysis'].get('auc'):.4f})，"
                  f"所有 model findings 已丢弃，caveats+{len(auto['auto_caveats'])}")
        else:
            state["findings"].extend(auto["auto_findings"])
            state["audience_segments"].extend(auto["auto_segments"])
            state["data_caveats"].extend(auto["auto_caveats"])
            state.setdefault("model_interpreter_blind_spots", []).extend(auto["auto_blind_spots"])
            print(f"          auc_quality={auc_quality} | "
                  f"findings+{len(auto['auto_findings'])}, "
                  f"segments+{len(auto['auto_segments'])}, "
                  f"caveats+{len(auto['auto_caveats'])}, "
                  f"blind_spots+{len(auto['auto_blind_spots'])}")

        log.log_decision(
            tool_id="model_interpreter", kind="invoke",
            reason=f"auc_quality={auc_quality}, "
                   f"findings+{len(auto['auto_findings'])}, caveats+{len(auto['auto_caveats'])}",
            elapsed_ms=int((time.time()-t0)*1000),
        )

    # 4) 6 domains（diagnostic_engine 在 compute-thresholds 后才可用，此处先跑无阈值版）
    print("[prepare] domain analyzers")
    for name, fn in [
        ("funnel_diagnosis",      funnel.analyze_funnel),
        ("marketing_attribution", attribution.analyze_attribution),
        ("user_segment",          user_segment.analyze_user_segment),
        ("price_sensitivity",     price_sensitivity.analyze_price_sensitivity),
        ("platform_behavior",     platform_behavior.analyze_platform_behavior),
        ("path_quality",          path_quality.analyze_path_quality),
    ]:
        t0 = time.time()
        try:
            df_stats = fn(df)
            if "_section" in df_stats.columns:
                state["agent_raw_stats"][name] = {
                    sec: g.drop(columns=["_section"]).to_string(max_rows=30)
                    for sec, g in df_stats.groupby("_section")
                }
            else:
                state["agent_raw_stats"][name] = {"main": df_stats.to_string(max_rows=30)}
            state["agent_structured_stats"][name] = df_stats.to_dict("records")
            log.log_decision(tool_id=f"domain_{name}", kind="invoke",
                             reason="must_run", elapsed_ms=int((time.time()-t0)*1000))
            print(f"          · {name:24s} {int((time.time()-t0)*1000):5d}ms")
        except Exception as e:
            state["agent_raw_stats"][name] = {"error": f"[执行失败] {type(e).__name__}: {e}"}
            log.log_decision(tool_id=f"domain_{name}", kind="skip",
                             reason=f"exception: {type(e).__name__}")
            print(f"          · {name:24s} FAIL: {type(e).__name__}: {str(e)[:60]}")

    # 计算 high_severity_count（供 render 的 headline 使用）
    state["high_severity_count"] = sum(
        1 for f in state.get("findings", []) if f.get("severity") == "high"
    )

    # 5) case_pool：每种问题类型抽取 1 个代表性用户，供 LLM synthesis 阶段生成 typical_case
    print("[prepare] case_extractor")
    try:
        from snippets import case_extractor
        t0 = time.time()
        pool = case_extractor.extract_case_pool(df)
        state["case_pool"] = pool
        print(f"          patterns extracted: {list(pool.keys())} ({int((time.time()-t0)*1000)}ms)")
        log.log_decision(
            tool_id="case_extractor", kind="invoke",
            reason=f"patterns={list(pool.keys())}",
            elapsed_ms=int((time.time()-t0)*1000),
        )
    except Exception as e:
        state.setdefault("case_pool", {})
        print(f"          [skip] case_extractor failed: {type(e).__name__}: {e}")

    # 写入 decision_trace + state
    event_logger.write_decision_trace(state, log)
    out_path = out_dir / "state_partial.json"
    _write_json(state, out_path)
    print(f"\n[prepare] DONE → {out_path}")
    print(f"          events: {log.path}")
    print(f"          数据已统计完毕，宿主 Agent 现在应：")
    print(f"            1. 运行 `cli compute-thresholds` 计算数据驱动阈值并评估诊断规则（以 feature_schema/diagnostic_rules.yaml 为准）")
    print(f"            2. 读 thresholds_report.md 了解规则触发情况（is_converted/is_paid CVR 对比）")
    print(f"            3. 按 methodology/08_diagnostic_rules.md 生成诊断结论（findings）")
    print(f"            4. 按 methodology/03..08 补充各维度统计叙述")
    print(f"            5. 如需内部质检/评分，可跑 `cli run-tools --tools self_critique confidence`（不会在新版报告中单独展示）")
    print(f"            6. 写 state_full.json 后调用 `cli render`")
    return 0


# ── compute-thresholds ───────────────────────────────────────────────


def cmd_compute_thresholds(args: argparse.Namespace) -> int:
    """从数据中计算每个特征的数据驱动阈值，并更新 state。

    所有阈值由各特征分组后的创单率/成单率（CVR）决定，不依赖 thresholds.yaml。
    计算完成后：
      1. 将 adaptive_thresholds 写入 state JSON（原地更新）
      2. 用 diagnostic_engine 重跑诊断规则汇总，更新 state["data_overview"]["diagnostic_rules_summary"]
      3. 输出可读的 thresholds_report.md 供 Agent 参考
    """
    from snippets import (
        event_logger,
        feature_loader as fl_mod,
        threshold_computer,
        diagnostic_engine as diag_mod,
    )

    state_path = Path(args.state)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"[compute-thresholds] loading {args.data}")
    df = _load_dataframe(Path(args.data))
    print(f"                     shape: {df.shape}")

    print(f"[compute-thresholds] loading state: {state_path}")
    with open(state_path, encoding="utf-8") as f:
        state = json.load(f)

    # 复用 prepare 阶段的过滤条件，保证两步骤数据一致
    flt = state.get("_filter_applied")
    if flt and flt.get("column") in df.columns:
        n0 = len(df)
        df = df[df[flt["column"]].fillna("") == flt["value"]].copy()
        print(f"                     re-applied prepare filter "
              f"({flt['column']}='{flt['value']}'): {n0:,} → {len(df):,}")

    log = event_logger.open_event_log(str(out_dir), fresh=False)
    t0 = time.time()

    # 1. 构建 FeatureLoader
    print("[compute-thresholds] building FeatureLoader")
    loader = fl_mod.FeatureLoader(df)
    coverage = loader.coverage_report()
    print(f"                     feature coverage: {coverage['coverage_rate']:.1%} "
          f"({coverage['total_present']}/{coverage['total_registered']})")

    # 2. 计算数据驱动阈值
    #    口径解耦（Option B）：
    #      - split_col  = is_converted（创单率，6.94%，信号更密）→ 仅用于「找最优切分点」，切分质量更稳
    #      - eval_col   = is_paid（成单率，最终支付）→ 规则 CVR 对比 / 有效信号筛选 / 严重度判定 / 卡片展示
    #    创单率仅作 KPI 漏斗的过程指标（create_*），不再作为诊断/展示主口径。
    print("[compute-thresholds] computing adaptive thresholds (CVR-based)...")
    eval_col  = args.target_col or "is_paid"
    split_col = "is_converted" if "is_converted" in df.columns and "is_converted" != eval_col else eval_col
    adaptive_thresholds = threshold_computer.compute_adaptive_thresholds(
        df, loader, target_col=split_col, eval_col=eval_col
    )
    state["adaptive_thresholds"] = adaptive_thresholds
    n_computed = len(adaptive_thresholds)
    n_optimal = sum(1 for v in adaptive_thresholds.values() if "youden_split" in str(v.get("method", "")))
    print(f"                     split basis = {split_col}（最优切分），eval/display basis = {eval_col}（判定/展示）")
    print(f"                     computed {n_computed} field thresholds "
          f"({n_optimal} via CVR-optimal, {n_computed - n_optimal} via percentile fallback)")

    # 3. 构建 DiagnosticEngine：主口径 = eval_col（成单率）。有效信号/显著性/严重度全部基于成单率。
    print("[compute-thresholds] running diagnostic rules...")
    engine = diag_mod.DiagnosticEngine(adaptive_thresholds, loader, cvr_col=eval_col)
    state["_cvr_col"]   = eval_col   # 展示/判定主口径（成单率）；供 draft/render/run-tools 复用
    state["_split_col"] = split_col  # 阈值最优切分口径（创单率）
    rule_summary_df = engine.rule_summary(df)

    # 过程指标：再用 split_col（创单率）算每条规则触发/对照 CVR，作为 KPI 漏斗的"创单过程"口径并列展示，
    # 不参与有效信号筛选与严重度判定。
    if split_col in df.columns and split_col != eval_col:
        try:
            engine_proc = diag_mod.DiagnosticEngine(adaptive_thresholds, loader, cvr_col=split_col)
            proc_df = engine_proc.rule_summary(df)[
                ["rule_id", "cvr_triggered", "cvr_not_triggered", "cvr_gap"]
            ].rename(columns={
                "cvr_triggered": "create_triggered",
                "cvr_not_triggered": "create_not_triggered",
                "cvr_gap": "create_gap",
            })
            rule_summary_df = rule_summary_df.merge(proc_df, on="rule_id", how="left")
            print(f"                     process-basis ({split_col}) 创单率已计算，作过程指标并列展示")
        except Exception as e:
            print(f"                     [warn] process-basis pass skipped: {type(e).__name__}: {e}")

    triggered    = int((rule_summary_df["status"] == "triggered").sum())
    full_trig    = int((rule_summary_df["status"] == "full_trigger_no_baseline").sum())
    skipped      = int((rule_summary_df["status"] == "skipped").sum())
    positives    = int(rule_summary_df.get("is_positive_signal", False).sum()) if "is_positive_signal" in rule_summary_df else 0
    print(f"                     rules: {triggered} triggered, {full_trig} full_trigger, "
          f"{skipped} skipped (of {len(rule_summary_df)} total)")
    if positives:
        print(f"                     positive_signal rules: {positives}")
    effective = int(rule_summary_df.get("effective_signal", False).sum()) if "effective_signal" in rule_summary_df else 0
    print(f"                     ⭐ effective signals (优先诊断): {effective}  "
          f"（已触发因果/正向 且 |CVR差|≥1.5pp、样本≥100）")

    # full_trigger_no_baseline 规则写入 data_caveats（不带 rule#N 前缀，仅中文名）
    ft_rules = rule_summary_df[rule_summary_df["status"] == "full_trigger_no_baseline"]
    for _, row in ft_rules.iterrows():
        state.setdefault("data_caveats", []).append({
            "field": f"「{row['name']}」",
            "issue": f"「{row['name']}」100%触发，无对照组，channel_filter 可能不适配当前渠道类型",
            "impact": "无法量化 CVR 差值，建议检查 diagnostic_rules.yaml 中 channel_filter 设置",
        })

    # skipped 规则（字段缺失）写入 data_caveats（不带 rule#N 前缀，仅中文名）
    sk_rules = rule_summary_df[rule_summary_df["status"] == "skipped"]
    for _, row in sk_rules.iterrows():
        state.setdefault("data_caveats", []).append({
            "field": f"「{row['name']}」",
            "issue": f"「{row['name']}」已跳过：{row.get('skip_reason','')}",
            "impact": "该规则无法评估，相关业务问题可能被遗漏",
        })

    # 将规则汇总写入 data_overview（含新增字段）
    export_cols = [
        "rule_id", "category", "name", "display_name", "positive_alias", "status", "condition",
        "trigger_rate", "trigger_cnt", "total_cnt",
        "cvr_triggered", "cvr_not_triggered", "cvr_gap",
        "cvr_gap_p_value", "cvr_gap_significant",
        "is_definitional", "is_positive_signal", "positive_reason",
        "_ease", "_score", "_signal_type", "is_leakage", "effective_signal", "skip_reason",
        "create_triggered", "create_not_triggered", "create_gap",
    ]
    export_cols = [c for c in export_cols if c in rule_summary_df.columns]
    if "data_overview" not in state:
        state["data_overview"] = {}
    state["data_overview"]["diagnostic_rules_summary"] = rule_summary_df[export_cols].to_dict("records")

    # 零方差字段写入 data_caveats
    zero_var_fields = [
        name for name, info in adaptive_thresholds.items()
        if info.get("signal_quality") == "structural_zero_variance"
    ]
    if zero_var_fields:
        state.setdefault("data_caveats", []).append({
            "field": "structural_zero_variance_fields",
            "issue": f"{len(zero_var_fields)} 个字段在当前活动数据中零方差（渠道特性）: {', '.join(zero_var_fields[:8])}{'…' if len(zero_var_fields)>8 else ''}",
            "impact": "这些字段对该活动类型的所有用户值相同，阈值无意义；相关规则若依赖这些字段，请检查 channel_filter 设置",
        })

    # 异常值字段写入 data_caveats
    for fname, info in adaptive_thresholds.items():
        if info.get("has_outlier"):
            state.setdefault("data_caveats", []).append({
                "field": fname,
                "issue": f"极端异常值：{info['outlier_note']}",
                "impact": f"该字段的 CVR 最优切分点可能受异常值影响，依赖此字段的诊断规则置信度降低；建议排查原始数据上报逻辑",
            })

    # 4. 写出 thresholds_report.md（含阈值详情 + 规则汇总表）
    report_md = threshold_computer.generate_thresholds_report(adaptive_thresholds)
    report_md += "\n\n" + engine.format_rule_summary_md(df)
    report_path = out_dir / "thresholds_report.md"
    report_path.write_text(report_md, encoding="utf-8")
    print(f"                     thresholds_report.md → {report_path}")

    # 5. 原地更新 state JSON
    log.log_decision(
        tool_id="compute_thresholds",
        kind="invoke",
        reason=f"CVR-based thresholds: {n_computed} fields, {triggered} rules triggered",
        elapsed_ms=int((time.time() - t0) * 1000),
    )
    event_logger.write_decision_trace(state, log)
    _write_json(state, state_path)
    print(f"\n[compute-thresholds] DONE → state updated in-place: {state_path}")
    print(f"  宿主 Agent 现在应：")
    print(f"    1. 读 thresholds_report.md 了解各字段阈值与规则触发情况")
    print(f"    2. 基于 state['adaptive_thresholds'] 和 state['data_overview']['diagnostic_rules_summary']")
    print(f"       按 methodology/08_diagnostic_rules.md 生成各规则的诊断结论")
    return 0


# ── draft ────────────────────────────────────────────────────────────


def cmd_draft(args: argparse.Namespace) -> int:
    """从 compute-thresholds 产物自动装配 state_full 骨架（findings/segments/narratives/actions）。

    定位：把原本由宿主 Agent 手写的 Step 3 变成"自动草拟 + Agent 润色"。
    草稿满足 signal_coverage（覆盖全部 effective 主题组）与 lint_report_completeness，
    宿主 Agent 只需润色 [待润色] 文案并把 _stage 置为 full，即可 render。
    """
    from snippets import draft_builder, report_validator, event_logger

    state_path = Path(args.state)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"[draft] loading state: {state_path}")
    with open(state_path, encoding="utf-8") as f:
        state = json.load(f)

    if not (state.get("data_overview") or {}).get("diagnostic_rules_summary"):
        raise SystemExit("[draft] state 缺 diagnostic_rules_summary，请先运行 compute-thresholds")

    log = event_logger.open_event_log(str(out_dir), fresh=False)
    t0 = time.time()
    draft_builder.build_draft(state, top_findings=args.top_findings, max_problems=args.max_problems)

    n_find = len(state.get("findings") or [])
    n_prob = len((state.get("narratives") or {}).get("problems") or [])
    n_seg = len(state.get("audience_segments") or [])
    n_act = len((state.get("action_plan") or {}).get("priority_actions") or [])
    print(f"[draft] assembled: findings={n_find}, problems={n_prob}, segments={n_seg}, actions={n_act}")

    # 自检：草稿应已满足完整性与漏诊覆盖
    gaps = report_validator.lint_report_completeness(state)
    blocks = [g for g in gaps if g.get("level") == "block"]
    print(f"[draft] completeness: {len(blocks)} blocking, {len(gaps)-len(blocks)} warnings")
    try:
        from snippets import self_critique
        cov = [i for i in self_critique.critique(state) if i.get("type") == "signal_coverage"]
        print(f"[draft] signal_coverage 漏诊: {len(cov)} 条（草稿已覆盖全部 effective 主题组则应为 0）")
    except Exception:
        pass

    log.log_decision(tool_id="draft", kind="invoke",
                     reason=f"findings={n_find}, problems={n_prob}",
                     elapsed_ms=int((time.time()-t0)*1000))
    event_logger.write_decision_trace(state, log)
    draft_path = out_dir / "state_draft.json"
    _write_json(state, draft_path)
    print(f"\n[draft] DONE → {draft_path}")
    print(f"  宿主 Agent 现在应：")
    print(f"    1. 打开 state_draft.json，按 methodology/03 润色所有 [待润色] 文案")
    print(f"       （signal/detail/narrative/title/typical_case/headline；保持 metric_refs 数值不变）")
    print(f"    2. 删除各对象的 _draft 标记，把 _stage 置为 \"full\"")
    print(f"    3. 另存为 state_full.json，再跑 run-tools self_critique 与 render")
    return 0


# ── crowd-rules ──────────────────────────────────────────────────────


def cmd_crowd_rules(args: argparse.Namespace) -> int:
    """从 state（draft 或 full）构建可执行人群规则 → crowd_rules.json。

    不需要 polish/render：draft 之后即可产出，供外部人群 pipeline（如私域诊断 driver）
    消费。render 时也会随报告再产一份，两者内容一致（同源 build_crowd_rules）。
    """
    from snippets.crowd_translator import build_crowd_rules

    state_path = Path(args.state)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"[crowd-rules] loading state: {state_path}")
    with open(state_path, encoding="utf-8") as f:
        state = json.load(f)

    rules = build_crowd_rules(state)
    out_path = out_dir / "crowd_rules.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(rules, f, ensure_ascii=False, indent=2)

    n_seg = sum(1 for r in rules if r.get("source") == "audience_segment")
    n_dr = sum(1 for r in rules if r.get("source") == "diagnostic_rule")
    n_push = sum(1 for r in rules if r.get("direction") == "push")
    n_excl = sum(1 for r in rules if r.get("direction") == "exclude")
    print(f"[crowd-rules] {len(rules)} rules "
          f"(audience_segment={n_seg}, diagnostic_rule={n_dr}; push={n_push}, exclude={n_excl})")
    print(f"[crowd-rules] DONE → {out_path}")
    return 0


# ── status ───────────────────────────────────────────────────────────


def cmd_status(args: argparse.Namespace) -> int:
    """打印当前 state 的流程进度、各模块填充情况、完整性缺项与下一步建议。"""
    from snippets import report_validator

    state_path = Path(args.state)
    with open(state_path, encoding="utf-8") as f:
        state = json.load(f)

    stage = state.get("_stage", "?")
    dov = state.get("data_overview") or {}
    has_thresholds = bool(state.get("adaptive_thresholds"))
    has_rules = bool(dov.get("diagnostic_rules_summary"))
    has_model = state.get("model_analysis") is not None
    n_find = len(state.get("findings") or [])
    nar = state.get("narratives") or {}
    n_prob = len(nar.get("problems") or []) if isinstance(nar, dict) else 0
    n_seg = len(state.get("audience_segments") or [])
    n_act = len((state.get("action_plan") or {}).get("priority_actions") or [])

    def mark(ok): return "✓" if ok else "·"
    print("=" * 56)
    print(f"  state: {state_path}   stage={stage}")
    print("=" * 56)
    print(f"  {mark(bool(dov))} data_overview        {mark(has_thresholds)} adaptive_thresholds")
    print(f"  {mark(has_rules)} diagnostic_rules     {mark(has_model)} model_analysis")
    print(f"  findings={n_find}  problems={n_prob}  segments={n_seg}  actions={n_act}")

    # 完整性 + 漏诊覆盖
    gaps = report_validator.lint_report_completeness(state)
    blocks = [g for g in gaps if g.get("level") == "block"]
    warns = [g for g in gaps if g.get("level") != "block"]
    print(f"\n  完整性：{len(blocks)} 阻断 / {len(warns)} 警告")
    for g in (blocks + warns)[:8]:
        lvl = "✗" if g.get("level") == "block" else "·"
        print(f"    {lvl} {g['message'][:74]}")

    # 下一步建议
    print("\n  下一步：")
    if not has_thresholds:
        nxt = "运行 compute-thresholds"
    elif stage == "partial" and n_find == 0:
        nxt = "运行 draft 自动装配骨架（或手写 findings）"
    elif stage == "draft" or "[待润色]" in json.dumps(nar, ensure_ascii=False):
        nxt = "润色 [待润色] 文案、删 _draft、置 _stage=full"
    elif blocks:
        nxt = "补齐上面的阻断项后再 render"
    elif stage != "full":
        nxt = "置 _stage=full 后 run-tools self_critique → render"
    else:
        nxt = "run-tools self_critique → render"
    print(f"    → {nxt}")
    return 0


# ── render ───────────────────────────────────────────────────────────


def cmd_render(args: argparse.Namespace) -> int:
    """对补全的 full state 做 schema 校验 + 渲染三件套。"""
    from snippets import report_renderer, report_validator

    state_path = Path(args.state)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"[render] loading {state_path}")
    with open(state_path, encoding="utf-8") as f:
        state = json.load(f)

    # headline 自动截断到 60 字（硬上限）：宿主 Agent 润色时可能写出超长 headline，
    # 与其在校验阶段硬拦、被迫改文重 render，不如在此自动截断并告警，保证 render 一次过。
    _nv = state.get("narratives") or {}
    _hl = _nv.get("headline")
    if isinstance(_hl, str) and len(_hl) > 60:
        _nv["headline"] = _hl[:60]
        state["narratives"] = _nv
        print(f"[render] headline 自动截断 {len(_hl)}→60 字：{_nv['headline'][:40]}…")

    # schema 校验
    errors = report_validator.validate_report(state)
    print(f"[render] schema validate: {len(errors)} errors")
    for e in errors[:10]:
        print(f"         · {e}")
    if errors and not args.skip_validate:
        print("[render] aborted due to schema errors (use --skip-validate to force)")
        return 2

    # lint
    warns = report_validator.lint_report(state)
    print(f"[render] lint warnings: {len(warns)}")
    for w in warns[:8]:
        print(f"         · {w}")

    # 完整性校验（页面一致性硬保障）：block 级缺项默认阻断 render
    gaps = report_validator.lint_report_completeness(state)
    blocks = [g for g in gaps if g.get("level") == "block"]
    cwarns = [g for g in gaps if g.get("level") != "block"]
    print(f"[render] completeness: {len(blocks)} blocking, {len(cwarns)} warnings")
    for g in cwarns[:8]:
        print(f"         · [warn] {g['message']}")
    if blocks and not getattr(args, "skip_completeness", False):
        print()
        print("[render] INCOMPLETE_REPORT: 检测到会破坏页面结构的缺项，报告不得产出")
        print("         宿主 Agent 必须补齐以下项后重新 render（或 --skip-completeness 强制）：")
        for g in blocks:
            print(f"  ✗ [{g['code']}] {g['message']}")
        print()
        return 4

    # 渠道词汇违规检查（阻塞级，不允许带错误词汇产出报告）
    channel_issues = report_validator.lint_channel_vocab_issues(state)
    if channel_issues and not args.allow_channel_lint:
        print()
        print("[render] REWRITE_REQUIRED: 检测到渠道词汇违规，报告不得产出")
        print("         宿主 Agent 必须按以下指示修改 state_full.json 后重新 render：")
        print()
        for issue in channel_issues:
            print(f"  ✗ {issue['location']}")
            print(f"    渠道：{issue['channel']} 专属词汇 {issue['bad_terms']} 不应出现")
            print(f"    实际渠道：{issue['actual_channels']}")
            print(f"    修正：{issue['rewrite_hint']}")
            print()
        print("  [修改规则]")
        print("  1. 找到上述 location 的 signal/detail/title/narrative 字段")
        print("  2. 删除或替换所有列出的专属词汇（用实际渠道对应词汇替代）")
        print("  3. 保存 state_full.json 后重新执行 cli render")
        print()
        return 3

    # target_audiences 标准化
    report_validator.normalize_target_audiences(state)

    if state.get("_stage") != "full":
        print("[render] WARN: _stage != 'full'（宿主 Agent 未完成 LLM 步骤？）")

    # 内部置信度过低提示（不写入 HTML，仅给 Agent 改进信号）
    conf = (state.get("confidence") or {}).get("overall")
    if conf is not None and conf < 0.5:
        print(f"[render] WARN: 内部置信度偏低（overall={conf:.2f}<0.5）。"
              f"建议按 methodology/04 排查：补跑失败维度 / 检查模型样本量 / 补强 finding 证据深度")

    paths = report_renderer.save_report(state, output_dir=str(out_dir))
    print(f"[render] DONE → {paths}")
    return 0


# ── run-tools ────────────────────────────────────────────────────────


def _auto_fix_critique_issues(state: dict, issues: list[dict]) -> int:
    """对确定性可修复的 self_critique issue 执行自动修复，返回修复条数。

    当前可自动修复类型：
      - language_compliance（规则编号暴露）：从 finding.detail/signal 中移除 Rule#N 模式
    """
    import re
    rules_meta = {
        int(r.get("rule_id", 0)): r.get("name", "")
        for r in (state.get("data_overview") or {}).get("diagnostic_rules_summary") or []
        if r.get("rule_id") is not None
    }
    findings_by_id = {f.get("id", ""): f for f in state.get("findings") or []}
    fixed = 0

    for issue in issues:
        if issue.get("type") != "language_compliance":
            continue
        target_id = str(issue.get("target_id", ""))
        f = findings_by_id.get(target_id)
        if not f:
            continue
        rid = f.get("rule_id")
        chinese_name = rules_meta.get(rid, "") if rid else ""
        changed = False
        for field in ("detail", "signal"):
            old = f.get(field, "")
            new = re.sub(r"规则#\d+[：:]\s*", "", old)
            new = re.sub(r"rule#\d+", "", new, flags=re.IGNORECASE)
            new = re.sub(r"\bRule\s*#?\d+\b", "", new, flags=re.IGNORECASE)
            new = new.strip()
            if new != old:
                f[field] = new
                changed = True
        if changed:
            fixed += 1
    return fixed


def cmd_run_tools(args: argparse.Namespace) -> int:
    """按 tool_id 重跑指定内部确定性工具（不替代 LLM 步骤）。

    self_critique 执行流：
      Round 1 → assess → 自动修复 language_compliance issue
      Round 2 → re-assess，验证修复后剩余 issue
    最终报告应在 run-tools self_critique 通过后再执行 render。
    """
    state = json.loads(Path(args.state).read_text(encoding="utf-8"))
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    from snippets import confidence as confidence_mod
    from snippets import event_logger, self_critique
    log = event_logger.open_event_log(str(out_dir), fresh=False)

    for tool_id in args.tools:
        print(f"[run-tools] {tool_id}")
        t0 = time.time()
        if tool_id == "self_critique":
            state.setdefault("_critique_history", [])

            # Round 1
            assessments = self_critique.assess(state)
            assessment_summary_r1 = self_critique.summarize_assessments(assessments)
            issues_r1 = list(state.get("self_critique") or [])
            summary_r1 = self_critique.summarize(issues_r1)
            print(f"            [R1] issues: {summary_r1}")

            # 自动修复 language_compliance
            fixed = _auto_fix_critique_issues(state, issues_r1)
            if fixed:
                print(f"            [auto-fix] 修复 {fixed} 条 language_compliance issue")

                # Round 2：修复后再次校验
                assessments = self_critique.assess(state)
                issues_r2 = list(state.get("self_critique") or [])
                summary_r2 = self_critique.summarize(issues_r2)
                assessment_summary = self_critique.summarize_assessments(assessments)
                print(f"            [R2] issues after fix: {summary_r2}")
                state["_critique_history"].append({
                    "round": 1, "summary": summary_r1,
                    "assessment_summary": assessment_summary_r1,  # R1 自身的评估摘要
                    "n_issues": len(issues_r1), "auto_fixed": fixed,
                })
                state["_critique_history"].append({
                    "round": 2, "summary": summary_r2,
                    "assessment_summary": assessment_summary,
                    "n_issues": len(issues_r2),
                })
                log.log_critique(round_no=2, issues_summary={**summary_r2,
                    "assessment_summary": assessment_summary, "auto_fixed_r1": fixed})
            else:
                assessment_summary = self_critique.summarize_assessments(assessments)
                state["_critique_history"].append({
                    "round": args.critique_round,
                    "summary": summary_r1,
                    "assessment_summary": assessment_summary,
                    "n_issues": len(issues_r1),
                })
                log.log_critique(round_no=args.critique_round, issues_summary={
                    **summary_r1, "assessment_summary": assessment_summary})

            final_issues = state.get("self_critique") or []
            print(f"            [final] issues: {self_critique.summarize(final_issues)}")
            print(f"            assessments: {self_critique.summarize_assessments(assessments)}")
            print(f"            _critique_history rounds: {len(state['_critique_history'])}")
        elif tool_id == "confidence":
            state["confidence"] = confidence_mod.compute_confidence_from_state(state)
            conf = state["confidence"]
            print(
                "            overall: "
                f"{conf.get('overall', 0):.3f}, level={conf.get('level', '-')}"
            )
        else:
            print(f"            unknown tool_id (skipped): {tool_id}")
            continue
        log.log_decision(tool_id=tool_id, kind="invoke",
                         reason="cli run-tools rerun",
                         elapsed_ms=int((time.time()-t0)*1000))

    event_logger.write_decision_trace(state, log)
    _write_json(state, Path(args.state))
    print(f"[run-tools] state updated in-place → {args.state}")
    return 0


# ── doctor ───────────────────────────────────────────────────────────


def cmd_doctor(args: argparse.Namespace) -> int:
    """环境自检：依赖、可选库、schema、manifest。"""
    print("=" * 60)
    print("marketing_audit_skill doctor")
    print("=" * 60)

    deps = [
        ("pandas",     True),
        ("numpy",      True),
        ("scipy",      False),
        ("jsonschema", False),
        ("yaml",       False),    # pyyaml
        ("lightgbm",   False),
        ("xgboost",    False),
    ]
    print("\n[依赖]")
    missing_required = []
    for name, required in deps:
        try:
            mod = importlib.import_module(name)
            ver = getattr(mod, "__version__", "?")
            print(f"  ✓  {name:14s}  {ver}")
        except ImportError:
            mark = "✗ MISS" if required else "·  optional"
            print(f"  {mark}  {name:14s}")
            if required:
                missing_required.append(name)

    # manifest 校验
    print("\n[manifest schema]")
    try:
        import jsonschema  # noqa: F401
    except ImportError:
        # jsonschema 是可选依赖：缺失只代表无法做 manifest 校验，不代表 manifest 损坏。
        # 渲染管线（render 的 report_validator）有独立 fallback，不依赖此处。降级为软提示。
        print("  ·  optional: jsonschema 未安装，跳过 manifest schema 校验（pip install jsonschema 可启用）")
    else:
        try:
            pkg_dir = Path(__file__).resolve().parent
            schema = json.loads((pkg_dir / "schemas" / "tools_manifest.schema.json").read_text(encoding="utf-8"))
            manifest = json.loads((pkg_dir / "TOOLS_MANIFEST.json").read_text(encoding="utf-8"))
            jsonschema.validate(manifest, schema)
            print("  ✓ TOOLS_MANIFEST.json 通过 schema 校验")
        except Exception as e:
            print(f"  ✗ {type(e).__name__}: {e}")

    # feature_schema（数据驱动阈值）
    print("\n[特征注册表与诊断规则]")
    try:
        pkg_dir = Path(__file__).resolve().parent
        registry_path = pkg_dir / "feature_schema" / "feature_registry.yaml"
        rules_path = pkg_dir / "feature_schema" / "diagnostic_rules.yaml"
        import yaml  # noqa: F401
        with open(registry_path, encoding="utf-8") as f:
            reg = yaml.safe_load(f)
        n_features = len(reg.get("features", []))
        print(f"  ✓ feature_registry.yaml 加载成功（{n_features} 个特征）")
        with open(rules_path, encoding="utf-8") as f:
            rules = yaml.safe_load(f)
        n_rules = len(rules.get("rules", []))
        print(f"  ✓ diagnostic_rules.yaml 加载成功（{n_rules} 条规则）")

        # A7：draft_builder 硬编码 rule_id/字段映射 与 yaml/registry 漂移检查
        import re as _re
        from snippets.draft_builder import _RULE_CASE_PATTERN, _RULE_SEGMENT_FIELD
        rule_ids = {r.get("id") for r in rules.get("rules", [])}
        feat_names = {f.get("name") for f in reg.get("features", [])}
        stale_case = sorted(rid for rid in _RULE_CASE_PATTERN if rid not in rule_ids)
        stale_seg  = sorted(rid for rid in _RULE_SEGMENT_FIELD if rid not in rule_ids)
        bad_fields = sorted({
            tok.group(0) for field, _op in _RULE_SEGMENT_FIELD.values()
            for tok in [_re.match(r"[A-Za-z_]+", field)]
            if tok and tok.group(0) not in feat_names
            and tok.group(0) not in ("is_converted", "is_paid")
        })
        if stale_case or stale_seg or bad_fields:
            if stale_case:
                print(f"  ⚠ draft_builder._RULE_CASE_PATTERN 含 yaml 不存在的 rule_id: {stale_case}")
            if stale_seg:
                print(f"  ⚠ draft_builder._RULE_SEGMENT_FIELD 含 yaml 不存在的 rule_id: {stale_seg}")
            if bad_fields:
                print(f"  ⚠ draft_builder._RULE_SEGMENT_FIELD 引用 registry 不存在的字段: {bad_fields}")
        else:
            print("  ✓ draft_builder 规则映射与 yaml/registry 一致（无漂移）")

        # A8：诊断规则的 category 必须都在 DiagnosticEngine._CATEGORY_EASE 中声明，
        # 否则该类别执行难易度静默退回默认 0.5，影响 _score 排序与封面/详表排序。
        from snippets.diagnostic_engine import DiagnosticEngine
        rule_cats = {r.get("category") for r in rules.get("rules", []) if r.get("category")}
        missing_ease = sorted(c for c in rule_cats if c not in DiagnosticEngine._CATEGORY_EASE)
        if missing_ease:
            print(f"  ⚠ 以下规则类别未在 _CATEGORY_EASE 声明（将退回默认 ease=0.5）: {missing_ease}")
        else:
            print(f"  ✓ 规则类别（{len(rule_cats)} 类）均已在 _CATEGORY_EASE 声明执行难易度")
    except ImportError:
        print("  ✗ pyyaml 未安装（pip install pyyaml）")
    except Exception as e:
        print(f"  ✗ {type(e).__name__}: {e}")

    # 模型后端
    print("\n[模型后端]")
    has_model = False
    for name in ("lightgbm", "xgboost"):
        try:
            importlib.import_module(name)
            print(f"  ✓ {name}")
            has_model = True
        except ImportError:
            pass
    if not has_model:
        print("  ⚠  无可用模型后端，model_analysis 将永远 skip")
        print("     建议: pip install lightgbm  或  pip install xgboost")

    print()
    return 0 if not missing_required else 1


# ── 入口 ─────────────────────────────────────────────────────────────


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="marketing_audit_skill",
                                 description=__doc__.split("\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)

    # prepare
    pp = sub.add_parser("prepare", help="跑确定性统计层 → state_partial.json")
    pp.add_argument("--data",       required=True, help="行为宽表 .csv / .parquet")
    pp.add_argument("--meta",       help="campaign_meta：JSON 文件路径 或 内联 JSON 字符串，如 '{\"campaign_name\":\"xxx\",\"target_products\":[\"机票\"]}'")
    pp.add_argument("--auto-meta",  action="store_true", help="从数据文件自动推断 campaign_name/channel/platform/date 等可推断字段（不覆盖 --meta 已提供的字段）")
    pp.add_argument("--campaign-id", help="未提供 meta 时备用 campaign_id")
    pp.add_argument("--no-model",   action="store_true", help="跳过模型训练（快速跑通；诊断仅用统计规则与阈值）")
    pp.add_argument("--out",        required=True, help="输出目录")
    pp.set_defaults(func=cmd_prepare)

    # compute-thresholds
    ct = sub.add_parser("compute-thresholds",
                         help="按 CVR 计算数据驱动阈值 + 跑诊断规则集（diagnostic_rules.yaml）")
    ct.add_argument("--data",       required=True, help="行为宽表 .csv / .parquet")
    ct.add_argument("--state",      required=True, help="state_partial.json 路径（原地更新）")
    ct.add_argument("--out",        required=True, help="输出目录（thresholds_report.md）")
    ct.add_argument("--target-col", default="is_paid",
                    help="展示/判定主口径列名（默认 is_paid 成单率；最优切分仍用 is_converted 创单率）")
    ct.set_defaults(func=cmd_compute_thresholds)

    # draft
    dr = sub.add_parser("draft", help="自动装配 state_full 骨架（findings/segments/narratives/actions）")
    dr.add_argument("--state",         required=True, help="compute-thresholds 后的 state_partial.json")
    dr.add_argument("--out",           required=True, help="输出目录（state_draft.json）")
    dr.add_argument("--top-findings",  type=int, default=6, dest="top_findings", help="草拟 finding 上限")
    dr.add_argument("--max-problems",  type=int, default=4, dest="max_problems", help="核心问题数上限")
    dr.set_defaults(func=cmd_draft)

    # crowd-rules
    cr = sub.add_parser("crowd-rules",
                        help="从 state（draft 即可）构建可执行人群规则 → crowd_rules.json")
    cr.add_argument("--state", required=True, help="state_draft.json 或 state_full.json")
    cr.add_argument("--out",   required=True, help="输出目录（crowd_rules.json）")
    cr.set_defaults(func=cmd_crowd_rules)

    # render
    pr = sub.add_parser("render", help="state_full.json → JSON / Markdown / HTML")
    pr.add_argument("--state",              required=True, help="补全后的 state JSON 路径")
    pr.add_argument("--out",                required=True, help="输出目录")
    pr.add_argument("--skip-validate",      action="store_true", help="忽略 schema 错误强制渲染")
    pr.add_argument("--skip-completeness",  action="store_true", help="忽略完整性 block 级缺项强制渲染（仅调试用）")
    pr.add_argument("--allow-channel-lint", action="store_true",
                    help="允许渠道词汇违规继续产出报告（仅用于调试，正式报告禁止使用）")
    pr.set_defaults(func=cmd_render)

    # run-tools
    rt = sub.add_parser("run-tools", help="重跑指定内部确定性工具")
    rt.add_argument("--state",           required=True, help="state JSON（原地更新）")
    rt.add_argument("--out",             required=True, help="日志输出目录")
    rt.add_argument("--tools",           nargs="+",
                    choices=["self_critique", "confidence"],
                    required=True,
                    help="要重跑的内部工具 id")
    rt.add_argument("--critique-round",  type=int, default=1)
    rt.set_defaults(func=cmd_run_tools)

    # doctor
    # status
    st = sub.add_parser("status", help="查看 state 流程进度 / 完整性缺项 / 下一步建议")
    st.add_argument("--state", required=True, help="state JSON 路径")
    st.set_defaults(func=cmd_status)

    dp = sub.add_parser("doctor", help="环境自检")
    dp.set_defaults(func=cmd_doctor)

    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
