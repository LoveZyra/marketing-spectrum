# SkillWhet 审阅与审计（2026-09-07）

> 对象：`skillwhet` 包，7,229 行实现，105 项离线测试全绿。
> 方法：三路并行代码审计（门控/编辑/捆绑；训练器/循环/贵门/暂存；后端/模拟/采集/提议/归因），**每条 bug 都有可运行的复现脚本并已由我复跑确认**；未能复现的只以"疑似"列出，不计入统计。训练效果维度的审阅基于对 trainer / loops / attribute / propose / expensive 的通读，对照 SkillOpt、SkillEvo、ACE、WikiSkill、SpecBench 的机制。

> **修复状态（2026-09-07 晚）**：第 2 节 48 条全部已修，每条对应 `tests/test_audit_regressions.py` 里一个同名回归测试（50 个，全绿；全套 155 个）；三个审计目录的复现脚本复跑后均显示修复后行为。修复过程中另外发现并修了两条审计没列的问题：**D1** "错误结果"型缺陷（断言失败、栈帧只在测试里）无法被 P2 定位到脚本符号——现在从测试源码里解析它调用的 `scripts.*` 符号，确定性路由；**D2** 进化出的红测试跨运行丢失——现在保存在 `.evo/pending_tests/`。第 1 节的效果维度中 1.1（`--runner pytest|agent|simulate|mixed`）、1.8 的 test 集报告与 val 平局规则、1.9（P3 生产者）已随本轮落地；其余仍是待办。

> **第二轮（2026-09-07 深夜）**：§1 的效果维度已全部实现并有测试（`tests/test_effectiveness.py`，24 项；全套 179 项全绿）。逐条状态见 §6；慢环第一次真实测量的记录也在 §6。

## 0. 一句话结论

代码结构和设计立论仍然成立，但**"全部完善"这个说法要收回**：审计确认 48 个 bug，其中 20 个属于"做出错误的接受/拒绝决定、数据丢失或泄漏"级别。之前的实模验证之所以能跑出 0.5 → 1.0，是因为那个 fixture 恰好绕开了其中最致命的几条——它没有 `tests/holdout/`，SKILL.md 里没有任何数值，任务全是 pytest 节点 id。换成自带留出测试、或者文档里写了版本号/URL 的任何真实 skill（例如包里自带的 `examples/pdf-tables`），**当前代码会在 G4 拒掉每一个候选，G8 封掉每一轮**。离线测试之所以全绿，是因为它们和实模 fixture 共用同一批盲区。

在"提升训练效果"之前，先得让判据本身正确。下面第 2 节是 bug 清单，第 1 节是判据正确之后还差什么。

---

## 1. 训练效果维度：还需要优化或补充什么

按预期收益排序。每条给出现状、它为什么卡住效果、建议的具体机制。

### 1.1 信号面太窄：目前只有 pytest 红绿真正接进了训练

`whet train` 硬编码 `PytestRunner`；`AgentRunner`（exact / rubric / rule 任务）和 `SimulationRunner`（多轮）只在 Python API 里能用。这意味着慢环（文档优化）在现有命令行路径上**从未被真实测量过**：`doc_defect` 信号只来自 evaluator 对"归因残差"（module 不在 scripts/ 下的 pytest 失败）的分类，文档改动的效果只能靠 G3 锚点存活和轮末 G7（而 G7 跑的还是 pytest）。文档环是这套系统一半的价值，现在处于"能跑、没量过"的状态。

建议：`--runner pytest|agent|simulate|mixed`，其中 mixed 按任务的 `reference_kind` 分派；同时补一个真实的文档任务集（哪怕 20 条 rubric 任务）做第一次慢环实模验证。rule 判官的三个 op（`no_refusal / tool_called / section_contains`）是空实现（见 C1），要先修。

### 1.2 任务集不会"生长"：没有任务合成、没有课程、没有前沿聚焦

任务只来自三处：手写、从测试派生、`harvest` 挖历史会话。全部是静态的。训练几轮后，长期通过的任务继续占据 train 集，K 采样和 G6 重放的算力被平均摊在已经不会失败的任务上；而 skill 真正的盲区没有任务去照。

建议三件事。其一，**前沿聚焦**：连续 N 轮通过的 train 任务移入 regression 集（只在 G6/G7 跑，不进 attribution），提议预算只花在仍失败的任务上。其二，**任务合成**：SkillEvo 的 `synthesize_scenario` 已经在 `simulate.py` 里，但没有接进训练；把"成功会话 → 变体任务"（换数值、换顺序、加干扰信息）和"失败簇 → 邻近任务"两条合成路径接进每轮，合成任务 `origin=synthetic` 只进 train（分桶逻辑已经保证不进 val/test）。其三，**难度/信息量加权**：G6 的 transition 分对每个任务等权，一条长期 pass→pass 的任务和一条刚 fail→pass 的任务贡献相同的分母；改成按"最近 k 轮翻转次数"加权，前沿任务的权重自然高。

### 1.3 提议是一发式的：门控免费，却没有"拒绝 → 带着门控结论重试"

快环的经济学前提是"验证免费，所以广撒网"。但现在每个候选只有一次机会：被 G2 拒（一个 ruff 错）、被 G4 拒（一个断言差一个字符），结论写进 wiki，**下一轮**才以 `known_failures` 文本形式回到提示词里。同一次迭代内没有"把 findings 喂回去再改一版"的步骤。这是最便宜的收益来源：G0–G5 的 findings 是精确到行的，一次带反馈的重试通常就能过。

建议：`commit()` 失败后，若 `stopped_at ∈ {G2, G3, G4}`，把 findings 和 diff 一起交给 fast_proposer 做 ≤2 次修订（同一 bundle 血统，provenance 记链），再进金字塔。预算上等价于把 K 从 4 提到 6，但命中率高得多。

配套的两点：一，K 个样本来自同一提示、同一温度，容易坍缩成同一个补丁——按"最小改动 / 防御式 / 重构"三种策略分别采样，或者让 haiku 和 sonnet 各出一半；二，**语义去重**：在进金字塔之前对候选做 AST 归一化 diff 指纹，和 wiki 里已拒绝的指纹相同就直接丢，省掉重复的门控和重放。

### 1.4 选择是"先过先赢"，不是"最好的赢"

`fast_loop` 对提议顺序遍历，第一个通过金字塔和 pre-promote 钩子的候选立刻落地，随后的同缺陷候选就在新基线上被判为"无变化"。这有两个后果：接受的是**第一个合格的**而不是最优的（更小 diff、更高变异分、更高 G6 分的可能排在后面）；且顺序效应让结果依赖 LLM 返回顺序，不可复现。

建议：按缺陷簇分组，同簇 K 个候选全部过完金字塔后，按（G6 分，−diff 行数，变异得分，复杂度增量）字典序选一个落地；其余记入 wiki 作为"可行但未选"。这是 SkillOpt "best of K"的本意，当前实现丢了这一层。

### 1.5 归因看不到轨迹，只看到 stdout 前 1200 字

对 agent 任务，evaluator 判断 code/doc/isolate 时拿到的是 `intent / reference / stdout[:1200] / 异常`。它看不到 agent 调了哪些工具、读了 SKILL.md 的哪一段、在哪一步走偏。SkillOpt 的归因是步级的。结果就是 `doc_defect` 的 summary 泛泛（"文档没有说明 X"），慢环据此产出的也就是泛泛的补丁。

建议：`AgentRunner` 记录完整轨迹（工具调用序列 + 每步引用的文档锚点），归因提示词给轨迹而不是 stdout；对 pytest 任务补一个**反事实归因**——把疑似出问题的文档段落临时删掉/把疑似函数换成 stub 再跑一次，结果翻转才确认根因。pytest 上这是毫秒级的，能把大量"ambiguous → isolate 丢掉"的信号救回来（现在 `ambiguous_budget=8` 之外的全部被丢弃）。

### 1.6 慢环从不看成功案例，且和代码改动共用一次 G7

`slow_loop` 调 `propose_doc_edits(..., successes=[])`——永远是空列表。反思器只见失败，只能往文档里加警告，不能做 ACE 意义上的"这条规则有用/有害"计数，也不能把成功轨迹中的做法固化成规则。同时，一轮里代码改动和文档改动一起接受 G7 判决：轮被拒时两者一起丢，轮被接受时不知道功劳是谁的，下一轮的 meta skill 学到的归因是错的。

建议：把该轮通过的任务轨迹（或 pytest 的通过用例名 + 对应文档锚点）作为 `successes` 传入；文档 bundle 单独做一次 val 子集评估（可以只跑 doc_defect 涉及的任务），独立记分。轮的结构改成"代码 → 量 → 文档 → 量"。

### 1.7 文档只增不减：没有规则退休机制

`run_slow_update` 每轮 ≥2 都可能往受保护区追加 guidance，meta skill 也每轮增长；`ledger` 的膨胀比是唯一刹车，而 ledger 现在对工作副本是盲的（B1）。WikiSkill 的合并/归并、ACE 的 helpful/harmful 计数，这里都没有。

建议：每条 guidance 必须引用它来源的任务 id；轮末做**反事实剪枝**——逐条删掉 guidance 重跑其引用的任务，仍通过则该条退休；guidance 区设硬上限（行数 + 字符数），超限时先合并再追加。

### 1.8 G7 在小任务集上没有统计意义，测试集从未被跑

8 条任务按 25%/25% 切分，val 只有 2 条：G7 的"严格大于"在这种规模下要么永远平局要么一票定生死。对 rubric 任务，LLM 判官单次打分噪声很大，单次 val 分数比较没有意义。另外 `test` 切分只被计数（`held_out_test_tasks`），**从未被执行**——最终报告里没有无偏数字。

建议：val 小于某阈值时告警并回退到"train 无回归"判据；rubric 任务的 G7 用 n=3 重复 + 配对比较（候选 vs 当前最优对同一任务的回答，让判官二选一），显著性用简单的符号检验；训练结束在 test 上跑一次，作为唯一对外报告的数字；再补一个 SpecBench 式的**可见-留出差距监控**——差距连续两轮扩大就停，这在架构文档的风险节里写了，代码里没有。

### 1.9 P3（能力缺口路径）没有生产者

`propose_capability` 需要 `list[Gap]`，但整个包里没有任何地方构造 `Gap`：`RootCause` 只有四个值，没有 `capability_gap`；`train()` 的 `gaps` 参数默认 None，CLI 也不传。三条快环路径实际只有两条在跑。

建议：在 `attribute` 里增加 `CAPABILITY_GAP` 根因（evaluator 判定"代码没错，是缺功能"时产出 `Gap`），或者由测试进化轮产出的"红测试 + 现有代码里无对应符号"直接构造 `Gap`。

### 1.10 成本结构：每次接受都全量重跑

每接受一个 bundle，`runner.run(train_tasks)` 和两次 `collect_test_status` 全量重跑。pytest 任务无所谓；agent 任务每条一次模型调用，训练成本随接受数线性放大。

建议：结果缓存键 `(skill 内容摘要, task id)`；用一次 coverage 运行建立"任务 ↔ 模块/符号"映射，G6 只重放触及被改符号的任务，轮末才全量；连续两轮同一缺陷簇修不掉时把 fast 模型从 haiku 升到 sonnet（升级阶梯），而不是一直用同一档。

### 1.11 优化器可见面没有白名单

这不是效果问题，是效果的可信度问题：审计确认候选可以改 `tests/holdout/`（A3），G5 拒绝信息带着留出测试名进了提议提示词（C17），`no_llm` 在线程池里失效（C18）。建议在 `materialize()` 一处集中实施白名单（只允许 `scripts/**`、`SKILL.md`、`references/**`、`tests/unit/**`、`CONTRACT.yaml` 的语义字段），wiki 对 G5 只记次数不记名字。

---

## 2. Bug 审计

严重度定义：**高** = 错误的接受/拒绝决定、数据丢失、泄漏、可被刷分；**中** = 真实输入下崩溃或误导性结果；**低** = 健壮性。复现脚本在 scratchpad `audit_a/ audit_b/ audit_c/` 下，每条都跑过。

### 2.1 高（20）— 全部已修

| # | 位置 | 缺陷 | 复现要点 | 修法 |
|---|---|---|---|---|
| A1 | `loops.py:182` + `g4_tests.py:99` | fast_loop 把 unit 和 holdout 基线合成一个 dict 传给每个 PytestGate；G4.unit 看到基线里的 holdout id 在自己的运行里"不存在"，一律判为回归 | 对**未改动**的 `examples/pdf-tables` 跑 commit：`G4.unit fail [tests/holdout/…]`。任何带留出测试的 skill 都无法接受任何候选 | `_run` 里只取 `self.subdir` 前缀的基线项 |
| A2 | `g4_tests.py:18` | `_NODE = \S+::\S+` 匹配不到含空格的 parametrize id；这些测试对基线和门都不可见，相对模式下把它们弄坏也能过 | `ids=["dollar with spaces"]`，候选弄坏它：`pytest 1 failed`，`regressed: []`，verdict pass | 正则改为 `(\S+::.+?)\s+(PASSED\|FAILED\|ERROR)`；或改用 junit-xml；相对模式下 `failed > status 里能解释的数量` 时判失败 |
| A3 | `edits.py:251` + `bundle.py:53` | 编辑目标路径原样拼接，无包含性检查、无白名单：可改 `tests/holdout/*`（架空 G5），`..` 写到工作目录外，绝对路径覆盖任意文件 | (a) 把留出测试改成 `assert True` + 作弊实现 → accepted；(b) `..` 模块 → 写到外面；(c) 绝对路径 DocEdit → 覆盖受害文件 | `materialize` 里 `resolve()` + `is_relative_to(cand)`；模块限 `scripts/**`；拒绝 `tests/holdout`、`tests/contract` |
| A4 | `bundle.py:64` | `materialize()` 在金字塔之前就从候选 AST 重新派生签名，G3 的"stable 入口不得单方面漂移"永远触发不了；`needs_atomic_bundle()` 定义了但无人调用 | stable 的 `normalize_cell` 加了参数、无文档改动：accepted，G3 findings 空，文档仍写旧签名 | G3 对**编辑前**的契约比对；`commit()` 调 `needs_atomic_bundle`，为真且无配套 doc_edits 则拒 |
| A5 | `analysis.py:88-191` | G1 别名数据流漏掉：`s: object = os.system`（AnnAssign）、`from os import *` 后直接 `system(c)`、`map(os.system, cs)`、`getattr(__builtins__,'eval')`、`a = b = os.system`、海象、`sys.modules['os'].system`、`Path(p).open('w')` 记为无副作用 | 四种写法 G1 全部 pass，findings 空 | 加 `visit_AnnAssign/visit_NamedExpr`，遍历所有 targets；`_resolve_value` 去掉 `builtins.` 前缀；`import *` 视为对应模块全部黑名单项的别名；检查调用**实参**里的 Name/Attribute |
| A6 | `g4_tests.py:72` | G4/G5 用 `run_tool`（裸 `subprocess.run`，继承环境、无 netns、无 rlimit）跑候选测试；只有基线采集走了沙箱 | 候选测试读到 `TRAINER_API_KEY`、能联网、RLIMIT_AS 无限：沙箱下 3 个测试 FAILED，门里 verdict pass | 换成 `run_sandboxed(argv, cand.skill_dir, SandboxPolicy(...))`，并透出 `degraded` |
| A7 | `contract_tests.py:86` | 生成文件只按 `e.id` 命名，不同模块同名入口互相覆盖，前者的 checks 静默不跑 | `a.py::run`（违反 `returns_type: str`）与 `b.py::run`：写出 1 个文件，G3 pass | 文件名带模块 slug |
| A8 | `mutation.py:182` | `killed = rc != 0`：套件里任何无关红测试（相对模式下常态）或不可收集模块都让每个变异体"被杀"，变异分恒 1.0，下限形同虚设 | 红套件 + 空断言测试：score 1.00 meets(0.6)=True；不可解析测试文件同样 1.00 | 先跑一次未变异得到绿集合，只有绿集合里的用例转红且 rc==1 才算杀死 |
| B1 | `ledger.py`（`check` / `govern`） | 跳过所有路径含 `.evo` 的文件，而训练工作副本就在 `.evo/current`：文档对 ledger 不可见 → 每个记录值都是"违规"，`bloat_ratio=-1` → G8 封掉每一轮 | 对未改动的 `.evo/current` 跑 `ledger.check`：3 violations；`govern`: passed=False。S0 文档里有任何数值/URL/常量名的 skill 都训不动 | 相对 `skill_dir` 判断，而不是相对绝对路径的 parts；或把工作副本放到 `.evo` 之外 |
| B2 | `expensive.py`（`replay_candidate` 阈值） | 均值阈值 2.0 会拒掉**无回归的正确修复**：修好 1 个、保住 1 个、另 2 个仍失败 → (2+3+1+1)/4 = 1.75 < 2.0 | fast: proposed 1 / accepted 0 / `G6 replay: score 1.75 < threshold`，fix 没进工作副本 | 判据改为 `regressed == 0 and repaired ≥ 1`；均值只做同簇候选排序 |
| B3 | `trainer.py` / `staging.py` | `adopt` 之后 `.evo/baseline` 不刷新；下一次 `train` 把**当前 live 的分数**配上**旧 S0 的目录**，没有轮改进时把旧 S0 送进 staging，`adopt`（不看 `manifest.accepted`）把 live 回滚成旧 S0 | run2 后 `live still fixed? False`，`live == old S0? True`，CLI adopt rc 0 —— 已修好的 skill 被无声回退 | `adopt` 后重建 baseline 快照与分数；`adopt` 拒绝 `accepted=False` 的 staging |
| B4 | `trainer.py:268-296` | 轮级 G8 拒绝只是不快照，**不回滚工作副本**：第 1 轮引入的硬违规留在 `.evo/current`，后面每一轮都被同一条违规封死 | 三轮全部 `gov_passed=False viol=['2.1.0']`，第 3 轮正确的代码修复也被拒 | 轮被 G8/G7 拒时把 `.evo/current` 恢复为 `prev_dir`（或最后接受的快照） |
| B5 | `loops.py:242` | `slow_loop` 的 `commit()` 不传 `baseline_tests`，G4 退回绝对模式：只要有任何单元测试是红的（训练期常态），纯文档 bundle 一律被拒 | 一个无关红测试 → `G4.unit fail absolute`，SKILL.md 未变 | 与 fast_loop 一样传 `baseline_tests`；文档 bundle 可跳过 G4/G5 |
| B6 | `evolve_tests.py:122` | `_is_red` 只看 rc≠0：收集期就报错的模块也算"红"而被接纳，之后每次 pytest 都整体崩溃（所有任务 NotCollected，G4 `pytest-crashed`），并且 `check_monotonic` 也拦不住 | 接纳一个 import 错误的测试后：`collect_test_status: {}`，G4 fail `pytest-crashed`，后续所有轮死掉 | 红的定义改为"可收集 且 至少一个用例 FAILED"（解析 `-v`），rc 2/3/4 直接拒 |
| B13 | `trainer.py:138` / `attribute.py` / `types.py:284` | P3 路径没有生产者：全包没有任何地方构造 `Gap`，`RootCause` 无 `capability_gap`，`train()` 的 `gaps` 默认 None 且 CLI 不传 | `grep -rn "Gap("` 只命中类定义 | 见 1.9 |
| C1 | `runner.py:171-199` | `score_rule_judge` 对 `no_refusal / tool_called / section_contains` 没有实现，直接算通过；这三个 op 在 `KNOWN_OPS` 里所以 `validate_judge` 不告警，而 harvest 的 miner 提示词还在鼓励产出 `no_refusal` | 回答 "I'm sorry, I can't help" → `no_refusal` 通过，(1.0, 1.0) | 实现三者，或从 `KNOWN_OPS` 与 miner 提示词里移除 |
| C4 | `simulate.py:214` | 用户 agent 在同一轮里"提出新意图 + action=done"时，`not sm.pending()` 分支直接返回 normal：该轮用户消息没有追加，服务方从未看到这个问题，但意图已记为 raised，判官打 0 → 任务失败 | 服务方只被调用 1 次，`raised` 里却有 2 个意图，verdict passed=False | 只在 `may_terminate()` 为真时返回；done 但有新意图时追加消息继续；另 `note_addressed` 对 `[agent error]`/空回复也标记已处理，需排除 |
| C7 | `simulate.py:366` + `expensive.py:130` | `EvalNoise`（模拟器自己没把 key 意图问全）被记为 `passed=False, hard=0.0`，下游 `aggregate / replay / holdout_gate` 当作回归处理 —— 与代码里"排除出分母"的注释相反 | 服务方回答完美、用户 agent 提前退出：aggregate (0.0, 0.96)，holdout gate reject | `ExecRecord` 加 `noise` 标志，三处聚合同时从分子分母剔除 |
| C9 | `harvest.py:37-40` | 脱敏漏掉 `Authorization: Bearer <jwt>`（正则在 Bearer 后的空格处截断）、JSON 引号里的 `"token"/"Authorization"`、带前缀的环境变量 `OPENAI_API_KEY= / DATABASE_PASSWORD= / STRIPE_SECRET=`（`\b` 在 `_` 后不成立） | 6 种样本原样漏出 | 加 `bearer\s+[\w.~+/=-]{16,}`；键名前允许 `\w*` 前缀；JSON 键表加 `token / authorization` |
| C15 | `slow_update.py:88-102` | `read/write_slow_field` 取第一个 START 与第一个 END，不做配对检查：孤儿 END 时每轮再追加一个块且 `prev_guidance` 恒空；孤儿 START 时下一次写入把 START 到 END 之间的**skill 正文删掉**；重复块只替换第一个 | `'## Rules' survived: False`；三轮后 START 计数 3、`read_slow_field` 为空 | 单一 DOTALL 正则定位配对块；不配对或重复时剥掉所有标记、只追加一个新块 |

### 2.2 中（22）— 全部已修

| # | 位置 | 缺陷 | 修法 |
|---|---|---|---|
| A9 | `contract_tests.py:32,69` | 生成的测试不是合法 Python：`json.dumps` 把 `None/True/False` 写成 `null/true/false`；`raises.exc="json.JSONDecodeError"` 被拼进函数名。正确的函数在 G3 被误拒；未知 `returns_type` 被静默丢弃 | 字面量用 `repr()`；exc 名做标识符清洗；未知类型报错 |
| A10 | `bundle.py:131-152` | `_promote` 非原子：逐文件全量复制（含不该动的 holdout），中途失败留下半更新的 skill_dir，异常穿出 `commit()`，`finally` 又删掉唯一的候选副本 | 只复制有差异的文件；先写 staging 再 `os.replace`；失败时从快照恢复 |
| A11 | `edits.py:222` | `add_import` 用子串判断"已存在"：有 `import requests` 时 `import re` 被跳过，新代码留下未绑定名 | 解析为 Import/ImportFrom 节点比较 |
| A12 | `bundle.py:105` | 仅含 `contract_delta` 的 bundle `is_empty()=False` 但 `commit()` 以 "no edit applied" 拒绝，契约语义字段的改动永远落不了地 | `contract_delta` 计入"已应用" |
| B7 | `trainer.py:183` | 测试轮永远过不了 G7（分数平局 → 拒），其产出只有在**之后**某个代码轮被接受时才进 staging；默认 `rounds=4, tests_every=2` 的最后一轮是测试轮，输出不可达 | 测试进化改为轮内代码阶段之前的一个 phase；或测试轮不经 G7、直接快照 |
| B8 | `loops.py:67` | repro-red 检查只看 rc≠0：`this is not python`、`import nonexistent_module` 都算"红"，检查形同虚设 | 要求可收集 + 至少一个用例 FAILED；修复后必须转绿（否则 repro 与修复无关） |
| B9 | `propose/p2_defect.py`（`_context`） | evaluator 把无栈帧的失败（AgentRunner / NotCollected，`module==""`）标成 code_defect 时，P2 对 skill **目录** `read_text()` → `IsADirectoryError` 崩掉整轮 | module 为空的簇不进 P2，或降级为 isolate |
| B10 | `cli.py:_tasks_from_pytest` + `runner.py` | skill 位于上层有 `pytest.ini / pyproject.toml / setup.py` 的仓库内时，`--collect-only` 的节点 id 带 rootdir 前缀（`skills/cells/tests/…`），运行时 id 无前缀，所有任务 NotCollected | 两处统一加 `--rootdir=<skill_dir>`，或 id 归一化到相对 skill_dir |
| B11 | `runner.py`（`PytestRunner`） | 与 A2 同源：含空格的 parametrize id 在运行器里也 NotCollected，`collect_test_status` 也看不到 | 同 A2 |
| B14 | `trainer.py:165,353` | `test` 切分只被计数，从未被执行，最终报告没有无偏数字 | 训练结束在 test 上跑一次 |
| C2 | `runner.py:190,192` | `max_chars/min_chars` 的 `int(arg)` 对非整数抛异常；`mine()` 只告警不丢弃，一条坏任务崩掉整个 split 的 `AgentRunner.run` | try/except 记为失败检查 |
| C3 | `backend.py:352` | `_balanced_objects` 把 `'` 当字符串定界符，对象前的散文里有一个撇号（"Here's the fix: {…}"）就吞掉后面全部，`extract_json` 返回 None，有效的 P2/P3/判官回复被丢 | 只在 `depth>0` 时跟踪字符串；或逐个 `{` 尝试 `raw_decode` |
| C5 | `simulate.py:90-95` | `_match` 取第一个作为子串出现的议程主题，"refund" 与 "refund timeline" 并存时后者永远无法 raised，coverage 永远 <1，每次运行都是 EvalNoise | 先精确匹配，再最长子串 |
| C6 | `simulate.py:141` | `</say>` 缺失（max_tokens=400 截断）时 `_parse_block` 把整段原文当作 `say`：`<reason>` 和 `<agenda_check>`（隐藏议程和用户 agent 的推理）被发给服务方并进入被判定的对话 | 未闭合时取 `<say>` 之后文本；否则剥掉所有标签块 |
| C8 | `simulate.py:64-65` | `Scenario.from_dict` 不归一化 `priority`（`"Key"/"high"` 静默变 minor，coverage 空转为 1.0、passed 空真），字符串议程项直接 `AttributeError` | 归一化到 `key/minor`；接受字符串项；`per_intent` 键同样归一化 |
| C10 | `harvest.py:129-134` | 把所有 `role==user` 记录当人类提示：压缩摘要（`isCompactSummary`）、`isMeta`、子代理提示（`isSidechain`）、`[Request interrupted by user]` 都进入 `user_prompts` 并喂给 miner；压缩摘要常成为 `user_prompts[0]`。已对照真实转录格式确认 | 跳过带这些标志的记录 |
| C11 | `evidence.py:204-211` | `parse_traceback` 以绝对路径含 `"scripts/"` 判断"skill 内帧"；skill 放在 `~/scripts/…` 下时测试帧和 site-packages 帧全部像 skill 代码，测试侧断言被路由成 code_defect | 相对 `skill_dir` 解析，`rel.parts[0]=="scripts"` |
| C12 | `evidence.py:214-218` | `_EXC_LINE` 取失败块里**最后一个**列 0 的 `XxxError:` 行，而失败块包含 "Captured stdout"；脚本 print 一行 `KeyError: …` 就覆盖真实异常类型（`ConnectionError` 会把记录送去 isolate） | 在第一个 `^-+ Captured ` 处截断；取最后一个 traceback 紧随的异常行 |
| C13 | `runner.py:96` | `_failure_block` 用测试名子串匹配头行，`test_parse` 拿到 `test_parse_empty` 的 traceback，两条记录聚成一簇，P2 去"修"一个故意的 raise | `\b…\b` 或完整 `Class.name` 精确匹配 |
| C14 | `edits.py:278-288` | `_in_protected` 只检查目标**起点**：目标从 START 标记前一点开始、延伸进块内的 delete/replace 可删除 guidance 和 START 标记（随后必然留下孤儿 END，触发 C15） | 判区间重叠 |
| C16 | `backend.py:222-223` | 系统提示词（SKILL.md + 全部 references）作为**一个 argv 元素**传给 `claude`，超过 Linux `MAX_ARG_STRLEN`（128 KiB）时 `execve` E2BIG；`simulate()` 把它记成 `[agent error]` 并按 KnowledgeGap 打分 | 超阈值改走临时文件或拼进 stdin |
| C17 | `wiki.py:108-118` → `loops.py:150` | G5 拒绝以留出测试的节点 id 作为"workaround"记入 wiki，`wiki.brief()` 把它注入 P2/P3 提示词：快环提议器看到了留出测试的名字（描述性名字本身就是信息） | G5 只记次数；`brief()` 过滤 `tests/holdout/` |

### 2.3 低（6）— 全部已修

| # | 位置 | 缺陷 | 修法 |
|---|---|---|---|
| A13 | `edits.py:47` | `_parse_function` 只保留 FunctionDef，模型随函数一起给出的 `import math` 被静默丢弃 | 有非函数语句时报 `EditError`，或把前导 import 走 `add_import` |
| A14 | `g1_security.py:87` | bandit 级别旗标差一档：默认 `MEDIUM` 传 `-lll`（仅 HIGH） | `LOW→-l, MEDIUM→-ll, HIGH→-lll` |
| A15 | `sandbox.py:72,140` | 超时只杀直接子进程，`setsid` 之后的孙进程存活 | `os.killpg` |
| A16 | `mutation.py:97-100` | 十六进制/八进制/二进制字面量 `int()` 抛异常但已计数，产生与源码相同的"变异体"，永远存活，压低分数 | `int(v, 0)` 并按原进制回写，或跳过 |
| B12 | `trainer.py:329` | 提前 `break` 时 evaluator 的成本未累计进本轮/总成本 | break 前也结算一次 |
| C18 | `backend.py:52-67` | `no_llm` 用 `threading.local`，`propose/doc.py` 的 `ThreadPoolExecutor` 里发出的调用不受拦截 | `contextvars` + `copy_context().run` |

### 2.4 疑似（未复现，不计入统计）— 三条均已顺手处理

`claude -p` 继承调用方 cwd/env：会加载调用方的 `CLAUDE.md`，且在 Claude Code 会话内运行时 `CLAUDECODE` 环境变量会让 CLI 拒绝启动（需真实 CLI 验证；建议 `cwd=tempdir` 并清掉该变量）。`attribute.py` 的 `"socket.timeout"` 永远匹配不到（`_EXC_LINE` 要求 Error/Exception 后缀），`scripts/` 内部的 `ImportError` 被当环境故障隔离而 P2 看不到。`assign_splits` 的"提升一条 train 到 val"回退是从头重算的，任务集微小时加一条任务会让之前提升的那条掉回 train。

---

## 3. 对之前结论的修正

| 之前的说法 | 现在 |
|---|---|
| "全部模块实现并接入主循环" | 模块都在，但 P3 无生产者、test 切分不执行、AgentRunner/SimulationRunner 未接 CLI |
| "已用真实模型端到端验证：0.5 → 1.0" | 结果本身真实，但 fixture 恰好避开了 A1/B1/B4/B5/B2 的触发条件；对 `examples/pdf-tables` 这种带 holdout 和数值文档的 skill，现有代码一个候选也接受不了 |
| "105 项测试通过" | 测试与 fixture 共用盲区：没有一条测试覆盖"带 holdout 的相对 G4"、"工作副本上的 ledger"、"G8 拒绝后的回滚"、"adopt 后的再次训练" |
| "G1 能穿透别名 / getattr / `__import__`" | 对单 Name 赋值成立；AnnAssign、链式赋值、海象、`import *`、以实参形式传递的可调用对象都看不到 |
| "训练只碰工作副本，live 不变" | 训练期成立；但 `adopt` 后再 `train` + `adopt` 会把 live 回滚（B3），且候选可以通过 `..`/绝对路径写到工作目录外（A3） |

---

## 4. 建议的推进顺序

**第一批：让判据正确（预计 1–2 天，全是小改）。** A1、B1、B2、B5、B4、B3、B6、C7、C1 —— 这九条决定"该收的收不进、不该收的收进来、收进来的又丢掉"。修完后把 `examples/pdf-tables` 作为第二个实模 fixture 跑通，并给每条加回归测试（尤其是"带 holdout 的相对 G4"和"adopt → train → adopt"）。

**第二批：封住优化器的作弊面（半天）。** A3、A6、C17、C18、A4、A8、B8 —— 白名单集中在 `materialize()` 一处，G4/G5 走沙箱，wiki 对 G5 脱敏，变异与 repro-red 的"红"改为可收集且有用例转红。

**第三批：解析与健壮性（1 天）。** A2/B11、B10、C3、C11、C12、C13、C15/C14、C9、C10、A9/A7、A10、B9、C16。

**第四批：效果维度（按 1.1 → 1.4 → 1.3 → 1.2 → 1.6 → 1.8 的顺序）。** 先把 agent/simulate runner 接进 CLI 并拿一个真实文档任务集量一次慢环；再做同簇 best-of-K 选择和带反馈重试（最便宜的两个收益）；然后是任务前沿聚焦与合成；最后是文档 successes 输入、规则退休、G7 的重复测量与 test 集报告。

~~第一、二批完成前，不建议在任何真实 skill 上执行 `whet adopt`。~~ 四批中的前三批已完成；第四批的 1.1 / 1.8（部分）/ 1.9 已完成，其余见 ARCHITECTURE.md "仍未做"。

## 5. 修复后的设计变化（与原架构文档不同的地方）

- **轮结构**：测试进化不再占用整轮。第 k 轮先跑测试阶段（代码冻结、只增、必须红），新红测试即刻成为 train 任务，同一轮的代码阶段就去修它。"代码与测试不同步"由 `edits.editable_path` 结构性保证：代码编辑根本写不到 `tests/`。
- **轮级拒绝回滚**：`.evo/current` 在 G7/G8 拒绝后恢复到最后一个被接受的状态（`anchor`）；进化出的红测试保留，并写入 `.evo/pending_tests/` 跨运行存续。
- **G7 平局规则**：val 平局 + 本轮有经 G6 验证的接受（修好 ≥1 个 train 任务且无回归）→ 接受（不更新 best）；无任何接受的平局仍拒绝。最终选择在同分时取更晚的候选。
- **G6 判据**：`regressed == 0 and repaired ≥ 1`（P1 规则修复允许 inert）；均值分只用于排序。
- **可编辑面白名单**：代码编辑仅 `scripts/**/*.py`；文档编辑仅 `SKILL.md`、`references/**/*.md`；`..`、绝对路径、`.evo`、`tests/holdout`、`tests/contract` 一律 `refused`。`_promote` 只写有差异的文件，`os.replace` 逐文件换入，失败全量回滚。
- **契约漂移**：`commit()` 对**编辑前**契约做 `stable_drift`；stable 入口签名变化必须同时携带 `contract_delta[id]` 和对其 doc_anchor 文件的 doc 编辑，否则 `contract drift` 拒绝。
- **pytest 统一入口** `pytestio.py`：`--rootdir=. -c /dev/null`，`-v` 行双端锚定解析，失败块按标题精确匹配并截掉 Captured 段；所有门、运行器、变异、repro、收集共用。
- **adopt**：拒绝 `accepted=False` 的 staging（`--force` 可覆盖）；成功后刷新 `.evo/baseline` 与 ledger，删除过期的 `current/prev`。
- **归因**：新增 `capability_gap` 根因与 `Attribution.gaps()`（P3 的生产者）；`scripts/` 内的 ImportError 视为代码缺陷；断言失败按测试调用的 skill 符号定位。
- **EvalNoise**：`ExecRecord.scored` 为假的记录从 `aggregate / replay / holdout_gate` 的分子分母同时剔除。

## 6. 效果维度的落地状态（第二轮）

| 维度 | 状态 | 机制（模块） | 默认 |
|---|---|---|---|
| 1.1 信号面 | ✅ | `--runner pytest\|agent\|simulate\|mixed`，`MixedRunner` 按任务形态分派 | pytest |
| 1.2 前沿聚焦 | ✅ | `trainer._TaskState`：跨轮/跨运行的通过历史；连续 `frontier_window` 轮通过的任务离开逐候选重放集，轮末全量复查，稳定任务回归则整轮拒；翻转次数作为 G6 排序权重 | 开 |
| 1.2 任务合成 | ✅ | `synthesize.py`：失败的 agent 任务优先，生成同族变体（换数值/顺序/加干扰/边界），必须带 rubric，`origin=synthetic` 只进 train，持久化到 `.evo/synthetic_tasks.json` | `--synthesize-every 0`（关） |
| 1.3 带反馈重试 | ✅ | `search.refine`：G0/G2/G3/G4 或 repro 仍红的候选，带精确 findings 再问一次，血统记 `refined_from:` | `--refine 1` |
| 1.3 语义去重 | ✅ | `search.fingerprint`：去 docstring 的 AST 指纹；本轮已见或 wiki 里已拒的指纹不进金字塔（`.evo/wiki/rejected_fingerprints.json`） | 开 |
| 1.3 采样多样性 | ✅ | P2 每个样本绑定一种修复策略（最小改动 / 防御式 / 重构） | 开 |
| 1.4 best-of-K | ✅ | `bundle.evaluate` 与 `promote` 拆开；同簇 K 个候选对同一基线全部过门，按（修好任务数, 重放均值, 变异分, −diff 行数）选一个落地，其余记"可行未选" | 开（`--first-wins` 关） |
| 1.5 轨迹归因 | ✅ | `ExecRecord.trajectory`（系统提示摘录、用户消息、回答、判官理由；多轮则是全部轮次），进归因提示词 | 开 |
| 1.5 反事实归因 | ✅ | `counterfactual.section_effects`：逐节删除重跑，失败任务变过 → 该节有害（产出带锚点的 doc_defect 信号）；通过任务变败 → 该节承重 | `--counterfactual-budget 0`（关） |
| 1.6 慢环看成功 | ✅ | 本轮通过的任务（意图 + 回答摘录）作为 `successes` 进反思器 | 开 |
| 1.6 文档单独计量 | ✅ | 文档 bundle 落地前后各跑一次 val，下降则只回退文档、代码保留功劳；`slow.doc_val_delta` | 开（pytest runner 下跳过） |
| 1.7 引用与上限 | ✅ | guidance 每条必须引用 `[task:id]`，无引用或引用不存在的任务即丢；硬上限 12 行 / 1800 字，保留最新 | 开 |
| 1.7 规则退休 | ✅ | `slow_update.retire_guidance`：被引用任务在删掉该行后仍通过 → 退休到 `.evo/retired_guidance.md` | `--retire-budget 0`（关） |
| 1.8 val 规模告警 | ✅ | `< min_val` 时 wiki 与 gate 报告标 warning | 4 |
| 1.8 判官重复测量 | ✅ | `AgentRunner(judge_samples=n)` 取中位数 | `--judge-samples 1`（建议 3） |
| 1.8 泛化差距监控 | ✅ | train−val 差距连续 `gap_patience` 个接受轮扩大超过 `gap_delta` 即停 | 2 / 0.05 |
| 1.8 test 集终评 | ✅ | 报告 `test_score_baseline / test_score_best` | 开 |
| 1.9 P3 生产者 | ✅ | `capability_gap` 根因 → `Attribution.gaps()` | 开 |
| 1.10 结果缓存 | ✅ | `cache.CachedRunner`：键 = (skill 内容摘要, 任务摘要, runner)，噪声不缓存，`.evo/cache.json` | 开（pytest 不缓存） |
| 1.10 并行 roll-out | ✅ | `AgentRunner(workers=4)`，contextvars 透传 `no_llm` | 4 |
| 1.10 模型升级阶梯 | ✅ | `search.ClusterLedger`：一个缺陷簇连续 `escalate_after` 轮未修好，改由慢环模型提议 | 2 |
| 1.11 白名单 | ✅ | 第一轮已做 | — |

**慢环第一次真实测量（claude -p，target=haiku，judge=opus，slow=sonnet）**

fixture：`pdf-tables`，`references/extraction.md` 种入两处错误陈述（"货币符号保留"、删掉"无表格返回空列表"），8 条 rubric 任务（train 4 / val 3 / test 1），`--runner agent`。四次运行，每次修一个刚暴露的问题：

| 运行 | 结果 | 暴露的问题 → 修法 |
|---|---|---|
| 1 | 2 轮各接受 1 个文档 bundle，val 0.65 → 0.977，`doc_val_delta` +0.317 / +0.01，$0.78 | 模型把"修正段落"**追加**在错句旁边，错句仍在，文档自相矛盾，膨胀 19% → 反思提示词加"错句必须 replace" |
| 2 | val 0.65 → 0.658（几乎没动），bundle 里 3 处编辑只有 append 落地 | `replace` 的 target 与原文不完全一致时静默跳过，且 provenance 不记录编辑状态 → provenance 记每条编辑的 status/detail；wiki 记"落地但有编辑未应用"；`edits.locate` 做空白不敏感 + 行块相似度（≥0.85）的模糊定位 |
| 3 | 仍 `skipped_target_not_found` ×2，文档 bundle 在单独计量中 val 0.642 → 0.628 被**自动回退** | 根因：`propose_doc_edits` 只把 **SKILL.md** 给反思器，`references/*.md` 从未进入提示词——慢环对大部分 skill 内容是盲的 → `prose_of()` 带 `===== FILE: path =====` 标记拼接全部文档，提示词要求 path 必须是列出的文件、target 从该文件逐字引用 |
| 4 | **1 轮**接受 1 个 bundle（2 处 replace，原地改写错句），val 0.65 → 0.967，`doc_val_delta` +0.317，**膨胀 0.0%**，G8 通过，第 2 轮无信号提前停止，$0.48 | — |

test 集（1 条关于签名的任务，与种入错误无关）：0.175 → 0.15，单样本判官的噪声量级——这就是 `--judge-samples 3` 的用途；val 的 3 条任务两轮读数一致。运行 3 里"文档 bundle 因 val 下降被自动回退"是 §1.6 单独计量机制第一次在真实模型上起作用。

三个问题（追加而非替换、目标模糊匹配、反思器看不到 references）都只有真实模型 + 真实文档任务才暴露得出来；离线测试里的 ScriptedBackend 永远会给出完美的 target。

## 7. 第三轮：默认关闭机制的实测、判官噪声、基准

新增两个命令：`whet eval`（同一切分跑 N 次，报告均值/极差/标准差/逐任务不稳定列表）和 `whet bench`（`examples/bench/` 四个种入缺陷的 case，每个在 scratch 副本上训练，输出一张表；`--ablate` 加跑 first-wins / no-refine / no-dedup）。以下全部用 `claude -p`（target=haiku，judge=opus，slow=sonnet）。

### 7.1 判官噪声：`--judge-samples 1` vs `3`

同一个已修好的文档 skill，8 条 rubric 任务，各跑 3 遍：

| | 三次总分 | 极差 | 标准差 | 不稳定任务 | 费用 |
|---|---|---|---|---|---|
| 单次判官 | 0.786 / 0.707 / 0.792 | 0.085 | 0.039 | 5 / 8 | $0.75 |
| 三次取中位 | 0.648 / 0.679 / 0.703 | 0.054 | 0.022 | 3 / 8 | $2.07 |

两点值得记下。噪声减半，费用 2.7 倍，这是预期内的；没预期到的是**均值降了 0.08**：单次判官对 d3（空白折叠问题）给过两次 0.95、一次 0.365，中位数三次都是 0.34–0.36 —— 两次 0.95 是离群值，d3 其实一直是失败的。单样本判官不只是抖，它系统性**高估**。剩余的抖动（d5、d4v）来自 target 模型本身回答的随机性，判官重复解决不了；`claude -p` 不接受 temperature 参数，这部分噪声只能靠任务数摊。

### 7.2 任务合成（`--synthesize-every 1`）——两次都暴露问题

| 运行 | 结果 | 问题 → 修法 |
|---|---|---|
| 1 | 2 个失败种子 → 4 个变体，全部进入 train；其中 2 个问的是 `parse_invoice()`、`get_records()` —— **skill 里不存在的函数** | 合成器只看到种子任务，看不到 skill → 提示词附全部文档 + 契约/AST 里的函数名列表；变体里出现不在列表里的 `name(` 一律丢弃 |
| 2 | 4 个变体全部有据可依，但在**有缺陷的 S0 上全部通过**（0.85–0.95），文档修好后全部**失败**（0.0–0.72）：rubric 写成了"与文档描述一致"，把缺陷当成了标准答案。val 门守住了这一轮（0.65 → 0.958），但 train 分从 0.79 掉到 0.28，训练信号被污染 | 提示词明确 rubric 必须是种子 rubric 推出的**正确答案**、禁止"与文档一致"；再加确定性的 `neighbour_check`：合成后立刻在当前 skill 上跑一次，失败种子的变体若通过、通过种子的变体若失败，都不是邻居，丢弃；rubric 里出现 "consistent with / according to the documentation" 直接丢 |
| 3 | 5 个候选 → 1 个因不存在的函数名被丢，4 个进 `neighbour_check` → 3 个在 S0 上通过（不是失败的邻居）被丢，**1 个**留下："normalize_cell 会把单元格里的多个制表符/换行折叠成一个空格吗"，rubric 写的是正确答案。修复后 train 0.815（无污染）、val 0.97 | 两道防线都起了作用；产出率 1/5——合成任务的每条成本约 4 次模型调用，比人写一条贵，但能自动指向盲区 |

### 7.3 反事实逐节消融（`--counterfactual-budget 16`）

在有缺陷的 S0 上跑：16 次 roll-out，4 个任务 × 4 节全覆盖，**零发现**。删掉写错的那一节，haiku 从"答错"变成"不知道"，任务仍然失败——消融只能识别"没有它更好"的段落，识别不了"写错但可改对"的段落，而后者才是慢环真正要修的东西。修好之后再跑：`extract_tables` 一节对 d2 承重（删掉就答不出空列表）；同时它对 d3 被记为"有害"——d3 问的是空白折叠，与这一节无关，是单次 roll-out 的噪声。因此加了 `confirm`：有害判定必须重跑一次复现才算数（承重判定不需要，误判承重只是少删一段）。两轮 $1.44，其中消融占大头——这个机制的性价比不如 §1.6 的"文档单独计量"，默认继续关闭。

### 7.4 guidance 退休（`--retire-budget 6`）

在带一条 `[task:d5]` guidance 的 skill 上跑：2 次 roll-out（带该行 d5 通过，去掉该行 d5 失败）→ 该行**承重，保留**。机制按设计工作；这个 fixture 里没有可退休的行，没法展示"退休"分支的真实样本。

### 7.5 文档单独计量的回退阈值

反事实那次运行的第 2 轮，文档 bundle 因 val 0.975 → 0.968 被自动回退。0.007 在 7.1 量出的噪声范围内（极差 0.05–0.09），这是把噪声当回归。加了 `doc_revert_margin=0.02`：只有跌幅超过它才回退。

### 7.6 基准（`whet bench --cases examples/bench`）

第一次跑（test 切分设计有误——放的是与缺陷无关的任务，S0 上就是 1.0，量不出泛化）：

| case | baseline | best | Δ | 轮数 | 接受 | 费用 | 耗时 |
|---|---|---|---|---|---|---|---|
| code-currency | 0.000 | 1.000 | +1.000 | 2 | 2 | $0.04 | 69s |
| code-two-defects | 0.000 | 1.000 | +1.000 | 2 | 3 | $0.08 | 109s |
| doc-missing-info | 0.050 | 0.973 | +0.923 | 2 | 1 | $0.43 | 160s |
| doc-wrong-statements | 0.658 | 0.970 | +0.312 | 2 | 1 | $0.47 | 162s |
| **均值** | | | **+0.809** | | **4/4 改进** | **$1.02** | 8.3 min |

code-currency 里 best-of-K 第一次在真实模型上做出选择：两个候选都修好了任务、重放分相同，diff 5 行的胜过 7 行的（wiki 记 `viable, not selected … rank=(1, 2.5, 0.0, -7)`）。code-two-defects 两个崩溃缺陷（`#` 行抛 ValueError、None 抛 TypeError）在一轮内各自被独立修复。

test 切分重新设计成**泛化探针**——训练里只见过 `$` 的 case 用 `€` 单元格考、只见过行首注释的 case 用行尾注释考、文档 case 用另一种问法问同一知识点——第二次跑：

| case | val S0 → best | **泛化探针 S0 → best** | 轮数 | 接受 | 费用 | 耗时 |
|---|---|---|---|---|---|---|
| code-currency | 0.500 → 1.000 | 0.000 → **1.000** | 2 | 2 | $0.08 | 119s |
| code-two-defects | 0.000 → 1.000 | 0.000 → **1.000** | 2 | 3 | $0.09 | 117s |
| doc-missing-info | 0.142 → 0.742 | 0.025 → **0.985** | 2 | 2 | $0.73 | 265s |
| doc-wrong-statements | 0.642 → 0.967 | 0.000 → **0.985** | 2 | 1 | $0.47 | 173s |
| **均值** | **+0.606** | **+0.986** | | **4/4** | **$1.37** | 11.3 min |

四个探针全部从 0 到 ≈1：修 `$` 的补丁顺手覆盖了 `€`（模型写的是通用的货币符号剥离），修行首注释的补丁覆盖了行尾注释，文档修好之后换一种问法也能答对。doc-missing-info 的 val 两次跑分别是 0.973 和 0.742——同一 case、同一配置，差 0.23，这就是 7.1 量出的那种噪声叠加在 2 轮 × 3 条 val 任务上的样子；探针一致（0.985）反而更可信。表格存于 `examples/bench/RESULTS.md`。

**这一轮的总账**：三个默认关闭的机制都在真实模型上跑过了——合成在两次修正后能产出有效任务（产出率低）；反事实消融识别不了"写错但可改对"的段落、只识别"没有更好"的段落，且需要复现确认才不误判，性价比不如文档单独计量，保持默认关闭；退休按设计工作但这个 fixture 里没有可退休的行。判官重复采样把噪声减半、把系统性高估修正了 0.08，费用 2.7 倍。四个种入缺陷 case 4/4 改进，泛化探针均值 +0.986，$1.37。

## 8. 第四轮：配对判官、跨函数 G1、影响图、第二个 skill 与消融

### 8.1 配对比较式判官（`--pairwise-judge`）

7.1 量出的判官噪声有一半来自"绝对打分"这件事本身：同一个回答判官会给 0.95 也会给 0.365。让判官做它真正擅长的事——把候选与**上一个被接受状态**对同一任务的回答并排放在一起，二选一——并且每对问两次、交换位置，两次不一致就算平局（抵消首位偏好）。G7 变成对 val 任务的**符号检验**：赢的任务数减输的任务数 ≥ 1 才接受；exact/rule 任务不进判官（通过 vs 失败直接分胜负）。`expensive.pairwise_judge / pairwise_gate`，trainer 在 `pairwise_judge=True` 且 runner 非 pytest 且 val 有 rubric 任务时启用；报告里同时记录绝对分以便对照。实测见 8.5。

### 8.2 跨函数 G1（`analysis._prepass_returns`）

原来的别名追踪不跨函数：`def get(): return os.system` 之后 `get()(cmd)` 看不见。现在先对模块做一遍预扫描，记录返回值可解析为危险可调用对象的函数，调用点 `helper()` 直接解析为它返回的东西。`re.sub` 这类无害返回不受影响。仍然不做的：跨模块返回值、经过容器/属性中转的可调用对象。

### 8.3 静态影响图（`impact.py`）

G6 重放原本对活跃集里的每个任务都跑一遍。对 pytest 任务，一个候选改了哪些符号是已知的（`bundle_symbols`），测试调了哪些符号也是已知的（`test_targets`），符号之间谁调谁可以从 AST 建调用图并做传递闭包——三者相交就是这个候选**可能**影响的任务集；其余任务不重放。agent 任务没有静态映射，永远重放；调用图里出现无法解析的调用（star import、动态分发）时保守地视为触达一切；整模块改写视为触达该模块所有函数。轮末的全量复查不变，所以漏掉的回归仍会在轮级被拦。

### 8.4 第二个示例 skill：`examples/textnorm`

`slugify / dedupe_lines / word_count` 三个纯函数，6 个可见测试、3 个留出测试、契约三个入口都 stable 并带 doc anchor。三个基准 case：`tn-slugify`（一个函数两处错误结果）、`tn-dedupe-count`（两个函数同时有缺陷）、`tn-doc-wrong`（文档两处与代码矛盾，探针把两处错误合在一个问题里问）。基准从 4 个 case 扩到 7 个，且不再只有一个领域。

### 8.5 实测

**消融（4 个 pytest case × 4 种配置，`claude -p`，2 轮，每格 n=1）**

| 配置 | val Δ 均值 | **泛化探针 Δ 均值** | 改进 | 总费用 |
|---|---|---|---|---|
| full（best-of-K + refine + dedup） | +0.750 | **+0.750** | 4/4 | $0.29 |
| first-wins（先过先赢） | +0.750 | +0.500 | 4/4 | $0.27 |
| no-refine | +0.750 | +0.500 | 4/4 | $0.22 |
| no-dedup | +0.750 | +0.750 | 4/4 | $0.24 |

四种配置在 val 上不可区分——种入的缺陷对 haiku 来说都是一轮就能修好的——差别只出现在探针上：`code-currency` 里 full 与 no-dedup 选出的补丁把 `$` 的修复推广到了 `€`，first-wins 与 no-refine 选出的没有。这与 best-of-K 的设计动机一致（同簇多个可行候选里选最小 diff、最高重放分的那个），但每格只跑了一次，haiku 采样本身有随机性，只能说方向一致，不能说显著。`tn-slugify` 的探针四种配置全 0：探针期望 `Über straße → uber-strae`（参考实现用 NFKD + ascii-ignore，ß 被丢掉），而模型写的折叠把 ß 映成 ss 得到 `uber-strasse`——模型的选择其实更合理，是探针写得过于绑定参考实现。探针设计本身也要被测。

**文档 case（full 配置）**

| case | val S0 → best | 泛化探针 S0 → best | 费用 |
|---|---|---|---|
| doc-missing-info | 0.128 → 0.500 | 0.075 → 0.960 | $0.54 |
| doc-wrong-statements | 0.653 → 0.967 | 0.000 → 0.975 | $0.49 |
| tn-doc-wrong（第一次） | 0.325 → **0.325** | 0.000 → 0.000 | $0.69 |
| tn-doc-wrong（修 ledger 后） | 0.335 → 0.765 | 0.000 → 0.975 | $0.45 |

`tn-doc-wrong` 第一次**零改进**，虽然两轮都产出了把 val 从 0.33 拉到 0.97 的文档 bundle（`doc_val_delta` +0.65）——两轮都被 **G8 拒掉，工作副本回滚**。违规项是 `LAST`：ledger 的"常量"模式 `[A-Z][A-Z0-9_]{3,}` 把文档里强调用的大写单词 "keeping the **LAST** occurrence" 当成了必须保留的常量，而修正恰恰是把 LAST 改成 FIRST。ledger 在保护一个错误值不被纠正。两处修法：常量模式改为必须含下划线或数字（`MAX_PAGES`、`HTTP2` 仍命中，`LAST/NEVER/ALWAYS` 不再命中）；以及一条有据可依的退休规则——文档 bundle 经单独计量确认改进（超过噪声阈值）后，它移除的 ledger 值标记 `retired_by=<bundle>`，不再算违规，留审计痕迹。修后重跑：val 0.335 → 0.765，探针 0 → 0.975，G8 通过。这是第三个只有真实模型 + 真实文档才暴露的慢环问题（前两个：追加而非替换、反思器看不到 references）。

**配对判官（`--pairwise-judge`，tn-doc-wrong）**

第 1 轮：候选 vs S0 的回答，3 条 val 任务 **2 胜 0 负 1 平**（w4v 平局——`word_count` 的文档本来就没错，两个回答等价），符号检验接受；同时记录的绝对分 0.717；探针 0 → 0.975；$0.60。第 2 轮无信号提前停止。修 ledger 之前的那次运行也已经给出 3 胜 0 负 / 2 胜 0 负 1 平 的一致判定，只是被 G8 拦下。与绝对打分相比，配对判官在这个 fixture 上没有出现 7.1 那种同一回答得分相差 0.6 的情况，每对问两次的成本与 `--judge-samples 2` 相当。

**本轮总账**：基准从 4 个 case（一个领域）扩到 7 个（两个领域），全部配置下 pytest case 4/4 改进，文档 case 修 ledger 后 3/3 改进，泛化探针除 `tn-slugify`（探针自身过于绑定实现）外全部 0 → ≥0.96。消融显示 best-of-K 与 refine 的收益体现在泛化探针而非 val 上（n=1，方向性结论）。

## 9. 第五轮：多种子重复消融、跨模块 G1、真实转录的 harvest

### 9.1 `whet bench --repeat N --jobs N` 与 `no_llm` 的改动

8.5 的消融每格只跑了一次，结论只能是"方向一致"。`run_bench` 现在接受 `repeat`（每个 case × 配置跑 N 次，scratch 目录带 `-rN` 后缀）和 `jobs`（线程池并行；每个任务通过 `make_roles()` 自建 backend 对象，不共享 cost 计数），`markdown()` 在重复时多一列 `rep`，汇总表的 "mean Δ test" 后面附上**跨重复的极差**（各重复均值的 max − min）。

并行跑出了一个真问题：`no_llm` 除了 contextvar 之外还维护着一份进程全局的"禁用区"列表，本意是兜底没有拷贝 context 的线程（C18）。四个训练在同一进程里并行时，任何一个进入门控区就把其他三个的提议器一并封死，`ForbiddenLLMCall` 满天飞。全局列表删掉，`no_llm` 只剩 contextvar；包内每个 `ThreadPoolExecutor` 都用 `contextvars.copy_context()` 派发（`propose/doc.py` 的反思器补上了这一条），C18 的回归测试改为同时断言"拷贝了 context 的线程被拦、无关线程不被拦"。门控不该创建线程，所以不需要全局兜底。

### 9.2 跨模块 G1（`analysis.returned_callables` + `analyze_source(imported_returns=…)`）

8.2 的跨函数预扫描只在模块内生效：`scripts/helpers.py` 里 `def runner(): return os.system`，`scripts/main.py` 里 `from scripts.helpers import runner; runner()(cmd)` 仍然看不见。G1 现在先对 skill 的全部脚本各做一遍 `returned_callables`，得到"模块 → {函数名: 危险可调用对象}"，再按每个模块的 `from scripts.x import name`（含 `as` 别名）把表映射到本地名，交给 `analyze_source` 作为预扫描的种子。`import scripts.x as x; x.runner()(cmd)` 这种属性式调用仍不覆盖，经容器/属性中转的可调用对象也不覆盖——都记在"仍未做"。

### 9.3 第一次在真实转录上跑 harvest

之前 harvest 只在合成的 fixture 上测过。这次对着本机 `~/.claude/projects` 跑（就是本次开发会话自己的转录）：

- `--dry-run`：找到 1 个会话，11 条人类轮次。系统注入的元信息轮（"Continue from where you left off"、压缩摘要、中断标记）被正确过滤，没有混进用户意图。
- 脱敏：原始转录里有不少 secret 形状的字符串（`sk-` 10 处、`AKIA` 4 处、bearer 8 处、`key=` 75 处）——全部出现在**工具结果**里（是我们自己的测试 fixture 与审计文本），而 harvest 只对人类轮次和助手回复做摘要，摘要里 0 命中、0 次替换。这是一个没被以前的 fixture 覆盖到的路径：真实转录的大头是工具输出，脱敏器应该也对工具输出生效，但摘要器根本不看它们，所以这次没有风险；若将来摘要扩展到工具输出，redaction 必须跟着扩。
- `mine`（sonnet）：3 个可检查任务（1 val、2 train），全部 rubric 型并带规则检查（`min_chars`、`no_refusal`、`contains`），`dropped_uncheckable=0`、`shape_only=0`。11 轮里只产出 3 个任务是合理的——其余轮次是"继续"之类没有独立意图的追问。

也就是说 harvest 端到端能跑通，但这个样本太小、也太自指（任务问的是"这个系统的输入是什么"），说明不了在别人的项目上会挖出什么样的任务。要评估它，需要一个不是自己开发会话的项目。

### 9.4 多种子重复消融：n=1 的结论没有复现，且暴露了排序键的一个方向性错误

4 个 pytest case × 4 种配置 × **3 次重复** = 48 次训练，4 路并行，`claude -p`，2 轮，总计 $3.56 / 24 分钟。

| 配置 | 运行数 | val Δ 均值 | **泛化探针 Δ 均值（跨重复极差）** | 改进 | 费用 |
|---|---|---|---|---|---|
| full | 12 | +0.750 | **+0.750 ± 0.000** | 12/12 | $0.88 |
| first-wins | 12 | +0.750 | +0.667 ± 0.250 | 12/12 | $0.93 |
| no-refine | 12 | +0.750 | **+0.750 ± 0.000** | 12/12 | $0.85 |
| no-dedup | 12 | +0.750 | +0.500 ± 0.000 | 12/12 | $0.90 |

对照 8.5 的 n=1（full/no-dedup +0.75，first-wins/no-refine +0.50）：**两个配置的排名反了**。no-refine 从 +0.50 变成 +0.75，no-dedup 从 +0.75 变成 +0.50。8.5 里"best-of-K 与 refine 的收益体现在探针上"这个结论**不成立**——它是 n=1 的抽样噪声。这正是当时写"方向性结论，不能说显著"的原因，现在把它明确划掉。

n=3 唯一稳定的信号来自逐 case 拆开看。`code-currency` 的探针（把 `$` 的修复推广到 `€`）：full 3/3、no-refine 3/3、first-wins 1/3、no-dedup 0/3；把每次胜出的补丁抓出来看，结论是**完全确定性**的——

```
full      r1/r2/r3   re.sub(r'[$€£¥]', '', raw)      → 探针 1,1,1
no-refine r1/r2/r3   re.sub(r'[$€£¥₹]', '', raw)     → 探针 1,1,1
first-wins r1  [\s$]+ ／ r2 [$€£¥] ／ r3 .strip(" $") → 探针 0,1,0
no-dedup  r1/r2/r3   re.sub(r"[\s$]+", " ", raw)     → 探针 0,0,0
```

探针分数不是配置的函数，而是**胜出补丁写没写通用字符类**的函数。而胜出补丁由排序键决定，wiki 里记着每次的排名：

```
r1 viable, not selected: 1c2d3506 rank=(1, 2.5, 0.0, -2)  (chosen 2f58250f rank=(1, 2.5, 0.0, -1))
r1 viable, not selected: 8e40ae32 rank=(1, 2.5, 0.0, -9)  (chosen 2f58250f rank=(1, 2.5, 0.0, -1))
```

三个候选在 `(修复任务数, 重放均分, 变异分)` 上**完全打平**——它们修的是同一个失败测试，可见测试与留出测试全绿，变异测试在基准里没开（恒为 0.0）。于是唯一的判别项是最后一位：**diff 最小者胜**。`re.sub(r"[\s$]+", " ", raw)` 是一行换一行，永远比多加一行字符类剥离的写法小。

**这是一个设计层面的发现，不是 bug 复现**：当所有可见信号都打平时，排序键退化为"最小改动"，而**最小性与泛化性是反相关的**。系统在按设计做正确的事（SkillOpt 的最小编辑原则、防膨胀），却系统性地选走了不泛化的那一个。no-dedup 3/3 都选中最小写法只是因为它多门控了几个候选、更容易采到那个最短的完成——不是 dedup 本身有害。

**修法：让"通用情况"变成快环可见的信号，而不是去偏好更大的 diff**（那等于放开膨胀闸门）。契约里新增一种可执行检查 `example`：

```yaml
- id: normalize_cell
  checks:
  - example: {args: ["  € 12 "], returns: "12"}
```

生成到 `tests/contract/`（G3 执行，不在优化器可编辑面内），维护者写下一条训练任务没覆盖的、被文档声明过的行为，它就成了零模型开销的门控信号。配套三处改动：

1. **G3 的契约检查改为相对基线判定**，与 G4/G5 同一条规则。否则一条基线本来就红的 `example` 会把整个循环锁死——没有任何提议器以契约检查为目标（P2 只从失败任务聚类），于是所有候选、包括修别的簇的候选，全被这一条拦住。改后：本来就红的仍红只报 warning，绿转红才是 error。
2. **修复的契约检查计入排序键**，位置在"修复任务数"之后、"重放均分"之前：`(repaired, contract_fixed, replay, mutation, -diff)`。修好一条被声明的行为，胜过省下几行 diff。
3. 基线状态收集加上 `tests/contract/`，并在收集前重新生成一次——否则上次运行后新加进契约的检查会在每个候选上都显示为"新坏的"。

回归测试三条（`tests/test_effectiveness.py`）：`example` 检查渲染成等值断言且畸形检查会响亮失败；基线已红的契约检查不拦无关候选（同时断言不传基线时仍是绝对判定）；**两个候选修同一个失败任务、小的那个保留 `lstrip("$")`、大的那个剥离任意货币符号时，大的赢**——这正是上面 48 次运行里输掉的那一场。

仍然没解决的：没有提议器以契约检查为目标。一条基线就红、又没有任何训练任务覆盖的 `example`，只会在有人为别的原因提出候选时充当判别项，不会自己被修。要闭环需要把失败的契约检查也当作缺陷聚类喂给 P2——留作下一步。

### 9.5 修法的实测（以及第一次实测为什么量到了个寂寞）

新增基准 case `code-currency-contract`：与 `code-currency` 完全相同的种入缺陷，唯一区别是契约里多了一条 `example: {args: ["  £ 40 "], returns: "40"}`。探针仍然是从未训练过的 `€`，与契约里的 `£` 是不同输入。4 配置 × 3 重复。

**第一次跑，结果几乎没变**（探针 8/12 vs 原案 7/12）。查 wiki 的排名日志，排序键第二位**全是 0**——契约检查一次都没参与过判别。原因是一个此前没被任何测试覆盖的 bug：

`bootstrap_contract` 用 `Contract(version=1, allowed_imports=allow)` 这个**空契约**当 base 去调 `derive_contract`。于是 `existing` 是空的，每一个入口点都被当成"新发现"，手写 CONTRACT.yaml 的**语义半边整个被丢掉**——postconditions、doc_anchor、stability（`stable` 被重置成 `experimental`）、checks，全没了。而"语义字段逐字保留、只有 signature 从 AST 覆写"正是 `derive_contract` 文档里写着的不变量，也是整个 G3 存在的前提。`derive_contract` 自己是对的，是 `bootstrap` 递给它的 base 错了。

这条 bug 的代价刚好可以量化：**它让一整轮基准（12 次训练、$0.70）什么都没测到**，因为被测的机制根本没进到运行里。它能活到现在，是因为所有测试 fixture 都是"先建源码、再 bootstrap 生成契约"，从来没有过"skill 自带手写契约"这条路径——而那恰恰是真实 skill 的常态。修法一行：base 改成 `load_contract(skill_dir)`，allowlist 与观测到的 stdlib 求并集。回归测试：`test_bootstrap_preserves_an_authored_contract`。

**修完重跑，机制生效**：

| 配置 | 无契约示例（`code-currency`） | 有契约示例（`code-currency-contract`） |
|---|---|---|
| full | 3/3 | **3/3** |
| no-refine | 3/3 | **3/3** |
| first-wins | 1/3 | 2/3 |
| no-dedup | **0/3** | **3/3** |
| 合计 | 7/12 | **11/12** |

（表内为泛化探针 0 → 1 的次数；两栏各 12 次运行，val 两栏都是 12/12 改进，第二栏 $0.70。）

排名日志里能直接看到判别发生：

```
r1 viable, not selected: 63b8c90406c0d30d rank=(1, 0, 2.5, 0.0, -2)
                 chosen: 144b3bf6079e08cc rank=(1, 1, 2.5, 0.0, -5)
```

修同一个失败任务、diff 小一半（-2 vs -5）的候选输给了修好契约示例的那个——这正是原来那 48 次运行里 no-dedup 三次三次输掉的同一场比赛。

唯一的例外是 `first-wins` 2/3：这个配置**关掉的就是排序本身**（第一个通过门控的候选直接落地），排序键里加什么都无从生效。机制只在"有得选"的时候起作用，这个例外恰好是它工作原理的反证。顺带一提，这也是 best-of-K 第一次拿到有机制可循的证据——不是靠聚合分数的差，而是靠日志里看得见的那一次判别；n=3 仍然不足以下显著性结论。

**代价**：契约示例要人写。这不是自动化的倒退——它是把"这个函数到底该干什么"从文档里的一句话变成一条可执行断言，而这件事只有维护者知道。系统能做的是让这条断言零成本地进入门控与排序，并在它一开始就是红的时候不把循环锁死。

**这一轮的总账**：多种子重复推翻了上一轮 n=1 的消融排名（诚实地说：那张表当时就不该被当成结论），并顺着"探针为什么是 0"一路挖到排序键的最小性偏好与泛化性反相关这个真正的原因；修法是把被声明的行为变成可执行的契约检查（探针 7/12 → 11/12），而不是调权重。过程中撞出一个能让整轮实验白跑的 bug——`bootstrap` 丢弃手写契约的语义半边——它本身就是"没有真实形态的 fixture 就测不出真实的 bug"的又一个例子。跨模块 G1 补上返回值追踪；harvest 第一次在真实转录上端到端跑通。四轮以来的模式很稳定：**每一次真实模型 + 真实形态的输入，都会撞出一个 mock 后端永远不会暴露的问题**。
