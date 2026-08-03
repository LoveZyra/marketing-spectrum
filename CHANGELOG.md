# Changelog —— 营销诊断 API(方案 C)

> 平台级演进记录。skill 自身的细粒度变更另见 `ma_server/marketing-audit/CHANGELOG.md`。
> fix 包是累积的:装最新一个就等于装了全部。

## fix14 · 2026-08-03

**健壮性收官(此前审查挂账的 P2 全清)**:
`call_claude` 改 Popen + start_new_session,超时 **killpg 杀整个进程组**——agent 的
Bash 孙进程握着 stdout 管道时,旧实现会在 communicate() 里永远等 EOF,worker 线程
卡死、并发额度与活动锁一起漏;现在收尾最多再等 10s,宁可丢部分输出不卡线程。
**服务启动扫描**残留 queued/running 任务判 `E_INTERRUPTED`,轮询方收到明确失败而非
无限 409(B/C 共用 MA_JOBS_DIR 同跑的部署需分开配目录)。**降级横幅**:润色未完成且
无 agent 成品时,发布页 `<body>` 顶部注入置顶警示,半成品不再裸发(rundir 原件不动)。
**`MA_JOB_DEADLINE`**(默认 3600,0=不限):步骤边界检查任务总耗时,超支判
`E_JOB_DEADLINE`,别让调用方陪着熬。

## fix13 · 2026-08-03

**Claude 会话归拢到单一项目**:所有 claude 子进程改用固定工作目录 `MA_LLM_HOME`
(默认 `<部署目录>/llm_sessions`)。此前 agent 每单以 `jobs/<id>/run` 为 cwd,
Claude Code 按 cwd 建项目,Prism 侧边栏每调一次接口就多一个「run」项目;
现在所有会话统一在 `llm_sessions` 一个项目下,transcript 也集中便于复盘。
产物路径不受影响(agent 提示词全为绝对路径,并新增"不要用相对路径"硬约束)。

## fix12 · 2026-08-03

**pull 失败可观测 + 取数脚本写盘加固**(修 hebo 表 `E_PULL_FAILED`):`run_cmd` 失败时
从**全量**输出抠出 `Caused by:` 异常行进 `detail.exceptions` 与任务日志——Spark 栈帧再长
也不丢根因(此前出参尾巴 2000 字全是 ParquetWriteSupport 栈帧,根因一行没有)。
配套 `hdfs-data/scripts/hdfs_get.py`(--where 路径,需单独拷到服务器 skill 目录):
写 parquet 前设 `datetimeRebaseModeInWrite/int96RebaseModeInWrite=LEGACY`
(老 Hive 哨兵日期 0001-01-01 之类,读/count 正常、一写就逐行抛错);
void(全 NULL)类型列写前转 string 并打印列名。

## fix11 · 2026-08-03

**鉴权比较改 bytes + 非 ASCII 口令启动拦截**(修线上 `E_MA_UNREACHABLE/ECONNRESET`):
str 版 `hmac.compare_digest` 撞上任何非 ASCII 字符会抛 TypeError,把连接炸成 RESET ——
口令文件里被抄进中文占位符「你的口令」后,每个带鉴权的请求全灭而 healthz 正常,
网关侧只看到 E_MA_UNREACHABLE。现改为 bytes 比较(永不抛,顶多 401);服务启动与
`restart_prism.sh` 均新增"口令含非 ASCII 直接拒启并提示生成真口令"的闸;
回归新增 3 条钉住"非 ASCII 口令/请求头必须 401 收场"。

## fix10 · 2026-08-03

**两张固定表落定**:特征表 `MA_FEAT_TABLE` 默认改为
`app_dm.tmp_ctj_marketing_audit_features_hebo`(固定表、无分区),过滤列新增
`MA_FILTER_COL`(默认 `activity_id`,老表是 `task_id`——配错不报错、只捞 0 行出空报告,
换表必查);人群池表 `MA_POP_TABLE` 默认改为 `app_dm.long_ctj_marketing_audit_sample`
(圈人 dry-run/计数/push_sql 的 FROM)。链路对两张表均只读。样本表主键列若不叫
`mapid`/`unionid`,用 `MA_ID_COL`/`MA_UNION_COL` 调。

## fix9 · 2026-07-30

**campaign_meta 兜底链重定**(修"报告标题显示活动 ID"):`--meta` 不再造占位符——
skill 的 `--auto-meta` 是"已提供字段不覆盖"的合并,提前塞占位值会把它从数据推真值的路堵死。
现行链条(prepare 之后由 `apply_meta_defaults` 收尾,run.log 记录每个值的来源):
`campaign_name`:入参 → 数据 activity_name → activity_id(兜底时告警);
`campaign_type`:入参 → 数据 activity_channel → 默认「活动」(老默认「社群进群」作废);
`target_products`:入参 → 数据 activity_product_name。

**skill 渲染器修复**(修"业务影响一行碎成列"):`.diag-impact-row` 是 flex 容器,
数字被 `_emph()` 包成 `<b>` 后,裸文本被切成一个个匿名 flex 子项。正文整体包进
`<span class="impact-text">` 恢复正常行内排版。文件:`marketing-audit/snippets/report_renderer.py`,
不在 fix 包里,需单独拷到服务器 skill 目录。

## fix8 · 2026-07-30

**对外契约收窄**:入参只收 `activity_id / date / meta`(campaign_type 挪进 meta),
多余键 400 拒单;`push_source` 挪到服务端 `MA_PUSH_SOURCE`(默认 both),
`pull_partition` 与 `note` 取消(特征表按约定为固定表、无分区,表名 `MA_FEAT_TABLE`,
全链路对表只读)。下单 202 回四字段;`/result` 只回六字段,rules 逐条只有
`name / finding_id / sql_filter / direction`。完整内部账仍在 `jobs/<id>/meta.json`。

**356352 单复盘落地**(那单 2334s、90% 耗时烧在 4 次全超时的模型调用上,
成品被弃用又被覆盖,最终发布骨架句报告):

- Agent 超时被杀先验产物:`state_full.json` 完整且过锚点校验就按成品采纳
  (那单 agent 在 1197.45s 已三道门禁全过、差 2.5 秒被杀);弃用产物挪存
  `*.agent_timeout/failed.json` 留证,润色永远覆盖不了它。
- 超时按后端实测思考延迟重定(线上是思考型模型,单次静默思考实测 358.8s):
  `MA_POLISH_TIMEOUT=600 / MA_POLISH_BUDGET=1800 / MA_AGENT_TIMEOUT=2400`,三值联动。
- 润色首轮即按 `MA_POLISH_BATCH=8` 分小批;提示词砍掉 data_overview 超长明细
  (55K → 单批约 18K 字),每槽数字仍在各自 context。
- 按调用分模型:agent `--model sonnet`,润色/schema/质检/渠道等轻量调用 `--model haiku`
  (`MA_AGENT_MODEL` / `MA_POLISH_MODEL`,空串=网关默认)。
- 可观测:CLI 超时保留已产出的 stdout/stderr;日志与出参带 `timed_out / timeouts`;
  healthz 报 models / push_source / polish_timeout。

## fix7 · 2026-07-29

上公司 ma_server 的整套配套:`preflight_ma_server.py` 环境体检(报告链接指测试机/回环、
发布目录缺失等"接口 200 但链接打不开"的静默错,启动时直接拦);Prism 反代
(`PRISM_MA_API_TARGET`,只认回环、精确路径白名单、剥上游鉴权头)与自启
(`PRISM_MA_API_AUTOSTART`,无 MA_API_KEY 拒绝自启);`run_ma_server.sh` 整轮联调,
端口被占则复用不抢。

## fix6 · 2026-07-29

报告产出 Agent:先给带工具权限的 claude 一次机会端到端用 skill 做定稿
(`--allowedTools` 点名,不开 dangerously),九种守卫任一不满足就安静退回老链路;
交稿过两道校验——findings 一条不能少、圈人锚点(name/sql_filter/estimated_size 等)
被改动按草稿回填。渠道词汇门禁(REWRITE_REQUIRED)只改文案不绕门禁,机械替换兜底。

## fix5 及更早 · 2026-07-28

方向归一化:`direction/direction_raw` 任一命中推送意图(促付/促活/唤醒/召回…)即认作
push 并留痕纠正——修"促付人群被当排除人群丢弃"(fnd_r41);圈人两轴口径定稿
(source 决定圈不圈,direction 决定推不推,push_source 按 finding_id 前缀分);
`_draft` 标记递归清理(修"永远过不了完备性门禁");HTTP 长连接 `_drain_body`
防串包;标签去千分位(修渲染器按标点切标签把数字切半)。B/C 双方案对照实测后定 C 上线。
