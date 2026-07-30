#!/usr/bin/env bash
# 营销诊断 API 服务安装脚本。先备份、再覆盖、最后自检。
# 累积包:装这一个就够了,不用再装之前的 fix / fix2 / … / fix7 / fix8。
# 用法:tar xzf ma-fix9.tar.gz -C ~/demo/ma-api-mode/ && bash ~/demo/ma-api-mode/install.sh
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
         regress_agent.py regress_env.py \
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

echo
if [ "$FAIL" -ne 0 ]; then
  echo "!!! 有回归挂了,先别重启服务,把上面的 [FAIL] 行发我 !!!"
  exit 1
fi

echo "=== 装完了,回归全过。 ==="
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
