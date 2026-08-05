# 02 — 小模型路径 (Step 2，可选)

> 对应代码：`snippets/model_analyst.py`
> 依赖：`lightgbm` 或 `xgboost`（二选一，自动检测），`scikit-learn`

## 目标

在用户行为特征宽表上训练一个二分类小模型（target=`is_paid`，最终支付成单），产出**与统计路径互补**的
五类输出，作为最终合成阶段交叉验证的"模型路径"。创单率（`is_converted`）仅作过程指标，不再作为建模目标。
特征方向（positive/negative/mixed）的 mixed 判定按目标基础率自适应（成单率 ~2% 的 1pp 差≈创单率 ~7% 的 3pp 差），
避免成单口径下方向全塌为 mixed。

> ⚠️ **模型路径的职责边界**：model_analysis 的任务是**诊断营销活动问题、识别影响转化的重要特征、给出高转化人群优化建议**。
> 它**不负责**评价模型本身的预测质量（如校准偏差、分桶预测误差）——这类模型内部指标属于系统工程问题，不应出现在营销诊断报告中。
> 具体地：
> - `fnd_model_calibration`（模型校准偏差）→ 仅写入 `data_caveats`，不生成 finding，不在报告中展示
> - `fnd_model_score_bucket_gap`（分桶预测偏差）→ 同上
> - 报告中只展示：影响 CVR 的 Top 特征、高转化人群规则（decision_rules）、转化人群洞察

## 五类产出

1. **特征重要性**（Top 20）—— gain-based、归一化到 [0,1]
2. **决策规则**（Top 10）—— 从树叶节点向上回溯得到的人可读规则（`feat<=thresh AND feat2>thresh2 ...`），过滤样本量 < 30 的叶节点；按 predicted_cvr 降序取 Top
3. **分桶预测 vs 实际**（10 个桶）—— 按预测分数分位数切分，每桶给出 `score_range / user_count / actual_cvr / predicted_cvr`
4. **高分未成单人群**（Top20% 预测分但 `is_paid=0`）—— 含用户数、占总成单比例、Top 8 重要特征在该群体 vs 全体的均值差异（数值列）或 top 值对比（类别列）
5. **AUC + overall_cvr + n_samples + backend** 等元信息

## 关键设计

### 数据准备（`_prepare_features`）
- **排除列**（`DEFAULT_EXCLUDE`，源于 `snippets/model_analyst.py`）：
  - 标识符：`mapid / deviceid / unionid / activity_name / activity_id / activity_channel / touch_date`
  - 目标列及衍生标签（防止泄漏）：`is_converted / is_paid / convert_product / convert_time`
  - 活动级信息（属于实验条件，不是用户特征，会造成反向因果）：`activity_product_name / last_touch_time / first_touch_time / touch_hour / touch_period`
  - 高基数文本序列（树模型无法消化）：`pre_path_model_seq / pre_path_detail_seq / pre_path_major_seq / pre_path_product_seq`
  - 高基数页面名字段（页面名通常远超 50 个）：`pre_first_touch_detail / pre_last_touch_detail / pre_first_mainflow_detail / pre_last_mainflow_detail / pre_first_mkt_activity_name / pre_last_mkt_activity_name / pre_last_search_product 等`
  - 时间戳字段（不直接入模，已有衍生的时间差字段替代）：`pre_first_event_time / pre_last_event_time / pre_first_mkt_time / pre_last_mkt_time / pre_first_mainflow_time / pre_last_mainflow_time / pre_last_order_time / intotime / label001 / last_create_order_time 等`
  - **整维度排除**（`EXCLUDE_DIMENSIONS`，按 registry `dimension` 动态取）：维度 13 `marketing_scene`（`sceneid / scene_name / is_today / scene_has_offline_node`）——活动级元数据属实验条件而非用户特征，全部不入模；该维度将来新增字段自动排除
  - **注意**：决策周期字段（如 `pre_first_expose_to_touch_min / pre_last_mainflow_to_touch_min`）度量的是行为到**触达时刻**的时间差，未转化用户同样有值，**不属于泄漏列，保留入模**
- **自动剔除**：
  - `dtype == object` 且 `nunique > 50` 的字符串列（如 `*_majorname / *_event_time` 等），树模型无法消化
  - **零方差列**：`fillna` 之后 `nunique <= 1` 的常数列（全 NaN 列在 fillna(-1) / fillna("__NA__") 后退化为常数）→ 对模型零贡献且拖慢训练，自动剔除并写入 `note` 字段 `[零方差剔除] col1, col2, ...`
- **缺失值**：数值列填 `-1`（"事件未发生"标识），字符串列填 `"__NA__"`，字符串列再转 `category`
- **类别列**：LightGBM 原生支持 → 传 `categorical_feature=[...]`；XGBoost 用 `enable_categorical=True`
- **单类目标**：若 `y.nunique() < 2`，**直接降级返回空结果**，写入提示文本，不抛异常

### 训练超参（保守默认值）
- `n_estimators=200`, `max_depth=4`, `learning_rate=0.05`
- LightGBM 额外：`num_leaves=31`, `min_child_samples=30`, `early_stopping_rounds=20`，`class_weight='balanced'`
- XGBoost 额外：`tree_method='hist'`, `early_stopping_rounds=20`，`scale_pos_weight = n_neg/n_pos`
- `train_test_split(test_size=0.2, random_state=42, stratify=y)`

### 类不平衡处理（必须）

营销转化 CVR 通常 <10%（极度不平衡）；不处理会让模型偏向预测"未转化"，**AUC 看似 0.8+
但对正例的精度仍很差**。代码内置：
- LightGBM：`class_weight='balanced'`（自动 `n_samples / (n_classes * np.bincount(y))`）
- XGBoost：`scale_pos_weight = (y==0).sum() / max((y==1).sum(), 1)`

实际使用的 `pos_weight` 写入 `model_analysis.pos_weight` 供审计。

### AUC 置信区间（bootstrap）

`_train_and_score()` 在验证集上做 500 次 bootstrap 重采样，输出：
- `auc`：点估计
- `auc_ci_low / auc_ci_high`：95% bootstrap CI 上下界
- `auc_ci`：`[low, high]` 数组形态

**下游使用规则**：confidence 计算的 `model_quality` 优先用 `auc_ci_low`（CI 下界）
作为基准，避免低样本量下 AUC 虚高。

### 低样本量分级（独立于 caller 的 `min_samples`）

无论 caller 传什么 `min_samples`，按数据规模绝对分级：

| n_total | note 前缀 | confidence 中 `model_quality` 折扣 |
|---|---|---|
| < 100 | `[跳过] hard_min_samples` | 整体 mq=0 |
| 100-199 | `[低样本量·强] n<200` | mq × 0.3 |
| 200-499 | `[低样本量·弱] n<500` | mq × 0.6 |
| ≥ 500 | （空 note） | 不折扣 |

### 后端选择
- `backend='auto'` → 优先 LightGBM（原生类别），fallback XGBoost
- 都没装时 → 抛 ImportError，提示 `pip install lightgbm` 或 `pip install xgboost`

## 输出 JSON（写入 `state['model_analysis']`）

```json
{
  "backend": "lightgbm",
  "auc": 0.7842,
  "auc_ci": [0.762, 0.804],
  "auc_ci_low": 0.762,
  "auc_ci_high": 0.804,
  "pos_weight": 10.86,
  "overall_cvr": 0.0843,
  "n_samples": 50000,
  "n_features": 142,
  "top_features": [
    {"rank": 1, "feature": "pre_mainflow_event_cnt", "importance": 0.1234, "direction": "positive", "description": "主流程行为总次数"},
    {"rank": 2, "feature": "pre_coupon_collect_cnt", "importance": 0.0986, "direction": "positive", "description": "历史红包/优惠领取总次数"},
    ...
  ],
  "decision_rules": [
    {"rule": "pre_mainflow_event_cnt>5 AND pre_coupon_collect_cnt>0",
     "predicted_cvr": 0.42, "lift": 5.0, "sample_count": 320},
    ...
  ],
  "score_buckets": [
    {"bucket": "Top10%", "score_range": "[0.55,0.92]",
     "user_count": 5000, "actual_cvr": 0.38, "predicted_cvr": 0.68},
    ...
  ],
  "high_score_not_converted": {
    "n": 1234,
    "share_of_not_converted_pct": 5.8,
    "score_threshold": 0.41,
    "features": {
      "pre_mainflow_event_cnt": "均值=8.2（全体=3.1, 差异=+165%）",
      "pre_coupon_collect_cnt": "均值=2.4（全体=0.6, 差异=+300%）"
    }
  },
  "llm_insights": "（可选）宿主 Agent 自己写的 3-5 条营销洞察文本"
}
```

## 宿主 Agent 的 LLM 角色（替代原 `_llm_interpret`）

原代码会调用 LLM 把模型结果转成 3-5 条营销洞察。在 skill 模式下，宿主 Agent 自己完成：

> 基于上面的 top_features / decision_rules / high_score_not_converted，写 3-5 条营销洞察。
> 每条 1-2 句，直接说结论，不描述数据本身。重点：哪些行为特征最能区分转化与不转化？高分未转化
> 人群的特征是什么？符合 `methodology/03_synthesis.md` 的写作约束（禁用词、含具体数字）。
>
> ⚠️ **语言规范**（面向运营，非技术受众）：
> - 禁止出现 `AUC`、`GBDT`、`LightGBM`、`feature importance` 等技术术语
> - 特征名引用规则：第一次出现时用「`feature_name`（中文描述）」格式，之后只用中文描述；`top_features[].description` 字段即对应中文描述
> - 禁止在洞察文本中写"Rule N"或规则编号，只写中文规则名

把生成的文本写入 `model_analysis.llm_insights`。

## 字段机械化解读（`snippets/model_interpreter.py`）

为避免宿主 Agent 漏读模型产出，`model_interpreter.interpret_model()` 自动从 10 个高/中价值字段
抽取候选 finding / segment / caveat / blind_spot。在 CLI `prepare` 命令中已自动调用并合并到 state。

| 字段 | 触发条件 | 自动产出 |
|---|---|---|
| `calibration.overconfident` | `max_gap > 0.05` | `auto_finding` + 圈人阈值 `blind_spot` |
| `low_score_converted` | 漏判占比 > 10% | `auto_finding` + 特征工程 `blind_spot` |
| `decision_rules` | `lift ≥ 2 且 sample_count ≥ 100`,再按全量口径 lift 降序只保留**效果最好的 top3**(`decision_rule_top_n` 可调;同 lift 取覆盖大者;全量规则仍留在 `model_analysis.decision_rules` 可审计) | `auto_segment`（含 filter_conditions） |
| `note` | 含 `[零方差剔除]` / `[低样本量·*]` | `auto_caveat` |
| `stratified_auc` | 子群 AUC 跨度 > 0.05 | `auto_finding` + 子群拟合 `blind_spot` |
| `rule_stability` | 跨子群 precision 差 ≥ 0.15 | `auto_caveat`（不可跨群复用） |
| `score_buckets` | `|actual - predicted| ≥ 0.10` | `auto_finding`（分桶不准） |
| `score_distribution` | `pct_above_0.9 > 5%` 或 `|skew| > 3` | `auto_caveat`（分布形态异常） |
| `stratified_score_buckets` | 同桶子群 CVR 相对差 ≥ 30% | `auto_caveat`（圈人规则失真） |
| `rule_overlap` | 规则间 Jaccard ≥ 0.5 | `auto_caveat`（触达疲劳风险） |

Agent 拿到这些候选后**仍可筛选 / 合并 / 润色**；interpreter 只解决"机械化抽取"，不替代业务判断。

阈值通过 `model_interpreter.DEFAULTS` 或调用时传入 `thresholds={}` 覆盖。

## 与 6 维度的联动（替代原 `Router.boost_from_feature_importance`）

Top 5 特征按前缀映射到对应维度，宿主 Agent 在 Step 3 应**优先深挖该维度**（特征名使用 `pre_` 前缀）：

| 特征前缀 | 映射维度 |
|---|---|
| `pre_max_funnel_depth` / `pre_reached_*` / `pre_mainflow_*` / `pre_back_to_*` / `pre_funnel_*` / `pre_skip_detail_flag` | `funnel_diagnosis` |
| `pre_mkt_*` / `pre_popup_*` / `pre_push_*` / `pre_sms_*` / `activity_touch_cnt` / `activity_channel_std` / `pre_min_mkt_response_sec` | `marketing_attribution` |
| `pre_browse_*` / `pre_*_depth` / `pre_top_interest_product` / `pre_is_cross_category` / `pre_search_*` / `pre_mkt_product_browse_match` | `user_segment` |
| `pre_coupon_*` / `pre_rp_*` / `pre_has_coupon` / `pre_has_blackwhale` | `price_sensitivity` |
| `pre_primary_platform` / `pre_*_event_cnt` / `pre_events_per_hour` / `pre_black_whale_interest` / `pre_viewed_member_assets` / `pre_checkin_triggered` / `pre_is_dormant_user` | `platform_behavior` |
| `pre_first_touch_*` / `pre_last_touch_*` / `pre_is_marketing_*` / `pre_last_order_*` / `pre_create_*` / `pre_has_complete_order` | `path_quality` |

## 跳过条件

以下情况宿主 Agent 应跳过本步：

- 用户明确说 `enable_model_analysis=False`
- `lightgbm` / `xgboost` 都未安装
- `is_paid` 列不存在 或 `nunique() < 2`
- 数据量 < 100（样本太少模型不可信）

跳过时把 `state['model_analysis'] = None`。Step 4 合成阶段会自动只走统计路径。

## 大数据量下的训练采样(2026-08-04 新增)

行数超过 `MA_MODEL_SAMPLE`(默认 50 万,0=关闭)时,训练前对数据做**正样本全保留、只采样负样本**的下采样;少数类占比异常(少数类自身超过预算)时自动退回等比分层,保证行为可预期。设计取舍:

- 只影响模型训练:data_overview/漏斗/阈值等统计仍在全量上计算,报告口径不变;
- 训练集类别先验因此高于真实(如 3%→30%):AUC/特征重要性等**排序型**结论不受影响;若把模型输出概率当绝对值使用(概率阈值圈人),需按训练/真实先验比校准;
- 采样明细(保留/采样行数、训练与全量正样本率)写入 `data_caveats` 与 events 决策日志,报告可溯源。

背景:2026-08-04 activity 1011270(5.9M 行×250 列)实测,全量喂 lightgbm 单步 1058s、占 prepare 59%,直接顶穿 1800s 步超时;采样至 50 万后该步预期 1-2 分钟。

## 统计口径:验证集 + 采样外推(2026-08-05 更新)

`run_model_analysis` 的分数型统计(score_buckets / high_score_not_converted / low_score_converted / calibration / 规则 precision-recall)自 fix19 起**只在验证集(20%)上计算**——训练集分数带 in-sample 乐观偏差,混入会系统性高估模型区分度。

若调用方做过类别下采样(`MA_MODEL_SAMPLE`,正样本全保留、只采负样本),`cli.py` 会把实测 `(正采样率, 负采样率)` 与全量真实 CVR 传入(`class_rates` / `true_overall_cvr`),模型侧按每类放大系数做**无偏外推**:

- `pos_scale = (全量正样本数 / val 正样本数) / 正采样率`,`neg_scale` 同理;
- 组人数 = `p·pos_scale + n·neg_scale`;组 CVR = `p·pos_scale / 组人数`。

因此输出中的 `user_count` / `n` / `sample_count` 是**全量人数口径**,`precision_population` / `lift_population` 是**全量 CVR/提升口径**(lift 相对 `true_overall_cvr`)。验证集原始命中数保留在 `sample_count_raw` / `n_raw`;`stats_scope="val"`、`sampled`、`calibration.sampled_prior` 标注口径供下游判别。**报告与圈人预估可直接引用外推后的数字**;唯一仍需按先验校准的是"把模型输出概率当绝对值用"(概率阈值圈人)的场景。

## 分类特征的规则抽取(2026-08-05 更新)

两后端(LightGBM / XGBoost)的"树路径→规则"翻译共用同一合并渲染器 `_merge_render_clauses`,非数值特征的规则从此可读、可执行、可回放:

- **空值语义**:入模前分类特征 NaN→`__NA__` 哨兵;渲染时 display 写「空值」,SQL 译为 `feat IS NULL`(或 `(feat IS NULL OR feat IN (...))` 组合)——哨兵字面量不出现在任何输出,线上表匹配的是真实 NULL;
- **反选改写**:`NOT IN(长清单)` 若补集 ≤8 且不大于清单,改写为等价 `IN(补集)`,更短且对训练中未见过的新类别更保守;
- **同特征合并**:一条路径对同一特征的多次切分,数值合并为最紧上下界、分类集合按 AND 语义求交/差,圈人 SQL 无冗余子句;
- **后端边界差异**:XGBoost 数值切分渲染为 `<` / `>=`,LightGBM 为 `<=` / `>`,均为精确语义的 Spark SQL;
- **规则可回放**:`_apply_rule_mask` 支持数值比较与 `in / not in [...]`(含「空值」),稳定性(O25)/重叠(O28)检验覆盖分类规则。
