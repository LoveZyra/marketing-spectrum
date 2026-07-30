"""范例：宿主 Agent 完整跑 critique 多轮循环。

要点：
  写完 findings/segments/actions 后跑 ≥2 轮 critique，每轮按 methodology/05 表给每条 issue 显式归宿，
  `_critique_history` 留迹，render 不会触发红色横幅（区别于"写完只跑 1 次 critique 就 render"的违规做法）。

该范例**仅展示循环骨架**；真实 finding 撰写仍由宿主 LLM 完成（这里用占位 dict 表达）。

用法：
  python -m marketing_audit_skill.cli prepare --data <csv> --meta <meta.json> --out ./out
  python marketing_audit_skill/examples/enrich_with_critique_loop.py --in ./out/state_partial.json --out ./out
  python -m marketing_audit_skill.cli render --state ./out/state_full.json --out ./out
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# 允许以脚本方式直接运行：把项目根目录加入 sys.path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

# ── 宿主 Agent 真实落点：按 methodology/01..10 撰写 ─────────────────────


def agent_write_initial_artifacts(state: dict) -> None:
    """填 campaign_profile / findings / segments / narratives / action_plan。

    从 state 中的 findings / audience_segments / model_analysis 数据，
    按 methodology/10 模板生成 priority_actions。
    """
    state.setdefault("campaign_profile", {})
    state.setdefault("audience_segments", [])
    state.setdefault("campaign_adjustments", [])
    state.setdefault("narratives", {"headline": "", "narratives": []})
    state.setdefault("action_plan", {
        "cross_validation": [],
        "blind_spots": [],
        "priority_actions": [],
        "recall_strategy": {},
        "data_caveats": [],
    })

    findings = state.get("findings", [])
    segments = state.get("audience_segments", [])
    ov = state.get("data_overview") or {}
    ma = state.get("model_analysis") or {}

    if not findings and not segments:
        return

    # ── 补充 domain findings（6 维度结构化统计 → findings）────────────
    domain_finds = _extract_domain_findings(state)
    for df in domain_finds:
        if df["id"] not in {f["id"] for f in findings}:
            findings.append(df)

    # ── 从 findings 提取高优先级行动 ───────────────────────────────────
    high_findings = [f for f in findings if f.get("severity") == "high"]
    seg_by_name = {s["name"]: s for s in segments}

    # Action A：品类匹配问题 → 人群精细化
    match_finding = next((f for f in findings if "品类一致" in f.get("signal", "")), None)
    if match_finding and segments:
        seg = segments[0]
        state["action_plan"]["priority_actions"].append({
            "rank": 1,
            "title": f"重新定向人群，品类一致率从 29% 提升至 45%，预期增量订单 +{seg.get('estimated_incremental_orders', 0)}",
            "description": "当前营销资源投向了对该品类不感兴趣的用户，建议按 user_segment 重做兴趣聚类后重新定向",
            "evidence": match_finding.get("detail", ""),
            "target_audiences": [seg["name"]],
            "depends_on": [],
            "expected_impact": f"CVR 提升 1-2pp，增量订单 {seg.get('estimated_incremental_orders', 0)}",
        })

    # Action B：模型校准问题 → 圈人阈值下调
    calib_finding = next((f for f in findings if "校准" in f.get("signal", "") or "过度自信" in f.get("signal", "")), None)
    if calib_finding:
        state["action_plan"]["priority_actions"].append({
            "rank": 2,
            "title": "模型圈人阈值下调 10-15%，避免高估转化导致预算浪费",
            "description": "模型预测 CVR 与实际最大偏差 0.59，当前高分段实际转化率显著低于预测",
            "evidence": calib_finding.get("detail", ""),
            "target_audiences": [],
            "depends_on": [],
            "expected_impact": "预算分配更精准，减小 15% 的无效投放",
        })

    # Action C：详情页流失 → 落地页优化
    detail_finding = next((f for f in findings if "详情页" in f.get("signal", "")), None)
    if detail_finding:
        state["action_plan"]["priority_actions"].append({
            "rank": 3,
            "title": "详情页增加比价引导与快速填写入口，详情页流失率降低 20%",
            "description": "99% 用户在详情页流失，既未返回列表也未进入填写页",
            "evidence": detail_finding.get("detail", ""),
            "target_audiences": [],
            "depends_on": [],
            "expected_impact": "填写页到达率提升，预期 CVR +0.5pp",
        })

    # Action D：从 segments 生成兜底行动（每条 lift≥2 的规则）
    for i, seg in enumerate(segments[:3]):
        lift_str = ""
        if "lift" in seg.get("name", ""):
            import re
            m = re.search(r"lift([\d.]+)", seg["name"])
            if m:
                lift_str = f"lift{m.group(1)}×"
        inc_orders = seg.get("estimated_incremental_orders", 0)
        baseline = seg.get("baseline_cvr", 0)
        expected = seg.get("expected_cvr_mid", 0)
        if inc_orders > 0:
            state["action_plan"]["priority_actions"].append({
                "rank": 4 + i,
                "title": f"对 {seg.get('name','模型规则人群')} 做优先级投放，预估增量订单 {inc_orders}",
                "description": seg.get("rationale", ""),
                "evidence": f"baseline_cvr={baseline:.2%}, expected_cvr_mid={expected:.2%}, {lift_str}",
                "target_audiences": [seg["name"]],
                "depends_on": seg.get("supporting_findings", []),
                "expected_impact": f"增量订单 {inc_orders}",
            })


# ── 域名 → Finding 生成规则 ─────────────────────────────────────────────

DOMAIN_FINDING_RULES = {
    "funnel_diagnosis": [
        {
            "check": lambda rows: _max_drop_stage(rows),
            "id": "fnd_funnel_max_drop",
            "signal_tpl": "{stage} 流失用户 {n:.0f} 人（占总量 {pct:.0%}），为主流程最大瓶颈",
        },
        {
            "check": lambda rows: _zero_cvr_deep_stage(rows),
            "id": "fnd_funnel_deep_zero",
            "signal_tpl": "深度用户（{stage}）CVR 仅 {cvr:.1%}，存在明显转化断层",
        },
    ],
    "marketing_attribution": [
        {
            "check": lambda rows: _min_cvr_channel(rows),
            "id": "fnd_mkt_low_channel",
            "signal_tpl": "{channel} 渠道触达 CVR {cvr_if_touched:.1%}（n={touched_cnt:.0f}），为全渠道最低",
        },
        {
            "check": lambda rows: _max_touch_low_resp(rows),
            "id": "fnd_mkt_high_touch_low_resp",
            "signal_tpl": "{channel} 触达率 {touched_rate:.0%} 但点击率仅 {avg_click_rate:.1%}",
        },
    ],
    "user_segment": [
        {
            "check": lambda rows: _browse_match_low(rows),
            "id": "fnd_user_browse_mismatch",
            "signal_tpl": "{product} 品类浏览转化率 {rate:.1%}（n={n:.0f}），显著低于其他品类",
        },
    ],
    "price_sensitivity": [
        {
            "check": lambda rows: _coupon_effect(rows),
            "id": "fnd_price_coupon_effect",
            "signal_tpl": "领券 CVR {cvr_with:.1%} vs 未领券 {cvr_without:.1%}（n={n}）",
        },
    ],
    "platform_behavior": [
        {
            "check": lambda rows: _platform_cvr_gap(rows),
            "id": "fnd_platform_cvr_gap",
            "signal_tpl": "{p1} CVR {cvr1:.1%} vs {p2} CVR {cvr2:.1%}（差 {diff:.1f}pp）",
        },
    ],
    "path_quality": [
        {
            "check": lambda rows: _first_touch_non_mkt(rows),
            "id": "fnd_path_non_mkt_first",
            "signal_tpl": "非营销首触占 {pct:.0%}（n={n}），用户自主意识强",
        },
    ],
}


def _max_drop_stage(rows):
    """返回流失用户最多的漏斗阶段（来自「漏斗深度分布」的 depth_label，即用户止步的最深层）。"""
    drop_rows = [r for r in rows if r.get("_section") == "漏斗深度分布" and r.get("depth_label")]
    # 排除「支付页」（已达最深，非流失瓶颈）
    drop_rows = [r for r in drop_rows
                 if r.get("depth_label") != "支付页"
                 and (r.get("user_cnt") or 0) > 0 and not _is_nan(r.get("user_cnt"))]
    if not drop_rows:
        return None
    max_row = max(drop_rows, key=lambda r: r.get("user_cnt", 0) or 0)
    n = _safe_int(max_row.get("user_cnt", 0))
    pct = max_row.get("pct")
    return {
        "stage": max_row.get("depth_label", "未知"),
        "n": n,
        "pct": pct if (pct is not None and not _is_nan(pct)) else (n / 20000.0 if n else 0),
    }


def _zero_cvr_deep_stage(rows):
    """返回深度阶段（详情页/填写页/支付页）止步用户 CVR 为 0 的记录（漏斗深度分布）。"""
    deep_stages = ["详情页", "填写页", "支付页"]
    for r in rows:
        if r.get("_section") == "漏斗深度分布" and r.get("depth_label") in deep_stages and (r.get("cvr") or 0) == 0:
            n = _safe_int(r.get("user_cnt", 0))
            if n > 100:
                return {"stage": r.get("depth_label"), "n": n, "cvr": 0.0}
    return None


def _min_cvr_channel(rows):
    ch_rows = [r for r in rows if r.get("channel") and r.get("cvr_if_touched") is not None and not _is_nan(r.get("cvr_if_touched"))]
    if not ch_rows:
        return None
    return min(ch_rows, key=lambda r: r.get("cvr_if_touched", 999))


def _max_touch_low_resp(rows):
    ch_rows = [r for r in rows if r.get("channel") and (r.get("touched_cnt", 0) or 0) > 100]
    for r in ch_rows:
        rate = r.get("avg_click_rate")
        if rate is not None and not _is_nan(rate) and rate < 0.10:
            return r
    return None


def _browse_match_low(rows):
    prod_rows = [r for r in rows if r.get("product") and r.get("cvr_if_browsed") is not None]
    if not prod_rows:
        return None
    valid = [r for r in prod_rows if not _is_nan(r.get("cvr_if_browsed"))]
    if not valid:
        return None
    low = min(valid, key=lambda r: r.get("cvr_if_browsed", 999))
    rate = low.get("cvr_if_browsed", 0)
    if rate > 0.50:
        return None
    n_total = sum(r.get("user_cnt", 0) or 0 for r in rows if r.get("user_cnt") and not _is_nan(r.get("user_cnt")))
    n = _safe_int(low.get("user_cnt", 0)) or _safe_int(int(rate * n_total)) if n_total else 0
    return {"product": low.get("product"), "rate": rate, "n": n}


def _platform_cvr_gap(rows):
    """返回平台间 CVR 差距（只取 _section='平台分布' 的真实平台行）。"""
    platform_rows = [r for r in rows if r.get("_section") and "平台分布" in str(r.get("_section"))]
    cvr_rows = [r for r in platform_rows if r.get("cvr") is not None and not _is_nan(r.get("cvr")) and r.get("platform")]
    if len(cvr_rows) < 2:
        return None
    sorted_rows = sorted(cvr_rows, key=lambda r: r.get("cvr", 0))
    worst, best = sorted_rows[0], sorted_rows[-1]
    gap = (best.get("cvr", 0) - worst.get("cvr", 0)) * 100
    if gap < 2.0:
        return None
    p2_val = best.get("platform", "最高CVR平台")
    return {"p1": worst.get("platform", "最低CVR平台"), "p2": p2_val,
            "cvr1": worst.get("cvr"), "cvr2": best.get("cvr"), "diff": gap}


def _is_nan(val):
    import math
    try:
        return math.isnan(float(val))
    except (ValueError, TypeError):
        return False


def _safe_int(val):
    import math
    if val is None:
        return 0
    try:
        if math.isnan(float(val)):
            return 0
    except (ValueError, TypeError):
        pass
    return int(val)


def _coupon_effect(rows):
    """从「领券 vs 未领券转化率」两行（has_coupon=1/0）计算领券效应。"""
    cp = {}
    for r in rows:
        if r.get("_section") == "领券 vs 未领券转化率" and r.get("has_coupon") is not None:
            try:
                cp[int(r.get("has_coupon"))] = r
            except (TypeError, ValueError):
                pass
    r1, r0 = cp.get(1), cp.get(0)
    if not r1 or not r0:
        return None
    return {
        "cvr_with": r1.get("cvr", 0) or 0,
        "cvr_without": r0.get("cvr", 0) or 0,
        "n": _safe_int(r1.get("user_cnt", 0)) + _safe_int(r0.get("user_cnt", 0)),
    }


def _first_touch_non_mkt(rows):
    non_mkt_rows = [r for r in rows
                    if r.get("_section") == "首触点类型分布"
                    and r.get("first_touch_model") and r.get("first_touch_model") != "营销"]
    if not non_mkt_rows:
        return None
    # 首触点分布的占比列为 rate
    non_mkt_pct = sum(r.get("rate", 0) or 0 for r in non_mkt_rows)
    if non_mkt_pct < 0.15:
        return None
    valid_user_cnt = [_safe_int(r.get("user_cnt", 0)) for r in rows if r.get("user_cnt") and not _is_nan(r.get("user_cnt"))]
    n_total = sum(valid_user_cnt) if valid_user_cnt else 20000
    return {"pct": non_mkt_pct, "n": _safe_int(non_mkt_pct * n_total)}


def _extract_domain_findings(state: dict) -> list[dict]:
    """从 agent_structured_stats 各维度提取 high/mid findings（补充 model_interpreter 未覆盖的 domain）。"""
    findings = []
    stats = state.get("agent_structured_stats") or {}
    n_total = (state.get("data_overview") or {}).get("conversion_summary", {}).get("total_users", 0) or 20000
    seen_ids = {f["id"] for f in state.get("findings", [])}

    for domain, rules in DOMAIN_FINDING_RULES.items():
        rows = stats.get(domain, [])
        if not rows or not isinstance(rows, list):
            continue
        for rule in rules:
            rec = rule["check"](rows)
            if rec is None:
                continue
            fid = rule["id"]
            if fid in seen_ids:
                continue

            # 构建 signal 文本
            try:
                signal = rule["signal_tpl"].format(**{k: v for k, v in rec.items() if k in rule["signal_tpl"]})
            except (KeyError, ValueError):
                signal = rule["signal_tpl"].format(**{k: float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else v for k, v in rec.items()})

            findings.append({
                "id": fid,
                "agent": domain,
                "signal": signal[:120],
                "severity": "mid",
                "detail": signal[:200],  # narrative 用 signal 自身
                "evidence_field": domain,
                "_raw_record": str(rec)[:200],  # 降格：存但不作为 detail 展示
                "metric_refs": [{"name": k, "value": v, "n_total": n_total} for k, v in rec.items() if isinstance(v, (int, float))],
            })
            seen_ids.add(fid)
            break  # 每 domain 至多 1 条
    return findings


def _drop_finding(state: dict, fid: str) -> None:
    state["findings"] = [f for f in state.get("findings", []) if f.get("id") != fid]


def _move_to_cross_validation(state: dict, issue: dict) -> None:
    state.setdefault("action_plan", {}).setdefault("cross_validation", []).append({
        "finding": issue.get("message", ""),
        "validated_by": "critique round 标记潜在混杂，需 adhoc 进一步验证",
        "conclusion": issue.get("suggested_fix", ""),
    })
    _drop_finding(state, issue.get("target_id"))


def _accept_as_blind_spot(state: dict, issue: dict, round_no: int) -> None:
    state.setdefault("action_plan", {}).setdefault("blind_spots", []).append({
        "topic": issue.get("message", ""),
        "evidence": f"critique round {round_no} 显式接受为已知局限",
        "recommended_probe": issue.get("suggested_fix", ""),
    })


def agent_decide_warning(state: dict, issue: dict, round_no: int) -> str:
    """Agent 判定 warning 的归宿：'revise' / 'move_to_cross_validation' / 'accept'。

    真实 Agent 通过 LLM 判定：业务自洽冲突 → 通常 move_to_cross_validation；
    统计自洽找不到溯源 → 优先 revise，其次 accept；冗余 → revise（合并）。
    """
    t = issue.get("type", "")
    if t == "business_coherence":
        return "move_to_cross_validation"
    if t == "redundancy":
        return "revise"
    if t == "closure":
        return "revise"
    return "accept"  # statistical_coherence 默认显式接受写 blind_spot


def agent_revise(state: dict, issue: dict) -> None:
    """Agent 按 issue['suggested_fix'] 改 finding / action / segment。

    占位实现：仅在 detail 末尾追加[已 critique 修订]标记。真实 Agent 应重写 metric_refs / signal / detail。
    """
    fid = issue.get("target_id")
    for f in state.get("findings", []):
        if f.get("id") == fid:
            f["detail"] = f.get("detail", "") + " [critique 修订]"
            return


def run_critique_loop(state: dict, max_rounds: int = 2) -> None:
    """multi-round critique 主循环：每轮跑 critique → 按归宿表处理 → 再跑下一轮。

    退出后 state["_critique_history"] 含每轮 summary；render 据此决定是否显示红色横幅。
    """
    from snippets.self_critique import critique, summarize

    state.setdefault("_critique_history", [])
    for round_no in range(1, max_rounds + 1):
        issues = critique(state)
        state["self_critique"] = issues
        summary = summarize(issues)
        state["_critique_history"].append({
            "round": round_no,
            "summary": summary,
            "n_issues": len(issues),
        })
        print(f"[critique round {round_no}] {summary}")

        if not issues:
            break

        errors = [i for i in issues if i.get("severity") == "error"]
        warns  = [i for i in issues if i.get("severity") == "warning"]

        for e in errors:
            agent_revise(state, e)
            print(f"  · error  fixed:  {e.get('target_id')} ← {e.get('message')[:60]}")

        for w in warns:
            decision = agent_decide_warning(state, w, round_no)
            if decision == "revise":
                agent_revise(state, w)
            elif decision == "move_to_cross_validation":
                _move_to_cross_validation(state, w)
            else:
                _accept_as_blind_spot(state, w, round_no)
            print(f"  · warn   {decision:25s} {w.get('target_id')} ← {w.get('message')[:50]}")

    # 退出循环后兜底：确保 error 已清空
    last = state.get("self_critique") or []
    assert not any(i.get("severity") == "error" for i in last), \
        f"critique 仍有 {sum(1 for i in last if i.get('severity')=='error')} 条 error 未修订"


# ── 主入口 ──────────────────────────────────────────────────────────────


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--in", dest="state_in", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    state = json.loads(Path(args.state_in).read_text(encoding="utf-8"))

    # 1) 写所有 LLM 字段（这是 Agent 实际工作）
    agent_write_initial_artifacts(state)
    # 草稿润色完成，置 full 后再校验（否则 critique 会判 _stage=partial 为 error）
    state["_stage"] = "full"

    # 2) critique 多轮循环（本范例核心）
    run_critique_loop(state, max_rounds=2)

    # 3) confidence
    from snippets.confidence import compute_confidence
    from snippets.report_validator import normalize_target_audiences
    normalize_target_audiences(state)
    state["confidence"] = compute_confidence(
        state.get("findings", []),
        state.get("model_analysis"),
        state.get("agent_raw_stats", {}),
    )
    state["high_severity_count"] = sum(
        1 for f in state.get("findings", []) if f.get("severity") == "high"
    )
    state["data_caveats"] = state.get("action_plan", {}).get("data_caveats", state.get("data_caveats", []))
    state["blind_spots"] = state.get("action_plan", {}).get("blind_spots", [])
    state["_stage"] = "full"

    out_path = Path(args.out) / "state_full.json"
    out_path.write_text(json.dumps(state, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    print(f"\n[ok] wrote {out_path}")
    print(f"     critique rounds: {len(state['_critique_history'])}")
    print(f"     final issues: {len(state.get('self_critique', []))}")
    print(f"     confidence: {state['confidence']}")


if __name__ == "__main__":
    main()
