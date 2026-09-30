# skillwhet 部署说明

skill 打磨器（SkillWhet · 砺）。**0.5.2（hl）：采纳不再把 `import.json`（受管记录）写回副本（采纳 A → 发布 → 采纳 B 的发布链路原来会死在 NO_IMPORT_RECORD）；作业刚创建就取消不再照跑（取消全程持锁，Popen 后先登记再复核）；`--target-model` 的 rollout 费用计入预算；受管记录的权威份移到工作树外 `<home>/records/<名>.json`（用 `<home>/records/.key` 里的随机密钥签名，0600、首次启动生成、与口令无关——Prism 没配口令时每次启动都会换口令；密钥丢了按工作树外的权威记录重签并在日志里告警；同一系统用户下副本代码理论上读得到这个文件，签名防的是绕过 serve 的随手篡改，不是隔离边界），`import.json` 只是镜像；每次体检 / 作业结束、serve 启动与停机时以 serve 的记录为准校正所有副本（被改过的记进 `warnings`），serve 自己在作业期间的写入（发布 rebase、从技能库更新）不会被改回；旧 home 首次启动自动迁移；bandit / ruff / pyright 优先以 `<当前解释器> -m` 调用（pip --user 装、脚本不在 PATH 也能用）；移除副本时任务集一起进 `_removed/`，总览只算托管中的；CSV 可选列留空当缺省；批文件名带微秒 + 序号（同秒两批不再后批失效）；harvest 脱敏补 URL 内嵌凭据 / 4 字以上口令 / 中文键名 / 全角冒号，反馈叠加层落盘前脱敏；缺 pytest / ruff / bandit 时对应门记 SKIP、整体 `passed=false` 并给装法（**生产 pip --user 装完请确认 `python3 -c 'import pytest'`、`ruff`、`bandit` 都在**）；有活跃作业时 bootstrap / DELETE 回 409 `JOB_ACTIVE`；排队中取消的作业 `cost_usd=0`；`allow` 校验模块名；坏查询参数回 400；未托管 skill 的 `POST /tasks` 回 404；SIGTERM 停 serve 时运行中作业记 `interrupted`；未被接受的 staging 只留最近 3 份；`whet-claude-*` 临时目录用完即删；serve 进程 umask 0077（home 下文件 0600 / 目录 0700）；同 skill 并发体检合并成一次。0.5.1（hf2）：费用上限在一轮之内也检查——花到上限后不再开新的提议 / 合成 / 补测试 / 反事实 / 慢环 / 轮间总结，已经该做的验证（整轮复查、G7）照做，然后按 `budget` 停；进度里多一条 `budget_reached`（跳过了什么、已花多少）。原来只在一轮结束时检查，一轮跑下来会超出不少（实测 $2 上限花到 $2.99）。0.5.0（he）：`train --resume`——每轮结束存 `.evo/checkpoint.json`，中断后从最后一个完成的轮次接着跑（不重测 S₀、被打断的那一轮丢弃重来；任务集 / 副本 / S₀ / 训练配置 / runner / 模型任一变了就退回重新开始，并在进度里说明原因；训练跑完即删 checkpoint；续跑作业的 `done.cost_usd` 只算这次，`total_cost_usd` 是整次训练）；作业参数新增 `resume`；`GET /skills/<n>/checkpoint`、`GET /tasks/new?skill=&since=`（夜训门槛：某时刻以来新进库的可判分任务数）；经验 Wiki 的每条经验有状态（假设 / 已证实 / 有争议 / 已退休）、范围、反例、修订号，G7 接受的一轮在同一位置改对了就给"改这里会坏行为"的经验记反例，下一轮纵向比较退步的给"这样改有效"的经验记反例，连续 5 次训练没再出现的退休、不再进提议提示；`GET /skills/<n>/wiki` 多回 `index`。0.4.2（hd）：staging 生成时把被改文件的原样存进 `staging/<id>/base/`，采纳 / 发布之后照样能看这份 staging 改了什么（老的已采纳 staging 用 `backup/` 当底）；发布 / 回滚记进 `<home>/publishes/<skill>.jsonl`（谁、哪份 staging、何时），`GET /skills/<n>/publishes` 读；训练进度加细粒度事件 `step` / `step_end`（每一步起止、耗时、累计调用与费用）、`task`（每条任务过没过、没过的原因）、`proposing` / `proposals` / `candidate` / `selected`（要了几个修改、每个候选死在哪道门、最后采用哪个）。0.4.1（hb，测试环境实测修的）：G0 / G1 查包里所有 `.py`（`snippets/`、`lib/`、根目录、tests/ 一起，不只 `scripts/`）；候选在 G1 / G2 上只判新增问题（父版本已有的 bandit / ruff / pyright 问题按指纹抵消）；技能库来源 bootstrap 时把 S₀ 现有 import 冻进 allowed_imports，标准库默认全放行、只拦进程 / 网络 / 动态加载 / 反序列化那一类；harvest 只挖用过该 skill（或有投给它的票）的会话、丢掉 Prism 附带的隐藏说明；回滚后不再误报 drift；采纳较早一份 staging 后也能发布；台账只收 SKILL.md 与 references/ 里的值。0.4.0（ha）：从会话挖任务（`harvest --feedback/--sessions`、serve 的 harvest 作业）、
任务家族（同一会话挖出的任务永远同一个 split）、G8 泄漏检查、**release-once**（test 只在 `release-eval` 看一次，采纳默认要求评过）。0.3.1：修沙箱把 HOME 指到副本后 Python user site 跟着丢、非 root 用 `--user` 装的 pytest 找不到的问题（`PYTHONUSERBASE` 钉住真 user base）。0.3.0（gz）：`whet serve` 加训练作业层 —— `/jobs`（单 worker FIFO 队列、进度 JSONL、取消 / 重启标记）、
`/skills/<n>/staging*`（列表 / 详情 + 逐文件 diff / 采纳 / 导出 tar.gz）、`/tasks/derive`（从 tests/ 派生任务）、`/skills/<n>/rebase`；
`train` 加 `--progress / --max-cost-usd / --max-minutes / --no-accept-rounds`。0.2.2：修 G4/G5 被野 `scripts` 包遮蔽（`pytest_bind.py`）。0.2.1 起有常驻形态 `whet serve`；CLI 照旧可用。**

- 线上路径：`~/prism/skillwhet/`
- 只用 CLI：装完不需要重启 Prism；**接了 Prism（`PRISM_SKILLWHET_AUTOSTART=1`）：装完必须 `bash prism.sh restart`**，serve 进程由 Prism 拉起

## 为什么它在 `services/` 而不是 `skills/` 或 `jobs/`

三条都不完全对得上，选 `services/` 是**按它将来的部署目标**落位的：

- 不是 `skills/`：它不被 `~/.claude/skills/` 装载。它的 `examples/*/SKILL.md` 是**测试夹具**，
  放进 `skills/` 会长出一批看起来像真 skill 的假目录。
- 不是 `jobs/`：`jobs/` 一个目录 = 一条固定业务流程；这是个可复用工具链，输入是任意 skill 包。
- 是 `services/`：融入 Prism 之后它就是 ma-api 的形状 —— 回环 Python 进程、`/api/whet/*`
  经 8080 反代、随 Prism 起停。届时这一节和上面的「不需要重启」一起改。

**训练对象在隔壁**：`../../skills/<name>/`。训练器与被训 skill 同仓同版本，这是有意的。

## 装

```bash
tar xzf skillwhet-src-<日期>.tar.gz -C ~/prism/
cd ~/prism/skillwhet
pip install -e ".[gates,test]"          # Ubuntu 24.04（PEP 668）要加 --break-system-packages；不用 venv 也行
python3 -m pytest -q                    # 233 条离线测试，全过才算装好
whet probe --model haiku       # 后端连通性 + JSON schema 自检（约 $0.04）
```

## `whet serve`（接 Prism 用）

```bash
SKILLWHET_TOKEN=<与 Prism .env 里 PRISM_SKILLWHET_TOKEN 相同> \
  whet serve --host 127.0.0.1 --port 8093 --home ~/.prism/skillwhet
curl -s http://127.0.0.1:8093/healthz          # 唯一不用 token 的路由；看 tools 里哪几样是 false
```

- 只绑回环；其余路由都要 `X-SkillWhet-Token` 头。
- `--home` 下：`work/<skill>/`（受管副本，`.evo/` 长在这里）· `tasks/<skill>/`（任务集）· `jobs/`（第二期）· `tmp/prism-skillwhet/`（TMPDIR，
  子进程与 `claude -p` 的临时目录全落这儿，Prism 按目录名忽略，不会长出幽灵项目）· `_removed/`（移除的副本，不删只挪）。
- 正常情况下不用手起：Prism 的 `PRISM_SKILLWHET_AUTOSTART=1` 会拉起它、并把日志并进 `prism.log`。手起只用于排查。
- 第一期路由：`/skills`（列表 / import / upload / bootstrap / gate / facts / contract / status / wiki / provenance / ledger / drift / DELETE）、
  `/tasks`（validate / 入库 / 列表）。
- 第二期（0.3.0）路由：`POST/GET /jobs`、`GET /jobs/<id>`、`/jobs/<id>/progress?after=<seq>`、`/jobs/<id>/log?tail=`、`POST /jobs/<id>/cancel`；
  `GET /skills/<n>/staging`、`GET /skills/<n>/staging/<sid>`（manifest / report / 逐文件 unified diff）、`POST .../adopt`、`GET .../export`（tar.gz）；
  `POST /tasks/derive`；`POST /skills/<n>/rebase`（body 可带 `event: publish|rollback`、`by`、`to`、`mode`，带了就记一笔发布记录）；`GET /skills/<n>/publishes`（0.4.2）。
- 第三期（0.4.0）：`POST /jobs` 多了 `kind`（`train` / `harvest` / `release_eval`）；`GET /jobs/<id>/result`（harvest 的预览：会话摘要 + 挖出的任务）、
  `POST /jobs/<id>/import`（把 harvest 结果里勾选的 task_ids 入库，**一个作业只能入一次**）；staging 摘要多 `release`（权威记录在
  `--home/releases/<skill>/<sid>.json`，不看 staging 里的 `release.json`）与 `contract`（base / candidate bundle 哈希、protocol 哈希）；
  `POST .../adopt` 多 `skip_release`（与 `force` 互不连带）。
- **harvest 作业**：只读白名单里的 transcript（`sessions` 必填，Prism 按「当前用户可见 + 所选项目 + 时间窗」生成；文件名 = provider 会话 id），
  transcript 目录取 `SKILLWHET_TRANSCRIPTS`，没设就是 serve 用户的 `~/.claude/projects`。`feedback_overlay` 是 Prism 的投票叠加层
  （按原生 uuid 对到 assistant 记录；Prism 侧已脱敏、限长，≤ 20 MiB）。有投票的回答优先出**任务家族**：期望结果 ≤ 200 字且未截断未脱敏 → exact，
  否则 rubric；outcome 标 `outcome:voted`（投票）或 `outcome:guessed`（模型猜）。`dry_run` 只列会话、零模型调用。
- **release-once**：训练默认**不碰 test split**（`--eval-test` 才评，Prism 不开）。`whet release-eval <copy> --staging <sid>` 对这份 staging
  评一次 test：先 `O_EXCL` 抢 `release.claim` 再跑，同一份 staging 第二次 → `TEST_CONSUMED`(3)；已采纳 → `ALREADY_ADOPTED`(5)；没有 test → `NO_TEST_TASKS`(4)。
  结果带 `test_set_hash`、`looks_on_test_set`（同一 test 集被看过几次，只展示不拦）、`candidate_bundle_hash`、`baseline_matches_staging`。
  `whet adopt` 默认要求评过且 candidate 哈希对得上；跳过要显式 `--no-release`（Prism 上是「仍要采纳」二次确认）。
- **G8 泄漏检查**（训练时默认开，`--no-leak-check` 关）：候选 SKILL.md / scripts 里出现 val / test 任务原文的长 n-gram（带特征数字 5-gram，
  否则 12-gram，已扣掉 S₀ 本来就有的）→ `leak_suspect` 违规，候选不被接受。**已知缺口**：slow_update 的指导文本不过这道检查（REVIEW S4）。
- 作业怎么跑：serve 里一个 worker 线程按 id 顺序取队列，`python -m skillwhet train <work/skill> --tasks <tasks/skill/all.json> --progress <jobs/<id>/progress.jsonl> …`
  作为**独立进程组**起（`start_new_session`），stdout 进 `jobs/<id>/stdout.log`；取消 = SIGTERM → 4 s → SIGKILL 整个进程组；
  serve 重启时把还在 running 的作业标成 `interrupted`（并顺手收掉还活着的训练进程组），不自动重跑。
  同一 skill 同时只允许一个活作业（`JOB_DUPLICATE` 409）。参数走白名单（`jobs.ARG_SPEC`），后端 / 模型名只认字母数字。
- 平台侧停机：`--max-cost-usd`、`--max-minutes`、`--no-accept-rounds` 在**每轮结束**检查，`stop_reason` 记进 report 与 `done` 事件；
  worker 另有墙钟兜底（`max_minutes × 1.5 + 5 min`），超了 kill 并标 failed。
- **安全边界（要读）**：训练与体检（G4 / G5）会真的执行副本里的 `scripts/` 与 `tests/`。沙箱只做 **网络隔离（`unshare -n`）+ rlimit + HOME 指向副本目录**，
  **没有文件系统隔离** —— 副本里的代码以 serve 进程用户身份跑，能读写这个用户能读写的一切。所以：
  1. serve 跟 Prism 用同一个专用低权限用户跑（不要 root），`~/.claude/skills`、`~/.prism` 之外别放敏感东西；
  2. Prism 侧只让 **上传者本人或 root** 对副本做会执行代码的动作（体检 / 派生 / 训练），非 root 还要先过 G1 安全门（bandit）；
  3. 不信任的用户就别给 Prism 账号 —— 上传即可执行代码，这是设计前提，不是漏洞。
  想要真正的隔离：`unshare -m`（需要 `kernel.apparmor_restrict_unprivileged_userns=0`）或 bwrap —— 0.4.0 **仍未做**，信任边界不变。
  harvest 作业不执行副本代码，但会读 serve 用户能读到的 transcript（只读白名单里的）；release-eval 会执行副本代码，权限同采纳。

## 包结构约定（hb 实测后补，要读）

- **优化器能改的代码只有 `scripts/**/*.py`**，能改的文档只有 `SKILL.md` 与 `references/*.md`（`edits.CODE_EDIT_ROOTS` / `DOC_EDIT_*`）。
  代码放在别处的 skill（marketing-audit 的 30 个模块在 `snippets/`）只能被训练文档；G2（ruff / pyright）也只查 `scripts/`，没有时 SKIP 并说明。
  G0 语法、G1 安全查的是包里所有 `.py`。
- **G4 与 pytest runner 只认 `tests/unit/`**，G5 只认 `tests/holdout/`。测试平铺在 `tests/` 下的（marketing-audit 就是）G4 会 SKIP 并提示挪进 `tests/unit/`；
  这时 pytest runner 下任务不计分，用 agent runner（花模型费）。
- 这两条是 0.4.x 的设计边界，不是 bug；要支持「代码根可配置」得改编辑面、G2、契约派生三处，另起一期。

## 运行环境要求

| 依赖 | 用途 | 缺了会怎样 |
|---|---|---|
| Python ≥ 3.11 | — | 装不上 |
| `unshare`（Linux） | 沙箱网络隔离 | 降级运行并告警，**代码执行连网络都不隔离**（Ubuntu 24.04 默认 `apparmor_restrict_unprivileged_userns=1` 就是这样，见 Prism 侧部署文档 §2.3） |
| `claude` CLI | 所有模型调用走 `claude -p` | 只能跑 `--fast-backend mock` |
| `ruff` / `bandit` / `pyright` | G1/G2 门 | 对应门降级 |

macOS 上没有 `unshare`，本地只适合跑 mock 后端；**真训练放这台 Linux 机器上跑。**

## 用

```bash
whet bootstrap ../../skills/<name>     # 冻结 S0、派生 CONTRACT.yaml、抓 Preserve Ledger
whet gate      ../../skills/<name> -v  # 免费门金字塔 G0→G5，看当前健康度
whet train     ../../skills/<name> --rounds 2 --tasks tasks.json
whet status    ../../skills/<name>     # 看报告：baseline → candidate、逐条编辑
whet release-eval ../../skills/<name> --staging <sid> --tasks tasks.json   # 留出集只评一次
whet adopt     ../../skills/<name>     # 显式采纳（没做 release-eval 要加 --no-release）
whet harvest   --transcripts ~/.claude/projects --sessions ids.txt --feedback overlay.json --out mined.json   # 从会话挖任务
```

**训练从不写 live 目录**，只动 `.evo/current`；`adopt` 是唯一会落到真 skill 上的动作，
且必须人工敲。这不是可选保障，是设计前提（`auto_adopt: false`）。

## 花钱的地方

`train` 会真的调模型（快环 haiku / 慢环 sonnet / 评估 opus），一次 2 轮的量级在 $0.05–$0.7。
`bench --ablate --repeat 3` 是几十次训练，跑之前先看清 `--jobs`。

## 不进仓库

`.evo/`、`.bench-work/`、`*.egg-info/`、`__pycache__/` —— 已在 `.gitignore`（本目录不额外配）。
