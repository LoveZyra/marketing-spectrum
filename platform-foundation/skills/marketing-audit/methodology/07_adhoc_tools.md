# 07 — 临时工具自生成（Ad-hoc Tool Synthesis）

> 当 `TOOLS_MANIFEST.json` 中所有工具都无法覆盖某个假设的证据需求时，宿主 Agent 进入本模式：
> 自己写一段 pandas 代码 → 沙箱执行 → 校验 → 把结果挂到 hypothesis / finding。
>
> 触发条件、生命周期、安全约束如下。

## 何时新建临时工具

满足以下任一条件：

1. **交叉缺失**：当前 hypothesis 需要"A × B 交叉表"，但 manifest 里没有同时覆盖 A、B 的工具
2. **粒度过粗**：已有工具仅输出 p50/均值，需要分布形态（双峰检测、分位数序列、长尾占比）
3. **跨维度联合**：需要把 model_analysis.top_features 与某统计字段做联合，无现成 snippet
4. **路径模式匹配**：需要在 `pre_path_model_seq` / `pre_path_detail_seq` 中找特殊子序列模式

## 何时**不要**新建

- manifest 已有工具能给出同类证据（哪怕需要二次后处理）→ 用现成的
- 仅为修一条文本表达 → 直接改 finding.detail
- 想做"全量画像"（属于 data_overview 职责，不是 ad-hoc）
- 该需求是反复出现的（≥3 次）→ 应固化进 `snippets/<name>.py` 而非临时

## 生命周期

```
PROPOSE → EXECUTE → VALIDATE → ATTACH → (PROMOTE)
```

| 阶段 | 责任方 | 落事件 |
|---|---|---|
| PROPOSE | Agent 写 tool_spec（见下方 schema） | `adhoc_tool: stage=propose` |
| EXECUTE | `adhoc_runner.run_adhoc(spec, df)` 沙箱执行 | `adhoc_tool: stage=execute` |
| VALIDATE | `adhoc_validator.validate(spec, output)` 跑 3 关 | `adhoc_tool: stage=validate` |
| ATTACH | 结果挂到 `state.adhoc_evidences` + `hypothesis.evidence_ids` | `adhoc_tool: stage=attach` |
| PROMOTE | `adhoc_registry.suggest_promotion()` 提示固化 | `adhoc_tool: stage=promote` |

## tool_spec 强制 schema

```json
{
  "name": "snake_case_short_name",
  "purpose": "20-50 字目的（必须含 hypothesis_id）",
  "created_for_hypothesis": "hyp_xxx",
  "input_columns": ["真实字段 1", "真实字段 2"],
  "output_schema": {"col_a": "type", "col_b": "type"},
  "code": "Python 代码，必须把最终结果赋给 result（DataFrame 或 dict）",
  "validation_checks": ["至少 1 条 boolean 表达式（用 result/df/np/pd），独立验证逻辑"],
  "severity_cap": "high | mid | low"
}
```

## 代码硬约束（adhoc_runner 强制）

- 仅允许 `pandas / numpy / scipy / math / statistics / itertools / collections`
- 禁止 `import os / sys / subprocess / socket / shutil / pathlib`
- 禁止 `open / eval / exec / compile / __import__ / globals / locals`
- 禁止任何以 `__` 开头的属性访问（`__class__` / `__subclasses__` / `__bases__`...）
- 输入 `df` 视为只读；需要修改先 `df = df.copy()`
- `result` 必须是 DataFrame 或 dict；DataFrame 行数 ≤ 1000（超过会被 `head(1000)` 截断）
- 执行超时 30s（在支持 SIGALRM 的平台启用；Windows 由调用方在外层用线程超时控制）

## VALIDATE 三关

1. **schema_check**：`input_columns` 全部在 `df.columns` 中；缺列时返回 `fallback_hint: "调用 data_fallback.ensure_field"`
2. **ast_check**：解析代码 AST，发现禁用 import / name / dunder 直接 reject
3. **output_check**：执行后输出类型正确、形状合规、`validation_checks` 表达式全部 True

任一失败 → `status=failed`，Agent 须按 `failure_reason.stage` 决定改写或回退。

## ATTACH：结果如何回流到 state

```python
ev_id = f"ev_adhoc_{code_hash[:8]}"
state["adhoc_evidences"].append({
    "id": ev_id,
    "tool_id": tool_id,
    "name": spec["name"],
    "code_hash": code_hash,
    "result_table": records[:200],   # 节流
    "result_summary": _summarize(records),
    "n_rows": len(records),
})
# 在对应 hypothesis 上挂 evidence_ids
for h in state["hypotheses"]:
    if h["id"] == spec["created_for_hypothesis"]:
        h["evidence_ids"].append(ev_id)

# finding 引用时按规范写
finding["evidence_field"] = f"adhoc:{spec['name']}"
finding["detail"] += f"（来源：临时工具 {spec['name']}, n={n}, code_hash={code_hash[:8]}）"
```

任何引用 ad-hoc evidence 的 finding **必须**在 detail 末尾标注 `code_hash` 前 8 位，便于复现。

## PROMOTE：什么时候应该转正

`adhoc_registry` 维护一份 `~/.marketing_audit_skill/adhoc_history.jsonl`，按 `code_hash` 计数：

- 单 campaign 复用 ≥ 2 次 → 把同一份代码挂在多个 hypothesis 上，无需 promote
- 跨 campaign 复用 ≥ 3 次 → 输出 promotion 建议（包含 `suggested_path`、调用清单）
- Agent 跑完整轮诊断后，把 `state["adhoc_promotion_suggestions"]` 落在最终报告 `data_caveats` 之后，由人或下一轮 Agent 决定 PR

## PROPOSE 例（参考）

> 场景：`funnel.py` 输出漏斗深度分布，但 hypothesis 想验证"营销首触 vs 非营销首触在『详情→列表回退次数』上是否有显著差异"。

```json
{
  "name": "funnel_back_by_mkt_first",
  "purpose": "验证 pre_is_marketing_first 在 pre_back_to_list_cnt 上的差异 (hyp_b9c1f)",
  "created_for_hypothesis": "hyp_b9c1f",
  "input_columns": ["pre_is_marketing_first", "pre_back_to_list_cnt", "is_converted"],
  "output_schema": {"pre_is_marketing_first": "int", "n": "int", "back_rate": "float", "cvr": "float"},
  "code": "g = df.groupby('pre_is_marketing_first')\nresult = pd.DataFrame({\n    'n': g.size(),\n    'back_rate': (g['pre_back_to_list_cnt'].mean()),\n    'cvr': g['is_converted'].mean(),\n}).reset_index()",
  "validation_checks": [
    "int(result['n'].sum()) == int(df['pre_is_marketing_first'].notna().sum())",
    "result['back_rate'].ge(0).all()"
  ],
  "severity_cap": "mid"
}
```

成功后 finding 引用：

```
detail: "营销首触用户漏斗回退均值 1.8 次（n=120），非营销首触 0.9 次（n=80），差 1.0 次（数据：pre_is_marketing_first × pre_back_to_list_cnt, 来源：临时工具 funnel_back_by_mkt_first, code_hash=3f8a1c9d）"
```

## 与 self_critique 的关系

- 引用 ad-hoc evidence 的 finding，若未在 detail 标注 `code_hash` → `business_coherence` warning
- ad-hoc 输出的 `validation_checks` 数量 = 0 → `statistical_coherence` warning
- `severity_cap=low` 的 ad-hoc evidence 派生 high severity finding → `statistical_coherence` error

## 与 data_fallback 的关系

ad-hoc 在 `schema_check` 失败（缺列）时，**首选**调用 `data_fallback.ensure_field` 派生缺失列再重试；只有 fallback 也无法补时，才放弃该 ad-hoc 工具。

所有自写 pandas 都要走 `adhoc_runner`，不允许直接 `exec` 用户代码。
