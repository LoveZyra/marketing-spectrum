# 08 — 诊断规则评估与结论生成 (Step 3b)

## 前置条件

`compute-thresholds` 已运行完成，`state["adaptive_thresholds"]` 和
`state["data_overview"]["diagnostic_rules_summary"]` 已填充。

---

## 规则汇总读取方式

```python
# 从 state 读取
rule_summary = state["data_overview"]["diagnostic_rules_summary"]
# 每条记录含：
# rule_id, category, name, display_name, positive_alias, status,
# trigger_rate, trigger_cnt, total_cnt,
# cvr_triggered, cvr_not_triggered, cvr_gap,           # 主口径 = 成单率(is_paid)
# create_triggered, create_not_triggered, create_gap,  # 过程口径 = 创单率(is_converted)
# cvr_gap_p_value, cvr_gap_significant,   # 触发组 vs 对照组 成单率 差异的卡方显著性
# _signal_type, effective_signal, is_definitional, is_positive_signal
```

> 🎯 **口径约定（统一成单率）**：`compute-thresholds` 把阈值「最优切分点」放在 **创单率（is_converted，信号更密、切分更稳）** 上找；但规则 CVR 对比、`effective_signal` 筛选、严重度判定、报告卡片展示**统一用成单率（is_paid，最终支付）**——即 `cvr_triggered/cvr_not_triggered/cvr_gap` 已是成单率值。创单率仅作 KPI 漏斗的过程指标（`create_*`），不进入单卡对比叙述。`state["_cvr_col"]` 记录主口径（默认 `is_paid`）。
>
> 🟩 **`display_name`（正向信号展示名）**：规则中文名编码的是负向假设（如「僵尸用户浪费营销」）。当数据把规则判为正向信号时，`display_name` 给出中性/正向别名（如「低活跃沉默用户成单较高」），渲染层与 draft 据此显示，**绝不把负向规则名挂在绿色正向卡上**。负向/定义性规则的 `display_name` 即原名。

> ⭐ **`effective_signal` 字段（优先看）**：布尔值。`True` 表示该规则已触发、属因果/正向信号、
> 效应量达标（**相对效应量** `rel=|cvr_gap|/对照CVR ≥ 30%` 且 触发样本 ≥ 100）**且统计显著（卡方 p<0.05）**。相对口径与基数无关，低转化活动（如成单率 0.04%）也能出信号，避免绝对 pp 阈值把稀疏口径的真实问题全部挡掉。triggered 规则里通常混有大量定义性
> （CVR=0 逻辑必然）或近零差值的规模型条目，`effective_signal=True` 的子集才是真正值得优先
> 生成 finding 的信号。thresholds_report.md 顶部会列出有效信号清单，对应行标 ⭐。
> **建议工作流：先处理全部 `effective_signal=True` 规则，再按需补充定义性规则（以规模叙述）。**

> 📊 **`cvr_gap_p_value` / `cvr_gap_significant`（统计显著性）**：触发组与对照组 CVR 差异的卡方检验结果
> （与 6 个领域分析口径一致）。`cvr_gap_significant=False`（p≥0.05）时差异可能为噪声：**该 finding 的
> severity 不得为 high（draft 自动封顶 mid），报告问题卡会显示「⚠️ 差异未达统计显著」**。scipy 不可用时
> p_value 为 null，按效应量/规模原逻辑评估（降级环境行为不变）。

**status 含义**：
- `triggered`：规则在数据中有命中行，需要 Agent 生成诊断结论
- `not_triggered`：无命中，可作为"该活动此问题不突出"的支撑依据
- `skipped`：必要字段缺失/全量 null（ETL 未回填），自动跳过，在 data_caveats 中记录
- `not_applicable`：**channel_filter 无匹配行**（规则不适用当前渠道类型），或维度级活动渠道门槛不满足，无法自动评估
- `full_trigger_no_baseline`：100% 触发，无对照组，无法量化 CVR 差值（通常是渠道适配缺陷，应检查 channel_filter）
- `disabled`：**业务评审已下线的规则**（yaml `enabled: false`）。引擎短路跳过，**不进 rule_summary、不进报告**，
  仅 `apply_all()` 里保留一行便于排查「这条规则去哪了」。与 skipped/not_applicable 的区别：那两个是「这次数据不适用」，
  disabled 是「业务判定不再使用」
- `below_min_trigger_rate`：触发率低于该规则的 `min_trigger_rate` 门槛（如 #41 要求 >5%），
  指标照常计算但不作为有效信号上报，避免小体量噪声进报告

> **channel_filter 机制**：规则可在 YAML 中声明 `channel_filter`（如 `activity_channel_std in ('push','popup')`）。引擎在评估前应用该过滤：无匹配行 → `not_applicable`，有匹配 → 仅在适用子集上评估。为特定渠道设计的规则在不适用渠道上会自动标记 not_applicable，不污染诊断。

> **applies_to / scope_filter 机制（V2.2 新增）**：`applies_to` 是规则的**适用活动范围**（`通用` / `广告投放` /
> `红包提醒·红包发放`），`scope_filter` 是它的可执行表达式。与 channel_filter 的分工：
> channel_filter 回答「这条规则在哪些**行**上算」，scope_filter 回答「这条规则对哪类**活动**才成立」。
> 不匹配时 → `not_applicable`，skip_reason 明确写「本规则仅适用于〈广告投放〉类活动」。

> **建议方向的唯一来源是 yaml 的 `recommendations` 字段**（2026-08-12 业务评审沉淀）。
> 本文档各章的「建议方向」表是它的可读快照，**以 yaml 为准**；改建议请改 yaml，不要只改这里。
> rule_summary 已把 `recommendations` / `applies_to` / `data_note` 带到 Agent 手里，可直接引用。

---

## 信号类型分层（`_signal_type` 字段）

每条规则在 rule_summary 中带 `_signal_type`，决定诊断处理方式：

| `_signal_type` | 含义 | 处理方式 |
|---|---|---|
| `causal` | 真实因果信号：触发CVR 与对照组有意义差异 | **主诊断**，按 `_score`（=\|cvr_gap\|×触发率×难易）排序，叙述含 CVR 对比+根因 |
| `positive` | 正向机会：触发CVR > 对照组且 相对效应量≥30%、样本≥100（显著性已校验）| 生成「正向机会」finding（severity=mid），作为优质人群定向或**保护型策略**（如排除冗余投放）|
| `definitional` | 定义性规则：触发条件含"未转化"语义，CVR=0% 是逻辑必然 | 叙述**以触发率(规模)为主，不强调 CVR 差值**；评分已强降权(×0.05) |
| `full_trigger` | 100% 触发无对照组 | 不进入主诊断，仅在 data_caveats 提示 channel_filter |

> **关键**：`positive` 信号是机会而非问题，渲染时标「正向机会」（绿色），不要写成负向问题。`definitional` 规则的诊断价值是"问题规模有多大"，不是"CVR 差多少"。

---

## 自动草拟 findings（减少手写负担）

`DiagnosticEngine.draft_findings_from_rules(rule_summary, top_n=6)` 按 `_signal_type` 分层
自动产出候选 finding 骨架（含标准 metric_refs 键名），宿主 Agent 只需润色 signal/detail
叙述并补业务影响，无需手拼指标：

```python
from marketing_audit_skill.snippets.diagnostic_engine import DiagnosticEngine
drafts = engine.draft_findings_from_rules(
    rule_summary=state["data_overview"]["diagnostic_rules_summary"], top_n=6)
# drafts 中 causal/positive 优先，definitional 补充；每条带 _draft=True 标记
# 宿主 Agent 润色后去除 _draft 标记，写入 state["findings"]
```

---

## Agent 生成诊断结论的工作流

### 0. 确定渠道词汇表（必须先于所有 finding 生成执行）

读取 `campaign_meta.target_channels`（或 `data_basic.activity_channel_dist`）确认本次活动的渠道组合，然后按下表约束 finding 中的渠道词汇：

| 渠道类型 | 专属词汇（该渠道存在时可用） | 排斥词汇（该渠道不存在时严禁出现） |
|---|---|---|
| `activity` / 活动 | 活动触达用户、活动推送、活动品类、活动用户 | 广告用户、广告投放、广告品类、广告进站、广告落地页 |
| `push` / Push 通知 | Push 触达用户、Push 推送用户、Push 渠道 | 该渠道不存在时禁用"Push 触达用户/Push 推送用户" |
| `popup` / 弹屏 | 弹屏触达用户、弹屏推送次数、弹屏打扰 | 该渠道不存在时禁用"弹屏触达用户/弹屏打扰/弹屏推送用户" |
| `sms` / 短信 | 短信触达用户、短信营销用户、短信推送 | 该渠道不存在时禁用"短信触达用户/短信推送用户" |
| `ad` / `cpc` / `dsp` / 广告 | 广告用户、广告投放、广告品类（全部广告词可用） | 该渠道不存在时禁用所有广告词汇 |

> **规则**：对 `activity_channel_dist` 中每种渠道类型，只使用该渠道对应的专属词汇；对于未出现在 `activity_channel_dist` 的渠道类型，其排斥词汇**一律不得**出现在 finding.signal/detail 和 narratives 中。
>
> **混合渠道**（如同时有 `push` 和 `popup`）：两种渠道词汇均可使用，但需在文中注明指的是哪个渠道。

### 0b. Finding 语言规范（运营友好，与步骤 0 同级前置）

**finding.signal 和 finding.detail 必须符合以下约束，否则 self_critique 将报 closure warning：**

| 约束 | 规则 | 示例（错 → 对） |
|---|---|---|
| 禁用规则编号 | 不得出现 `Rule N`、`规则 N`、`rule#N` 等任何形式的编号 | "Rule 11 触发率..." → "跨品类推送错配触发率..." |
| 英文字段名首次出现带中文 | 字段名首次出现格式为「`field_name`（中文）」，后续只用中文 | "`pre_mkt_touch_cnt`=9次" → "`pre_mkt_touch_cnt`（历史营销触达次数）=9次" |
| 禁用 ML 术语 | AUC、GBDT、LightGBM、feature importance 等一律不出现在对外文本 | "模型 AUC=0.78" → "转化预测模型识别准确率较高" |

> **finding.metric_refs[].name** 是内部结构字段，可保留英文键名（如 `cvr_triggered`），不受此约束。

### 1. 筛选高优先级规则

**第一步永远是取 `effective_signal=True` 子集**（已触发因果/正向 且效应量达标），它直接滤掉
定义性与近零差值噪声。再用 `_signal_type` 分层（见上），最后在 causal 内按以下顺序：
1. `status=triggered` 且触发行成单率显著低于对照（相对效应量 `rel=|cvr_gap|/对照CVR ≥ 0.30`）→ 高优先
2. `status=triggered` 且 `trigger_rate > 0.20`（触发比例高）→ 中优先
3. `status=triggered` 且 `trigger_rate <= 0.20` → 低优先，仅在报告中简要提及
4. `_signal_type=positive` 的正向机会**单独成条**，不与负向问题混排

### 2. 为每条高优先规则生成 finding

#### metric_refs 标准键约定（渲染器自动识别）

| 键名 | 含义 | 用途 |
|---|---|---|
| `cvr_triggered` | 触发组 CVR（0-1 小数） | 图表触发柱 / CVR 标签 |
| `cvr_not_triggered` | 对照组 CVR（0-1 小数） | 图表对照柱 / CVR 标签 |
| `cvr_gap` | CVR 差值（0-1 小数，**公式固定为 cvr_triggered − cvr_not_triggered**） | 差值标签、颜色判断 |
| `trigger_rate` | 触发比例（0-1 小数） | 三列指标"触发比例" |
| `n_event` | 触发用户数（整数） | 三列指标"触发用户数" |

> ⚠️ **cvr_triggered / cvr_not_triggered 必须来自 `diagnostic_rules_summary[rule_id]` 的同名字段，不得手工估写。**
> 核查方法：`cvr_triggered − cvr_not_triggered` 的符号必须与 `cvr_gap` 一致。
> - 负向规则（causal）：`cvr_triggered < cvr_not_triggered`，gap < 0
> - 正向规则（positive）：`cvr_triggered > cvr_not_triggered`，gap > 0
>
> 若填写的值方向相反，渲染器会自动纠正，但 `self_critique` 仍会报 warning 要求修正。

> **非标准键**（如 `flight_browsed_cvr`、`depth3_cvr`）可自由命名保留业务含义，但不被渲染器自动引用，需在 signal/detail 中手动引用。  
> **100% 触发规则**（`trigger_rate ≥ 0.99`）无对照组，请将 `cvr_not_triggered` 设为 `null`，渲染器会自动切换为单指标展示。

```json
{
  "agent": "diagnostic_rules",
  "rule_id": 2,
  "signal": "过度营销骚扰：当日触达≥N次用户占比 15.2%（n=1520），触发行 CVR 2.1% 低于未触发行 6.3%",
  "severity": "high",
  "detail": "超过CVR拐点的触达次数对该活动反而导致转化率下降...",
  "metric_refs": [
    {"name": "cvr_triggered",     "value": 0.021,  "n_event": 1520},
    {"name": "cvr_not_triggered", "value": 0.063,  "n_total": 8480},
    {"name": "cvr_gap",           "value": -0.042},
    {"name": "trigger_rate",      "value": 0.152},
    {"name": "n_event",           "value": 1520},
    {"name": "cvr_not_triggered", "value": 0.063, "n_total": 8480}
  ],
  "confidence": 0.85
}
```

### 3. 严重度判定指南

> ⚠️ **用基差无关的相对效应量，不用绝对 pp**：成单率基数(~2%)是创单率(~7%)的 1/3，绝对 pp 阈值会把成单口径的大问题误降级。
> 按**相对效应量** `rel = |cvr_gap| / 对照组CVR` 判定（draft 已自动计算，下表供手写时参考）：

| 条件 | 建议严重度 |
|---|---|
| `rel ≥ 0.60`（差值≥对照的 60%）或（覆盖 `trigger_rate ≥ 0.10` 且 `rel ≥ 0.30`） | high |
| `rel ≥ 0.30` 或 `trigger_rate > 0.30` | mid |
| 其余触发规则 | low |
| `severity_base=high`（规则本身定义）且触发 | 至少 mid，通常 high |

> ⚠️ **显著性封顶（硬约束）**：`cvr_gap_significant=False`（卡方 p≥0.05）时，无论效应量/规模多大，severity **不得为 high**（draft 自动降为 mid）。统计上无法区分于噪声的差异不应被列为高危问题。仅当 p_value 为 null（无 scipy）时按上表原逻辑评估。

---

## 执行可行性权重（影响 priority_actions 排序）

每条规则在 `diagnostic_rules.yaml` 中带 `execution_difficulty` 字段（`easy / medium / hard`），
来源于业务人员对各问题执行改造成本的评估。

在 `priority_actions` 排序时，**同等 severity/score 的规则优先推送 `easy` 问题**（快赢策略）：

| execution_difficulty | 排序权重 | finding.detail 建议措辞风格 |
|---|---|---|
| easy | ×1.2 | "在先知系统设置…" / "立即配置…上限" / "检查…标签配置" |
| medium | ×1.0 | "优化…逻辑" / "建立…机制" / "调整…策略" |
| hard | ×0.7 | "中长期规划…" / "需系统改造后…" / "建议纳入下期需求" |

`execution_difficulty` **仅影响同分位规则的相对排序**，不修改 `_score` 的 CVR 驱动计算逻辑。
在 finding 末尾标注 `（执行难度：容易/中等/困难）`，帮助业务快速判断落地成本。

---

## 各类别重点诊断方向与建议约束

> Agent 写 `finding.detail` 时，**必须覆盖对应规则至少一个建议方向**，但措辞须结合实际数据（含具体数字），不得原文照搬。建议方向来源于业务执行经验，作为解法空间约束，不作为固定输出模板。

### 触达质量（Rules 1, 2, 3, 4, 5, 37, 45）

**关注点**：无效触达率 + 过度触达阈值（从 `adaptive_thresholds.activity_touch_cnt.optimal` 读取）+ 跨渠道渠道种数（`insite_channel_cnt.optimal`）+ 人群质量

> ⚠️ **渠道适用性约束**：Rule 3（弹屏打扰）专为 `popup`/`弹屏` 渠道设计，使用弹屏触发计数字段。
> 若 `target_channels` **不含** `popup`/`弹屏`，将 Rule 3 标记为 `not_applicable`，不生成 finding。

| Rule | execution_difficulty | 建议方向（必须覆盖其一） |
|---|---|---|
| 1 无效营销触达 | medium | ① 优化人群定向，加限制条件排除近90天主流程行为=0 的低意向用户（"排除无主流程行为"过泛）；② 检查营销落地页与内容匹配度 |
| 2 过度营销骚扰 | easy | ① **按渠道分设**单用户单日触达上限（弹屏最严、Push 次之，各渠道上限 = 该渠道 CVR 拐点 N，从 adaptive_thresholds 读取）；② 超标用户进入冷却名单 |
| 3 弹屏打扰 ⚠️ popup渠道专属 | medium | ① 优化弹屏触发时机，避开用户关键操作路径；② 增加关闭按钮可见性；③ 弹屏内容与用户当前浏览意图匹配 |
| 4 人群质量过低 | easy | ① 投放人群加上风控标签的过滤（排除风险用户/近1年负营收/极短停留）；② 先核查圈选人群质量与活动-人群匹配度，再决定是否投放 |
| 5 僵尸用户浪费营销 | easy | ① 建立用户活跃度筛选机制：**近90天访问天数处于最低四分之一**且当日无主流程行为的，减少营销触达；② 优先触达近期有主流程行为的高价值用户 |
| 37 跨渠道频次叠加疲劳 | medium | ① 建立单用户跨渠道每日触达上限（Push+Popup+站内信合计不超过 CVR 拐点渠道种数，从 `insite_channel_cnt.optimal` 读取）；② 设置渠道互斥规则，当日已触达 N 种渠道后暂停其余渠道 |
| 45 低意向过度营销 ⚠️ 仅广告投放 | medium | ① 广告投放排除该人群，标记为低活跃用户不再投入效果预算；② 仅保留 1 次/月品牌曝光 |

> ⚠️ **Rule 2 的口径提醒（写进 data_caveats）**：弹屏存在曝光/点击/关闭三种 action，
> `activity_touch_cnt` 与 `pre_popup_touch_cnt` 应只统计「曝光」。上游大宽表口径修正前，
> 本条对 popup 渠道的触达次数偏高，阈值判定偏严。

> ⚠️ **Rule 45 适用范围**：`applies_to=广告投放`，`scope_filter: activity_channel_std == 'ads'`。
> 非广告活动上自动 `not_applicable`。阈值「站内四渠道合计 ≥3 次」是业务硬值，
> 同时输出 `insite_total_touch_cnt` 的 CVR 拐点作**对照**（`threshold_reference`，不参与判定）；
> 写 finding 时可把两个数一起摆出来，供业务判断是否切换到自适应口径。
> 与 #1（无主流程却有触达）、#5（僵尸用户）同属「无主流程低意向」主题组，覆盖检查合并。

### 时机匹配（Rules 6, 7, 44）

**关注点**：时段不一致率（`period_mismatch_flag`）+ 先知场景实时/离线配置（伪实时）

> ⚠️ **Rule 7 口径已纠正（2026-08-12）**：原名「营销时机滞后」、description 写的是「触达晚于成单的时序反转」，
> 但它的 condition 只算 `pre_last_order_to_touch_min <= 拐点`，**从未校验触达与成单的先后顺序**。
> 现改名为「成单后推送过急」，severity 由 high 降为 mid，叙述只讲「间隔过短」。
> 疑似时序倒置属于**先知实时场景标签配置问题**，走 #44 伪实时场景配置排查，不要在本条里写「时序反转」。

| Rule | execution_difficulty | 建议方向（必须覆盖其一） |
|---|---|---|
| 6 营销时机不当 | easy | ① 检查先知场景是否实时场景使用了离线标签（伪实时问题）；② 订阅消息"实时场景"改配"即时发送" |
| 7 成单后推送过急 | easy | ① 将营销推送时间延后；② 查看实时场景标签是否配置错误 |
| 44 伪实时场景配置 | easy | ① 排查实时场景（`is_today`）是否误配离线节点（`scene_has_offline_node`），改为即时发送；② 校验先知场景标签实时性，避免人群量级缺失与推送时段错配 |

### 内容匹配（Rules 11, 43）

**关注点**：目标品类零接触（`pre_target_product_visit_cnt=0 且 pre_browse_target_product=0`）的占比及 CVR

> 🔄 **Rule 11 口径已变更（2026-08-12 业务评审）**：由 `pre_mkt_product_browse_match == 0`
> （目标品类 ≠ 兴趣最深品类，"软"错配）改为
> `(pre_target_product_visit_cnt == 0) & (pre_browse_target_product == 0)`
> （目标品类既没访问过也没浏览过，"零接触"）。`pre_mkt_product_browse_match` 不再被任何规则引用
> （字段保留，模型分析仍用）。写 finding 时**不要再用「兴趣最深品类不一致」的措辞**。

> ✅ **渠道适用性**：Rule 11 已覆盖 `activity`/`push`/`popup`/`sms`/`outbound`/`insite_msg` 渠道，
> 对**活动渠道**同样适用，常是活动类活动转化最强的可控因素。

| Rule | execution_difficulty | 建议方向（必须覆盖其一） |
|---|---|---|
| 11 跨品类推送错配 | medium | ① 根据用户实时浏览行为动态调整推送内容；② 建立用户兴趣标签实时更新机制 |
| 43 推送零浏览品类 | medium | ① 推送前校验 `pre_target_product_visit_cnt > 0`；② 从未浏览目标品类则降级为通用红包 |

> **11 与 43 的关系（口径变更后）**：43 = 11 ∧ `pre_mainflow_event_cnt > 0`，即 **43 是 11 的真子集**
> ——「对目标品类零接触，但对别的品类是有行为的」。这批人不是不活跃，是对该品类没兴趣，误投代价高于沉默用户。
> **两条必须合并为一条 finding**（取触发体量/效应量更强者作主，另一条只在同一段里补一句子集规模），
> 严禁分开上报造成"同一批人报两遍"。
>
> ⚠️ **重叠度监控**：两条的 Jaccard 在合成数据上已达 0.96。上线后若在真实活动上仍 ≥0.9，
> 说明 43 已无独立信息量，应把 43 也软下线、由 11 单独承载（在 CHANGELOG 记一笔即可）。

### 站内外衔接（Rules 12, 13, 14）

**关注点**：`insite_multi_channel_match_flag=0`（站内多渠道品类不一致）+ `ads_no_insite_flag` 触发率 + `ads_insite_match_flag=0` 占比

> ℹ️ **Rule 12（站内多渠道品类不一致）** 用 `insite_multi_channel_match_flag`，适用全渠道（不依赖广告字段）；Rule 13/14 才是广告渠道专属。站内不足 2 种渠道时 `insite_multi_channel_match_flag` 为 NULL，规则自动不命中。

> ⚠️ **渠道适用性约束**：Rule 13/14 使用 `ads_*` 前缀字段，语义上专为**广告渠道**（`ad`/`cpc`/`dsp`/`display`）设计，测量"站外广告→站内落地页"的品类一致性。
> - 若 `campaign_meta.target_channels` **不含**广告类型渠道：
>   1. 将 Rule 13/14 标记为 `not_applicable`，不生成主要 finding
>   2. 若 `ads_*` 字段仍有非零值，在 `data_caveats` 中注明："`ads_insite_match_flag` 在活动渠道下含义存疑，数据仅作参考，不作为主结论依据"
>   3. **转向 Rule 11（跨品类推送错配）**作为内容匹配类问题的主 finding
> - 只有渠道中包含广告类型时，才可以用"广告进站""广告落地页"等词汇写 finding

| Rule | execution_difficulty | 建议方向（必须覆盖其一） |
|---|---|---|
| 12 站内多渠道品类不一致 | medium | ① 建立跨渠道品类一致性校验，同一用户同日多渠道路由一致品类；② 设置渠道间品类互斥规则，优先推送用户兴趣最深品类的活动 |
| 13 站内外项目不一致 | easy | ① 广告进站用户有项目标识时，站内弹屏/站内信投放一致项目的红包和落地页（**仅适用于广告渠道**） |
| 14 站外无站内承接 | medium | ① 建立站外广告到站内承接的联动机制；② 用户进站后首屏展示与广告内容相关的落地页或活动（**仅适用于广告渠道**） |

### 关键打断（Rule 39）

**关注点**：到达填写页后流失、且历史弹屏常被快速拒绝的人群规模与 CVR

> 🗑️ **本类目已于 2026-08-12 业务评审大幅收缩**：Rules 15/16/17/18 全部软下线（理由见文末「已下线规则」），
> 只保留 #39。**不要再基于 `pre_last_mainflow_detail` 的"详情/填写"文本匹配写打断类结论**——
> 该口径依赖页面命名，稳定性差且业务侧不可执行。
> 支付决策窗口的干扰问题请走「遗单召回」主题组（#21 / #25）叙述。

> ⚠️ **渠道适用性约束**：Rule 39（弹屏打扰填写）专为 `popup`/`弹屏` 渠道设计。
> 若 `target_channels` **不含** `popup`/`弹屏`，将 Rule 39 标记为 `not_applicable`，不生成 finding。

| Rule | execution_difficulty | 建议方向（必须覆盖其一） |
|---|---|---|
| 39 弹屏打扰填写 ⚠️ popup渠道专属 | medium | ① 填写页期间禁止弹屏；② 设置订单流程中的营销静默期 |

> ⚠️ **窗口口径提醒（2026-08-12 fix25/fix26）**：特征表 `marketing_audit_base_feature_activity`
> 是**按 date 分区的近1天窗口**，`pre_*` 字段全部只覆盖当天。写 finding 时**不得**把它们
> 表述为「历史」「长期」「从未」——那是把一天行为外推成长期画像。
>
> **#5 与 #21 已叠加长周期画像字段**：#5 加 `visit_days`（近90天访问天数）p25 门槛，
> #21 加 `serialid_bonus`（近1年促销订单占比）p75 门槛。这两条现在才真正能说「长期低活跃」
> 与「价格敏感」；画像未 join 上时整条 skipped，**宁可不报也不用一天行为下长期结论**。
> 其余 A 级规则（#11/#19/#25/#27/#43）尚未叠加长周期字段，叙述须严格限定在「当日」。

### 转化效率（Rules 19, 20, 21, 41）

**关注点**：自然转化占比（#19）+ 缺少优惠的遗单用户占比（#21）+ 创单→支付漏出率（#41）

| Rule | execution_difficulty | 建议方向（必须覆盖其一） |
|---|---|---|
| 19 自然转化营销多余 | medium | ① 建议缩小人群投放范围，把"自然转化型"用户（自己来+不找券+不点营销+路径直达）通过先知人群包排除；② 接入红包补贴价敏人群算法，仅对优惠敏感用户补贴 |
| 20 过度营销浪费 | easy | ① 设置单用户单日触达上限（= CVR 拐点 N 次）；② 无响应用户进入 24h 冷却名单 |
| 21 缺少临门一脚优惠 | medium | ① 对**价格敏感的**遗单用户及时发送专属优惠券或红包；② 设置创单未付自动发券流程；③ 优化优惠门槛，提高核销率 |
| 41 营销触发下单未成单 | medium | ① 创单未付用户及时发送促付提醒或优惠券；② 如果本身是红包提醒类活动，检查用户创单金额是否不满足门槛、或红包不可用；③ 搭配支付立减提升转化 |

> ⚠️ **Rule 41 有触发体量门槛**：`min_trigger_rate: 0.05`。创单未付占比 ≤5% 时状态为
> `below_min_trigger_rate`，**不生成 finding**（体量太小，写进报告是噪声）。
> 指标照常计算，可在 data_overview 里引用数字，但不作为问题项上报。

### 流程体验（Rules 23, 25, 27）

**关注点**：比价犹豫 + 遗单习惯（漏斗倒退口径已于 2026-08-12 下线）

| Rule | execution_difficulty | 建议方向（必须覆盖其一） |
|---|---|---|
| 23 跨品类比价未决策 | hard | ① 识别比价用户提供跨品类对比工具（中长期）；② 针对比价用户推送限时优惠促进决策 |
| 25 多次创单未付 | medium | ① 针对多次遗单用户发送专属优惠或触发客服介入；② 分析未付原因（支付问题/比价/意外中断）针对性解决 |
| 27 低意向仅营销 | medium | ① 优化人群定向，排除漏斗深度≤1 的低意向用户；② 优先营销漏斗深度≥3 的高意向用户以提高 ROI |

### 创单前营销（Rules 33, 34, 35, 38）

**关注点**：创单前触达次数 + 渠道多样性

> ⚠️ **渠道适用性约束**：Rule 35（创单前弹屏过多）专为 `popup`/`弹屏` 渠道设计，使用弹屏触达计数字段。
> 若 `target_channels` **不含** `popup`/`弹屏`，将 Rule 35 标记为 `not_applicable`，不生成 finding。

| Rule | execution_difficulty | 建议方向（必须覆盖其一） |
|---|---|---|
| 33 创单前营销过多 | medium | ① 控制创单前营销频次（参考 CVR 拐点）；② 设置冷却期，单用户 2 小时内不超过 2 次触达 |
| 34 创单前多渠道冲突 | hard | ① 建立跨渠道营销协调机制（中长期）；② 设置渠道互斥规则，优先使用历史响应率最高的渠道 |
| 35 创单前弹屏过多 ⚠️ popup渠道专属 | medium | ① 减少弹屏频次，单用户单日不超过 1 次；② 使用其他温和渠道替代多余弹屏 |
| 38 活动堆叠冲突 | hard | ① 建立活动冲突检测机制（中长期）；② 设置活动优先级，同一用户同日只触发最高优先级活动 |

### 优惠机制（Rule 42；46 待数据）

**关注点**：领券平台与下单主平台不一致占比（`pre_last_coupon_platform != pre_primary_platform`）

| Rule | execution_difficulty | 建议方向（必须覆盖其一） |
|---|---|---|
| 42 红包与下单平台不符 | easy | ① 提示业务侧考虑限制红包使用平台，避免跨平台领券不可用 |

> 🚧 **Rule 46 红包门槛过高（已建条目，`enabled: false`，P2 待数据）**：
> 判定「红包门槛 > 对应订单项目 GMV 的 130%」。阻塞原因：大宽表 `action` 列现为
> `concat(couponamount, smallvalidamount)`，需拆出 `coupon_amount` / `coupon_min_valid_amount`；
> 「优享红包不可用占比」口径待业务补充。
> **P1 过渡做法**：用画像字段 `gmv`（近 1 年客单价）做代理，算出「门槛/客单价」分布，
> 只写进 `data_caveats` 作观测，**不生成 finding**。

> 🗑️ **「用户价值」类目已整体下线（2026-08-12）**：原仅含 Rule 40 高频下单。
> 高频下单属于用户分层描述而非营销问题，不适合作为诊断项。
> 高价值人群的差异化运营建议请放进 action_plan 的中长期项，不再作为 finding 上报。

---

## 关联规则合并原则

部分规则逻辑高度相关，应合并为一个 finding（避免重复）：

| 合并组 | 规则 | 合并逻辑 |
|---|---|---|
| 过度触达 / 频次管控 | 2, 20, 33, 37 | 合并为"过度触达浪费"一条 finding（2/20/33 按触达次数、37 按跨渠道渠道种数，从不同维度刻画频次过载） |
| 无主流程低意向 | 1, 5, 45 | 合并为"低意向人群浪费"一条 finding（1 按本次触达、5 按历史沉默、45 按站内多渠道累计≥3 次；45 仅广告投放活动出现） |
| 内容错配 | 11, 43 | **必须合并**：43 是 11 的真子集（11 ∧ 有其他主流程行为），分开上报＝同一批人报两遍 |
| 遗单召回 | 21, 25 | 合并为"遗单用户策略"一条 finding（原 16/18 已下线） |

---

## 规则 #4（人群质量）处理方式

> 自 V2.1 起，Rule 4 已**激活为自动评估**（不再 `auto_eval=false`）。基于新增用户画像字段
> `risk_type`（风控）/`finance_revenue_after`（营收）/`timediff`（停留时长）按
> `(risk_type=='风险用户') | (finance_revenue_after<0) | (timediff<10)` 判定低质量人群占比。
> 字段缺失（数据未回填）时规则自动 `skipped` 并在 `data_caveats` 记录，无需手工处理。
> 距上次消费>360天的"久未消费"信号需补充 `days_since_last_order` 派生字段后再叠加。

---

## 已下线规则（`enabled: false`，2026-08-12 业务评审）

下列规则**不会出现在 rule_summary 中**。若历史报告或 state 里出现这些 rule_id，属于下线前的产物。
Agent 不得基于这些口径生成任何 finding；用户问起时按「已评审下线」+ 原因回答。

| rule_id | 规则名 | 原类别 | 下线原因 |
|---|---|---|---|
| 15 | 详情页营销打断 | 关键打断 | 详情页停留与营销触达的时间差不足以判定「打断」，误诊率高；业务侧不可执行 |
| 16 | 弹屏打断支付 | 关键打断 | 与 #39 弹屏打扰填写重叠，且创单未付归因不清 |
| 17 | 填写页营销打断 | 关键打断 | 口径依赖 `pre_last_mainflow_detail` 文本匹配，稳定性差 |
| 18 | 营销干扰支付 | 关键打断 | 漏斗倒退归因到营销缺乏时序证据 |
| 24 | 漏斗严重倒退 | 流程体验 | 倒退次数与转化的关系不稳定，阈值不可解释 |
| 40 | 高频下单 | 用户价值 | 属用户分层描述而非营销问题 |
| 46 | 红包门槛过高 | 优惠机制 | **不是下线，是 P2 待数据**：需大宽表拆出红包金额/门槛字段 |

**待办（`pending_change` 字段登记，下一批次认领）**

| rule_id | 待改动 | 阻塞项 |
|---|---|---|
| 3 | 条件扩为 `... & ((pre_popup_close_rate>0.6) \| (timediff<10))` | 新派生字段 `pre_popup_close_rate`（popup 分类中 action='关闭'） |
| 2 | 弹屏触达次数只计「曝光」 | 上游大宽表口径修正 |
| 45 | 固定阈值 3 → 自适应拐点 | 需 `insite_total_touch_cnt` 派生字段 + 一个月对账数据 |

---

## 输出格式要求

- 每条 finding 的 `signal` 字段必须包含**具体数字**（触发率、CVR、阈值）
- `metric_refs` 中的 `value` 必须来自 `diagnostic_rules_summary` 的实际计算值
- 不得使用"可能"、"或许"、"似乎"等模糊词汇
- 标题模板：`<问题类别>：<具体数据陈述>，CVR <触发行%> vs 未触发行 <CVR%>`
