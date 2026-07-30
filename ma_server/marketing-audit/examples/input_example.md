# 输入示例

## 1. 数据文件

```
d:\data\user_activity_features_20260505.parquet
```

含 `is_converted` / `is_paid` 列的用户-活动宽表，每行 = 一个用户被一个活动触达的记录。常见字段族（触达前行为加 `pre_` 前缀）：

- 漏斗类：`pre_max_funnel_depth / pre_target_product_funnel_depth / pre_skip_detail_flag / pre_back_to_list_cnt / pre_back_to_booking_cnt`
- 营销类：`pre_*_touch_cnt / pre_*_click_rate / pre_last_mkt_channel / pre_mkt_trigger_mainflow_cnt / pre_mkt_fatigue_cnt`
- 品类类：`pre_browse_* / pre_*_depth / pre_top_interest_product / pre_mkt_product_browse_match`
- 优惠类：`pre_coupon_collect_cnt / pre_rp_hotel / pre_rp_flight / pre_rp_target_product / pre_last_coupon_product`
- 平台类：`pre_primary_platform / pre_app_event_cnt / pre_is_cross_platform / pre_first_active_period`
- 路径类：`pre_first_touch_model / pre_last_touch_model / pre_path_model_seq / pre_search_match_target`
- 会员类：`pre_viewed_member_assets / pre_black_whale_interest / pre_checkin_triggered`

## 2. campaign_meta

```json
{
  "campaign_id":          "campaign_20260505",
  "campaign_name":        "五一大促",
  "campaign_type":        "大促",
  "start_date":           "2026-05-01",
  "end_date":             "2026-05-07",
  "target_products":      ["酒店", "机票"],
  "target_channels":      ["push", "sms", "insite_msg"],
  "target_audience":      "近90天有酒店/机票浏览但未下单的用户",
  "target_platform":      "全平台",
  "discount_type":        "满减",
  "discount_value":       "满300减50",
  "coupon_validity_h":    24,
  "target_cvr":           0.12,
  "target_response_rate": 0.15,
  "benchmark_cvr":        0.10,
  "benchmark_response_rate": 0.13,
  "last_campaign_issues": "上次大促 push 响应率偏低，酒店品类转化不及预期"
}
```

## 3. 输出目录

```
./memory_cache/campaign_20260505/
```

诊断完成后会生成：

- `diagnosis_report.json`
- `diagnosis_report.md`
- `diagnosis_report.html`

## 4. 宿主 Agent 串起来的最小例子（路由驱动）

> 启用 `TOOLS_MANIFEST.json` + methodology/14/15/16 后，宿主 Agent 读 manifest 自主路由：
> 每步前评估 preconditions、缺数据走 fallback、需要 A×B 交叉走临时工具、写完后跑反思环。
>
> 完整端到端可执行参考见 [`examples/enrich_with_adhoc.py`](enrich_with_adhoc.py)。

```python
import json, pandas as pd
from pathlib import Path

from marketing_audit_skill.snippets import (
    data_fallback, data_overview, model_analyst,
    self_critique, adhoc_runner, adhoc_registry, event_logger, confidence,
    report_renderer, report_validator,
)
from marketing_audit_skill.snippets.funnel import analyze_funnel
from marketing_audit_skill.snippets.attribution import analyze_attribution
# ...其余 4 个 domain analyzers 同理

out_dir = Path("./memory_cache/campaign_20260505")
out_dir.mkdir(parents=True, exist_ok=True)
log = event_logger.open_event_log(str(out_dir), fresh=True)

df = pd.read_parquet("data.parquet")
state = {
    "campaign_id": campaign_meta["campaign_id"],
    "campaign_profile": ...,
    "agent_raw_stats": {},
    "agent_structured_stats": {},
    "findings": [],
    "audience_segments": [],
    "campaign_adjustments": [],
    "hypotheses": [],
    "data_caveats": [],
}

# ── A. 自主补齐缺失字段（methodology/15） ─────────────────────────
df, caveats = data_fallback.ensure_required_fields(df, mode="all")
state["data_caveats"].extend(caveats)
for c in caveats:
    log.log_decision(tool_id="data_fallback", kind="fallback",
                     reason=f"派生 {c['field']}", fallback_used=c.get("fallback"))

# ── B. data_overview + 6 domain（按 TOOLS_MANIFEST 路由） ───────
manifest = json.loads(Path("marketing_audit_skill/TOOLS_MANIFEST.json").read_text(encoding="utf-8"))
state["data_overview"] = data_overview.compute_data_overview(df, campaign_id=state["campaign_id"])
log.log_decision(tool_id="data_overview", kind="invoke", reason="must_run")

ma = model_analyst.run_model_analysis(df)
state["model_analysis"] = ma.to_dict() if ma else None
log.log_decision(
    tool_id="model_analysis",
    kind="invoke" if ma else "skip",
    reason="preconditions_ok" if ma else "lib_or_label_unavailable",
)

for name, fn in [
    ("funnel_diagnosis",     analyze_funnel),
    ("marketing_attribution", analyze_attribution),
    # ... 其余 4 个
]:
    df_stats = fn(df)
    state["agent_raw_stats"][name] = {
        sec: g.drop(columns=["_section"]).to_string(max_rows=30)
        for sec, g in df_stats.groupby("_section")
    }
    state["agent_structured_stats"][name] = df_stats.to_dict("records")
    log.log_decision(tool_id=f"domain_{name}", kind="invoke", reason="must_run")
    # Agent 按阈值表判定 severity → 写 findings/segments/adjustments

# ── C. 临时工具补强（methodology/07） ────────────────────────────

# 假设：现有 snippet 无法回答"营销首触 × 详情页回退"，进入 ad-hoc
spec = {
    "name": "funnel_back_by_mkt_first",
    "purpose": "验证 is_marketing_first 在 back_to_list_from_detail 上的差异 (hyp_b9c1f)",
    "created_for_hypothesis": "hyp_b9c1f",
    "input_columns": ["is_marketing_first", "back_to_list_from_detail", "is_converted"],
    "output_schema": {"is_marketing_first": "int", "n": "int", "back_rate": "float"},
    "code": (
        "g = df.groupby('is_marketing_first')\n"
        "result = pd.DataFrame({'n': g.size(), 'back_rate': g['back_to_list_from_detail'].mean()}).reset_index()"
    ),
    "validation_checks": ["bool(result['back_rate'].between(0, 1).all())"],
}
run = adhoc_runner.run_adhoc(spec, df)
log.log_adhoc(tool_id=f"tool_{(run.get('code_hash') or '')[:8]}", stage="execute",
              name=spec["name"], status=run["status"], errors=run.get("errors"))
if run["status"] == "validated":
    adhoc_runner.attach_evidence(state, spec, run, hypothesis_id="hyp_b9c1f")
    adhoc_registry.record_usage(spec, code_hash=run["code_hash"],
                                campaign_id=state["campaign_id"])

# ── D. Self-Critique 反思环（methodology/14），最多 2 轮 ─────────
for round_no in (1, 2):
    issues = self_critique.critique(state)
    state["self_critique"] = issues
    log.log_critique(round_no, self_critique.summarize(issues))
    if not any(i["severity"] == "error" for i in issues):
        break
    # Agent 按 issue.suggested_fix 修订 state.findings / action_plan / segments

# ── E. 写 narratives + action_plan、置信度、落盘 ──────────────────
state["narratives"] = ...      # methodology/10
state["action_plan"] = ...
state["confidence"] = confidence.compute_confidence(
    state["findings"], state.get("model_analysis"), state["agent_raw_stats"]
)
state["_stage"] = "full"

event_logger.write_decision_trace(state, log)   # → state["_decision_trace"]
report_validator.normalize_target_audiences(state)
paths = report_renderer.save_report(state, output_dir=str(out_dir))
print(paths)                                     # {"json": ..., "md": ..., "html": ...}
print("decision_trace:", len(state["_decision_trace"]), "steps")
print("events.jsonl:  ", log.path)
```

### 关键能力索引

| 能力 | 实现 | 触发时机 |
|---|---|---|
| 自主决策步骤 | `TOOLS_MANIFEST.json` + Agent 读 preconditions / postconditions | 每次工具调用前 |
| 缺数据回退 | `data_fallback.ensure_required_fields` | 流程最开始，结果写 `state.data_caveats` |
| 反思决策合理性 | `self_critique.critique` + 最多 2 轮迭代 | findings/action_plan 写完后 |
| 现有工具不够时自生成 | `adhoc_runner.run_adhoc` + 沙箱 AST 检查 + `validation_checks` | hypothesis 缺证据且 manifest 无匹配 |
| 决策可审计 | `event_logger.log_decision/log_adhoc/log_critique` → `_decision_trace` | 每次决策落事件 |
