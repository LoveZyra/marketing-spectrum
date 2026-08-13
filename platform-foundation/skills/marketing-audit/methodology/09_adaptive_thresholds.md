# 09 — 数据驱动阈值说明（Adaptive Thresholds）

## 设计原则

所有诊断阈值均由活动数据的 CVR 决定。**口径解耦（Option B）**：

- **最优切分点**在 **创单率（`is_converted`，信号更密、切分更稳）** 上找——`compute_adaptive_thresholds(target_col="is_converted")`（=`split_col`）。
- **规则 CVR 对比 / 有效信号 / 严重度 / 卡片展示** 统一用 **成单率（`is_paid` 最终支付）**——由 `eval_col`（默认 `is_paid`）评估，写 `state["_cvr_col"]`。
- 每个 `threshold_found` 字段额外带 **成单率切分**：`cvr_below_eval` / `cvr_above_eval` / `cvr_gap_eval` / `eval_col`（在创单率最优切分点上重算成单率，供正向机会等卡片以成单率展示）。
- 规则汇总额外带 **创单率过程指标**：`create_triggered` / `create_not_triggered` / `create_gap`（仅 KPI 漏斗展示，不参与判定）。

1. 对每个需要阈值的数值型特征，按分位数分桶（20组）
2. 计算每桶的 CVR（切分基准 = 创单率）
3. 找使切分点两侧 CVR 差值最大的那个值（类 Youden's J）作为 `optimal` 阈值
4. 同时计算 p25/p50/p75/p90/p95 供参考；并在该切分点上重算成单率（`cvr_*_eval`）
5. 样本量不足或 CVR 无显著变化时，退回到 p75 分位数并标注原因

**优势**：阈值随活动、时间、人群自动适应，不依赖任何主观判断。

---

## 读取方式

```python
thresholds = state["adaptive_thresholds"]

# 读取某字段的最优阈值（诊断规则使用此值）
optimal = thresholds["activity_touch_cnt"]["optimal"]       # e.g., 3.0

# 读取计算方法
method = thresholds["activity_touch_cnt"]["method"]         # "youden_split" 或 "percentile_p75_fallback"

# 读取 CVR 对比（验证阈值合理性）
cvr_below = thresholds["activity_touch_cnt"]["cvr_below"]   # 阈值以下 CVR
cvr_above = thresholds["activity_touch_cnt"]["cvr_above"]   # 阈值以上 CVR
cvr_gap   = thresholds["activity_touch_cnt"]["cvr_gap"]     # 差值

# 读取参考分位数
p75 = thresholds["activity_touch_cnt"]["p75"]
p90 = thresholds["activity_touch_cnt"]["p90"]
```

---

## `thresholds_report.md` 使用方式

`compute-thresholds` 运行后会在输出目录生成 `thresholds_report.md`，包含：
0. **⭐ 最具区分度字段 TOP（报告顶部）**：所有有效阈值字段按 |CVR差| 排序的速览表，标注正/负向
1. 每个特征的阈值详情（optimal、方法、CVR 对比、分位数）
2. CVR 分桶详情（可展开查看每个分桶的样本量和 CVR）
3. 31 条诊断规则的触发率汇总表（含 ⭐ 有效信号标记 + 「显著性」列：✅ p<0.05 / ⚠️ p≥0.05 / —）

**Agent 应在生成诊断结论前先阅读此报告**，重点关注：
- **先看顶部「最具区分度字段 TOP」表**：31 条规则未必覆盖最强信号（如机票浏览深度→CVR 从
  6% 跃升到 19%），该表把最强正/负向阈值信号一眼列出，可直接引用为 narratives 证据。
  正向字段＝优质人群（可定向/扩量），负向字段＝抑制因素（应排除/降权）。
- `optimal` 阈值是否符合业务直觉（过高或过低时需在 data_caveats 标注）
- `method=percentile_p75_fallback` 的字段（CVR 无显著变化，该字段对转化区分度低）
- `cvr_gap > 0.05` 的字段（CVR 区分度高，是重要诊断特征）

> ⚠️ **TOP 表与规则的关系**：TOP 表是**统计上下文/证据补充**，不替代规则诊断。约束下
> findings 仍以 31 条规则为主诊断源；TOP 表帮助 Agent 为规则结论补强数据、或在 narratives
> 中引用规则未直接量化的强信号（带 rule_id=null 的正向机会可据此撰写）。

---

## 低样本量处理

当字段有效样本量 `n < 30` 时：
- 自动退回 `percentile_p75_fallback` 方法
- `note` 字段标注"CVR 最优切分不可用，退回 p75 分位数"
- 该字段对应的诊断规则 finding 应将 `confidence` 设为 ≤ 0.6

当整体 CVR < 1% 时：
- 正负样本极度不均衡，Youden's J 不可靠
- 自动退回 `percentile_p75_fallback`

---

## 阈值合理性自检清单

Agent 在引用阈值时应确认：

- [ ] `optimal` 值不为 `null`（null 表示计算失败，该规则评估结果不可信）
- [ ] `method` 字段是 `youden_split`（而非 fallback）才保证 CVR 驱动
- [ ] `n_below` 和 `n_above` 均 ≥ 30（样本量足够）
- [ ] `cvr_gap` 方向符合业务预期（例如过度触达的 `cvr_gap` 应为负）
- [ ] **`has_outlier` 字段**：若为 `true`，则该字段存在极端异常值（p99 >> IQR），CVR 最优切分点可能被污染。`outlier_note` 字段包含具体数值和排查建议。受影响规则的 finding `confidence` 应降为 ≤ 0.75，并在 `data_caveats` 中标注

```python
# 检查某字段是否存在异常值警告
field_info = thresholds.get("pre_last_order_to_touch_min", {})
if field_info.get("has_outlier"):
    print(f"异常值警告：{field_info['outlier_note']}")
    # → 对应规则的 finding.confidence 应 ≤ 0.75
```

---

## 与诊断规则的对应关系

`diagnostic_rules.yaml` 中的 `condition_template` 通过 `threshold(field, stat)` 引用阈值：

```yaml
condition_template: "activity_touch_cnt >= threshold('activity_touch_cnt', 'optimal')"
```

DiagnosticEngine 在运行时将 `threshold('activity_touch_cnt', 'optimal')` 替换为
`state["adaptive_thresholds"]["activity_touch_cnt"]["optimal"]` 的实际数值。

**注意**：若某字段的 `optimal=null`（计算失败），该规则评估时该条件不会触发任何行，
但不报错。Agent 应检查 rule_summary 中该规则的 `status` 和 `warnings`。

---

## 阈值更新时机

不需要手动更新阈值配置文件。以下情况重新运行 `compute-thresholds` 即可：
- 数据日期窗口发生变化
- 活动类型或目标人群发生显著变化
- 新增特征字段后（需先在 `feature_registry.yaml` 注册）
