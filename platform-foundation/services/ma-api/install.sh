#!/usr/bin/env bash
# 营销诊断 API 服务安装脚本。先备份、再覆盖、最后自检。
# 累积包:装这一个就够了,不用再装之前的 fix / fix2 / … / fix9 / fix10。
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
