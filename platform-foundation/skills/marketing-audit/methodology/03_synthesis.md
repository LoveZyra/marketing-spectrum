# 03 — 合成报告 (Step 4)

> 这是**写作约束最严格**的一步。所有"专业感"都来自这里的禁用词清单与强制模板。

## 三件产出（都由宿主 Agent 撰写）

### 03.1 `headline` — 30-50 字核心结论

含活动名 + 一个数据 + 一个判断。示例：

> Push 渠道响应率 4.81%、品类匹配率 0%，活动 CVR 13.5% 主要由自然流量贡献而非营销驱动

### 03.1b `narratives.subhead` — 封面副句（可选，40-60 字）

封面「核心结论」下方的一行引导句。**由 Agent 撰写、面向真实数据**——渲染层不再自造带数据结论的定型句（历史上写死的"创单用户中仅 X% 完成支付"在创单=成单时会渲染成自相矛盾的"仅 100%"）。写作要点：

- 内容型引导：概述核心矛盾 + 一处正向机会，可含关键数字，但**数字与判断必须与本次数据自洽**（如创单=成单时写"创单即成单、无支付漏损"，切勿写"仅 100% 完成支付"）。
- 缺省行为：不填时渲染层回退到**不含任何数据判断**的结构导航句"下文按严重度拆解核心问题，并给出可落地的人群包与行动。"——安全、永不失真。
- 示例：`创单即成单、无支付漏损；问题集中在海量低意向人群空耗与红包无转化增量，同时存在可放大的高潜复购人群。`

### 03.2 `narratives` — 每个核心问题一条（限 3-6 条）

> ⚠️ **口径一致性（写 title/narrative 前必须执行）**：问题卡的标题、叙述、卡内对比图**必须同一口径**。
> 报告问题卡图表统一用**成单率（is_paid，最终付款）**，故 title/narrative 的转化数字也必须用成单率，
> **不得标题写"创单率 2.12%"、图却画"成单率 0.56%"**（两套数字对不上）。规则主口径已统一为成单率
> （`cvr_triggered/cvr_not_triggered/cvr_gap` 即成单率值），draft 的 finding.signal 据此预填，润色时沿用即可。
> 创单率（is_converted）仅作"过程"指标保留在封面 KPI 漏斗（5万→创单→成单）与 `create_*` 字段，
> 不进入单张问题卡的对比叙述。
>
> ⚠️ **domain snippets（`agent_raw_stats`）的 CVR 是创单率口径**（如"主平台分布""各阶段到达率""…创单率曲线"）。
> 这些是过程上下文、不展示；若在叙述里引用，**必须显式标"创单率"**，不得与问题卡的成单率混排成一套对比数字。

> ⚠️ **渠道术语一致性校验（写 narrative 前必须执行）**：
> 1. 从 `data_basic.activity_channel_dist` 确认本次活动渠道类型
> 2. 扫描所有 `evidence_finding_ids` 引用的 finding.signal/detail：若含有与本次渠道不符的词汇
>    （如活动渠道下出现"广告用户/广告投放/广告品类"）→ **在 narrative 中更正为正确渠道词汇**，不传播 finding 中的错误描述
> 3. narrative.title 和 narrative.narrative 中的渠道词必须与实际渠道一致
>    - `activity` 渠道：使用"活动触达用户/活动推送"，禁止出现"广告用户/广告投放/广告流量"
>    - `ad`/`cpc` 渠道：才可以使用"广告"相关词汇

每个 narrative 必须引用至少 1 个 finding id 或 evidence id：

```json
{
  "agent": "marketing_attribution",
  "title": "12-25 字论断式标题，必须含一个关键数据",
  "narrative": "60-100 字现象+数据，每个比例配原始计数（n=xx），结尾追加：（数据：<field>=<value>, n=<count>）",
  "impact": "30-50 字业务影响（CVR/成本/用户体验的具体冲击）",
  "evidence_finding_ids": ["fnd_xx", "ev_xx"]
}
```

> **模型洞察（agent=model_analysis）额外字段**：
> ```json
> {
>   "agent": "model_analysis",
>   "rule_name": "火车票竞争效应",
>   "title": "...",
>   "narrative": "...",
>   "impact": "...",
>   "evidence_finding_ids": ["fnd_model_train_neg", "fnd_23_crosscat"]
> }
> ```
> `rule_name`：≤12 字，描述模型洞察的核心效应名（如"跨品类竞争效应"、"低相关搜索干扰"），渲染时作 `diag-rule-name` badge 显示。若未填写，渲染器自动从次级规则名或标题截取，但优先填写以获得最准确的标签。

### 03.3 `action_plan` — 跨路径整合行动方案

> ⚠️ **写作顺序约束（必须遵守）**
> 1. **先**完成 `narratives.problems`（确定 N 个核心问题，编号 1..N）
> 2. **再**写 `priority_actions`：每条行动必须对应一个核心问题，填写 `problem_rank = 1..N`
> 3. 禁止创建 `problem_rank` 超出范围（> N）或为空的行动
> 4. 同一问题可有多条行动（不同 `rank`），每条行动只能对应一个问题

### `narratives.problems` 中的 `typical_case` 字段（必填）

**每个 narrative.problem 必须包含 `typical_case` 字段**，用于在报告中展示真实数据驱动的用户案例。

数据来源：`state['case_pool']`（由 `cli prepare` 的 `case_extractor` 自动填充，包含 10 种问题模式的代表用户）。

**写作步骤**：
1. 根据 problem 的 `evidence_finding_ids` 和 `agent`，从 `case_pool` 中选取最匹配的模式
   - 品类错配/跨品类 → `category_mismatch` 或 `cross_category`
   - 高意向未转化/关键页打断/长决策 → `high_intent_unconverted`
   - 营销疲劳/多次触达/多渠道冲突/弹屏过多 → `marketing_fatigue`
   - 未进主流程/落地即离/低意向/僵尸用户 → `no_mainflow`
   - 漏斗回退/营销致倒退 → `funnel_regression`
   - **创单未付/促付类（is_converted=1 & is_paid=0，或有未付创单）→ `created_not_paid`**（时序呈现"创单→停留待支付→未付"，勿用未创单的高意向案例）
   - **成单后被打扰（已成单+短间隔强渠道）→ `post_order_disturb`**（时序呈现"距上次成单 N 分钟即被触达"）
   - **站内外衔接类（站内多渠道不一致 #12 / 站内外项目不一致 #13 / 站外无站内承接 #14）→ `ads_mismatch`**：该案例的时序会明确呈现"站外广告品类 → 站内承接品类（不一致）"，必须用它，**不要用 `no_mainflow` 等无法体现站外→站内断层的案例**
2. 从 `case_pool[pattern_id].key_features` 提取 3 个核心指标作为 `metrics`（数值直接引用真实值）
   - ⚠️ `metrics[].label` **必须写中文指标名**（如"历史漏斗深度""站外广告品类"），**严禁直接填 `pre_max_funnel_depth` 等英文字段名**；渲染层虽有中文化兜底，但 JSON 中也应为中文
3. 参考 `case_pool[pattern_id].path_events` 生成 3-4 个行为时序事件（清晰、可读）
   - **用户行为路径**：`path_events` 中以「用户行为路径：」开头的事件，由触达前 `modelname:detailname:majorname` 三维序列合并而成，**聚焦与该问题最相关的关键节点**：疲劳/站内外看营销渠道触点、漏斗/高意向看深层漏斗页（详情/填写/支付）、品类问题看非目标品类的真实浏览。**首次行为与最近一次行为始终保留**；反复出现的同一节点合并为 `节点×N`（保留"反复浏览/反复触达"强度）；被跳过的非关键中段以 `⋯` 表示；**与问题最相关的关键节点用 `**节点**` 包裹（渲染为加粗标红）**（如 `营销:push:国际机票早鸟 → ⋯ → **主流程:填写页:火车票×3** → ⋯ → 营销:活动:特价机票`）。润色时保留该 `model:detail:major` 链路结构、`×N`、`⋯` 与 `**关键步骤**` 标记，**不要改写为"近期浏览"等笼统表述、也不要补全省略的步数、也不要删除 `**` 标记**
   - **红包行为**：`path_events` 中的红包事件展示**领券覆盖的各品类 + 首张/最近品类轨迹 + 是否含活动目标品类券**（如"领券 7 次，覆盖 4 个品类：机票、酒店、景区、汽车票；首张「国际机票」→ 最近「酒店」；含活动目标「机票」券"）。⚠️ V2 基础特征**仅有各品类是否领过（0/1）+ 首末品类，无每品类张数、无金额/面额**，严禁编造张数或金额；如需金额需在上游特征工程补字段
   - 案例用户已选取**较极端的代表用户**（问题指标处于高分位），叙述可直接强调其极端表现，便于运营理解
4. 生成 1 句 `profile_text`（从 key_features 推断用户特征，不得虚构）
5. 生成 2-3 句 `root_cause`（直接分析该用户数据，不泛化）

```json
{
  "typical_case": {
    "user_id": "U{case_pool[pattern_id].user_id}",
    "badge_text": "简短标签（≤6字，如"品类不匹配"）",
    "badge_type": "unmatched | pending | immune | converted | matched",
    "profile_text": "一句话用户画像（基于 key_features 推断，含1个具体数字）",
    "metrics": [
      {"val": "真实值", "label": "指标名称"},
      {"val": "真实值", "label": "指标名称"},
      {"val": "真实值", "label": "指标名称"}
    ],
    "timeline": [
      {"time": "HH:MM", "action": "行为描述（基于 path_events）", "type": "normal"},
      {"time": "HH:MM", "action": "问题行为（issue）", "type": "issue"},
      {"time": "HH:MM", "action": "最终结果", "type": "normal"}
    ],
    "root_cause": "2-3句根因分析，引用该用户具体数据，解释为何未转化"
  }
}
```

> ⚠️ **约束**：
> - `user_id` 必须来自 `case_pool`，不得编造
> - `metrics[].val` 必须是 `key_features` 中的真实值
> - 若 `case_pool` 为空，LLM 可基于 aggregate stats 构建代表性案例，但须标注 `"user_id": "典型用户（合成）"`
> - `badge_type` 取值：`unmatched`（红）/ `pending`（黄）/ `immune`（灰）/ `converted`（蓝）/ `matched`（绿）

---

```json
{
  "cross_validation": [
    {"finding": "统计或模型发现（含数据）",
     "validated_by": "另一路径的具体印证",
     "conclusion": "综合结论，不空泛"}
  ],
  "priority_actions": [
    {
      "rank": 1,
      "problem_rank": 1,
      "title": "<动词> <幅度>，<指标> <现状>→<目标>",
      "description": "30-50 字行动描述，动词开头",
      "evidence": "来自统计/模型的具体依据，含数字",
      "target_audiences": ["从已生成人群包名称中精确引用，或填 \"全量\""],
      "depends_on": [],
      "expected_impact": "可量化预期，如 CVR 提升 3-5pp",
      "execution_difficulty": "easy | medium | hard（从规则的 execution_difficulty 字段继承）"
    }
  ],
  "data_caveats": [
    {"field": "数据字段或维度",
     "issue": "缺失率/异常情况（含数字）",
     "impact": "对结论的具体影响"}
  ]
}
```

> **不需要填写的字段**（已从报告移除）：
> - `blind_spots`：待验证问题列表 — 不在正式报告中展示，无需填写
> - `recall_strategy`：召回策略卡片 — 召回逻辑已整合入对应 `priority_actions`，不单独展示

> **报告渲染说明**（render 自动处理，Agent 无需额外操作）：
>
> | 报告区域 | 数据来源 | 逻辑 |
> |---|---|---|
> | 封面"核心问题诊断"卡（左列） | `narratives.problems`（与第 I 章同源） | **按实现难度低→高排序**（快赢优先）：先取业务优先级 Top5，再按对应行动 `execution_difficulty`（同难度内按规则 `_ease` 降序）重排；与第 I 章诊断卡、目录同序同源 |
> | 封面"行动建议"卡（右列） | `priority_actions` | 展示**全部**条目，**顺序跟随左列问题**（即实现难度低→高），与左列一一对应；每条显示 `execution_difficulty` 标签（低/中/高），标题取至第一个顿号前，**Agent 必须填写此字段** |
> | 行动建议章节分组 | `priority_actions.problem_rank` | 按 `problem_rank` 归入对应的核心问题组（用问题真实 `problem_rank` 匹配，难度重排不影响归属），分组显示序号与第 I 章一致；无 `problem_rank` 时 fallback：从 `evidence` 文本提取 Rule N 匹配 |
> | 详细数据表排序 | `diagnostic_rules_summary._ease` | 按执行难易（低→高）→触发比例（高→低）自动排序，**无需 Agent 干预** |
>
> `problem_rank` 和 `execution_difficulty` 是影响行动建议渲染的两个关键字段：前者决定分组归属（与第 I 章对应），后者既决定封面难度标签，也参与**封面问题/行动的难度排序**与详细数据表排序。两者均必须填写，不得留空。`problem_rank` 从 `narratives.problems` 的顺序确定（第一个问题填 1，依此类推）。
> ⚠️ **封面与各章节按实现难度低→高排序**：`execution_difficulty` 准确填写直接决定封面问题/行动的先后顺序（运营按"先易后难/快赢优先"逐条落地），务必结合规则的 `execution_difficulty` 字段如实填写，不要全填 medium。
> ℹ️ 报告「核心问题 → 行动」矩阵与行动卡展示每个问题人群的**触发占比**（`trigger_rate`，渲染层从规则汇总自动读取），无需 Agent 额外填写。

## 写作七原则（必须全部遵守）

1. **笃定结论**
   - 禁用："或、可能、似乎、存在风险、主因之一、有待、建议关注、需要进一步分析、初步判断、是主因、有所"
   - 改成确定判断或可执行动作

2. **去 AI 化**
   - 禁用："我/我们/本次诊断/分析显示/AI/Agent/根据数据可知/经过分析/通过…可以看出"
   - 直接陈述事实

3. **数字精确**
   - 用 `66.67%` 而不是"超过六成"
   - 每个比例**尽量**配原始计数：`23.5%（47/200 用户）`

4. **术语统一**
   - 首次出现写"CVR（转化率）"，之后统一用 CVR
   - 响应率、点击率同理

5. **句子紧凑**
   - 单句 ≤ 60 字
   - narrative 段落 60-100 字

6. **强论断 title**
   - title 像新闻标题，论断式而非描述式
   - **反例（不允许）**："分析渠道情况"、"优化 Push 渠道"
   - **正例**："Push 触达 104 次仅 5 次响应，渠道效率 4.81%"、"Push 削减 50%，响应率 4.81%→8%"

7. **运营友好语言（面向非技术受众）**

   a. **禁用 ML/技术专有词**：严禁在 title/narrative/impact/root_cause 等所有对外展示字段中出现以下词汇——
      - 模型词：`AUC`、`ROC`、`GBDT`、`LightGBM`、`XGBoost`、`feature importance`、`精度`（机器学习含义）
      - 字段名词：英文字段名（如 `pre_mainflow_event_cnt`）不得裸露在叙述文本中
      - 规则编号：`Rule 11`、`规则 11`、`Rule N`、`rule#N`、`规则#N` 等编号形式**一律不得出现**

   b. **英文特征名首次出现必须带中文说明**：在任何内部字段（evidence、metric_refs.name 除外）首次引用英文特征名时，格式为「`字段名`（中文描述）」；同一字段在后续文本中**仅用中文描述**。
      > 示例：`pre_mainflow_event_cnt`（主流程行为次数）首次出现后，后续一律写"主流程行为次数"，不再重复英文名。

   c. **规则只用中文名**：引用诊断规则时，只写中文规则名（如"跨品类推送错配"），不写编号（Rule 11）。渲染器会通过 `diag-rule-name` badge 展示规则名，Agent 无需额外处理。

   d. **模型准确率描述**：如需提及模型预测能力，使用"转化预测模型"或"模型识别准确率"，避免写 "AUC=0.78" 此类技术参数。

## priority_actions 排序规则

**rank=1 优先给**：`severity=high` 且 `execution_difficulty=easy` 的规则。

同 severity 内按执行可行性排序：`easy` > `medium` > `hard`。`hard` 问题（如决策周期过长、多渠道冲突）即使 CVR 影响显著，也应排在 easy/medium 快赢项之后，并在 description 中注明"需系统改造，建议纳入下期需求"。

---

## 强制 title 模板（priority_actions）

```
<动词> <幅度>，<指标> <现状>→<目标>
```

示例：
- "Push 削减 50%，响应率 4.81%→8%"
- "主推品类切换至火车票，覆盖兴趣用户从 7%→16%"
- "优惠门槛降至 100 元，火车票领券人群扩 3x"

每个 title 必须含**至少一个具体数字**。

## 跨路径整合规则（`cross_validation` 怎么写）

每条 cross_validation 必须满足"两路径互相佐证或矛盾":

- **印证型**：统计发现 X，模型 top_features 第 1 名也是相关特征 / 决策规则也命中
- **矛盾型**：统计认为渠道 A 有效，但模型特征重要性 A 极低 → 可能是混杂效应
- **盲区型**：统计未覆盖某变量，但模型把它选到 Top → 写到 `data_caveats`，或写入 `blind_spots`（仅内部记录，不在报告展示）

## `target_audiences` 校验

`priority_actions[].target_audiences` 必须**精确引用** `state['audience_segments']` 中已存在的 `name`，或使用全量哨兵词（"全量" / "全量用户"）。

> ⚠️ **强制约束**：
> - 写 `priority_actions` 之前，**先为每个非全量行动创建对应的 `audience_segments` 条目**（含 `name`、`filter_conditions`、`rationale`）
> - 禁止写入未在 `audience_segments` 中定义的人群名——这会导致报告中人群 chip 显示为断链（`!`标记）
> - 只有真正覆盖全部触达用户时才使用 "全量"（如全局配置变更、落地页修改），不得用 "全量" 代替「懒得定义 segment」
> - `report_validator.lint_report` 会检测引用了不存在 segment 的人群名，生成 warning

```json
{"name": "高意向未转化酒店用户", "matched": true}
```

## blind_spots 与 data_caveats

- `blind_spots`：数据本身够，但当前分析路径没覆盖到的"潜在风险点"（如：未交叉验证设备型号 × 渠道）。**数据层保留，不在报告 HTML/Markdown 中展示。**
- `data_caveats`：数据本身的"质量缺陷"导致结论需打折（如：`gmv` 字段 60% 缺失 → 收入估算不可信）。报告中正常展示。

## 自检清单（生成后逐条过）

- [ ] 是否出现禁用词？
- [ ] 是否所有比例都尽量配了原始计数？
- [ ] title 是否含具体数字？
- [ ] 是否暴露 AI 身份？
- [ ] `target_audiences` 是否引用了已存在的 segment name？
- [ ] 是否每个 narrative 至少引用 1 个 evidence 或 finding id？
- [ ] `priority_actions` 是否按 rank 升序排列（rank=1 最重要）？
- [ ] `priority_actions` 中每条行动是否都已填写 `problem_rank`（1..N）？是否有 `problem_rank=null` 的行动？
- [ ] `priority_actions` 的 `problem_rank` 是否全部在 `narratives.problems` 范围内（不超过 N）？
- [ ] model_analysis 类问题是否填写 `rule_name`（≤12字，描述核心效应，如"火车票竞争效应"）？
- [ ] narrative 中是否出现与实际渠道不符的词汇（如活动渠道却出现"广告用户/广告投放/广告流量"字样）？
- [ ] 是否出现 ML/技术专有词（AUC、LightGBM、feature importance 等）？出现则替换为中文业务描述。
- [ ] 是否出现规则编号（Rule N、规则 11 等）？出现则替换为中文规则名。
- [ ] 英文字段名（`pre_*` 等）首次出现时是否附带了中文说明？后续是否统一使用中文？
- [ ] `lint_report_completeness(state)` 是否无 `block` 级缺项（核心问题非空、`problem_rank` 合法）？warn 级（每个核心问题含 `typical_case`、行动人群可解析、问题数≥3、问题有对应行动）是否尽量补齐？render 会对 block 级阻断产出。

不合格则**自行重写**，不要交付半成品。
