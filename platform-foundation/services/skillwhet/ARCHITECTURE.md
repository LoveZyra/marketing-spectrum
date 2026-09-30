# SkillWhet（砺）完整架构与实现方案

> *磨已有的 skill，而不是造新的。*

> 系列第四份。前置：`skill-evolution-design.md`（主干）、`skill-evolution-2026-landscape.md`（30 篇文献图谱）、`skillwhet-design.md`（双载体设计立论）。
> 本文是**可施工的规格**：模块分解、接口签名、数据契约、算法、配置、CLI、里程碑。
> **状态（2026-09-07 晚）**：全部模块实现并接入主循环，10,381 行实现 + 2,695 行测试，190 项测试通过（其中 50 项是审计回归测试）。三路审计确认的 48 个 bug **全部修复**，清单与设计变化见 `REVIEW.md`。**实模验证**（`claude -p`，haiku/sonnet/opus）：带留出测试、文档含数值的 `examples/pdf-tables` 种入两个"错误结果"型缺陷，一轮内全部修复，val 0.0 → 1.0，G8 通过，$0.12；`adopt` 后 live 全绿、baseline 刷新。
> **第四轮（9-08）**：配对判官（G7 作候选 vs 当前回答的符号检验）、跨函数 G1（helper 返回的危险可调用对象）、静态影响图（G6 只重放能触达被改符号的 pytest 任务）、第二个示例 skill `textnorm` 与 3 个新 case（基准 7 个 case、两个领域）。实测：`tn-doc-wrong` 暴露 ledger 把强调用大写词当常量、拦下正确修复——常量模式收紧 + 经计量确认的改进可退休 ledger 值；修后 3/3 文档 case 改进；配对判官 2 胜 0 负 1 平接受。记录 `REVIEW.md` §8。
> **第五轮（9-09）**：`whet bench --repeat N --jobs N`（多种子重复 + 并行，`no_llm` 改为纯 contextvar 才不会互相封死）、跨**模块** G1 返回值追踪、harvest 首次在真实转录上端到端跑通。**48 次重复消融推翻了第四轮 n=1 的排名**（no-refine 与 no-dedup 对调，`REVIEW.md` §9.4）；顺着"探针为什么是 0"查到真正原因：可见信号全部打平时排序键退化为"最小 diff"，而**最小性与泛化性反相关**。修法是让被声明的行为可执行——契约新增 `example` 检查、G3 契约检查改为相对基线判定、修复的契约检查进入排序键第二位。实测（新 case `code-currency-contract`，12 次运行）泛化探针 **7/12 → 11/12**，唯一没受益的 `first-wins` 恰好是关掉排序的那个配置。过程中撞出一个让整轮实验白跑的 bug：`bootstrap_contract` 用空契约当 base，**手写 CONTRACT.yaml 的语义半边（含 checks）被整个丢弃**（§9.5）。195 项测试。

---

## 0. 系统一览

```
                             ┌──────────────────────────────┐
   真实会话 / 工单 / 基准     │        L0 证据层              │
   ───────────────────────▶  │  harvest → 脱敏 → TaskRecord  │
                             │  train / val / holdout 三分   │
                             └──────────────┬───────────────┘
                                            ▼
                             ┌──────────────────────────────┐
                             │        L1 执行层              │
                             │  agent(S_t) 跑任务 → 轨迹     │
                             │  沙箱：无网络 / 只读 / 限时   │
                             └──────────────┬───────────────┘
                                            ▼
                             ┌──────────────────────────────┐
                             │      L2 归因层（四路）        │
                             │ code_defect  → 快环           │
                             │ doc_defect   → 慢环           │
                             │ contract_drift → 原子捆绑     │
                             │ isolate      → 不进环         │
                             └────┬──────────┬──────────┬────┘
                    ┌─────────────┘          │          └──────────────┐
                    ▼                        ▼                         ▼
      ┌──────────────────────┐  ┌────────────────────┐  ┌──────────────────────┐
      │   L3 快环（代码）     │  │  L4 原子捆绑        │  │   L5 慢环（文档）     │
      │  P1 规则 / P2 缺陷    │  │  code+contract+doc │  │  minibatch 反思       │
      │  P3 能力              │  │  一次不可分割提交   │  │  分层合并 → 排序      │
      │  提议 ~2 次 LLM       │  │                    │  │  提议 ~12 次 LLM      │
      └──────────┬───────────┘  └─────────┬──────────┘  └──────────┬───────────┘
                 └────────────────┬───────┴────────────────────────┘
                                  ▼
                 ┌────────────────────────────────────┐
                 │   L6 门控金字塔（便宜的在前）        │
                 │  G0 parse    G1 sec    G2 static    │  ← 零 LLM
                 │  G3 contract G4 unit   G5 holdout   │  ← 零 LLM
                 │  ─────────────────────────────────  │
                 │  G6 逐patch重放  G7 留出集聚合       │  ← 贵
                 │  G8 治理（事实/结构/体积）           │  ← 贵
                 └────────────────┬───────────────────┘
                                  ▼
        ┌─────────────────────────────────────────────────┐
        │  L7 记账与交付                                   │
        │  wiki（永不回滚） · provenance · Preserve Ledger │
        │  argmax over {S₀} ∪ 历史 → staging → 人工 → adopt│
        └─────────────────────────────────────────────────┘
```

**三条贯穿全局的不变量：**

1. **执行模型冻结。** 只有 skill 变。这是可归因性与零部署开销的前提。
2. **Generator ≠ Evaluator。** 编辑者与裁判必须不同模型（SkillEvo 的唯一架构性模型要求，防自审循环依赖）。
3. **候选集永远含 S₀。** 最终 `argmax` 覆盖整个历史包括起点，保证**进化永不劣于起点**（SkillRevise）。

---

## 1. 模块分解

```
skillwhet/
├── types.py           ✅ 核心类型：Edit/Bundle/GateResult/Contract/FailureSignal
├── analysis.py        ✅ 确定性 AST 分析：导入、签名、副作用、危险构造
├── contract.py        ✅ CONTRACT.yaml 派生/同步/锚点解析
├── edits.py           ✅ libcst 结构化代码编辑 + 四原子文档编辑
├── provenance.py      ✅ 溯源链 + require_provenance 硬门
├── gates/             ✅ G0–G5 + 金字塔运行器 + assert_free
│   ├── base.py           Gate 协议、Candidate、外部工具封装
│   ├── g0_parse.py       语法 + libcst round-trip
│   ├── g1_security.py    import 白名单 / 危险调用 / 副作用包含
│   ├── g2_static.py      ruff + pyright + 复杂度 + 标注覆盖
│   ├── g3_contract.py    签名漂移 / 锚点存活 / 副作用包含 / 孤儿函数
│   ├── g4_tests.py       pytest（unit 与 holdout 同机制不同契约）
│   └── pyramid.py        短路执行 + 报告 + 零 LLM 断言
├── cli.py             ✅ contract init|sync · gate · facts
│
├── evidence.py        ✅ 会话采集、脱敏、TaskRecord、三分
├── attribute.py       ✅ 四路归因
├── propose/           ✅ 提议器
│   ├── p1_rules.py       规则驱动（零 LLM）
│   ├── p2_defect.py      缺陷驱动（栈追踪锚定）
│   ├── p3_capability.py  能力驱动（测试先行）
│   └── doc.py            文档反思 / 合并 / 排序
├── bundle.py          ✅ 原子捆绑构造与提交
├── replay.py          ✅ G6 逐 patch 重放（4 档转移分）
├── rollout.py         ✅ G7 留出集聚合门
├── governance.py      ✅ G8 双锚点事实一致性 + 结构诊断
├── wiki.py            ✅ 持久知识层
├── ledger.py          ✅ Preserve Ledger
├── mutation.py        ✅ 变异测试（测试质量准入）
├── staging.py         ✅ staging → 人工确认 → adopt 事务
└── trainer.py         ✅ 主循环
```

全部已实现并测试：5420 行实现 + 1057 行测试，80 项通过。

---

## 2. 数据契约

### 2.1 CONTRACT.yaml —— 文档与代码的唯一耦合面

```yaml
version: 1
allowed_imports: [__future__, re]        # 白名单；stdlib 子集自动并入
entrypoints:
  - id: extract_tables                    # AST 限定名（支持 Class.method）
    module: scripts/extract.py
    signature: "extract_tables(path: str, pages: str | None = None) -> list[...]"
    doc_anchor: references/extraction.md#extract_tables
    preconditions:  []
    postconditions: ["returns a possibly-empty list; never raises on ..."]
    side_effects:   [none]                # none|filesystem:tmp|filesystem:workspace|network|subprocess
    stability:      stable                # stable|experimental|deprecated
    cost_class:     cpu_bound
```

**关键规则：`signature` 由 AST 派生，永不手写。**

```python
contract, changes = derive_contract(skill_dir, base=existing)
# 语义字段（pre/post/side_effects/stability/doc_anchor）逐字保留
# 只有 signature 从源码覆写 → 签名漂移在结构上不可能存在于契约内部
```

这样 G3 检查的就只剩"语义半边"，而语义半边正是需要人/模型维护、也确实会漂移的部分。

`stability` 是**编辑权限分级**：
- `stable`：签名变更必须走原子捆绑；必须全类型标注；必须有 doc_anchor
- `experimental`：可自由变更（G3 降级为 warning）
- `deprecated`：只允许删除

`checks` 是契约里**可执行**的那一半，由 `contract_tests.generate` 渲染进
`tests/contract/`（每次重新生成，不在优化器可编辑面内），G3 运行：

```yaml
checks:
- never_raises: {args: ["missing.pdf"]}
- returns_type: list
- pure:       {args: ["  $ 12 "]}
- idempotent: {args: ["  $ 12 "]}
- raises:     {args: ["{"], exc: json.JSONDecodeError}
- example:    {args: ["  € 12 "], returns: "12"}   # 唯一钉住"行为"而非"形状"的一种
```

`example` 是第五轮加的，动机是量出来的（`REVIEW.md` §9.4）：当所有候选在
"修了几个任务 / 重放均分 / 变异分"上全部打平时，排序键退化为最小 diff，而
最小性与泛化性反相关。维护者写下一条训练任务没覆盖、但文档声明过的行为，
它就以零模型开销进入门控与排序。配套：**G3 的契约检查按基线相对判定**（本来
就红的只报 warning，绿转红才 error——否则一条基线红的 `example` 会锁死整个
循环，因为没有提议器以契约检查为目标），修复的检查数进入排序键的第二位
`(repaired, contract_fixed, replay, mutation, -diff)`。

### 2.2 TaskRecord

```python
@dataclass
class TaskRecord:
    id: str; project: str; intent: str
    context_excerpt: str = ""; system: str = ""
    outcome: Literal["success","fail","mixed","unknown"] = "unknown"
    reference_kind: Literal["exact","rubric","rule","none"] = "none"
    reference: str = ""                    # 精确答案，或 rubric 文本
    judge: dict = field(default_factory=dict)
    split: Literal["train","val","test"] = "train"
    origin: Literal["real","synthetic"] = "real"
    skill_hint: str = ""
    source_sessions: list[str] = field(default_factory=list)
```

三条硬规则：
- `reference_kind == "none"` → **丢弃**，不伪造参考（sleep 引擎的启发式挖掘器就死在这）
- **rubric 优先于 checks**，永远。任何字面串检查都能被"输出必须含 XXX"绕过
- split 用 `hash(seed + id) % 100` 稳定分配；合成/召回任务**无条件进 train**

### 2.3 磁盘布局

```
skills/<name>/
├── SKILL.md  CONTRACT.yaml  references/*.md  scripts/*.py
├── tests/{unit,contract,holdout}/          # holdout 对优化器不可见
└── .evo/
    ├── baseline/                            # S₀ 冻结，永不变
    ├── wiki/{patterns/*.md, logs.md, impact.md}   # 永不回滚
    ├── ledger.yaml                          # Preserve Ledger
    ├── provenance.jsonl                     # 每条改动 → 证据
    └── rounds/<r>/{bundles/, gates/, report.json}
```

---

## 3. 门控金字塔（已实现）

### 3.1 接口

```python
class Gate(Protocol):
    name: str
    cost: str                              # free | cheap | expensive
    def run(self, cand: Candidate) -> GateResult: ...

@dataclass
class Candidate:
    skill_dir: Path
    contract: Contract
    changed_modules: set[str]
    baseline_tests: dict[str, bool] | None = None   # unit + holdout + contract

res: PyramidResult = run_pyramid(skill_dir, contract, build_fast_pyramid())
assert_free(build_fast_pyramid())          # 结构性保证：快环零 LLM
```

`Verdict` 三态而非布尔：`PASS` / `FAIL` / **`SKIP`**。工具缺失必须报 SKIP，**绝不能静默当 PASS**——否则一个没装 pyright 的机器会以为自己有类型门。

### 3.2 实测（examples/pdf-tables，6 个门全过）

| 门 | 耗时 | 抓什么 |
|---|---|---|
| G0 parse | 2ms | 语法错误、**LLM 输出截断**、libcst round-trip 不稳 |
| G1 security | 130ms | import 白名单、危险调用、副作用未声明 |
| G2 static | 800ms | ruff + pyright + 复杂度 + stable 入口标注覆盖 |
| G3 contract | 2ms | 签名漂移、doc_anchor 断链、孤儿公开函数、`checks` 生成的契约测试（相对基线） |
| G4 unit | 230ms | 可见测试 |
| G5 holdout | 250ms | **优化器永不可见的测试** |
| **合计** | **~1.4s** | **0 次模型调用** |

### 3.3 每道门都验证过它拦得住什么

`examples/demo.py` 逐门注入缺陷：

| 注入 | 结果 |
|---|---|
| 截断的函数 | G0 拦下，0.2ms |
| `import requests`（不在白名单） | G1 拦下，同时报出未声明的 network 副作用 |
| `open(...,'w')` 但契约声明 `[none]` | G1 拦下，指到行 |
| 裸 `except` + `pass` | G2 拦下（`E722`/`S110`） |
| 加参数但契约未同步 | G3 拦下，**并给出旧签名 vs 新签名** |
| **背下可见测试输入直接返回** | **过 G0–G4，只在 G5 挂掉** |

最后一行是整个设计的验证点：一个刷分候选在没有 G5 的系统里会被接受。

---

## 4. 快环：代码优化（规格）

### 4.1 成本结构决定配置

| | 快环 | 慢环 |
|---|---|---|
| 提议 | **~2 次 LLM** | ~12 次 LLM |
| **验证** | **0 次** | **10²–10³ 次** |
| 提议器模型 | 小模型 / 低 effort | 前沿模型 / 中高 effort |
| 每缺陷采样 | **K=4~8**，放开采 | K=1 |
| 提纯手段 | 门控（确定性） | 分层合并 + 排序 |

**门控便宜的地方多提议少思考，门控昂贵的地方少提议多思考。** SkillOpt 那套分层合并机械存在的唯一理由是"测一次太贵所以只能提一次好的"，快环不满足这个前提。

### 4.2 三条路径

```python
# propose/p1_rules.py —— 零 LLM，不限预算
def propose_rule_fixes(skill: Path) -> list[Bundle]:
    """ruff --fix / autoflake / deptry 收敛。工具调用本身就是证据。"""

# propose/p2_defect.py —— 60% 预算，栈追踪锚定
def propose_defect_fixes(skill: Path, clusters: list[FailureCluster],
                         k: int = 4) -> list[Bundle]:
    """每个缺陷采 K 个候选修复。必须产出 repro_test。"""

# propose/p3_capability.py —— 40% 预算，测试先行
def propose_capability(skill: Path, gaps: list[Gap], k: int = 4) -> list[Bundle]:
    """先写测试（必须当前是红的），再写实现；单函数限制。"""
```

### 4.3 快环算法

```python
def fast_loop(skill: Path, contract: Contract, signals: list[FailureSignal],
              wiki: Wiki, cfg: FastConfig) -> tuple[Path, list[Bundle]]:
    accepted = []
    gates = build_fast_pyramid(cfg.pyramid)
    assert_free(gates)                                     # 不变量

    for stage, proposals in [
        ("P1", propose_rule_fixes(skill)),
        ("P2", propose_defect_fixes(skill, cluster(signals), k=cfg.k)),
        ("P3", propose_capability(skill, rank_gaps(signals), k=cfg.k)),
    ]:
        for bundle in proposals:
            require_provenance(bundle)                     # 无溯源不接受
            cand = snapshot(skill, scratch())              # 永不改原件
            apply_bundle_to_dir(cand, bundle.code_edits)

            if stage == "P2" and not repro_was_red(skill, bundle):
                wiki.record(bundle, "repro test was not red before the fix")
                continue

            res = run_pyramid(cand, contract, gates)
            if res.passed:
                skill = promote(cand); accepted.append(bundle)
            else:
                # ★ 候选回滚，但"这条路走不通、被哪道门拦下"留在 wiki 里
                wiki.record(bundle, res.stopped_at, res.findings)
    return skill, accepted
```

**`wiki.record` 是 WikiSkill 那条设计在快环的体现**：候选被拒时代码回滚，wiki 永不回滚。快环候选量大，这层知识价值最高。

### 4.4 失败聚类（零 LLM）

```python
def cluster(signals) -> list[FailureCluster]:
    """按 (exc_type, top_frame, module) 确定性分组，按频次排序。
    不需要 embedding，不需要 LLM。"""
```

---

## 5. 慢环：文档优化（规格）

沿用 SkillOpt 的六段流水线，两处因代码而变：

**变化一：反思输入多一路 `code_delta`。** 代码能力变了，文档该说的话就变了——脚本现在能自动处理空文档，文档里"注意先检查是否为空"那条就该删。不喂这一路，文档会持续积累过时告诫，这是知识膨胀的典型来源。

**变化二：新增编辑意图 `sync_with_code`**，与 evolve/fix/refine 并列，证据是契约 diff 而非轨迹。

```python
def slow_loop(skill, contract, doc_signals, code_delta, anchor_s0, meta) -> Path:
    fail_mb, succ_mb = split_minibatches(doc_signals, size=8)
    raw = parallel_reflect(fail_mb + succ_mb, workers=16,
                           code_delta=code_delta, meta_skill=meta)
    merged = hierarchical_merge(raw, batch=8)      # 失败优先
    ranked = rank_and_clip(merged, budget=lr_schedule.step())
    return apply_doc_edits(skill, ranked)
```

编辑预算默认 cosine `4 → floor 2`。消融显示对 schedule 形式不敏感，**对"有没有预算"极其敏感**。

---

## 6. 原子捆绑（规格）

```python
@dataclass
class Bundle:
    code_edits: list[CodeEdit]
    doc_edits: list[DocEdit]
    contract_delta: dict
    evidence: list[str]
    origin: Literal["P1","P2","P3","drift","doc"]
```

**任何触及 `stable` 接口的改动必须以一次不可分割的提交同时修改代码、契约、文档。** 门控顺序：

```
G0–G2 代码静态门      ← 先淘汰最便宜的
G3    契约门（三方一致性）  ← 关键：代码 ⟷ 契约 ⟷ 文档 同时自洽
G4–G5 单测 + 留出测试
G6–G7 重放 + 留出集聚合  ← 走到这里才花 rollout 的钱
G8    治理门
```

**捆绑是原子的**：任何一道门拒绝，整个 bundle 回滚。不允许"代码过了、文档没过就只提交代码"——那正好制造契约漂移。

---

## 7. 贵门（规格）

### G6 逐 patch 重放

聚合分数门抓不到"平均有益但弄坏一个原本通过的任务"。每条 patch 单独在源任务克隆上重放：

```
失败→成功 3.0   成功→成功 2.0   失败→失败 1.0   成功→失败 0.0   θ = 2.0
```

### G7 留出集聚合门

```python
if cand_score > current_score:              # 严格大于，平局判负
    accept; if cand_score > best_score: new_best
else:
    reject → rejected_buffer（epoch 内负反馈）
```
候选去重：`sel_cache[sha256(skill)[:16]]` 命中直接复用，跳过整轮 rollout。

### G8 治理门

**硬约束 · 事实一致性**（双锚点）：对 S₀ 查跨轮知识丢失，对 S_{t-1} 查本轮新引入错误。**特别盯过泛化**——把"200GB，7月27日到期"改成"视套餐而定"是严重知识丢失，必须点名丢了哪个具体值。

**软约束 · 结构一致性**：不拒绝候选，产出建议合并进下一轮。`merge_sections` / `consolidate_tail` / `split_file`（仅 >700 行时）。每文件最多 3 条。**禁止跨文件去重**（渐进式披露会累积上下文）。

代码侧对应物：圈复杂度、模块行数、导入开销由 G2b/G2c 直接测出，喂给 `ΔBloat`。

---

## 8. 多目标效用

```
U = w₁·Δpass + w₂·Δrobust − w₃·C_intf − w₄·ΔCost − w₅·ΔBloat + w₆·Δtransfer
```

两条纪律：
- **`w₃` 显著高于 `w₁`。** 修好 3 个、弄坏 1 个原本通过的候选应该被拒。这是 SkillEvo 的 RegR（实测 28.2% → 21.1%）在代码侧的对应物。
- **`ΔBloat` 必须显式建模。** SkillEvo 实测有治理 +2.8% vs 无治理 +16.2%（近 6 倍）。代码比散文更容易膨胀，因为加防御性检查总是"看起来更安全"。

---

## 9. 测试的进化（规格）

代码优化依赖测试当判据，而测试也要成长——这里有个必须正面处理的循环依赖：同一个优化器若能同时改代码和测试，它会发现改测试容易得多。SpecBench 里那个**2900 行、背下测试输入的哈希表"编译器"**就是这么长出来的。

四条硬约束：

1. **时序隔离**：测试与代码**交替进化，永不同步**（第 k 轮改代码测试冻结，k+1 轮反之）
2. **测试只增不减**：删除或弱化现有通过断言是**硬拒绝**，放宽需人工审批
3. **holdout 永不可见**，且其存在本身不告知优化器
4. **新测试的价值判据是"它当前是红的"**，一加进去就绿的没有信息量

**变异测试**（Python-only 才有的武器）：`mutmut` 注入变异看测试能否杀死，是"测试是否真在测东西"的确定性度量，零 LLM，正是 shape-only judge 问题在代码侧的解药。**当准入门槛用（下限 60%），不当优化目标**——一旦要最大化，优化器就去写专门杀变异体的测试。

**冷启动顺序由此确定：没有测试的 skill，第一轮不做代码优化，做测试床。**

---

## 10. 主循环

```python
def train(skill_0: Path, tasks: TaskSet, rounds: int = 4) -> StagingResult:
    S = S_best = skill_0
    freeze(S_0 := snapshot(skill_0, ".evo/baseline"))
    wiki, prov, ledger = Wiki(), ProvenanceLog(...), Ledger.load(...)
    C = {S_0}                                          # ★ 候选集含起点

    if not has_tests(S):                               # Phase 0
        S = bootstrap_testbed(S, tasks)                # 无测试不优化

    for r in range(1, rounds + 1):
        traces  = rollout(agent(S), tasks.train)       # L1，沙箱
        signals = attribute(verify(traces), contract=load_contract(S))   # L2 四路

        if not signals.actionable():
            break                                      # 无可修复信号，提前终止

        for _ in range(cfg.fast_iters):                # L3 快环（默认 3）
            S, code_bundles = fast_loop(S, contract, signals.code_defect, wiki, cfg)
            if not code_bundles:
                break

        for drift in signals.contract_drift:           # L4 原子捆绑
            S = commit_atomic(S, propose_bundle(drift))

        S = slow_loop(S, contract, signals.doc_defect, # L5 慢环
                      code_delta=code_bundles, anchor_s0=S_0, meta=meta)

        ok, issues = govern(S, base=S_0, prev=S_prev)  # L6 G8
        for _ in range(3):                             # 内环 edit→check→fix
            if ok: break
            S, ok, issues = repair(S, issues)

        score = evaluate_on(S, tasks.val)              # G7
        C.add(S); wiki.commit(r, code_bundles, score)
        if score > best_score: S_best, best_score = S, score

        if r % 2 == 0:                                 # 测试与代码交替
            S = evolve_tests(S, signals, code_frozen=True)

    S_star = argmax(C, key=lambda s: (val_score(s), -bloat(s)))   # 含 S₀
    return stage(S_star, report=build_report(wiki, prov))         # 不直接上线
```

三个刻意设计：**快环在慢环内多迭代**（门便宜）；**代码先于文档**（修好的代码改变文档该说什么）；**argmax 含 S₀**（永不劣于起点）。

---

## 11. 配置

```yaml
model:
  fast_proposer:  { backend: openai_chat, model: <small>, effort: low }
  slow_proposer:  { backend: openai_chat, model: <frontier>, effort: medium }
  evaluator:      { backend: anthropic,  model: <other-family> }   # ★ ≠ proposer
train:
  rounds: 4
  fast_iters: 3
  seed: 42
fast:
  k_samples: 6
  budget_p2: 6
  budget_p3: 4
gates:
  max_complexity: 10
  test_timeout_s: 30
  use_bandit: true
  use_pyright: true
  mutation_floor: 0.60
slow:
  minibatch_size: 8
  merge_batch_size: 8
  edit_budget: 4
  lr_scheduler: cosine        # floor 2
  analyst_workers: 16
gate:
  metric: mixed               # hard | soft | mixed
  mixed_weight: 0.5
  strictly_greater: true      # 平局判负
utility:
  w_pass: 1.0   w_robust: 0.5   w_interference: 2.0   # ★ 干扰权重最高
  w_cost: 0.2   w_bloat: 0.3
safety:
  require_provenance: true
  sandbox: { network: false, fs: read-only-except-tmp, cpu_s: 60, mem_mb: 2048 }
  auto_adopt: false           # 人工确认才上线
```

---

## 12. CLI

```bash
# 已实现
skillwhet contract init <skill> [--allow pkg1,pkg2]
skillwhet contract sync <skill> [--write]
skillwhet gate <skill> [-v] [--json] [--no-short-circuit]
skillwhet facts <skill>

# 规格
skillwhet bootstrap <skill>              # 测试床 + 基线冻结
skillwhet train <skill> --tasks t.json --rounds 4
skillwhet fast <skill> --signals s.json  # 只跑快环
skillwhet replay <skill> --patch p.json  # G6
skillwhet report <skill> --round 3
skillwhet stage <skill> / adopt <staging>
```

---

新增（第三轮）：

| 命令 | 作用 |
|---|---|
| `whet eval <skill> --tasks T --split val --repeat N [--runner agent --judge-samples K]` | 不训练，同一切分跑 N 次，报告均值、极差、标准差、逐任务不稳定列表、噪声记录数；判官噪声的直接读数 |
| `whet bench --cases examples/bench [--ablate] [--out bench.json]` | 对每个种入缺陷的 case 在 scratch 副本上跑 `train`，输出 baseline / best / Δ / test / 轮数 / 接受数 / 成本 / 耗时 的表，`--ablate` 加跑 first-wins / no-refine / no-dedup 三种消融 |


## 13. 里程碑

| 阶段 | 内容 | 状态 |
|---|---|---|
| **M0 地基** | 类型、AST 分析、CONTRACT 派生、libcst 编辑、G0–G5、溯源硬门、CLI | ✅ 完成 |
| **M1 快环** | 证据层 + 四路归因 + P1/P2/P3 提议器 + wiki | ✅ 完成 |
| **M2 耦合** | 原子捆绑 + G6 重放 + G7 聚合门 + 候选集含 S₀ | ✅ 完成 |
| **M3 慢环** | minibatch 反思 + 分层合并 + 排序裁剪 + slow update | ✅ 完成 |
| **M4 治理与交付** | G8 双锚点 + 结构诊断 + 变异测试 + staging/adopt 事务 | ✅ 完成 |

**实模验证记录（claude -p，2026-09-07）**

| 轮次 | 发现 | 修复 |
|---|---|---|
| 1 | haiku 在 `--tools ""` 下仍试图调用工具，撞 `--max-turns 1` 空返回 | 后端给所有 system prompt 前置"无工具"声明，`tool_use` 停机重试一次 |
| 2 | haiku 返回 `scripts.cells.normalize_cell`（带模块路径），编辑层找不到符号 | 符号归一化 + 以 content 里的 `def` 名兜底；prompt 措辞明确 |
| 3 | 两个缺陷各修一个都在 G4 被拒——G4 要求全套通过 | G4/G5 改为**相对基线**：只拒回归，不要求全绿 |
| 4 | 训练直接写进 live 目录；同名测试从未断言过这一点 | 训练在 `.evo/current` 工作副本上跑；测试补断言 |
| 5 | 两轮跑通：0.5 → 1.0，$0.06，live 保持不变，slow update/meta skill 触发正常 | — |
| 6（审计后） | `pdf-tables` + 两个"错误结果"缺陷（断言失败、栈帧只在测试里）：评估器判 code_defect 但 P2 把**测试文件**当编辑目标，被白名单拒绝 | 从测试源码解析其调用的 `scripts.*` 符号，确定性路由到代码缺陷；P2 提示词附失败测试源码 |
| 7（审计后） | 同一 fixture 重跑：9 提议 / 3 接受（P1 + 2 P2）/ 6 拒（repro 在已修复的基线上已绿），val 0.0 → 1.0，test 集 1.0/1.0，G8 通过（ledger 看见 2 个数值，膨胀 8%），$0.12；adopt 后 live 5/5 通过，baseline 已刷新 | — |
| 8（慢环） | 文档种入错误 + rubric 任务 + `--runner agent`：模型把修正**追加**在错句旁（膨胀 19%）；`replace` 目标不精确即静默跳过；反思器只看 SKILL.md、看不到 references | 反思提示词要求 replace；`edits.locate` 模糊定位；`prose_of()` 带文件标记拼接全部文档；provenance 记每条编辑状态 |
| 9（慢环） | 重跑：1 轮原地改写两处错句，val 0.65 → 0.967，`doc_val_delta` +0.317，膨胀 0%，$0.48 | — |

前四个是 mock 后端永远暴露不出来的问题；第 6 个是审计修好 A1/B1 之后才有机会暴露的问题。

**仍未做**：多语言脚本（用户确认仅 Python）；外部标准 benchmark（内部基准 7 个 case / 两个领域，`whet bench` 可直接加）；G1 经容器/属性中转的可调用对象（跨函数、跨模块返回值已覆盖，`import scripts.x as x; x.get()(cmd)` 这种属性式调用未覆盖）；**没有提议器以契约检查为目标**——一条基线就红、又无训练任务覆盖的 `example` 只能在别人提候选时充当判别项，不会自己被修，要闭环得把失败的契约检查也当缺陷聚类喂给 P2；harvest 只在自己的开发会话上验证过，样本自指；target 模型自身的回答随机性无法用判官重复消除（`claude -p` 不接受 temperature），只能靠任务数摊。

---

## 14. 验收指标

**能力**：train/val/**holdout** 三者分开报；单测与契约测试通过率；**`C_intf` 干扰数**（原本通过现在挂了的数量）。

**稳定性（更重要）**：`RegR` 连续 4 轮单调不增；`Bloat` 4 轮累计 < 10%；圈复杂度 P95；接受率（**低是健康的**——SkillOpt 全程只接受 1–4 条编辑）。

**可信度**（来自 2026 年的负面结果，不加会自欺）：
- **skill 读取率 / 遵循率** —— OpenSkillEval 实测默认读取率仅 **~48%**，平均总分改善 **<0.04**。优化了但没被读等于没优化
- **可见测试 vs 留出测试的差距** —— SpecBench 实测差距随代码规模每 10× 扩大 **28pp**。差距扩大就是在刷分
- **机制证据** —— PAST-Bench 的判据："写了制品却从不读取、或通过错误载体成功的 agent，不应该记功"

**成本**：快环 token **全部计在提议侧，验证侧恒为 0**；若验证侧出现 LLM 调用，说明有门被错误实现成了 LLM 判断。部署增量必须是 0。

**别用来验收的**：裁判与人的一致率。S³Gym 实测判断准确度与实际增益相关性 **ρ = −0.010**，基本无关。

---

## 15. 风险

1. **P3 能力驱动最可能出事**。无失败锚点，模型会"想象"需求。若 `ΔBloat` 上升而 `Δpass` 不动，第一个该关的就是它。
2. **契约维护本身是成本**。缓解：签名从 AST 自动生成（已实现），只有语义部分需维护。
3. **测试床冷启动质量决定一切**。只测 happy path 会优化出只在 happy path 正确的 skill。缓解：冷启动人工抽检 holdout。
4. **类型标注覆盖率**。pyright 的价值随覆盖率急剧下降——已在 G2 加了 `stable-entrypoint-unannotated` 检查强制。
5. **C 扩展依赖**（numpy/pandas/lxml）静态分析看不见，只能靠 G4 兜底。
6. **代码侧文献支撑最薄**。只有 Skills-Coach 与 SkillSmith 碰过，前者判据是 LLM 评分而非任务成功率、训练与测试任务由同一系统合成。**这部分是工程推演不是文献复现，上线前需自己做 G4/G5/G6 各自贡献的消融。**
7. **SkillJack 攻击面**。检测率 98.5%（轨迹）→ 11.4%（抽取出的 skill），删源后 80% 存活。已实现的对策：`require_provenance` 硬门 + G1 import 白名单前置；仍需补 skill 级（非轨迹级）二次扫描。
