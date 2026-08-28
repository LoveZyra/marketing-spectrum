#!/usr/bin/env bash
# 营销诊断 API 服务安装脚本。先备份、再覆盖、最后自检。
# 累积包:装这一个就够了,不用再装之前的 fix / fix2 / … / fix9 / fix10。
# fix25(2026-08-17):报告链接一单一份 —— 不再互相覆盖。
#   现象:同一活动复诊,新报告把上一单原地盖掉。发布文件名一直是
#         diagnosis-report-{activity_id}.html,先前发出去的链接全部改指最新内容
#         (最坏是指到一份带降级横幅的半成品),历史版本再也找不回来。
#   ⓐ 发布文件名改为 diagnosis-report-{activity_id}-{job_id}.html。带 activity_id
#      是给运维看的,job_id 才是唯一性来源。report_url 返回的就是这个唯一链接。
#   ⓑ job_id 从 rundir(<jobs>/<job_id>/run)推,方案 B/C 的 runner 也显式传一份;
#      命令行自测那种非标准 rundir 兜底造「时间戳_6位随机」,同秒并发也不撞。
#   ⓒ 不留 latest 别名:老的 diagnosis-report-{activity_id}.html 不再写入,已经在
#      盘上的照样打得开,只是从此没有任何东西会覆盖它。
#   ⓓ 新增 MA_REPORT_KEEP(默认 20,0=不清理):发布时顺手清掉同一活动的旧报告,
#      只留最近 N 份。只动「本活动 + 文件名尾巴形状对得上」的文件 —— activity_id
#      允许连字符(ACT9 与 ACT9-B 并存),裸 startswith 会误删别人的报告。
#      清理失败只告警,不让整单变红。
#   ⚠ 调用方必读:report_url 不再是可以按 activity_id 拼出来的固定地址,
#      **必须**从 /result 出参里取。拼死链的老代码要改。
# fix24(2026-08-17):target_audiences 收进管控 —— 报告附录里模型人群挂出死链的修复。
#   现象:三个模型分析人群在「可落地人群包」表里同时挂上「↑ #2 回到核心发现」,
#         而核心发现 #2 根本不产出这些人群。
#   根因:回链按人群名去撞 action_plan.priority_actions[].target_audiences,而这一栏
#         不在 SEG_ANCHORS 里、提示词也没提,是 Agent 的自由发挥区。模型 finding 在
#         draft_builder._segment_from_finding 直接 return None,所以它那条行动的草稿
#         写的是 ["全量"];Agent 润色时把这个占位「写实」成了它在 audience_segments
#         里看到的三个模型人群名。
#   ⓐ 新增 restore_action_audiences():target_audiences 按草稿回填(先按 problem_rank
#      配对,配不上按位置;两边条数对不上就整个跳过,不猜)。它是「这条行动打哪批人」
#      的结构指针,不是文案 —— 行动的标题/描述照旧随 Agent 改。
#   ⓑ 回填走独立 warning,**不计入 fixed_anchors** —— 圈人锚点的账不能被稀释。
#   ⓒ 提示词硬约束补一条:不许改 target_audiences,草稿写「全量」就保持「全量」。
#   ⚠ 配套 ma-skill-fix32:回链改为结构匹配(人群 finding_id ∈ 核心发现
#      evidence_finding_ids),Agent 怎么写 target_audiences 都挂不上错链。两层各自
#      独立生效:只装 ma 侧,回链口径没变但源头不再被写歪;只装 skill 侧,回链正确
#      但 target_audiences 仍会飘。建议同批装。
# fix23(2026-08-14):suggestion 前置分档标注 ——
#   【建议推送】模型分析产出的推送人群(= direction create)
#   【建议优化】规则库产出的推送人群
#   【建议排除】非推送人群(内部 exclude)
#   ⓐ 出参 direction 只有 create/alter 两值,而 alter 里混着「规则产出要推的」和
#      「诊断明说别推的」—— 展示时分不出。前缀补上这层,且是机器生成的固定 token,
#      UI 可直接切出来做标签/配色,不依赖润色文案的措辞。
#   ⓑ 幂等且自纠正:已带任一前缀先剥再按当前口径重加,重复投影不会叠成
#      「【建议推送】【建议推送】…」,上游带错前缀也会被纠正。
#   ⓒ 读的是**归一化之后**的 direction:促付人群(direction_raw=促付)已在
#      pick_push_rules 里救回 push,所以是【建议优化】而不是【建议排除】——
#      这是 2026-07-29 那个线上问题的回归点,契约回归有专项断言(64 项)。
#   ⓓ 文案为空时只给前缀,不凭空编业务话术。
#   ⚠ 配套 ma-skill-fix31:模型人群的建议动作从写死的套话改成按主导维度写实
#      (原来三条模型人群三句一模一样「下一周期对该群体做优先级投放或预算倾斜」)。
#      不装 skill 包的话前缀照常有,只是模型人群那句仍是套话。
# fix22(2026-08-14):/result 的 direction 改为**人群包操作类型**(create / alter)——
#   create = 模型分析产出的推送人群(下游新建人群包);
#   alter  = 其余一律(规则库产出的推送人群 + 所有非推送人群,下游改已有人群包)。
#   判定依据 finding_id 前缀:fnd_model_* → create,其余(fnd_r*/fnd_pos_*/未来新前缀)→ alter。
#   ⓐ 只在出参投影层(ma_core.crowd_operation)做映射,**流水线内部仍用 push/exclude** ——
#      push_sql / size.push 的红线过滤、促付救回、notes、报告全依赖 direction=="push",
#      改内部值要牵动十几处还得重写红线断言。映射放投影层,出参怎么变推送口径都不受影响
#      (fix22 的回归里专门复核了这条)。
#   ⓑ 原始 push/exclude 仍在 meta.json 的 crowd_spec.rules[].direction 里,排查照用。
#   ⚠ 调用方必读:exclude 人群现在也标 alter,**alter 里混着"要推的"和"明确别推的"**。
#      不要遍历 rules[] 逐条去推 —— 推送人群以服务端给的 push_sql / size.push 为准
#      (它只含 push)。若必须自己拼,请读 meta.json 的原始 direction。
# fix21(2026-08-14):/result 的 rules[] 改为**带全部 direction**(调用方按方向自行分流)——
#   ⓐ ma_pipeline.pick_push_rules:不再只放行 push,两个方向都进 picked / 出参 rules[]。
#      direction 归一化结果写回字段(促付→push 等),原值留 direction_raw / direction_from_skill。
#   ⓑ ★红线★ 推送口径与出参口径**必须分开算**:push_sql 与 size.push 只用
#      direction=push 的那批(run_pipeline 里的 push_only / _push_only)。exclude 一旦
#      混进去就是 2026-07-28 的原样事故 —— 那单 6 条 audience_segment 里 3 条 exclude,
#      「跨渠道高频疲劳人群」一条覆盖 49477/50000 人,OR 进 push_sql 后出参 49735 人里
#      九成恰恰是诊断说"别推"的。regress_direction 加了 4 条专项断言守这条,含一条
#      反向用例(故意把 exclude 并进去必须被抓到,防哨兵恒真)。
#   ⓒ 不另给 excluded_rules 顶层数组:同一批人出现在两处,调用方并起来会重复计数。
#      crowd_spec.excluded_rules 仍在 meta.json 里,供 notes / 排查用。
#   ⓓ rules[] 六字段结构一字未动(name/finding_id/sql_filter/filter_zh/direction/suggestion),
#      只是条数变多、direction 第一次出现 exclude 值。
#   ⚠ 调用方必读:**不要把 rules[] 整个 OR 起来去推**。要么直接用服务端给的 push_sql
#      (已只含 push),要么自己拼时先按 direction 过滤。老调用方若是"拿到 rules 就全推",
#      升级前必须先改 —— 这是本次唯一的破坏性变更。
# fix20(2026-08-14):crowd_push 去 Spark,改本地 data.parquet 校验(修 8/14 并发炸单)——
#   背景:job_20260814_143039 / 144153 两单 crowd_push 并发下炸(SPARK-2243 抢构造 /
#   setCallSite NoneType 被兄弟单 stop 误杀)。根因是进程内共享 SparkContext 的生命周期,
#   修法不是治 Spark,是**不再用 Spark**:
#   ① ma_pipeline.py:HiveSource 去 Spark —— 校验/计数改在 pull 落地的 data.parquet
#      上用 pandas 做(上游诊断/建模本就跑在这份数据上,同数据同执行器,数才可比);
#      并发问题从根上消失,无需降 MA_MAX_CONCURRENCY。
#   ② 「人群池」概念取消:MA_POP_TABLE / MA_POP_FILTER 作废(POP_TABLE 留作 FEAT_TABLE
#      别名);出参 push_sql 的 FROM 仍是特征表 + activity 过滤,业务方用法不变。
#   ③ 分流:模型人群(fnd_model_*)直通(正确性由 skill 侧叶子 oracle 在源头逐条证明);
#      规则库人群做一致性自检 —— 本地按 scope∩channel 子集复算,数必须等于上游
#      trigger_cnt,不等即剔除+告警(MA_RULE_CHECK=lenient 可临时只警不剔)。
#   ④ 候选规则全部未通过校验时整单 E_NO_VALID_RULES(MA_REQUIRE_RULES=0 可关),
#      不再出 push_sql=None 的"成功"单。
#   ⑤ notes 文案改口径:size.push 是本活动特征数据上的并集去重人数(校验口径),
#      实际推送人数以 push_sql 线上执行为准。
#   ⑥ regress_direction.py:真实数据重放的断言从"写死 fnd_r37/fnd_r11 挡在包外"
#      改为方向不变量(非 push 且非促付的条目不进包、其独有谓词不进 push_sql)——
#      重放优先取服务器最新真实 job,#37 被某单数据判成显著正向(→push)是合法产出,
#      写死 id 会把"数据变了"误报成"代码坏了"(20260814 首装实证,30过/1挂即此)。
#   ⚠ 必须配套装 ma-skill-fix30(叶子 oracle/三形态渲染/sql_to_zh/eval_condition 都在
#      skill 侧),否则:模型人群 pandas 条件仍是老的反解析产物(含分类切分的跑不通,
#      会全部 fail-open 回退 estimated_size)、一致性自检因缺 scope/channel 字段而全部
#      退化为全量口径。两包一起装,顺序无所谓,装完一起重启。
# fix19(2026-08-12):人群规则出参新增中文口径 filter_zh ——
#   ⓐ ma_core.py:/result 的公开投影加第六个字段 filter_zh(该人群筛选条件的中文说法,
#      与报告附录「筛选条件（中文）」同源)。**执行仍以 sql_filter 为准** —— 中文只给人看,
#      翻不动时是空串(不是 null),下游不要拿它做任何判断。
#   ⓑ 投影逻辑抽成 ma_core.public_rules(),新增 regress_contract.py(22 项)守住契约:
#      六个字段一个不多一个不少、顺序固定、skill 侧内部键(pandas_filter/_seg_index/
#      suggestion_source…)一个不许漏。此前这段逻辑埋在 handler 里,加字段全靠人眼盯。
#   ⓒ 值由 skill 侧产出:**必须配套装 ma-skill-fix29**,否则 crowd_rules.json 里没有
#      filter_zh,接口这一列会全是空串(不报错,但也没内容)。
# fix18.1(2026-08-07):上线首单(1012006)复盘补丁 ——
#   ⓐ ma_core.py:/result 的公开投影加第五个字段 suggestion(此前 attach_suggestions
#      回填的值只留在 meta.json,调用方看不到)。suggestion_source 仍留 meta.json。
#   ⓑ ma_pipeline.py:restore_seg_anchors 的人群身份键改为「finding_id + 组内序号」。
#      模型人群的 finding_id 全是 fnd_model_decision_rule,老写法拿 fid 当字典键会让
#      三条人群塌成一条 —— 前两条的 name/sql_filter/estimated_size 被回填成第三条的值,
#      表现为「接口三个人群名各不相同、报告里三行同名」。首单实证,已修。
#   ⓒ 配套 skill(ma-skill-fix20 同批更新):阈值最多 4 位小数(修 fix20 引入的
#      `> 2.50000000000000044409` 回归)。
# fix18(2026-08-05):人群规则出参加 suggestion(建议动作)——
#   ① ma_pipeline.py:出参 crowd_spec.rules[] 与 excluded_rules[] 每条新增
#      suggestion(= 报告「可落地人群包」里与该人群对应的那句建议动作)+ suggestion_source
#      (index/sql/name/default,标记这句话是怎么对上的,便于线上统计走没走兜底)。
#      为什么要在 assemble 前回填而不是在 crowd-rules 那步直接取:crowd_rules.json 是在
#      report_agent/polish **之前**冻结的(锚点先冻结,Agent 不能中途改人群口径),
#      那时 action 还是草稿骨架句「按 finding 建议方向投放/排除/促付。[待润色]」,
#      直接带出去就是占位符。对齐用位置序号做主键(不看人名 —— 人名可能带·变体N、
#      也可能撞名),sql_filter 校验,name 兜底,都落空按方向给兜底话术。
#   ② 配套 skill(ma-skill-fix20,单独包):crowd_rules.json 也带 suggestion 作保底值;
#      模型人群命名按"区分性特征"重写(原来三条规则都叫「深漏斗高潜人群」靠·变体N 区分);
#      top3 选人群时按命中人群 Jaccard 去冗(避免只差一个阈值的近重复规则占掉名额)。
# fix17(2026-08-04):prepare 提速与降级不冻死(1011270 单复盘:pull 修好后瓶颈下移,
#   prepare 对 5.9M×250 全量单跑 28.6min 顶穿 1800s,其中 lightgbm 训练 1058s 占 59%;
#   降级"本地骨架"后又因骨架取列的十几个无日志 Spark 查询把任务冻死在 phase=prepare)——
#   ① 配套 cli.py:模型训练前下采样 —— 正样本全保留、只采样负样本(MA_MODEL_SAMPLE
#      默认 50 万行,0=关;少数类占比异常自动退回等比分层)。只有模型吃采样,统计/漏斗/
#      阈值仍全量;"训练先验被抬高"与采样明细写进 data_caveats 与决策日志。
#   ② ma_pipeline.py:骨架构建加硬上限 MA_STUB_TIMEOUT(默认 900s)+ 逐列心跳日志;
#      超时/异常一律退化为"无列骨架"继续走,降级路径永不冻死。
#   ③ restart_prism.sh(随包更新到 Prism 根目录):export PRISM_ALLOW_QUERY_TOKEN=1
#      (浏览器 WS 只能 ?token= 传凭据,默认关 → WS 鉴权 0 成功,对话/shell 全挂);
#      启动命令加 env -u API_KEY(去掉 pod 继承的模型凭据,防 REST 401)。
# fix16(2026-08-03):合流版 —— 当天两条并行开发线在此合一(此前两条线各自发过"fix14"):
#   A) 健壮性线(另一会话的 fix14):ma_core 超时改杀整个进程组(孙进程拖不死 worker)、
#      启动扫描残留任务判 E_INTERRUPTED、降级报告发布页压警示横幅、MA_JOB_DEADLINE
#      总闸(默认 3600s,0=关,步骤边界拦"叠加超时")。
#   B) 表口径与取数线(本包 fix14/15 原有):两表统一 sample_hebo、MA_POP_FILTER 活动
#      过滤、hdfs_get.py repartition 并行写出。
#   C) fix16-a2:cli.py 装载削峰(arrow 直读 + self_destruct + system 内存池),治
#      千万行单 prepare 被 OOM SIGKILL(128G 容器峰值 116G→~65G)。
#   ⚠ 两个配套 skill 文件随包解在当前目录,需分别拷入 skill 目录才生效(先备份原件):
#      cp hdfs_get.py ~/.claude/skills/hdfs-data/scripts/hdfs_get.py
#      cp cli.py      ~/.claude/skills/marketing-audit/cli.py
# fix15(2026-08-03):分区表取数优化(特征表已按 activity_id 改建分区表)——
#   ① ma_pipeline.py:两表合一(POP_TABLE==FEAT_TABLE)时,quantile / count_rules /
#      count_push_total 与出参 push_sql 统一前置 {MA_FILTER_COL}='{activity_id}':
#      吃到分区剪裁不再全表扫,口径上人数只算本活动的特征行。MA_POP_FILTER=auto/1/0。
#   ⚠ ② 配套 hdfs_get.py(已随包带在解包目录,需再拷到 skill 目录才生效):
#      写出 coalesce(nparts) 改 repartition(nparts)。
#      coalesce 是窄依赖,nparts=1 时把上游扫描塌进 1 个 task 单核串行 —— 未分区表实测
#      23GB 扫 30min 0 产出,被 1800s 超时杀掉(job_20260803_171733)。repartition 扫描
#      并行、仅写出 nparts 个 task,输出文件数不变。装法(先备份原件):
#      cp hdfs_get.py ~/.claude/skills/hdfs-data/scripts/hdfs_get.py
# fix14(2026-08-03):特征表与人群池表默认值统一改为 app_dm.tmp_ctj_marketing_audit_sample_hebo。
#   背景:fix10 落定的人群池 app_dm.long_ctj_marketing_audit_sample 在 metastore 一直没建出来 ——
#   1000344 单 prepare 被 SIGKILL(疑似 OOM)降级后,骨架查这张表取列名,AnalysisException
#   无人接,整单以 E_INTERNAL 收场(详见 诊断_20260803_activity1000344.md)。
#   现按新口径两表同源;要换表 export MA_FEAT_TABLE / MA_POP_TABLE,代码不用动。
#   ⚠ 换表必查 MA_FILTER_COL:过滤列配错不报错,只捞回 0 行然后产出一份空报告。
# fix13(2026-08-03):claude 会话归拢:子进程固定 cwd=MA_LLM_HOME(默认 llm_sessions),
#   Prism 不再每单新建「run」项目,所有会话在同一项目下。
# fix12(2026-08-03):pull 失败时从全量输出抠出 Caused by 异常行进 detail.exceptions
#   与任务日志(Spark 栈帧再长也不丢根因);配套 hdfs_get.py 修复(rebase/void列,单独拷)。
# fix11(2026-08-03):鉴权比较改 bytes;口令含非 ASCII(如误抄「你的口令」占位符)
#   在服务启动与 restart_prism.sh 里直接拒启 —— 修线上 ECONNRESET 事故。
# fix10(2026-08-03):两张固定表落定 ——
#   特征表默认 app_dm.tmp_ctj_marketing_audit_features_hebo,过滤列默认 activity_id
#   (MA_FILTER_COL 可调,老表是 task_id;配错不报错只捞 0 行,换表必查);
#   人群池默认 app_dm.long_ctj_marketing_audit_sample(圈人计数与 push_sql 的 FROM)。
# 用法:tar xzf ma-fix18.tar.gz -C ~/prism/ma-api-mode/ && bash ~/prism/ma-api-mode/install.sh
#      (ma_server 上按实际部署路径,如 ~/prism/ma-api-mode/)
# ⚠ fix9 还配套改了 skill 的渲染器(业务影响排版碎裂修复),那个文件不在本包里:
#   把 report_renderer.py 拷到 ~/.claude/skills/marketing-audit/snippets/ 里(先备份原件)。
#
# 装完之后要做什么,取决于你在哪台机器上:
#   下午那台测试机(43.167.214.72) → bash run_real_c.sh
#   公司 ma_server                 → python3 preflight_ma_server.py 先体检,再 bash run_ma_server.sh c
# 两条路的区别在文末,也在 运行说明.md 的「上 ma_server」一节。
set -u
cd "$(dirname "$0")" || exit 1
TS=$(date +%Y%m%d_%H%M%S)

echo "=== 1. 备份原文件到 .bak_$TS ==="
# 这几个是"服务器上那份可能被手改过"的:改过端口、改过 CSV 路径、改过 export 的一堆
# MA_*。直接盖掉会把那些改动无声抹平 —— 无声是最要命的,人不会去看一个成功的日志。
for f in ma_core.py ma_pipeline.py ma_api_c.py ma_api_b.py \
         run_real_c.sh run_real_b.sh run_ma_server.sh preflight_ma_server.py; do
  if [ -f "$f" ] && [ -f "_new/$f" ]; then
    cp -p "$f" "$f.bak_$TS" && echo "  备份 $f -> $f.bak_$TS"
  fi
done

echo "=== 2. 覆盖 ==="
# 只有 _new/ 里真有的才覆盖 —— 所以这个名单可以列全,包里没带的自然跳过。
for f in ma_core.py ma_pipeline.py ma_api_c.py ma_api_b.py \
         regress_polish.py regress_direction.py regress_critique.py \
         regress_agent.py regress_env.py regress_contract.py \
         preflight_ma_server.py \
         run_real_c.sh run_real_b.sh run_ma_server.sh \
         运行说明.md; do
  if [ -f "_new/$f" ]; then
    cp -p "_new/$f" "$f" && echo "  更新 $f  ($(wc -c < "$f") 字节)"
  fi
done
# 回归用的重放存档。regress_direction 里有 5 条断言是 fnd_r41(创单未付待促付人群)
# 那个线上问题的回归,它们要有一份真实 crowd_rules.json 才跑得起来。没有这份存档,
# 刚解包的机器上那 5 条一条都不跑,汇总还照样是"全过"—— 所以它必须跟着包走。
if [ -d _new/fixtures ]; then
  mkdir -p fixtures
  for f in _new/fixtures/*; do
    [ -f "$f" ] && cp -p "$f" "fixtures/$(basename "$f")" \
      && echo "  更新 fixtures/$(basename "$f")  ($(wc -c < "$f") 字节)"
  done
fi
# restart_prism.sh 的家在上一级(Prism 根目录):它按自身所在位置推 PRISM_DIR 和
# ma-api-mode 路径,放错层级会把 ma-api-mode/ma-api-mode 当成服务目录。
# 所以它不走上面的白名单,单独拷到 ../ 去。
if [ -f "_new/restart_prism.sh" ]; then
  [ -f "../restart_prism.sh" ] && cp -p "../restart_prism.sh" "../restart_prism.sh.bak_$TS" \
    && echo "  备份 ../restart_prism.sh -> ../restart_prism.sh.bak_$TS"
  cp -p "_new/restart_prism.sh" "../restart_prism.sh" && chmod +x "../restart_prism.sh" \
    && echo "  更新 ../restart_prism.sh  (Prism 根目录,重启入口)"
fi
rm -rf _new

echo "=== 3. 语法自检 ==="
python3 -m py_compile ma_core.py ma_pipeline.py ma_api_c.py ma_api_b.py preflight_ma_server.py \
  && echo "  COMPILE_OK" || { echo "  COMPILE_FAIL —— 请把上面报错发我"; exit 1; }
# 三个 runner 都过一遍 bash -n。run_ma_server.sh 里有 ${MODE^^} 这类 bash 4 的写法,
# 万一哪天被 sh 跑了,这一步会先炸给你看,而不是等到半夜下不出单。
for s in run_real_c.sh run_real_b.sh run_ma_server.sh; do
  [ -f "$s" ] || continue
  bash -n "$s" || { echo "  $s 语法有问题,请把上面报错发我"; exit 1; }
done
echo "  RUNNER_OK"

FAIL=0
run_suite () {   # $1=标题  $2=脚本
  echo "=== $1 ==="
  if python3 "$2" > "/tmp/$2.log" 2>&1; then
    tail -2 "/tmp/$2.log"
  else
    FAIL=1
    echo "  这一项挂了,下面是失败的断言(完整日志 /tmp/$2.log):"
    grep -E '^\s+\[FAIL\]|^\s+挂: |汇总' "/tmp/$2.log" | tail -20
  fi
}

run_suite "4. 回归:圈人口径(只推 push,促付要被认回来)" regress_direction.py
run_suite "5. 回归:润色接得住"                          regress_polish.py
run_suite "6. 回归:门禁分得清 schema / lint / 渠道"      regress_critique.py
run_suite "7. 回归:报告产出 Agent(带工具权限用 skill)"  regress_agent.py
run_suite "8. 回归:环境体检 / 长连接不串包 / Prism 自启"  regress_env.py
run_suite "9. 回归:/result 公开契约(六字段,内部键不外泄)"   regress_contract.py

echo
if [ "$FAIL" -ne 0 ]; then
  echo "!!! 有回归挂了,先别重启服务,把上面的 [FAIL] 行发我 !!!"
  exit 1
fi

echo "=== 装完了,回归全过。 ==="
echo
echo "fix23:suggestion 前置分档标注 ——"
echo "  - 【建议推送】模型产出推送人群 / 【建议优化】规则产出推送人群 / 【建议排除】非推送人群。"
echo "  - alter 里的两类人靠它区分;前缀是固定 token,UI 可直接切出来做标签。"
echo "  - 幂等自纠正:重复投影不叠加,上游错前缀会被纠正。"
echo "  - ⚠ 配套装 ma-skill-fix31,否则模型人群的建议动作仍是那句通用套话。"
echo
echo "fix22:/result 的 direction 改为人群包操作类型 ——"
echo "  - create = 模型分析产出的推送人群(新建人群包);alter = 其余一律(改已有人群包)。"
echo "  - 判定用 finding_id 前缀:fnd_model_* → create,其余 → alter。"
echo "  - 内部仍是 push/exclude,只在出参投影层映射;push_sql / size.push 口径完全不受影响。"
echo "  - ⚠ exclude 人群也标 alter —— alter 里混着「要推的」和「明确别推的」。"
echo "    推送以服务端 push_sql / size.push 为准;自己拼 SQL 请读 meta.json 的原始 direction。"
echo "  - 抽查:取一单 /result,direction 应只出现 create / alter 两个值;"
echo "    create 条数应等于 fnd_model_* 且内部 direction=push 的人群数。"
echo
echo "fix21:/result 的 rules[] 改为带全部 direction ——"
echo "  - rules[] 现在同时含 push 与 exclude,由每条的 direction 区分;六字段结构未变。"
echo "  - ★ push_sql / size.push 仍只含 push 那批,服务端已算好,可直接用。"
echo "  - ⚠ 破坏性变更:调用方**不要把 rules[] 整个 OR 起来推**。自己拼 SQL 的话"
echo "    必须先按 direction 过滤 —— exclude 是诊断明说「本活动别推」的人群,"
echo "    7/28 那单里一条 exclude 就覆盖 49477/50000 人。"
echo "  - 抽查:取一单 /result,rules[] 里应能看到 direction=exclude 的条目;"
echo "    再核对 crowd_spec.push_sql 的谓词数 == direction=push 的规则条数。"
echo
echo "fix20:crowd_push 去 Spark,改本地 data.parquet 校验 ——"
echo "  - 8/14 两单并发炸(SPARK-2243 / setCallSite)从根上消失:进程内不再有 Spark。"
echo "  - MA_POP_TABLE / MA_POP_FILTER 作废;push_sql 口径不变(特征表 + activity 过滤)。"
echo "  - 新增 env:MA_RULE_CHECK=strict|lenient(默认 strict)、MA_REQUIRE_RULES=1|0(默认 1)。"
echo "  - ⚠ 必须配套装 ma-skill-fix30:"
echo "      bash ~/.claude/skills/marketing-audit/scripts/install_skill.sh ma-skill-fix30.tar.gz"
echo "  - 首跑建议 export MA_RULE_CHECK=lenient 观察 2~3 单:job warnings 里如出现"
echo "    「一致性自检不过」需先查口径(如训练采样),确认后去掉该 env 回 strict。"
echo "  - 上线后盯两个应恒为 0 的量:skill 日志的 oracle 自检 WARNING、job 的自检剔除。"
echo "  - 抽查一单 /result:rules[].filter_zh 应为逐 token 直译口径(字段中文+且/或/属于);"
echo "    meta 里 data_source=parquet:data.parquet 即新链路生效。"
echo
echo "fix19:人群规则出参新增中文口径 ——"
echo "  - /result 出参 rules 逐条现在是六个字段:name/finding_id/sql_filter/filter_zh/direction/suggestion。"
echo "      filter_zh = 筛选条件的中文说法(如「（已转化）且（未成单）」),与报告附录同源。"
echo "      **执行仍以 sql_filter 为准**;filter_zh 翻不动时是空串,不是 null,下游不必判空。"
echo "  - 纯增字段,老调用方不受影响。"
echo "  - ⚠ 值由 skill 侧产出,必须配套装 ma-skill-fix29,否则这一列全是空串:"
echo "      bash ~/.claude/skills/marketing-audit/scripts/install_skill.sh ma-skill-fix29.tar.gz"
echo "  - 上线后抽查:随便取一单的 /result,看 rules[].filter_zh 是否有中文;"
echo "    若整批为空 → skill 包没装或没生效(crowd_rules.json 里就没有这个键)。"
echo
echo "fix18.1:上线首单复盘补丁 ——"
echo "  - /result 出参 rules 逐条现在是五个字段:name/finding_id/sql_filter/direction/suggestion。"
echo "  - 人群身份键修碰撞:同 finding_id 的模型人群不会再互相覆盖(报告与接口人群名从此一致)。"
echo "  - 配套 skill 包 ma-skill-fix20 同批更新(阈值最多 4 位小数),两个包一起装。"
echo
echo "fix18:人群规则出参新增 suggestion(建议动作)——"
echo "  - crowd_spec.rules[] 与 excluded_rules[] 每条多两个字段:"
echo "      suggestion        = 报告「可落地人群包」里该人群对应的建议动作(纯文本)"
echo "      suggestion_source = index / sql / name / default,标记这句话是怎么对上的"
echo "  - 纯增字段,老调用方不受影响;下游若要用,认 suggestion 即可。"
echo "  - 上线后抽查:出参里 suggestion_source=default 的条数应当很少;若大面积是 default,"
echo "    说明定稿人群段没对上(看日志里那行「suggestion 回填 N 条,来源分布 …」)。"
echo "  - ⚠ 配套 skill 包 ma-skill-fix20 要一起装,否则模型人群仍会重名、且 crowd_rules.json 无保底值:"
echo "      tar xzf ma-skill-fix20.tar.gz -C ~/.claude/skills/marketing-audit/"
echo
echo "fix17:prepare 提速与降级不冻死 ——"
echo "  - 模型训练下采样(正样本全保留、只采负样本)MA_MODEL_SAMPLE=500000(0=关):"
echo "    千万行单 model_analysis ~17min→1-2min;训练先验抬高一事写进 data_caveats。"
echo "  - 骨架构建硬上限 MA_STUB_TIMEOUT=900s + 逐列心跳:降级路径超时/异常退化为无列骨架,不再冻死。"
echo "  - ⚠ cli.py 本轮有更新,记得拷:cp cli.py ~/.claude/skills/marketing-audit/cli.py(先备份)。"
echo "  - 大活动(千万行级)prepare 其余步骤仍是全量统计,若仍贴近 1800s:临时调 MA_STEP_TIMEOUT=2700"
echo "    并同步调大 MA_JOB_DEADLINE;根治靠列裁剪(MA_PULL_COLUMNS/feature_registry,待落地)。"
echo
echo "fix16:合流版(健壮性线 fix14 + 表口径线 fix15 + cli.py 削峰),新增必读:"
echo "  - MA_JOB_DEADLINE 总闸默认 3600s(0=关):步骤边界检查任务总耗时,超支判 E_JOB_DEADLINE。"
echo "  - 降级稿不裸发:润色未完成且无 agent 成品时,发布页顶部自动压橙色警示横幅(原件不动)。"
echo "  - ⚠ 两个配套 skill 文件都要拷(先备份原件):"
echo "      cp hdfs_get.py ~/.claude/skills/hdfs-data/scripts/hdfs_get.py"
echo "      cp cli.py      ~/.claude/skills/marketing-audit/cli.py"
echo
echo "fix15:分区表取数优化 ——"
echo "  - 两表合一时人群池查询与 push_sql 自动限定本活动(MA_POP_FILTER=auto,设 0 回到全表口径)。"
echo "  - ⚠ 配套 hdfs_get.py 已随包解在当前目录,再拷到 skill 目录才生效(先备份原件):"
echo "      cp hdfs_get.py ~/.claude/skills/hdfs-data/scripts/hdfs_get.py"
echo "  - 验证分区剪裁:spark-sql EXPLAIN SELECT * FROM <表> WHERE activity_id='<id>',"
echo "    物理计划里 PartitionFilters 非空才是真剪裁;重跑一单看 pull 是否降到秒级~分钟级。"
echo
echo "fix14:特征表与人群池默认值已统一为 app_dm.tmp_ctj_marketing_audit_sample_hebo(两表同源)。"
echo "  - 若起服务的 shell 里已 export 过 MA_FEAT_TABLE / MA_POP_TABLE,以环境变量为准 —— 确认没指着旧表。"
echo "  - 换表必查过滤列:新表的活动 ID 列若不叫 activity_id,export MA_FILTER_COL=<实际列名>(配错不报错,只出空报告)。"
echo "  - 主键列若不叫 mapid/unionid:export MA_ID_COL / MA_UNION_COL 配平。"
echo "  - 顺手建议:export PYTHONUNBUFFERED=1,子进程再被杀时日志能留下死前最后一行。"
echo
echo "fix9(2026-07-30)在 fix8 之上追加两件事(356352 报告格式问题的修复):"
echo
echo "  ⓪a meta 兜底链:--meta 不再造占位符,campaign_name→数据 activity_name→activity_id,"
echo "     campaign_type→数据 activity_channel→「活动」(老默认「社群进群」作废),"
echo "     target_products→数据 activity_product_name。报告标题从此显示活动真名而不是 ID。"
echo "  ⓪b 配套 skill 渲染器修复(业务影响一行碎成列的问题),文件不在本包:"
echo "     cp report_renderer.py ~/.claude/skills/marketing-audit/snippets/   # 先备份原件"
echo
echo "fix8 的内容(累积包里都含)—— 一半是契约收窄,一半是 356352 单的复盘落地:"
echo
echo "  ① 对外契约收窄(老调用方必须跟着改,发老字段会被 400 拒单,不是静默忽略):"
echo "     入参只收 activity_id / date / meta(campaign_type 放 meta 里);"
echo "     push_source 挪到服务端:export MA_PUSH_SOURCE=both   # model/rule/both,默认 both"
echo "     pull_partition 与 note 取消(特征表按约定是固定表、无分区,对表只读不写)。"
echo "     /result 只回六个字段:job_id/state/activity_id/mode/report_url/rules,"
echo "     rules 逐条只有 name/finding_id/sql_filter/direction。"
echo "     完整内部账(push_sql/size/degraded/warnings/notes)都在 jobs/<id>/meta.json。"
echo
echo "  ② 356352 单复盘落地(那单 2334s 出废稿,90% 时间烧在 4 次全超时的模型调用上):"
echo "     - agent 超时被杀时先验产物:state_full.json 完整且过锚点校验就按成品采纳,"
echo "       不再只看退出码就丢(那单 agent 三道门禁全过、差 2.5 秒被杀,成品被覆盖);"
echo "       弃用的产物挪存 *.agent_timeout/failed.json 留证,润色永远盖不掉它。"
echo "     - 超时按实测思考延迟重定(后端是思考型,单次静默思考实测 358.8s):"
echo "       MA_POLISH_TIMEOUT=600  MA_POLISH_BUDGET=1800  MA_AGENT_TIMEOUT=2400(联动,别只调一个)"
echo "     - 润色首轮就按 MA_POLISH_BATCH=8 分小批,不再 48 槽一把梭;"
echo "       提示词砍掉数据概览里的超长明细(55K→单批约 18K),每槽数字仍在各自 context 里。"
echo "     - claude 超时被杀时保留已产出的 stdout/stderr,日志与出参带 timed_out/timeouts。"
echo
echo "  ③ 按调用分模型(--model 经网关按名分发,空串=网关默认):"
echo "     export MA_AGENT_MODEL=sonnet    # 报告产出 Agent 全量活"
echo "     export MA_POLISH_MODEL=haiku    # 润色/schema/质检/渠道等轻量文本调用"
echo "     当前生效值看 /healthz 的 models 字段和启动横幅。"
echo
echo "上一版(fix7)的要点仍然有效,都是冲着「上公司 ma_server」去的:"
echo
echo "  ① 环境体检 preflight_ma_server.py"
echo "     不起服务,只看这台机器配得对不对:报告链接的前缀、发布目录在不在、"
echo "     取数脚本和 skill 在不在、端口有没有被占、反代和自启会不会被拒。"
echo "     跑法:python3 preflight_ma_server.py        (--no-network 跳过探测)"
echo "     同一套体检在服务启动时也会跑一遍,致命项直接拦住不让起;"
echo "     确认都是有意为之才 export MA_ALLOW_BAD_ENV=1 放行。"
echo
echo "  ② 端口:公司网关只转发 8080,而 8080 是 Prism 的。所以本服务**不单独开端口对外**,"
echo "     而是挂在 Prism 底下走反代。在起 Prism 的那个 shell 里:"
echo "       export PRISM_MA_API_TARGET=127.0.0.1:8092     # 不配 = 反代根本不挂载"
echo "     之后对外地址就是 https://<网关域名>/api/ma/...,和 Prism 同源、同一个端口。"
echo "     只认回环地址:能转到任意主机的反代就是一个现成的 SSRF 跳板,所以那是硬拒。"
echo
echo "  ③ 自启:让 Prism 起来的时候顺带把诊断服务也拉起来,退出时一并收掉。"
echo "       export PRISM_MA_API_AUTOSTART=$(pwd)/ma_api_c.py   # 必须绝对路径"
echo "       export PRISM_MA_API_PYTHON=python3                 # 可选,默认 python3"
echo "     子进程监听哪个端口是从 PRISM_MA_API_TARGET 反推的,不读你 shell 里的 MA_API_PORT ——"
echo "     两边配歪这件事从根上就不存在了。"
echo "     注意 MA_API_KEY 没设会**拒绝自启**(不是起了之后警告一声):这条路径经网关对外,"
echo "     裸跑等于把接口敞开。本机调试才用 PRISM_MA_API_ALLOW_NO_KEY=1。"
echo "     还有:MA_* 那一堆变量要 export 在**起 Prism 的 shell** 里,子进程继承的是它的环境。"
echo
echo "  ④ run_ma_server.sh —— ma_server 上的整轮联调(体检→起服务→下单→取结果→验出参)。"
echo "     它会先探一下端口:已经有服务在应答就**复用**,不抢。"
echo "     因为那个进程很可能是 Prism 自启的子进程,kill 掉 Prism 会立刻再拉起来,"
echo "     两边抢同一个端口,谁也起不来。真要换成新代码,重启 Prism,别在这儿 kill。"
echo "     用法:bash run_ma_server.sh c        (b = 方案B,FORCE_RESTART=1 = 强行自己起)"
echo
echo "报告产出 Agent 的变量(fix6 引入,fix8 改了默认超时并加了模型),都在导入时读取 ——"
echo "必须 export 之后再起服务,写在 python3 后面是不生效的:"
echo "  MA_REPORT_AGENT=1                             # 1=报告产出交给带工具权限的 claude 自己用 skill(默认开)"
echo "  MA_AGENT_TOOLS='Bash,Read,Write,Edit,Glob,Grep'  # 点名放开这几个,不用 --allow-dangerously-skip-permissions"
echo "  MA_AGENT_TIMEOUT=2400                         # fix8 从 1200 调来:356352 单 1197.45s 干完全活被擦边杀掉"
echo "  MA_AGENT_MODEL=sonnet                         # fix8 新增,agent 的 --model"
echo "  MA_AGENT_MAX_TURNS=                           # 留空=不限;要收紧就填个数"
echo "  MA_AGENT_PROMPT=                              # 留空=用内置提示词;填路径可整段替换"
echo "把 MA_REPORT_AGENT 设成 0 就退回 fix5 的老链路(驱动自己拼报告),两条路都在。"
echo
echo "另外 target_products(品类名)的口径:"
echo "  默认  = --auto-meta 从数据的 activity_product_name 取,这是正常路径,不报警;"
echo "         取到了什么会写进出参 notes,想看就看一眼"
echo "  要指定 = 下单时 meta.target_products 传数组,或 export MA_TARGET_PRODUCTS='机票,酒店'"
echo "  只有取回来的值看着像页面名(「特价机票业务总览」这种)才会在 warnings 里吵一声"
echo
echo "=== 让新代码生效: ==="
echo "  开了 Prism 自启      → 重启 Prism 就行(子进程跟着一起换)。别单独 pkill 它。"
echo "  手工起的服务          → pkill -f 'ma_api_[c].py' ; sleep 1 ; bash run_ma_server.sh c"
echo "  下午那台测试机        → pkill -f 'ma_api_[c].py' ; sleep 1 ; bash run_real_c.sh"
