# 营销诊断 Skill 下一步优化方案

> 基于 `marketing_audit_skill` 现状（SKILL.md / README / methodology / diagnostic_rules.yaml / CHANGELOG / 0630规则知识库 / 新增特征.txt / get_data.py / REPORT_CONSISTENCY_OPTIMIZATION）通读后给出。
> 按 **战略层 → 战术层 → 落地层** 组织，每条含 **现状缺口 → 目标态 → 涉及文件/产物 → 验收口径**。

---

## 一、现状定位（一句话）

当前 skill 是一个 **离线、单活动、转化口径（is_converted/is_paid）、规则驱动（31 条）** 的"诊断 → 报告"开环工具：

- 输入：已落地的 `tmp_ctj_mktv2_final` 宽表（T+1 离线链路，见 `get_data.py` 的 Spark + HDFS + Hive 路径）
- 输出：JSON / Markdown / HTML 报告
- 闭环边界：**诊断完即结束，不回写、不联动投放、不验证效果**

最近 5 轮 CHANGELOG（2026-06-30 ~ 2026-07-01）全在做 **"报告呈现稳健性 / 低基数口径自适应 / 多活动批量耐受"**，本质是在 **既有闭环内打磨精度**，尚未向外延展。

**核心瓶颈**：
1. 诊断产出的圈人包 / 行动建议无法直接驱动投放，人工拼接环节重
2. 规则体系只服务"转化"场景，对拉新 / 留存 / 召回活动会误诊
3. 诊断准不准没有量化回溯，规则不能自校准
4. 实时性问题（Rule 44 伪实时 / Rule 7 时机滞后）用 T+1 数据诊断，时序错配
5. 多活动批量诊断是"逐活动独立"，看不到活动间组合冲突

---

## 二、优化路线图（按价值 × 可行性排序）

### Phase 1｜平台打通：从"诊断报告"到"诊断 → 标签 → 场景 → 推送"闭环

**现状缺口**：
诊断产出的 `audience_segments`（圈人包）只落到 JSON 字段，运营仍需手工导出 → 在先知平台建场景 → 配推送；`design_issues` 里反复出现的"伪实时场景配置（Rule 44）/ 时机滞后（Rule 7）"也无法回写先知修正。

打样周期 = 诊断周期 + 人工建场景周期 + 推送周期。

**目标态**：
诊断完成即可一键生成 **先知场景草稿 + 私域推送任务草稿**，人工只做"确认"不做"拼接"。

| 子项 | 现状 | 目标 | 落地文件 |
|---|---|---|---|
| 1.1 圈人包导出标准化 | `audience_segments` 仅 JSON 内嵌 | 新增 `cli export-segments --format 先知/私域`，输出先知场景所需的 `mapid 列表 + 标签表达式` 与私域平台所需的人群包格式 | 新增 `snippets/segment_exporter.py` + `cli.py` 新子命令 |
| 1.2 诊断 → 先知场景草稿 | 无 | 把每条 `priority_action` 映射成先知场景节点（人群条件 / 触达渠道 / 时机窗口），输出 `scene_draft.json` 供先知平台导入 | 新增 `snippets/scene_generator.py`，复用 `campaign_meta` + `audience_segments` |
| 1.3 反向回写设计缺陷 | `design_issues` 只读 | Rule 44（伪实时）/ Rule 7（时机滞后）触发时，自动生成"先知节点修正建议"（哪个 sceneid 应改 is_today / 哪个标签延迟需排查）写入 `action_plan` | `methodology/08_diagnostic_rules.md` 增"回写建议"段；`draft_builder.py` 增回写装配 |
| 1.4 API 直连（可选，需平台侧配合） | 无 | 先知 / 私域平台提供 OpenAPI 时，`cli push-scene --dry-run` 直接调平台接口创建场景草稿 | 新增 `snippets/platform_client.py`，配置化 endpoint |

**验收口径**：
- 同一活动从 `render` 完成到"先知场景草稿就绪" ≤ 1 分钟（人工仅点确认）
- Rule 44 / Rule 7 触发的活动 100% 产出场景修正建议
- 圈人包导出格式通过先知平台导入校验

---

### Phase 2｜场景扩增：从"转化诊断"到"转化 / 留存 / 拉新 / 召回"四象限

**现状缺口**：
31 条规则 + 6 维度全部围绕 **当次触达 → 当次成单** 的转化漏斗。`campaign_type` 字段虽在 `methodology/01_campaign_profile.md` 定义了"大促 / 召回 / 新客获取 / 复购"，但 **规则不区分 campaign_type**——把"召回活动"套用"转化规则"会得出"人群质量过低 / 僵尸用户浪费"等错误结论（召回活动的目标本就是沉默用户）。

**目标态**：
规则按 `campaign_type` 分层，每类活动有专属规则子集 + 专属正向信号口径。

| 活动类型 | 目标变量 | 规则侧重 | 新增规则方向 |
|---|---|---|---|
| 转化（现状） | `is_paid` 当次成单 | 31 条现状规则 | — |
| **拉新** | `is_new_paid`（集团新客成单，需派生 `type_mem='集团新客'`） | 弱化"人群质量过低 / 僵尸用户"，新增"新客首单激励有效性 / 新客承接路径完整性 / 老客误投" | 新增 5-8 条 `campaign_type=new_acquisition` 专属规则 |
| **留存 / 复购** | `is_repaid`（N 天内复购，需后置观察窗口） | 弱化"过度营销"，新增"复购间隔合理性 / 品类复购周期匹配 / 流失预警人群识别" | 新增 5-8 条 `campaign_type=retention` 规则，需引入后置观察窗口字段 |
| **召回** | `is_reactivated`（沉默 N 天后成单） | **反转**"僵尸用户浪费营销"为正向，新增"沉默深度 → 召回难度分级 / 召回激励梯度" | 反转 Rule 5 口径 + 新增召回专属规则 |

**落地文件**：
- `feature_schema/diagnostic_rules.yaml`：每条规则增 `applicable_campaign_types: [转化, 拉新, ...]` 字段，`DiagnosticEngine` 按 `campaign_meta.campaign_type` 过滤
- `snippets/diagnostic_engine.py`：规则路由按 campaign_type 分流
- `methodology/01_campaign_profile.md`：campaign_type 推断逻辑强化（当前默认"大促"过于粗糙）
- 新增 `methodology/10_scenario_rules.md`：四象限规则选用指南
- `feature_schema/feature_registry.yaml`：补拉新 / 留存所需派生字段（`type_mem` / `is_new_paid` / `is_repaid` / `days_since_last_order` 后置窗口）

**验收口径**：
- 同一份召回活动数据，用"召回"口径跑出的 high-severity findings 数量 ≠ 用"转化"口径（避免误诊）
- 拉新活动能识别"老客误投"问题
- 留存活动能识别"复购间隔不合理"问题
- `doctor` 自检通过（规则无漂移、字段覆盖率达标）

---

### Phase 3｜闭环验证：从"一次诊断"到"A/B 反馈 → 规则自校准"

**现状缺口**：
`snippets/confidence.py` 的 `rule_coverage` 分母是固定的 41 条规则，**没有"这条规则上次建议后，运营采纳了，效果是否真提升"的反馈**。诊断准不准全靠人读报告，没有量化回溯。

**目标态**：
每次诊断产出的 `priority_actions` 带 `action_id`，运营在先知 / 私域平台执行后，结果回灌做"建议 → 执行 → 效果"三元组归档，定期跑 `cli audit-actions` 校准规则阈值与 severity。

| 子项 | 落地 |
|---|---|
| 3.1 action_id 全链路打标 | `draft_builder.py` 给每条 `priority_action` 生成稳定 hash id；先知场景草稿携带该 id |
| 3.2 效果回灌 | 新增 `cli ingest-result --action-id <id> --outcome <paid/cvr>`，写入 `action_outcome_store.jsonl` |
| 3.3 规则自校准 | 新增 `cli audit-actions`：按规则聚合历史建议的"采纳率 / 采纳后 lift"，对长期 lift ≤ 0 的规则降 severity 或标 `low_confidence` |
| 3.4 阈值漂移监控 | `threshold_computer.py` 的 `optimal` 切分点跨活动存档，新增 `cli threshold-drift` 对比同品类活动阈值变化趋势 |

**验收口径**：
- 跑满 30 个活动后，`audit-actions` 能输出"Rule X 历史建议 12 次，采纳 7 次，采纳后平均 lift +0.3pp，未采纳组 +0.1pp → 规则有效"这类报告
- 长期 lift ≤ 0 的规则自动降 severity 并在报告中标 `low_confidence`
- 阈值漂移超过 20% 的字段在 `thresholds_report.md` 顶部预警

---

### Phase 4｜数据时效：从"T+1 宽表"到"近实时诊断"

**现状缺口**：
`get_data.py` 走 Spark + HDFS + `tmp_ctj_mktv2_final`，是典型 T+1 离线链路。Rule 44（伪实时场景）/ Rule 7（时机滞后）这类 **实时性问题的诊断却用离线数据**，时序错配。

**目标态**：
保留离线全量诊断为主路径，新增 **轻量近实时诊断子路径**——活动进行中即可跑"触达质量 + 时机匹配 + 关键打断"三类规则的实时版，转化类规则仍等 T+1。

**落地**：
- `cli prepare --mode realtime`：只跑不依赖 `is_paid` 的规则子集（约 12 条），用流式特征（触达计数 / 时段匹配 / 弹屏拒绝）做即时预警
- 新增 `snippets/realtime_features.py`：对接实时行为流（需数据侧提供 Kafka / Mini-batch 接口）
- 报告渲染增"实时预警横幅"模块

**验收口径**：
- 活动进行中可每 15 分钟刷新一次实时预警
- 实时预警与 T+1 全量诊断结论一致率 ≥ 80%（不一致 case 进 `data_caveats`）
- 实时模式不依赖 `is_paid`，零转化活动也能产出预警

---

### Phase 5｜组合诊断：从"单活动"到"活动组合优化"

**现状缺口**：
CHANGELOG 2026-07-01 已支持"多活动批量诊断"，但是 **逐活动独立诊断**，看不到活动间冲突（同一用户当日被多个活动叠加触达 → Rule 38 活动堆叠冲突只能在本活动内看到自己的触达，看不到"另一活动也在打这人"）。

**目标态**：
新增 `cli portfolio-diagnosis`，以 `mapid + touch_date` 为粒度跨活动聚合，识别"活动间抢量 / 频次叠加 / 品类互斥"等组合级问题。

**落地**：
- 新增 `snippets/portfolio_analyzer.py`，输入多活动 state 合并，输出组合级 findings（如"活动 A 与活动 B 在 23% 用户上叠加触达，叠加组 CVR 比单活动组低 X pp"）
- 报告新增"活动组合冲突"章节

**验收口径**：
- 能识别 ≥ 2 个活动在同一用户身上的叠加触达
- 组合级 findings 带可执行建议（如"活动 A 与活动 B 错峰投放"）
- 组合诊断不破坏单活动诊断的独立性

---

## 三、优先级建议

| Phase | 价值 | 可行性 | 建议优先级 |
|---|---|---|---|
| **Phase 2 场景扩增** | 高（直接决定能否服务拉新 / 留存活动） | 中（需派生字段 + 规则分层，不依赖外部平台） | **P0 先做** |
| **Phase 1 平台打通** | 高（压缩打样周期是业务核心诉求） | 中低（依赖先知 / 私域平台 API 就绪） | **P0 与 Phase 2 并行**（1.1 / 1.2 圈人包导出可先做，1.4 API 直连等平台侧） |
| Phase 3 闭环验证 | 中高（决定 skill 长期能否自进化） | 中（需运营侧配合回灌结果） | P1 |
| Phase 5 组合诊断 | 中（活动量大后才显价值） | 中 | P2 |
| Phase 4 近实时 | 中（实时场景占比决定） | 低（依赖数据侧流式基建） | P3 |

---

## 四、与现有架构的兼容性约束（落地时必须守住）

1. **不破坏现有 10 步流程**：`prepare → compute-thresholds → draft → 润色 → self_critique → render` 是已验证的主路径，新增能力以 **子命令 / 可选 phase** 形式接入，不重构主链路。
2. **`_cvr_col` / `_split_col` 双口径约定**：Phase 2 新增的 `is_new_paid` / `is_repaid` 必须遵循"split 用过程指标、CVR 用目标指标"的现有范式，`threshold_computer.py` 已支持参数化列名。
3. **规则 yaml 单一事实源**：所有规则（含新增的拉新 / 留存规则）继续在 `feature_schema/diagnostic_rules.yaml` 维护，`DiagnosticEngine` 不硬编码规则逻辑。
4. **报告一致性不回退**：Phase 1-5 新增模块必须遵循 `references/REPORT_CONSISTENCY_OPTIMIZATION.md` 的"永不崩、永不消失"原则，用 `_empty_section` 兜底。
5. **`--auto-meta` 陷阱不重蹈**：Phase 2 的 `campaign_type` 推断若从数据来，必须像 `target_products` 一样 **强制向用户确认**（见 SKILL.md Step 1 ⚠️）。
6. **CHANGELOG 持续记录**：每个 Phase 落地后按现有 CHANGELOG 格式（动机 / 变更表 / 验证）追加章节，保持优化日志可追溯。

---

## 五、Phase 2（P0）展开 TODO 清单（可执行级）

> Phase 2 不依赖外部平台，可立即开工，故展开到函数 / 字段级。

### 5.1 规则分层改造

- [ ] `feature_schema/diagnostic_rules.yaml`：每条规则增 `applicable_campaign_types` 字段（默认 `[转化]`，保持向后兼容）
- [ ] 现有 31 条规则按以下口径标注 `applicable_campaign_types`：
  - Rule 1（无效触达）/ 2（过度骚扰）/ 3（弹屏打扰）/ 33（创单前营销过多）/ 35（弹屏过多）/ 37（跨渠道频次叠加）→ `[转化, 留存]`（频次管控类，留存也适用）
  - Rule 4（人群质量过低）/ 5（僵尸用户浪费）→ `[转化]` only（召回活动会误诊）
  - Rule 7（时机滞后）/ 6（时机不当）/ 44（伪实时）→ `[转化, 拉新, 留存, 召回]`（时机类全场景适用）
  - Rule 11（跨品类错配）/ 43（推送零浏览品类）→ `[转化, 拉新, 留存]`（召回弱化）
  - Rule 19（自然转化多余）/ 20（过度营销浪费）/ 21（缺临门一脚）→ `[转化]` only
  - Rule 25（多次创单未付）/ 41（创单未成单）→ `[转化, 留存]`
  - Rule 40（高频下单）→ `[留存, 召回]`（高频用户在转化场景是冗余投放，在留存场景是核心人群）
- [ ] `snippets/diagnostic_engine.py`：`evaluate()` 增 `campaign_type_filter` 参数，按 `state.campaign_meta.campaign_type` 过滤规则
- [ ] `snippets/threshold_computer.py`：`compute_adaptive_thresholds()` 增 `campaign_type` 透传，规则触发率汇总按分层输出

### 5.2 拉新场景规则新增

- [ ] 派生字段：`snippets/data_fallback.py` 增 `type_mem` 派生（依赖 `新增特征.txt` 中的 `first_create_order_time`）
- [ ] 派生字段：`is_new_paid = (type_mem == '集团新客') & (is_paid == 1)`
- [ ] 新增规则（写入 `diagnostic_rules.yaml`，`applicable_campaign_types: [拉新]`）：
  - R-NA1 老客误投拉新活动：`type_mem == '集团老客'` → severity high
  - R-NA2 新客首单激励缺失：`(type_mem == '集团新客') & (pre_has_coupon == 0) & (is_converted == 0)` → high
  - R-NA3 新客承接路径断裂：`(type_mem == '集团新客') & (pre_max_funnel_depth <= 2) & (is_converted == 0)` → mid
  - R-NA4 新客品类引导不足：`(type_mem == '集团新客') & (pre_target_product_visit_cnt == 0)` → mid
  - R-NA5 拉新活动老客占比过高（活动级）：`type_mem == '集团老客'` 触发率 > 70% → high（活动级规则）

### 5.3 留存 / 复购场景规则新增

- [ ] 派生字段：`is_repaid`（需后置观察窗口 N 天，N 由 `campaign_meta.repurchase_window_d` 决定，默认 30）
- [ ] 派生字段：`days_since_last_order`（已有部分支持，见 Rule 4 description）
- [ ] 新增规则（`applicable_campaign_types: [留存]`）：
  - R-RT1 复购间隔过短（同品类复购周期 < 历史中位数的 0.5 倍）→ mid（过早复购可能是误投）
  - R-RT2 复购间隔过长（> 历史中位数的 2 倍）→ mid（流失预警）
  - R-RT3 品类复购周期不匹配（活动品类与用户历史复购品类不一致）→ high
  - R-RT4 高价值用户低频触达（`pre_complete_order_cnt >= 阈值` 且 `activity_touch_cnt == 1`）→ mid
  - R-RT5 流失预警人群识别（`days_since_last_order > 180` 且近 30 天无行为）→ high

### 5.4 召回场景规则反转与新增

- [ ] Rule 5（僵尸用户浪费营销）在 `campaign_type=召回` 时 **反转** 为正向信号（`positive_alias: 沉默用户召回触达有效`）
- [ ] 新增规则（`applicable_campaign_types: [召回]`）：
  - R-RB1 沉默深度分级（`pre_is_dormant_user == 1` & `days_since_last_order` 分桶）→ low（分级建议，非问题）
  - R-RB2 召回激励梯度缺失（沉默 > 180 天但无专属大额券）→ high
  - R-RB3 召回承接路径单一（沉默用户仅单渠道触达）→ mid
  - R-RB4 召回后无承接（触达后 24h 内无站内行为）→ high（需后置窗口）

### 5.5 方法论与文档

- [ ] 新增 `methodology/10_scenario_rules.md`：四象限规则选用指南，说明每类活动的目标变量、规则子集、正向信号口径差异
- [ ] 更新 `methodology/01_campaign_profile.md`：`campaign_type` 推断逻辑强化，从数据推断时强制向用户确认（参照 `target_products` 的 ⚠️ 陷阱处理）
- [ ] 更新 `SKILL.md`：Step 1 增 `campaign_type` 确认环节；硬门槛清单增"规则 applicable_campaign_types 与 campaign_type 匹配"
- [ ] 更新 `methodology/08_diagnostic_rules.md`：规则选用按 campaign_type 分流说明
- [ ] 更新 `feature_schema/feature_registry.yaml`：注册 `type_mem` / `is_new_paid` / `is_repaid` / `days_since_last_order` / `repurchase_window_d`

### 5.6 验证

- [ ] 取一份召回活动数据，分别用 `campaign_type=转化` 与 `campaign_type=召回` 跑全流程，对比 high-severity findings 差异（应显著不同）
- [ ] 取一份拉新活动数据，验证 R-NA1（老客误投）能触发
- [ ] `cli doctor` 通过（规则无漂移、字段覆盖率达标）
- [ ] `cli render` 通过（schema 0 错、completeness 0 阻断）
- [ ] CHANGELOG 追加"Phase 2 场景扩增"章节

---

## 六、Phase 1（P0 并行）展开 TODO 清单

### 6.1 圈人包导出（1.1，不依赖外部平台，可立即做）

- [ ] 新增 `snippets/segment_exporter.py`：
  - `export_segments(state, format='先知')` → 输出 `segments_先知.json`（含 mapid 列表 + 标签表达式）
  - `export_segments(state, format='私域')` → 输出 `segments_私域.csv`（mapid + unionid + segment_name）
- [ ] `cli.py` 新增子命令 `export-segments --state <path> --format 先知/私域 --out <dir>`
- [ ] `schemas/` 新增 `segment_export.schema.json` 校验导出格式

### 6.2 先知场景草稿生成（1.2，不依赖外部 API）

- [ ] 新增 `snippets/scene_generator.py`：
  - `generate_scene_drafts(state)` → 把每条 `priority_action` 映射成先知场景节点
  - 输出 `scene_draft.json`：每个场景含 `scene_name` / `audience_condition`（来自 segment）/ `channel` / `time_window` / `linked_action_id`
- [ ] `cli.py` 新增子命令 `generate-scenes --state <path> --out <dir>`
- [ ] `methodology/03_synthesis.md` 增"场景草稿生成约束"段

### 6.3 设计缺陷回写（1.3）

- [ ] `methodology/08_diagnostic_rules.md`：Rule 44 / Rule 7 增"回写建议"模板
- [ ] `snippets/draft_builder.py`：`draft_findings_from_rules()` 检测到 Rule 44 / 7 触发时，自动在 `action_plan.priority_actions` 追加"先知节点修正"类行动
- [ ] 行动模板：`{action_type: 'platform_fix', target_sceneid: <id>, fix_field: 'is_today/scene_has_offline_node', reason: <rule description>}`

### 6.4 API 直连（1.4，依赖平台侧，后置）

- [ ] 新增 `snippets/platform_client.py`：配置化 endpoint，`push_scene_draft(scene_draft)` / `push_segment(segment)`
- [ ] `cli.py` 新增 `push-scene --dry-run` / `push-scene --confirm`
- [ ] 配置文件 `.devin/config.json` 或环境变量管理 endpoint / token

---

## 七、风险与依赖

| 风险 | 影响 | 缓解 |
|---|---|---|
| 先知 / 私域平台 API 不就绪 | Phase 1.4 阻塞 | 1.1 / 1.2 先做离线导出，API 就绪后无缝切换 |
| 派生字段依赖上游表（`type_mem` 需 `first_create_order_time`） | Phase 2 拉新规则阻塞 | 与数据侧确认 `app_da.public_marketing_detail_mapid_add` 已含该字段（见 `新增特征.txt`） |
| 后置观察窗口字段（`is_repaid`）需 T+N 数据 | Phase 2 留存规则阻塞 | 先用 `is_paid` 当次成单近似，T+N 数据就绪后切换 |
| 运营侧不回灌 action 执行结果 | Phase 3 闭环验证失效 | action_id 打标先做，回灌接口准备好等运营侧接入 |
| 规则分层后历史报告不可比 | 报告口径变化 | `state._scenario_version` 记录口径版本，历史报告不重跑 |

---

> 本方案为静态规划文档，落地时按 Phase 顺序逐项执行，每完成一个子项更新 CHANGELOG 并打 git tag。
