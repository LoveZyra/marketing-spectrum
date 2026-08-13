# 05 — Self-Critique 反思环

> 在 Step 3 末（findings/segments/adjustments 都写完后）和 Step 4 末（narratives/action_plan 写完后）各跑一次。
> 输出 `state["self_critique"]`：list[issue]；非空时 Agent **必须按下表给每条 issue 一个归宿**后再跑一次，最多迭代 2 轮。

## 目标语义：评估当前轮之前的诊断结果

Self-Critique 不是另写一份总结，而是对**截至当前轮次开始前**已经存在的诊断结果做质量裁决：

1. 对每条 `finding`、`audience_segment`、`priority_action` 生成 `assessment`。
2. `assessment.status` 只能是：
   - `accepted`：证据、业务方向、去重和行动闭环都通过，可进入综合。
   - `questioned`：命中明确 issue，必须修订、移位、显式接受为局限，或复诊。
   - `pending`：事实层证据不足，暂不能接受也不能否定，必须补证据。
3. `questioned` 中被 Agent 判定为**不接受当前结论**的项目，不得只改文字；必须按 `rediagnosis_plan` 调用已有工具，或在现有工具粒度不足时调用 `adhoc_synthesis` 自定义临时工具重新诊断。
4. 每次复诊写回 state 后，重新运行 `assess/critique`。只有所有 `error` 清空，且剩余 warning 已有明确归宿，才能 synthesize / render。

推荐代码入口：

```python
from marketing_audit_skill.snippets.self_critique import assess, summarize_assessments

assessments = assess(state)
state["_critique_history"].append({
    "round": round_no,
    "assessment_summary": summarize_assessments(assessments),
    "summary": summarize(state["self_critique"]),
})
```

## ⚠ 硬阻塞规则（先看这条）

**渠道词汇违规是最高优先级阻塞**：`cli render` 若检测到 findings/narratives 中含有当前渠道不存在的专属词汇（如 activity 渠道却出现"广告用户/广告流量"），会退出码=3 并打印 `REWRITE_REQUIRED` 修正指令。Agent 必须先修复所有渠道词汇违规、再重新 render，不得使用 `--allow-channel-lint` 绕过。

**Agent 不得在 critique 输出非空时直接进入 render**。即使全是 warning，也必须按下表显式归宿：

| issue 严重度 | 归宿（必选其一） | 写入位置 |
|---|---|---|
| `error` | 修订对应 finding/action/segment | 原位置 |
| `warning` (statistical_coherence) | (a) 重算 metric_refs.value 写回；或 (b) 把该指标改引 `agent_raw_stats[dim]` 字符串片段；或 (c) 显式接受并写入 `data_caveats` 说明原值不可溯源 | finding 原位 / data_caveats |
| `warning` (business_coherence) | (a) 把 finding 移到 `action_plan.cross_validation` 并标"潜在混杂"；或 (b) 移到 `blind_spots`；**不得**保留为独立 high severity finding | action_plan |
| `warning` (redundancy) | 合并到留下的那条，其余 drop | findings |
| `warning` (closure) | 修 priority_actions 直到引用真实人群/字段 | action_plan |
| `warning` (language_compliance) | 用 LLM-revise 改写违规文本（规则编号→中文名、AUC→转化预测准确率、禁用词→合规表述） | finding/narrative/action 原位 |

**第二轮 critique 跑完后**：仍非空的 warning 必须**显式列入 `state["action_plan"]["blind_spots"]`**（含 issue.target_id、issue.message、为什么决定保留），否则视为流程违规。Confidence.evidence_depth 自动 ×0.8 折扣。

## 不接受项的复诊路由

`self_critique.critique` 会给每个 issue 附加 `rediagnosis_plan`：

| issue 类型 | 默认复诊工具 | fallback | 处理原则 |
|---|---|---|---|
| `statistical_coherence` | 对应维度工具，如 `domain_funnel_diagnosis` / `domain_marketing_attribution` | `adhoc_synthesis` | 重算 metric_refs / n_total / p_value / CI；重算后仍不支持则降级或删除 finding |
| `business_coherence` | `model_analysis` + `diagnostic_rules` | `adhoc_synthesis` | 验证模型方向、活动配置和统计 finding 是否混杂；不支持则移入 cross_validation / blind_spots |
| `redundancy` | `LLM-merge` | 无 | 合并重复项，保留证据更强的一条 |
| `closure` | `LLM-revise` | 无 | 补真实人群、真实字段、量化 expected_impact |
| `language_compliance` | `LLM-revise` | 无 | 改写违规文本；改完后 `lint_report` 重跑应无该 warning |

如果 `rediagnosis_plan.tool_id` 是 manifest 现有工具，先调用现有工具；如果工具 precondition 失败或输出粒度不足，再调用 `adhoc_synthesis`。临时工具成功后必须把 evidence 挂到 `state.adhoc_evidences`，并在被修订 finding 的 `detail` 写明 `code_hash`。

## 反思的 8 类问题

> 反思环不仅审"写得对不对"（自洽/冗余/闭环/语言），也审"漏没漏"（**漏诊覆盖**）与"渲染健不健康"。

| 类型 | 检查项 | 触发动作 |
|---|---|---|
| **统计自洽**（statistical_coherence） | finding.metric_refs[*].value 能否在 `agent_structured_stats` / `data_overview` / `adaptive_thresholds` 中复现；ci 是否跨 0；p_value 是否引用；n_total 是否真实 | 不通过 → severity 降级，detail 末尾追加`[未通过自洽校验]`，标记 `needs_evidence=true` |
| **指标符号自洽**（statistical_coherence/_check_metric_sign） | `cvr_gap` 符号是否等于 `cvr_triggered − cvr_not_triggered`（写反触发/对照组） | 符号相反 → 校正 metric_refs 并据此修订 signal/detail 方向叙述 |
| **漏诊覆盖**（signal_coverage） | `effective_signal=True` 的强信号，其**主题组**是否有任一 finding 覆盖（按合并组判定，避免误报已并入项） | 未覆盖 → 为该主题补 finding，或在 `data_caveats` 显式说明并入/排除理由 |
| **业务自洽**（business_coherence） | finding 方向是否与 `campaign_profile.design_issues` 一致；是否与 `model_analysis.top_features` 方向相反 | 矛盾 → 把该 finding 移入 `action_plan.cross_validation` 或 `action_plan.blind_spots`，不再单独叙述 |
| **冗余/重复**（redundancy） | findings.signal 文本是否高相似（>0.8 token 重叠）；audience_segments.filter_conditions 是否等价 | 合并保留最有数据支撑那条，其他丢弃 |
| **action 闭环**（closure） | priority_actions.target_audiences 引用的人群是否真实存在于 audience_segments；expected_impact 是否量化 | 不闭环 → 重写或补全 |
| **渲染健康**（render_health） | 上一次 render 是否产生过模块降级（`state["render_warnings"]` 非空） | 排查对应模块依赖的 state 数据缺失/异常，修复后重新 render |
| **语言合规**（language_compliance） | `report_validator.lint_report()` 检测到：规则编号（Rule N）、ML 专有词、禁用词、渠道词汇错配 | 调用 `LLM-revise` 按写作约束改写文本；**不涉及数据重算**，仅改文字 |

> **漏诊覆盖（signal_coverage）是本轮新增的核心能力**：以往反思只检查"已写 finding 的质量"，无法发现"强信号被整个漏掉"。现在 compute-thresholds 标记的 `effective_signal` 若其主题组无 finding 覆盖（合并组见 `self_critique._COVERAGE_GROUPS`，对齐 methodology/08 的关联规则合并原则），反思环会列出"可能漏诊"清单，提示补 finding 或显式说明不纳入理由。

## issue 结构

```json
{
  "type": "statistical_coherence | business_coherence | redundancy | closure | language_compliance",
  "severity": "error | warning",
  "target_kind": "finding | audience_segment | priority_action",
  "target_id": "fnd_xx | seg name | action rank",
  "message": "10-40 字问题描述",
  "suggested_fix": "30-80 字建议修订内容"
}
```

- `severity=error` → 不修订不得进入 render
- `severity=warning` → Agent 可保留并在 `data_caveats` 补充说明

## 自检 prompt（Agent 内嵌使用）

```
你是诊断质量审稿人。现在 state 已有：
  - findings[N], audience_segments[K], priority_actions[M]
  - agent_structured_stats（事实层数据）
  - campaign_profile.design_issues、model_analysis.top_features

请对以下每条 finding/action/segment 回答：
  1) 该条主张引用的数字能否在 agent_structured_stats 中找到原值？找不到/对不上 → issue
  2) 是否与 campaign_profile 或 model_analysis 方向冲突？冲突 → issue
  3) 是否与同维度其他 finding 高度重复？是 → 标记 redundancy
  4) action 的 target_audiences 是否都在 audience_segments 中？impact 是否量化？

输出 JSON 数组（issue 列表）。无问题输出 [].
```

## 与其他方法论的关系

- 替代不了 `report_validator.validate_report`（schema 硬错误）和 `lint_report`（禁用词），而是补充"业务/统计合理性"维度
- 与 `methodology/06_data_fallback.md` 协同：被 fallback 派生的列产生的 finding，必须在 detail 中标注`[代理指标]`，否则 self_critique 报 warning

## 迭代上限与 Agent 实操模板

正确的循环（warning 也要走完归宿，不能直接放过）：

```python
from marketing_audit_skill.snippets.self_critique import assess, summarize, summarize_assessments

MAX_ROUNDS = 2
for round_no in range(1, MAX_ROUNDS + 1):
    assessments = assess(state)          # 同时写 state["self_critique"]
    issues = state["self_critique"]
    state.setdefault("_critique_history", []).append({
        "round": round_no,
        "summary": summarize(issues),
        "assessment_summary": summarize_assessments(assessments),
        "issues": issues,
    })
    if not issues:
        break

    errors  = [i for i in issues if i["severity"] == "error"]
    warns   = [i for i in issues if i["severity"] == "warning"]

    # 1) error 必须修订
    for e in errors:
        agent_revise(state, e)            # Agent 按 e["suggested_fix"] 改 finding/action/segment

    # 2) warning 也必须给归宿（修订 / 移位 / 显式接受）
    for w in warns:
        decision = agent_decide_warning(state, w)
        if decision == "revise":
            agent_revise(state, w)
        elif decision == "rediagnose":
            plan = w["rediagnosis_plan"]
            run_tool_or_adhoc(state, plan)  # 调 manifest 工具；粒度不足则 adhoc_synthesis
            agent_revise_from_new_evidence(state, w)
        elif decision == "move_to_cross_validation":
            state["action_plan"].setdefault("cross_validation", []).append({
                "finding": w["message"], "validated_by": "(待补)",
                "conclusion": w["suggested_fix"],
            })
            _drop_finding(state, w["target_id"])
        elif decision == "accept":
            state["action_plan"].setdefault("blind_spots", []).append({
                "topic": w["message"],
                "evidence": f"critique round {round_no} 接受为已知局限",
                "recommended_probe": w["suggested_fix"],
            })

# 退出循环后：state["self_critique"] 应为 [] 或全部为已显式接受的 warning
assert all(i["severity"] != "error" for i in state["self_critique"]), "error 必须清空"
```

**关键点（避免下次又跳过）**：
1. `_critique_history` 记录每轮 summary，仅作内部流程记录，不在报告 HTML 中展示；render 时若 round=1 且非空，lint 会输出 warning 提示
2. 第二轮后仍存在的 warning，必须在 `data_caveats` / `blind_spots` 中能查到对应条目，否则 confidence.evidence_depth ×0.8
3. Agent 不要因为 warning "听起来不严重" 就放过 — 一个真实案例：模型 Top 特征方向与统计 finding 方向冲突的 warning，本应把 fnd_attr_01 移到 cross_validation 标注"模型对 pre_ads_touch_cnt 仍打正向号，需补广告子类拆分验证"
