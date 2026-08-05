#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
营销诊断 API 模式 —— 流水线编排层

把 流程.md 里那条 7 步链路搬到 API 模式下,并按接口的口径改三处:

  1) 只出推送人群。原流程 push + exclude 两套都写表,API 模式按约定"只退出需要 push
     的人群,需要排除的不会进行推送"。所以这里没有 exclude 分支,也没有 left_anti 去重叠。
  2) 不写任何表。原流程写 tmp_ctj_sy_crowd_test / tmp_ctj_sy_report,API 模式一行都不写,
     只把"报告链接 + 人群规则 JSON"作为出参返回。
  3) 润色这一步在原流程里是唯一需要 Agent/人工的环节,API 模式必须无人值守,
     所以改成 headless 调 Claude Code CLI,并且用"补空槽"的方式做(见 polish_state)。

⚠ 本文件不 import 私域平台诊断/ 下的任何模块,也不修改那边任何文件。
   push 这一支的逻辑是照着 run_one_activity.py 重新实现的,口径刻意保持一致
   (尤其是"按 finding_id 前缀分模型/规则"这一条,见 pick_push_rules)。
   只有一处故意不一致:圈人时要看 direction,只收 push。离线流程不看,是因为 direction
   留给下游消费;API 模式没有下游,不在这里拦就等于把排除人群推出去了。

后端拆成正交的两轴,而不是三个写死的档位:

  数据源(MA_DATA)   hive  —— hdfs_get 拉特征,Spark 在人群池上校验/计数(ma_server)
                     csv   —— 本地一份 CSV 顶替人群池,装进内存 sqlite 后照样跑校验/计数
                     synth —— 合成数据,谁都不依赖,只验证状态机
  诊断步骤(MA_SKILL) skill —— 真调 marketing-audit 的 cli.py
                     stub  —— 本地造同形状的 state,不调 skill

  之所以拆开:"skill 装好了但机器上没有 Hive"是真实且常见的处境(轻量服务器就是),
  把它写成一个第三档会越写越多,拆成两轴就只是换个数据源。

MA_RUNTIME 只是这两轴的预设名:
   real  = hive  + skill      全真,给 ma_server 用
   csv   = csv   + skill      有 skill 没取数能力的机器,数据来自本地 CSV
   skill = synth + skill      连数据都没有,但想验证 skill 的每个子命令
   stub  = synth + stub       纯空跑
   显式给 MA_DATA / MA_SKILL 时覆盖预设。

任何一档的人群校验都不是"跳过":规则的 dry-run、每条命中数、去重后人数都是真算的,
区别只在算在哪份数据上。

环境变量
  MA_RUNTIME          real / csv / skill / stub,默认 stub
  MA_DATA             hive / csv / synth,覆盖预设的数据源
  MA_SKILL            skill / stub,覆盖预设的诊断步骤
  MA_CSV              csv 数据源用的文件,**没有默认值**,数据源是 csv 时必须显式给
  MA_CSV_ENCODING     指定 CSV 编码;不给就按 utf-8-sig→utf-8→gb18030→latin-1 依次试
  MA_CSV_MAX_ROWS     CSV 最多装载多少行,默认 500000
  MA_ID_COL           去重主键列;不给就在 mapid/memberid/unionid… 里挑,挑不到告警
  MA_UNION_COL        unionid 列;同上
  MA_SKILL_DIR        marketing-audit skill 目录,默认 ~/.claude/skills/marketing-audit
  MA_HDFS_GET         hdfs_get.py 路径,默认 ~/.claude/skills/hdfs-data/scripts/hdfs_get.py
  MA_SKILL_STRICT     1=skill 任一步失败即整单失败;默认 0(该步降级为本地骨架并告警)
  MA_SKILL_PY         调 cli.py 用的解释器,默认 python3
  MA_FEAT_TABLE       特征表,默认 app_dm.tmp_ctj_marketing_audit_sample_hebo(固定表、无分区)
  MA_FILTER_COL       特征表里活动 ID 的过滤列,默认 activity_id(老表是 task_id)
  MA_POP_TABLE        人群池表,默认 app_dm.tmp_ctj_marketing_audit_sample_hebo(与特征表同表)
                      (圈人 dry-run/计数/push_sql 的 FROM 都用它;主键列不叫
                       mapid/unionid 的话用 MA_ID_COL / MA_UNION_COL 调)
  MA_PUBLIC_DIR       HTML 发布目录,默认按 runtime 取(real=/home/jovyan/prism/public)
  MA_URL_BASE         报告 URL 前缀
  MA_STEP_TIMEOUT     单个子命令超时秒数,默认 1800
  MA_POLISH_TIMEOUT   润色单次 CLI 调用的超时,默认 300
  MA_POLISH_ROUNDS    润色最多几轮(第 1 轮整批,之后分批补漏),默认 3
  MA_POLISH_BATCH     补漏时每批几个空槽,默认 12
  MA_POLISH_BUDGET    润色总时间预算秒数,默认 900
  MA_SCHEMA_CHECK     润色后是否用 skill 的 schema 门禁做闭环体检,默认 1
  MA_SCHEMA_ROUNDS    体检-重写最多几轮,默认 2(渠道词汇那几轮不计入)
  MA_STUB_ROWS        synth 人群池行数,默认 2000
  MA_REPORT_AGENT     报告产出是否交给带工具权限的 claude 自己用 skill,默认 1
  MA_AGENT_TOOLS      给它的 --allowedTools,默认 Bash,Read,Write,Edit,Glob,Grep
  MA_AGENT_TIMEOUT    这一步的超时秒数,默认 1200
  MA_AGENT_MAX_TURNS  传给 --max-turns;不给就不传
  MA_AGENT_PROMPT     自定义提示词模板文件;不给就用内置的
  MA_ALLOW_BAD_ENV    1=环境体检查出致命问题也照常启动(见 check_env),默认 0
"""

import hashlib
import json
import os
import random
import re
import shutil
import subprocess
import sys
import threading
import time

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

PLACEHOLDER = "[待润色]"


def _env(name, default):
    return os.environ.get(name) or default


def _env_int(name, default):
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


RUNTIME = (_env("MA_RUNTIME", "stub")).strip().lower()
SKILL_DIR = _env("MA_SKILL_DIR", os.path.expanduser("~/.claude/skills/marketing-audit"))
HDFS_GET = _env("MA_HDFS_GET", os.path.expanduser("~/.claude/skills/hdfs-data/scripts/hdfs_get.py"))
FEAT_TABLE = _env("MA_FEAT_TABLE", "app_dm.tmp_ctj_marketing_audit_sample_hebo")
# 固定特征表(fix14 起与人群池统一为 sample_hebo 表)里活动 ID 的过滤列叫 activity_id;老表叫 task_id。
# 换表时列名对不上,pull 不报错、只捞回 0 行,然后一路"顺利"产出一份空报告 ——
# 所以列名必须跟表一起配,MA_FILTER_COL 就是那个口子。
FILTER_COL = _env("MA_FILTER_COL", "activity_id").strip() or "activity_id"
# 人群池表:圈人 dry-run/计数/push_sql 的 FROM 都用它。
# fix14(2026-08-03):与特征表统一改为 app_dm.tmp_ctj_marketing_audit_sample_hebo。
# 背景:fix10 落定的 app_dm.long_ctj_marketing_audit_sample 在 metastore 里一直没建出来 ——
# 1000344 单 prepare 被杀降级后,骨架查它取列名,AnalysisException 无人接,整单崩
# (详见 诊断_20260803_activity1000344.md)。换表用 MA_FEAT_TABLE/MA_POP_TABLE,代码不用动;
# 换表必查 MA_FILTER_COL(过滤列配错不报错,只捞 0 行出空报告)。
# 老表是 tmp_dm.tmp_ctj_mktv2_sy_sample;主键/联合列若与老表不同,用 MA_ID_COL/MA_UNION_COL 调。
POP_TABLE = _env("MA_POP_TABLE", "app_dm.tmp_ctj_marketing_audit_sample_hebo")
# fix15:两表合一(POP_TABLE == FEAT_TABLE)时,人群池侧查询默认限定在本活动 ——
# quantile / count_rules / count_push_total 与出参 push_sql 统一前置 {FILTER_COL}='{activity_id}'。
# 好处:表按 activity_id 分区后,这些查询吃到分区剪裁,不再全表扫;
# 口径上人数只算本活动的特征行(两表合一后不过滤,会把所有活动的行混进计数)。
# MA_POP_FILTER: auto(默认,仅两表同名时启用)/ 1(强制启用)/ 0(关闭,回到全表口径)。
POP_FILTER = (_env("MA_POP_FILTER", "auto")).strip().lower()
STEP_TIMEOUT = _env_int("MA_STEP_TIMEOUT", 1800)
# fix17:降级骨架构建的硬上限(秒,0=不限)。骨架要摸 Hive 取真列名+分位数(十几个查询,
# 全程无日志)——1011270 单(2026-08-04)prepare 超时降级后就冻死在这里,任务停在
# phase=prepare 再无进展。超过上限就放弃取真列,改用无列骨架,流水线继续走。
STUB_TIMEOUT = _env_int("MA_STUB_TIMEOUT", 900)
# 2026-07-30 按 356352 单 transcript 实测重定超时:线上后端(glm-5.2)是思考型,
# 单次静默思考实测最长 358.8s —— 300s 的润色超时天然低于它的思考时长,三杀全是
# 这个死法。三个值联动:单次 600 > 实测思考上限;预算 1800 = 3 次满额,只调
# 单次不调预算的话,一次卡死就吃光预算,补漏轮反而消失。
POLISH_TIMEOUT = _env_int("MA_POLISH_TIMEOUT", 600)
POLISH_ROUNDS = _env_int("MA_POLISH_ROUNDS", 3)
# 批次也调小(12→8):48 槽一把梭的 55K 大题让思考型后端一想就是五分钟起,
# 小题的思考在几十秒量级。首轮同样分批(见 polish_state)。
POLISH_BATCH = _env_int("MA_POLISH_BATCH", 8)
POLISH_BUDGET = _env_int("MA_POLISH_BUDGET", 1800)
# 单任务总耗时上限(秒),0=不限。在每个步骤开跑前检查:超了就判 E_JOB_DEADLINE,
# 别让调用方陪着熬(agent 2400 + 润色 1800 + 修复若干,理论最坏能叠到小时级)。
# 它拦的是"步骤叠加超时";单步内部卡死由 call_claude 的进程组 kill 兜。
JOB_DEADLINE = _env_int("MA_JOB_DEADLINE", 3600)
STUB_ROWS = _env_int("MA_STUB_ROWS", 2000)
# 报告产出这一段交给带工具权限的 claude,让它自己去读 SKILL.md、自己跑 skill。
# 0 = 退回「驱动代跑 skill + 无工具模型只润色」的老链路。
REPORT_AGENT = (_env("MA_REPORT_AGENT", "1")).strip() not in ("0", "false", "no", "")
AGENT_TOOLS = _env("MA_AGENT_TOOLS", "Bash,Read,Write,Edit,Glob,Grep")
# 1200 是擦边刀:356352 那单 agent 在 1197.45s 已经三道门禁全过、render DONE,
# 差 2.5 秒被杀。翻倍留余量;超时被杀时产物还有一次"验伤采纳"的机会(见 run_report_agent)
AGENT_TIMEOUT = _env_int("MA_AGENT_TIMEOUT", 2400)
# 按调用分模型(2026-07-30 定):agent 是全量活,走强模型;润色/schema/质检/渠道
# 这些轻量文本调用走快模型 —— 356352 的教训是思考型满血模型面对小题也要长考,
# 快模型正好对症。取值传给 claude -p 的 --model(别名或全名都行,网关按名分发);
# 设成空串 = 不传 --model,回到网关默认,行为与旧版完全一致。
AGENT_MODEL = _env("MA_AGENT_MODEL", "sonnet").strip()
POLISH_MODEL = _env("MA_POLISH_MODEL", "haiku").strip()
# 所有 claude 子进程的固定工作目录。Claude Code 按 cwd 建"项目",以前 agent 每单
# 用 jobs/<job_id>/run 当 cwd,Prism 侧边栏每调一次接口就多一个叫「run」的新项目
# (2026-08-03 用户截图实证)。固定成一个目录后,所有单的会话都归到同一个项目
# (项目名即目录名 llm_sessions)下;产物路径不受影响 —— 提示词里全是绝对路径。
LLM_HOME = _env("MA_LLM_HOME", os.path.join(BASE_DIR, "llm_sessions"))
AGENT_MAX_TURNS = _env("MA_AGENT_MAX_TURNS", "")
AGENT_PROMPT_FILE = _env("MA_AGENT_PROMPT", "")
SKILL_STRICT = (_env("MA_SKILL_STRICT", "0")).strip() in ("1", "true", "yes")
# 润色完拿 skill 的 schema 门禁体检一遍,它报错我们就重写。0 关掉(省一次 render 的时间)
SCHEMA_CHECK = (_env("MA_SCHEMA_CHECK", "1")).strip() not in ("0", "false", "no", "")
SCHEMA_ROUNDS = _env_int("MA_SCHEMA_ROUNDS", 2)
# 润色前把 skill 自己的写作约束读进提示词。0 = 只用本地精简版(离线自测时省一次读盘)
SKILL_RULES = (_env("MA_SKILL_RULES", "1")).strip() not in ("0", "false", "no", "")
RULES_CHARS = _env_int("MA_RULES_CHARS", 2600)
# 润色完跑 skill 自带的质检环(cli run-tools --tools self_critique)。SKILL.md 第 8 步
SELF_CRITIQUE = (_env("MA_SELF_CRITIQUE", "1")).strip() not in ("0", "false", "no", "")
CRITIQUE_ROUNDS = _env_int("MA_CRITIQUE_ROUNDS", 1)
# render 撞上渠道词汇门禁(REWRITE_REQUIRED)时,把 skill 的原话丢给模型改写再重来。
# 这道门禁 skill 明令不许用开关绕过,只能真改文案
CHANNEL_FIX = (_env("MA_CHANNEL_FIX", "1")).strip() not in ("0", "false", "no", "")
# 渠道门禁最多改写重渲几次。设 0 等于关掉,那样一撞门禁就只能退回应急页 —— 不建议。
CHANNEL_TRIES = _env_int("MA_CHANNEL_TRIES", 2)
# render 之前问一次 skill「还缺什么」,只写日志不改东西,出问题时截图里能直接看到它的判词。
SKILL_STATUS = (_env("MA_SKILL_STATUS", "1")).strip() not in ("0", "false", "no", "")
# SKILL.md 明写:--auto-meta 从 activity_product_name 猜品类,那列常存的是页面名,
# 猜错会让「跨品类推送错配」这类规则整片误判。这两个给运维一个不改代码就能纠正的口子。
CAMPAIGN_NAME = _env("MA_CAMPAIGN_NAME", "")
TARGET_PRODUCTS = _env("MA_TARGET_PRODUCTS", "")
SKILL_PY = _env("MA_SKILL_PY", "python3")
# 没有默认值,而且是故意的:这里原来指着东京测试机上那份 /home/ubuntu/特价机票-正式.csv,
# 换台机器就变成一个"文件找不到"的怪报错,还得先猜到这个路径是从哪来的。
CSV_PATH = _env("MA_CSV", "")
CSV_ENCODING = os.environ.get("MA_CSV_ENCODING")
CSV_MAX_ROWS = _env_int("MA_CSV_MAX_ROWS", 500000)

_STAGING = os.path.expanduser("~/html-server/staging")
_DEFAULT_PUBLIC = {
    "real": "/home/jovyan/prism/public",
    "csv": _STAGING,
    "skill": _STAGING,
    "stub": _STAGING,
}
_DEFAULT_URLBASE = {
    "real": "https://friday_deployment_14540_algo_agent.gw.friday.17usoft.com",
    "csv": "http://43.167.214.72:8000",
    "skill": "http://43.167.214.72:8000",
    "stub": "http://127.0.0.1:8000",
}
PUBLIC_DIR = _env("MA_PUBLIC_DIR", _DEFAULT_PUBLIC.get(RUNTIME, _DEFAULT_PUBLIC["stub"]))
URL_BASE = _env("MA_URL_BASE", _DEFAULT_URLBASE.get(RUNTIME, _DEFAULT_URLBASE["stub"]))

MA_CLI = os.path.join(SKILL_DIR, "cli.py")


# --------------------------------------------------------------------------- 环境体检

# 下午那台腾讯轻量测试机的公网 IP。它在代码里只出现这一次,作用是当"抄错配置"的指纹:
# 报告链接上如果还挂着它,说明这台机器照搬了测试机的环境。
LIGHTHOUSE_TEST_HOST = "43.167.214.72"
# 认 ma_server 的地标。选这个目录是因为 real 链路本身就依赖它(报告要落到它的 public 下):
# 它在 = 这台机器具备走 real 的前提,它不在 = 一定不具备。
# 没用主机名,也没用公网 IP —— 腾讯轻量把公网 IP NAT 在网关上,机器自己看不见自己的公网地址,
# 拿 IP 判会在测试机上误报。
_MA_SERVER_MARK = "/home/jovyan/prism"
# 公司网关目前只转发 8080(API服务方案.md §1.3)。报告链接落在别的端口上,
# 调用方在公司网里点不开 —— 这是"接口 200 了、报告也生成了,但出参没用"的典型死法。
_GATEWAY_PORTS = (80, 443, 8080)
_LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0")


def _looks_like_ma_server():
    return os.path.isdir(_MA_SERVER_MARK)


def _url_host_port(url):
    """从 URL 里抠出 (host, port)。抠不出来给 (None, None)。

    没用 urllib.parse:运维手写的 MA_URL_BASE 经常漏掉 scheme,urlparse 会把整串
    当成 path 而不是报错,那样这道体检就静默失效了 —— 比不做还坏。这里对半截 URL 一视同仁。
    """
    if not url:
        return (None, None)
    s = re.sub(r"^[A-Za-z][A-Za-z0-9+.\-]*://", "", str(url).strip())
    s = s.split("/", 1)[0].split("?", 1)[0]
    if not s:
        return (None, None)
    if s.startswith("["):                       # IPv6 字面量,冒号是地址的一部分
        end = s.find("]")
        if end < 0:
            return (s, None)
        host, rest = s[:end + 1], s[end + 1:]
        port = rest[1:] if rest.startswith(":") else ""
    elif s.count(":") == 1:
        host, port = s.split(":", 1)
    else:                                        # 裸 IPv6 或没有端口
        host, port = s, ""
    try:
        return (host, int(port)) if port else (host, None)
    except ValueError:
        return (host, None)


def check_env(runtime=None, public_dir=None, url_base=None, on_ma_server=None,
              skill_dir=None, hdfs_get=None, csv_path=None,
              data_kind=None, steps_kind=None, exists=None):
    """上线前的环境体检。返回 (fatal, warn) 两个中文串列表。

    分级只看一条:**这一单会不会出"看不出来的坏结果"**。
      fatal —— 会。接口 200、报告也生成了,只是链接谁都打不开 / 出参里根本没有链接。
               这种错不拦在启动时,就只能等业务方来问"你给我的地址打不开"。
      warn  —— 可能出问题,但当事人也许就是故意的(比如在 ma_server 上先跑一轮 csv 验证)。

    每个输入都能从参数覆盖、连"文件在不在"都能换掉,是为了让回归不必真的造出
    /home/jovyan 才能测,也顺便保证这个模块 import 的时候没有任何副作用。
    """
    runtime = (RUNTIME if runtime is None else runtime or "").strip().lower()
    public_dir = PUBLIC_DIR if public_dir is None else public_dir
    url_base = URL_BASE if url_base is None else url_base
    skill_dir = SKILL_DIR if skill_dir is None else skill_dir
    hdfs_get = HDFS_GET if hdfs_get is None else hdfs_get
    csv_path = CSV_PATH if csv_path is None else csv_path
    if data_kind is None or steps_kind is None:
        _d, _s = resolve_runtime()
        data_kind = _d if data_kind is None else data_kind
        steps_kind = _s if steps_kind is None else steps_kind
    if on_ma_server is None:
        on_ma_server = _looks_like_ma_server()
    if exists is None:
        exists = os.path.exists

    fatal, warn = [], []
    host, port = _url_host_port(url_base)
    cli_path = os.path.join(skill_dir, "cli.py") if skill_dir else ""

    # 1) 报告链接还指着东京测试机。在测试机上这是对的,在 ma_server 上就是死链。
    if host == LIGHTHOUSE_TEST_HOST and on_ma_server:
        fatal.append(
            "MA_URL_BASE={} 指向测试机 {},但这台机器是 ma_server —— 出参里的报告链接"
            "公司网内打不开,而接口会照常返回成功。改成网关地址,或按反代方式配 "
            "https://<网关域名>/api/ma 同源的报告前缀。".format(url_base, LIGHTHOUSE_TEST_HOST))

    # 2) 出参链接指向本机回环。调用方拿到的是一个只有服务器自己能打开的地址。
    if on_ma_server and (host or "").lower() in _LOOPBACK_HOSTS:
        fatal.append(
            "MA_URL_BASE={} 是本机地址,调用方拿到的报告链接打不开。"
            "本机自测可以,正式对外必须换成网关能到的前缀。".format(url_base))

    # 3) 端口不在网关白名单里。方案里白纸黑字:网关目前只转发 8080。
    if on_ma_server and port is not None and port not in _GATEWAY_PORTS:
        warn.append(
            "MA_URL_BASE 的端口是 {},而公司网关目前只转发 {} —— 报告链接大概率"
            "在公司网里点不开。确认这个端口真的对外通,再忽略这条。".format(
                port, "/".join(str(p) for p in _GATEWAY_PORTS)))

    # 4) real 档但发布目录不在。publish_html 遇到这种只是告警降级,
    #    结果就是出参里 report_url=null —— 接口"成功"了但没给东西。
    if runtime == "real" and not exists(public_dir):
        parent = os.path.dirname((public_dir or "").rstrip("/")) or "/"
        if not exists(parent):
            fatal.append(
                "runtime=real,发布目录 {} 不存在,连上级 {} 都没有 —— 报告发不出去,"
                "出参的 report_url 会是 null。确认 MA_PUBLIC_DIR 配对了。".format(public_dir, parent))
        else:
            fatal.append(
                "runtime=real,发布目录 {} 不存在(上级目录在)。publish_html 不会自动建目录,"
                "先 mkdir -p 再起服务。".format(public_dir))

    # 5) 机器和档位对不上。两个方向都只是提醒 —— 先跑一轮 csv 验证是正当操作。
    if on_ma_server and runtime != "real":
        warn.append(
            "这台机器看着是 ma_server(存在 {}),但 MA_RUNTIME={} —— 走的不是 Hive 真数据。"
            "如果是有意先验证链路就忽略;正式对外记得改回 real。".format(_MA_SERVER_MARK, runtime))
    if runtime == "real" and not on_ma_server:
        warn.append(
            "MA_RUNTIME=real 但没找到 {} —— 这台机器不像 ma_server,Hive 取数多半会在 "
            "pull 步失败。".format(_MA_SERVER_MARK))

    # 6) real 档取数脚本不在。每一单都会在第一步倒下,不如启动时就说。
    if runtime == "real" and not exists(hdfs_get):
        fatal.append(
            "runtime=real 但取数脚本不在:{}(MA_HDFS_GET)。每一单都会在 pull 步失败。".format(hdfs_get))

    # 7) 诊断步骤是 skill,但 skill 不在。这个不致命 —— 每步会降级成本地骨架并告警 ——
    #    但报告质量会明显下滑,值得在启动横幅上就看见。
    if steps_kind == "skill" and not exists(cli_path):
        warn.append(
            "找不到 skill 的 cli.py:{}(MA_SKILL_DIR)。诊断各步会降级成本地骨架,"
            "报告质量会掉一档。".format(cli_path))

    # 8) csv 档的数据文件。以前这里默认指着测试机上那份机票 CSV,
    #    在别的机器上就成了"找不到文件"这种莫名其妙的报错,现在默认为空、必须显式给。
    if data_kind == "csv":
        if not csv_path:
            fatal.append(
                "数据源是 csv,但 MA_CSV 没配 —— 没有数据可跑。"
                "export MA_CSV=/绝对路径/xxx.csv(这里以前默认指着测试机上那份机票 CSV,已去掉)")
        elif not exists(csv_path):
            fatal.append("数据源是 csv,但文件不存在:{}(MA_CSV)".format(csv_path))

    return fatal, warn


def format_env_report(fatal, warn, prefix=""):
    """把体检结果排成人能一眼看完的几行。启动横幅和 preflight 共用一份排版。"""
    lines = []
    for m in fatal or []:
        lines.append("{}✗ [环境] {}".format(prefix, m))
    for m in warn or []:
        lines.append("{}⚠ [环境] {}".format(prefix, m))
    return lines


class StepError(Exception):
    """带错误码的流水线失败。code 会原样出现在接口的 error.code 里。"""

    def __init__(self, code, message, detail=None):
        Exception.__init__(self, message)
        self.code = code
        self.message = message
        self.detail = detail


# --------------------------------------------------------------------------- 上下文


class Ctx(object):
    """一次运行的上下文:参数 + 产物目录 + 两个回调(写日志 / 报阶段)。

    回调而不是直接依赖 JobStore,是为了让这个模块能脱离 HTTP 服务单独跑
    (命令行直接 python3 ma_pipeline.py <activity_id> 就能验证)。
    """

    def __init__(self, params, rundir, log=None, set_phase=None):
        self.params = params
        self.rundir = rundir
        self.activity_id = params["activity_id"]
        self.push_source = params.get("push_source") or "model"
        self._log = log or (lambda s: sys.stderr.write(s + "\n"))
        self._set_phase = set_phase or (lambda p: None)
        self.warnings = []
        self.steps = []
        self.skill_degraded = False   # SkillSteps 任何一步退回本地骨架时置位
        self.render_forced = False    # render 被门禁拦下后加了强制开关
        self.render_flags = []        # 具体加了哪几个(出参和 notes 要如实写)
        self.schema_unresolved = 0    # schema 体检修完仍没过的条数
        self.critique = None           # skill 自己的质检结论(None=没问到)
        self.critique_left = 0         # 质检跑完仍没解决的条数
        self.channel_rewrites = 0      # 渠道词汇被改写重渲了几次
        self.meta_guessed = False      # target_products 走默认(从 activity_product_name 取)
        self.products_given = None     # 入参/环境变量显式给的品类
        self.products_inferred = None  # --auto-meta 实际从数据里取到的品类
        self.report_agent = None       # 报告产出交给带工具的 claude 之后的结论
        self.report_banner = None      # 发布时要压在报告顶部的降级横幅(None=不加)
        self.started_at = time.time()  # 任务起点,MA_JOB_DEADLINE 按它算总耗时
        os.makedirs(rundir, exist_ok=True)

    def log(self, msg):
        self._log(msg)

    def phase(self, name):
        self._set_phase(name)
        self.log("── 阶段 {}".format(name))

    def warn(self, msg):
        self.warnings.append(msg)
        self.log("⚠ " + msg)

    def path(self, *parts):
        return os.path.join(self.rundir, *parts)

    def step(self, name, fn):
        """跑一步并记录耗时。异常原样抛出,由 run_pipeline 统一转成 error。"""
        if JOB_DEADLINE > 0:
            spent = time.time() - self.started_at
            if spent > JOB_DEADLINE:
                # 总闸在步骤边界拦:已经超支就别再进下一步了。单步内部的卡死
                # 由 call_claude 的进程组 kill 兜,这里只管"步骤叠加超时"。
                raise StepError("E_JOB_DEADLINE",
                                "任务总耗时 {:.0f}s 已超上限 {}s,不再进入步骤 {}"
                                "(MA_JOB_DEADLINE,设 0 可关)".format(spent, JOB_DEADLINE, name))
        self.phase(name)
        t0 = time.time()
        try:
            out = fn()
        except StepError:
            self.steps.append({"name": name, "ok": False,
                               "elapsed_sec": round(time.time() - t0, 2)})
            raise
        self.steps.append({"name": name, "ok": True,
                           "elapsed_sec": round(time.time() - t0, 2)})
        return out


def run_cmd(ctx, cmd, timeout=None, code="E_STEP_FAILED"):
    """跑子命令,输出并入任务日志。argv 形式,不过 shell。"""
    ctx.log("$ " + " ".join(cmd))
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True,
                              timeout=timeout or STEP_TIMEOUT, env=os.environ.copy())
    except subprocess.TimeoutExpired:
        raise StepError(code, "子命令超时 {}s: {}".format(timeout or STEP_TIMEOUT, cmd[0]))
    except (OSError, ValueError) as exc:
        raise StepError(code, "子命令起不来: {}: {}".format(type(exc).__name__, exc))
    tail = ((proc.stdout or "") + (proc.stderr or "")).strip()
    for line in tail.splitlines()[-30:]:
        ctx.log("  | " + line[:300])
    if proc.returncode != 0:
        # Spark/Java 报错动辄几百行栈帧,detail 只留尾巴 2000 字时,真正的
        # "Caused by: XxxException: 人话原因"那一行经常在更上面被截丢
        # (2026-08-03 hebo 表 pull 失败,出参里只剩 ParquetWriteSupport 栈帧,
        # 根因一行都没有)。这里从**全量**输出里单独抠出异常行,进 detail 也进任务日志。
        exc_lines = [ln.strip()[:300] for ln in tail.splitlines()
                     if re.search(r"Caused by:|Exception(?::| in )|^\s*[A-Za-z.]+Error:",
                                  ln)][:8]
        for ln in exc_lines:
            ctx.log("  !! " + ln)
        raise StepError(code, "子命令失败 exit={}: {}".format(proc.returncode, " ".join(cmd[:4])),
                        detail={"exit_code": proc.returncode, "tail": tail[-2000:],
                                "exceptions": exc_lines})
    return proc.stdout or ""


# --------------------------------------------------------------------------- 数据源


class BaseSource(object):
    """数据源只负责三件事:把数据落到本地一个文件、校验规则、算人数。

    它不知道 skill,也不知道报告。这样"没有 Hive"这件事只影响这一层,
    上面的诊断链路和出参口径原样不动。
    """

    name = "base"
    label = POP_TABLE          # 人数到底是在哪份数据上算出来的(出参 data_source)
    sql_table = POP_TABLE      # 出参 SQL 的 FROM 写什么(出参 source_table)
    id_col = "mapid"
    union_col = "unionid"

    # label 与 sql_table 刻意分开:csv 模式下人数算在本地那份 CSV 上(label),
    # 但给出去的 SQL 必须是能直接拿去生产跑的形状,FROM 后面得是人群池表名(sql_table)。
    # 合成一个字段就只能二选一 —— 要么 SQL 不可执行,要么数据来源被隐去。

    def pull(self, ctx):
        raise NotImplementedError

    def describe_columns(self, ctx):
        """[{name, type, numeric}] —— 给 stub 造规则用,让假规则也长在真列上。"""
        return []

    def quantile(self, ctx, col, q):
        return None

    def base_where(self, ctx):
        """人群池查询与出参 SQL 的公共前置谓词(如活动过滤)。默认无。"""
        return None

    def row_count(self, ctx):
        return None

    def validate_rules(self, ctx, rules):
        raise NotImplementedError

    def count_rules(self, ctx, rules):
        raise NotImplementedError

    def count_push_total(self, ctx, rules):
        raise NotImplementedError

    def fix_sql(self, s):
        """列名被改写过时,把规则里的原名换成表里的实际名。默认不改。"""
        return s

    def close(self):
        pass


class _NoSource(BaseSource):
    """骨架兜底的兜底:不摸任何外部系统。取列返回空,build_stub_state 会造出
    "无列骨架"(形状完整、规则退化为 id 非空一条)——用于真数据源卡死/失败时,
    让降级路径本身也有出路,而不是冻死在 phase=prepare(fix17,1011270 单教训)。"""

    name = "none"

    def describe_columns(self, ctx):
        return []


class HiveSource(BaseSource):
    """ma_server 上的真数据源:hdfs_get 拉特征,Spark 在人群池上校验/计数。"""

    name = "hive"

    def __init__(self):
        self._spark = None
        self.label = POP_TABLE

    def pull(self, ctx):
        data_path = ctx.path("data.parquet")
        if ctx.params.get("skip_pull") and os.path.exists(data_path):
            ctx.log("skip_pull:data.parquet 已存在,跳过拉取")
            return data_path
        # 2026-07-30 定的口径:特征表是一张固定表、没有分区,取数只按 activity_id 过滤,
        # 不传 --partition(原入参 pull_partition 已随契约收窄一并取消)。
        # 正式表名定下来后 export MA_FEAT_TABLE=<那张表> 即可,代码不用动。
        # 另:整条链路对这张表只有读 —— 圈人计数也全是 SELECT,没有任何写入。
        cmd = [SKILL_PY, HDFS_GET, "--table", FEAT_TABLE,
               "--where", "{}='{}'".format(ctx.params.get("filter_col") or FILTER_COL, ctx.activity_id),
               "--output", data_path]
        run_cmd(ctx, cmd, code="E_PULL_FAILED")
        return data_path

    def _get_spark(self):
        if self._spark is None:
            try:
                import findspark
                findspark.init()
                from pyspark.sql import SparkSession
            except ImportError as exc:
                raise StepError("E_NO_SPARK", "hive 数据源需要 pyspark/findspark: {}".format(exc))
            self._spark = SparkSession.builder.appName("ma_api_push").enableHiveSupport().getOrCreate()
            self._spark.conf.set("spark.sql.shuffle.partitions", "64")
        return self._spark

    def describe_columns(self, ctx):
        spark = self._get_spark()
        out = []
        for n, t in spark.table(POP_TABLE).dtypes:
            out.append({"name": n, "type": t,
                        "numeric": t.split("(")[0] in ("int", "bigint", "smallint", "tinyint",
                                                       "double", "float", "decimal", "long")})
        return out

    def base_where(self, ctx):
        """两表合一时,人群池查询限定本活动:{FILTER_COL}='{activity_id}'(见 MA_POP_FILTER)。"""
        if POP_FILTER in ("0", "false", "no", "off"):
            return None
        if POP_FILTER in ("1", "true", "yes", "on") or POP_TABLE == FEAT_TABLE:
            col = (ctx.params or {}).get("filter_col") or FILTER_COL
            return "{}='{}'".format(col, ctx.activity_id)
        return None

    def quantile(self, ctx, col, q):
        spark = self._get_spark()
        sql = "SELECT percentile_approx({}, {}) AS v FROM {}".format(col, q, POP_TABLE)
        bw = self.base_where(ctx)
        if bw:
            sql += " WHERE {}".format(bw)
        row = spark.sql(sql).collect()[0]
        return row["v"]

    def validate_rules(self, ctx, rules):
        """LIMIT 0 dry-run:缺列/语法错一次拿到,单条失败只跳过该条。"""
        spark = self._get_spark()
        ok, dropped = [], []
        for r in rules:
            try:
                spark.sql("SELECT 1 FROM {} WHERE ({}) LIMIT 0".format(POP_TABLE, r["sql_filter"]))
                ok.append(r)
            except Exception as exc:  # noqa: BLE001 —— Spark 抛的是 Py4J 包装异常,类型不稳定
                dropped.append({"name": r.get("name"), "reason": str(exc).splitlines()[0][:200]})
        return ok, dropped

    def count_rules(self, ctx, rules):
        """一趟 SUM(CASE WHEN) 拿到每条规则在人群池上的实际命中数。"""
        if not rules:
            return
        spark = self._get_spark()
        agg = ", ".join("SUM(CASE WHEN ({}) THEN 1 ELSE 0 END) AS c{}".format(r["sql_filter"], i)
                        for i, r in enumerate(rules))
        sql = "SELECT {} FROM {}".format(agg, POP_TABLE)
        bw = self.base_where(ctx)
        if bw:
            sql += " WHERE {}".format(bw)
        row = spark.sql(sql).collect()[0]
        for i, r in enumerate(rules):
            r["population_size"] = int(row["c{}".format(i)] or 0)

    def count_push_total(self, ctx, rules):
        """去重后的推送人数 —— 出参里唯一权威的那个数。"""
        if not rules:
            return 0
        spark = self._get_spark()
        pred = " OR ".join("({})".format(r["sql_filter"]) for r in rules)
        bw = self.base_where(ctx)
        if bw:
            pred = "{} AND ({})".format(bw, pred)
        row = spark.sql("SELECT COUNT(DISTINCT {}) AS n FROM {} WHERE {}".format(
            self.id_col, POP_TABLE, pred)).collect()[0]
        return int(row["n"] or 0)

    def close(self):
        if self._spark is not None:
            try:
                self._spark.stop()
            except Exception:  # noqa: BLE001
                pass
            self._spark = None


# ---- 本地 sqlite 数据源(csv / synth 共用同一套校验计数) ----


_IDENT_OK = re.compile(r"[^0-9A-Za-z_-￿]")


def safe_ident(name, idx):
    """SQLite 允许 >=0x80 的字符做裸标识符,所以中文列名可以原样留;
    只把空格/括号/点号这类会断句的字符换掉。"""
    s = _IDENT_OK.sub("_", (name or "").strip())
    if not s or s[0].isdigit():
        s = "c{}_{}".format(idx, s)
    return s


def sniff_type(values):
    """整列全是整数→INTEGER,全是数字→REAL,否则 TEXT。空串当缺失,不参与判定。"""
    seen = False
    all_int = True
    for v in values:
        if v is None or v == "":
            continue
        seen = True
        try:
            int(v)
        except (TypeError, ValueError):
            all_int = False
            try:
                float(v)
            except (TypeError, ValueError):
                return "TEXT"
    if not seen:
        return "TEXT"
    return "INTEGER" if all_int else "REAL"


class SqliteSource(BaseSource):
    """把一份本地表格装进内存 sqlite,规则的 dry-run 和计数全部真跑。

    这一层的意义:服务器上没有 Hive,但"规则写错会被剔掉""mapid 必须去重"
    这两条口径不能因此变成口头承诺 —— 放在 sqlite 上照样是被执行验证的。
    """

    def __init__(self):
        self._conn = None
        self._cols = []          # [{name, safe, type}]
        self._rename = {}        # 原名 -> 安全名(仅在真改了名时有条目)

    # 子类实现:返回 (表头 list, 行迭代器)
    def _rows(self, ctx):
        raise NotImplementedError

    def _db(self, ctx):
        if self._conn is not None:
            return self._conn
        import sqlite3
        header, rows = self._rows(ctx)
        rows = list(rows)
        safe = []
        for i, h in enumerate(header):
            s = safe_ident(h, i)
            if s != h:
                self._rename[h] = s
            safe.append(s)
        # 同名去重(sanitize 之后可能撞车)
        used = {}
        for i, s in enumerate(safe):
            if s in used:
                used[s] += 1
                safe[i] = "{}_{}".format(s, used[s])
            else:
                used[s] = 0
        types = [sniff_type([r[i] if i < len(r) else None for r in rows[:2000]])
                 for i in range(len(header))]
        self._cols = [{"name": header[i], "safe": safe[i], "type": types[i]}
                      for i in range(len(header))]
        conn = sqlite3.connect(":memory:")
        conn.execute("CREATE TABLE pop ({})".format(
            ", ".join("{} {}".format(c["safe"], c["type"]) for c in self._cols)))
        ph = ",".join("?" * len(self._cols))

        def _cast(v, t):
            if v is None or v == "":
                return None
            if t == "INTEGER":
                try:
                    return int(v)
                except (TypeError, ValueError):
                    return None
            if t == "REAL":
                try:
                    return float(v)
                except (TypeError, ValueError):
                    return None
            return v

        def _feed(src, cols):
            """边喂边释放:src 是本函数独占的列表,插一批就丢一批。

            这里刻意不写成列表推导。50000 行 x 221 列的真实文件,
            列表推导会让「原始行」和「转换后的元组」同时压在内存里,
            叠上 sqlite 自己那一份,3.7G 的机器会被推到边缘。
            """
            m = len(cols)
            step = 2000
            while src:
                chunk = src[:step]
                del src[:step]
                for r in chunk:
                    yield tuple(_cast(r[i] if i < len(r) else None, cols[i]["type"])
                                for i in range(m))

        conn.executemany("INSERT INTO pop VALUES ({})".format(ph),
                         _feed(rows, self._cols))
        conn.commit()
        del rows
        self._conn = conn
        self._resolve_keys(ctx)
        n = conn.execute("SELECT COUNT(*) FROM pop").fetchone()[0]
        d = conn.execute("SELECT COUNT(DISTINCT {}) FROM pop".format(self.id_col)).fetchone()[0]
        ctx.log("人群池装载完成:{} 行 / {} 列,主键 {} 去重后 {} 个,unionid 列 {}".format(
            n, len(self._cols), self.id_col, d, self.union_col))
        if n and d == n:
            ctx.log("提示:本数据里 {} 本身就唯一,去重不会减少人数(口径仍然保留)".format(self.id_col))
        if self._rename:
            ctx.log("列名改写 {} 个(空格/括号等会断句的字符已换成下划线)".format(len(self._rename)))
        return conn

    def _resolve_keys(self, ctx):
        """确定主键列与 unionid 列。宁可显式告警,也不猜错了闷着跑。"""
        names = [c["safe"] for c in self._cols]
        lower = dict((c["safe"].lower(), c["safe"]) for c in self._cols)

        def pick(env_name, cands, what):
            want = os.environ.get(env_name)
            if want:
                if want in names:
                    return want
                if want.lower() in lower:
                    return lower[want.lower()]
                raise StepError("E_BAD_COLUMN", "{} 指定的列 {} 不在数据里;可用列:{}".format(
                    env_name, want, ",".join(names[:30])))
            for c in cands:
                if c in lower:
                    return lower[c]
            for c in cands:
                for nm in names:
                    if c in nm.lower():
                        ctx.warn("没找到{}列,按名字近似选用 {}".format(what, nm))
                        return nm
            return None

        self.id_col = pick("MA_ID_COL", ["mapid", "map_id", "memberid", "member_id",
                                         "unionid", "openid", "uid", "user_id"], "主键")
        if not self.id_col:
            self.id_col = names[0]
            ctx.warn("数据里没有 mapid 之类的主键列,退而用第一列 {} 当去重键;"
                     "如不正确请用 MA_ID_COL 指定".format(self.id_col))
        self.union_col = pick("MA_UNION_COL", ["unionid", "union_id", "wx_unionid", "openid"], "unionid")
        if not self.union_col:
            self.union_col = self.id_col
            ctx.warn("数据里没有 unionid 列,出参的 unionid 用 {} 顶替".format(self.id_col))

    def fix_sql(self, s):
        if not self._rename or not s:
            return s
        for old, new in self._rename.items():
            s = re.sub(r"(?<![0-9A-Za-z_])" + re.escape(old) + r"(?![0-9A-Za-z_])", new, s)
        return s

    def describe_columns(self, ctx):
        self._db(ctx)
        return [{"name": c["safe"], "type": c["type"], "numeric": c["type"] in ("INTEGER", "REAL")}
                for c in self._cols]

    def quantile(self, ctx, col, q):
        conn = self._db(ctx)
        n = conn.execute("SELECT COUNT(*) FROM pop WHERE {} IS NOT NULL".format(col)).fetchone()[0]
        if not n:
            return None
        off = max(0, min(n - 1, int(n * q)))
        row = conn.execute("SELECT {c} FROM pop WHERE {c} IS NOT NULL ORDER BY {c} LIMIT 1 OFFSET {o}".format(
            c=col, o=off)).fetchone()
        return row[0] if row else None

    def row_count(self, ctx):
        return int(self._db(ctx).execute("SELECT COUNT(*) FROM pop").fetchone()[0])

    def validate_rules(self, ctx, rules):
        conn = self._db(ctx)
        ok, dropped = [], []
        for r in rules:
            f = self.fix_sql(r.get("sql_filter"))
            try:
                conn.execute("SELECT 1 FROM pop WHERE ({}) LIMIT 0".format(f)).fetchall()
                r["sql_filter"] = f
                ok.append(r)
            except Exception as exc:  # noqa: BLE001 —— sqlite3.OperationalError 等
                dropped.append({"name": r.get("name"), "sql_filter": r.get("sql_filter"),
                                "reason": str(exc).splitlines()[0][:200]})
        return ok, dropped

    def count_rules(self, ctx, rules):
        if not rules:
            return
        conn = self._db(ctx)
        agg = ", ".join("SUM(CASE WHEN ({}) THEN 1 ELSE 0 END)".format(r["sql_filter"]) for r in rules)
        row = conn.execute("SELECT {} FROM pop".format(agg)).fetchone()
        for i, r in enumerate(rules):
            r["population_size"] = int(row[i] or 0)

    def count_push_total(self, ctx, rules):
        if not rules:
            return 0
        conn = self._db(ctx)
        pred = " OR ".join("({})".format(r["sql_filter"]) for r in rules)
        return int(conn.execute("SELECT COUNT(DISTINCT {}) FROM pop WHERE {}".format(
            self.id_col, pred)).fetchone()[0] or 0)

    def close(self):
        if self._conn is not None:
            self._conn.close()
            self._conn = None


class CsvSource(SqliteSource):
    """用一份本地 CSV 顶替 Hive 人群池。服务器上没有取数能力时的正式通路,
    不是玩具:表头、类型、行数都按真文件来,规则照样在这份数据上被验证。"""

    name = "csv"

    def __init__(self):
        SqliteSource.__init__(self)
        self.path = CSV_PATH
        self.label = "csv:{}".format(self.path or "(MA_CSV 未配置)")
        self.encoding = None

    # 嗅探样本大小。取 4MB 是因为要压住"表头 ASCII、中文全在数据行里"这种情况,
    # 又不至于为了猜编码把 100MB 的文件整个读一遍。
    PROBE_BYTES = 4 << 20

    def _sniff(self):
        """挑编码。

        原来的写法只解第一行就定编码 —— 在真实的机票明细表上会稳稳地选错:
        那张表 221 列的表头全是 ASCII(mapid/deviceid/activity_name…),中文在数据行里,
        于是 utf-8 在第一行轻松通过,然后在第 2 行的 0xcc 上炸掉,而且是在 _open 返回之后
        才炸,fallback 根本没机会接。所以要拿一大段真实内容去试,试的范围得覆盖会被解析的部分。
        """
        if not self.path:
            raise StepError(
                "E_CSV_NOT_SET",
                "数据源是 csv 但 MA_CSV 没配。export MA_CSV=/绝对路径/xxx.csv 再起服务"
                "(这个默认值以前指着测试机上的 /home/ubuntu/特价机票-正式.csv,已经去掉了)")
        try:
            with open(self.path, "rb") as f:
                blob = f.read(self.PROBE_BYTES)
        except (IOError, OSError) as exc:
            raise StepError("E_CSV_NOT_FOUND", "读不到 CSV {}: {}".format(self.path, exc))
        if not blob:
            raise StepError("E_CSV_EMPTY", "CSV 是空的:{}".format(self.path))

        truncated = len(blob) == self.PROBE_BYTES
        last = None
        for enc in ([CSV_ENCODING] if CSV_ENCODING else []) + ["utf-8-sig", "utf-8", "gb18030", "latin-1"]:
            probe = blob
            # 截断点可能正好把一个多字节字符劈成两半,那不算这个编码不行,往回退几个字节再试。
            for _ in range(5):
                try:
                    probe.decode(enc)
                    return enc
                except UnicodeDecodeError as exc:
                    last = exc
                    if truncated and exc.start >= len(probe) - 4:
                        probe = probe[:-1]
                        continue
                    break
                except LookupError as exc:
                    last = exc
                    break
        raise StepError("E_CSV_ENCODING", "CSV 编码识别失败 {}:{};可用 MA_CSV_ENCODING 显式指定".format(
            self.path, last))

    def _open(self):
        if not self.encoding:
            self.encoding = self._sniff()
        try:
            return open(self.path, encoding=self.encoding, newline="")
        except (IOError, OSError) as exc:
            raise StepError("E_CSV_NOT_FOUND", "读不到 CSV {}: {}".format(self.path, exc))

    def _rows(self, ctx):
        import csv
        f = self._open()
        try:
            rd = csv.reader(f)
            try:
                header = next(rd)
            except StopIteration:
                raise StepError("E_CSV_EMPTY", "CSV 是空的:{}".format(self.path))
            rows, capped = [], False
            try:
                for r in rd:
                    if len(rows) >= CSV_MAX_ROWS:
                        capped = True
                        break
                    rows.append(r)
            except UnicodeDecodeError as exc:
                # 嗅探只看了文件头部,坏字节藏在更后面时会走到这里。
                # 与其让它冒成 E_INTERNAL,不如给个能直接照做的错。
                raise StepError("E_CSV_ENCODING",
                                "CSV 第 {} 行附近按 {} 解不开(编码嗅探只看了前 {}MB):{};"
                                "用 MA_CSV_ENCODING 显式指定编码".format(
                                    len(rows) + 2, self.encoding,
                                    self.PROBE_BYTES >> 20, exc))
        finally:
            f.close()
        ctx.log("CSV {} 编码 {},读入 {} 行".format(os.path.basename(self.path), self.encoding, len(rows)))
        if capped:
            ctx.warn("CSV 超过 MA_CSV_MAX_ROWS={} 行,只装载了前 {} 行,人数会偏小".format(
                CSV_MAX_ROWS, len(rows)))
        return header, rows

    def pull(self, ctx):
        """"拉数"在 CSV 模式下就是把源文件复制进本次运行目录 —— 留证据,也让 skill 有东西可读。"""
        if not os.path.exists(self.path):
            raise StepError("E_CSV_NOT_FOUND", "指定的 CSV 不存在:{}".format(self.path))
        dst = ctx.path("data.csv")
        shutil.copyfile(self.path, dst)
        ctx.log("数据源 = 本地 CSV {}({} 字节),已复制到运行目录".format(
            self.path, os.path.getsize(self.path)))
        self._db(ctx)
        return dst


class SynthSource(SqliteSource):
    """谁都不依赖的合成数据源。只用来验证状态机,人数不具备任何业务含义。"""

    name = "synth"

    def __init__(self):
        SqliteSource.__init__(self)
        self.label = "synth:memory"

    def _rows(self, ctx):
        return [c for c, _ in STUB_COLUMNS], gen_rows(ctx.activity_id)

    def pull(self, ctx):
        p = write_rows_csv(ctx.path("data.csv"), gen_rows(ctx.activity_id))
        ctx.log("未连 Hive/HDFS,已生成合成样本 {}".format(os.path.basename(p)))
        self._db(ctx)
        return p


STUB_COLUMNS = [
    ("mapid", "TEXT"),
    ("unionid", "TEXT"),
    ("task_id", "TEXT"),
    ("pre_order_cnt_30d", "INTEGER"),
    ("pre_gmv_90d", "REAL"),
    ("pre_last_active_days", "INTEGER"),
    ("pre_is_member", "INTEGER"),
    ("pre_coupon_used_30d", "INTEGER"),
    ("pre_city_level", "INTEGER"),
    ("is_convert", "INTEGER"),
]


def gen_rows(activity_id, n=None):
    """造一份确定性的合成样本。

    两个刻意为之的性质:
      - 8% 的行复用已有 mapid —— 人群池里 mapid 本来就不唯一,
        造出重复,size.push 的 COUNT(DISTINCT) 才是真在做去重
      - is_convert 与几个特征弱相关 —— 否则任何模型步都只能学出常数
    """
    n = n or STUB_ROWS
    rnd = random.Random(int(hashlib.sha256(activity_id.encode("utf-8")).hexdigest()[:12], 16))
    rows = []
    for i in range(n):
        if i and rnd.random() < 0.08:
            mapid = rows[rnd.randrange(len(rows))][0]
        else:
            mapid = "m{:08d}".format(rnd.randrange(10 ** 8))
        order_cnt = rnd.choice([0, 0, 0, 1, 1, 2, 3, 5, 8])
        gmv = round(rnd.expovariate(1 / 220.0), 2)
        last_active = rnd.choice([1, 2, 3, 7, 14, 30, 60, 90, 180])
        is_member = 1 if rnd.random() < 0.31 else 0
        p = 0.04 + 0.05 * min(order_cnt, 4) + (0.06 if is_member else 0) \
            + (0.07 if last_active <= 7 else 0) + min(gmv, 800) / 8000.0
        rows.append((
            mapid,
            "u{:010d}".format(rnd.randrange(10 ** 10)),
            activity_id,
            order_cnt,
            gmv,
            last_active,
            is_member,
            rnd.choice([0, 0, 0, 1, 2]),
            rnd.choice([1, 2, 2, 3, 3, 4, 5]),
            1 if rnd.random() < min(p, 0.85) else 0,
        ))
    return rows


def write_rows_csv(path, rows):
    import csv
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow([c for c, _ in STUB_COLUMNS])
        w.writerows(rows)
    return path


# --------------------------------------------------------------------------- 诊断步骤


def _assert_filters_survived(ctx, state_draft, rules_path):
    """退出码 0 不等于「产出可用」,这一步专门堵这个洞。

    实测(3.7G 的 Lighthouse,没装 pandas):skill 的 crowd-rules 会「成功」返回
    一份 sql_filter 全是空串的规则表 —— 名字、direction、finding_id 都在,
    唯独过滤条件没了。这种静默的空产出比直接报错危险得多:它会一路顺到出参里,
    变成 size.push=0,读起来像「这批人里确实没人该推」,实际是工具压根没算。
    所以在这里主动判失败,交回 _try 去降级;strict 模式下就该整单失败。
    """
    try:
        rules = _load(rules_path)
        segs = (_load(state_draft) or {}).get("audience_segments") or []
    except Exception:  # noqa: BLE001 - 读不动就不拦,交给下游按老路子报
        return
    if not segs:
        return
    ok = [r for r in (rules or [])
          if r.get("source") == "audience_segment" and (r.get("sql_filter") or "").strip()]
    if ok:
        return
    raise StepError("E_CROWD_RULES_EMPTY",
                    "crowd-rules 退出码 0,但 {} 条人群段里没有一条带得上 sql_filter".format(len(segs)))


# skill 的 render 有两道门禁,过不去就非零退出,并在 stderr 里点名该加哪个开关。
# 老代码只认第一道(完备性),第二道(schema)一来就直接抛 —— _try 转手降级成
# StubSteps.render,产出的是我写的应急骨架页,样式跟正版模板完全是两回事。
# 用户连着两次说「html 格式不对」,就是这张应急页。
#
# 宁可出正版模板 + 如实标注哪一关是硬闯的,也不要样式全非的应急页。
# 每一项:(开关, 在 stderr 里认这些关键词, (门禁叫什么, 硬闯之后要如实说明什么))
RENDER_FORCE_FLAGS = (
    ("--skip-completeness",
     ("INCOMPLETE_REPORT", "completeness"),
     ("完备性门禁", "正文可能仍残留草稿骨架句")),
    ("--skip-validate",
     ("schema error", "schema validate", "--skip-validate"),
     ("schema 门禁", "个别字段没满足 skill 的字数/格式硬规矩")),
)


class SkillSteps(object):
    """真调 marketing-audit 的 cli.py。

    每一步都可降级:MA_SKILL_STRICT=0 时,某一步失败就退回本地骨架并告警,
    整单继续跑完。第一次在新机器上跑,需要的是一份"哪一步能跑哪一步不能"的完整记录,
    而不是在第一步就停下。
    """

    name = "skill"

    def __init__(self):
        self._help = None
        self._fallback = StubSteps()

    def _ensure(self, ctx):
        if self._help is not None:
            return self._help
        if not os.path.exists(MA_CLI):
            raise StepError("E_NO_SKILL", "找不到 marketing-audit 的 cli.py:{}".format(MA_CLI))
        try:
            proc = subprocess.run([SKILL_PY, MA_CLI, "--help"], capture_output=True,
                                  text=True, timeout=120)
            self._help = (proc.stdout or "") + (proc.stderr or "")
        except Exception as exc:  # noqa: BLE001
            self._help = ""
            ctx.warn("cli.py --help 没跑通({}),后续子命令按原样尝试".format(exc))
        ctx.log("skill 就绪:{}".format(MA_CLI))
        return self._help

    def _has(self, sub):
        return (not self._help) or (sub in self._help)

    @staticmethod
    def _dump_detail(ctx, label, exc):
        """把 StepError.detail 里的真实 stderr 落盘 + 进日志。

        以前这里什么都不做,detail 直接被丢掉,结果线上只看得到
        「E_PREPARE_FAILED 子命令失败 exit=1」这一句,查不出到底哪儿炸的。
        """
        detail = getattr(exc, "detail", None) or {}
        tail = (detail.get("tail") or "").strip()
        if not tail:
            return
        safe = "".join(c if (c.isalnum() or c in "-_") else "_" for c in label)
        try:
            p = ctx.path("skill_error_{}.txt".format(safe))
            with open(p, "w", encoding="utf-8") as fh:
                fh.write("exit_code={}\n\n".format(detail.get("exit_code")))
                fh.write(tail)
            ctx.log("  ↳ 真实报错已存 {}".format(os.path.basename(p)))
        except OSError as err:
            ctx.log("  ↳ 报错落盘失败:{}".format(err))
        for line in tail.splitlines()[-12:]:
            ctx.log("  ! " + line[:300])

    def _try(self, ctx, label, real_fn, fallback_fn):
        self._ensure(ctx)
        try:
            return real_fn()
        except StepError as exc:
            if SKILL_STRICT:
                raise
            ctx.warn("skill 的 {} 失败({}: {}),本步降级为本地骨架".format(label, exc.code, exc.message))
            self._dump_detail(ctx, label, exc)
            ctx.skill_degraded = True
            return fallback_fn()

    def prepare(self, ctx, source, data_path):
        def _real():
            run_cmd(ctx, [SKILL_PY, MA_CLI, "prepare", "--data", data_path,
                          "--meta", build_prepare_meta(ctx),
                          "--auto-meta", "--out", ctx.rundir], code="E_PREPARE_FAILED")
            p = ctx.path("state_partial.json")
            if not os.path.exists(p):
                raise StepError("E_PREPARE_FAILED", "prepare 没产出 state_partial.json")
            return p
        return self._try(ctx, "prepare", _real,
                         lambda: self._fallback.prepare(ctx, source, data_path))

    def compute_thresholds(self, ctx, source, data_path, state_partial):
        def _real():
            run_cmd(ctx, [SKILL_PY, MA_CLI, "compute-thresholds", "--data", data_path,
                          "--state", state_partial, "--out", ctx.rundir], code="E_THRESHOLDS_FAILED")
        return self._try(ctx, "compute-thresholds", _real,
                         lambda: self._fallback.compute_thresholds(ctx, source, data_path, state_partial))

    def draft(self, ctx, source, state_partial):
        def _real():
            run_cmd(ctx, [SKILL_PY, MA_CLI, "draft", "--state", state_partial,
                          "--out", ctx.rundir], code="E_DRAFT_FAILED")
            p = ctx.path("state_draft.json")
            if not os.path.exists(p):
                raise StepError("E_DRAFT_FAILED", "draft 没产出 state_draft.json")
            return p
        return self._try(ctx, "draft", _real, lambda: self._fallback.draft(ctx, source, state_partial))

    def crowd_rules(self, ctx, source, state_draft):
        def _real():
            run_cmd(ctx, [SKILL_PY, MA_CLI, "crowd-rules", "--state", state_draft,
                          "--out", ctx.rundir], code="E_CROWD_RULES_FAILED")
            p = ctx.path("crowd_rules.json")
            if not os.path.exists(p):
                raise StepError("E_CROWD_RULES_FAILED", "crowd-rules 没产出 crowd_rules.json")
            _assert_filters_survived(ctx, state_draft, p)
            return p
        return self._try(ctx, "crowd-rules", _real,
                         lambda: self._fallback.crowd_rules(ctx, source, state_draft))

    def validate(self, ctx, state_path):
        """问 skill:这份 state 过不过得了它自己的 schema 门禁。

        返回 [] 表示过了,返回清单表示没过,返回 None 表示问不出来(不猜)。
        优先用 cli.py 的 validate 子命令;没有就拿 render 往临时目录空跑一次 ——
        render 是先校验再出图,校验挂了不会写文件,这个代价换"提前知道"值得。
        """
        self._ensure(ctx)
        tmp = ctx.path("_schema_check")
        try:
            if not os.path.isdir(tmp):
                os.makedirs(tmp)
        except OSError:
            return None
        # 注意不能用 self._has():它在探测不到 --help 时返回 True,那会去跑一个
        # 可能根本不存在的子命令,argparse 的 "invalid choice: 'validate'" 里恰好带
        # validate 这个词,一路会被误当成"schema 没报错"。宁可退回 render 空跑。
        if self._help and "validate" in self._help:
            base = [SKILL_PY, MA_CLI, "validate", "--state", state_path]
        else:
            base = [SKILL_PY, MA_CLI, "render", "--state", state_path, "--out", tmp]
        # 完备性门禁排在 schema 前面。草稿句还没清干净的时候它先拦,
        # 我们就永远问不到 schema 这层 —— 所以被它拦下要补开关再问一次。
        for flags in ([], ["--skip-completeness"]):
            try:
                run_cmd(ctx, base + flags, code="E_SCHEMA_CHECK")
                return []                       # 整个 render 都跑通了,两道门禁都过了
            except StepError as exc:
                tail = ((getattr(exc, "detail", None) or {}).get("tail") or "")
                items = parse_schema_errors(tail) if _looks_schema(tail) else []
                if items:
                    return items
                # 渠道词汇门禁排在 schema 后面,可它一拦,后面就全问不到了。
                # 以前这里认不出它、返回 None,于是 schema 体检整段被跳过 ——
                # 渠道违规顺手把 schema 问题一起挡在门外,等 render 才发现,
                # 那时候已经没有重写窗口。如实报上去,让调用方先把渠道词修掉。
                if "REWRITE_REQUIRED" in tail:
                    return ChannelGate(tail)
                if flags or "INCOMPLETE_REPORT" not in tail:
                    break
        # 失败了、又一条都抠不出来:可能是环境问题,也可能是我看不懂的新格式。
        # 一律当"问不出来"处理,绝不返回空清单 —— 空清单的意思是"体检通过"。
        return None

    def self_critique(self, ctx, state_path, rnd=1):
        """跑 skill 自己的质检:cli run-tools --tools self_critique。

        这是 skill 推荐流程里的第 8 步(SKILL.md:润色 → run-tools self_critique → render),
        以前这条链路整个跳过了 —— 我在外面另写了一套字数体检,却没用它自带的那套。
        它是纯 Python、不需要模型,方案 C 完全跑得动;而且它会顺手自动修掉
        language_compliance 那一类(规则编号→中文名),写回同一个 state 文件。

        返回 issue 清单;跑不通返回 None(表示"没问到",不等于"没问题")。
        """
        self._ensure(ctx)
        if not self._has("run-tools"):
            ctx.log("skill 的 cli 没有 run-tools 子命令,跳过自带质检")
            return None
        cmd = [SKILL_PY, MA_CLI, "run-tools", "--state", state_path,
               "--out", ctx.rundir, "--tools", "self_critique",
               "--critique-round", str(rnd)]
        try:
            out = run_cmd(ctx, cmd, code="E_CRITIQUE_FAILED")
        except StepError as exc:
            ctx.warn("skill 自带质检没跑通({}),本轮跳过".format(exc.message))
            self._dump_detail(ctx, "self_critique_r{}".format(rnd), exc)
            return None
        for line in (out or "").splitlines():
            line = line.strip()
            if line:
                ctx.log("  [critique] " + line[:300])
        # run-tools 是原地改写 state 文件的,必须重新读,不能拿内存里的旧对象
        try:
            state = _load(state_path)
        except (IOError, OSError, ValueError) as exc:
            ctx.warn("质检后读不回 state({})".format(exc))
            return None
        return list(state.get("self_critique") or [])

    def status(self, ctx, state_path):
        """问一句 skill:这份 state 现在还缺什么。只看不改,失败不影响主流程。

        排查现场只有一张终端截图的时候,这几行是 skill 自己的判词,
        比我这边任何一句转述都可信。
        """
        self._ensure(ctx)
        if not SKILL_STATUS or not self._has("status"):
            return None
        try:
            out = run_cmd(ctx, [SKILL_PY, MA_CLI, "status", "--state", state_path],
                          code="E_STATUS")
        except StepError as exc:
            ctx.log("skill status 没跑通({}),跳过".format(exc.message))
            return None
        for line in (out or "").splitlines()[:60]:
            if line.strip():
                ctx.log("  [status] " + line.rstrip()[:300])
        return out

    def render(self, ctx, source, state_full, on_rewrite=None):
        def _real():
            base = [SKILL_PY, MA_CLI, "render", "--state", state_full, "--out", ctx.rundir]
            flags = []
            tries = 0
            # 每失败一次就按 stderr 里的关键词补一个强制开关再来;开关都补过了还失败,
            # 才是真失败。两道门禁可能接连拦,所以要循环而不是只重试一次。
            #
            # 渠道词汇门禁(REWRITE_REQUIRED)是例外:它没有、也不该有强制开关。
            # skill 的方法论把它定成"最高优先级阻塞",并明写不得用 --allow-channel-lint 绕过。
            # 所以撞上它只有一条路 —— 按它给的修正指令改文案,再重渲。
            for _ in range(len(RENDER_FORCE_FLAGS) + CHANNEL_TRIES + 1):
                try:
                    run_cmd(ctx, base + flags, code="E_RENDER_FAILED")
                    break
                except StepError as exc:
                    tail = ((getattr(exc, "detail", None) or {}).get("tail") or "")
                    if "REWRITE_REQUIRED" in tail:
                        self._dump_detail(ctx, "render_gate_channel_r{}".format(tries + 1), exc)
                        if on_rewrite is None or tries >= CHANNEL_TRIES:
                            raise
                        tries += 1
                        if not on_rewrite(tail, tries):
                            raise
                        ctx.channel_rewrites = getattr(ctx, "channel_rewrites", 0) + 1
                        continue                     # 改完重渲,一个开关都不加
                    hit = [it for it in RENDER_FORCE_FLAGS
                           if it[0] not in flags and any(k in tail for k in it[1])]
                    if not hit:
                        raise
                    for flag, _keys, (gate, caveat) in hit:
                        self._dump_detail(ctx, "render_gate_" + flag.strip("-"), exc)
                        flags.append(flag)
                        ctx.render_flags = list(flags)
                        ctx.warn("render 被{}拦下,加 skill 自己给的 {} 强制产出"
                                 "(样式为正版模板,{})".format(gate, flag, caveat))
                    ctx.render_forced = True
            html = ctx.path("diagnosis_report.html")
            if not os.path.exists(html):
                raise StepError("E_RENDER_FAILED", "render 没产出 diagnosis_report.html")
            return html
        return self._try(ctx, "render", _real,
                         lambda: self._fallback.render(ctx, source, state_full))


class StubSteps(object):
    """不调 skill,本地造一份形状对齐的 state。

    规则不是写死的常量:它们长在数据源真实存在的数值列上,阈值取自这份数据的分位数。
    所以在 CSV 模式下,即使 skill 全挂,圈出来的人数也仍然是这份 CSV 上的真实计数。
    """

    name = "stub"

    def prepare(self, ctx, source, data_path):
        p = ctx.path("state_partial.json")
        # fix17:骨架构建要摸 Hive(取列名+一串分位数),给它硬上限 + 双兜底 ——
        # 1011270 单(2026-08-04)prepare 超时降级后,任务冻死在这里 25 分钟以上:
        # updated_at 不动、无日志、无子进程,监测只能判"疑似挂死"。
        # 超时或异常都退化为无列骨架(_NoSource):形状完整、无真列规则,流水线继续走。
        # 只有 hive 源进看门狗线程:本地源(synth/csv)瞬时完成,且 sqlite 连接绑创建线程,
        # 挪进子线程反而必炸(regress_direction 哨兵实测),维持原路径。
        if not isinstance(source, HiveSource):
            _dump(p, build_stub_state(ctx, source))
            return p
        box = {}

        def _build():
            try:
                box["state"] = build_stub_state(ctx, source)
            except Exception as exc:  # noqa: BLE001 —— 兜底路径不允许任何异常外逸
                box["err"] = exc

        t = threading.Thread(target=_build, name="stub-prepare", daemon=True)
        t.start()
        t.join(STUB_TIMEOUT if STUB_TIMEOUT > 0 else None)
        if t.is_alive():
            ctx.warn("本地骨架构建超过 {}s(疑似数据源/Spark 卡住),放弃取真列,"
                     "改用无列骨架继续 —— 本单无圈人规则(MA_STUB_TIMEOUT 可调)".format(STUB_TIMEOUT))
            box.pop("state", None)
        elif box.get("err") is not None:
            ctx.warn("本地骨架构建失败({}),改用无列骨架继续".format(
                str(box["err"]).splitlines()[0][:200]))
            box.pop("state", None)
        if "state" not in box:
            box["state"] = build_stub_state(ctx, _NoSource())
        _dump(p, box["state"])
        return p

    def compute_thresholds(self, ctx, source, data_path, state_partial):
        state = _load(state_partial)
        state["adaptive_thresholds"] = state.get("_auto_thresholds") or {}
        _dump(state_partial, state)

    def draft(self, ctx, source, state_partial):
        state = _load(state_partial)
        state["_stage"] = "draft"
        state["_draft"] = True
        p = ctx.path("state_draft.json")
        _dump(p, state)
        return p

    def crowd_rules(self, ctx, source, state_draft):
        state = _load(state_draft)
        rules = []
        for seg in state.get("audience_segments", []):
            r = {
                "source": "audience_segment",
                "name": seg["name"],
                "direction": seg["direction"],
                "finding_id": seg["finding_id"],
                "pandas_filter": seg.get("pandas_filter"),
                "sql_filter": seg["sql_filter"],
                "estimated_size": seg.get("estimated_size"),
            }
            # direction_raw 必须带出去:它是"方向没映射上"的唯一线索,
            # 白名单投影漏掉它,下游 normalize_direction 就再也认不回来了
            # (fnd_r41 促付人群就是这么在 stub 链路里第二次被丢掉的)。
            if seg.get("direction_raw"):
                r["direction_raw"] = seg["direction_raw"]
            rules.append(r)
        # 诊断规则也进 crowd_rules.json(审计用),但不参与圈人 —— 这条口径必须被过滤逻辑覆盖到
        rules.append({
            "source": "diagnostic_rule", "name": "R7 低活跃衰减", "direction": "exclude",
            "finding_id": "fnd_r7", "sql_filter": "1=1", "estimated_size": 41000,
        })
        p = ctx.path("crowd_rules.json")
        _dump(p, rules)
        return p

    def self_critique(self, ctx, state_path, rnd=1):
        return None                    # 本地骨架没有质检可跑,如实返回"没问到"

    def status(self, ctx, state_path):
        return None

    def render(self, ctx, source, state_full, on_rewrite=None):
        html = ctx.path("diagnosis_report.html")
        with open(html, "w", encoding="utf-8") as f:
            f.write(render_stub_html(_load(state_full)))
        return html


# --------------------------------------------------------------------------- 后端组装


class Backend(object):
    """数据源 × 诊断步骤。两个维度正交,所以"没有 Hive 但有 skill"这种真实处境
    不需要单独写一套代码,换个数据源就行。"""

    def __init__(self, source, steps):
        self.source = source
        self.steps = steps
        self.name = "{}+{}".format(source.name, steps.name)

    def close(self):
        self.source.close()


_PRESETS = {
    "real":  ("hive",  "skill"),
    "csv":   ("csv",   "skill"),
    "skill": ("synth", "skill"),
    "stub":  ("synth", "stub"),
}


def resolve_runtime():
    d, s = _PRESETS.get(RUNTIME, _PRESETS["stub"])
    return (os.environ.get("MA_DATA") or d).strip().lower(), \
           (os.environ.get("MA_SKILL") or s).strip().lower()


def get_backend():
    data, skill = resolve_runtime()
    if data == "hive":
        src = HiveSource()
    elif data == "csv":
        src = CsvSource()
    else:
        src = SynthSource()
    steps = SkillSteps() if skill == "skill" else StubSteps()
    return Backend(src, steps)


# 体检在 import 时跑一次,结果挂在模块上,给 /healthz、启动横幅和每一单的 warnings 用。
# 放在这里(而不是 check_env 定义处)是因为它要用到上面的 resolve_runtime。
# 只算不抛:在 import 里抛异常会让"我就想看看哪儿配错了"都做不到。
ON_MA_SERVER = _looks_like_ma_server()
ENV_FATAL, ENV_WARN = check_env(on_ma_server=ON_MA_SERVER)
ALLOW_BAD_ENV = (_env("MA_ALLOW_BAD_ENV", "0")).strip() in ("1", "true", "yes")


def env_gate(echo=None):
    """启动前的环境闸门。返回 True = 可以起服务。

    体检结果无论如何都打出来:致命的拦下,不致命的留在启动横幅里 —— 等哪天出问题,
    截图一发就能看见当时的环境是什么样,不用再回头猜是谁配的。
    """
    echo = echo or (lambda s: sys.stderr.write(s + "\n"))
    for line in format_env_report(ENV_FATAL, ENV_WARN):
        echo(line)
    if not ENV_FATAL:
        return True
    if ALLOW_BAD_ENV:
        echo("⚠ [环境] MA_ALLOW_BAD_ENV=1,上面 {} 条致命问题被放行;"
             "它们会出现在每一单的 warnings 里。".format(len(ENV_FATAL)))
        return True
    echo("✗ [环境] {} 条致命问题,拒绝启动 —— 这些错不拦在这儿,就只能等业务方来问"
         "「你给我的链接打不开」。".format(len(ENV_FATAL)))
    echo("        确认都是有意为之,再 export MA_ALLOW_BAD_ENV=1 放行;")
    echo("        只想看看哪儿配错了:python3 preflight_ma_server.py 或 --check。")
    return False



# --------------------------------------------------------------------------- stub 数据


def _thr(v):
    """把分位数写成 SQL 字面量。整数就写整数,免得 `>= 3.0` 这种在报告里刺眼。"""
    if isinstance(v, float):
        return str(int(v)) if v == int(v) else "{:.6g}".format(v)
    return str(v)


def _seg(name, direction, finding_id, sql_filter, note=None, direction_raw=None):
    seg = {"name": name, "direction": direction, "finding_id": finding_id,
           "pandas_filter": None, "sql_filter": sql_filter,
           "estimated_size": None, "baseline_cvr": None, "expected_cvr_mid": None,
           "basis": note or "本地骨架按数据分位数生成,不代表模型结论"}
    if direction_raw:
        seg["direction_raw"] = direction_raw
    return seg


def _pick_numeric(ctx, source, want=3, scan=40):
    """挑几列有区分度的数值列。全是同一个值的列做不出规则,直接跳过。"""
    # fix17:这段会对数据源发一串分位数查询(hive 下是 Spark 作业),以前全程无日志,
    # 外面看就是"任务冻住"。逐列打点,让 log_tail 能看到它活着、走到哪一列。
    ctx.log("骨架取列:开始探测数值列(最多探 {} 列,目标选 {} 列,每列 2 个分位数查询)".format(scan, want))
    out = []
    seen = 0
    for c in source.describe_columns(ctx):
        if seen >= scan or len(out) >= want:
            break
        if not c.get("numeric") or c["name"] in (source.id_col, source.union_col):
            continue
        seen += 1
        lo = source.quantile(ctx, c["name"], 0.25)
        hi = source.quantile(ctx, c["name"], 0.75)
        if lo is None or hi is None or lo == hi:
            continue
        out.append(c)
        ctx.log("骨架取列:选中 {}({}/{})".format(c["name"], len(out), want))
    return out


def build_stub_state(ctx, source):
    """造一份结构与真 state_partial 对齐的骨架。

    规则不是写死的常量:它们长在数据源真实存在的列上,阈值取自这份数据的分位数。
    这样即使 skill 全部降级,圈出来的人数也仍然是这份数据上的真实计数,而不是编的。

    形状上刻意保留这几件事,每一条都对应一个要防的回归:
      - 三类 finding_id 前缀都造齐(fnd_model_* / fnd_rN / fnd_pos_*),
        且让 direction 与前缀交叉 —— 验证"分模型/规则只看 finding_id,不看 direction",
        以及反过来"推不推只看 direction,不看前缀",两个轴互不干扰
      - 留一条覆盖面极广的 exclude 规则 —— 验证它不会被 OR 进 push_sql。
        真实事故就长这样:那条 49477/50000 的「跨渠道高频疲劳人群」
      - 留一条 direction=exclude 但 direction_raw="促付" 的规则 —— 验证方向归一化
        能把它认回 push(对应线上 fnd_r41)
      - 留一条引用不存在列的规则 —— 用来验证 dry-run 会把它剔掉
      - 各段人群故意互相重叠 —— 用来验证 population_size 不可相加
    """
    aid = ctx.activity_id
    cols = _pick_numeric(ctx, source)
    segs = []
    if cols:
        a = cols[0]["name"]
        segs.append(_seg("模型高潜A:{} 处于高位".format(a), "push", "fnd_model_01",
                         "{} >= {}".format(a, _thr(source.quantile(ctx, a, 0.60)))))
        segs.append(_seg("模型低效C:{} 处于低位".format(a), "exclude", "fnd_model_03",
                         "{} <= {}".format(a, _thr(source.quantile(ctx, a, 0.20)))))
        if len(cols) > 1:
            b = cols[1]["name"]
            segs.append(_seg("模型高潜B:{} 与 {} 同时靠前".format(a, b), "push", "fnd_model_02",
                             "{} >= {} AND {} >= {}".format(
                                 a, _thr(source.quantile(ctx, a, 0.50)),
                                 b, _thr(source.quantile(ctx, b, 0.50)))))
            segs.append(_seg("规则seg:{} 偏低".format(b), "push", "fnd_r3",
                             "{} <= {}".format(b, _thr(source.quantile(ctx, b, 0.40)))))
        if len(cols) > 2:
            c2 = cols[2]["name"]
            segs.append(_seg("规则seg:{} 头部".format(c2), "push", "fnd_pos_02",
                             "{} >= {}".format(c2, _thr(source.quantile(ctx, c2, 0.80)))))
        # 下面两条是回归用的哨兵,不是给业务看的规则
        segs.append(_seg("排除:{} 近乎全量的疲劳人群".format(a), "exclude", "fnd_r37",
                         "{} >= {}".format(a, _thr(source.quantile(ctx, a, 0.01))),
                         note="哨兵:覆盖面极广的排除规则,一旦被 OR 进 push_sql 就是事故"))
        segs.append(_seg("创单未付待促付人群", "exclude", "fnd_r41",
                         "{} >= {}".format(a, _thr(source.quantile(ctx, a, 0.90))),
                         note="哨兵:direction_raw 是推送意图,应被归一化认回 push",
                         direction_raw="促付"))
        ctx.log("本地骨架按数据分位数生成 {} 条人群规则,取材列:{}".format(
            len(segs), ",".join(c["name"] for c in cols)))
    else:
        ctx.warn("这份数据里没有有区分度的数值列,只能造一条全量规则,圈出来就是全体人群")
        segs.append(_seg("兜底:全量人群", "push", "fnd_model_01",
                         "{} IS NOT NULL".format(source.id_col), note="没有可分层的数值列"))
    segs.append(_seg("坏规则:引用了人群池没有的列", "push", "fnd_model_99",
                     "ma_not_a_real_column_zzz > 0", note="故意写错,用来验证 dry-run 会剔除它"))

    rows = source.row_count(ctx)
    return {
        "_stage": "partial",
        "_draft": True,
        "headline": PLACEHOLDER,
        "campaign_meta": {
            "campaign_name": "活动 {}".format(aid),
            "campaign_type": ctx.params.get("campaign_type") or "活动",   # 与收尾兜底链的默认一致
            "target_products": ["门票"],
            "channel": "私域社群",
            "activity_id": aid,
        },
        "data_overview": {"rows": rows, "source": source.label,
                          "columns": len(source.describe_columns(ctx))},
        "findings": [
            {"finding_id": segs[0]["finding_id"], "title": segs[0]["name"], "detail": PLACEHOLDER},
            {"finding_id": segs[1]["finding_id"], "title": segs[1]["name"], "detail": PLACEHOLDER},
        ],
        "audience_segments": segs,
        "_auto_thresholds": dict(
            (c["name"], source.quantile(ctx, c["name"], 0.60)) for c in cols),
        "narratives": {
            "problems": [
                {"title": PLACEHOLDER, "narrative": PLACEHOLDER, "impact": PLACEHOLDER,
                 "root_cause": PLACEHOLDER},
                {"title": PLACEHOLDER, "narrative": PLACEHOLDER, "impact": PLACEHOLDER,
                 "root_cause": PLACEHOLDER},
            ]
        },
        "action_plan": [
            {"title": PLACEHOLDER, "description": PLACEHOLDER, "expected_impact": PLACEHOLDER},
            {"title": PLACEHOLDER, "description": PLACEHOLDER, "expected_impact": PLACEHOLDER},
        ],
    }


def render_stub_html(state):
    """极简报告页。刻意不塞几百 KB 内联 CSS —— 报告是给人看的,也是给下游读的。"""
    def _obj(v):
        return v if isinstance(v, dict) else {}

    def _listify(v, *inner):
        """skill 的 state 和本地骨架 state 形状不一样:同一字段这边是 list,
        那边可能是 {"priority_actions": [...]}。上一版直接 for it in dict,
        拿到的是字符串 key,it.get 当场 AttributeError,
        把一次"降级"炸成了整单 error。这里两种形状都收。
        """
        if isinstance(v, dict):
            for k in inner:
                if isinstance(v.get(k), list):
                    return v[k]
            for cand in v.values():
                if isinstance(cand, list):
                    return cand
            return []
        return v if isinstance(v, list) else []

    meta = _obj(state.get("campaign_meta"))
    ov = _obj(state.get("data_overview"))
    narr = _obj(state.get("narratives"))
    esc = _html_escape

    def rows(items, keys):
        out = []
        for it in _listify(items):
            if not isinstance(it, dict):
                it = {keys[0]: it}
            tds = "".join("<td>{}</td>".format(esc(str(it.get(k, "")))) for k in keys)
            out.append("<tr>{}</tr>".format(tds))
        return "\n".join(out)

    segs = _listify(state.get("audience_segments"), "segments")
    problems = _listify(narr.get("problems"), "problems", "items")
    actions = _listify(state.get("action_plan"), "priority_actions", "actions")
    return """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<style>
body{{font:15px/1.7 system-ui,-apple-system,"PingFang SC",sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;color:#222}}
h1{{font-size:1.5rem}} h2{{font-size:1.1rem;margin-top:2rem;border-left:3px solid #444;padding-left:.5rem}}
table{{border-collapse:collapse;width:100%;margin:.5rem 0}} th,td{{border:1px solid #ddd;padding:.4rem .6rem;text-align:left;font-size:14px}}
th{{background:#f6f6f6}} .meta{{color:#666;font-size:13px}}
</style></head><body>
<h1>{headline}</h1>
<p class="meta">活动 {aid} · {ctype} · 渠道 {channel} · 整体转化率 {cvr}</p>
<h2>核心发现</h2>
<table><tr><th>finding</th><th>标题</th><th>说明</th></tr>
{findings}
</table>
<h2>人群分层</h2>
<table><tr><th>名称</th><th>方向</th><th>finding_id</th><th>sql_filter</th><th>预估规模</th></tr>
{segs}
</table>
<h2>问题诊断</h2>
<table><tr><th>问题</th><th>描述</th><th>影响</th><th>根因</th></tr>
{problems}
</table>
<h2>行动建议</h2>
<table><tr><th>动作</th><th>说明</th><th>预期</th></tr>
{actions}
</table>
</body></html>
""".format(
        title=esc("营销诊断报告 {}".format(meta.get("activity_id", ""))),
        headline=esc(str(state.get("headline") or narr.get("headline") or "营销诊断报告")),
        aid=esc(str(meta.get("activity_id", ""))),
        ctype=esc(str(meta.get("campaign_type", ""))),
        channel=esc(str(meta.get("channel", ""))),
        cvr=esc(str(ov.get("overall_cvr", ""))),
        findings=rows(state.get("findings") or [], ["finding_id", "title", "detail"]),
        segs=rows(segs, ["name", "direction", "finding_id", "sql_filter", "estimated_size"]),
        problems=rows(problems, ["title", "narrative", "impact", "root_cause"]),
        actions=rows(actions, ["title", "description", "expected_impact"]),
    )


def _html_escape(s):
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
             .replace('"', "&quot;"))


def _load(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _dump(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


# --------------------------------------------------------------------------- 润色(唯一的模型环节)


# skill 的 draft 骨架句式。只清自己的 [待润色] 是不够的 —— skill 的 completeness
# 门禁把这些填充句也算作"未润色",render 直接判 INCOMPLETE_REPORT 退出码 4。
DRAFT_MARKS = ("待润色", "指标现状\u2192目标", "论断式标题", "补充\u2026", "补充...")
_FILLER_RE = re.compile(r"[\uff08(]基于[^\uff09)]{0,40}补[^\uff09)]{0,20}[\uff09)]")


# 2026-07-29 real_c_001:门禁报「待润色×49、骨架填充句×11(补充现象+数据叙述;
# 补充业务影响; 补充业务根因与建议方向…)」。那 11 句是 skill 自己 draft 出来的骨架,
# 上面那几个字面量一个都不匹配 —— 于是它们压根没进空槽列表,润色就算成功也照样被拦。
# 骨架句的共同长相:以「补充/待补」这类祈使词开头的短语。
#
# 2026-07-29 第二轮:上面这条曾经把「填写」也算进去,结果把规则目录里的
# 业务术语「填写页营销打断」误判成草稿:凭空多了 2 个空槽,模型改写好的文案
# 又被回写前的同一道判断退件,最后 55/57 报 degraded。教训:「填写」在营销漏斗里
# 本就是名词(填写页),不能当祈使词用。同时再加三道闸:带数字的、带句读的、
# 太长的,都是写完的成品文案,不是骨架。
_SKELETON_RE = re.compile(r"^\s*(补充|待补|请写|写一句|TODO|TBD)", re.I)
_HAS_NUM = re.compile(r"\d")
_SENT_END = re.compile(r"[。！？!?;；]")

# skill 的 state 里只有这几棵子树装的是给人读的文案;其余都是统计口径与维度标签。
# 实测 job_20260729_105131 的 state_draft:49 处真空槽全部落在 findings(8) /
# audience_segments(8) / narratives(21) / action_plan(12),一处例外都没有。
#
# 为什么要分这么一刀:上一版拿句式猜骨架句,猜到了 agent_structured_stats 头上。
# funnel_diagnosis[4].depth_label 本来就该是「填写页」—— 它是漏斗层级的名字,
# 结果被当成「填写…」祈使句发给模型改写成了一整句话。这类字段完备性门禁压根不看,
# 所以 6 个分组维度被静静写坏,出参上一点痕迹也没有 —— 比那 2 处没填上的严重得多。
# 定下来:显式占位符(skill 自己写的,没歧义)全树都认;
#         靠句式猜的骨架句,只在正文子树里认。
# 漏判的后果是门禁拦下来(吻得很响,一看就知道要添哪棵树);
# 误判的后果是数据被改写(没声没息)。往响的那边偏。
PROSE_ROOTS = ("findings", "audience_segments", "narratives", "action_plan",
               "executive_summary", "recommendations", "summary")


def _looks_like_skeleton(s):
    """以祈作词开头的短标签才算骨架。带数字/带句读/过长的都是成品文案。"""
    t = s.strip()
    if not _SKELETON_RE.match(t):
        return False
    if _HAS_NUM.search(t):
        return False        # 「补充一轮定向触达,预计提升 1.2pp」是真文案
    if _SENT_END.search(t):
        return False        # 骨架句不带句读,成句的都是写完的
    return len(t) <= 24     # 骨架句都是短标签


def _has_draft_mark(s):
    """显式占位符。skill 自己落下的记号,含义没歧义,在哪棵树上都算草稿。"""
    return any(m in s for m in DRAFT_MARKS) or bool(_FILLER_RE.search(s))


def _in_prose(path):
    return path.split(".", 1)[0].split("[", 1)[0] in PROSE_ROOTS


def _is_draft_text(s, path=None):
    """这句文案还是草稿骨架吗。

    给了 path 就按位置收紧:句式启发只在正文子树里生效。
    统计块里的维度标签(「填写页」这种)不是没写完,那本来就是它的值。
    """
    if _has_draft_mark(s):
        return True
    if path is not None and not _in_prose(path):
        return False
    return _looks_like_skeleton(s)


def clear_draft_marks(node):
    """递归删 _draft、递归把 _stage 置 full。返回 (删了几个, 改了几处)。

    上一版只在顶层写 state["_draft"] = False,而 skill 的 state 在 21 个嵌套节点上
    各挂一个 _draft —— 门禁数的是整棵树,于是那一版永远过不了。
    """
    n_d = n_s = 0
    if isinstance(node, dict):
        if "_draft" in node:
            node.pop("_draft", None)
            n_d += 1
        if "_stage" in node:
            node["_stage"] = "full"
            n_s += 1
        for v in list(node.values()):
            a, b = clear_draft_marks(v)
            n_d += a
            n_s += b
    elif isinstance(node, list):
        for v in node:
            a, b = clear_draft_marks(v)
            n_d += a
            n_s += b
    return n_d, n_s


# 2026-07-29 real_c_001 的报告:「核心问题 → 对应行动」那一列渲染成了
# 「控制49」「挽回2」「纠正19」「倾斜资源给3」—— 四格全废。
# state 里 action_plan.priority_actions[*].title 原文是完整的
# (「控制49,477人触达频次:建立全局频次上限机制」),是 skill 的渲染器在做短标签时
# 按标点切第一段,而千分位那个半角逗号排在冒号前面,一刀正好切在数字中间。
# skill 是用户自己装的、不能改,所以在交给 render 之前先把标签里的千分位抹掉:
# 「49,477」→「49477」。切出来的短标签就变回「控制49477人触达频次」。
#
# 这个坑有我一半:_PATH_RULES 里「标题必须含具体数字」是我写的,模型照做了,
# 写出来的数字自带千分位。提示词那头也一并改。
#
# 只动数字中间的逗号,只动标签类字段。正文(detail/narrative/description)照旧带
# 千分位 —— 那些地方带着更好读,而且没有哪一列会去切它们。
_THOUSANDS_RE = re.compile(r"(?<=\d)[,，](?=\d{3}(?!\d))")

# 渲染器拿去做短标签的字段名。注意「深度2,3,4」这种不会被误伤:
# 千分位要求逗号后面正好跟三位数字。
LABEL_KEYS = ("title", "name", "display_name", "label", "headline")


def strip_label_thousands(node, prefix="", out=None):
    """抹掉标签类字段里的千分位逗号,返回改动清单 [(路径, 原文, 新值)]。"""
    if out is None:
        out = []
    if isinstance(node, dict):
        for k, v in node.items():
            path = "{}.{}".format(prefix, k) if prefix else k
            if isinstance(v, str) and k in LABEL_KEYS:
                neu = _THOUSANDS_RE.sub("", v)
                if neu != v:
                    node[k] = neu
                    out.append((path, v, neu))
            else:
                strip_label_thousands(v, path, out)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            strip_label_thousands(v, "{}[{}]".format(prefix, i), out)
    return out


def collect_placeholders(node, prefix=""):
    """把 state 里所有还写着 [待润色] 的位置找出来,返回 [(路径, 同级上下文)]。

    路径形如 narratives.problems[0].title。不做整树塞给模型,只把空槽列出来 ——
    真 state_draft 有 ~47 处空槽而全文很大,整篇进出模型既慢又容易被截断,
    补空槽的输出量只和空槽数有关。
    """
    out = []
    if isinstance(node, dict):
        for k, v in node.items():
            out.extend(collect_placeholders(v, "{}.{}".format(prefix, k) if prefix else k))
    elif isinstance(node, list):
        for i, v in enumerate(node):
            out.extend(collect_placeholders(v, "{}[{}]".format(prefix, i)))
    elif isinstance(node, str) and _is_draft_text(node, prefix):
        out.append(prefix)
    return out


_PATH_TOK = re.compile(r"([^.\[\]]+)|\[(\d+)\]")


def set_by_path(root, path, value):
    """按 a.b[0].c 定位并赋值。路径不存在就返回 False,不新建节点。"""
    toks = []
    for m in _PATH_TOK.finditer(path):
        toks.append(m.group(1) if m.group(1) is not None else int(m.group(2)))
    if not toks:
        return False
    cur = root
    for t in toks[:-1]:
        try:
            cur = cur[t]
        except (KeyError, IndexError, TypeError):
            return False
    last = toks[-1]
    try:
        if isinstance(cur, list) and isinstance(last, int):
            if last >= len(cur):
                return False
        elif isinstance(cur, dict):
            if last not in cur:
                return False
        else:
            return False
        cur[last] = value
        return True
    except (KeyError, IndexError, TypeError):
        return False


def context_for(state, path):
    """给模型一点上下文:这个空槽所在对象里其他非空字段。"""
    toks = []
    for m in _PATH_TOK.finditer(path):
        toks.append(m.group(1) if m.group(1) is not None else int(m.group(2)))
    cur = state
    for t in toks[:-1]:
        try:
            cur = cur[t]
        except (KeyError, IndexError, TypeError):
            return {}
    if not isinstance(cur, dict):
        return {}
    return {k: v for k, v in cur.items()
            if isinstance(v, (str, int, float)) and not _is_draft_text(str(v))}


# skill 的 render 有一道 schema 门禁,部分字段有最小字数,不够就 exit=2 拒绝渲染:
#     [render] schema validate: 1 errors
#       · headline 长度 26 字 < 30 字
# job_20260729_114613 就栽在这儿。根子在我 —— 下面 _PATH_RULES 里 headline 那条
# 原本只写了上限「不超过 50 字」,没写下限,模型老老实实写了 26 字。
# 现在两头都堵:rule_for 会把下限拼进提示词,润色循环收尾前再做一次确定性体检。
# 键按 path 前缀匹配(点号开头表示按后缀匹配,与 _PATH_RULES 同一套规则)。
SCHEMA_MIN_LEN = (
    ("narratives.headline", 30),
)


def min_len_for(path):
    for key, n in SCHEMA_MIN_LEN:
        if key.startswith("."):
            if path.endswith(key):
                return n
        elif path.startswith(key):
            return n
    return 0


# skill 的 schema 报错实录(job_20260729_114613):
#     [render] schema validate: 1 errors
#       · headline 长度 26 字 < 30 字 (当前: 2403人创单未付,立即启动促付挽回是最高优先级行动)
#     [render] aborted due to schema errors (use --skip-validate to force)
# 逐条抠出「哪个字段 / 什么毛病 / 差多少」。抠不出结构的也留着原文照样丢给模型 ——
# skill 报错说的是人话,模型看得懂,这比我在这边猜一张规则表要跟得上。
_SCHEMA_BULLET = re.compile(r"^\s*[\u00b7\u2022\u25cf\-\*]\s+(\S.*)$")
_LEN_CN = re.compile(r"(?P<field>[\w.\[\]]+)\s*长度\s*(?P<got>\d+)\s*字?\s*"
                     r"(?P<op>[<>])\s*(?P<need>\d+)")
_LEN_EN = re.compile(r"(?P<field>[\w.\[\]]+)\s+(?:length|len)\s+(?P<got>\d+)\s*"
                     r"(?P<op>[<>])\s*(?P<need>\d+)", re.I)
_FIELD_HEAD = re.compile(r"^([A-Za-z_][\w.\[\]]*)")


class ChannelGate(object):
    """render 的渠道词汇门禁(exit=3)。

    它跟 schema 错误不是一回事:schema 有强制开关可以硬闯,渠道词汇没有,
    methodology/05 也写死了「不得使用 --allow-channel-lint 绕过」。
    所以它必须能跟"体检通过([])"和"问不出来(None)"区分开 —— 单独给一个类型,
    调用方漏判会当场报错,而不是被当成空清单悄悄放过去。
    """

    __slots__ = ("tail",)

    def __init__(self, tail):
        self.tail = tail or ""

    def __repr__(self):                                            # pragma: no cover
        return "<ChannelGate {} chars>".format(len(self.tail))


def _looks_schema(tail):
    low = (tail or "").lower()
    return ("schema" in low) or ("validate" in low) or ("--skip-validate" in low)


_SCHEMA_HEAD = re.compile(r"^\s*\[[a-z_-]+\]\s*schema\s+validate\s*[:\uff1a]", re.I)
_BLOCK_HEAD = re.compile(r"^\s*\[[a-z_-]+\]")
_PAST_SCHEMA = re.compile(r"lint warnings|INCOMPLETE_REPORT|REWRITE_REQUIRED", re.I)


def schema_error_lines(text):
    """只截「[render] schema validate: N errors」那一段下面的条目。

    render 打完 schema 紧接着打 lint warnings,两段的条目长得一模一样(都是「· xxx」)。
    整段一起 parse 的话,非阻塞的 lint 会被当成阻塞的 schema 错误 ——
    白让模型重写一遍不该动的字段,还会在出参里谎报"schema 没过 N 条"。
    """
    lines = (text or "").splitlines()
    idx = None
    for i, ln in enumerate(lines):
        if _SCHEMA_HEAD.match(ln):
            idx = i                  # 取最后一段:重试时同一个 tail 里可能有好几段
    if idx is None:
        # 没看见段头。但能确认已经走过 schema 那一段的话(lint/完备性/渠道的话都出现了),
        # 后面的条目就不是 schema 错误,别拿它们冒充。
        if any(_PAST_SCHEMA.search(ln) for ln in lines):
            return []
        return lines                 # 认不出结构:维持老行为,整段 parse
    out = []
    for ln in lines[idx + 1:]:
        if _BLOCK_HEAD.match(ln):
            break
        out.append(ln)
    return out


def parse_schema_errors(text, limit=20):
    """把 skill 的 schema 报错拆成结构化清单。认不出结构的条目也保留 raw。"""
    out = []
    for ln in schema_error_lines(text):
        m = _SCHEMA_BULLET.match(ln)
        if not m:
            continue
        body = m.group(1).strip()
        if not body:
            continue
        item = {"raw": body, "field": None, "op": None, "need": None, "got": None}
        c = _LEN_CN.search(body) or _LEN_EN.search(body)
        if c:
            item["field"] = c.group("field")
            item["op"] = c.group("op")
            item["need"] = int(c.group("need"))
            item["got"] = int(c.group("got"))
        else:
            f = _FIELD_HEAD.match(body)
            if f:
                item["field"] = f.group(1)
        out.append(item)
        if len(out) >= limit:
            break
    return out


def paths_for_field(state, field):
    """skill 报的是叶子名(headline),我们要的是全路径(narratives.headline)。

    先按全路径试;对不上就按叶子名全树搜,搜到几条给几条 —— 宁可多重写一处,
    也好过报错反复出现却定位不到。
    """
    if not field:
        return []
    if _str_at(state, field):
        return [field]
    leaf = field.split(".")[-1].split("[")[0]
    hits = []

    def walk(node, prefix=""):
        if isinstance(node, dict):
            for k, v in node.items():
                p = "{}.{}".format(prefix, k) if prefix else k
                if k == leaf and isinstance(v, str) and v.strip():
                    hits.append(p)
                else:
                    walk(v, p)
        elif isinstance(node, list):
            for i, v in enumerate(node):
                walk(v, "{}[{}]".format(prefix, i))

    walk(state)
    return hits


def _need_text(err):
    """把一条 schema 报错翻成给模型看的要求。"""
    if err.get("need") and err.get("op") == "<":
        return "至少 {} 个字(含标点),当前 {} 字,太短了".format(err["need"], err.get("got"))
    if err.get("need") and err.get("op") == ">":
        return "最多 {} 个字(含标点),当前 {} 字,太长了".format(err["need"], err.get("got"))
    return "渲染器原话:" + err.get("raw", "")


def build_repair_prompt(state, items):
    """items: [{"path","need","current"}]。只修这几条,别的不动。"""
    meta = state.get("campaign_meta") or {}
    return (
        "你在修一份私域营销诊断报告的文案。报告渲染器做了校验,下面这些字段没通过,"
        "请按每条的 need 重写。保持原意和已有的数字,只调整写法和长度。\n"
        "这份报告最后由 marketing-audit skill 渲染并跑它自己的质检,"
        "重写的时候按下面这段它的写作约束来。\n\n"
        + skill_writing_rules() + "\n\n"
        "活动背景:" + json.dumps(meta, ensure_ascii=False) + "\n\n"
        "要修的字段(path 是位置,need 是渲染器的要求,current 是现在的原文):\n"
        + json.dumps(items, ensure_ascii=False, indent=1) + "\n\n"
        "要求:\n"
        "- 只输出一个 JSON 对象,不要解释,不要代码块标记。\n"
        '- 格式:{"fills": {"<path>": "<重写后的中文>", ...}},path 必须与上面完全一致。\n'
        "- 上面列了几条就回几条,不要额外加没问过的 key。\n"
        "- 字数按中文字符数算,标点也算。有下限的宁可多写 3-5 字,不要卡在边界上。\n"
        "- 不要编造没给的数字;不要出现花括号和英文双引号;不要出现占位说法。\n"
    )


def schema_repair(ctx, state, validate, call_cli, extract_json, info):
    """闭环体检:落一版 → 问 skill → 它报什么就重写什么 → 复检。

    这是替代硬编码规则表的办法。skill 以后加规矩、改字数,这边不用改代码也跟得上;
    真修不好也不致命 —— render 那头还有强制开关兜底,至少样式是正版模板。
    """
    if validate is None or not SCHEMA_CHECK or SCHEMA_ROUNDS <= 0:
        return
    probe = ctx.path("state_check.json")
    rnd, ch_tries = 0, 0
    while rnd < SCHEMA_ROUNDS:
        _dump(probe, state)
        try:
            errs = validate(probe)
        except Exception as exc:                                   # noqa: BLE001
            ctx.warn("schema 体检没跑通({}),跳过这一步".format(exc))
            return
        if isinstance(errs, ChannelGate):
            # 渠道词汇门禁把体检整段挡住了。先在内存里按它给的指令改掉违规词再问一次;
            # 这一轮不计进 schema 轮次 —— 否则一次渠道违规就能把重写预算全吃光。
            if not CHANNEL_FIX or ch_tries >= CHANNEL_TRIES:
                ctx.warn("渠道词汇还没清干净,schema 体检问不下去了,"
                         "这一步先跳过(render 那头还会再修一次)")
                return
            ch_tries += 1
            if not channel_repair_state(ctx, state, errs.tail, ch_tries,
                                        call_cli, extract_json, info):
                return
            ctx.channel_rewrites = getattr(ctx, "channel_rewrites", 0) + 1
            continue
        rnd += 1
        if errs is None:
            return                              # 问不出来就不猜,交给 render 那头兜底
        if not errs:
            info["schema_ok"] = True
            ctx.schema_unresolved = 0
            ctx.log("schema 体检通过" + ("(第 {} 轮)".format(rnd) if rnd > 1 else ""))
            return
        info.setdefault("schema_errors", []).extend(e["raw"] for e in errs)
        # 先按"没修好"记账。下面任何一条提前 return 都不会把这笔账漏掉;
        # 真修好了在通过分支里再抹掉。宁可多报一句,也不要悄悄放过去。
        ctx.schema_unresolved = len(errs)
        ctx.warn("skill 的 schema 门禁报了 {} 条:{}".format(
            len(errs), " / ".join(e["raw"][:60] for e in errs[:3])))

        items, seen = [], set()
        for e in errs:
            hits = paths_for_field(state, e.get("field"))
            if not hits:
                ctx.log("  定位不到字段「{}」,这条只能交给 render 的强制开关".format(e.get("field")))
                continue
            for p in hits[:3]:
                if p in seen:
                    continue
                seen.add(p)
                items.append({"path": p, "need": _need_text(e),
                              "current": _str_at(state, p)})
        if not items:
            return
        prompt = build_repair_prompt(state, items)
        tag = "schema_r{}".format(rnd)
        try:
            with open(ctx.path("repair_prompt_{}.txt".format(tag)), "w",
                      encoding="utf-8") as fh:
                fh.write(prompt)
        except OSError:
            pass
        call = call_cli(prompt, POLISH_TIMEOUT)
        info["calls"] = info.get("calls", 0) + 1
        out = call.get("stdout") or ""
        try:
            with open(ctx.path("repair_stdout_{}.txt".format(tag)), "w",
                      encoding="utf-8") as fh:
                fh.write(out)
        except OSError:
            pass
        paths = [it["path"] for it in items]
        got = fills_from_output(out, paths, extract_json)
        hit = 0
        for path, val in got.items():
            if _is_draft_text(val, path):
                continue
            if set_by_path(state, path, val):
                hit += 1
        ctx.log("schema 重写 r{}:问了 {} 条,改上 {} 条 (exit={})".format(
            rnd, len(paths), hit, call.get("exit_code")))
        info.setdefault("schema_repaired", []).extend(paths[:10])
        if hit == 0:
            ctx.warn("schema 重写一条都没落地,不再重试")
            return
    # 轮次用完还没过 —— 说清楚,别让人以为体检通过了
    _dump(probe, state)
    try:
        left = validate(probe)
    except Exception:                                              # noqa: BLE001
        left = None
    if isinstance(left, ChannelGate):
        left = None                 # 渠道门禁不是 schema 结论,别拿它当"没过 N 条"
    if left:
        info["schema_ok"] = False
        ctx.schema_unresolved = len(left)
        ctx.warn("schema 体检 {} 轮后仍有 {} 条没过,render 会走强制开关出图".format(
            SCHEMA_ROUNDS, len(left)))
    elif left == []:
        info["schema_ok"] = True
        ctx.schema_unresolved = 0
        ctx.log("schema 体检通过(最后一轮)")


def _str_at(state, path):
    """按 collect_placeholders 那套 path 取回字符串,取不到返回空串(只用于报错文案)。"""
    cur = state
    for part in re.findall(r"[^.\[\]]+|\[\d+\]", path):
        try:
            if part.startswith("["):
                cur = cur[int(part[1:-1])]
            else:
                cur = cur[part]
        except (KeyError, IndexError, TypeError, ValueError):
            return ""
    return cur if isinstance(cur, str) else ""


def short_fields(node, prefix="", out=None):
    """挑出没写够 skill 最小字数的文案位置,返回 path 列表。

    只看有下限要求的字段;空串不算(那是空槽,collect_placeholders 管)。
    """
    if out is None:
        out = []
    if isinstance(node, dict):
        for k, v in node.items():
            short_fields(v, "{}.{}".format(prefix, k) if prefix else k, out)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            short_fields(v, "{}[{}]".format(prefix, i), out)
    elif isinstance(node, str):
        n = min_len_for(prefix)
        if n and 0 < len(node.strip()) < n:
            out.append(prefix)
    return out


# 字段级硬指标。每一条都出自 skill:methodology/03_synthesis.md 的字段规格、
# report_validator.validate_report 的长度门禁、以及 cli render 的自动截断行为。
# 这张表有两个消费方 —— rule_for() 给单个空槽做提示,skill_writing_rules() 把整张表
# 铺进提示词。共用一张表是为了别再出现"提示词里写 30-50、代码里判 30"这种两处打架。
_PATH_RULES = (
    ("narratives.headline",
     "30-50 \u5b57\uff0c\u542b\u6d3b\u52a8\u540d + \u4e00\u4e2a\u6570\u636e + \u4e00\u4e2a\u5224\u65ad\uff1b"
     "\u4e0d\u8db3 30 \u5b57 skill \u76f4\u63a5\u62d2\u7edd\u6e32\u67d3\uff0c\u8d85\u8fc7 60 \u5b57\u4f1a\u88ab\u81ea\u52a8\u622a\u65ad\uff08\u53ef\u80fd\u622a\u5728\u534a\u53e5\u4e0a\uff09"),
    ("narratives.subhead",
     "40-60 \u5b57\u5c01\u9762\u526f\u53e5\uff0c\u6982\u8ff0\u6838\u5fc3\u77db\u76fe + \u4e00\u5904\u6b63\u5411\u673a\u4f1a\uff1b\u6570\u5b57\u4e0e\u5224\u65ad\u5fc5\u987b\u4e0e\u672c\u6b21\u6570\u636e\u81ea\u6d3d"),
    ("action_plan.priority_actions",
     "\u6807\u9898\u8d70\u5f3a\u5236\u6a21\u677f\uff1a<\u52a8\u8bcd> <\u5e45\u5ea6>\uff0c<\u6307\u6807> <\u73b0\u72b6>\u2192<\u76ee\u6807>\uff0c"
     "\u5fc5\u987b\u542b\u81f3\u5c11\u4e00\u4e2a\u5177\u4f53\u6570\u5b57\uff08\u4eba\u6570/\u767e\u5206\u6bd4/\u5355\u91cf\uff09\uff1b"
     "\u6570\u5b57\u8fde\u7740\u5199\uff0c\u4e0d\u8981\u5343\u5206\u4f4d\u9017\u53f7\uff08\u5199 49477\uff0c\u4e0d\u5199 49,477\uff09"),
    (".narrative", "60-100 \u5b57\uff0c\u5148\u73b0\u8c61\u540e\u6570\u636e\uff1b\u6bcf\u4e2a\u6bd4\u4f8b\u5c3d\u91cf\u914d\u539f\u59cb\u8ba1\u6570\uff08n=xx\uff09"),
    (".description", "30-50 \u5b57\u884c\u52a8\u63cf\u8ff0\uff0c\u52a8\u8bcd\u5f00\u5934"),
    (".title", "12-25 \u5b57\uff0c\u8bba\u65ad\u5f0f\u6807\u9898\uff0c\u5fc5\u987b\u542b\u4e00\u4e2a\u5173\u952e\u6570\u636e\uff1b"
               "\u4e0d\u8981\u7528\u300c\u5173\u4e8e\u300d\u300c\u5206\u6790\u300d\u5f00\u5934"),
    (".detail", "30-60 \u5b57\uff0c\u5148\u7ed9\u6570\u636e\u518d\u7ed9\u7ed3\u8bba\uff0c\u5355\u53e5\u4e0d\u8d85 60 \u5b57"),
    (".signal", "\u4e00\u53e5\u8bdd\u8bf4\u6e05\u73b0\u8c61\uff0c\u5e26\u6570\u5b57\uff0c\u4e0d\u8981\u91cd\u590d detail"),
    (".root_cause", "2-3 \u53e5\uff0c\u5f15\u8be5\u7528\u6237\u7684\u5177\u4f53\u6570\u636e\u8bf4\u4e3a\u4ec0\u4e48\u4f1a\u8fd9\u6837\uff0c\u4e0d\u8981\u91cd\u590d\u73b0\u8c61"),
    (".impact", "30-50 \u5b57\u4e1a\u52a1\u5f71\u54cd\uff0c\u91cf\u5316\u5230\u4eba\u6570\u6216\u767e\u5206\u6bd4"),
    (".expected_impact", "\u53ef\u8861\u91cf\u7684\u9884\u671f\uff0c\u5e26\u6570\u5b57\uff08\u5982 CVR \u63d0\u5347 3-5pp\uff09"),
    (".profile_text", "\u4e00\u53e5\u8bdd\u7528\u6237\u753b\u50cf\uff0c\u542b 1 \u4e2a\u5177\u4f53\u6570\u5b57\uff0c\u4e0d\u5f97\u865a\u6784"),
    (".rationale", "\u8bf4\u6e05\u4e3a\u4ec0\u4e48\u5708\u8fd9\u6279\u4eba\uff0c\u5e26\u4e0a\u89c4\u6a21\u6216\u8f6c\u5316\u6570\u5b57"),
)

# skill 改了写作规矩,这里自动跟着改 —— 前提是能读到 skill 的 methodology。
# 读不到(比如离线自测、或者 skill 装在别处)就用下面这份精简版,不让流程停。
_FALLBACK_WRITING_RULES = (
    "\u3010\u5199\u4f5c\u7ea6\u675f\uff08\u672c\u5730\u7cbe\u7b80\u7248\uff0c\u672a\u8bfb\u5230 skill \u539f\u6587\uff09\u3011\n"
    "1. \u7b03\u5b9a\u7ed3\u8bba\uff1a\u7981\u7528\u300c\u53ef\u80fd/\u4f3c\u4e4e/\u6216/\u6709\u5f85/\u5efa\u8bae\u5173\u6ce8/\u9700\u8981\u8fdb\u4e00\u6b65\u5206\u6790/\u521d\u6b65\u5224\u65ad\u300d\u3002\n"
    "2. \u53bb AI \u5316\uff1a\u7981\u7528\u300c\u6211/\u6211\u4eec/\u672c\u6b21\u8bca\u65ad/\u5206\u6790\u663e\u793a/AI/Agent/\u6839\u636e\u6570\u636e\u53ef\u77e5/\u7ecf\u8fc7\u5206\u6790\u300d\u3002\n"
    "3. \u6570\u5b57\u7cbe\u786e\uff1a\u5199 66.67% \u800c\u4e0d\u662f\u300c\u8d85\u8fc7\u516d\u6210\u300d\uff0c\u6bd4\u4f8b\u5c3d\u91cf\u914d\u539f\u59cb\u8ba1\u6570\u3002\n"
    "4. \u53e5\u5b50\u7d27\u51d1\uff1a\u5355\u53e5\u4e0d\u8d85 60 \u5b57\u3002\n"
    "5. \u8fd0\u8425\u53cb\u597d\uff1a\u4e0d\u5f97\u51fa\u73b0 AUC/LightGBM/feature importance \u7b49\u6280\u672f\u8bcd\uff1b"
    "\u4e0d\u5f97\u51fa\u73b0\u300cRule 11/\u89c4\u5219 11\u300d\u8fd9\u7c7b\u89c4\u5219\u7f16\u53f7\uff0c\u53ea\u5199\u4e2d\u6587\u89c4\u5219\u540d\uff1b"
    "\u82f1\u6587\u5b57\u6bb5\u540d\u9996\u6b21\u51fa\u73b0\u8981\u5e26\u4e2d\u6587\u8bf4\u660e\uff0c\u4e4b\u540e\u53ea\u7528\u4e2d\u6587\u3002\n"
    "6. \u6e20\u9053\u8bcd\u6c47\u5fc5\u987b\u4e0e\u5b9e\u9645\u6e20\u9053\u4e00\u81f4\uff1aactivity \u6e20\u9053\u5199\u300c\u6d3b\u52a8\u89e6\u8fbe\u7528\u6237/\u6d3b\u52a8\u63a8\u9001\u300d\uff0c"
    "\u7981\u6b62\u51fa\u73b0\u300c\u5e7f\u544a\u7528\u6237/\u5e7f\u544a\u6295\u653e/\u5e7f\u544a\u6d41\u91cf\u300d\u3002\n"
)

_RULES_CACHE = {}


def _md_section(text, start, stops):
    """\u4ece markdown \u91cc\u622a\u4e00\u6bb5\uff1astart \u5f00\u5934\u7684\u90a3\u884c\u8d77\uff0c\u78b0\u5230 stops \u91cc\u4efb\u4e00\u884c\u4e3a\u6b62\u3002"""
    out, on = [], False
    for ln in (text or "").splitlines():
        s = ln.strip()
        if not on:
            if s.startswith(start):
                on = True
                out.append(ln)
            continue
        if any(s.startswith(x) for x in stops):
            break
        out.append(ln)
    return "\n".join(out).strip()


def _clip(text, limit):
    """\u6309\u884c\u622a\u65ad\uff0c\u4e0d\u628a\u4e00\u53e5\u8bdd\u65a9\u4e00\u534a\u3002"""
    if len(text) <= limit:
        return text
    out = []
    n = 0
    for ln in text.splitlines():
        if n + len(ln) + 1 > limit:
            break
        out.append(ln)
        n += len(ln) + 1
    return "\n".join(out).rstrip() + "\n\uff08\u4ee5\u4e0b\u7565\uff09"


def _field_rules_text():
    """\u628a _PATH_RULES \u94fa\u6210\u63d0\u793a\u8bcd\u91cc\u7684\u5b57\u6bb5\u7ea7\u6e05\u5355\u3002"""
    lines = ["\u3010\u5b57\u6bb5\u7ea7\u786c\u6307\u6807\uff08\u51fa\u81ea skill \u7684\u5b57\u6bb5\u89c4\u683c\u4e0e\u6e32\u67d3\u5668\u884c\u4e3a\uff09\u3011"]
    for key, tip in _PATH_RULES:
        lines.append("- {}\uff1a{}".format(key, tip))
    lines.append("- metric_refs \u91cc\u7684\u6570\u503c\u4e00\u4e2a\u90fd\u4e0d\u8bb8\u6539\uff0c\u53ea\u6539\u53d9\u8ff0\u5199\u6cd5\u3002")
    return "\n".join(lines)


def skill_writing_rules():
    """\u628a skill \u81ea\u5df1\u5199\u7684\u5199\u4f5c\u7ea6\u675f\u76f4\u63a5\u7aef\u8fdb\u63d0\u793a\u8bcd\u3002

    \u4ee5\u524d\u8fd9\u6bb5\u662f\u6211\u5728 _PATH_RULES \u91cc\u624b\u6284\u7684\uff0c\u6284\u6f0f\u4e86\u4e5f\u6ca1\u4eba\u77e5\u9053 ——
    headline \u7684 60 \u5b57\u4e0a\u9650\u3001priority_actions \u7684\u5f3a\u5236\u6807\u9898\u6a21\u677f\u3001\u7981\u7528\u8bcd\u6e05\u5355\uff0c
    \u8fd9\u4e09\u6837\u90fd\u5199\u5728 skill \u7684 methodology/03_synthesis.md \u91cc\uff0c\u6211\u7684\u63d0\u793a\u8bcd\u4e00\u6761\u90fd\u6ca1\u5e26\u3002
    \u73b0\u5728\u76f4\u63a5\u8bfb\u539f\u6587\uff1askill \u6539\u4e86\u89c4\u77e9\uff0c\u63d0\u793a\u8bcd\u81ea\u52a8\u8ddf\u7740\u6539\u3002
    """
    if "text" in _RULES_CACHE:
        return _RULES_CACHE["text"]
    verbatim = ""
    if SKILL_RULES:
        p = os.path.join(SKILL_DIR, "methodology", "03_synthesis.md")
        try:
            with open(p, encoding="utf-8") as fh:
                doc = fh.read()
            verbatim = _md_section(doc, "## \u5199\u4f5c\u4e03\u539f\u5219", ("## \u8de8\u8def\u5f84\u6574\u5408\u89c4\u5219",))
        except (OSError, UnicodeError):
            verbatim = ""
    if verbatim:
        head = ("\u3010skill \u81ea\u5df1\u7684\u5199\u4f5c\u7ea6\u675f\uff08\u539f\u6587\u6458\u5f55\u81ea "
                "marketing-audit/methodology/03_synthesis.md\uff09\u3011\n")
        body = head + _clip(verbatim, RULES_CHARS)
    else:
        body = _FALLBACK_WRITING_RULES
    _RULES_CACHE["text"] = body + "\n\n" + _field_rules_text()
    _RULES_CACHE["from_skill"] = bool(verbatim)
    return _RULES_CACHE["text"]


def rules_from_skill():
    """\u63d0\u793a\u8bcd\u91cc\u7684\u5199\u4f5c\u7ea6\u675f\u5230\u5e95\u662f\u4e0d\u662f\u4ece skill \u8bfb\u5230\u7684\uff08\u51fa\u53c2\u8981\u5982\u5b9e\u5199\uff09\u3002"""
    if "text" not in _RULES_CACHE:
        skill_writing_rules()
    return bool(_RULES_CACHE.get("from_skill"))


def rule_for(path):
    tip = None
    for key, t in _PATH_RULES:
        if key.startswith("."):
            if path.endswith(key):
                tip = t
                break
        elif path.startswith(key):
            tip = t
            break
    if tip is None:
        tip = "20-60 字,基于给出的数据说话"
    # 下限跟着 SCHEMA_MIN_LEN 走,改表就自动同步进提示词,不会两处打架
    n = min_len_for(path)
    if n:
        tip += "。硬性下限:不足 {} 字 skill 的 schema 门禁会直接拒绝渲染,务必写够".format(n)
    return tip


def build_polish_prompt(state, slots):
    meta = state.get("campaign_meta") or {}
    ov = state.get("data_overview") or {}
    # 数据概览里过长的明细列表不进提示词。356352 实测:55614 字的 r1 提示词里,
    # data_overview 占 35503 字,其中 diagnostic_rules_summary(33 条规则全量明细)
    # 一项就 23921 字 —— 而每个空槽要用的数字都在它自己的 context 里(signal /
    # affected_users / 同级指标),全局明细纯属重复负重。只保留紧凑段落
    # (漏斗/渠道/平台这些全局口径,给 narratives 一类文案打底),超长的按键名报备。
    ov_slim, ov_dropped = {}, []
    for k, v in ov.items():
        if len(json.dumps(v, ensure_ascii=False)) <= 2000:
            ov_slim[k] = v
        else:
            ov_dropped.append(str(k))
    segs = [{"name": s.get("name"), "direction": s.get("direction"),
             "finding_id": s.get("finding_id"), "expected_cvr_mid": s.get("expected_cvr_mid")}
            for s in (state.get("audience_segments") or [])]
    items = [{"path": p, "rule": rule_for(p), "context": context_for(state, p)} for p in slots]
    return (
        "你在给一份私域营销诊断报告做文案润色。下面给你活动背景、人群分层结果,"
        "以及一批待填写的空位。请为每个空位写一句中文,填进 JSON 返回。\n"
        "这份报告最后由 marketing-audit skill 渲染并跑它自己的质检,"
        "写之前先把下面这段它的写作约束读完,按它的规矩写。\n\n"
        + skill_writing_rules() + "\n\n"
        "活动背景:" + json.dumps(meta, ensure_ascii=False) + "\n"
        "数据概览:" + json.dumps(ov_slim, ensure_ascii=False)
        + ("(过长明细已省略:{};每个空位的数字见其 context)".format("、".join(ov_dropped))
           if ov_dropped else "") + "\n"
        "人群分层:" + json.dumps(segs, ensure_ascii=False) + "\n\n"
        "待填空位(path 是位置,rule 是这条的写法要求,"
        "context 是同一对象里已有的字段,供你判断该写什么):\n"
        + json.dumps(items, ensure_ascii=False, indent=1) + "\n\n"
        "要求:\n"
        "- 只输出一个 JSON 对象,不要解释,不要代码块标记。\n"
        '- 格式:{"fills": {"<path>": "<你写的中文>", ...}},path 必须与上面给的完全一致。\n'
        "- 上面列了几个 path 就回几条,一条都不能少,不要额外加没问过的 key。\n"
        "- 不要编造没给的数字;文案里不要出现花括号和英文双引号。\n"
        "- 每条都是成品文案,不能再出现「待润色」「补充…」这类占位说法。\n"
        "- 标题类文案（title / name / headline）里的数字连着写，不要加千分位逗号："
        "写「49477 人」不写「49,477 人」。报告里有一列按标点切短标签，逗号会把标题切成半截。\n"
    )


def scrape_fills(text, slots):
    """整段 JSON 解析不了时的兜底:按 path 逐条把 "path": "文案" 抠出来。

    被截断、多一个尾逗号、少一个右括号 —— 这些都不影响已经写完的那些条目,
    整段判废太亏。只认我们自己问过的 path,模型自己编的新 key 一律不要。
    """
    out = {}
    for p in slots:
        m = re.search('"' + re.escape(p) + r'"\s*:\s*"((?:[^"\\]|\\.)*)"', text)
        if not m:
            continue
        raw = m.group(1)
        try:
            val = json.loads('"' + raw + '"')
        except ValueError:
            val = raw
        if isinstance(val, str) and val.strip():
            out[p] = val.strip()
    return out


def fills_from_output(text, slots, extract=None):
    """把模型这次输出里能用的文案都捞出来,返回 {path: 文案}。

    2026-07-29 real_c_001 就死在这一步:CLI exit=0、stdout 开头明明就是
    ```json\n{"fills": {"findings[0].detail": "2,403名用户创单后未支付…" —— 文案写得挺好,
    但老的 extract_json 是个不认字符串字面量的括号计数器,配不平就返回 None,
    49 个空槽一条没落地。所以这里不能只靠一次严格解析:
    严格解析 → 少了就按 path 逐条抓 → 还少就认了,交给下一轮补。
    """
    if not text:
        return {}
    want = list(slots)
    extract = extract or (lambda t: None)
    parsed = extract(text)
    fills = None
    if isinstance(parsed, dict):
        fills = parsed.get("fills")
        if not isinstance(fills, dict) and any(k in parsed for k in want):
            fills = parsed  # 模型直接给了 {path: 文案},没套 fills 那层
    got = {}
    if isinstance(fills, dict):
        for k in want:
            v = fills.get(k)
            if isinstance(v, str) and v.strip():
                got[k] = v.strip()
    missing = [p for p in want if p not in got]
    if missing:
        for k, v in scrape_fills(text, missing).items():
            got.setdefault(k, v)
    return got


def _batches(items, n):
    return [items[i:i + n] for i in range(0, len(items), n)]


# --------------------------------------------------------------------------- skill 自带质检

# 纯文字能改的两类。其余(统计自洽/业务自洽/漏诊/冗余/渲染健康)都要重算或重新诊断,
# 方案 C 的模型是不带工具的,让它"改文案"去修统计结论只会编出一个更好听的错答案 ——
# 那些一律按 skill 方法论的 accept 分支处理:显式写进 blind_spots 备查。
CRITIQUE_TEXT_TYPES = ("language_compliance", "closure", "redundancy")

# 允许改写的文本字段。刻意不含 name / id / *_filter:
# 人群 name 被 priority_actions.target_audiences 和 crowd_rules.json 同时引用,
# 改一个字就会让圈人对不上(fnd_r41 就是这么丢的),宁可不修也不能动。
CRITIQUE_TEXT_FIELDS = ("headline", "subhead", "title", "signal", "detail", "narrative",
                        "root_cause", "impact", "description", "expected_impact",
                        "rationale", "profile_text", "summary")


def priority_actions_of(state):
    """容忍两种形状地取出行动清单:正版 schema 是 {"priority_actions": [...]},
    但也见过直接写成数组的。

    fix6d 之后这件事从"洁癖"变成了"必须":报告正文改由带工具权限的模型自己产出,
    它交回来的 state 形状就不再由驱动这边保证了。为一个纯展示字段的形状意外,
    把一份本来合格的报告整份判废,是把代价放错了地方。
    取不出来就返回空列表 —— 调用方一律按"没有行动项"处理,不抛。
    """
    ap = state.get("action_plan") if isinstance(state, dict) else None
    if isinstance(ap, dict):
        acts = ap.get("priority_actions")
    elif isinstance(ap, list):
        acts = ap
    else:
        acts = None
    return [a for a in (acts or []) if isinstance(a, dict)]


def _obj_at(state, path):
    cur = state
    for m in _PATH_TOK.finditer(path):
        t = m.group(1) if m.group(1) is not None else int(m.group(2))
        try:
            cur = cur[t]
        except (KeyError, IndexError, TypeError):
            return None
    return cur


def critique_target_paths(state, issue):
    """把一条 issue 落到具体可改写的字段路径上。定位不到返回 []。

    定位不到不是小事:它意味着这条问题只能记账、不能修,所以调用方要如实告警,
    不能因为"清单空了"就当成修好了。
    """
    kind = str(issue.get("target_kind") or "")
    tid = str(issue.get("target_id") or "").strip()
    base = None
    if kind == "finding":
        for i, f in enumerate(state.get("findings") or []):
            if str(f.get("id") or "") == tid and tid:
                base = "findings[{}]".format(i)
                break
    elif kind == "audience_segment":
        for i, s in enumerate(state.get("audience_segments") or []):
            if str(s.get("name") or "") == tid and tid:
                base = "audience_segments[{}]".format(i)
                break
    elif kind == "priority_action":
        acts = priority_actions_of(state)
        for i, a in enumerate(acts):
            if tid and tid in (str(a.get("rank") or ""), str(a.get("title") or "")):
                base = "action_plan.priority_actions[{}]".format(i)
                break
    elif kind == "narrative":
        probs = ((state.get("narratives") or {}).get("problems") or [])
        if tid.isdigit() and int(tid) < len(probs):
            base = "narratives.problems[{}]".format(int(tid))
    if base is None:
        return []
    obj = _obj_at(state, base)
    if not isinstance(obj, dict):
        return []
    return ["{}.{}".format(base, k) for k in CRITIQUE_TEXT_FIELDS
            if isinstance(obj.get(k), str) and obj.get(k).strip()]


def _blind_spot_entry(issue, rnd):
    return {
        "topic": "[{}] {}".format(issue.get("type"), issue.get("message"))[:180],
        "evidence": "skill self_critique 第 {} 轮提出,target={}/{};"
                    "方案 C 的模型不带工具,无法重算数据或重新诊断,"
                    "按 methodology/05 的 accept 分支显式保留".format(
                        rnd, issue.get("target_kind"), issue.get("target_id")),
        "recommended_probe": issue.get("suggested_fix") or "按 rediagnosis_plan 复诊",
    }


def park_in_blind_spots(state, issues, rnd):
    """methodology/05 的硬规矩:第二轮之后仍在的 warning 必须能在 blind_spots 里查到,
    否则算流程违规。改不动的那些就明写在这儿,别让它悄悄消失。"""
    if not issues:
        return 0
    plan = state.get("action_plan")
    if not isinstance(plan, dict):
        # 形状不对也得有地方记账 —— 记不下来等于问题凭空消失,那正是方法论
        # 明令禁止的。就地扶正成正版形状,原来的数组留在 priority_actions 里。
        plan = {"priority_actions": plan} if isinstance(plan, list) else {}
        state["action_plan"] = plan
    spots = plan.setdefault("blind_spots", [])
    have = set()
    for s in spots:
        if isinstance(s, dict):
            have.add(str(s.get("topic") or ""))
        else:
            have.add(str(s))
    n = 0
    for it in issues:
        e = _blind_spot_entry(it, rnd)
        if e["topic"] in have:
            continue
        have.add(e["topic"])
        spots.append(e)
        n += 1
    return n


def critique_repair(ctx, state_path, steps, call_cli, extract_json, info):
    """跑 skill 自带质检,并按它自己那张归宿表把每条 issue 安排掉。

    以前这一步整个不存在:我在外面手写了一套字数体检,却没调 skill 自带的质检环节。
    现在的分工是 —— 文字类的问题交给模型重写,重算类的问题按方法论显式落进 blind_spots,
    两类都不许悄悄放过。
    """
    if not SELF_CRITIQUE or CRITIQUE_ROUNDS <= 0:
        return None
    fn = getattr(steps, "self_critique", None)
    if fn is None:
        return None

    stat = {"rounds": [], "fixed": 0, "parked": 0, "left": None, "unlocated": 0}
    for rnd in range(1, CRITIQUE_ROUNDS + 1):
        issues = fn(ctx, state_path, rnd)
        if issues is None:
            ctx.warn("skill 自带质检没问到结果,本次报告未经它的质检")
            stat["left"] = None
            ctx.critique = stat
            return stat
        n_err = len([i for i in issues if i.get("severity") == "error"])
        by_type = {}
        for i in issues:
            by_type[i.get("type")] = by_type.get(i.get("type"), 0) + 1
        stat["rounds"].append({"round": rnd, "total": len(issues),
                               "error": n_err, "by_type": by_type})
        ctx.log("skill 质检 r{}:{} 条(error {}),分布 {}".format(
            rnd, len(issues), n_err, by_type))
        if not issues:
            stat["left"] = 0
            ctx.critique_left = 0
            ctx.critique = stat
            ctx.log("skill 自带质检通过")
            return stat

        state = _load(state_path)
        text_issues = [i for i in issues if i.get("type") in CRITIQUE_TEXT_TYPES]
        other = [i for i in issues if i.get("type") not in CRITIQUE_TEXT_TYPES]

        items, seen = [], set()
        unlocated = []
        for it in text_issues:
            paths = critique_target_paths(state, it)
            if not paths:
                unlocated.append(it)
                continue
            need = "{}(skill 质检 {} 级);建议:{}".format(
                it.get("message") or "", it.get("severity") or "warning",
                it.get("suggested_fix") or "")
            for p in paths:
                if p in seen or len(items) >= 24:
                    continue
                seen.add(p)
                items.append({"path": p, "need": need, "current": _str_at(state, p)})
        stat["unlocated"] += len(unlocated)
        if unlocated:
            ctx.warn("有 {} 条质检问题定位不到具体字段,只能记账不能自动修"
                     "(第一条:{})".format(len(unlocated),
                                          (unlocated[0].get("message") or "")[:60]))

        hit = 0
        if items:
            prompt = build_repair_prompt(state, items)
            tag = "critique_r{}".format(rnd)
            _save_text(ctx, "repair_prompt_{}.txt".format(tag), prompt)
            call = call_cli(prompt, POLISH_TIMEOUT)
            info["calls"] = info.get("calls", 0) + 1
            out = call.get("stdout") or ""
            _save_text(ctx, "repair_stdout_{}.txt".format(tag), out)
            got = fills_from_output(out, [it["path"] for it in items], extract_json)
            for path, val in got.items():
                if _is_draft_text(val, path):
                    continue
                if set_by_path(state, path, val):
                    hit += 1
            stat["fixed"] += hit
            ctx.log("质检重写 r{}:问了 {} 条,改上 {} 条 (exit={})".format(
                rnd, len(items), hit, call.get("exit_code")))

        parked = park_in_blind_spots(state, other + unlocated, rnd)
        stat["parked"] += parked
        if parked:
            ctx.log("有 {} 条问题按方法论显式记入 action_plan.blind_spots".format(parked))

        strip_label_thousands(state)
        _dump(state_path, state)
        if hit == 0 and rnd >= 1 and not items:
            break                      # 没有能改的文字问题了,再问一轮也是同样的结论

    # 轮次用完:再问一次拿最终账
    final = fn(ctx, state_path, CRITIQUE_ROUNDS + 1)
    if final is not None:
        stat["left"] = len(final)
        stat["left_error"] = len([i for i in final if i.get("severity") == "error"])
        ctx.critique_left = len(final)
        if final:
            state = _load(state_path)
            stat["parked"] += park_in_blind_spots(state, final, CRITIQUE_ROUNDS + 1)
            _dump(state_path, state)
            ctx.warn("skill 自带质检跑完仍有 {} 条(error {}),已全部记入 blind_spots".format(
                len(final), stat["left_error"]))
        else:
            ctx.log("skill 自带质检通过(收尾复检)")
    ctx.critique = stat
    return stat


# --------------------------------------------------------------------------- 渠道词汇门禁

_CH_BAD = re.compile(r"渠道[：:]\s*(\S+?)\s*专属词汇\s*(\[[^\]]*\])")
_CH_ACT = re.compile(r"实际渠道[：:]\s*(\[[^\]]*\]|\S+)")
_CH_QUOTED = re.compile(r"'([^']+)'|\"([^\"]+)\"")

# 实在改不动时的兜底替换。只在模型没改干净时才用,而且只换渠道那个词头,
# 剩下的句子一个字不动 —— 宁可读起来平淡,也不能带着别的渠道的词出报告。
_CH_PREFIX = {"ad": "活动", "ads": "活动", "activity": "活动", "活动": "活动",
              "push": "Push", "sms": "短信", "短信": "短信",
              "popup": "弹屏", "pop_up": "弹屏", "弹屏": "弹屏"}
_CH_HEADS = ("广告", "弹屏", "短信", "Push", "Push ")


def parse_channel_gate(tail):
    """从 render 的 REWRITE_REQUIRED 段落里抠出违规词和实际渠道。

    只认它打印的那几行,不去猜 location 字符串的结构 —— location 一旦改格式,
    按位置解析的代码会静默改错地方,而按词面搜索最多是搜不到。
    """
    bad, actual = [], []
    for line in (tail or "").splitlines():
        m = _CH_BAD.search(line)
        if m:
            for a, b in _CH_QUOTED.findall(m.group(2)):
                t = (a or b).strip()
                if t and t not in bad:
                    bad.append(t)
        m = _CH_ACT.search(line)
        if m:
            blob = m.group(1)
            got = [(a or b).strip() for a, b in _CH_QUOTED.findall(blob)]
            if not got:
                got = [blob.strip().strip("[]")]
            for t in got:
                if t and t not in actual:
                    actual.append(t)
    return bad, actual


def paths_with_terms(state, terms, prefix="", out=None):
    """把 state 里所有含违规词的可改写字段找出来。

    按词面全树搜索,不解析 location。多花一点遍历,换的是"绝不会改错对象"。
    """
    if out is None:
        out = []
    if isinstance(state, dict):
        for k, v in state.items():
            p = "{}.{}".format(prefix, k) if prefix else k
            if (isinstance(v, str) and k in CRITIQUE_TEXT_FIELDS
                    and any(t in v for t in terms)):
                out.append(p)
            else:
                paths_with_terms(v, terms, p, out)
    elif isinstance(state, list):
        for i, v in enumerate(state):
            paths_with_terms(v, terms, "{}[{}]".format(prefix, i), out)
    return out


def _channel_word(actual):
    for a in actual or []:
        w = _CH_PREFIX.get(str(a).strip().lower()) or _CH_PREFIX.get(str(a).strip())
        if w:
            return w
    return (actual or ["活动"])[0]


def blunt_channel_fix(state, paths, bad, actual):
    """兜底:把违规词里的渠道词头换成实际渠道的词头,其余原样。"""
    word = _channel_word(actual)
    n = 0
    for p in paths:
        cur = _str_at(state, p)
        neu = cur
        for t in bad:
            if t not in neu:
                continue
            rep = t
            for head in _CH_HEADS:
                if t.startswith(head):
                    rep = word + t[len(head):]
                    break
            if rep == t:                    # 认不出词头就整词换掉,不留违规词
                rep = word + "用户"
            neu = neu.replace(t, rep)
        if neu != cur and set_by_path(state, p, neu):
            n += 1
    return n


def channel_repair_state(ctx, state, tail, rnd, call_cli, extract_json, info):
    """按 render 的 REWRITE_REQUIRED 指令,就地改掉 state 里的违规渠道词。

    只动内存里的 state、不碰文件 —— 润色阶段(state 还在手上)和 render 阶段
    (state 已经落盘)因此共用同一套改法,不会出现两条链路修得不一样的情况。
    返回落地的处数;0 表示一处都没改上,调用方据此决定放弃还是重试。
    """
    bad, actual = parse_channel_gate(tail)
    if not bad:
        ctx.warn("渠道门禁拦下了,但没抠出具体违规词,改不了")
        return 0
    paths = paths_with_terms(state, bad)
    ctx.warn("渠道词汇门禁:{} 这些词在本次渠道({})里不存在,命中 {} 处文案,"
             "按 skill 的修正指令改写(不使用 --allow-channel-lint)".format(
                 "/".join(bad[:6]), "/".join(actual[:3]) or "未知", len(paths)))
    if not paths:
        return 0
    items = [{"path": p,
              "need": "删掉「{}」这类不属于本次渠道的词,换成实际渠道({})的说法,"
                      "如「活动触达用户」「活动推送」;句子其余部分和所有数字保持不变".format(
                          "/".join(bad[:4]), "/".join(actual[:2]) or "activity"),
              "current": _str_at(state, p)} for p in paths[:24]]
    prompt = build_repair_prompt(state, items)
    tag = "channel_r{}".format(rnd)
    _save_text(ctx, "repair_prompt_{}.txt".format(tag), prompt)
    call = call_cli(prompt, POLISH_TIMEOUT)
    info["calls"] = info.get("calls", 0) + 1
    out = call.get("stdout") or ""
    _save_text(ctx, "repair_stdout_{}.txt".format(tag), out)
    got = fills_from_output(out, [it["path"] for it in items], extract_json)
    hit = 0
    for p, v in got.items():
        if _is_draft_text(v, p) or any(t in v for t in bad):
            continue                   # 改完还带着违规词,等于没改,别写回去
        if set_by_path(state, p, v):
            hit += 1
    left = paths_with_terms(state, bad)
    blunt = blunt_channel_fix(state, left, bad, actual) if left else 0
    if blunt:
        ctx.warn("有 {} 处模型没改干净,按渠道词头做了机械替换(读起来会平淡些,"
                 "但不能带着别的渠道的词出报告)".format(blunt))
    info.setdefault("channel_fix", []).append(
        {"round": rnd, "bad_terms": bad[:8], "actual": actual[:4],
         "paths": len(paths), "model_fixed": hit, "blunt_fixed": blunt})
    return hit + blunt


def make_channel_rewriter(ctx, state_path, call_cli, extract_json, info):
    """给 SkillSteps.render 的回调:门禁一拦就按它给的指令改文案,然后重渲。

    以前撞上这道门禁的结果是:没有对应的强制开关 → 抛错 → _try 降级成本地骨架页,
    用户看到的就是"样式不对"的那张应急页。门禁本身是对的 —— 报告里写着"广告用户",
    可这次活动根本没有广告渠道,该改的是文案不是门禁。
    """
    if not CHANNEL_FIX:
        return None

    def _rewrite(tail, rnd):
        state = _load(state_path)
        n = channel_repair_state(ctx, state, tail, rnd, call_cli, extract_json, info)
        if not n:
            return False
        strip_label_thousands(state)
        _dump(state_path, state)
        ctx.log("渠道词汇改写 r{}:落地 {} 处,重新 render".format(rnd, n))
        return True

    return _rewrite


def build_prepare_meta(ctx):
    """拼 prepare 的 --meta。**只放显式给的,一个占位符都不造。**

    2026-07-30 改口径:skill 的 --auto-meta 用 setdefault 合并,"已提供的字段不覆盖"。
    老版本在这儿把 campaign_name 兜成 str(activity_id)、campaign_type 兜成「社群进群」,
    等于抢在 auto-meta 之前塞了占位值,把它从数据推真值的路整个堵死 ——
    356352 那单报告标题显示活动 ID 就是这么来的(数据里明明有 activity_name)。
    现在的兜底链(在 prepare 之后的 apply_meta_defaults 收尾):
      campaign_name:入参/MA_CAMPAIGN_NAME → 数据 activity_name(auto-meta)→ activity_id
      campaign_type:入参 → 数据 activity_channel(auto-meta 的 target_channels)→「活动」
      target_products:入参/MA_TARGET_PRODUCTS → 数据 activity_product_name(auto-meta)
    """
    raw = ctx.params.get("meta")
    meta = {}
    if isinstance(raw, dict):
        meta = dict(raw)
    elif isinstance(raw, str) and raw.strip():
        try:
            got = json.loads(raw)
            meta = dict(got) if isinstance(got, dict) else {}
        except ValueError:
            ctx.warn("入参 meta 不是合法 JSON,已忽略")
    if not meta.get("campaign_type") and ctx.params.get("campaign_type"):
        meta["campaign_type"] = ctx.params["campaign_type"]
    if not meta.get("campaign_name") and CAMPAIGN_NAME:
        meta["campaign_name"] = CAMPAIGN_NAME
    ctx.meta_given = set(k for k in ("campaign_name", "campaign_type") if meta.get(k))
    if not meta.get("target_products"):
        if TARGET_PRODUCTS:
            meta["target_products"] = [x for x in re.split(r"[,，/\s]+", TARGET_PRODUCTS) if x]
            ctx.products_given = list(meta["target_products"])
        else:
            # 没给就走 --auto-meta 从数据里的 activity_product_name 取 —— 这是正常默认路径,
            # 不是降级,所以这里不进 warnings(进了会让每一单都顶着一条假警报)。
            # 真正该盯的不是"有没有给",而是"取出来的到底是不是品类名":
            # 那一列有时存的是页面名(「特价机票业务总览」)。所以只记一笔来源,
            # 等 prepare 跑完再回读实际取到的值来判(见 check_inferred_products)。
            ctx.meta_guessed = True
    else:
        _tp = meta.get("target_products")
        ctx.products_given = [x for x in ([_tp] if isinstance(_tp, str) else (_tp or []))
                              if isinstance(x, str) and x.strip()]
    return json.dumps(meta, ensure_ascii=False)


def apply_meta_defaults(ctx, state_path):
    """prepare 之后的 meta 收尾兜底(2026-07-30 口径)。

    auto-meta 能从数据里推的这时候都推完了(campaign_name←activity_name、
    target_channels←activity_channel、target_products←activity_product_name),
    这里只处理"数据里也没有"的残局,并把最终值写回 state:
      campaign_name 还空 → 用 activity_id 兜底,并 warn(报告标题会显示活动 ID)
      campaign_type 还空 → 先用 target_channels 第一个(即数据的 activity_channel),
                           再不行才是默认「活动」
    另把最终 campaign_type 同步回 ctx.params(Agent 提示词里的「活动类型」用它)。
    """
    try:
        state = _load(state_path)
    except (IOError, OSError, ValueError) as exc:
        ctx.warn("meta 收尾兜底跳过:读不了 state({})".format(exc))
        return None
    cm = state.get("campaign_meta")
    if not isinstance(cm, dict):
        cm = {}
        state["campaign_meta"] = cm
    given = getattr(ctx, "meta_given", set()) or set()
    changed = False

    name = cm.get("campaign_name")
    if not (isinstance(name, str) and name.strip()):
        cm["campaign_name"] = str(ctx.activity_id)
        changed = True
        ctx.warn("campaign_name 入参没给、数据里也没有 activity_name —— 报告标题只能显示"
                 "活动 ID({});要正经标题就在入参 meta.campaign_name 里给".format(ctx.activity_id))
    else:
        ctx.log("campaign_name = {}({})".format(
            name.strip(), "入参/环境变量" if "campaign_name" in given
            else "数据 activity_name(auto-meta 推断)"))

    ctype = cm.get("campaign_type")
    if not (isinstance(ctype, str) and ctype.strip()):
        first = None
        chans = cm.get("target_channels")
        if isinstance(chans, list):
            for c in chans:
                if isinstance(c, str) and c.strip():
                    first = c.strip()
                    break
        cm["campaign_type"] = first or "活动"
        changed = True
        ctx.log("campaign_type 未传,{}".format(
            "取数据 activity_channel:{}".format(first) if first
            else "数据里也没有渠道字段,按默认「活动」"))
    else:
        ctx.log("campaign_type = {}({})".format(
            ctype.strip(), "入参" if "campaign_type" in given else "数据/上游已有"))

    ctx.params["campaign_type"] = cm.get("campaign_type")
    if changed:
        _dump(state_path, state)
    return cm


# 页面名/栏目名的常见尾巴。命中不等于一定错,但值得让人看一眼再往下走。
_PAGE_NAME_HINTS = ("总览", "业务", "频道", "专区", "首页", "页面", "会场", "专题",
                    "banner", "Banner", "落地页", "活动页", "大促", "列表页")


def check_inferred_products(ctx, state_partial):
    """prepare 跑完之后,回读 --auto-meta 实际取到的 target_products。

    默认值本来就该来自数据里的 activity_product_name,所以"用了默认"不值得报警;
    值得报警的是取回来的东西看着像页面名而不是品类名 —— 那会让「跨品类推送错配」
    这一类规则整片误判,而且是静悄悄地错。

    读不出来就当没这回事:这只是一次抽查,不该让一份本来能出的报告卡在这儿。
    """
    if not getattr(ctx, "meta_guessed", False):
        return None
    try:
        st = _load(state_partial)
        got = ((st or {}).get("campaign_meta") or {}).get("target_products")
    except Exception:
        return None
    # 单个字符串也认:这份 state 是 skill 写的,形状不归驱动这边保证,
    # 直接 for 一个字符串会把「机票」拆成两个字,那种"取到了"比取不到更坏。
    if isinstance(got, str):
        got = [got]
    got = [x for x in (got or []) if isinstance(x, str) and x.strip()]
    if not got:
        return None
    ctx.products_inferred = got
    smelly = [x for x in got if any(h in x for h in _PAGE_NAME_HINTS) or len(x) >= 8]
    if smelly:
        ctx.warn("--auto-meta 从 activity_product_name 取到的品类是 {},"
                 "看着像页面名而不是品类名(如「机票」);跨品类相关规则的结论请先人工确认,"
                 "要改就在入参 meta.target_products 里显式给,或设 MA_TARGET_PRODUCTS".format(
                     "、".join(smelly)))
    return got


def _save_text(ctx, name, text):
    try:
        with open(ctx.path(name), "w", encoding="utf-8") as fh:
            fh.write(text or "")
    except OSError:
        pass


# --------------------------------------------------------------------------- 报告产出 Agent

# 这几个字段是下游圈人已经用掉的锚点。crowd_rules.json 在这一步之前就生成了,
# 里面的 name / sql_filter / estimated_size 跟 state 里必须一一对得上;
# Agent 改动其中任何一个,报告和人群包就会指向两拨人 —— fnd_r41 就是这么丢的。
SEG_ANCHORS = ("name", "sql_filter", "estimated_size", "direction", "finding_id")

AGENT_PROMPT_TMPL = u"""你是营销诊断报告的产出者。这一单的所有中间产物都在:{rundir}

现在要做的事:把 {draft} 这份草稿,用 marketing-audit 这个 skill 做成定稿。

skill 的位置:
- 目录:{skill_dir}
- 命令行:{cli}
先读 {skill_md},按它写的流程走。它自己那套方法论在 {methodology} 下面,
写作规范看 03_synthesis,质检看 05_self_critique。

流程(以 SKILL.md 为准,下面只是提醒):
0. 【先落稿,再自检】第一步就把完整定稿直接写到 {out}(第一版不必完美),
   之后每一步改进都原地更新这个文件。这次运行有超时上限,任何时刻被杀,
   {out} 都必须已经是一份完整可用的稿子 —— 只存在于你脑子里的改法一文不值。
1. 读 {draft},把里面所有 [待润色] 之类的空槽按 skill 的写作规范写实;
2. 写够 skill 要求的字数,narratives.headline 不得少于 30 字;
3. _stage 置为 full,清掉 _draft 标记;
4. 跑 `{cli_cmd} run-tools --state <state> --out {rundir} --tools self_critique`,
   按它报的 issue 改;error 级必须改掉,warning 改不掉的按 05_self_critique 的规矩
   显式写进 action_plan.blind_spots;
5. 跑 `{cli_cmd} render --state <state> --out {rundir}` 确认三道门禁都过;
6. 收尾时确认 {out} 就是最终定稿(按第 0 条,它全程都应该是最新的)。

时间预算:你大约有 {timeout_min} 分钟。时间紧张时优先保证正文写完、字数达标 ——
self_critique 和 render 后面的流程还会替你复核;不要花时间写批量改写脚本,
直接改 {out} 这个文件本身。

这一单的背景:
- activity_id:{activity_id}
- 活动类型:{campaign_type}
- 数据来源:{data_source}
- 推送口径:接口只输出需要推送(push)的人群,需要排除的人群不推送,
  所以人群相关的结论要按「推送谁」来写,不要写成「排除谁」。

硬约束(违反的话这一步的产出会被丢弃):
- 你的工作目录**不是** {rundir},所有读写一律用上面给出的绝对路径,不要用相对路径。
- 只能在 {rundir} 里面写文件。不要改 {skill_dir} 下面的任何东西 —— skill 是只读的。
- 不要改 audience_segments 里的 name / sql_filter / estimated_size / direction /
  finding_id。这些字段下游已经拿去圈人了,改一个字报告和人群包就对不上。
  profile_text 这类纯描述可以改写。
- 不要删 findings,不要新增或删除 audience_segments,不要编造数据里没有的数字。
- 不要用 --allow-channel-lint、--skip-validate、--skip-completeness 硬闯门禁。
  渠道词汇违规(REWRITE_REQUIRED)是最高优先级阻塞,只能改文案,不能绕。
- 正文里不许留 [待润色]、TODO、占位句。

做完之后,用不超过 10 行讲清楚:你跑了哪几条 skill 命令、self_critique 报了几条、
render 是否一次过、还有什么没解决。不要把报告正文贴回来。
"""


def _agent_prompt(ctx, draft_path, out_path, data_label=None):
    """拼给 Agent 的提示词。MA_AGENT_PROMPT 指了文件就用文件里的模板。"""
    tmpl = AGENT_PROMPT_TMPL
    if AGENT_PROMPT_FILE and os.path.exists(AGENT_PROMPT_FILE):
        try:
            with open(AGENT_PROMPT_FILE, encoding="utf-8") as fh:
                tmpl = fh.read()
        except (IOError, OSError) as exc:
            ctx.warn("读不了自定义提示词模板({}),用内置的".format(exc))
    skill_dir = os.path.dirname(os.path.abspath(MA_CLI)) if MA_CLI else ""
    fields = {
        "rundir": ctx.rundir,
        "draft": draft_path,
        "out": out_path,
        "skill_dir": skill_dir,
        "cli": MA_CLI,
        "cli_cmd": "{} {}".format(SKILL_PY, MA_CLI),
        "skill_md": os.path.join(skill_dir, "SKILL.md"),
        "methodology": os.path.join(skill_dir, "methodology"),
        "activity_id": ctx.activity_id,
        "campaign_type": ctx.params.get("campaign_type") or "未指定",
        "data_source": data_label or RUNTIME,
        "timeout_min": max(1, AGENT_TIMEOUT // 60),
    }
    try:
        return tmpl.format(**fields)
    except (KeyError, IndexError, ValueError) as exc:
        ctx.warn("自定义提示词模板占位符对不上({}),用内置的".format(exc))
        return AGENT_PROMPT_TMPL.format(**fields)


def _seg_key(seg, idx):
    """给人群段一个跨版本还认得出来的身份:优先 finding_id,再退到位置。"""
    fid = (seg or {}).get("finding_id")
    return ("fid", fid) if fid else ("idx", idx)


def restore_seg_anchors(ctx, draft, out):
    """把 Agent 动过的圈人锚点回填成草稿里的值,并把改名反向映射回去。

    不是不信任它写的文案 —— 文案随它改,越好越好。但 name / sql_filter /
    estimated_size 这几样在它动手之前就已经被 crowd_rules.json 拿走了,
    这时候再改,报告说的人和实际推送的人就是两拨。
    返回 (回填处数, 改名映射)。
    """
    d_segs = draft.get("audience_segments") or []
    o_segs = out.get("audience_segments") or []
    renames, fixed = {}, 0
    if len(o_segs) != len(d_segs):
        ctx.warn("Agent 把人群段从 {} 段改成了 {} 段,整段回填成草稿版本"
                 "(圈人规则已经按草稿生成,不能中途变数)".format(len(d_segs), len(o_segs)))
        out["audience_segments"] = json.loads(json.dumps(d_segs))
        return len(d_segs), renames
    by_key = {}
    for i, s in enumerate(d_segs):
        by_key[_seg_key(s, i)] = s
    for i, o in enumerate(o_segs):
        d = by_key.get(_seg_key(o, i)) or d_segs[i]
        for k in SEG_ANCHORS:
            if k not in d:
                continue
            if o.get(k) != d.get(k):
                if k == "name" and isinstance(o.get(k), str):
                    renames[o[k]] = d[k]
                o[k] = d[k]
                fixed += 1
    if renames:
        # 名字回填了,引用也要跟着回填,否则 priority_actions 指向一个不存在的人群。
        # 这里必须走容忍形状的取法:action_plan 只是展示字段,它写歪了不该连累
        # 整份报告被判废(2026-07-29 本地端到端就是这么把一份合格产物扔掉的)。
        for a in priority_actions_of(out):
            tas = a.get("target_audiences")
            if isinstance(tas, list):
                a["target_audiences"] = [renames.get(t, t) for t in tas]
    if fixed:
        ctx.warn("Agent 动了 {} 个圈人锚点字段(改名 {} 处),已按草稿回填 —— "
                 "报告里的人群口径必须跟 crowd_rules.json 完全一致".format(fixed, len(renames)))
    return fixed, renames


def verify_agent_state(ctx, draft_path, out_path):
    """检查 Agent 交出来的 state_full.json 能不能用。能用就回填锚点后落盘。"""
    try:
        out = _load(out_path)
    except (IOError, OSError, ValueError) as exc:
        ctx.warn("Agent 交的 state_full.json 读不出来({}),这一步作废".format(exc))
        return None
    if not isinstance(out, dict) or not out.get("findings"):
        ctx.warn("Agent 交的 state 里没有 findings,这一步作废")
        return None
    draft = _load(draft_path)
    d_ids = [f.get("id") for f in (draft.get("findings") or []) if f.get("id")]
    o_ids = set(f.get("id") for f in (out.get("findings") or []))
    lost = [i for i in d_ids if i not in o_ids]
    if lost:
        ctx.warn("Agent 交的 state 少了 {} 条结论({}),这一步作废 —— "
                 "报告可以改写,但不能凭空少掉诊断结果".format(len(lost), ",".join(lost[:4])))
        return None
    fixed, renames = restore_seg_anchors(ctx, draft, out)
    _dump(out_path, out)
    return {"fixed_anchors": fixed, "renames": len(renames),
            "findings": len(out.get("findings") or []),
            "segments": len(out.get("audience_segments") or [])}


def run_report_agent(ctx, draft_path, call_cli, steps, data_label=None):
    """把报告产出交给带工具权限的 claude,让它自己去用 marketing-audit。

    返回 {"used": True, "state_full": 路径, ...};没跑或没跑成返回 {"used": False, ...},
    调用方据此决定是拿它的产物往下走,还是退回老链路。这一步永远不抛异常 ——
    它是"更好的那条路",不是必经之路。
    """
    info = {"used": False, "reason": None, "tools": AGENT_TOOLS}
    if not REPORT_AGENT:
        info["reason"] = "MA_REPORT_AGENT=0,按配置走驱动代跑 skill 的老链路"
        ctx.log(info["reason"])
        return info
    if getattr(steps, "name", "") != "skill":
        info["reason"] = "当前后端没有真 skill 可用(steps={}),交给 Agent 没有意义".format(
            getattr(steps, "name", "?"))
        ctx.log(info["reason"])
        return info
    if not MA_CLI or not os.path.exists(MA_CLI):
        info["reason"] = "找不到 skill 的 cli.py({}),这一步跳过".format(MA_CLI)
        ctx.warn(info["reason"])
        return info
    if call_cli is None or not getattr(call_cli, "supports_tools", False):
        # 老版本的 ma_api_c.py 注进来的 call_cli 不认 argv_extra/cwd。
        # 宁可跳过也不要偷偷用不带工具的调用去冒充 —— 那样日志里会写着"Agent 跑过了",
        # 实际上它连 SKILL.md 都读不到。
        info["reason"] = "注进来的 call_cli 不支持带工具调用,这一步跳过(升级 ma_api_c.py 即可)"
        ctx.warn(info["reason"])
        return info

    out_path = ctx.path("state_full.json")
    try:
        prompt = _agent_prompt(ctx, draft_path, out_path, data_label)
    except Exception as exc:                                       # noqa: BLE001
        info["reason"] = "提示词拼不出来({}),这一步跳过".format(exc)
        ctx.warn(info["reason"])
        return info
    _save_text(ctx, "agent_prompt.txt", prompt)
    extra = ["--allowedTools", AGENT_TOOLS]
    if AGENT_MAX_TURNS:
        extra += ["--max-turns", str(AGENT_MAX_TURNS)]
    ctx.log("把报告产出交给 claude 自己用 skill:工具={} 超时={}s 提示词={}字 "
            "(不开 --allow-dangerously-skip-permissions)".format(
                AGENT_TOOLS, AGENT_TIMEOUT, len(prompt)))
    try:
        call = call_cli(prompt, AGENT_TIMEOUT, argv_extra=extra, cwd=ctx.rundir)
    except Exception as exc:                                       # noqa: BLE001
        info["reason"] = "Agent 调用本身出错({}),退回老链路".format(exc)
        ctx.warn(info["reason"])
        return info
    call = call or {}
    info["exit_code"] = call.get("exit_code")
    info["elapsed_sec"] = call.get("elapsed_sec")
    info["timed_out"] = bool(call.get("timed_out"))
    _save_text(ctx, "agent_stdout.txt", call.get("stdout") or "")
    _save_text(ctx, "agent_stderr.txt", call.get("stderr") or "")
    for line in (call.get("stdout") or "").strip().splitlines()[-12:]:
        if line.strip():
            ctx.log("  [agent] " + line.strip()[:300])

    if call.get("exit_code") != 0:
        # 超时 ≠ 没干成。356352 那单:agent 在 1197.45s 已经 self_critique 0 issues、
        # render 三道门禁全过、DONE、exit 0,差 2.5 秒被 1200s 超时杀掉 —— 而
        # state_full.json 完整躺在盘上。老代码只看退出码就弃用,成品接着被降级
        # 润色覆盖,最后发出去的是骨架句废稿。所以先验产物,再决定弃不弃:
        # 锚点校验本来就是给"不可信产物"设的闸,超时稿走同一道闸,不额外冒险。
        if call.get("timed_out") and os.path.exists(out_path):
            try:
                chk = verify_agent_state(ctx, draft_path, out_path)
            except Exception as exc:                               # noqa: BLE001
                ctx.warn("校验超时 Agent 产物时出错({})".format(exc))
                chk = None
            if chk is not None:
                info.update(chk)
                info["used"] = True
                info["timed_out"] = True
                info["state_full"] = out_path
                info["reason"] = ("Agent 超时被杀({}s),但 state_full.json 已完整落盘"
                                  "且通过锚点校验,按成品采纳".format(call.get("elapsed_sec")))
                ctx.warn(info["reason"] + " —— 三道门禁仍由驱动自己再跑一遍")
                return info
        info["reason"] = "Agent 非零退出(exit={},{}s){}".format(
            call.get("exit_code"), call.get("elapsed_sec"),
            ",超时了" if call.get("timed_out") else "")
        ctx.warn(info["reason"] + " —— 退回驱动代跑 skill 的老链路")
        # 弃用就把文件挪走留证:一是好复盘,二是保证它绝不会被后面
        # 润色写盘时覆盖(356352 的成品就是这么没的)。
        if os.path.exists(out_path):
            try:
                os.replace(out_path, ctx.path("state_full.agent_{}.json".format(
                    "timeout" if call.get("timed_out") else "failed")))
                ctx.log("Agent 的 state_full.json 已挪存留证,不会被后续润色覆盖")
            except OSError:
                pass
        return info
    if not os.path.exists(out_path):
        info["reason"] = "Agent 跑完了但没留下 state_full.json,退回老链路"
        ctx.warn(info["reason"])
        return info
    try:
        chk = verify_agent_state(ctx, draft_path, out_path)
    except Exception as exc:                                       # noqa: BLE001
        ctx.warn("校验 Agent 产物时出错({})".format(exc))
        chk = None
    if chk is None:
        info["reason"] = "Agent 的产物没通过锚点校验,退回老链路"
        try:
            os.rename(out_path, ctx.path("state_full.agent_rejected.json"))
        except OSError:
            pass
        return info
    info.update(chk)
    info["used"] = True
    info["state_full"] = out_path
    ctx.log("Agent 交稿:{} 条结论 / {} 段人群,回填锚点 {} 处,耗时 {}s;"
            "接下来门禁仍由驱动自己跑一遍".format(
                chk["findings"], chk["segments"], chk["fixed_anchors"],
                call.get("elapsed_sec")))
    return info


def polish_state(ctx, state_draft_path, call_cli, extract_json, validate=None):
    """state_draft.json → state_full.json。唯一真正用到模型的一步。

    call_cli / extract_json 由调用方注入(ma_api_c.py 里就是那两个已经验证过的函数),
    这样这个模块不用自己再实现一遍 CLI 调用和降级判定。

    分轮补漏:第 1 轮把所有空槽一次问完(快),没填上的按 MA_POLISH_BATCH 拆小批再问,
    最多 MA_POLISH_ROUNDS 轮、总共不超过 MA_POLISH_BUDGET 秒。
    一次没接住不该让整篇报告陪葬 —— 这是 2026-07-29 那一单的教训。

    返回 (state_full_path, polish_info)。模型没跑通不算致命 —— 走降级:
    空槽保留原文,报告照样出,出参里标 degraded。
    """
    state = _load(state_draft_path)
    slots = collect_placeholders(state)
    # 空槽之外,还有一类要重写的:写了、但没写够 skill 的最小字数。
    # 这类不重写的话 render 会 exit=2,整份报告掉回本地骨架页。
    short0 = [p for p in short_fields(state) if p not in slots]
    if short0:
        slots = slots + short0
        ctx.log("另有 {} 处没写够 skill 的最小字数,一并重写:{}".format(
            len(short0), ", ".join(short0[:4])))
    info = {"slots": len(slots), "filled": 0, "degraded": False, "reason": None,
            "calls": 0, "rounds": []}
    ctx.log("待润色空槽 {} 处".format(len(slots)))

    if not slots:
        n_d, n_s = clear_draft_marks(state)
        state["_stage"] = "full"
        info["draft_marks_cleared"] = n_d
        ctx.log("清掉嵌套 _draft {} 个 / _stage 置 full {} 处".format(n_d, n_s))
        fixed = strip_label_thousands(state)
        if fixed:
            info["label_thousands_fixed"] = [
                "{}: {} \u2192 {}".format(p, a, b) for p, a, b in fixed][:10]
            ctx.log("\u6807\u7b7e\u53bb\u5343\u5206\u4f4d {} \u5904".format(len(fixed))
                    + "\uff08\u6e32\u67d3\u5668\u6309\u6807\u70b9\u5207\u77ed\u6807\u7b7e\uff0c"
                    + "\u6570\u5b57\u91cc\u7684\u9017\u53f7\u4f1a\u88ab\u5f53\u65ad\u70b9\uff09\uff1a"
                    + ", ".join(p for p, _, _ in fixed[:4]))
        schema_repair(ctx, state, validate, call_cli, extract_json, info)
        strip_label_thousands(state)
        p = ctx.path("state_full.json")
        _dump(p, state)
        return p, info

    started = time.time()
    pending = list(slots)
    applied = 0
    last_exit = None
    rejects = []

    for rnd in range(1, max(1, POLISH_ROUNDS) + 1):
        if not pending:
            break
        if time.time() - started > POLISH_BUDGET:
            ctx.warn("润色超出总预算 {}s,剩 {} 处不再重试".format(POLISH_BUDGET, len(pending)))
            break
        # 每一轮都拆小批(以前首轮 48 槽一把梭:55K 字的大题把思考型后端送进
        # 超过 300s 的长思考,-p 模式下颗粒无收 —— 356352 三杀实证)。
        # 小批的题小、思考短、输出短,不容易被截断,也好定位是哪批出问题。
        groups = _batches(pending, max(1, POLISH_BATCH))
        rnd_stat = {"round": rnd, "slots": len(pending), "groups": len(groups),
                    "filled": 0, "timeouts": 0}
        for gi, group in enumerate(groups):
            if time.time() - started > POLISH_BUDGET:
                break
            prompt = build_polish_prompt(state, group)
            tag = "r{}_{}".format(rnd, gi)
            with open(ctx.path("polish_prompt_{}.txt".format(tag)), "w", encoding="utf-8") as f:
                f.write(prompt)
            call = call_cli(prompt, POLISH_TIMEOUT)
            info["calls"] += 1
            last_exit = call.get("exit_code")
            out = call.get("stdout") or ""
            # 完整落盘。上一次复盘时只有出参里 300 字的 stdout_head,
            # 根本判断不出是被截断还是解析崩了 —— 这个坑不留给下一次。
            with open(ctx.path("polish_stdout_{}.txt".format(tag)), "w", encoding="utf-8") as f:
                f.write(out)
            if call.get("timed_out"):
                rnd_stat["timeouts"] += 1
            ctx.log("润色 r{}批{} exit={} elapsed={}s stdout={}字{}".format(
                rnd, gi, call.get("exit_code"), call.get("elapsed_sec"), len(out),
                "(超时被杀)" if call.get("timed_out") else ""))
            # 非零退出时把 stderr 尾巴带进任务日志 —— "0 字"到底是没吐还是报错,当场可见
            if call.get("exit_code") != 0 and (call.get("stderr") or "").strip():
                ctx.log("  ↳ stderr尾: " + (call.get("stderr") or "").strip()[-200:]
                        .replace("\n", " / "))
            got = fills_from_output(out, group, extract_json)
            hit = 0
            for path, val in got.items():
                if _is_draft_text(val, path):
                    # 模型把占位符原样抄回来了,不算填上。
                    # 这里曾经默默 continue,结果判重了也没人知道 —— 现在记下来。
                    rejects.append(path)
                    ctx.log("r{}批{}:{} 的回写看着还是骨架,丢弃「{}」".format(
                        rnd, gi, path, val[:40]))
                    continue
                if set_by_path(state, path, val):
                    hit += 1
            applied += hit
            rnd_stat["filled"] += hit
            if hit < len(group):
                ctx.log("r{}批{}:问了 {} 条,填上 {} 条".format(rnd, gi, len(group), hit))
        info["rounds"].append(rnd_stat)
        pending = collect_placeholders(state)
        pending += [p for p in short_fields(state) if p not in pending]
        if rnd_stat["filled"] == 0 and rnd > 1:
            ctx.warn("第 {} 轮一条都没补上,不再重试".format(rnd))
            break

    info["exit_code"] = last_exit
    info["elapsed_sec"] = round(time.time() - started, 2)
    info["filled"] = applied
    left = collect_placeholders(state)
    too_short = [p for p in short_fields(state) if p not in left]
    if too_short:
        # 这条要显眼:它是 render 拒渲染的直接原因,比"少填一句"严重
        info["too_short"] = ["{}({} 字 < {} 字)".format(
            p, len(_str_at(state, p)), min_len_for(p)) for p in too_short]
        left = left + too_short
        ctx.warn("有 {} 处仍没写够 skill 的最小字数:{} —— render 可能被 schema 门禁拦下".format(
            len(too_short), ", ".join(info["too_short"][:3])))
    info["remaining"] = len(left)
    if left:
        info["missed"] = left[:10]
    if rejects:
        # 没填上的时候先看这一栏:不为空就说明模型写了、是我们自己退的件
        info["rejected"] = rejects[:10]
        info["rejected_count"] = len(rejects)
    n_d, n_s = clear_draft_marks(state)
    state["_stage"] = "full"
    info["draft_marks_cleared"] = n_d
    ctx.log("清掉嵌套 _draft {} 个 / _stage 置 full {} 处".format(n_d, n_s))

    if applied == 0:
        info["degraded"] = True
        info["reason"] = "模型没返回可用的 fills"
        ctx.warn("润色一条都没落地,空槽保留原文,报告降级产出")
    elif left:
        info["degraded"] = True
        info["reason"] = "仍有 {} 处未填".format(len(left))
        ctx.warn("润色还剩 {} 处没填上(共 {} 处),报告可能仍含草稿句".format(len(left), len(slots)))
    else:
        ctx.log("润色 {} 处全部落地,{} 次调用,耗时 {}s".format(
            applied, info["calls"], info["elapsed_sec"]))

    fixed = strip_label_thousands(state)
    if fixed:
        info["label_thousands_fixed"] = [
            "{}: {} \u2192 {}".format(p, a, b) for p, a, b in fixed][:10]
        ctx.log("\u6807\u7b7e\u53bb\u5343\u5206\u4f4d {} \u5904".format(len(fixed))
                + "\uff08\u6e32\u67d3\u5668\u6309\u6807\u70b9\u5207\u77ed\u6807\u7b7e\uff0c"
                + "\u6570\u5b57\u91cc\u7684\u9017\u53f7\u4f1a\u88ab\u5f53\u65ad\u70b9\uff09\uff1a"
                + ", ".join(p for p, _, _ in fixed[:4]))
    # 体检放在最后:去千分位之后再问 skill,免得我们这一刀又把字数抠到线下面。
    # 重写完可能重新引入千分位,所以修完再抹一次。
    schema_repair(ctx, state, validate, call_cli, extract_json, info)
    strip_label_thousands(state)
    p = ctx.path("state_full.json")
    _dump(p, state)
    return p, info


# --------------------------------------------------------------------------- push 人群


# skill 出参里 direction 只认 push / exclude 两个值。遇到别的说法(中文动作词)
# 会被归一化成 exclude,原文留在 direction_raw —— 也就是说 direction_raw 一旦出现,
# 就意味着"这条的方向没映射上",此时 direction 本身是不可信的。
# 2026-07-28 那轮的 fnd_r41「创单未付待促付人群」(direction_raw="促付", 2403 人)
# 就是这么丢的:促付明明是最该推的一批人,被当成排除人群整包扔掉。
PUSH_INTENT_RAW = ("push", "推送", "触达", "促付", "促活", "促转化", "促成交",
                   "唤醒", "召回", "复购", "承接", "转化")


def normalize_direction(rule):
    """判定一条规则的推送方向,返回 (direction, fix_note)。

    fix_note 非空表示这条做过纠正或存疑,调用方要把它写进 warnings —— 宁可吵一点,
    也不要让一个人群包无声无息地消失。
    """
    raw = (rule.get("direction_raw") or "").strip()
    d = (rule.get("direction") or "").strip().lower()
    name = rule.get("name") or rule.get("finding_id") or "(未命名)"
    if raw and d != "push":
        if any(k in raw for k in PUSH_INTENT_RAW):
            return "push", ("规则「{}」direction={} 但 direction_raw={},"
                            "属推送意图,已纠正为 push".format(name, d or "(空)", raw))
        return (d or "exclude"), ("规则「{}」direction_raw={} 未识别,"
                                  "按 {} 处理,未进入推送包".format(name, raw, d or "exclude"))
    if not d:
        return "push", "规则「{}」没有 direction,按 push 处理".format(name)
    if d not in ("push", "exclude"):
        # 同一个坑的另一半:上面那支只在 skill 归一化过(direction=exclude +
        # direction_raw=促付)时才生效。可 direction 本身就不受 schema 约束 ——
        # 真 skill 的 crowd-rules 只统计 push/exclude 两个值,别的原样带出来,
        # 于是「促付」有可能直接落在 direction 上,没有 direction_raw 兜底。
        # 那样这条 2403 人的促付人群会一路滑进 excluded,和 fnd_r41 死法一模一样,
        # 只是换了个字段。所以这里对 direction 本身再判一次推送意图。
        if any(k in d for k in PUSH_INTENT_RAW):
            return "push", ("规则「{}」direction={} 不是 push/exclude,"
                            "但属推送意图,已纠正为 push".format(name, d))
        return "exclude", ("规则「{}」direction={} 未识别,按 exclude 处理,"
                           "未进入推送包".format(name, d))
    return d, None


def pick_push_rules(all_rules, push_source):
    """从 crowd_rules 里挑出参与圈人的规则。

    两个轴是正交的,不要混:

      - source:只用 audience_segment。诊断规则(diagnostic_rule)是"发现",
        不是策划挑出来的投放包,不圈人。这条与 run_one_activity.py 一致。
      - direction:只用 push。这条与离线流程**故意不一致**,是 API 模式特有的。
        离线流程里 direction 不参与筛选,因为它是留给下游(建表导入 / 推送平台)
        消费的;API 模式按约定把下游整个去掉了,出参只有报告链接和规则 JSON,
        消费 direction 的那一环没了,它就必须在这里生效。
        2026-07-28 那轮吃过亏:6 条 audience_segment 里 3 条是 exclude,其中
        「跨渠道高频疲劳人群」一条覆盖 49477/50000 人,OR 进 push_sql 之后,
        出参的 49735 人里九成恰恰是诊断结论说"别推"的人。

    按约定这里只做正选,不做反选 —— exclude 规则既不圈人,也不拿去对 push 人群
    做 AND NOT 过滤,它们只在 excluded 里留个名字备查。

    模型/规则的划分仍然只看 finding_id 前缀,不看 direction,那是另一个轴:
        fnd_model_*        → 模型输出
        fnd_r* / fnd_pos_* → 规则产出

    返回 (segs, picked, excluded, fixes)。
    """
    segs, excluded, fixes = [], [], []
    for r in all_rules:
        if r.get("source") != "audience_segment" or not r.get("sql_filter"):
            continue
        direction, fix = normalize_direction(r)
        if fix:
            fixes.append(fix)
        if direction == "push":
            if (r.get("direction") or "").strip().lower() != "push":
                # 纠正完要把结果写回出参。否则这条人群在 rules 里、size.push 也算了它,
                # 字段上却写着 direction=exclude —— 下游照着 direction 过滤一遍,
                # 等于纠正了个寂寞。原值不丢:direction_raw 留着,再记一条谁改的。
                r = dict(r)
                r["direction_from_skill"] = r.get("direction")
                r["direction"] = "push"
                r["direction_fixed"] = True
            segs.append(r)
        else:
            # 刻意不带 sql_filter 出去:排除规则不该被下游拿去执行
            excluded.append({"name": r.get("name"),
                             "finding_id": r.get("finding_id"),
                             "direction": direction,
                             "direction_raw": r.get("direction_raw"),
                             "estimated_size": r.get("estimated_size"),
                             "reason": "direction={},按接口口径不参与推送".format(direction)})
    if push_source == "model":
        picked = [r for r in segs if (r.get("finding_id") or "").startswith("fnd_model")]
    elif push_source == "rule":
        picked = [r for r in segs if (r.get("finding_id") or "").startswith(("fnd_r", "fnd_pos"))]
    else:
        picked = list(segs)
    return segs, picked, excluded, fixes


def build_push_sql(rules, table=None, id_col="mapid", union_col="unionid", base_where=None):
    """出参里那条可直接拿去跑的取数 SQL。

    去重用 GROUP BY <主键> + MIN(<unionid>):原流程用的是 Spark dropDuplicates(["mapid"]),
    保留哪条 unionid 是任意的。这里改成确定性的 MIN,是为了让接口给出的 SQL 可复现 ——
    代价是同一活动走 API 和走原流程,mapid 集合一致但个别 unionid 可能不同。
    这条差异写进 notes,不藏着。

    表名与两个列名都由数据源给出:csv 模式下这条 SQL 是照着那份 CSV 的真实表头写的,
    换回 hive 就自动变成人群池表。
    """
    if not rules:
        return None, None
    t = table or POP_TABLE
    pred = "\n     OR ".join("({})".format(r["sql_filter"]) for r in rules)
    if base_where:
        # fix15:两表合一的活动过滤 —— 与 count_push_total 口径一致,
        # 且业务直接拿去跑时也吃到分区剪裁。
        pred = "({})\n   AND (\n       {}\n   )".format(base_where, pred)
    if union_col and union_col != id_col:
        proj = "SELECT {i},\n       MIN({u}) AS {u}\n".format(i=id_col, u=union_col)
    else:
        proj = "SELECT {i}\n".format(i=id_col)
    push_sql = (proj + "  FROM {t}\n WHERE {p}\n GROUP BY {i}").format(t=t, p=pred, i=id_col)
    count_sql = ("SELECT COUNT(DISTINCT {i}) AS push_size\n"
                 "  FROM {t}\n WHERE {p}").format(i=id_col, t=t, p=pred)
    return push_sql, count_sql


def build_notes(ctx, backend, dropped, degraded_polish, has_rules, excluded=None):
    src = backend.source
    idc, unc = src.id_col, src.union_col
    notes = [
        "本接口只输出需要推送的人群,排除人群不在出参内,也不做任何表写入",
        "population_size 之间互相重叠,不可相加;权威人数以 size.push 为准",
        "{} 在样本池中不唯一,取数必须按 {} 去重".format(idc, idc),
        "一个 {} 命中多个 {} 时保留哪一条是不确定的,{} 不可作主键".format(idc, unc, unc),
        "push_sql 用 GROUP BY {} + MIN({}) 做确定性去重;原离线流程用 dropDuplicates,"
        "{} 集合一致,个别 {} 可能不同".format(idc, unc, idc, unc),
        "模型/规则的划分只看 finding_id 前缀(fnd_model_* vs fnd_r*/fnd_pos_*),与离线流程一致;"
        "direction 是另一个轴,只决定推不推",
        "只有 source=audience_segment 且 direction=push 的规则参与圈人;"
        "排除规则既不圈人,也不用于对推送人群做反向过滤",
    ]
    # getattr 防御:回归脚本里的 FakeSrc 只带用到的字段,不继承 BaseSource,
    # 不能要求它有 base_where(fix15 首装时 regress_agent §7 就是这么炸的)。
    _bw = getattr(src, "base_where", None)
    _bw = _bw(ctx) if callable(_bw) else None
    if _bw:
        notes.insert(0, "人群池口径(fix15):两表合一,计数与 push_sql 已限定 {} —— "
                        "人数=该活动特征行内命中,不含其他活动".format(_bw))
    if src.name == "synth":
        notes.insert(0, "⚠ 人群池是本地合成的假数据,人数与 SQL 结果不可用于生产决策")
    elif src.name == "csv":
        notes.insert(0, "⚠ 人数是在本地 CSV({}) 上算的,不是生产人群池;"
                        "push_sql 的 FROM 已按 {} 写好,但列名要和线上表对齐后才能直接跑".format(
                            os.path.basename(getattr(src, "path", "") or ""), src.sql_table))
    if backend.steps.name == "stub":
        notes.append("本次未调用 marketing-audit skill,人群规则由本地骨架按数据分位数生成,不是模型结论")
    elif ctx.skill_degraded:
        notes.append("marketing-audit skill 有步骤未跑通并已降级为本地骨架(见 warnings),规则质量低于正常水平")
    # 报告正文是谁写的,得写清楚 —— 这两条路的产出质量不是一回事
    _ag = getattr(ctx, "report_agent", None) or {}
    if _ag.get("used"):
        notes.append("报告正文由带工具权限的 claude 自己调 marketing-audit 产出"
                     "(工具:{});圈人锚点、三道门禁和推送口径仍由本服务复核,"
                     "其中回填了 {} 处被改动的人群锚点".format(
                         _ag.get("tools"), _ag.get("fixed_anchors", 0)))
    elif backend.steps.name != "stub":
        notes.append("报告正文走的是「本服务代跑 skill 子命令 + 模型补空槽」这条链"
                     "({}),不是模型自己端到端用 skill".format(
                         _ag.get("reason") or "未启用报告产出 Agent"))
    if getattr(ctx, "render_forced", False):
        notes.append("报告用 skill 的 {} 强制渲染:样式与结构是 skill 正版模板,"
                     "但正文可能仍有不达标之处(草稿骨架句 / 字数不够),"
                     "发给业务前需人工过一遍".format(
                         " ".join(getattr(ctx, "render_flags", None) or ["--skip-completeness"])))
    if excluded:
        notes.append("有 {} 条 direction=exclude 的人群规则未参与推送(只在 excluded_rules 里留名备查,"
                     "不含 sql_filter,不计入 size.push)".format(len(excluded)))
    if dropped:
        notes.append("有 {} 条规则未通过人群表 dry-run 校验,已剔除且不计入人数(见 dropped_rules)".format(len(dropped)))
    if degraded_polish:
        notes.append("本次报告润色未完成(模型环节降级),报告正文可能仍含 [待润色]")
    _cq = getattr(ctx, "critique", None)
    if _cq is None:
        if backend.steps.name != "stub":
            notes.append("本次未跑通 skill 自带的 self_critique 质检,报告只过了字数/完备性两道机械门禁")
    elif _cq.get("left") is None:
        notes.append("skill 自带质检没问到结果,本次报告未经它的质量裁决")
    elif _cq.get("left"):
        _ag_used = bool((getattr(ctx, "report_agent", None) or {}).get("used"))
        notes.append("skill 自带质检剩 {} 条未解决(其中 error {} 条),"
                     "已按方法论逐条记入 action_plan.blind_spots;{}".format(
                         _cq.get("left"), _cq.get("left_error", 0),
                         "统计/业务自洽这类需要重算的问题,带工具的模型也没能在超时内解决,"
                         "要复诊请人工介入" if _ag_used else
                         "统计/业务自洽这类需要重算的问题,不带工具的润色模型改不了,"
                         "要复诊请开 MA_REPORT_AGENT 走带工具的报告产出"))
    else:
        notes.append("已跑 skill 自带的 self_critique 质检并通过")
    if getattr(ctx, "channel_rewrites", 0):
        notes.append("渠道词汇门禁触发过 {} 次,已按 skill 的修正指令改写文案后重新渲染"
                     "(未使用 --allow-channel-lint 绕过)".format(ctx.channel_rewrites))
    if getattr(ctx, "meta_guessed", False):
        _got = getattr(ctx, "products_inferred", None)
        notes.append("target_products 走默认:由 --auto-meta 从数据的 activity_product_name 取到 {};"
                     "要改成别的品类,在入参 meta.target_products 里显式给".format(
                         "、".join(_got)) if _got else
                     "target_products 走默认(--auto-meta 从 activity_product_name 取),"
                     "但没能回读到实际取值,跨品类相关规则的结论请人工确认")
    else:
        _given = getattr(ctx, "products_given", None)
        if _given:
            notes.append("target_products 由入参显式给出:{}(未走 --auto-meta 推断)".format(
                "、".join(_given)))
    if getattr(ctx, "schema_unresolved", 0):
        notes.append("有 {} 处文案没能满足 skill 的 schema 硬规矩(字数/格式),"
                     "已按 skill 报错重写过但仍未达标,详见 polish.schema_errors".format(
                         ctx.schema_unresolved))
    if not has_rules:
        notes.append("本次没有任何可用的推送规则,push_sql 与 size.push 均为空")
    return notes


# --------------------------------------------------------------------------- 主流程


def run_pipeline(params, rundir, log=None, set_phase=None, call_cli=None, extract_json=None):
    """跑完整条链路,返回接口 result 结构。抛 StepError 表示这一单失败。"""
    ctx = Ctx(params, rundir, log=log, set_phase=set_phase)
    backend = get_backend()
    src, steps = backend.source, backend.steps
    ctx.log("runtime={} 后端={} 数据源={} 发布目录={}".format(
        RUNTIME, backend.name, src.label, PUBLIC_DIR))
    # 环境体检的结论跟着每一单走。fatal 能到这儿只有一种可能:有人显式开了
    # MA_ALLOW_BAD_ENV —— 那就让它在这一单的 warnings 里留下痕迹,别只在启动日志里闪一下。
    for m in ENV_FATAL:
        ctx.warn("环境(已被 MA_ALLOW_BAD_ENV 放行):{}".format(m))
    for m in ENV_WARN:
        ctx.warn("环境:{}".format(m))

    try:
        data_path = ctx.step("pull", lambda: src.pull(ctx))
        sp = ctx.step("prepare", lambda: steps.prepare(ctx, src, data_path))
        apply_meta_defaults(ctx, sp)      # auto-meta 推完之后的收尾兜底(名称/类型)
        check_inferred_products(ctx, sp)
        ctx.step("thresholds", lambda: steps.compute_thresholds(ctx, src, data_path, sp))
        sd = ctx.step("draft", lambda: steps.draft(ctx, src, sp))
        cr_path = ctx.step("crowd_rules", lambda: steps.crowd_rules(ctx, src, sd))

        all_rules = _load(cr_path)
        segs, picked, excluded, fixes = pick_push_rules(all_rules, ctx.push_source)
        for f in fixes:
            ctx.warn(f)
        ctx.log("crowd_rules {} 条,audience_segment 里 direction=push 的 {} 条,"
                "push({}) 候选 {} 条;另有 {} 条排除规则不参与推送".format(
                    len(all_rules), len(segs), ctx.push_source, len(picked), len(excluded)))
        for e in excluded:
            ctx.log("不推送 {} ({}) est={}".format(
                e.get("name"), e.get("reason"), e.get("estimated_size")))

        def _crowd():
            ok, dropped = src.validate_rules(ctx, picked)
            for d in dropped:
                ctx.warn("剔除规则 {}: {}".format(d.get("name"), d.get("reason")))
            src.count_rules(ctx, ok)
            for r in ok:
                ctx.log("规则命中 {} → {}".format(r.get("name"), r.get("population_size")))
            total = src.count_push_total(ctx, ok)
            ctx.log("去重后推送人数 size.push = {}".format(total))
            return ok, dropped, total

        push_ok, dropped, push_size = ctx.step("crowd_push", _crowd)

        # 报告产出:先给带工具权限的 claude 一次机会,让它自己去读 SKILL.md、
        # 自己跑 skill 把草稿做成定稿。它交出来的稿子接着当成新的草稿走下面这条链 ——
        # 该润的继续润,skill 自带质检照跑,三道门禁一道不放过。
        # 它没跑成就原样用 state_draft.json,整条链跟以前一模一样。
        agent_info = ctx.step(
            "report_agent",
            lambda: run_report_agent(ctx, sd, call_cli, steps,
                                     data_label=getattr(src, "label", None)))
        ctx.report_agent = agent_info
        polish_in = agent_info.get("state_full") if agent_info.get("used") else sd

        sf, polish_info = ctx.step(
            "polish", lambda: polish_state(ctx, polish_in, call_cli, extract_json,
                                           validate=getattr(steps, "validate", None)
                                           and (lambda p: steps.validate(ctx, p))))
        polish_info["report_agent"] = agent_info

        # 半成品别裸发(356352 教训:骨架句报告一路发到公网,读报告的人毫无提示)。
        # 润色没救完、又没有 agent 成品兜底时,发布出去的页面顶部压一条醒目横幅,
        # report_url 照给、规则照出 —— 但"这是待人工复核的降级稿"必须钉在读者眼前。
        if polish_info.get("degraded") and not agent_info.get("used"):
            ctx.report_banner = ("⚠ 数据诊断已完成,但文案润色未完成"
                                 "(剩余待润色 {} 处):正文可能残留草稿骨架句,"
                                 "发给业务方前请先人工复核".format(polish_info.get("remaining", 0)))

        # skill 推荐流程的第 8 步:润色完先跑它自带的质检,再 render。
        # 以前这里直接跳到 render —— 等于把 skill 自己那套质量裁决完全绕过去了。
        ctx.step("self_critique",
                 lambda: critique_repair(ctx, sf, steps, call_cli, extract_json, polish_info))
        if hasattr(steps, "status"):
            steps.status(ctx, sf)

        on_rewrite = make_channel_rewriter(ctx, sf, call_cli, extract_json, polish_info)
        html = ctx.step("render", lambda: steps.render(ctx, src, sf, on_rewrite=on_rewrite))
        report_url = ctx.step("publish", lambda: publish_html(ctx, html))

        def _assemble():
            push_sql, count_sql = build_push_sql(
                push_ok, table=src.sql_table, id_col=src.id_col, union_col=src.union_col,
                base_where=src.base_where(ctx) if hasattr(src, "base_where") else None)
            cols = [src.id_col] if src.union_col == src.id_col else [src.id_col, src.union_col]
            spec = {
                "version": "1.0",
                "placeholder": False,
                "activity_id": ctx.activity_id,
                "push_source": ctx.push_source,
                "source_table": src.sql_table,
                "data_source": src.label,
                "dedup_key": src.id_col,
                "dedup_strategy": "min_unionid",
                "columns": cols,
                "push_sql": push_sql,
                "sql": count_sql,
                "rules": [dict(r, crowd="push") for r in push_ok],
                "dropped_rules": dropped,
                "excluded_rules": excluded,
                "size": {"push": push_size},
                "notes": build_notes(ctx, backend, dropped, polish_info.get("degraded"),
                                     bool(push_ok), excluded),
            }
            return {
                "activity_id": ctx.activity_id,
                "date": ctx.params.get("date"),
                "mode": "C",
                "runtime": RUNTIME,
                "backend": {"data": src.name, "steps": steps.name,
                            "source": src.label, "skill_degraded": ctx.skill_degraded,
                            "render_forced": ctx.render_forced,
                            "render_flags": list(getattr(ctx, "render_flags", []) or []),
                            "schema_ok": polish_info.get("schema_ok"),
                            "self_critique": getattr(ctx, "critique", None),
                            "channel_rewrites": getattr(ctx, "channel_rewrites", 0),
                            "report_agent": getattr(ctx, "report_agent", None)},
                "degraded": (bool(polish_info.get("degraded")) or ctx.skill_degraded
                             or ctx.render_forced),
                "report_url": report_url,
                "crowd_spec": spec,
                "size": {"push": push_size},
                "polish": polish_info,
                "steps": ctx.steps,
                "artifacts": {
                    "rundir": ctx.rundir,
                    "state_draft": os.path.basename(sd),
                    "state_full": os.path.basename(sf),
                    "crowd_rules": os.path.basename(cr_path),
                    "report_html": os.path.basename(html),
                },
            }

        result = ctx.step("assemble", _assemble)
        result["warnings"] = ctx.warnings
        return result
    finally:
        backend.close()


def publish_html(ctx, html_path):
    """把报告拷到公开目录并给出 URL。目录不存在时不让整单失败,降级返回本地路径。

    ctx.report_banner 非空时,发布副本的 <body> 顶部注入一条置顶横幅(rundir 里的
    原件不动)。这是"降级稿不裸发"的最后一道闸:出参里的 degraded 标志读者看不见,
    压在页面上的字才看得见。
    """
    name = "diagnosis-report-{}.html".format(ctx.activity_id)
    if not os.path.isdir(PUBLIC_DIR):
        ctx.warn("发布目录不存在:{},报告只留在运行目录".format(PUBLIC_DIR))
        return None
    banner = getattr(ctx, "report_banner", None)
    try:
        if banner:
            with open(html_path, encoding="utf-8") as f:
                doc = f.read()
            ins = ('<div style="position:sticky;top:0;z-index:9999;background:#b45309;'
                   'color:#fff;padding:10px 16px;font:13px/1.7 -apple-system,'
                   "'PingFang SC',sans-serif;text-align:center\">{}</div>").format(
                       _html_escape(banner))
            m = re.search(r"<body[^>]*>", doc)
            doc = (doc[:m.end()] + ins + doc[m.end():]) if m else (ins + doc)
            with open(os.path.join(PUBLIC_DIR, name), "w", encoding="utf-8") as f:
                f.write(doc)
            ctx.log("发布带降级横幅的报告(半成品不裸发,原件在 rundir 未动)")
        else:
            shutil.copyfile(html_path, os.path.join(PUBLIC_DIR, name))
    except (IOError, OSError) as exc:
        ctx.warn("发布失败({}),报告只留在运行目录".format(exc))
        return None
    url = URL_BASE.rstrip("/") + "/" + name
    with open(ctx.path("report_url.txt"), "w", encoding="utf-8") as f:
        f.write(url + "\n")
    ctx.log("报告已发布 {}".format(url))
    return url


# --------------------------------------------------------------------------- 命令行自测


def _cli_main():
    import argparse
    ap = argparse.ArgumentParser(description="不起 HTTP 服务,直接跑一遍流水线")
    ap.add_argument("activity_id")
    ap.add_argument("--push-source", default="model", choices=["model", "rule", "both"])
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    sys.path.insert(0, BASE_DIR)
    from ma_core import call_claude, extract_json as _ej, CLAUDE_BIN

    def _call(prompt, timeout):
        argv = [CLAUDE_BIN, "-p", prompt]
        if POLISH_MODEL:
            argv += ["--model", POLISH_MODEL]   # 命令行自测没有 agent 步,全按轻量调用走
        return call_claude(argv, timeout)

    rundir = args.out or os.path.join(BASE_DIR, "runs", args.activity_id)
    params = {"activity_id": args.activity_id, "push_source": args.push_source, "date": None}
    try:
        res = run_pipeline(params, rundir, log=lambda s: print(s), call_cli=_call, extract_json=_ej)
    except StepError as exc:
        print("失败 {}: {}".format(exc.code, exc.message))
        raise SystemExit(1)
    print(json.dumps(res, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    _cli_main()
