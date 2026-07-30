# marketing_audit_skill

营销活动诊断 skill，面向 AI Agent（Claude Code、Codex 等）设计。

提供从原始行为宽表到完整诊断报告（JSON / Markdown / HTML）的**全流程方法论 + 可直接调用的代码片段**，不内置 LLM，不依赖任何 Agent 框架——宿主 Agent 自身即是 LLM 和编排器。

---

## 快速开始

### 环境依赖

```bash
pip install pandas numpy scipy lightgbm scikit-learn jsonschema
```

> `xgboost` 可替代 `lightgbm`；`scipy` 和 `jsonschema` 可选，缺失时对应功能降级。

### 一键跑通（推荐 CLI 全流程）

```bash
OUT=./out
# 1) 统计层 + 模型（--no-model 可跳过模型，快速跑通）
python -m marketing_audit_skill.cli prepare \
    --data your_data.csv --auto-meta \
    --meta '{"campaign_name":"特价机票","target_products":["机票"]}' --out $OUT

# 2) 数据驱动阈值 + 31 条规则（标 effective_signal ⭐ + 最具区分度 TOP 表）
python -m marketing_audit_skill.cli compute-thresholds \
    --data your_data.csv --state $OUT/state_partial.json --out $OUT

# 3) 自动装配 state_full 骨架（覆盖全部强信号，过完整性校验）
python -m marketing_audit_skill.cli draft --state $OUT/state_partial.json --out $OUT

# 4) ★ 宿主 Agent 润色 $OUT/state_draft.json 的所有 [待润色] 文案，
#    删除 _draft 标记、把 _stage 置为 "full"，另存为 state_full.json ★

# 5) 内部质检（漏诊覆盖/统计自洽/符号/闭环/语言…）
python -m marketing_audit_skill.cli run-tools \
    --state $OUT/state_full.json --out $OUT --tools self_critique confidence

# 6) 落盘 JSON / Markdown / HTML（自动跑 schema + 完整性校验，缺项阻断）
python -m marketing_audit_skill.cli render --state $OUT/state_full.json --out $OUT

# 随时查看进度 / 下一步
python -m marketing_audit_skill.cli status --state $OUT/state_full.json
python -m marketing_audit_skill.cli doctor   # 环境自检
```

> 推荐流程：`prepare → compute-thresholds → draft → 润色(_stage=full) → run-tools self_critique → render`。
> `draft` 把"从零手搓"变成"润色"，保证每次报告结构一致、强信号不漏。
> 库式（直接调用 snippets 手拼 state）见 `examples/enrich_with_critique_loop.py`。

### 参考完整实现

`examples/enrich_with_critique_loop.py` 是推荐的宿主 Agent 范例，演示了如何：

- 读取 `state_partial.json`（统计层已跑完的中间产物）
- 补写所有 findings / segments / adjustments / narratives / action_plan
- 完整运行 self_critique 两轮反思循环
- 重新渲染 HTML 并做 schema 校验

```bash
python -m marketing_audit_skill.cli prepare --data <csv> --meta <meta.json> --out ./out
python -m marketing_audit_skill.cli compute-thresholds --data <csv> --state ./out/state_partial.json --out ./out
python marketing_audit_skill/examples/enrich_with_critique_loop.py --in ./out/state_partial.json --out ./out
python -m marketing_audit_skill.cli render --state ./out/state_full.json --out ./out
```

---

## 目录结构

```
marketing_audit_skill/
├── methodology/          # 方法论文档（Agent 阅读，指导 LLM 步骤）
│   ├── 00_overview.md           # 整体流程与角色拆分
│   ├── 01_campaign_profile.md   # 活动配置诊断
│   ├── 02_model_analysis.md     # 模型分析解读
│   ├── 03_synthesis.md          # 报告撰写约束
│   ├── 04_confidence.md         # 置信度评分
│   ├── 05_self_critique.md      # 自我循环校验
│   ├── 06_data_fallback.md      # 字段缺失派生
│   ├── 07_adhoc_tools.md        # 自生成临时工具
│   ├── 08_diagnostic_rules.md   # 31 条规则诊断结论生成
│   └── 09_adaptive_thresholds.md # 数据驱动阈值使用说明
├── snippets/             # 纯函数代码片段（可直接 import，无 LLM 依赖）
│   ├── data_overview.py      # 12 维全量描述统计
│   ├── funnel.py             # 转化漏斗分析
│   ├── attribution.py        # 营销渠道归因
│   ├── user_segment.py       # 用户兴趣分群
│   ├── price_sensitivity.py  # 优惠价格敏感度
│   ├── platform_behavior.py  # 平台与活跃度
│   ├── path_quality.py       # 行为路径质量
│   ├── model_analyst.py      # LightGBM/XGBoost 转化预测
│   ├── confidence.py         # 4 维度置信度评分
│   ├── report_renderer.py    # HTML + Markdown 报告渲染
│   ├── report_validator.py   # Schema 校验 + lint
│   ├── feature_loader.py     # 特征注册表驱动的字段访问层
│   ├── threshold_computer.py # CVR 驱动的自适应阈值计算
│   ├── diagnostic_engine.py  # 31 条规则批量评估引擎
│   ├── data_fallback.py      # 缺失字段派生回退
│   ├── self_critique.py      # 多轮自我反思校验
│   ├── model_interpreter.py  # 模型输出机械化抽取
│   ├── adhoc_runner.py / adhoc_validator.py / adhoc_registry.py  # 自生成工具
│   ├── draft_builder.py      # 从规则汇总自动装配 state_draft 骨架
│   ├── case_extractor.py     # 抽取代表性用户案例池（typical_case 来源）
│   ├── event_logger.py       # 执行日志
│   └── stats_utils.py        # 统计推断工具（Wilson CI / 卡方 / Welch-t）
├── schemas/              # JSON Schema（报告结构校验）
│   ├── report.schema.json
│   ├── finding.schema.json
│   ├── audience_segment.schema.json
│   └── action.schema.json
├── examples/             # 参考实现
│   ├── input_example.md
│   ├── output_example.json
│   ├── enrich_with_adhoc.py        # 内部 ad-hoc synthesis 复诊参考
│   └── enrich_with_critique_loop.py # 内部 self_critique 闭环参考
├── SKILL.md              # Agent 使用指南（Claude Code 等直接阅读）
└── README.md             # 本文件
```

---

## 角色概览（概念视图）

> 下表是「角色 / 职责」的概念拆分。**实际操作流水线以 SKILL.md 的十步为准**：
> `prepare → compute-thresholds → draft → 润色(_stage=full) → run-tools self_critique → render`
> （即在 Step 1 之后插入 `compute-thresholds`（数据驱动阈值 + 31 条诊断规则）与 `draft`（自动装配骨架）两步）。

| 角色 | 是否需要 LLM | 代码片段 |
|------|------------|---------|
| 活动配置诊断 | 是 | 无，纯 Agent 推理 |
| 数据概览 | 否 | `snippets/data_overview.py` |
| 数据驱动阈值 + 31 条规则 | 否 | `snippets/threshold_computer.py` + `diagnostic_engine.py` |
| 模型分析（可选） | 仅解读 | `snippets/model_analyst.py` |
| 6 维度域分析 | 是（判定阈值 + 文本） | `snippets/<dim>.py` × 6 |
| 草稿装配 | 否 | `snippets/draft_builder.py` |
| 合成报告（润色草稿） | 是（严格写作约束） | 无，纯 Agent 撰写 |
| 置信度评分（内部，不展示） | 否 | `snippets/confidence.py` |
| 落盘 | 否 | `snippets/report_renderer.py` |

6 个诊断维度：`funnel_diagnosis` / `marketing_attribution` / `user_segment` / `price_sensitivity` / `platform_behavior` / `path_quality`

---

## 输入数据格式

### 行为宽表（`.parquet` / `.csv`）

以 **用户-活动（mapid + activity_name + activity_id + activity_channel）** 为粒度，约 **200 个特征**，必须含 `is_converted`（创单=1）与 `is_paid`（成单=1）列。触达前行为特征统一加 `pre_` 前缀。

| 维度 | 字段数 | 代表字段 |
|------|:---:|---------|
| 活动维度信息 | 9 | `activity_channel_std`, `activity_product_name`, `touch_hour`, `activity_touch_cnt` |
| 核心标签 | 4 | `is_converted`, `is_paid`, `convert_product`, `convert_time` |
| 触达前漏斗 | 15 | `pre_max_funnel_depth`, `pre_reached_payment`, `pre_back_to_list_cnt`, `pre_skip_detail_flag` |
| 触达前历史营销 | 26 | `pre_*_touch_cnt`, `pre_mkt_fatigue_cnt`, `pre_*_click_rate`, `pre_over_mkt_flag` |
| 触达前产品偏好 | 26 | `pre_browse_*`, `pre_*_depth`, `pre_top_interest_product`, `pre_mkt_product_browse_match` |
| 触达前红包偏好 | 14 | `pre_coupon_collect_cnt`, `pre_rp_*`, `pre_rp_target_product`, `pre_last_coupon_product` |
| 触达前平台/活跃/首页/会员 | 30 | `pre_primary_platform`, `pre_events_per_hour`, `pre_user_active_period`, `pre_is_dormant_user` |
| 触达前行为路径 | 43 | `pre_first/last_touch_*`, `pre_path_model_seq`, `pre_is_marketing_first`, `pre_search_match_target` |
| 触达前历史订单 | 12 | `pre_complete_order_cnt`, `pre_create_not_complete`, `pre_last_order_product`, `pre_is_repurchase` |
| 跨渠道衔接 | 9 | `has_ads_touch`, `ads_insite_match_flag`, `first_insite_product_name`, `ads_no_insite_flag` |

> 字段语义与诊断维度的对应关系：`references/behavior_fields.md`（按字段名搜索，只加载匹配章节）。

### 活动元数据（`campaign_meta` dict）

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
  "discount_type":        "满减",
  "discount_value":       "满300减50",
  "coupon_validity_h":    24,
  "target_cvr":           0.12,
  "benchmark_cvr":        0.10
}
```

---

## 输出产物

运行完成后在 `output_dir` 生成三个文件：

| 文件 | 说明 |
|------|------|
| `diagnosis_report.json` | 完整 state，遵循 `schemas/report.schema.json` |
| `diagnosis_report.md` | Markdown 格式诊断报告 |
| `diagnosis_report.html` | 金融纸风格 HTML 报告（衬线+等宽字体 base64 内嵌、纯 CSS 图表、零 CDN、离线自包含） |

---

## 统计工具

`snippets/stats_utils.py` 提供：

| 函数 | 用途 |
|------|------|
| `wilson_ci(p, n)` | Wilson 置信区间（比例，小样本稳健） |
| `chi2_test(table)` | 卡方独立性检验（列联表） |
| `welch_t_test(a, b)` | 均值差异 Welch 修正 t 检验 |
| `bootstrap_ci(values, fn)` | 通用 bootstrap 置信区间 |
| `severity_from_pvalue(sev, p)` | p>0.05 时严重度自动降一级 |

---

## Schema 校验

```python
from marketing_audit_skill.snippets.report_validator import validate_report, lint_report

errors   = validate_report(state)   # JSON schema 硬错误
warnings = lint_report(state)       # 写作约束软警告（禁用词等）
```

---

## 报告结构（HTML/Markdown）

渲染后的报告由四个章节组成：

| 章节 | 内容 |
|---|---|
| **封面** | 活动标题、核心结论、**3 个 KPI**（覆盖用户 / 高危问题数 / 优先行动数） |
| **封面执行卡** | **2 列布局**：左列"核心问题诊断"（排除定义性规则，负向问题优先+正向信号，横向条形图，按 `\|gap\|×rate` 排序）；右列"行动建议"（全部 priority_actions，难度标签 低/中/高，动词短语截取至第一个顿号） |
| **I 核心问题诊断** | Top 4-5 个问题的叙述卡片，引用 `narratives.problems` |
| **II 行动建议** | priority_actions 按执行时效分组（立即/短期/中期），含召回策略和盲点 |
| **III 详细诊断数据** | 触发规则 Top 10 完整数据表，**按执行难易（低→高）→触发比例（高→低）排序**，含执行难易彩色列 |
| **APPENDIX** | 置信度评分、决策轨迹、数据局限性 |

> **Agent 关注**：`priority_actions[].execution_difficulty` 影响封面行动建议卡的标签和详细数据表排序，**必须填写**（继承自 `diagnostic_rules.yaml` 的 `execution_difficulty` 字段）。

---

## 设计原则

- **零 LLM 依赖**：所有 `snippets/` 函数都是纯 Python，可在无网络环境运行
- **零 Agent 框架依赖**：宿主 Agent 自带编排能力，本 skill 只提供方法论和代码片段
- **强制覆盖**：6 维度必须全跑，置信度的 `data_coverage` 维度会核查
- **统计显著性约束**：6 维领域分析与 **31 条规则引擎**均做卡方检验，`p > 0.05`（差异不显著）时 severity 不得为 high 且 `effective_signal=False`；`n < 30` 时 confidence ≤ 0.6
- **去 AI 化报告**：`report_renderer.py` 遵循"故事化、选择性、去术语化"三原则

---

## 版本记录

| 版本 | 日期 | 更新内容 |
|---|---|---|
| v3.1 | 2026-06-16 | 封面/章节按实现难度低→高排序；典型案例改为"问题契合度选人"（10 模式 fit_fn），新增 `created_not_paid`/`post_order_disturb` 模式并补全 31 条规则全映射；行为路径升级为 `model:detail:major` 触点链（问题相关选点 + `×N`/`⋯`/`↩回退`）；红包展示各品类覆盖；指标全中文化 + "主流程"口径 + 目标零浏览红标；新增 Rule 43「推送零浏览品类」。详见 [CHANGELOG.md](CHANGELOG.md) |
