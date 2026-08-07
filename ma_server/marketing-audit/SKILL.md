---
name: marketing-audit
description: Diagnose marketing campaign performance from user behavior wide tables and campaign metadata. Use when the user provides parquet/csv campaign behavior data plus campaign configuration and asks for campaign diagnosis, conversion analysis, audience segmentation, root-cause analysis, optimization actions, report generation, or self-critique of marketing findings.
---

# Marketing Audit

> 本文件面向 Claude Code 等宿主 Agent。阅读本文件后，Agent 应知道：要做什么、读哪些文件、走什么路由、通过哪些硬门槛。不需要一次性加载所有 methodology 文件——按需读取。

## 术语定义

| 术语 | 含义 |
|------|------|
| phase | manifest 中的逻辑阶段（如 `discover_data`、`domain_analysis`、`critique`、`synthesize`） |
| tool | `TOOLS_MANIFEST.json` 中的可路由单元 |
| snippet | `snippets/` 下的确定性 Python 模块 |
| methodology | `methodology/*.md` 中的 LLM 判断规则 |
| state | 跨 phase 传递的唯一共享 dict |

## 快速路径（10 步）

1. 获取 `campaign_meta`：仅 `campaign_name`+`target_products` 硬必填；其余可用 `cli prepare --auto-meta` 从数据自动推断（见 `methodology/01_campaign_profile.md`）  
   ⚠️ **`--auto-meta` 已知陷阱**：`target_products` 从 `activity_product_name` 推断，该列有时存的是页面名（如"特价机票业务总览"）而非品类名（"机票"），**必须向用户确认**，否则 Rule 11（跨品类推送错配）等规则全部误判
2. 加载 csv/parquet/xlsx 到 `df`
3. 运行 `cli prepare` → 得到 `state_partial.json`（6 维统计 + 模型分析）
4. 运行 `cli compute-thresholds` → 得到 `adaptive_thresholds`（CVR 驱动）+ 诊断规则触发率（规则集以 `feature_schema/diagnostic_rules.yaml` 为准，当前 33 条）（含 `_signal_type` 分类 + `effective_signal` ⭐ 有效信号标记 + `cvr_gap_p_value`/`cvr_gap_significant` 卡方显著性，`effective_signal` 已要求 p<0.05）；⚠️ 阅读 `thresholds_report.md` 顶部「最具区分度字段 TOP」表、`⚠️ 异常值警告` 与规则汇总「显著性」列，未达显著（p≥0.05）的差异 severity 不得为 high
5. **运行 `cli draft`**（推荐）→ 自动装配 `state_draft.json` 骨架：每个 `effective_signal` 主题组各产一条 finding（覆盖全部强信号，天然满足 `signal_coverage`）、候选 `audience_segments`、`narratives.problems`（含 `typical_case`，从 `case_pool` 自动匹配）、`priority_actions`（problem_rank 自洽）。草稿已满足结构性完整项，仅余「未润色」一条 block 待 Agent 清除（润色完 [待润色]、删 `_draft`、置 `_stage=full` 即解除）。⚠️ 阅读 `thresholds_report.md` 顶部「最具区分度字段 TOP」表与 `⚠️ 异常值警告`。
6. **润色草稿**：打开 `state_draft.json`，按 `methodology/03..08` 把所有 `[待润色]` 文案改写为运营友好叙述（signal/detail/narrative/title/typical_case/headline；**保持 metric_refs 数值不变**），正向信号单独成条、定义性规则以规模叙述，按证据强弱调整 severity；删除各对象 `_draft` 标记，把 `_stage` 置为 `"full"`。
   > 不想用 draft 时可退回手写：先取 `effective_signal=True`（⭐）子集，用 `DiagnosticEngine.draft_findings_from_rules()` 取骨架后手补 segments/narratives/actions。
7. 复核 `narratives.problems`、`action_plan.priority_actions`、`audience_segments` 引用自洽（problem_rank、target_audiences 指向真实 segment）
8. 运行 `cli run-tools --tools self_critique`：处理 `signal_coverage`（漏诊主题）、`statistical_coherence`（含符号自洽）、`closure` 等 issue；若现有工具粒度不足，可按 `methodology/07` 使用 `adhoc_synthesis`
9. 如需内部评分，运行 `cli run-tools --tools confidence`；新版 HTML/Markdown 不单独展示顶层 confidence 模块
10. 运行 `cli render`（自动跑 `validate_report` + `lint_report_completeness`，block 级缺项阻断）→ 检查硬门槛清单

> **推荐全流程**：`prepare → compute-thresholds → draft → 润色(_stage=full) → run-tools self_critique → render`。draft 把"从零手搓"变成"润色"，并使每次报告结构一致、强信号不漏。
> 需要人群规则落库/圈人时，draft 之后即可先跑 `cli crowd-rules`（不必等润色/render）。

### CLI 关键参数

- `cli prepare --meta '{"campaign_name":"x","target_products":["机票"]}'`：内联 JSON 或文件路径
- `cli prepare --auto-meta`：从数据推断 campaign_name/channel/平台/日期等（推断的平台写 `inferred_platform`，**不触发过滤**）
- 仅当**用户显式** `--meta` 提供 `target_platform` 时才按平台过滤数据；过滤条件记入 `state._filter_applied`，`compute-thresholds` 自动复用以保证两步骤数据一致
- `cli crowd-rules --state state_draft.json --out <dir>`：从 state（draft 即可）构建可执行人群规则 → `crowd_rules.json`。外部人群 pipeline 应走此子命令消费规则，不要直接 import `snippets/` 内部模块
- 环境变量 `MA_MODEL_SAMPLE`（默认 `500000`，`0`=关闭）：`prepare` 的模型训练前下采样上限——**正样本全保留、只采样负样本**（少数类占比异常时自动退回等比分层）。只有模型训练吃采样，统计/漏斗/阈值仍为全量口径；模型分析输出的计数/CVR 亦已按采样率外推回全量口径（2026-08-05）；采样明细与"训练类别先验被抬高"的提示写入 `data_caveats` 与 events 决策日志（2026-08-04，治千万行级 prepare 超时）

## 功能概述

对营销活动用户行为宽表（parquet/csv）+ 活动配置元数据（dict）进行全维度诊断，输出：

- **findings**：各维度问题清单（`severity: high | mid | low`）
- **audience_segments**：圈人包（筛选条件 + 预期 CVR）
- **narratives + action_plan**：故事化叙述 + 优先行动方案
- **adhoc_synthesis / self_critique / confidence**：内部复诊、质检与评分能力；可写入 state，但新版 HTML/Markdown 不作为独立模块展示

## 输入

| 参数 | 类型 | 说明 |
|------|------|------|
| `data_path` | str / Path | 用户行为宽表，每行一个用户。**推荐**含 `is_converted` 列；缺失时先调用 `data_fallback.ensure_field("is_converted")` 派生；无法派生则降级模型分析并在 `data_caveats` 标注。 |
| `campaign_meta` | dict | 活动配置元数据。**仅 `campaign_name` 和 `target_products` 为硬必填**，其余字段可选（缺失写 null）。见 `methodology/01_campaign_profile.md`。 |
| `output_dir` | str / Path | 诊断结果输出目录。 |

## 核心工作流（路由驱动，唯一模式）

宿主 Agent 读 `TOOLS_MANIFEST.json`，评估 preconditions，自主决定调用 / 跳过 / 回退。不固定执行顺序。

```
LOOP:
  1) 扫描 state keys + df 列 → context
  2) 读 TOOLS_MANIFEST.json，过滤：preconditions 已满足 且 postconditions 未写入 的 tool
  3) 优先级：compute_thresholds > must_run tool > synthesize_report > optional self_critique/confidence > render
  4) 候选为空但存在 open hypothesis，且现有工具无法覆盖 → 进入 adhoc_synthesis；证据合并回 findings/data_caveats，不生成报告展示模块
  5) 调用 tool，写 state，通过 event_logger.log_decision 落 _decision_trace
  6) precondition 失败 → 调 data_fallback（methodology/06）后重试
  7) 6 个 domain + diagnostic_rules 完成 → synthesize_report；若结论矛盾/证据不足/用户要求质检 → self_critique，必要时复诊
  8) 可选写入 confidence 作为内部评分；validate_report 通过 → render
 
 **诊断约束**：所有规则诊断仅基于 diagnostic_rules.yaml 规则集（当前 33 条，以该文件为准）。
                  诊断目标只考虑 is_converted 和 is_paid 的高低，不使用点击率等其他指标。
```

## Phases（对应 TOOLS_MANIFEST）

`discover_data` → `describe_data` → `compute_thresholds` → `model_required` → `domain_analysis`（×6）→ `diagnostic_rules` → `synthesize` → `score_and_render`

具体 tool 路由规则、preconditions、postconditions 全部在 `TOOLS_MANIFEST.json`。

## 按需读取导航

| 当你需要… | 读取 |
|-----------|------|
| 诊断活动配置先天缺陷 | `methodology/01_campaign_profile.md` |
| 解读模型特征 | `methodology/02_model_analysis.md` |
| 撰写 narratives / action_plan | `methodology/03_synthesis.md` |
| 计算内部置信度评分（不展示） | `methodology/04_confidence.md` |
| 运行内部 self-critique 质检/复诊 | `methodology/05_self_critique.md` |
| 处理缺失字段 / 派生列 | `methodology/06_data_fallback.md` |
| 生成内部临时工具（现有工具不满足时） | `methodology/07_adhoc_tools.md` |
| 诊断规则评估与结论生成（含执行难易权重、建议方向约束） | `methodology/08_diagnostic_rules.md` |
| 读取数据驱动阈值（含异常值警告字段） | `methodology/09_adaptive_thresholds.md` |
| 查询字段语义 | 在 `references/behavior_fields.md` 中按字段名搜索，只加载匹配章节 |

## 模型分析——分级策略

1. `lightgbm` 或 `xgboost` 可 import → 运行 `run_model_analysis(df)`（两后端规则抽取同权：分类切分/空值/反选改写行为一致，2026-08-05）。模型人群按**区分性特征**自动命名（独有条件优先、标签带方向、类别值入名，2026-08-05），top3 选取会按命中人群 Jaccard 去冗（`decision_rule_max_jaccard` 默认 0.5），避免只差一个阈值的近重复规则各占一个名额。行数超过 `MA_MODEL_SAMPLE`（默认 50 万）时训练前自动下采样（正样本全保留、只采负样本）：AUC/特征重要性等排序型结论不受影响；输出的计数/CVR/lift 已按采样率无偏外推回**全量口径**（`n_samples_population`/`precision_population`/`lift_population`，2026-08-05），报告与圈人预估可直接引用；仅"把模型概率当绝对值用"（概率阈值圈人）仍需按训练/真实先验比校准（提示在 `data_caveats`）。
2. 不可用 → 在 `state["data_caveats"]` 记录缺席原因；`state["model_analysis"] = None`；最终诊断仅使用统计规则与领域统计；若运行内部 confidence，`model_quality` 自动降权为 0.0。
3. **仅在用户明确同意时**才安装依赖，不得自行 `pip install`。

## 硬门槛清单

提交产物前，宿主 Agent 必须确认全部通过：

- [ ] `TOOLS_MANIFEST.json` 中所有 `must_run=true` tool 均已执行（含 `compute_thresholds`、`model_analysis`、`model_interpreter`、6 个 `domain_*`、`diagnostic_rules`、`synthesize_report`）
- [ ] `state["_decision_trace"]` 非空；每条 must_run tool 有 `kind=invoke` 或 `kind=fallback` 记录
- [ ] 6 个 `agent_raw_stats[dim]` 均已填写
- [ ] 若运行过 `self_critique`：所有 `questioned/pending` 项都有显式归宿（修订 / 接受为 caveat / 复诊 / 移入 blind_spots（仅内部记录，不在报告展示）/ 删除）
- [ ] 若运行过 `adhoc_synthesis`：相关 evidence 能在 `state.adhoc_evidences` 找到，不把临时工具作为新版报告独立章节展示
- [ ] 若写入 `state["confidence"]`：仅作为内部评分使用，不要求 HTML/Markdown 展示顶层 confidence 模块
- [ ] `priority_actions[].target_audiences` 引用了真实存在的 `audience_segments[].name`
- [ ] `headline` 不含禁用词且长度 30–60 字（推荐 30–50，超 50 仅触发软警告不阻断 render）
- [ ] `priority_actions[].title` 均含具体数字，格式 `<动词> <幅度>，<指标> <现状>→<目标>`
- [ ] `state["_stage"]` 已设为 `"full"`
- [ ] `validate_report(state)` 返回空列表（无 schema 错误）
- [ ] `lint_report_completeness(state)` 无 `level=="block"` 项（页面一致性硬保障：核心问题非空、`priority_actions[].problem_rank` 在 `[1,N]` 内）；`render` 默认对 block 级缺项阻断产出。warn 级（缺 `typical_case`、人群断链、问题数 <3、问题无行动）应尽量补齐
- [ ] 若 `findings` 中 `severity=="high"` 少于 3 条：将证据最强的 `mid` 条目提升进主问题列表，**保留其真实 severity**，不得为凑数量而拔高 severity

> **页面一致性保障（render 内置，Agent 无需手动处理）**：章节缺数据时渲染带标签占位卡而非整章消失，单模块异常自动降级，4 大章节（核心问题 I / 行动建议 II / 详细诊断数据 III / 附录）锚点与左侧目录恒在。

## 示例文件

| 文件 | 用途 |
|------|------|
| `examples/enrich_with_critique_loop.py` | 内部 self_critique 闭环参考 |
| `examples/enrich_with_adhoc.py` | 内部 ad-hoc synthesis 复诊参考 |
| `examples/input_example.md` | 输入数据与 campaign_meta 完整模板 |
| `examples/output_example.json` | 期望输出 JSON 示例 |

## Schemas

| 文件 | 用途 |
|------|------|
| `schemas/finding.schema.json` | Finding 结构定义 |
| `schemas/audience_segment.schema.json` | 人群包结构定义 |
| `schemas/action.schema.json` | 优先行动结构定义 |
| `schemas/report.schema.json` | 完整报告结构定义 |

## 输出

- `{output_dir}/diagnosis_report.json` / `.md` / `.html`：由 `snippets/report_renderer.save_report(state, output_dir)` 生成，须在 `validate_report(state)` 无错误后调用
- `{output_dir}/crowd_rules.json`：可执行人群规则（`source`/`direction`(push|exclude)/`pandas_filter`/`sql_filter`(Spark SQL)/`estimated_size` 等）。render 时随报告自动产出；也可在 draft 后用 `cli crowd-rules` 提前单独产出（两者同源 `snippets/crowd_translator.build_crowd_rules`，内容一致）。`sql_filter` 为 best-effort 翻译，消费方在目标表上执行前应做 `LIMIT 0` dry-run 校验
