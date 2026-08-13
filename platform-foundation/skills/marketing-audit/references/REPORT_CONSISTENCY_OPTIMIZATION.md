# 报告页面一致性优化方案

> 目标：**每次运行该技能，报告页面骨架与各模块始终一致** —— 不因 LLM 填充不全或上游数据缺失而出现「整页 render 失败、整章消失、模块半残、图表空白」等问题。
>
> 本文基于 2026-06-08「特价机票」第二次诊断运行（`run_v2/`）中对渲染器/校验器的探针测试得出，所有结论均可复现。

---

## 0. 问题根因（一句话）

渲染器 [report_renderer.py](../snippets/report_renderer.py) 大量使用「**数据缺失 → `if not X: return ""`（整段返回空）**」的策略，而完整性目前**只靠 SKILL.md 的硬门槛由 LLM 自觉保证**，render 阶段无强制校验、无占位兜底。一旦 LLM 少填或上游裁剪，页面就会「静默退化」甚至「整页崩」，且每次退化形态都不一样 → 页面格式不稳定。

---

## 1. 探针实证（run_v2 复现）

对一份**完整且通过校验**的 `state_full.json`，逐项把某模块置空后调用 `render_html`，观察页面：

| 注入的缺陷 | 现象 | 严重度 |
|---|---|---|
| `diagnostic_rules_summary = []` 或缺失 | **整页 render 抛 `AttributeError`，报告完全产不出** | 🔴 P0（已修） |
| `priority_actions = []` | **整个「优先行动方案」章节消失**（`id="chapter-actions"` 不存在），页面 4 章变 3 章 | 🔴 P0 |
| `narratives.problems = []` | 「核心问题」章节空壳，无任何问题卡/案例，**无占位说明** | 🟠 P1 |
| `findings = []` | 章节在但内容大幅缩水，封面数字/图表缺数据 | 🟠 P1 |
| 某 problem 缺 `typical_case` | 4 个问题里只有 3 个显示案例块，**视觉不一致、无占位** | 🟠 P1 |
| `audience_segments = []` | 人群包模块静默为空，行动里的人群 chip 断链 | 🟡 P2 |
| 非规则型 finding（如模型洞察）`metric_refs=[]` 且无 `rule_id` | 该问题对比图**无数据可画 → 空白图** | 🟡 P2 |

> P0 的崩溃点已定位并修复：[report_renderer.py:1035](../snippets/report_renderer.py#L1035) `_extract_top_problems` 中 `rules_by_id.get(int(rid)).get("_signal_type")` 对 `None` 调 `.get`。已加 None-guard。

---

## 2. 优化维度（从哪些维度优化）

### 维度 A：渲染容错——「永不崩、永不消失」（最高优先）

**原则**：任何章节/模块都必须**总是渲染一个稳定容器**；数据缺失时显示**带标签的占位**（如「暂无优先行动（数据未生成）」），而不是返回空串让整章消失。

落地点：
- A1（P0，已完成）：`_extract_top_problems` 的 rule 查表加 None-guard，杜绝整页崩。
- A2：把 6 个章节方法（`_chapter_one_problems` / `_chapter_three_actions` / `_chapter_detailed_data` / `_appendix` / 人群块 / caveats）的 `if not X: return ""` 统一改为 `return self._empty_section(anchor, title, hint)` —— 章节标题与锚点恒在，正文为占位卡。
- A3：渲染入口包一层 `try/except`：单个模块抛异常时降级为占位块并记 `render_warnings`，绝不让单点异常打穿整页。

### 维度 B：渲染前「完整性校验」——把硬门槛从 LLM 自觉变成程序强制

现状 `validate_report` 只校验 schema + headline 长度 + 渠道词；**不校验内容完整性**。新增 `lint_report_completeness(state) -> list[gap]`，在 render 前阻断/告警以下「页面会变残」的情况：

- B1：`narratives.problems` 数量 < 3（封面诊断卡会过空）。
- B2：每个 problem 必须有 `typical_case`，且 `evidence_finding_ids` 至少命中 1 条真实 finding。
- B3：每个 problem 的主 finding 必须含可画图的 `metric_refs`（causal/positive 至少有 `cvr_triggered`；100% 触发显式 `cvr_not_triggered=null`）—— 否则图表空白。
- B4：每个 `priority_action.problem_rank ∈ [1, N]`，且 `target_audiences` 能解析到 `audience_segments.name` 或「全量」。
- B5：`priority_actions` 数量 ≥ 1 且与 problems 形成映射（每个核心问题至少 1 条行动）。

输出结构化 gap 列表，CLI render 默认遇 `block` 级 gap 退出并打印「需补齐项」，与现有渠道词 lint 的阻断式交互一致。

### 维度 C：图表/指标数据兜底链

渲染器已有 `_cvr` 的「metric_refs → rule_data fallback」逻辑（[report_renderer.py:541](../snippets/report_renderer.py#L541)），但仅对带 `rule_id` 的 finding 生效。补强：
- C1：模型型/无 rule_id 的 finding，若 `metric_refs` 缺标准键，渲染图表时回退到「单值卡」或占位「（该洞察无对照组指标，详见叙述）」，不画空图。
- C2：`metric_refs` 里 `cvr_gap` 与 `cvr_triggered−cvr_not_triggered` 符号不一致时，渲染器已自动纠正——保留，但同时进 `render_warnings` 便于回溯。

### 维度 D：封面卡与正文「同源同序」一致性

封面「核心问题诊断卡（左）」「行动建议卡（右）」分别来自 `narratives.problems` 与 `priority_actions`。
- D1：渲染前断言两者数量与 `problem_rank` 映射自洽；不自洽时以 problems 为准补占位行，避免左右栏错位/缺行。
- D2：`_signal_type`/`severity` 缺失时给确定性默认（已部分有 `_DEFAULT_PROBLEM_TITLES`），统一补齐颜色/badge 默认值。

### 维度 E：离线/资源一致性（已较好，仅固化）

- E1：（已落地）金融纸模板迁移后 HTML 永远自包含——字体 base64 内嵌、纯 CSS 图表、零外部 CDN，离线一致性问题天然消解；原 `--offline` 开关已移除（不再有"两种模式"差异）。

---

## 3. 落地优先级与工作量

| 阶段 | 内容 | 风险 | 状态 |
|---|---|---|---|
| **P0** | A1 崩溃 None-guard（[report_renderer.py:1035](../snippets/report_renderer.py#L1035)） | 极低 | ✅ 已完成 |
| **P0** | A2 章节占位兜底 `_empty_section`（problems/actions/detailed/appendix/seg 不再整章消失） | 低 | ✅ 已完成 |
| **P0** | A3 render 单模块 `_safe` try/except 降级 + `render_warnings` | 低 | ✅ 已完成 |
| **P1** | B1–B5 `lint_report_completeness` + CLI `--skip-completeness` 阻断 | 中 | ✅ 已完成 |
| **P2** | C1 无对照指标问题卡占位（不留空白图） | 低 | ✅ 已完成 |
| **P2** | D1 封面两列空列占位（结构恒定）；D2 左列与第 I 章同源同序 | 低 | ✅ 已完成 |
| **附带** | 详细数据章节编号 `IV → III` 修正 + 补入左侧目录 | 低 | ✅ 已完成 |
| **P3** | C2 cvr_gap 符号纠正落 `render_warnings`（现由 self_critique 兜住） | 低 | 暂缓 |
| **P3** | E1 离线快照纳入 CI 回归 | 低 | 暂缓（需 CI 基建） |

### 实施后回归（全部通过）
- 渲染零崩溃：对 `problems/actions/findings/rules_summary/segments` 任一为空、`narratives/action_plan` 缺失、乃至「全部剥空」，render 均成功且 4 大章节锚点 + 左侧目录恒在。
- 完整性 lint 命中：`problems=[]`/`problem_rank` 越界 → block；缺 `typical_case`、人群断链、问题数 <3、问题无行动 → warn。
- 真实数据 `run_v2`：schema 0、lint 0、completeness 0/0，章节编号 I/II/III/APPENDIX 连续，目录含「III 详细诊断数据」。

---

## 4. 验收标准（「页面格式每次一致」的可测定义）

1. **零崩溃**：对任意通过 schema 的 state，`render` 不抛异常（含 problems/actions/findings/rules_summary/segments 任一为空）。
2. **章节恒在**：封面 + 4 大章节（核心问题/行动方案/详细数据/附录）锚点恒定存在；缺数据时为带标签占位，不消失。
3. **模块齐整**：每个核心问题都含 {对比图 or 单值卡 or 占位}、typical_case（折叠）、≥1 条行动；不出现「3/4 有案例」式残缺。
4. **render 前拦截**：`lint_report_completeness` 把会导致页面变残的缺项在 render 前列清单阻断，而非事后发现。
5. **回归快照**：在线/离线两份 HTML 的章节锚点集合一致（diff 仅在数据，不在结构）。

---

## 5. 配套文档同步（实施后）

- `SKILL.md` 硬门槛：注明「render 阶段由 `lint_report_completeness` 程序强制，不再仅靠 Agent 自觉」。
- `methodology/03_synthesis.md`：在自检清单后追加「完整性校验项与占位规则」。
- `methodology/00_overview.md`：补充 render 容错与占位策略说明。
