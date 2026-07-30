# 营销诊断 Skill 优化日志

> 2026-06-16 一轮试用反馈驱动的优化。按主题分类，列出变更点、动机与涉及文件。

---

## ★ 2026-07-01 未润色报告拦截闸门收紧（根治"报告产出不完整"）

**动机**：多活动批量诊断的报告出现大量未润色内容（"补充业务影响（30-50字）"、"（基于 key_features 补一句用户画像）"、"（草稿，待润色）"等直接渲染进 HTML）。根因**不是** draft_builder——`[待润色]` 占位是**设计特性**（让宿主 Agent 的 LLM 针对每个活动的真实发现产出个性化文案，而非定死模板）。真正的漏洞在**完整性闸门太窄**：`lint_report_completeness` 的 `draft_not_polished` 只统计带方括号的 `[待润色]`。批量流程若用"机械去标记"（正则删 `[待润色…]` 方括号并置 `_stage=full`）代替真正的 LLM 润色，就会：① 删掉方括号标记后闸门计数=0、蒙混过关；② 留下占位里的说明句（不含方括号）和表头非方括号的"（草稿，待润色）"→ 未润色内容渲染进报告。

| 变更 | 说明 | 文件 |
|---|---|---|
| **闸门改检测裸串"待润色" + 骨架填充签名句** | `draft_not_polished` 由 `blob.count("[待润色]")` 改为 `blob.count("待润色")`（覆盖 `[待润色]`/`（草稿，待润色）`/任意变体——draft 每个占位字段都含"待润色"三字），并新增 12 条 draft 骨架填充签名句（"补充业务影响"、"补充现象+数据叙述"、"（基于 key_features"、"补一句用户画像"、"动词开头，补具体行动描述"…）检测；任一命中即 block。**不硬编码任何报告文案**，只是强制"必须真正 LLM 润色（占位被替换）才能出报告"。 | `snippets/report_validator.py` |

**为何这是正确的修法**：draft 的每个 `[待润色]` 占位字段都含"待润色"三字，故裸串检测 100% 覆盖未润色字段；填充签名句检测是对"机械去标记"漏网场景的兜底。二者叠加使**任何未经 LLM 润色的 state 都无法通过 render 闸门**，从机制上根除"报告产出不完整"。draft_builder 的 `[待润色]` 设计**保持不变**（LLM 按 methodology/03 逐条润色仍是既定流程）。

**验证**：① 复现旧失败模式（机械 strip 15 个活动 draft）→ 新闸门**全部拦截**（旧 `[待润色]` 残留=0 会漏过，新裸串"待润色"=1 被抓）。② 特价机票-正式.csv 全流程（prepare→compute-thresholds→draft→**真实 LLM 逐条润色**→self_critique 0 issue→render）：schema 0 错、lint 0、completeness 0 阻断，四大模块齐全、0 处填充残留、headline 50 字、正文为基于该活动真实发现的个性化叙述。③ parquet 随机 **12 个活动**（行 82–34,723、成单率 0–35%、公共/酒店/火车票等品类）全流程复跑 `prepare(--no-model)→compute-thresholds→draft`：12/12 跑通；11 个产出 findings（4–9 条）+4 核心问题，1 个零转化活动产出 0 问题；**每个活动的生 draft 与"机械去标记" draft 均被闸门拦截**（`draft_not_polished` 或零问题活动的 `no_problems`）——即任何未经真实 LLM 润色的 state 都无法 render 出报告，从机制上确保不会再产出不完整报告。

## ★ 2026-07-01 多活动批量诊断发现：阈值计算不耐受"N+"分桶字段

**动机**：用 `20260701_营销诊断测试数据.parquet`（108 个活动、渠道均 activity）做**逐活动批量诊断**时，`compute-thresholds` 在部分活动上崩溃：`TypeError: unsupported operand type(s) for -: 'str' and 'str'`（`np.percentile`/`np.quantile` 的 `_lerp`）。根因：V2.1 上限分桶字段 `360d_create_order_count`（值 `0,1,2,3,4,5,"5+"`）、`order_pc` 等含 `"5+"` 使整列为 object dtype，被登记为阈值字段后进入分位数计算即报错。历史 CSV 无此类分桶值故未暴露。

| 变更 | 说明 | 文件 |
|---|---|---|
| **阈值字段稳健数值化** | `compute_adaptive_thresholds` 取列改为 `series = _numeric(df[name])`；新增 `_numeric()`：数值列原样返回，object 列按"去掉首个非数字字符及其后"（`"5+"→"5"`）再 `to_numeric`，纯非数值列整体转 NaN 由分位数/CVR 计算自动排除并走 fallback。 | `snippets/threshold_computer.py` |
| **补 3 条规则 positive_alias** | 60 活动批量中规则 **24 漏斗严重倒退**（38 活动）、**43 推送零浏览品类**（33）、**11 跨品类推送错配**（4）在部分活动数据判为正向，但缺 `positive_alias` → 汇总里显示通用「{类别}·正向机会」。补：24=历史多次回退用户成单较高、43=目标品类零浏览仍成单较高、11=跨品类兴趣用户成单不低。至此跨 60 活动出现的正向规则均具名。 | `feature_schema/diagnostic_rules.yaml` |

**验证**：① 崩溃活动（如「超级星期三 高星酒店买一送一」1122 行）修复后 `compute-thresholds` 正常产出 79 字段阈值、17 触发、4 有效信号，全流程 `prepare(--no-model)→…→render` 通过、HTML 生成。② 该两分桶字段未被任何诊断规则 `condition_template`/`required_fields` 引用，故 `DiagnosticEngine` 无需改动。③ 零转化活动核心问题为空属真实结论，批量侧用 `--skip-completeness` 产出"无显著问题"占位报告并标记（非技能缺陷）。

## ★ 2026-06-30 全流程回归（国际酒店 151 万行）发现的报告呈现缺陷修复 — 第 1 轮

**动机**：以「海外酒店红包」全量数据（1,514,650 行、红包领取渠道、成单率 0.04%）跑通 `prepare→compute-thresholds→draft→润色→self_critique→render` 后，逐字审阅三件套，发现 5 处「报告格式/内容不合理」缺陷（非阻断但影响可读性与正确性）。

| # | 缺陷（运行中实测） | 修复 | 文件 |
|---|---|---|---|
| 1 | **正向规则缺别名→绿卡挂通用名**：Rule 7（营销时机滞后）、37（跨渠道频次叠加疲劳）数据判为正向，但 yaml 无 `positive_alias`，`display_name` 退回通用「{类别}·正向机会」，核心问题卡徽章显示为「时机匹配·正向机会」「触达质量·正向机会」，信息量为零。 | 为全部 6 条「可正向/已声明正向但缺别名」规则补 `positive_alias`：**7**=近期成单复购人群成单较高、**37**=多渠道可达用户成单较高、**13**=站外引流自主进站成单较高、**14**=仅站外触达自主意向强成单较高、**34**=多渠道覆盖用户成单较高、**38**=多活动叠加用户成单较高。 | `feature_schema/diagnostic_rules.yaml` |
| 2 | **MD 章节号跳号**：核心问题为「第一章」、行动建议却标「第三章」，中间模型摘要无章号，读者误以为缺「第二章」。 | 行动建议 MD 标题 `第三章 → 第二章`（模型摘要为非章节小节，保持无号）。 | `snippets/report_renderer.py` |
| 3 | **摘要恒显误导性「预期增量支付订单 0」**：人群包未带 `expected_cvr_mid` 时聚合恒为 0，摘要仍硬显示「预期增量支付订单 0」，读作"零增量/坏数据"。 | 增量为 0/不可得时**省略该子句**（兑现函数 docstring「避免摘要恒显示误导性的 0」原意）。 | `snippets/report_renderer.py` |
| 4 | **低基数活动模型 CVR 塌成「0.0%」**：模型摘要 `整体成单率 {:.1f}%` 在 0.04% 基数下显示「0.0%」，与摘要表「0.04%」矛盾。 | 按量级自适应有效位：`<1%` 用 2 位小数（0.04%），`≥1%` 用 1 位。 | `snippets/report_renderer.py` |
| 5 | **正向机会被称「根本问题」**：核心问题章 h2 恒为「N 项相互关联的根本问题」，但本活动 4 项中 2 项为正向机会，把机会称作"根本问题"不合理。 | 标题/副标题按问题与机会构成自适应：全负向→「N 项相互关联的根本问题」；含正向→「N 项核心发现（含 M 项正向机会）」；全正向→「N 项正向机会」。 | `snippets/report_renderer.py` |

**验证**（同数据重跑 `compute-thresholds→draft→润色→self_critique→render`）：display_name 7=「近期成单复购人群成单较高」、37=「多渠道可达用户成单较高」✓；MD 出现「第一章/第二章」、无跳号 ✓；摘要无「预期增量支付订单」误导子句 ✓；模型摘要「整体成单率 0.04%」✓；HTML 核心问题章标题「四项核心发现（含 二 项正向机会）」、通用「·正向机会」徽章清零 ✓；render schema 0 错、completeness 0 阻断、self_critique 0 issue。`doctor` ✓（33 规则无漂移、10 类 ease）。

### 第 2 轮（详细表/MD 一致性）

| # | 缺陷（运行中实测） | 修复 | 文件 |
|---|---|---|---|
| 6 | **详细诊断表严重度列恒为「中等」**：`_chapter3` 读 `r.get("severity_base","mid")`，但 `severity_base` 不在 `compute-thresholds` 的 `export_cols` 中（引擎产出却未导出），故 Top10 表所有规则严重度恒显示「中等」——89.8% 体量的「过度营销浪费」与 0.1% 的小规则同级，列失去意义。 | 新增 `_rule_row_severity(row)` 数据驱动严重度（相对效应量 + 体量 + 显著性封顶；定义性按体量、泄漏按人数），替代静态 `severity_base`。 | `snippets/report_renderer.py` |
| 7 | **MD 正向机会与问题混排无区分**：HTML 用绿色区分正向卡，但 MD 无颜色，核心问题章「二、高潜人群清晰可识别」等正向机会与真实问题同样式罗列，读者误当问题。 | MD 核心问题标题对正向机会加「【正向机会】」前缀（按主证据 finding 的 `_signal_type` 判定）。 | `snippets/report_renderer.py` |
| 8 | **89.8% 红包空耗 finding 仅记 mid，且高危<3 触发兜底警告**：「过度营销浪费」覆盖 136 万用户（89.8%）是最大体量问题，却按定义性保守记 mid，与详细表数据驱动严重度（严重）不一致，并使 `lint` 报「high<3」。 | 该 finding 严重度按体量上调为 high（与数据驱动一致），高危计数 2→3，`lint` warning 清零。 | 润色（state_full） |

**第 2 轮验证**：详细表严重度按数据分级——过度营销浪费/无效营销触达=严重、营销干扰支付/填写页打断/多次创单未付=轻微、其余=中等，与核心问题卡一致 ✓；MD 出现「二、【正向机会】…」「三、【正向机会】…」✓；摘要「高危 3 · 中危 2」、`lint` 0 warning、render schema 0 错、self_critique 0 issue ✓。

### 第 3 轮（低基数模型方向）

| # | 缺陷（运行中实测） | 修复 | 文件 |
|---|---|---|---|
| 9 | **模型摘要 Top5 特征方向全为「≈混合」**：`_compute_feature_direction` 的 mixed 绝对下限 `max(0.008, 0.40×base)` 在成单率 0.04% 下恒由 0.008（0.8pp）主导，而特征 top/bottom 组 CVR 差仅 0.01~1.5pp，全部 < 0.8pp → 方向全塌为 mixed，0.96 AUC 模型的方向洞察归零。与已修的 effective_signal「绝对 pp 不适配稀疏口径」同源。 | 绝对下限 0.008/0.012 → **0.0005/0.0008**（降 16 倍）：中高基数活动 `0.40×base` 仍主导、行为不变；低基数活动方向判定恢复。 | `snippets/model_analyst.py` |

**第 3 轮验证**：重跑 `prepare`（模型重训）后，Top 特征方向恢复——`pre_last_order_to_touch_min`↑、`insite_product_cnt`↑、`first_insite_product_name`↓，不再全为 ≈；MD 模型摘要显示「#1 站内承接品类 ↓ / #2 最近成单到触达时间差 ↑ / #5 站内营销品类数 ↑」✓。

### 第 4 轮（低基数 lift 精度）

| # | 缺陷（运行中实测） | 修复 | 文件 |
|---|---|---|---|
| 10 | **「潜在改善」lift 列/卡恒显 0.00pp**：封面「核心问题→行动」矩阵 lift 列与问题卡「全量预期可改善约 X pp」用固定 `.2f`，在 0.04% 基数下 lift（`|gap|×触发率`）均 <0.01pp → 全显示「+0.00」「约 0.00pp」，读作"无改善"。 | 新增 `_fmt_lift()` 自适应精度：≥0.01pp 行为与旧 `.2f` 一致，更小量级保留 3~4 位有效数字，避免误导性 0.00。 | `snippets/report_renderer.py` |

**第 4 轮验证**：封面矩阵 lift 显示「+0.005 / +0.001 / +0.01」、卡片「可改善约 0.005pp」等非零真值 ✓。

### 第 5 轮（特价机票回归发现：模型子群 finding 泄漏 ML 术语）

| # | 缺陷（回归中实测） | 修复 | 文件 |
|---|---|---|---|
| 11 | **模型子群拟合 finding 泄漏「AUC」+ 裸字段名**：`_interpret_stratified_auc` 生成 user-facing finding `fnd_model_stratified_auc`，`detail`＝"拟合不足子群：pre_primary_platform=微信 (AUC 0.719)"——含 ML 术语「AUC」与英文字段名，违反 methodology/03·08 语言规范（render lint 报 warning）。该观测本属「模型内部质量」，方法论定义为 blind_spot（仅内部、不在报告展示）。 | 该子群拟合观测**只写 `auto_blind_spots`（内部）、不再产出 user-facing finding**；信息不丢失，且报告不再出现 AUC/裸字段名。 | `snippets/model_interpreter.py` |

**第 5 轮验证**：对两数据集既有 `model_analysis` 直接重跑 `interpret_model()`——`fnd_model_stratified_auc` 不再出现、任何 finding 均不含「AUC」、blind_spot「模型对部分子群拟合不足」保留 ✓。

### 第 6 轮（人工复审补充：封面副句写死 → 改为 Agent 撰写）

| # | 缺陷（人工复审发现） | 修复 | 文件 |
|---|---|---|---|
| 12 | **封面副句由渲染层自造数据结论**：`_exec_summary` 用固定「创单用户中仅 X% 完成支付」模板（仅百分比算出）。本活动创单=成单（564=564）→ 支付率 100% → 渲染成自相矛盾的"仅 100.0% 完成支付"。**根因是架构越界**：渲染层不应撰写带数据判断的定型句（任何定型句都会在某类边界数据上失真），prose 应由 Agent 面向真实数据撰写。 | 渲染层**不再自造数据结论句**：封面副句优先取 Agent 撰写的 `narratives.subhead`（面向真实数据、不会矛盾），缺省仅回退到**不含任何数据判断**的结构导航句「下文按严重度拆解核心问题…」。方法论 `03` 新增 `narratives.subhead` 可选字段说明。 | `snippets/report_renderer.py`、`methodology/03_synthesis.md` |

**第 6 轮验证**：国际酒店（Agent 写 subhead）封面显示「创单即成单、无支付漏损；问题集中在海量低意向人群空耗与红包无转化增量，同时存在可放大的高潜复购人群。」；特价机票（未写 subhead）走缺省回退，显示纯结构导航句、无任何 `仅 X% 完成支付` 定型句；两者全文无"仅 100"矛盾串；re-render schema 0 错、lint 0、completeness 0 阻断。

**同轮顺带排查**：按上述原则全量扫描渲染层自造结论句，另修 `_extract_headline` 兜底句——原写死"主要集中在渠道效率、品类匹配与优惠机制三个维度"（臆断维度，非每个活动成立），改为不臆断维度的中性兜底"活动存在 N 项高危问题，详见下文核心问题诊断"。（该兜底仅在 Agent 完全未写 headline 时触发，正常流程不出现。）

> **通用原则（本轮沉淀）**：凡"带数据结论的句子"一律由 Agent（LLM）面向真实数据撰写并入 state，渲染层只负责布局与回退到无数据判断的安全占位；渲染层严禁自造会随数据变化的定型结论句（否则必在某类边界数据——创单=成单、零转化、单一渠道等——上失真）。

### 收敛验证（国际酒店全量 + 特价机票回归）

**国际酒店（1,514,650 行，成单率 0.04%）最终态**：`prepare(AUC 0.962)→compute-thresholds(5 有效信号)→draft→润色→self_critique(0 issue, 13/13 accepted)→render`：schema 0 错、completeness 0 阻断/0 警告、lint 0、渠道词汇 0 违规；三件套四大模块（核心问题含正向机会绿标 / 行动建议 / 详细诊断数据 / 附录人群包数据局限）齐全；正向徽章具名、详细表严重度分级（过度营销浪费/无效触达=严重）、模型方向有箭头（↑↓）、lift 非零、headline 49 字；全文 0 处 `[待润色]`/`_draft`/`·正向机会`/`预期增量支付订单 0`/`约 0.00pp`/裸 NaN。

**特价机票（50,000 行，成单率 2.14%）回归**：`prepare(AUC 0.807)→compute-thresholds→draft→render`：模型方向 5 正/4 负/1 混（中基数行为不变，证明方向下限下调无回归）、有效信号 8（与历史一致）、render schema 0 错/completeness 0 阻断、findings 不含 `fnd_model_stratified_auc`、全文无「AUC」泄漏。残留 2 条 lint（headline 52 字、行动标题缺数字）系本次回归用**通用脚本**机械去标记所致（非技能缺陷，真人润色即消，国际酒店真润色为 0 warning）。

**收敛结论**：6 轮（含人工复审）全流程测试共发现并修复 **12 处**（11 处技能代码/数据 + 1 处严重度口径），均为低基数/呈现一致性类缺陷，根因同属「绝对阈值/静态字段/写死措辞在稀疏成单口径或创单=成单场景下失真」。两数据集全流程零阻断、报告四大模块齐全、内容无 ML 术语/裸字段名/误导性 0 值/自相矛盾串；中基数数据集无回归。本轮循环收敛、结束。

## ★ 2026-06-30 有效信号阈值改为相对效应量（基差无关）

**动机**：诊断「海外酒店红包」活动（红包领取渠道、当日国际酒店成单率仅 **0.04%**）时，`effective_signal` 用**绝对 1.5pp** 门槛——在 0.04% 基数下任何 CVR 差都 <0.05pp，结构性地把所有信号挡掉（0 有效信号、0 问题、报告为空）。这正是历史记录的「绝对 pp 阈值不适配稀疏成单口径」问题。

| 变更 | 说明 | 文件 |
|---|---|---|
| **正向门槛 / effective_signal 改相对口径** | `POS_GAP_MIN=0.015`（绝对 1.5pp）→ **相对效应量 `rel=|cvr_gap|/对照CVR ≥ 0.30`**（与严重度 mid 档一致）；保留触发样本≥100 + 卡方 p<0.05 两道护栏防低基数噪声。口径仍为创单率/成单率。 | `snippets/diagnostic_engine.py` |
| **文案同步** | 引擎 `format_rule_summary_md`、`self_critique` 漏诊注释、`methodology/08`（effective_signal 定义 + positive 信号判定）同步为相对口径。 | `snippets/self_critique.py`、`methodology/08_diagnostic_rules.md` |

**验证**：① 特价机票（成单率 2.14%）**无回归**——核心问题（跨品类错配/跨渠道/自然转化等）仍为有效信号，有效信号 7→8（多捕获 1 个 <1.5pp 但相对≥30% 且显著的真实信号）。② 海外酒店红包（0.04%）：有效信号 **0→2**——复购用户（成单率 0.21% vs 0.04%，p=0.013）、多渠道触达用户（0.08% vs 0.03%，p=0.002）两个统计显著的正向高潜子群浮现；全流程（含模型）跑通、render 通过。

---

## ★ 2026-06-25 V2.1 新特征接入 + 规则知识库对齐（已收敛）

**动机**：① 把 `0630优化/新增特征.txt` 的两类新特征（用户画像 20 + 先知场景 4）登记进 skill；② 参照 `0630优化/0630规则知识库.md` 更新诊断规则：删除文档标注的冗余规则、修复缺陷规则、接入新特征；除"逻辑定死的判断性规则"外，其余规则阈值仍由模型/数据驱动（`threshold(field,'optimal')` 占位，不硬编码）。

| 轮次 | 变更 | 文件 |
|---|---|---|
| **特征登记** | 维度 12 用户画像（20）+ 维度 13 先知场景（4）；数值价值字段配 percentile 阈值。详见上一条 V2.1 记录。 | `feature_schema/feature_registry.yaml`、`references/behavior_fields.md`、`snippets/report_renderer.py` |
| **规则删除（11 条）** | 按知识库「建议删除」删除 **8,9,10,22,26,28,29,30,31,32,36**（时序倒置重复/场景过窄/正向信号误作问题/与他规则高度重叠/决策效率类诊断价值低）。决策效率类别因此清空（`_CATEGORY_EASE` 保留该类别条目以备将来）。 | `feature_schema/diagnostic_rules.yaml` |
| **Rule 37 并入频次管控组（保留）** | 用户决定：删 37 会丢失 `insite_channel_cnt`（跨渠道渠道种数叠加疲劳，上版报告核心问题之一），故**保留 Rule 37 并并入触达质量·频次管控组**——与按「触达次数」管控的 Rule 2/20/33 同属「过度触达」finding 合并组，从「渠道种数」维度互补，合并为一条 finding 避免重复。阈值仍由数据驱动（`insite_channel_cnt.optimal`，非判断性规则）。 | `feature_schema/diagnostic_rules.yaml`、`feature_registry.yaml`、`snippets/*`、`methodology/08` |
| **补回 KB 基础规则 Rule 12** | yaml 早前缺失知识库基础规则 **Rule 12 站内多渠道品类不一致**（`insite_multi_channel_match_flag==0`，站内外衔接，全渠道）；补回以与 KB 基础规则一致。最终 **33 条**（KB 基础 31 含 12/37 + 技能增强 43 推送零浏览品类 / 44 伪实时场景）。 | `feature_schema/diagnostic_rules.yaml`、`feature_registry.yaml` |
| **新特征接入规则** | **Rule 4 人群质量过低**：由死规则（auto_eval=false）激活为 `(risk_type=='风险用户') \| (finance_revenue_after<0) \| (timediff<10)`（用户画像新字段，判断性规则）。**新增 Rule 44 伪实时场景配置**：`(is_today==1) & (scene_has_offline_node==1)`（先知场景新字段，判断性规则，承接 KB 对 Rule 6 的伪实时建议）。两者字段缺失时安全 skip，待数据到位自动评估。 | `feature_schema/diagnostic_rules.yaml`、`feature_registry.yaml` |
| **缺陷规则修复** | **Rule 19 自然转化** 升级为多信号交叉验证：剔除循环条件 `is_converted==1`，改用「首触非营销+无领券+从未点营销+路径直达(跳详情 或 不返列表+不跨品类+≤3页)」锁定自然转化型用户（判断性正向规则）。 | `feature_schema/diagnostic_rules.yaml` |
| **依赖同步** | 清理删除规则所有残留引用、补 Rule 4/12/44：registry `diagnostic_rules` 链接、`draft_builder` 三张映射、`self_critique._COVERAGE_GROUPS`、`diagnostic_engine._RULE_THRESHOLD_FIELD`。`doctor` ✓（32 规则、无漂移、10 类别 ease）、全 snippet import ✓、0 悬挂引用。 | `snippets/draft_builder.py`、`self_critique.py`、`diagnostic_engine.py` |
| **方法论/文档同步** | `methodology/08` 各类别建议方向表重写（删 building block、加 Rule 4/12/44、Rule 19 升级措辞、并入 KB 对 Rule 1/2/5 的优化建议、合并组与「#4 处理方式」更新）；`methodology/01` 设计-规则联动表去除已删规则；`methodology/03` 禁编号示例改用现存规则；`00/04/09/SKILL/README` 规则数 42→31→**32** 同步。 | `methodology/*.md`、`SKILL.md`、`README.md` |
| **全流程回归测试** | 合成数据集（真实 CSV 50000 行 + 24 新特征列，分布设计触发 Rule 4/44）跑 `prepare(含/不含模型)→compute-thresholds→draft→render`：32 规则、22 触发、0 跳过、6 有效信号；**Rule 4 触发率 9.75%、Rule 44 19.7%、Rule 19 升级后正向(cvr_t 10.9% vs 2.1%)**；删除规则全部不在；含 10 个新数值特征的 79 字段阈值（仍由 CVR/分位数据驱动）；含模型路径 AUC 0.806 正常处理新列；draft 信号覆盖 0 漏诊、render 4 卡正常。 | 端到端验证 |

**收敛结论**：规则集 **33 条**与 KB 基础规则完全一致（缺失 0、删除已应用、Rule 12 补回、Rule 37 并入频次管控组保留、增强 43/44 有据），新特征已接入诊断规则；除判断性规则（4/12/19/44）用定死逻辑外，其余规则阈值仍由模型/数据驱动（含 Rule 37 的 `insite_channel_cnt.optimal`）。`doctor` ✓（33 规则无漂移）、0 悬挂引用、全流程回归零异常（真实 CSV：Rule 37 触发 99%、cvr 2.12% vs 4.02% 复现上版核心发现；新特征列缺失时 Rule 4/44 安全跳过）。本主题收敛、循环结束。

---

## ☆ 2026-06-24 报告样式定稿固化进 skill（进行中，分多轮）

**动机**：把多轮试调定稿的「老核心问题卡 + 奶白底纯黑字 + S3 鲜明高对比」样式直接固化进 `report_renderer.py`，清除旧暖色「金融纸」样式，不做样式兜底，模板完全基于定稿样式。配套：用正式数据 `dataset/特价机票-正式.csv` 全量重跑 ≥5 次，每次发现问题即修，直至模板完全正确、skill 无优化点。

| 轮次 | 变更 | 文件 |
|---|---|---|
| **R1 调色板** | `:root` 暖色「金融纸」→ 定稿配色：奶白底 `#faf9f5`、白纸面 `#fff`、纯黑字 `#000000`、次级 `#444444`、S3 红 `#e23b3b`/绿 `#1f9e78`/琥珀 `#b45309`、深褐红强调 `#bb3b27`；补充老卡片(diag-card)所需别名变量（`--soft/--soft-2/--accent/--ink-2/--ink-3/--line-soft/--green/--amber`）。源码内 19 个硬编码暖色 hex（75 处）同步复合重映射到定稿色（gen_templates A ∘ S3 ∘ 纯黑）。已渲染验证：`--bg/--ink/--red/--grn` 正确、暖色残留 0。 | `snippets/report_renderer.py` |
| **R2 核心问题卡** | 「01 大号斜体」版式 → 老版 **diag-card**：chip 头部（#N + 类别/规则 chip + 黑色加粗标题 + 难度/严重度徽章）+ **坐标轴条形图**（网格刻度 + 触发/对照两条，`<title>` 悬停/点选显具体值）+ 右侧 KPI（触发比例 / 触发用户数 / 全量预期改善）+ 业务影响框 + 典型案例折叠。新增 `_CARDS_CSS`（作用域 `.fp-oldcards`，配色直接固化为 S3 定稿，无后处理）、`_nice_axis`/`_svg_chart`/`_diag_card`/`_diag_case`；删除旧 `_finding_article`/`_case_block` 死代码。字体按角色统一：标题/正文衬线(Lora)、标签无衬线、数字等宽(Spline Sans Mono)。头部 chip 改轻量中性（类别 `#f1ede7/#6f6256`、规则 `#faf9f6/#8c8579`）、严重度仅文字、难度浅底药丸；典型案例突出节点统一红色。保留「差异未达显著」提示（数据正确性）。已渲染验证：4 卡正确、悬停 `<title>` 齐全、正向卡绿/负向卡红语义正确、口径自适应（is_paid→支付成单率 / 否→创单率）。 | `snippets/report_renderer.py` |
| **R3 标签配色** | 章节眉标(.18em：刊头/核心结论/I/II/III/附录)→ 深褐红 `#7c2d12`；封面漏斗/矩阵标题(.14em)→ 纯黑加粗；各表表头(.06em，矩阵/详细/附录)→ 纯黑加粗；详细诊断表两列支付率（触发/正常）值 → 纯黑（差值列仍保留红绿语义）；漏斗步骤小标签「创单→支付」→ 纯黑加粗（数值/箭头/失血点仍红）。渲染校验：眉标/表头残留 `var(--red)`/`var(--lab)` 计数 = 0。 | `snippets/report_renderer.py` |
| **R4 回归 & 健壮性** | 正式数据全量回归（11 组数据形态，全部 0 异常）：4 个流水线态 `state_draft/partial/full`+`diagnosis_report`（partial=1 卡、full=4 卡，皆正确）+ 6 个边界用例（切换创单率口径、无典型案例、cvr 全空、零问题、案例 metrics/timeline 为空、文本含 HTML 特殊字符 / `**` / `[[rule]]`）+ 口径切换校验（is_converted→「创单率」19 处、is_paid→「支付成单率」）。**与定稿样张结构级比对**：`report_终版_S3鲜明高对比.html` 全部 `.diag-*` 选择器/元素 class 一致（仅多出有意新增的 `.diag-sig-badge`）；关键 CSS 规则体与样张「层叠生效值」逐项一致（样张含 base+`#font-unify` 覆盖两套，本版直接固化为单套定稿值，更干净）。视觉抽查：封面/三卡/展开典型案例(画像+指标格+时序红高亮+根因)/详细表，均与样张一致。`ast.parse`+`import` 通过、无悬挂引用、暖色残留 0。 | `snippets/report_renderer.py` |
| **R5 端到端全量运行** | `dataset/特价机票-正式.csv`（50000×221）**完整跑 5 次** `prepare→compute-thresholds→draft→render`：run2 含模型（xgboost AUC=0.806，interpreter +1 finding/+4 segment）、run1/3/4/5 `--no-model`。每次 4 卡，调色板/眉标/表头全部正确、暖色与残留红标签 = 0；run1/3/4/5 的卡片结构（卡数/图表标题/CVR 值/差值）**逐字节一致 → 流水线可复现**；新流水线产物复现了既有 `diagnosis_report.json` 的 CVR（38.18%/1.72%/0.56%/3.18%），印证渲染器与上游集成无缝。`doctor` 全绿（217 特征 / 42 规则 / 类别 ease 无漂移）。说明：draft 阶段的 `[待润色]` 文案与 headline/title lint 属宿主 Agent LLM 润色环节（设计如此），非模板/样式问题。 | 端到端验证（未改代码） |

**收敛结论**：模板已完全固化进 skill 且与定稿样张一致；旧暖色「金融纸」核心问题版式与 `_finding_article`/`_case_block` 死代码已清除，无样式兜底。正式数据端到端全量运行 5 次（含模型 1 次）全部正确且可复现，多形态回归零异常。模板完全正确、样式层无遗留优化点，本主题收敛、循环结束。

---

## ★ 2026-06-18 诊断口径统一为成单率（is_paid）

**动机**：用户要求"卡片渲染口径都以成单率为准""模型分析也以 is_paid 为目标"，并修复一轮试用发现的 4 个问题。统一口径同时根除了"创单口径有效、成单口径却近零"的自相矛盾信号。

**口径解耦（Option B）**：最优切分点仍在创单率（`is_converted` ~7%，信号密、切分稳）上找；规则 CVR 对比 / 有效信号 / 严重度 / 卡片 / 模型全部用成单率（`is_paid` ~2%）。创单率仅作 KPI 漏斗过程指标。

| 变更 | 动机 | 文件 |
|---|---|---|
| **模型目标改 `is_paid`**：`TARGET_COL="is_paid"`，`_rule_stability`/`_rule_overlap`/`_compute_feature_direction` 改 target 参数；prepare 前置校验改 is_paid | 用户要求模型以成单为目标 | `snippets/model_analyst.py`、`cli.py` |
| **compute-thresholds 口径解耦**：`split_col=is_converted`（切分）/`eval_col=is_paid`（判定+展示），写 `state["_cvr_col"]`；新增 `create_*` 创单率过程列；`--target-col` 默认改 is_paid | 切分要密信号、展示要成单率 | `cli.py`、`snippets/threshold_computer.py`（新增 `cvr_*_eval` 成单率切分） |
| **#1 正向信号绿标配负向规则名**：yaml 新增 `positive_alias`（10 条）→ 引擎 `display_name` → draft/renderer 全链路用展示名 | 负向规则名（如"僵尸用户浪费营销"）不该挂绿色正向卡 | `feature_schema/diagnostic_rules.yaml`、`snippets/diagnostic_engine.py`、`draft_builder.py`、`report_renderer.py` |
| **#2 人群包口径与 finding 触发人群不一致**：人群包改用规则真实触发条件，规模与 finding 同源 | 旧 curated 代理字段选错字段，rule37 人群只剩 1/17（2912 vs 49477） | `snippets/draft_builder.py` |
| **#3 创单/成单双口径对不上** | 全口径统一成成单率即根除 | （上述解耦） |
| **稀疏成单率下的绝对阈值修复**（同类 bug 4 处）：严重度改基差相对效应量；模型方向 mixed 阈值改基差自适应；`model_interpreter` 漏判 share 恒 `/100`（旧启发式把 0.37% 误当 37%）；创单未付/促付类规则用 `创单率≈100%且成单更差` 识别重述 | 成单率基数(~2%)是创单率(~7%)的 1/3，硬编码 pp 阈值全失真 | `snippets/draft_builder.py`、`model_analyst.py`、`model_interpreter.py` |
| **渲染层口径自适应**：卡片/详表/模型摘要/漏判提示均按 `_cvr_col` 显示"成单率"，移除 `paid_*` 覆盖逻辑 | 主口径已是成单率，无需二次覆盖 | `snippets/report_renderer.py` |
| **文档同步** | 口径说明一致 | `TOOLS_MANIFEST.json`、`methodology/02、03、08、09` |

> #4（rule37 条件文案）经查证非 bug：`insite_channel_cnt>=1` 正确（523 名 0 渠道为对照组）。

**全量逐文件审计补充**（同日）：

| 变更 | 动机 | 文件 |
|---|---|---|
| `draft_findings_from_rules`（手写退回骨架）同步：绝对 5pp→基差相对效应量、正向用 `display_name`、措辞改成单率 | 与 `build_draft` 一致，避免成单口径下误降级/挂负向名 | `snippets/diagnostic_engine.py` |
| domain snippets 26 处"转化率"标签→"创单率"（仅标签，计算不变）+ 守门注释 | 6 个 domain 统计是创单率过程上下文、不展示；显式标口径，杜绝被当成成单率混入问题卡 | `snippets/{funnel,attribution,platform_behavior,user_segment,price_sensitivity,path_quality}.py`、`methodology/00、03` |
| 文档/schema 描述补全成单率口径 + 新字段（`create_*`/`cvr_*_eval`/`display_name`） | 描述与实现一致 | `methodology/00、02、08`、`schemas/report.schema.json`、`schemas/finding.schema.json` |
| 删除孤儿示例 `enrich_partial_state.py`（旧手写工作流）+ 清引用；移除 model_analyst 该示例专属中文键；重生成 `output_example.json` | 历史残留，统一到当前 draft 工作流 | `examples/`、`snippets/model_analyst.py`、`README.md` |

---

## 00. 2026-06-17 报告渲染层重做（金融纸模板 + 单文件整合）

**动机**：把报告样式升级为「金融纸」离线自包含模板，并把渲染层从双文件收敛为单文件、清掉旧模板残留与死代码。

| 变更 | 动机 | 文件 |
|---|---|---|
| **报告模板全面迁移「金融纸」**：Lora 衬线 + Spline Sans Mono 等宽（字体 subset 后 base64 内嵌，零 CDN）、暖纸配色、双线刊头、转化漏斗带、问题→行动矩阵、编号发现卡（**纯 CSS 条形，移除 Chart.js**）、固定左侧目录 + scroll-spy | 升级报告观感并保证内网/离线/合规可直接交付 | `snippets/report_renderer.py`、`assets/fonts/fonts.css` |
| **矩阵/行动卡末列「现状→目标」改为「人群触发占比」**：渲染层直接读规则汇总 `trigger_rate`，不再依赖文本反解/Agent 填值；回退此前为「现状→目标」加的 `expected_metric` 基础设施 | 「现状→目标」抓不到数显示「—」；触发占比数据驱动、稳定 | `report_renderer.py`、`draft_builder.py`、`schemas/action.schema.json`、`methodology/03` |
| **渲染器双文件合并为单文件**：`report_renderer_fp.py` 并入 `report_renderer.py`，删除约 1350 行旧 HTML 死代码（`_render_html_legacy` 及其 20 个旧章节方法、`_CHART_JS_INIT`、`report_styles.css`），删除 `report_renderer_fp.py` / `report_styles.css`；合并副作用导致 `_FIELD_ZH` 连带删除已恢复 | 金融纸已是唯一渲染器，`_fp` 后缀名不副实，旧商业风格模板成死代码 | `snippets/report_renderer.py`（2860→1507 行） |
| **移除失效的 `--offline` 开关**：金融纸 HTML 永远自包含，`offline` 参数已成空操作 | 死参数（字体内嵌/纯 CSS/零 CDN，无降级可言） | `snippets/report_renderer.py`、`cli.py`、`README` |

---

## 0. 2026-06-17 全量扫描优化（稳健性 + 统计严谨性）

**动机**：全量扫描 skill 后修复一处系统性误报、补两处防御/能力缺口。

| 变更 | 动机 | 文件 |
|---|---|---|
| **站内外衔接（rules 13/14）改按活动渠道门控**：`channel_filter` 由用户历史字段 `has_ads_touch==1` 改为 `activity_channel_std=='ads'`，并在引擎加类别级硬门槛 `_CAMPAIGN_CHANNEL_GATED_CATEGORIES`（非广告活动一律 not_applicable） | activity 活动误诊出站内外衔接问题 | `feature_schema/diagnostic_rules.yaml`、`snippets/diagnostic_engine.py` |
| **「其他」类规则按 name 语义归类**：37→触达质量、38→创单前营销、39→关键打断、41→转化效率，新增「用户价值」(40)/「优惠机制」(42) 两类并补 `_CATEGORY_EASE` | 大类徽章「其他」无信息量 | `diagnostic_rules.yaml`、`diagnostic_engine.py`、`methodology/08` |
| **无规则归属问题统一信号名**：draft 用特征中文名预填 `signal_name`→`problem.rule_name`，渲染层 `_problem_rule_label` 统一封面左列/中间徽章/行动分组标题，杜绝退化为「诊断规则」/空白 | 正向阈值机会标题缺失/难看 | `snippets/draft_builder.py`、`snippets/report_renderer.py` |
| **正向 finding 补 `trigger_rate`/`n_event`**：修复详情卡「符合特征比例/高潜用户数」显示「—」 | metric_refs 缺字段 | `snippets/draft_builder.py` |
| **修复 self_critique pending 系统性误报**：`_is_pending_result` 区分 6 个领域 agent 与 diagnostic_rules/model_analysis（后者事实层在 diagnostic_rules_summary/metric_refs），规则类 finding 不再被误判 pending | 每次需手动 `_critique_dispositions` 兜底 | `snippets/self_critique.py` |
| **doctor 新增类别-ease 漂移检查**：规则 category 必须都在 `_CATEGORY_EASE` 声明，否则告警 | 新增类别静默退回 ease=0.5 | `cli.py` |
| **42 条规则引擎补卡方显著性**：新增 `cvr_gap_p_value`/`cvr_gap_significant`（与领域分析同口径）；`effective_signal` 加 p<0.05 门槛；不显著差异 severity 封顶 mid + 报告卡「⚠️ 差异未达统计显著」徽章 + 汇总表「显著性」列 | 兑现「p>0.05 降级」原则，规则引擎此前无显著性 | `diagnostic_engine.py`、`draft_builder.py`、`report_renderer.py`、`cli.py`、`methodology/08`、`09`、`README` |

---

## 一、封面排序（按实现难度低→高）

**动机**：试用反馈——封面核心问题与建议应"先易后难"，让运营按快赢优先逐条落地。

| 变更 | 文件 |
|---|---|
| 新增 `_DIFF_RANK`、`_ease_to_diff()`、`_order_problems_by_difficulty()`：核心问题先取业务优先级 Top5，再按对应行动 `execution_difficulty`（同难度内按规则 `_ease` 降序）重排 | `snippets/report_renderer.py` |
| `_extract_top_problems` 输出已难度重排；封面左列（问题）、右列（行动）、第 I 章、目录、MD 报告全部同序 | 同上 |
| 封面右列行动跟随左列问题顺序，两列一一对应 | 同上 |
| 修复：`_group_actions_by_problem` 改用问题**真实 problem_rank** 匹配行动（`_match_rank`），避免难度重排后位置错位 | 同上 |
| 文档：封面/章节难度排序说明 | `methodology/03_synthesis.md` |

---

## 二、典型案例 · 用户选取方案

**动机**：案例用户要"与发现的问题最一致"，运营一眼对得上结论。

| 变更 | 文件 |
|---|---|
| `_select_representative`：75 分位 → **较极端用户**（95 分位，规避脏值）；无 rank_by 退化按 `pre_total_event_cnt` | `snippets/case_extractor.py` |
| **问题契合度选人**：每个模式定义 `fit_fn`（加权该问题全部定义性特征），取契合度 92 分位用户（`_PATTERN_FIT`/`_select_by_fit`/`_select_case_user`） | 同上 |
| 新增案例模式 `created_not_paid`（创单未付，`is_converted=1 & is_paid=0`）——修复"创单未付问题却用未创单的高意向案例"的硬伤 | 同上 |
| 新增案例模式 `post_order_disturb`（成单后打扰，rules 7/8/10） | 同上 |
| `_RULE_CASE_PATTERN` **补全 42 条规则全映射**，消除 18 条规则落到 `no_mainflow` 兜底 | `snippets/draft_builder.py` |
| 10 个模式 fit_fn 逐一数据校验（疲劳→反复触达、漏斗回退→多次回退、品类错配→重度浏览他类且目标零浏览…） | — |

---

## 三、典型案例 · 行为路径

**动机**："近期浏览"太笼统；需展示 `modelname:detailname:majorname` 触点链，且聚焦与问题最相关的路径。

| 变更 | 文件 |
|---|---|
| "近期浏览" → **"用户行为路径"**；三序列（model/detail/major）按节点 zip 合并为 `model:detail:major → …` | `snippets/case_extractor.py` |
| **问题相关选点**（`_node_relevance`/`_PATTERN_KEY_MODELS`/`_FUNNEL_RANK`）：疲劳/站内外看营销渠道、漏斗/高意向看深层漏斗页、品类问题看非目标品类浏览 | 同上 |
| **首次行为 + 最近一次行为始终保留**；反复节点合并为 `节点×N`；跳过段用 `⋯` | 同上 |
| 噪声治理：主流程节点须含真实品类词（剔除 `OPPO预装`/`banner曝光`/`iOS生态`）；营销渠道噪声仅在营销类问题保留 | 同上 |
| 超长 majorname（如整条短信）截断 `…`（16 字） | 同上 |
| **漏斗回退专标 `↩回退`**：主流程节点漏斗深度低于上一主流程节点即标记（仅 funnel_regression） | 同上 |
| 文档：路径润色指引（保留 `×N`/`⋯`/`↩回退`，勿改回"近期浏览"、勿补省略步数） | `methodology/03_synthesis.md` |

---

## 四、典型案例 · 红包行为

**动机**：核对基础数据能否补红包金额；展示各品类领券。

| 变更 | 文件 |
|---|---|
| **结论：V2 特征无红包金额/面额/张数**，仅各品类是否领过（0/1）+ 首末品类。严禁编造金额 | — |
| 红包事件展示：领券次数 + **覆盖各品类** + 首张→最近品类轨迹 + 是否含目标品类券 | `snippets/case_extractor.py` |
| 厘清"含目标品类券"措辞，避免误读最近那张即目标券 | 同上 |
| 文档：红包写作约束（无金额/张数） | `methodology/03_synthesis.md` |

---

## 五、典型案例 · 指标展示

**动机**：指标卡曾露英文字段名、显示无意义的 0/1 浏览标志位；浏览次数口径需标"主流程"。

| 变更 | 文件 |
|---|---|
| 指标 label **英文字段名自动中文化**（`_diag_case_block` 过 `_humanize_feature` 兜底 + 补全约 40 个中文映射） | `snippets/report_renderer.py` |
| 草稿层 label 也写中文 | `snippets/draft_builder.py` |
| 品类错配 `display_metrics`：主流程浏览最多品类 / 该品类主流程浏览次数 / 目标品类主流程浏览次数（替换误导性"浏览品类数"） | `snippets/case_extractor.py` |
| 跨品类 `display_metrics`：浏览品类数 + 第 1/第 2 浏览品类及次数（目标口径不适用） | 同上 |
| **目标品类主流程浏览=0 时红色"从未浏览"**（`alert` 机制） | `case_extractor.py` + `report_renderer.py` |
| 经 SQL 核对 `*_visit_cnt = SUM(modelname='主流程')`，所有浏览次数标签加"**主流程**"三字 | 两处 |
| draft 时序由前 3 改前 4，避免关键 issue 事件被红包事件挤出 | `snippets/draft_builder.py` |

---

## 六、诊断规则

| 变更 | 文件 |
|---|---|
| **新增 Rule 43「推送零浏览品类」**：`pre_target_product_visit_cnt=0 & pre_mainflow_event_cnt>0`（比 Rule 11 更硬的错配；实测 -8.10pp）。接入引擎、findings、人群包、coverage 同组（与 11 合并避免重复上报）、案例映射 | `feature_schema/diagnostic_rules.yaml`、`snippets/self_critique.py`、`snippets/draft_builder.py` |
| ads_mismatch fit 优先取"站外广告品类可识别"的用户，案例更清晰 | `snippets/case_extractor.py` |

---

## 七、Bug 修复

| 问题 | 修复 | 文件 |
|---|---|---|
| 案例用户 ID 双前缀 `UU…` | `_typical_case` 不再重复加 "U" 前缀 | `snippets/draft_builder.py` |
| 站内外承接案例用 `no_mainflow`、看不出"站外→站内断层" | rules 12/13/14 映射 `ads_mismatch` | 同上 |
| 创单未付问题用未创单案例 | 新增 `created_not_paid` 模式并重映射 | `case_extractor.py`/`draft_builder.py` |
| 跨品类事件硬编码"火车票/机票" | 改为动态展示真实浏览最多两品类 | `case_extractor.py` |
| `post_order_disturb` 在 sample 数据 NaN 报错 | int 转换前 `pd.notna` 守卫 | 同上 |
| 路径残留噪声 / 固定 6 步显模板 | 见第三节 | 同上 |

---

## 八、文档与配置同步

| 变更 | 文件 |
|---|---|
| "41 条规则" → "42 条规则"（共 26 处） | `cli.py`、`SKILL.md`、`README.md`、`methodology/00,04,09`、`schemas/*.json`、`TOOLS_MANIFEST.json`、5 个 snippets |
| case_pool "8 种问题模式" → "10 种" | `methodology/03_synthesis.md`、`schemas/report.schema.json` |
| Rule 43 规格 + 汇总表更新（42 条 / 34 全渠道通用） | `features/v3/diagnostic_rules.md` |
| Rule 43 列入内容匹配规则表 + 与 11 关系说明 | `methodology/08_diagnostic_rules.md` |
| sample_data 补 `pre_first/last_coupon_product`（内置 demo 可完整跑红包事件） | `snippets/sample_data.py` |

---

## 九、健壮性加固（全量审查轮）

**动机**：全面审查 skill，消除潜在崩溃点与边界隐患，让调用更顺畅、不出意外。功能保持不变。

| 问题 | 修复 | 文件 |
|---|---|---|
| `int(row.get(k, d))` / `int(row.get(k, d) or d)` 遇 NaN 崩溃（NaN 为真值，`or` 兜底失效）；真实数据 `pre_last_order_to_touch_min` 等字段含 4.8 万 NaN | 新增 `_sint(row, key, default)`：`pd.isna` 判空 + try/except 双重兜底，统一替换 21 处 `int(row.get(...))` | `snippets/case_extractor.py` |

> 验证：`_sint` 改动前后，对真实数据全量重跑 `prepare→compute-thresholds→draft`，`case_pool`/`findings`/`audience_segments`/`narratives`/`diagnostic_rules_summary` 五项确定性产物哈希完全一致——功能零变化。

---

## 验证

- 真实数据（`特价机票-正式.csv`，5 万行）全链路跑通：`of 42 total` 规则、`validate_report` 无错、`lint` 无 block。
- 内置 sample-data demo：10/10 案例模式提取成功。
- 5 个核心问题案例与问题强一致；封面难度排序、行为路径、红包品类、0 值红标、中文指标全部生效。
