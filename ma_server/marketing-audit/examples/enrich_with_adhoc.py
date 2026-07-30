"""示例：路由驱动 + 临时工具 + self_critique 端到端示例（用户-活动粒度）。

演示宿主 Agent 如何将 TOOLS_MANIFEST + methodology/05/06/07 配合工作：

  1) data_fallback.ensure_required_fields 补齐缺失字段
  2) 调用 domain must_run 工具产出统计上下文
  3) 当 hypothesis "营销首触 vs 非营销首触在『详情→列表回退次数』上是否有显著差异" 没有现成 snippet 覆盖时
     → 进入 ad-hoc：写 spec → run_adhoc → attach_evidence
  4) self_critique 跑闭环，非空则按 issue.suggested_fix 修订
  5) event_logger 全程记录决策轨迹 → state["_decision_trace"]

用法：
    python -m marketing_audit_skill.cli prepare --data <csv> --meta <meta.json> --out ./out
    python -m marketing_audit_skill.cli compute-thresholds --data <csv> --state ./out/state_partial.json --out ./out
    python marketing_audit_skill/examples/enrich_with_adhoc.py \\
        --in ./out/state_partial.json \\
        --data <parquet> \\
        --out ./out_adhoc
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd

from snippets import (
    adhoc_registry,
    adhoc_runner,
    data_fallback,
    event_logger,
    self_critique,
)


def main(state_path: Path, data_path: Path, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    log = event_logger.open_event_log(str(out_dir), fresh=True)

    state = json.loads(state_path.read_text(encoding="utf-8"))
    df = pd.read_parquet(data_path)

    # ── Step A — data_fallback：自主补齐 ──────────────────────────────────
    df, fb_caveats = data_fallback.ensure_required_fields(df, mode="all")
    state.setdefault("data_caveats", []).extend(fb_caveats)
    for c in fb_caveats:
        log.log_decision(
            tool_id="data_fallback",
            kind="fallback",
            reason=f"派生 {c['field']}",
            fallback_used=c.get("fallback"),
        )

    # ── Step B — Hypothesis：营销首触是否影响详情→列表回退 ──────────────────
    hyp_id = "hyp_mkt_first_back"
    state.setdefault("hypotheses", []).append({
        "id": hyp_id,
        "question": "营销首触用户在 pre_back_to_list_cnt 上是否显著高于非营销首触？",
        "suspected_dims": ["funnel_diagnosis", "path_quality"],
        "priority": 4,
        "expected_evidence": "pre_is_marketing_first × pre_back_to_list_cnt 分组 + Welch t test",
        "status": "investigating",
        "evidence_ids": [],
        "finding_ids": [],
    })
    log.log_hypothesis(hyp_id, "营销首触 vs 非营销首触在『详情→列表回退次数』上是否有显著差异")

    # ── Step C — PROPOSE：现有 snippet 无法覆盖该交叉，进入 ad-hoc ──────────
    spec = {
        "name": "funnel_back_by_mkt_first",
        "purpose": f"验证 pre_is_marketing_first 在 pre_back_to_list_cnt 上的差异 ({hyp_id})",
        "created_for_hypothesis": hyp_id,
        "input_columns": ["pre_is_marketing_first", "pre_back_to_list_cnt", "is_converted"],
        "output_schema": {
            "pre_is_marketing_first": "int",
            "n": "int",
            "back_mean": "float",
            "cvr": "float",
        },
        "code": (
            "sub = df.dropna(subset=['pre_is_marketing_first', 'pre_back_to_list_cnt'])\n"
            "g = sub.groupby('pre_is_marketing_first')\n"
            "result = pd.DataFrame({\n"
            "    'n': g.size(),\n"
            "    'back_mean': g['pre_back_to_list_cnt'].mean(),\n"
            "    'cvr': g['is_converted'].mean() if 'is_converted' in sub.columns else g.size() * 0,\n"
            "}).reset_index()"
        ),
        "validation_checks": [
            "int(result['n'].sum()) <= int(df['pre_is_marketing_first'].notna().sum())",
            "bool(result['back_mean'].ge(0).all())",
        ],
        "severity_cap": "mid",
    }
    log.log_adhoc(tool_id="(pending)", stage="propose", name=spec["name"])
    log.log_decision(
        tool_id="adhoc_synthesis",
        kind="adhoc",
        reason="no_existing_tool: funnel.py 不输出 pre_is_marketing_first × pre_back_to_list_cnt 交叉",
    )

    # ── Step D — EXECUTE + VALIDATE ──────────────────────────────────────
    run = adhoc_runner.run_adhoc(spec, df)
    log.log_adhoc(
        tool_id=f"tool_{(run.get('code_hash') or '')[:8]}",
        stage="execute",
        name=spec["name"],
        code_hash=run.get("code_hash"),
        status=run.get("status"),
        errors=run.get("errors"),
    )

    if run["status"] == "validated":
        ev_id = adhoc_runner.attach_evidence(state, spec, run, hypothesis_id=hyp_id)
        log.log_adhoc(
            tool_id=f"tool_{run['code_hash'][:8]}",
            stage="attach",
            name=spec["name"],
            code_hash=run["code_hash"],
            status="validated",
        )

        recs = run["records"]
        row_mkt = next((r for r in recs if int(r["pre_is_marketing_first"]) == 1), None)
        row_org = next((r for r in recs if int(r["pre_is_marketing_first"]) == 0), None)
        if row_mkt and row_org:
            diff = row_mkt["back_mean"] - row_org["back_mean"]
            finding = {
                "id": "fnd_adhoc_01",
                "agent": "funnel_diagnosis",
                "signal": (
                    f"营销首触用户回退均值 {row_mkt['back_mean']:.2f} 次（n={int(row_mkt['n'])}），"
                    f"非营销首触 {row_org['back_mean']:.2f} 次（n={int(row_org['n'])}），差 {diff:+.2f} 次"
                ),
                "severity": "mid",
                "detail": (
                    f"pre_is_marketing_first=1 组 pre_back_to_list_cnt 均值 {row_mkt['back_mean']:.2f}，"
                    f"pre_is_marketing_first=0 组 {row_org['back_mean']:.2f}；"
                    f"营销首触 CVR={row_mkt['cvr']:.2%}，非营销={row_org['cvr']:.2%}。"
                    f"（数据：pre_is_marketing_first × pre_back_to_list_cnt，来源：临时工具 "
                    f"{spec['name']}，code_hash={run['code_hash'][:8]}）"
                ),
                "evidence_field": f"adhoc:{spec['name']}",
                "metric_refs": [{
                    "name": "back_mean_diff",
                    "value": round(diff, 3),
                    "n_total": int(row_mkt["n"] + row_org["n"]),
                    "source": f"adhoc:{spec['name']}",
                }],
            }
            state.setdefault("findings", []).append(finding)
            log.log_finding(finding["id"], finding["agent"], finding["signal"], finding["severity"])

            for h in state["hypotheses"]:
                if h["id"] == hyp_id:
                    h["status"] = "resolved"
                    h["finding_ids"].append(finding["id"])

        adhoc_registry.record_usage(
            spec, code_hash=run["code_hash"], campaign_id=state.get("campaign_id"),
        )
    else:
        print(f"[adhoc] failed at stage={run['stage']}: {run['errors']}")
        if run.get("fallback_hint"):
            print(f"        hint: {run['fallback_hint']}")

    # ── Step E — Self-Critique 闭环 ──────────────────────────────────────
    for round_no in (1, 2):
        issues = self_critique.critique(state)
        state["self_critique"] = issues
        summary = self_critique.summarize(issues)
        log.log_critique(round_no, summary)
        print(f"[critique r{round_no}] {summary}")
        if summary.get("error", 0) == 0:
            break
        # 在真实 Agent 里，按 issue.suggested_fix 修订 state；本示例只演示一轮决策

    # ── Step F — Promote 建议 ───────────────────────────────────────────
    suggestions = adhoc_registry.suggest_promotion(threshold=3)
    if suggestions:
        state["adhoc_promotion_suggestions"] = suggestions
        print(f"[promote] {len(suggestions)} ad-hoc 工具达到晋升阈值")

    # ── Step G — 落 decision_trace + state ─────────────────────────────
    event_logger.write_decision_trace(state, log)

    out_json = out_dir / "state_with_adhoc.json"
    out_json.write_text(
        json.dumps(state, ensure_ascii=False, indent=2, default=str),
        encoding="utf-8",
    )

    print(f"\n[ok] state → {out_json}")
    print(f"     events  → {log.path}")
    print(f"     adhoc_tools: {len(state.get('adhoc_tools', []))}")
    print(f"     adhoc_evidences: {len(state.get('adhoc_evidences', []))}")
    print(f"     findings: {len(state.get('findings', []))}")
    print(f"     decision_trace: {len(state.get('_decision_trace', []))} steps")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--in", dest="state_in", required=True, help="state_partial.json 路径")
    ap.add_argument("--data", required=True, help="原始 parquet 数据路径")
    ap.add_argument("--out", default="./report_test_adhoc", help="输出目录")
    args = ap.parse_args()
    main(Path(args.state_in), Path(args.data), Path(args.out))
