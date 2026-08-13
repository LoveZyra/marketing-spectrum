# 04 — 置信度评分 (Step 5)

> 对应代码：`snippets/confidence.py`，纯函数无 LLM 依赖。

## 4 个维度的评分公式

### 1) `data_coverage` — 数据覆盖率（双子分）

```
# 子分 1：domain snippet 覆盖率（6 个维度）
n_total_agents = 6
n_covered      = agent_raw_stats 中非空且不含 "[执行失败]" 的维度数
domain_coverage = round(n_covered / 6, 2)

# 子分 2：诊断规则覆盖率（31 条规则）
total_rules    = 41
evaluated      = diagnostic_rules_summary 中 status ∈ {"triggered", "not_triggered"} 的条数
rule_coverage  = round(evaluated / 41, 2)

# 合并（有 rule_summary 时各占 50%，否则退回纯 domain）
data_coverage = round(0.5 * domain_coverage + 0.5 * rule_coverage, 2)
```

每个维度强制至少跑一次（见 `methodology/00_overview.md` 硬约束），理想值：domain=1.0，rule≈1.0（#4 人群质量规则固定 not_applicable）。

### 2) `model_quality` — 模型质量

```
if model_analysis is None or 'auc' missing:
    model_quality = 0.0
else:
    # 优先用 CI 下界（auc_ci_low）作基准，避免低样本量下 AUC 虚高拉分
    auc_basis = model_analysis.get('auc_ci_low') or model_analysis['auc']
    mq = max(0.0, min((auc_basis - 0.5) / 0.4, 1.0))
    # 低样本量分级折扣（见 methodology/09 的"低样本量分级"表）
    if note startswith "[低样本量·强]" or "n<200" in note:
        mq *= 0.3
    elif note startswith "[低样本量"（弱）":
        mq *= 0.6
    model_quality = round(mq, 2)
```

**为什么用 CI 下界**：bootstrap 验证集 AUC 在 n<500 时区间宽度常常 >0.1，点估计很可能
偏向乐观；用 CI 下界=保守估计=对不稳定模型自动降权。

### 3) `finding_richness` — 发现丰富度

```
high_cnt = findings 中 severity=='high' 的数量
mid_cnt  = findings 中 severity=='mid' 的数量
finding_richness = round(min((high_cnt * 2 + mid_cnt) / 10, 1.0), 2)
```

high 计 2 分、mid 计 1 分，10 分封顶。

### 4) `evidence_depth` — 证据深度

```
with_evidence = findings 中 detail 字段非空的条数
evidence_depth = round(with_evidence / max(len(findings), 1), 2)
```

## 综合分

```
weights = {
    "data_coverage":   0.3,
    "model_quality":   0.3,
    "finding_richness": 0.2,
    "evidence_depth":  0.2,
}
overall = sum(scores[k] * weights[k] for k in weights)
overall = round(overall, 2)
```

## 等级映射

| overall | level |
|---|---|
| ≥ 0.75 | 高 |
| ≥ 0.50 | 中 |
| < 0.50 | 低 |

## 输出（写入 `state['confidence']`）

```json
{
  "data_coverage": 0.97,
  "domain_coverage": 1.0,
  "rule_coverage": 0.95,
  "model_quality": 0.71,
  "finding_richness": 0.7,
  "evidence_depth": 0.95,
  "overall": 0.83,
  "level": "高"
}
```

## 提升建议（宿主 Agent 可以参考的"自我改进"线索）

如果 `overall < 0.5`：

- `data_coverage < 1.0` → 把失败的维度补跑一次
- `model_quality == 0` → 检查是否能装 lightgbm / xgboost；或样本量是否够
- `finding_richness < 0.4` → 阈值由 adaptive_thresholds 驱动；检查是否有规则触发但 Agent 未生成 finding（参见 `methodology/08_diagnostic_rules.md`）
- `evidence_depth < 0.6` → finding 的 detail 字段被宿主 Agent 写得太敷衍，补充数据依据
