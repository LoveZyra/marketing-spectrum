# 00 — 整体流程与角色拆分

## 流程图

```
┌──────────────────────────────────────────────────────────────────┐
│  Step 0  campaign_profile                                        │
│    输入: campaign_meta (dict)                                     │
│    产出: { config_summary, design_issues[], target_vs_actual }    │
│    方法: methodology/01_campaign_profile.md                       │
│    LLM: 是（宿主 Agent 按设计缺陷清单自检）                          │
│    CLI: 无（纯 LLM 步骤）                                          │
├──────────────────────────────────────────────────────────────────┤
│  Step 1  data_overview（CLI: prepare）                           │
│    输入: df（tmp_ctj_mktv2_final，用户-活动粒度）                   │
│    产出: 12 维全量描述统计 + feature coverage report               │
│    代码: snippets/data_overview.py + snippets/feature_loader.py   │
│    LLM: 否                                                        │
│    注意: diagnostic_engine 在 Step 1b 后注入，首次 prepare 暂为 None│
├──────────────────────────────────────────────────────────────────┤
│  Step 1b  compute-thresholds（CLI: compute-thresholds）          │
│    输入: df + state_partial.json                                  │
│    产出: state["adaptive_thresholds"]（CVR 驱动，31 条规则触发率）  │
│          thresholds_report.md（可读版本，供 Agent 参考）            │
│    方法: methodology/09_adaptive_thresholds.md                    │
│    代码: snippets/threshold_computer.py + snippets/diagnostic_engine.py│
│    LLM: 否                                                        │
│    ★ 必须在 Step 2/3 之前运行，阈值计算完成才能开始诊断             │
├──────────────────────────────────────────────────────────────────┤
│  Step 2  model_analysis（由 prepare 自动跑；--no-model 可跳过）   │
│    输入: df                                                      │
│    产出: { auc, top_features[], decision_rules[], ... }           │
│    方法: methodology/02_model_analysis.md                         │
│    代码: snippets/model_analyst.py + model_interpreter.py         │
│    LLM: 仅在解读 top_features 时                                  │
├──────────────────────────────────────────────────────────────────┤
│  Step 3  domain × 6（CLI: prepare 已自动跑完）                    │
│    funnel_diagnosis / marketing_attribution / user_segment        │
│    price_sensitivity / platform_behavior / path_quality           │
│    产出: state["agent_raw_stats"] + state["agent_structured_stats"]│
│    ★ 各维度统计为统计上下文，供 Agent 为诊断规则 findings 生成叙述   │
│    LLM: 仅在为已触发规则生成叙述 detail 时（参见 Step 3b）          │
├──────────────────────────────────────────────────────────────────┤
│  Step 3b  诊断规则（结果已在 Step 1b 写入 state）                 │
│    产出: 31 条规则触发率 + 成单率(is_paid)CVR 对比（创单率作过程指标）│
│    方法: methodology/08_diagnostic_rules.md                       │
│    代码: snippets/diagnostic_engine.py                            │
│    LLM: 是（按 methodology/08 为触发规则生成 findings）            │
│    注意: 读 thresholds_report.md 了解规则触发详情                  │
├──────────────────────────────────────────────────────────────────┤
│  Step 3c  draft（CLI: draft，推荐）                              │
│    输入: state（compute-thresholds 后）                           │
│    产出: state_draft.json 骨架（findings/segments/narratives+      │
│          typical_case/actions），覆盖全部 effective 主题组          │
│    代码: snippets/draft_builder.py                                │
│    LLM: 否（Agent 随后润色 [待润色] 文案、置 _stage=full）          │
├──────────────────────────────────────────────────────────────────┤
│  Step 3.7  self_critique（CLI: run-tools self_critique）          │
│    输入: state                                                    │
│    产出: issues（漏诊覆盖/统计自洽/符号/闭环/语言/渲染健康…）        │
│    方法: methodology/05_self_critique.md                          │
│    代码: snippets/self_critique.py                                │
│    LLM: 是（响应 issues 并修订）                                   │
├──────────────────────────────────────────────────────────────────┤
│  Step 4  synthesize（润色 draft → _stage=full）                  │
│    方法: methodology/03_synthesis.md                              │
│    LLM: 是（必须遵守禁用词清单 + 强制 title 模板）                   │
├──────────────────────────────────────────────────────────────────┤
│  Step 5  confidence                                              │
│    代码: snippets/confidence.py                                   │
│    注意: data_coverage = 0.5×domain_coverage + 0.5×rule_coverage  │
│          rule_coverage = 有效评估规则数 / 41                        │
├──────────────────────────────────────────────────────────────────┤
│  Step 6  落盘（CLI: render）                                      │
│    diagnosis_report.json / .md / .html                            │
└──────────────────────────────────────────────────────────────────┘
```

## 角色拆分

| 概念 | 本 skill 的实现 |
|---|---|
| 流程编排 | 宿主 Agent 按 `SKILL.md` 的 Step 0..6 顺序执行 |
| 主诊断源 | `DiagnosticEngine` 的 31 条规则（Step 3b）：最优切分用创单率(is_converted)、CVR对比/有效信号/严重度/展示用成单率(is_paid) |
| 统计上下文 | 6 个 domain snippets（Step 3），提供分布统计供叙述引用。**CVR 均为创单率(is_converted)过程口径**，不展示；引用时须显式标"创单率"，不得当作成单率混入问题卡 |
| 诊断记忆 | 宿主 Agent 自行维护 `findings` 列表，跨 Step 时携带 |
| 自生成工具 | 现有 snippet 不满足时进入 `methodology/07_adhoc_tools.md` 流程 |
| LLM 调用 | 宿主 Agent 自己就是 LLM |
| 报告渲染 | `snippets/report_renderer.py` 纯模板函数 |

## 中间产物的数据契约

宿主 Agent 在 Step 间应维护一个 `state` dict：

```python
state = {
    "_stage": "partial" | "full",    # CLI 产物总是 partial；宿主 Agent 补完 LLM 步骤后改 full
    "campaign_id": "...",
    "campaign_profile": { ... },     # Step 0 产出
    "data_overview": { ... },        # Step 1 产出（含 diagnostic_rules_summary）
    "adaptive_thresholds": { ... },  # Step 1b 产出（CVR 驱动阈值，参见 methodology/09）
    "model_analysis": { ... } | None,# Step 2 产出
    "agent_raw_stats": {             # Step 3 每维度 snippet 的字符串摘要（按 _section 拆分）
        "funnel_diagnosis": {
            "漏斗深度分布":    "...",  # dict[section_name → 字符串]
            "各阶段到达率":    "...",
            "触达前决策周期":  "...",
            "逐层漏斗转化率":  "..."
        },
        "marketing_attribution": { ... },
        ...
    },
    "agent_structured_stats": {      # Step 3 同维度 records 形态（list[dict]，程序化用）
        "funnel_diagnosis": [{"pre_max_funnel_depth": 3, "user_cnt": 21, "cvr": 0.0, "_section": "漏斗深度分布"}, ...],
        ...
    },
    "findings": [ ... ],             # Step 3b 累积，schemas/finding.schema.json
    "audience_segments": [ ... ],    # 累积，schemas/audience_segment.schema.json
    "campaign_adjustments": [ ... ],
    "narratives": { ... },           # Step 4 产出
    "action_plan": { ... },          # Step 4 产出
    "confidence": { ... },           # Step 5 产出
}
```

> `agent_raw_stats[<dim>]` 是 `dict[section → str]`，便于直接塞进 LLM prompt 做"引证"；
> `agent_structured_stats[<dim>]` 是 `list[dict]`（records），便于 Python 代码直接索引、再加工。
> 写 finding 时，建议从 `agent_structured_stats` 读数字，从 `agent_raw_stats` 复制片段做证据展示。

## 收敛与覆盖

- **31 条规则全量评估**：Step 1b 已自动完成，Agent 从 `state["data_overview"]["diagnostic_rules_summary"]` 读结果。
- **domain 统计强制覆盖**：6 个维度必须全跑（Step 1 已自动完成），`data_coverage` 的 domain 部分会核查。
- **高严重度兜底**：若整轮跑完 `findings` 中 `severity=='high'` 的条数 < 3，在 Step 4 的 synthesize 阶段基于 evidence 补写。
- **统计显著性硬约束**：
  - `p_value > 0.05` → severity 降一级，finding.detail 追加"组间差异不显著 (p=X)"
  - `n_total < 30` → confidence ≤ 0.6；`n_total < 100` → confidence ≤ 0.75
  - 工具：`snippets/stats_utils.py` 提供 `wilson_ci / chi2_test / welch_t_test / severity_from_pvalue`

> 接下来按顺序阅读 `01..09` 各份 methodology。
