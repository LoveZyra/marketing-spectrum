# -*- coding: utf-8 -*-
"""fix6d 回归:报告产出交给带工具权限的 claude 之后,哪些东西必须仍然守得住。

这一步的定位是「更好的那条路」,不是必经之路。所以这份回归主要不是验证它跑得通,
而是验证它跑不通的时候没人受伤:

  1) 该跳过的时候跳过 —— 开关关了、后端没有真 skill、注进来的 call_cli 不带工具,
     三种情况都必须老老实实退回老链路,而不是拿一个不带工具的调用冒充「模型用了 skill」。
  2) 跑通了也不放行圈人锚点 —— name / sql_filter / estimated_size / direction /
     finding_id 是 crowd_rules.json 已经拿走的东西,Agent 改了就回填,
     改名还要把 priority_actions.target_audiences 里的引用一起改回来(fnd_r41 那个坑)。
  3) 产物不合格就作废 —— 读不出来、没有 findings、少了结论,一律退回老链路,
     并且把坏文件改名留证,不能让它顶着 state_full.json 的名字混进下一步。
  4) 提示词里那几条硬约束必须在 —— 尤其是三个强制开关都要以「禁止」的语气出现,
     以及「只输出需要推送的人群」这条接口口径。

用法:python3 regress_agent.py
"""
import json
import os
import shutil
import sys

RUN = "/tmp/regress_agent"
if os.path.isdir(RUN):
    shutil.rmtree(RUN)
os.makedirs(RUN)

# MA_CLI 是 import 时算出来的,而这份回归的很多断言都要求「cli.py 存在」这一关先过。
# 真 skill 装在哪台机器上是哪台的事,回归不该依赖它 —— 自带一个空壳目录顶上。
# 它只被 os.path.exists 看一眼,从头到尾没被执行过。
_SKILL = os.path.join(RUN, "skill")
os.makedirs(_SKILL)
with open(os.path.join(_SKILL, "cli.py"), "w", encoding="utf-8") as _f:
    _f.write("# 占位用,回归不会执行它\n")
os.environ["MA_SKILL_DIR"] = _SKILL

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("MA_RUNTIME", "stub")

import ma_pipeline as P

OK, BAD = [], []


def check(name, cond, detail=""):
    (OK if cond else BAD).append(name)
    print("  [{}] {}{}".format("PASS" if cond else "FAIL", name,
                               ("  <- " + detail) if detail else ""))


class Ctx(object):
    def __init__(self, run, params=None):
        self.rundir = run
        self.params = params or {"activity_id": "REGRESS"}
        self.activity_id = self.params.get("activity_id") or "REGRESS"
        self.logs = []
        self.warns = []
        self.report_agent = None
        # 跟真 Ctx 对齐,别让替身比正主宽松
        self.meta_guessed = False
        self.products_given = None
        self.products_inferred = None

    def path(self, *parts):
        return os.path.join(self.rundir, *parts)

    def log(self, m):
        self.logs.append(m)

    def warn(self, m):
        self.warns.append(m)
        self.logs.append("WARN " + m)


class Steps(object):
    def __init__(self, name):
        self.name = name


def draft_state():
    """草稿:两条结论、两段人群,人群锚点齐全。"""
    return {
        "_stage": "draft", "_draft": True,
        "campaign_meta": {"activity_id": "REGRESS", "campaign_type": "社群进群"},
        "findings": [
            {"id": "fnd_r41", "title": "创单未付规模偏大", "detail": "[待润色]"},
            {"id": "fnd_model_1", "title": "高分人群转化更好", "detail": "[待润色]"},
        ],
        "audience_segments": [
            {"name": "创单未付待促付人群", "direction": "push", "finding_id": "fnd_r41",
             "sql_filter": "has_order=1 AND paid=0", "estimated_size": 2403,
             "profile_text": "[待润色]"},
            {"name": "模型高分待触达人群", "direction": "push", "finding_id": "fnd_model_1",
             "sql_filter": "score>=0.72", "estimated_size": 18800,
             "profile_text": "[待润色]"},
        ],
        "action_plan": {"priority_actions": [
            {"title": "启动促付", "target_audiences": ["创单未付待促付人群"]},
            {"title": "扩量触达", "target_audiences": ["模型高分待触达人群", "创单未付待促付人群"]},
        ]},
        "narratives": {"headline": "[待润色]"},
    }


def write_draft(run):
    p = os.path.join(run, "state_draft.json")
    P._dump(p, draft_state())
    return p


def fake_cli(behave, tools_ok=True):
    """call_cli 替身。behave(prompt, rundir) 负责伪造 Agent 的落盘行为,
    返回 call 字典;不返回就当 exit=0。"""
    seen = []

    def _call(prompt, timeout, argv_extra=None, cwd=None):
        seen.append({"prompt": prompt, "timeout": timeout,
                     "argv_extra": list(argv_extra or []), "cwd": cwd})
        out = behave(prompt, cwd) if behave else None
        return out or {"exit_code": 0, "stdout": "done", "stderr": "",
                       "elapsed_sec": 1.0, "timed_out": False}

    if tools_ok:
        _call.supports_tools = True
    return _call, seen


# ------------------------------------------------------- 1) 三条跳过路径
print("\n=== 1) 该跳过就跳过:开关 / 后端 / call_cli 能力 ===")

run1 = os.path.join(RUN, "skip")
os.makedirs(run1)
ctx1 = Ctx(run1)
sd1 = write_draft(run1)
cli1, seen1 = fake_cli(None)

_saved = P.REPORT_AGENT
P.REPORT_AGENT = False
info = P.run_report_agent(ctx1, sd1, cli1, Steps("skill"))
P.REPORT_AGENT = _saved
check("MA_REPORT_AGENT=0 → 不跑", info["used"] is False, info["reason"])
check("关掉时一次 CLI 都不调", not seen1, str(len(seen1)))

info = P.run_report_agent(ctx1, sd1, cli1, Steps("stub"))
check("后端是 stub → 不跑", info["used"] is False, info["reason"])
check("stub 时也不调 CLI", not seen1, str(len(seen1)))

cli_notools, seen_nt = fake_cli(None, tools_ok=False)
info = P.run_report_agent(ctx1, sd1, cli_notools, Steps("skill"))
check("call_cli 不带 supports_tools → 不跑", info["used"] is False, info["reason"])
check("宁可跳过也不拿无工具调用冒充", not seen_nt, str(len(seen_nt)))
check("跳过的理由里指了怎么修", "ma_api_c" in (info.get("reason") or ""), info["reason"])

# 真 ma_api_c.py 注进来的那个必须带标记,否则这条路永远走不到
_capi = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ma_api_c.py")
_csrc = open(_capi, encoding="utf-8").read()
check("ma_api_c.py 的 call_cli 打了 supports_tools 标记",
      "_call.supports_tools = True" in _csrc)
check("ma_api_c.py 的 call_cli 收 argv_extra / cwd",
      "def _call(prompt, timeout, argv_extra=None, cwd=None):" in _csrc)
check("argv_extra 真的拼进 argv(2026-07-30 分模型后,--model 在工具参数之前)",
      "[CLAUDE_BIN, \"-p\", prompt] + model_argv + list(argv_extra or [])" in _csrc)
check("真实子进程用固定工作目录(Prism 不再每单建「run」项目)",
      "timeout, cwd=workdir)" in _csrc and "LLM_HOME" in _csrc)


# ------------------------------------------------------- 2) 调用参数
print("\n=== 2) 调起来的时候给了什么 ===")

run2 = os.path.join(RUN, "call")
os.makedirs(run2)
ctx2 = Ctx(run2, {"activity_id": "ACT9", "campaign_type": "社群进群"})
sd2 = write_draft(run2)


def good(prompt, cwd):
    st = draft_state()
    st["_stage"] = "full"
    st.pop("_draft", None)
    st["narratives"]["headline"] = "创单未付 2403 人是本轮最大漏斗缺口,应优先促付挽回"
    for f in st["findings"]:
        f["detail"] = "实测数据写实的一段话,不再是占位符。"
    P._dump(os.path.join(cwd, "state_full.json"), st)
    return {"exit_code": 0, "stdout": "跑了 render,一次过\n", "stderr": "",
            "elapsed_sec": 42.0, "timed_out": False}


cli2, seen2 = fake_cli(good)
info2 = P.run_report_agent(ctx2, sd2, cli2, Steps("skill"), data_label="本地 CSV")
check("正常路径:用上了", info2["used"] is True, str(info2.get("reason")))
check("只调一次", len(seen2) == 1, str(len(seen2)))
c2 = seen2[0]
check("带了 --allowedTools", "--allowedTools" in c2["argv_extra"], str(c2["argv_extra"]))
check("工具清单就是 MA_AGENT_TOOLS",
      c2["argv_extra"][c2["argv_extra"].index("--allowedTools") + 1] == P.AGENT_TOOLS,
      P.AGENT_TOOLS)
check("没有 --allow-dangerously-skip-permissions",
      not any("dangerously" in a for a in c2["argv_extra"]), str(c2["argv_extra"]))
check("cwd 就是这一单的 rundir", c2["cwd"] == run2, str(c2["cwd"]))
check("超时用 MA_AGENT_TIMEOUT", c2["timeout"] == P.AGENT_TIMEOUT, str(c2["timeout"]))
check("提示词落盘留证", os.path.exists(os.path.join(run2, "agent_prompt.txt")))
check("stdout 落盘留证", os.path.exists(os.path.join(run2, "agent_stdout.txt")))
check("state_full.json 就是下一步的入口",
      info2["state_full"] == os.path.join(run2, "state_full.json"))
check("出参记了耗时", info2.get("elapsed_sec") == 42.0, str(info2.get("elapsed_sec")))
check("Agent 的原话进了日志", any("[agent]" in m for m in ctx2.logs),
      str(ctx2.logs[-1])[:60])


# ------------------------------------------------------- 3) 提示词里的硬约束
print("\n=== 3) 提示词:该说的话一句都不能少 ===")

pr = open(os.path.join(run2, "agent_prompt.txt"), encoding="utf-8").read()
check("告诉它 rundir", run2 in pr)
check("告诉它草稿在哪", sd2 in pr)
check("告诉它 skill 的 cli.py 在哪", P.MA_CLI in pr)
check("让它先读 SKILL.md", "SKILL.md" in pr)
check("指了方法论目录", "methodology" in pr)
check("点名 self_critique 这一步", "run-tools" in pr and "self_critique" in pr)
check("点名 render 这一步", "render" in pr)
check("写死了产物文件名", "state_full.json" in pr)
check("带上活动上下文", "ACT9" in pr and "社群进群" in pr)
check("带上数据来源", "本地 CSV" in pr)
check("讲清接口只推 push 人群", "只输出需要推送" in pr or "只输出需要推送(push)的人群" in pr)
for flag in ("--allow-channel-lint", "--skip-validate", "--skip-completeness"):
    ln = [l for l in pr.splitlines() if flag in l]
    check("提示词把 {} 写成禁止项".format(flag),
          bool(ln) and any(("不要用" in l or "不得" in l or "禁止" in l or "不能" in l)
                           for l in ln),
          str(ln)[:80])
check("禁止改圈人锚点", all(k in pr for k in P.SEG_ANCHORS), str(P.SEG_ANCHORS))
_ta_ln = [l for l in pr.splitlines() if "target_audiences" in l]
check("禁止改 target_audiences(结构指针,不是文案)",
      bool(_ta_ln) and any(("不要改" in l or "不得" in l or "禁止" in l) for l in _ta_ln),
      str(_ta_ln)[:80])
check("说清「全量」要原样保留(别拿人群名去填占位)", "全量" in pr)
check("禁止写 skill 目录", "只读" in pr or "不要改" in pr)
check("禁止留 [待润色]", "[待润色]" in pr)
check("headline 字数底线写进去了", "30" in pr)


# ------------------------------------------------------- 4) 锚点回填
print("\n=== 4) 圈人锚点:文案随它改,锚点必须回填 ===")

run4 = os.path.join(RUN, "anchor")
os.makedirs(run4)
ctx4 = Ctx(run4)
sd4 = write_draft(run4)


def tamper(prompt, cwd):
    st = draft_state()
    st["_stage"] = "full"
    segs = st["audience_segments"]
    segs[0]["name"] = "创单未付促付包"                 # 改名
    segs[0]["estimated_size"] = 9999                  # 改人数
    segs[0]["sql_filter"] = "1=1"                     # 改圈人条件
    segs[0]["profile_text"] = "写得更好的一段人群画像"   # 这个允许改
    segs[1]["direction"] = "exclude"                  # 改方向
    st["action_plan"]["priority_actions"][0]["target_audiences"] = ["创单未付促付包"]
    st["action_plan"]["priority_actions"][1]["target_audiences"] = [
        "模型高分待触达人群", "创单未付促付包"]
    P._dump(os.path.join(cwd, "state_full.json"), st)
    return None


cli4, _ = fake_cli(tamper)
info4 = P.run_report_agent(ctx4, sd4, cli4, Steps("skill"))
check("动了锚点也还是用它的稿", info4["used"] is True, str(info4.get("reason")))
st4 = P._load(info4["state_full"])
s0, s1 = st4["audience_segments"]
check("name 回填", s0["name"] == "创单未付待促付人群", s0["name"])
check("estimated_size 回填", s0["estimated_size"] == 2403, str(s0["estimated_size"]))
check("sql_filter 回填", s0["sql_filter"] == "has_order=1 AND paid=0", s0["sql_filter"])
check("direction 回填", s1["direction"] == "push", s1["direction"])
check("profile_text 不动它的", s0["profile_text"] == "写得更好的一段人群画像",
      s0["profile_text"])
acts = st4["action_plan"]["priority_actions"]
check("改名反向映射:priority_actions[0]",
      acts[0]["target_audiences"] == ["创单未付待促付人群"], str(acts[0]["target_audiences"]))
check("改名反向映射:混在一起的那条也换回来了",
      acts[1]["target_audiences"] == ["模型高分待触达人群", "创单未付待促付人群"],
      str(acts[1]["target_audiences"]))
check("回填了几处如实记账", info4.get("fixed_anchors") == 4, str(info4.get("fixed_anchors")))
check("改名处数如实记账", info4.get("renames") == 1, str(info4.get("renames")))
check("回填这件事必须出现在 warnings", any("锚点" in w for w in ctx4.warns),
      str(ctx4.warns)[:80])

# 段数变了 → 整段回填,不做逐字段对齐(对不上就是对不上)
run4b = os.path.join(RUN, "anchor_count")
os.makedirs(run4b)
ctx4b = Ctx(run4b)
sd4b = write_draft(run4b)


def drop_seg(prompt, cwd):
    st = draft_state()
    st["_stage"] = "full"
    st["audience_segments"] = st["audience_segments"][:1]
    P._dump(os.path.join(cwd, "state_full.json"), st)
    return None


cli4b, _ = fake_cli(drop_seg)
info4b = P.run_report_agent(ctx4b, sd4b, cli4b, Steps("skill"))
st4b = P._load(info4b["state_full"])
check("人群段被删 → 整段回填成草稿版本",
      len(st4b["audience_segments"]) == 2, str(len(st4b["audience_segments"])))
check("整段回填也要吵一声", any("人群段" in w for w in ctx4b.warns), str(ctx4b.warns)[:80])


# action_plan 形状飘了 → 它只是展示字段,不该连累整份报告被判废。
# 2026-07-29 本地端到端就栽在这:模型把它写成数组,restore_seg_anchors 在
# .get("priority_actions") 上 AttributeError,一份本来合格的产物被整份扔掉。
run4c = os.path.join(RUN, "anchor_shape")
os.makedirs(run4c)
ctx4c = Ctx(run4c)
sd4c = write_draft(run4c)


def wrong_shape(prompt, cwd):
    st = draft_state()
    st["_stage"] = "full"
    st["audience_segments"][0]["name"] = "创单未付促付包"
    st["action_plan"] = [{"owner": "运营", "target_audiences": ["创单未付促付包"],
                          "detail": "把这批人捞回来"}]     # 正版是对象,这里写成了数组
    P._dump(os.path.join(cwd, "state_full.json"), st)
    return None


cli4c, _ = fake_cli(wrong_shape)
info4c = P.run_report_agent(ctx4c, sd4c, cli4c, Steps("skill"))
check("action_plan 写成数组也照样收稿", info4c["used"] is True, str(info4c.get("reason")))
st4c = P._load(info4c["state_full"])
check("形状飘了,改名照样反向映射回去",
      P.priority_actions_of(st4c)[0].get("target_audiences") == ["创单未付待促付人群"],
      json.dumps(P.priority_actions_of(st4c), ensure_ascii=False)[:160])
check("priority_actions_of 认对象形状(正版)",
      [a["detail"] for a in P.priority_actions_of(
          {"action_plan": {"priority_actions": [{"detail": "x"}]}})] == ["x"])
check("priority_actions_of 认数组形状(模型常飘的那种)",
      [a["detail"] for a in P.priority_actions_of({"action_plan": [{"detail": "y"}]})] == ["y"])
check("priority_actions_of 遇上说不通的形状就当没有,不抛",
      P.priority_actions_of({"action_plan": "一句话"}) == []
      and P.priority_actions_of({}) == []
      and P.priority_actions_of({"action_plan": ["字符串项", {"detail": "z"}]}) == [{"detail": "z"}])
check("行动项定位撞上数组形状也不炸,定位不到就如实返回空",
      P.critique_target_paths({"action_plan": [{"title": "T", "detail": "d"}]},
                              {"target_kind": "priority_action", "target_id": "T"}) == [])

# blind_spots 也得有地方落:形状不对就地扶正,不能让问题凭空消失
st4d = {"action_plan": [{"detail": "原来的行动项"}]}
P.park_in_blind_spots(st4d, [{"type": "closure", "message": "没闭环",
                              "target_kind": "finding", "target_id": "fnd_1"}], 2)
check("action_plan 是数组时,blind_spots 仍记得下来",
      len((st4d["action_plan"] or {}).get("blind_spots") or []) == 1,
      json.dumps(st4d, ensure_ascii=False)[:200])
check("扶正的时候原来的行动项没被扔掉",
      P.priority_actions_of(st4d) == [{"detail": "原来的行动项"}],
      json.dumps(st4d.get("action_plan"), ensure_ascii=False)[:160])


# target_audiences 是结构指针不是文案:它说的是「这条行动打哪批人」,报告附录的
# 「↑ #N 回到核心发现」回链靠它算。2026-08-17 线上:核心发现 #2 是模型洞察类
# finding,草稿里 _action_from_problem 拿不到对应人群(模型 finding 在
# _segment_from_finding 直接 return None),写的是 ["全量"];Agent 润色时把这个
# 占位「写实」成了它在 audience_segments 里看到的三个模型人群名,附录于是挂出
# 三条指向无关发现的死链。现行为:按草稿回填。
run4e = os.path.join(RUN, "action_audiences")
os.makedirs(run4e)
ctx4e = Ctx(run4e)


def draft_with_quanliang():
    st = draft_state()
    st["action_plan"]["priority_actions"] = [
        {"title": "启动促付", "problem_rank": 1,
         "target_audiences": ["创单未付待促付人群"]},
        {"title": "模型洞察跟进", "problem_rank": 2, "target_audiences": ["全量"]},
    ]
    return st


sd4e = os.path.join(run4e, "state_draft.json")
P._dump(sd4e, draft_with_quanliang())


def fill_quanliang(prompt, cwd):
    st = draft_with_quanliang()
    st["_stage"] = "full"
    acts = st["action_plan"]["priority_actions"]
    acts[1]["title"] = "对模型高潜人群做预算倾斜"          # 文案随它改
    acts[1]["target_audiences"] = ["模型高分待触达人群"]   # 结构指针,不许它改
    acts[0]["target_audiences"] = ["创单未付待促付人群", "模型高分待触达人群"]
    P._dump(os.path.join(cwd, "state_full.json"), st)
    return None


cli4e, _ = fake_cli(fill_quanliang)
info4e = P.run_report_agent(ctx4e, sd4e, cli4e, Steps("skill"))
check("只动 target_audiences 不算废稿", info4e["used"] is True, str(info4e.get("reason")))
st4e = P._load(info4e["state_full"])
acts4e = P.priority_actions_of(st4e)
check("被「写实」的「全量」回填成「全量」(模型人群不再冒充这条行动的对象)",
      acts4e[1]["target_audiences"] == ["全量"], str(acts4e[1]["target_audiences"]))
check("多塞进来的人群名也被摘掉",
      acts4e[0]["target_audiences"] == ["创单未付待促付人群"],
      str(acts4e[0]["target_audiences"]))
check("行动文案照旧不动它的", acts4e[1]["title"] == "对模型高潜人群做预算倾斜",
      acts4e[1]["title"])
check("回填这件事必须出现在 warnings",
      any("target_audiences" in w for w in ctx4e.warns), str(ctx4e.warns)[:120])
check("这笔账不混进圈人锚点计数", info4e.get("fixed_anchors") == 0,
      str(info4e.get("fixed_anchors")))

# 没改就不该吵:同样的稿子原样交回来,warnings 里不许出现这条
run4f = os.path.join(RUN, "action_audiences_clean")
os.makedirs(run4f)
ctx4f = Ctx(run4f)
sd4f = os.path.join(run4f, "state_draft.json")
P._dump(sd4f, draft_with_quanliang())


def keep_audiences(prompt, cwd):
    st = draft_with_quanliang()
    st["_stage"] = "full"
    st["action_plan"]["priority_actions"][1]["title"] = "改文案不改人群"
    P._dump(os.path.join(cwd, "state_full.json"), st)
    return None


cli4f, _ = fake_cli(keep_audiences)
info4f = P.run_report_agent(ctx4f, sd4f, cli4f, Steps("skill"))
check("没改 target_audiences 就不告警(不制造噪声)",
      not any("target_audiences" in w for w in ctx4f.warns), str(ctx4f.warns)[:120])

# 条数对不上 → 不按位置猜,整个跳过(此时仍有改名反向映射兜着)
run4g = os.path.join(RUN, "action_audiences_len")
os.makedirs(run4g)
ctx4g = Ctx(run4g)
sd4g = os.path.join(run4g, "state_draft.json")
P._dump(sd4g, draft_with_quanliang())


def drop_action(prompt, cwd):
    st = draft_with_quanliang()
    st["_stage"] = "full"
    st["action_plan"]["priority_actions"] = [
        {"title": "只剩一条", "target_audiences": ["模型高分待触达人群"]}]
    P._dump(os.path.join(cwd, "state_full.json"), st)
    return None


cli4g, _ = fake_cli(drop_action)
info4g = P.run_report_agent(ctx4g, sd4g, cli4g, Steps("skill"))
st4g = P._load(info4g["state_full"])
check("行动条数对不上就不按位置猜(对不上就是对不上)",
      P.priority_actions_of(st4g)[0]["target_audiences"] == ["模型高分待触达人群"],
      str(P.priority_actions_of(st4g)))


# ------------------------------------------------------- 5) 作废路径
print("\n=== 5) 产物不合格:作废并留证,绝不带病往下走 ===")


def reject_case(tag, behave):
    run = os.path.join(RUN, tag)
    os.makedirs(run)
    ctx = Ctx(run)
    sd = write_draft(run)
    cli, _seen = fake_cli(behave)
    return P.run_report_agent(ctx, sd, cli, Steps("skill")), ctx, run


def nonzero(prompt, cwd):
    P._dump(os.path.join(cwd, "state_full.json"), draft_state())
    return {"exit_code": 1, "stdout": "", "stderr": "boom", "elapsed_sec": 3.0,
            "timed_out": False}


i5a, c5a, _ = reject_case("exit", nonzero)
check("非零退出 → 不用它", i5a["used"] is False, str(i5a.get("reason")))
check("非零退出会告警", any("退回" in w for w in c5a.warns), str(c5a.warns)[:60])


def timeout_case(prompt, cwd):
    return {"exit_code": None, "stdout": "", "stderr": "timeout after 1200s",
            "elapsed_sec": 1200.0, "timed_out": True}


i5b, c5b, _ = reject_case("timeout", timeout_case)
check("超时且没落盘 → 不用它", i5b["used"] is False, str(i5b.get("reason")))
check("超时这件事说出来了", "超时" in (i5b.get("reason") or ""), str(i5b.get("reason")))


# 356352 的教训反着钉一遍:超时 ≠ 没干成。那单 agent 在 1197.45s 三道门禁全过、
# render DONE,差 2.5 秒被杀,成品却因"只看退出码"被弃用、再被降级润色覆盖。
# 现行为:超时但 state_full.json 完整且过锚点校验 → 采纳,出参如实标 timed_out。
def timeout_done(prompt, cwd):
    P._dump(os.path.join(cwd, "state_full.json"), draft_state())
    return {"exit_code": None, "stdout": "", "stderr": "timeout after 2400s",
            "elapsed_sec": 2400.0, "timed_out": True}


i5b2, c5b2, _ = reject_case("timeout_done", timeout_done)
check("超时但产物完整且过校验 → 采纳(356352 救回路径)",
      i5b2["used"] is True, str(i5b2.get("reason")))
check("采纳的超时稿在出参里如实标 timed_out", i5b2.get("timed_out") is True)


def timeout_bad(prompt, cwd):
    P._dump(os.path.join(cwd, "state_full.json"), {"findings": []})
    return {"exit_code": None, "stdout": "", "stderr": "timeout after 2400s",
            "elapsed_sec": 2400.0, "timed_out": True}


i5b3, c5b3, r5b3 = reject_case("timeout_bad", timeout_bad)
check("超时+产物不合格 → 仍不采纳", i5b3["used"] is False, str(i5b3.get("reason")))
check("弃用的超时稿挪存留证(不会再被润色覆盖)",
      (not os.path.exists(os.path.join(r5b3, "state_full.json")))
      and os.path.exists(os.path.join(r5b3, "state_full.agent_timeout.json")))

i5c, c5c, _ = reject_case("nofile", lambda p, c: None)
check("没落盘 state_full.json → 不用它", i5c["used"] is False, str(i5c.get("reason")))


def broken_json(prompt, cwd):
    with open(os.path.join(cwd, "state_full.json"), "w", encoding="utf-8") as f:
        f.write("{ 这不是 JSON")
    return None


i5d, c5d, r5d = reject_case("broken", broken_json)
check("JSON 坏了 → 不用它", i5d["used"] is False, str(i5d.get("reason")))
check("坏文件改名留证,不占 state_full.json 这个名字",
      os.path.exists(os.path.join(r5d, "state_full.agent_rejected.json"))
      and not os.path.exists(os.path.join(r5d, "state_full.json")))


def lost_finding(prompt, cwd):
    st = draft_state()
    st["findings"] = st["findings"][:1]
    P._dump(os.path.join(cwd, "state_full.json"), st)
    return None


i5e, c5e, r5e = reject_case("lost", lost_finding)
check("少了结论 → 不用它", i5e["used"] is False, str(i5e.get("reason")))
check("少的是哪条说得出来", any("fnd_model_1" in w for w in c5e.warns),
      str(c5e.warns)[:80])
check("少结论的产物也改名留证",
      os.path.exists(os.path.join(r5e, "state_full.agent_rejected.json")))


def no_findings(prompt, cwd):
    P._dump(os.path.join(cwd, "state_full.json"), {"_stage": "full", "findings": []})
    return None


i5f, _c, _r = reject_case("empty", no_findings)
check("findings 空 → 不用它", i5f["used"] is False, str(i5f.get("reason")))


def blow_up(prompt, cwd):
    raise RuntimeError("CLI 层自己炸了")


i5g, c5g, _ = reject_case("raise", blow_up)
check("CLI 调用本身抛异常也不能让整单挂", i5g["used"] is False, str(i5g.get("reason")))


# ------------------------------------------------------- 6) 接进流水线的方式
print("\n=== 6) 接线:它的产物要真的变成 polish 的输入 ===")

_src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "ma_pipeline.py"),
            encoding="utf-8").read()
# 用调用点本身当锚,别用 "report_agent" 这个字面量 —— 它在 build_notes 的
# getattr(ctx, "report_agent", None) 里也出现,拿它排序会排到 run_pipeline 前面去
_AT = 'lambda: run_report_agent(ctx, sd,'
check("run_pipeline 里有 report_agent 这一步",
      _AT in _src and 'ctx.step(\n            "report_agent",' in _src)
check("report_agent 排在 crowd_rules 之后",
      _src.index('ctx.step("crowd_rules"') < _src.index(_AT))
check("report_agent 排在 polish 之前",
      _src.index(_AT) < _src.index('"polish", lambda:'))
check("polish 的入参是 Agent 的产物或草稿",
      'polish_in = agent_info.get("state_full") if agent_info.get("used") else sd' in _src)
check("polish 收的是 polish_in",
      'polish_state(ctx, polish_in, call_cli, extract_json' in _src)
check("门禁没被绕过:self_critique 仍在 report_agent 之后",
      _src.index(_AT) < _src.index('ctx.step("self_critique"'))
check("render 仍由驱动自己跑",
      _src.index(_AT) < _src.index("steps.render(ctx, src, sf"))
check("出参 backend 带上了 report_agent", '"report_agent": getattr(ctx, "report_agent"' in _src)


# ------------------------------------------------------- 7) notes 如实说话
print("\n=== 7) notes:报告正文是谁写的,必须写清楚 ===")


class FakeSrc(object):
    name = "csv"
    id_col = "member_id"
    union_col = "union_id"
    sql_table = "t"
    path = "/tmp/x.csv"
    label = "本地 CSV"


class FakeBackend(object):
    def __init__(self, steps_name):
        self.source = FakeSrc()
        self.steps = Steps(steps_name)


ctx7 = Ctx(os.path.join(RUN, "notes"))
os.makedirs(ctx7.rundir)
ctx7.skill_degraded = False
ctx7.report_agent = {"used": True, "tools": "Bash,Read", "fixed_anchors": 2}
n7 = P.build_notes(ctx7, FakeBackend("skill"), [], False, True)
check("用了 Agent → notes 明说是模型自己调的 skill",
      any("自己调 marketing-audit" in x for x in n7), str([x[:30] for x in n7]))
check("同时说明门禁仍由服务复核", any("三道门禁" in x for x in n7))

ctx7b = Ctx(os.path.join(RUN, "notes2"))
os.makedirs(ctx7b.rundir)
ctx7b.skill_degraded = False
ctx7b.report_agent = {"used": False, "reason": "MA_REPORT_AGENT=0"}
n7b = P.build_notes(ctx7b, FakeBackend("skill"), [], False, True)
check("没用 Agent → notes 也明说走的是代跑那条链",
      any("代跑 skill 子命令" in x for x in n7b), str([x[:30] for x in n7b]))
check("把没走 Agent 的原因带出来", any("MA_REPORT_AGENT=0" in x for x in n7b))

ctx7c = Ctx(os.path.join(RUN, "notes3"))
os.makedirs(ctx7c.rundir)
ctx7c.skill_degraded = False
ctx7c.report_agent = None
n7c = P.build_notes(ctx7c, FakeBackend("stub"), [], False, True)
check("stub 后端不提 Agent 这回事",
      not any("代跑 skill 子命令" in x or "自己调 marketing-audit" in x for x in n7c))


# ------------------------------------------------- 7b) target_products 的来路
# 口径(2026-07-29 用户确认):它是品类名;默认取数据里的 activity_product_name,
# 用户也可以自己指定。所以"走了默认"是正常路径,不该当成降级去报警 ——
# 该盯的是取回来的到底像不像品类名。
print("\n=== 7b) target_products:默认取数,也允许显式指定 ===")


def _partial(run, products):
    os.makedirs(run, exist_ok=True)
    p = os.path.join(run, "state_partial.json")
    P._dump(p, {"campaign_meta": {"target_products": products}})
    return p


ctxA = Ctx(os.path.join(RUN, "tp_given"), {"activity_id": "A",
                                           "meta": {"target_products": ["机票"]}})
os.makedirs(ctxA.rundir)
metaA = json.loads(P.build_prepare_meta(ctxA))
check("显式给了就用显式的", metaA.get("target_products") == ["机票"], str(metaA))
check("显式给了就不算走默认", ctxA.meta_guessed is False, str(ctxA.meta_guessed))
check("显式给了不该有任何 meta 警告", not ctxA.warns, str(ctxA.warns))

ctxB = Ctx(os.path.join(RUN, "tp_auto"), {"activity_id": "B"})
os.makedirs(ctxB.rundir)
P.build_prepare_meta(ctxB)
gotB = P.check_inferred_products(ctxB, _partial(ctxB.rundir, ["机票"]))
check("没给就走 activity_product_name", ctxB.meta_guessed is True)
check("回读得到实际取到的品类", gotB == ["机票"], str(gotB))
check("走默认且取到品类名 → 不该报警(默认是正常路径,不是降级)",
      not ctxB.warns, str(ctxB.warns))

ctxC = Ctx(os.path.join(RUN, "tp_page"), {"activity_id": "C"})
os.makedirs(ctxC.rundir)
P.build_prepare_meta(ctxC)
P.check_inferred_products(ctxC, _partial(ctxC.rundir, ["特价机票业务总览"]))
check("取回来像页面名 → 这才该吵一声",
      any("看着像页面名" in w for w in ctxC.warns), str(ctxC.warns))

ctxD = Ctx(os.path.join(RUN, "tp_odd"), {"activity_id": "D"})
os.makedirs(ctxD.rundir)
P.build_prepare_meta(ctxD)
check("回读不到就当没这回事,不抛",
      P.check_inferred_products(ctxD, os.path.join(ctxD.rundir, "没有这个文件.json")) is None
      and P.check_inferred_products(ctxD, _partial(ctxD.rundir, [])) is None)
check("单个字符串不能被拆成一个个字",
      P.check_inferred_products(ctxD, _partial(ctxD.rundir, "机票")) == ["机票"],
      str(P.check_inferred_products(ctxD, _partial(ctxD.rundir, "机票"))))

for _c in (ctxA, ctxB):
    _c.skill_degraded = False
nA = P.build_notes(ctxA, FakeBackend("skill"), [], False, True)
nB = P.build_notes(ctxB, FakeBackend("skill"), [], False, True)
check("notes 说清楚品类是入参给的",
      any("由入参显式给出" in x and "机票" in x for x in nA),
      str([x for x in nA if "target_products" in x]))
check("notes 说清楚品类是默认取的,还带上取到了什么",
      any("走默认" in x and "机票" in x for x in nB),
      str([x for x in nB if "target_products" in x]))
check("prepare 之后真的回读了一次",
      "check_inferred_products(ctx, sp)" in _src)


# ------------------------------------------------------- 8) 开关与默认值
print("\n=== 8) 开关 ===")

check("MA_REPORT_AGENT 默认开", P.REPORT_AGENT is True, str(P.REPORT_AGENT))
check("默认工具是点名的那几个,不是全开",
      P.AGENT_TOOLS == "Bash,Read,Write,Edit,Glob,Grep", P.AGENT_TOOLS)
check("默认超时 2400s(356352 单 1197.45s 干完全活被 1200 擦边杀掉,翻倍留余量)",
      P.AGENT_TIMEOUT == 2400, str(P.AGENT_TIMEOUT))
check("帮助文本里列了这几个开关",
      all(k in _src for k in ("MA_REPORT_AGENT", "MA_AGENT_TOOLS", "MA_AGENT_TIMEOUT",
                              "MA_AGENT_MAX_TURNS", "MA_AGENT_PROMPT")))
check("锚点回填不再硬吃对象形状(一飘就炸的那种写法)",
      '(out.get("action_plan") or {}).get("priority_actions")' not in _src
      and "for a in priority_actions_of(out):" in _src)
check("SEG_ANCHORS 就是圈人用到的那五个",
      set(P.SEG_ANCHORS) == {"name", "sql_filter", "estimated_size", "direction",
                             "finding_id"}, str(P.SEG_ANCHORS))


print("\n=== 汇总:{} 过 / {} 挂 ===".format(len(OK), len(BAD)))
for b in BAD:
    print("  挂: " + b)
sys.exit(1 if BAD else 0)
