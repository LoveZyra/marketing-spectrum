# -*- coding: utf-8 -*-
"""fix6 回归:方案 C 到底有没有用上 skill 自己那套东西。

起因是两个问题:
  1) 「C 方案报告组装的时候,是不是并没有阅读并使用诊断 skill」—— 是。
     SKILL.md 推荐的流程第 8 步 `run-tools --tools self_critique` 我整条跳过了,
     在外面另写了一套字数体检当质检。
  2) 「skill 自带了质检环节,为什么你还要单独写」—— 没有理由,那是我漏了。
     它是纯 Python、不需要模型,方案 C 的驱动完全跑得动。

顺带查出来的第三件事最要命:渠道词汇门禁(REWRITE_REQUIRED / exit 3)没有强制开关,
skill 的方法论也明写「不得使用 --allow-channel-lint 绕过」。所以以前一撞上它,
render 抛错 → _try 降级成本地骨架页 —— 这正是「c 产出的报告样式不是 skill 里的样式」。

这份回归盯的就是这三条链路,外加 --auto-meta 那个 SKILL.md 自己标了「必须向用户确认」
的坑(以及顺手查出来的 dict 进 argv 会直接崩的 bug)。

用法:python3 regress_critique.py
"""
import io
import json
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("MA_RUNTIME", "stub")

import ma_core
import ma_pipeline as P

OK, BAD = [], []


def check(name, cond, detail=""):
    (OK if cond else BAD).append(name)
    print("  [{}] {}{}".format("PASS" if cond else "FAIL", name,
                               ("  <- " + detail) if detail else ""))


RUN = "/tmp/regress_critique"
if os.path.isdir(RUN):
    shutil.rmtree(RUN)
os.makedirs(RUN)


class Ctx(object):
    """够用的 ctx 替身:critique / 渠道改写 / build_prepare_meta 都只用到这几样。"""

    def __init__(self, run, params=None):
        self.run = self.rundir = run
        self.params = params or {}
        self.activity_id = self.params.get("activity_id") or "REGRESS"
        self.logs = []
        self.warns = []
        self.critique = None
        self.critique_left = 0
        self.channel_rewrites = 0
        self.meta_guessed = False
        # 跟真 Ctx 对齐,别让替身比正主宽松
        self.products_given = None
        self.products_inferred = None
        self.render_forced = False
        self.render_flags = []
        self.skill_degraded = False

    def path(self, name):
        return os.path.join(self.run, name)

    def log(self, m):
        self.logs.append(m)

    def warn(self, m):
        self.warns.append(m)
        self.logs.append("WARN " + m)


def full_state():
    """一份已经润色完的 state,字段名照 skill 的 schema 来。"""
    return {
        "_stage": "full",
        "campaign_meta": {"activity_id": "REGRESS", "campaign_type": "社群进群"},
        "findings": [
            {"id": "fnd_r41", "title": "创单未付规模偏大",
             "signal": "2403 名用户创单后未支付",
             "detail": "规则#7 命中 2403 人,占进站用户 12.4%,成单率 0%"},
            {"id": "fnd_model_1", "title": "高分人群转化更好",
             "signal": "模型高分段成单率 3.1%",
             "detail": "AUC 0.71,高分段较低分段高 2.4 个百分点"},
        ],
        "audience_segments": [
            {"name": "创单未付待促付人群", "direction": "push", "finding_id": "fnd_r41",
             "sql_filter": "has_order=1 AND paid=0", "estimated_size": 2403,
             "profile_text": "创单后 24 小时未支付,广告用户占比偏高"},
        ],
        "narratives": {
            "headline": "创单未付 2403 人是本次最大的转化漏损,应优先启动促付挽回",
            "problems": [
                {"title": "创单未付规模偏大", "impact": "广告流量进站后成单率为 0"},
                {"title": "高频触达无增益", "impact": "触达 3 次以上成单率反降"},
            ],
        },
        "action_plan": {
            "priority_actions": [
                {"rank": 1, "title": "启动促付挽回,成单率 0%→2.5%",
                 "expected_impact": "预计新增成单 60 单",
                 "target_audiences": ["创单未付待促付人群"]},
            ],
        },
    }


def dump_state(name, obj=None):
    p = os.path.join(RUN, name)
    P._dump(p, obj if obj is not None else full_state())
    return p


# ------------------------------------------------------- 1) issue 落到哪个字段
print("\n=== 1) critique_target_paths:一条 issue 落到哪些可改写字段 ===")
S = full_state()

r = P.critique_target_paths(S, {"target_kind": "finding", "target_id": "fnd_r41"})
check("finding 按 id 定位", "findings[0].detail" in r and "findings[0].signal" in r, str(r))
check("finding 定位不会串到隔壁那条",
      not any(p.startswith("findings[1]") for p in r), str(r))

r = P.critique_target_paths(S, {"target_kind": "audience_segment",
                                "target_id": "创单未付待促付人群"})
check("audience_segment 按 name 定位", "audience_segments[0].profile_text" in r, str(r))
# 这条是硬底线:人群 name 同时被 priority_actions.target_audiences 和 crowd_rules.json 引用,
# 改一个字圈人就对不上了(fnd_r41 就是这么丢过一次)
check("绝不把人群 name 交出去改", not any(p.endswith(".name") for p in r), str(r))
check("绝不把 sql_filter 交出去改",
      not any("filter" in p for p in r), str(r))

r = P.critique_target_paths(S, {"target_kind": "priority_action", "target_id": "1"})
check("priority_action 按 rank 定位",
      "action_plan.priority_actions[0].title" in r, str(r))
r = P.critique_target_paths(S, {"target_kind": "priority_action",
                                "target_id": "启动促付挽回,成单率 0%→2.5%"})
check("priority_action 也认 title", "action_plan.priority_actions[0].title" in r, str(r))

r = P.critique_target_paths(S, {"target_kind": "narrative", "target_id": "1"})
check("narrative 按下标定位", r == ["narratives.problems[1].title",
                                    "narratives.problems[1].impact"], str(r))

check("定位不到就老实返回空",
      P.critique_target_paths(S, {"target_kind": "finding", "target_id": "不存在"}) == [],
      "")
check("下标越界不许崩",
      P.critique_target_paths(S, {"target_kind": "narrative", "target_id": "99"}) == [])
check("target_kind 不认识也不崩",
      P.critique_target_paths(S, {"target_kind": "rule", "target_id": "x"}) == [])


# ------------------------------------------------------- 2) 改不动的要留痕
print("\n=== 2) park_in_blind_spots:改不动的问题必须明写,不许悄悄消失 ===")
st2 = full_state()
issues2 = [
    {"type": "statistical_coherence", "severity": "warning", "target_kind": "finding",
     "target_id": "fnd_model_1", "message": "AUC 0.71 在事实层查不到原值",
     "suggested_fix": "重算 metric_refs 或写入 data_caveats"},
    {"type": "business_coherence", "severity": "warning", "target_kind": "finding",
     "target_id": "fnd_r41", "message": "方向与模型 top 特征相反",
     "suggested_fix": "移入 cross_validation"},
]
n = P.park_in_blind_spots(st2, issues2, 1)
spots = st2["action_plan"]["blind_spots"]
check("两条都记了账", n == 2 and len(spots) == 2, str(n))
check("记的是 methodology/05 的 accept 分支形状",
      all(set(("topic", "evidence", "recommended_probe")) <= set(s) for s in spots),
      str(spots[0]))
check("topic 带上 issue 类型好回查", "[statistical_coherence]" in spots[0]["topic"],
      spots[0]["topic"])
check("evidence 写清楚为什么不修(而不是假装修了)",
      "不带工具" in spots[0]["evidence"], spots[0]["evidence"])
check("suggested_fix 进了 recommended_probe",
      spots[0]["recommended_probe"] == issues2[0]["suggested_fix"])
check("再记一遍不会重复", P.park_in_blind_spots(st2, issues2, 2) == 0,
      str(len(st2["action_plan"]["blind_spots"])))
check("空清单不写东西", P.park_in_blind_spots(st2, [], 2) == 0)

st2b = {"action_plan": {"blind_spots": ["老格式的一条字符串"]}}
P.park_in_blind_spots(st2b, issues2[:1], 1)
check("blind_spots 里混着老字符串也不崩",
      len(st2b["action_plan"]["blind_spots"]) == 2,
      str(st2b["action_plan"]["blind_spots"]))


# ------------------------------------------------------- 3) 跑 skill 自带质检
print("\n=== 3) critique_repair:跑 skill 的质检,并按它的归宿表安排每条 issue ===")


class FakeSteps(object):
    """按 run-tools 的真实行为写:它原地改写 state 文件,所以调用方必须重新读盘。"""

    name = "skill"

    def __init__(self, rounds, mutate=None):
        self.rounds = list(rounds)          # 每轮返回的 issue 列表(None = 没问到)
        self.calls = []
        self.mutate = mutate

    def self_critique(self, ctx, state_path, rnd=1):
        self.calls.append((state_path, rnd))
        if self.mutate:
            st = P._load(state_path)
            self.mutate(st, rnd)
            P._dump(state_path, st)
        i = len(self.calls) - 1
        return self.rounds[i] if i < len(self.rounds) else []

    def status(self, ctx, state_path):
        return None


def fake_cli(fills):
    """替身模型:按 path 回填给定文案。返回 (fn, 调用记录)。"""
    seen = []

    def _call(prompt, timeout=None):
        seen.append(prompt)
        return {"exit_code": 0,
                "stdout": json.dumps({"fills": fills}, ensure_ascii=False)}
    return _call, seen


LANG = {"type": "language_compliance", "severity": "warning", "target_kind": "finding",
        "target_id": "fnd_r41", "message": "detail 里出现规则编号",
        "suggested_fix": "把「规则#7」改成中文规则名"}
STAT = {"type": "statistical_coherence", "severity": "warning", "target_kind": "finding",
        "target_id": "fnd_model_1", "message": "AUC 查不到原值",
        "suggested_fix": "重算或写入 data_caveats"}
GHOST = {"type": "closure", "severity": "error", "target_kind": "finding",
         "target_id": "fnd_不存在", "message": "引用了不存在的人群",
         "suggested_fix": "补真实人群"}

NEW_DETAIL = "低活跃衰减规则命中 2403 人,占进站用户 12.4%,这批人成单率为 0"

sp = dump_state("s_crit1.json")
steps = FakeSteps([[LANG, STAT], []])
cli, seen = fake_cli({"findings[0].detail": NEW_DETAIL})
ctx = Ctx(RUN)
info = {}
stat = P.critique_repair(ctx, sp, steps, cli, ma_core.extract_json, info)
after = P._load(sp)
check("文字类问题交给模型重写了", after["findings"][0]["detail"] == NEW_DETAIL,
      after["findings"][0]["detail"])
check("重写结果落盘了(不是只改内存)", "规则#7" not in json.dumps(after, ensure_ascii=False))
check("重算类问题没去动文字",
      after["findings"][1]["detail"] == full_state()["findings"][1]["detail"])
check("重算类问题按方法论进了 blind_spots",
      any("statistical_coherence" in s["topic"]
          for s in after["action_plan"]["blind_spots"]), str(stat))
check("统计:改上 1 条", stat["fixed"] >= 1, str(stat))
check("统计:记账 1 条", stat["parked"] >= 1, str(stat))
check("收尾复检问了最后一轮", len(steps.calls) == 2, str(steps.calls))
check("最后一轮清零 → left=0", stat["left"] == 0, str(stat))
check("提示词里带上 skill 自己的写作约束",
      seen and "写作" in seen[0], (seen[0][:60] if seen else ""))
check("提示词里带上 skill 的原话建议",
      seen and "中文规则名" in seen[0])
check("prompt / stdout 都落盘了,出问题能翻",
      os.path.exists(os.path.join(RUN, "repair_prompt_critique_r1.txt"))
      and os.path.exists(os.path.join(RUN, "repair_stdout_critique_r1.txt")))
check("出参挂在 ctx.critique 上", ctx.critique is stat)

# run-tools 是原地改 state 的:必须重新读盘,否则它自动修掉的东西会被我们覆盖回去
sp = dump_state("s_crit2.json")


def _mutate(st, rnd):
    st["findings"][0]["signal"] = "skill 自己修过的句子 r{}".format(rnd)


steps = FakeSteps([[STAT], []], mutate=_mutate)
cli, _ = fake_cli({})
ctx = Ctx(RUN)
P.critique_repair(ctx, sp, steps, cli, ma_core.extract_json, {})
check("skill 在质检里自动修的内容没被我们覆盖掉",
      P._load(sp)["findings"][0]["signal"].startswith("skill 自己修过的句子"),
      P._load(sp)["findings"][0]["signal"])

# 定位不到的问题:不能因为"清单空了"就当修好了
sp = dump_state("s_crit3.json")
steps = FakeSteps([[GHOST], []])
cli, _ = fake_cli({})
ctx = Ctx(RUN)
stat = P.critique_repair(ctx, sp, steps, cli, ma_core.extract_json, {})
check("定位不到的问题要告警", any("定位不到" in w for w in ctx.warns), str(ctx.warns))
check("定位不到也要记账,不许人间蒸发",
      any("closure" in s["topic"] for s in P._load(sp)["action_plan"]["blind_spots"]))
check("统计里如实记了 unlocated", stat["unlocated"] == 1, str(stat))

# 质检压根没跑通:必须如实说"没问到",不能报"通过"
sp = dump_state("s_crit4.json")
steps = FakeSteps([None])
ctx = Ctx(RUN)
stat = P.critique_repair(ctx, sp, steps, fake_cli({})[0], ma_core.extract_json, {})
check("没问到 → left=None(不等于没问题)", stat["left"] is None, str(stat))
check("没问到要留一句警告", any("没问到" in w for w in ctx.warns), str(ctx.warns))
check("没问到就不该再问第二轮", len(steps.calls) == 1, str(steps.calls))

# 一上来就干净
sp = dump_state("s_crit5.json")
steps = FakeSteps([[]])
ctx = Ctx(RUN)
stat = P.critique_repair(ctx, sp, steps, fake_cli({})[0], ma_core.extract_json, {})
check("一轮就干净 → 直接收工", stat["left"] == 0 and len(steps.calls) == 1, str(stat))
check("干净的时候不写 blind_spots",
      "blind_spots" not in (P._load(sp).get("action_plan") or {}))

# 第二轮还剩:全部记账 + 告警
sp = dump_state("s_crit6.json")
steps = FakeSteps([[STAT], [STAT]])
ctx = Ctx(RUN)
stat = P.critique_repair(ctx, sp, steps, fake_cli({})[0], ma_core.extract_json, {})
check("跑完还剩的要告警", any("仍有" in w for w in ctx.warns), str(ctx.warns))
check("跑完还剩的数记在 left", stat["left"] == 1, str(stat))
check("剩下的全在 blind_spots 里查得到",
      len(P._load(sp)["action_plan"]["blind_spots"]) >= 1)

# 开关关掉 = 明确不跑,而不是假装跑过
old = P.SELF_CRITIQUE
P.SELF_CRITIQUE = False
steps = FakeSteps([[STAT]])
ctx = Ctx(RUN)
check("MA_SELF_CRITIQUE=0 就真的不跑",
      P.critique_repair(ctx, dump_state("s_crit7.json"), steps, fake_cli({})[0],
                        ma_core.extract_json, {}) is None and not steps.calls)
P.SELF_CRITIQUE = old


class NoCritique(object):
    name = "stub"


ctx = Ctx(RUN)
check("后端没有 self_critique 也不崩",
      P.critique_repair(ctx, dump_state("s_crit8.json"), NoCritique(),
                        fake_cli({})[0], ma_core.extract_json, {}) is None)
check("本地骨架如实返回没问到", P.StubSteps().self_critique(ctx, "x") is None)


# ------------------------------------------------------- 4) 渠道门禁:读它的原话
print("\n=== 4) parse_channel_gate:按 skill 打印的原格式抠违规词 ===")

# 一字不改抄自 cli.py cmd_render 的打印块
GATE = """
[render] REWRITE_REQUIRED: 检测到渠道词汇违规，报告不得产出
         宿主 Agent 必须按以下指示修改 state_full.json 后重新 render：

  ✗ findings[0] (fnd_r41)
    渠道：广告 专属词汇 ['广告用户', '广告流量'] 不应出现
    实际渠道：['activity']
    修正：改为「活动触达用户/活动推送（activity渠道）」

  ✗ narratives.problems[0]
    渠道：广告 专属词汇 ['广告流量'] 不应出现
    实际渠道：['activity']
    修正：改为「活动触达用户/活动推送（activity渠道）」

  [修改规则]
  1. 找到上述 location 的 signal/detail/title/narrative 字段
  2. 删除或替换所有列出的专属词汇（用实际渠道对应词汇替代）
  3. 保存 state_full.json 后重新执行 cli render
"""
bad, actual = P.parse_channel_gate(GATE)
check("违规词全抠出来了", bad == ["广告用户", "广告流量"], str(bad))
check("实际渠道抠出来了", actual == ["activity"], str(actual))
check("同一个词不重复", len(bad) == len(set(bad)))
check("空输入不崩", P.parse_channel_gate("") == ([], []))
check("认不出格式就返回空(而不是瞎猜)",
      P.parse_channel_gate("[render] REWRITE_REQUIRED: 出事了") == ([], []))
b2, a2 = P.parse_channel_gate('    渠道：Push 专属词汇 ["Push触达用户"] 不应出现\n'
                              "    实际渠道：activity")
check("双引号和不带方括号的实际渠道也认", b2 == ["Push触达用户"] and a2 == ["activity"],
      str((b2, a2)))


print("\n=== 5) paths_with_terms:按词面全树搜,不去解析 location ===")
S5 = full_state()
paths = P.paths_with_terms(S5, ["广告用户", "广告流量"])
check("人群 profile_text 里的找到了", "audience_segments[0].profile_text" in paths, str(paths))
check("narratives 深处的也找到了", "narratives.problems[0].impact" in paths, str(paths))
check("没有的词不乱报", P.paths_with_terms(S5, ["弹屏打扰"]) == [])
S5b = {"audience_segments": [{"name": "广告用户高潜人群", "detail": "正常句子"}]}
check("name 里带违规词也不动它(改了圈人就对不上)",
      P.paths_with_terms(S5b, ["广告用户"]) == [], str(P.paths_with_terms(S5b, ["广告用户"])))
S5c = {"findings": [{"sql_filter": "channel='广告用户'", "detail": "广告用户 2403 人"}]}
check("只改文案字段,不碰 sql_filter",
      P.paths_with_terms(S5c, ["广告用户"]) == ["findings[0].detail"],
      str(P.paths_with_terms(S5c, ["广告用户"])))


print("\n=== 6) blunt_channel_fix:模型没改干净时的兜底 ===")
S6 = full_state()
S6["findings"][0]["detail"] = "广告用户共 2,403 人,广告流量进站后成单率 0%"
n = P.blunt_channel_fix(S6, ["findings[0].detail"], ["广告用户", "广告流量"], ["activity"])
got = S6["findings"][0]["detail"]
check("换掉了渠道词头", n == 1 and "广告" not in got, got)
check("换成了实际渠道的说法", got.startswith("活动用户"), got)
check("数字一个没动", "2,403" in got and "0%" in got, got)
S6b = {"findings": [{"detail": "弹屏打扰次数偏高"}]}
P.blunt_channel_fix(S6b, ["findings[0].detail"], ["弹屏打扰"], ["push"])
check("渠道词头按实际渠道走(push→Push)",
      "Push" in S6b["findings"][0]["detail"], S6b["findings"][0]["detail"])
S6c = {"findings": [{"detail": "认不出词头的怪词ABC 在这儿"}]}
P.blunt_channel_fix(S6c, ["findings[0].detail"], ["认不出词头的怪词ABC"], ["activity"])
check("认不出词头就整词换掉,绝不留违规词",
      "认不出词头的怪词ABC" not in S6c["findings"][0]["detail"],
      S6c["findings"][0]["detail"])


# ------------------------------------------------------- 7) render 撞门禁怎么办
print("\n=== 7) render × 渠道门禁:改文案重渲,绝不加 --allow-channel-lint ===")

GATE_TAIL = GATE.strip()
COMPLETE_TAIL = ("[render] INCOMPLETE_REPORT: 检测到会破坏页面结构的缺项，报告不得产出\n"
                 "  ✗ [draft_not_polished] 检测到未润色草稿")


def fake_run(tails):
    calls = []

    def _run(ctx, cmd, timeout=None, code="E_STEP_FAILED"):
        calls.append(list(cmd))
        i = len(calls) - 1
        if i < len(tails) and tails[i]:
            raise P.StepError(code, "子命令失败 exit=3",
                              {"exit_code": 3, "tail": tails[i]})
        with io.open(os.path.join(ctx.rundir, "diagnosis_report.html"), "w",
                     encoding="utf-8") as fh:
            fh.write(u"<html>正版模板</html>")
        return ""
    return _run, calls


def run_render(tails, rewrite_ok=True, sub="rd"):
    d = os.path.join(RUN, sub)
    if os.path.isdir(d):
        shutil.rmtree(d)
    os.makedirs(d)
    sf = os.path.join(d, "state_full.json")
    P._dump(sf, full_state())
    ctx = Ctx(d)
    rew = []

    def _on(tail, rnd):
        rew.append((tail, rnd))
        return rewrite_ok

    st = P.SkillSteps()
    st._help = "usage: cli.py {prepare,draft,render,run-tools,status}"
    fn, calls = fake_run(tails)
    old = P.run_cmd
    P.run_cmd = fn
    try:
        html = st.render(ctx, None, sf, on_rewrite=_on)
    finally:
        P.run_cmd = old
    return html, calls, rew, ctx


html, calls, rew, ctx = run_render([GATE_TAIL, None], sub="rd1")
check("撞上渠道门禁会回调改文案", len(rew) == 1, str(len(rew)))
check("回调拿到的是 skill 的原话", "REWRITE_REQUIRED" in rew[0][0])
check("改完真的重渲了一次", len(calls) == 2, str(len(calls)))
# 这条是这次修复的核心:方法论明写不得用 --allow-channel-lint 绕过
check("从头到尾没出现 --allow-channel-lint",
      not any("--allow-channel-lint" in c for c in calls), str(calls[-1]))
check("重渲那次一个开关都没加", calls[1] == calls[0], str(calls[1][len(calls[0]):]))
check("最后拿到的是 skill 的正版页", "正版模板" in io.open(html, encoding="utf-8").read())
check("降级标记没被误设", ctx.skill_degraded is False)
check("改写次数记了账", ctx.channel_rewrites == 1, str(ctx.channel_rewrites))
check("门禁原文落盘留证",
      os.path.exists(os.path.join(RUN, "rd1", "skill_error_render_gate_channel_r1.txt")))

html, calls, rew, ctx = run_render([GATE_TAIL, GATE_TAIL, None], sub="rd2")
check("拦两次就改两次", len(rew) == 2 and len(calls) == 3, str((len(rew), len(calls))))
check("改两次也没碰那个开关",
      not any("--allow-channel-lint" in c for c in calls))

html, calls, rew, ctx = run_render([GATE_TAIL, None], rewrite_ok=False, sub="rd3")
check("改不动就老实降级(而不是硬产一张带错词的报告)",
      ctx.skill_degraded is True and len(calls) == 1, str(len(calls)))

old_tries = P.CHANNEL_TRIES
P.CHANNEL_TRIES = 1
html, calls, rew, ctx = run_render([GATE_TAIL, GATE_TAIL, None], sub="rd4")
check("改写次数封顶,不会无限重渲", len(rew) == 1 and ctx.skill_degraded is True,
      str((len(rew), len(calls))))
P.CHANNEL_TRIES = old_tries

# 完备性门禁还是走老路:补 skill 自己给的强制开关
html, calls, rew, ctx = run_render([COMPLETE_TAIL, None], sub="rd5")
check("完备性门禁仍旧靠 --skip-completeness",
      "--skip-completeness" in calls[1] and not rew, str(calls[1][-3:]))
check("两道门禁接连拦也各走各的路",
      run_render([COMPLETE_TAIL, GATE_TAIL, None], sub="rd6")[2].__len__() == 1)

html, calls, rew, ctx = run_render([None], sub="rd7")
check("不给回调也照常跑(老调用方不受影响)",
      P.SkillSteps().render.__defaults__ == (None,), str(P.SkillSteps().render.__defaults__))
check("本地骨架渲染也认新签名",
      "on_rewrite" in P.StubSteps.render.__code__.co_varnames)

# 关掉开关 = 回到修复前那条老路(会降级),这条留着是为了让开关的代价看得见
old_fix = P.CHANNEL_FIX
P.CHANNEL_FIX = False
check("MA_CHANNEL_FIX=0 时不给回调",
      P.make_channel_rewriter(Ctx(RUN), "x", fake_cli({})[0], ma_core.extract_json, {})
      is None)
P.CHANNEL_FIX = old_fix


print("\n=== 8) make_channel_rewriter:真去改那几句话 ===")
d8 = os.path.join(RUN, "ch")
os.makedirs(d8)
sf8 = os.path.join(d8, "state_full.json")
P._dump(sf8, full_state())
ctx8 = Ctx(d8)
info8 = {}
cli8, seen8 = fake_cli({
    "audience_segments[0].profile_text": "创单后 24 小时未支付,活动触达用户占比偏高",
    "narratives.problems[0].impact": "活动触达用户进站后成单率为 0",
})
ok = P.make_channel_rewriter(ctx8, sf8, cli8, ma_core.extract_json, info8)(GATE_TAIL, 1)
after8 = P._load(sf8)
blob8 = json.dumps(after8, ensure_ascii=False)
check("改写返回成功", ok is True)
check("违规词从整份 state 里清干净了", "广告用户" not in blob8 and "广告流量" not in blob8,
      blob8[:120])
check("人数没被顺手改掉", after8["audience_segments"][0]["estimated_size"] == 2403)
check("人群 name 一个字没动",
      after8["audience_segments"][0]["name"] == "创单未付待促付人群")
check("提示词把 skill 的实际渠道告诉模型了", "activity" in seen8[0])
check("改写明细进了 info,出参查得到", info8["channel_fix"][0]["bad_terms"] == ["广告用户", "广告流量"],
      str(info8.get("channel_fix")))
check("门禁告警说清楚了没用绕过开关",
      any("allow-channel-lint" in w for w in ctx8.warns), str(ctx8.warns))

# 模型敷衍了事(改完还带着违规词)→ 必须兜底,不能就这么发出去
P._dump(sf8, full_state())
ctx8b = Ctx(d8)
info8b = {}
lazy, _ = fake_cli({"audience_segments[0].profile_text": "广告用户还是在这儿",
                    "narratives.problems[0].impact": "广告流量还是在这儿"})
ok = P.make_channel_rewriter(ctx8b, sf8, lazy, ma_core.extract_json, info8b)(GATE_TAIL, 1)
blob = json.dumps(P._load(sf8), ensure_ascii=False)
check("模型没改干净时兜底顶上", ok is True and "广告用户" not in blob, blob[:120])
check("兜底了要说一声", any("机械替换" in w for w in ctx8b.warns), str(ctx8b.warns))
check("兜底次数也记账", info8b["channel_fix"][0]["blunt_fixed"] >= 1, str(info8b))

P._dump(sf8, full_state())
ctx8c = Ctx(d8)
check("门禁原话抠不出词就如实说改不了",
      P.make_channel_rewriter(ctx8c, sf8, fake_cli({})[0], ma_core.extract_json, {})(
          "[render] REWRITE_REQUIRED: 看不懂的格式", 1) is False)
check("抠不出词要告警", any("抠出" in w for w in ctx8c.warns), str(ctx8c.warns))


# ------------------------------------------------------- 9) 两道门禁互相挡路
print("\n=== 9) schema_error_lines:别把非阻塞的 lint 当成阻塞的 schema 错误 ===")

# 一字不改抄自 cli.py cmd_render:schema 有错就 return 2,lint 那段根本轮不到打印
SCHEMA_TAIL = u"""[render] headline 自动截断 78→60 字：先把创单未付这批人捞回来…
[render] schema validate: 2 errors
         · narratives.headline 长度 26 字 < 30 字 (当前: 2403人创单未付，立即启动促付挽回)
         · action_plan.priority_actions[0].expected_impact 缺少量化目标
[render] aborted due to schema errors (use --skip-validate to force)"""

# schema 过了才轮到 lint。两段的条目长得一模一样(都是「         · xxx」)——
# 整段一起 parse 的话,非阻塞的 lint 会被当成阻塞的 schema 错误:白让模型重写一遍
# 不该动的字段,还会在出参里谎报「schema 没过 3 条」。
LINT_TRAP = u"""[render] schema validate: 0 errors
[render] lint warnings: 3
         · findings[0].detail 单句超过 60 字，建议拆句
         · narratives.problems[1].impact 存在 AI 腔用词
         · action_plan.priority_actions[0].title 未使用「动词+幅度」模板
[render] completeness: 1 blocking, 0 warnings

[render] INCOMPLETE_REPORT: 检测到会破坏页面结构的缺项，报告不得产出
         宿主 Agent 必须补齐以下项后重新 render（或 --skip-completeness 强制）：
  ✗ [draft_not_polished] 检测到未润色草稿（待润色×49）"""

errs = P.parse_schema_errors(SCHEMA_TAIL)
check("schema 那段的条目都抠出来了", len(errs) == 2, str(errs))
check("字数类报错拆成了结构化的要求",
      errs[0]["field"] == "narratives.headline" and errs[0]["op"] == "<"
      and errs[0]["need"] == 30 and errs[0]["got"] == 26, str(errs[0]))
check("自动截断那行不是条目,没混进来",
      all("自动截断" not in e["raw"] for e in errs), str(errs))
check("收尾那句 aborted 也没混进来",
      all("aborted" not in e["raw"] for e in errs), str(errs))

check("lint 的条目一条都不算 schema 错误", P.parse_schema_errors(LINT_TRAP) == [],
      str(P.parse_schema_errors(LINT_TRAP)))
check("完备性门禁的 ✗ 行也不算 schema 错误",
      not any("draft_not_polished" in e["raw"] for e in P.parse_schema_errors(LINT_TRAP)))
check("下一个 [xxx] 段头就是分界线",
      P.schema_error_lines(LINT_TRAP) == [], str(P.schema_error_lines(LINT_TRAP)))

MIXED = u"""[render] schema validate: 1 errors
         · narratives.headline 长度 26 字 < 30 字
[render] lint warnings: 2
         · 这条是 lint,不该被当成 schema
         · 这条也是"""
mx = P.parse_schema_errors(MIXED)
check("同一段输出里两种条目并存也切得开", len(mx) == 1, str(mx))
check("切出来的是 schema 那条", "长度" in mx[0]["raw"], str(mx))

RETRY = u"""[render] schema validate: 1 errors
         · 上一轮的老报错
[render] aborted due to schema errors (use --skip-validate to force)
[render] schema validate: 1 errors
         · action_plan.priority_actions[0].title 缺少目标值"""
rt = P.parse_schema_errors(RETRY)
check("一个 tail 里有好几段时取最后一段(重试的结论才算数)",
      len(rt) == 1 and "priority_actions" in rt[0]["raw"], str(rt))

check("没有段头、但看得出已经走过 schema 那层 → 不拿后面的条目冒充",
      P.parse_schema_errors(u"[render] lint warnings: 1\n         · 只是个 lint") == [])
check("认不出结构就维持老行为,整段 parse(宁可多问一句)",
      len(P.parse_schema_errors(u"  · 谁知道这是哪来的一条\n  · 还有一条")) == 2)
check("空输入不崩", P.parse_schema_errors("") == [] and P.schema_error_lines(None) == [])


print("\n=== 9b) SkillSteps.validate:渠道门禁要能跟「通过」「问不出来」分开 ===")


def run_validate(tails, help_text="usage: cli.py {prepare,draft,render,run-tools,status}"):
    """把 validate 的 run_cmd 换成按剧本抛错的替身,返回 (结论, 实际执行的命令)。"""
    d = os.path.join(RUN, "vd")
    if not os.path.isdir(d):
        os.makedirs(d)
    ctx = Ctx(d)
    st = P.SkillSteps()
    st._help = help_text
    fn, calls = fake_run(tails)
    old = P.run_cmd
    P.run_cmd = fn
    try:
        return st.validate(ctx, os.path.join(d, "state_full.json")), calls, ctx
    finally:
        P.run_cmd = old


got, calls, _ = run_validate([GATE_TAIL])
check("渠道门禁不返回 None,而是一个认得出来的类型",
      isinstance(got, P.ChannelGate), repr(got))
check("门禁原话原样带上,后面才改得动文案", "REWRITE_REQUIRED" in got.tail)
check("ChannelGate 跟「体检通过」区分得开", got != [] and bool(got) is True)
check("撞上渠道门禁就别再补开关重试了(补了也过不去)", len(calls) == 1, str(len(calls)))

got, calls, _ = run_validate([None])
check("整个 render 空跑通过 → 返回 [](两道门禁都过了)", got == [], repr(got))
check("空跑用的是 render 不是不存在的 validate 子命令",
      "render" in calls[0] and "validate" not in calls[0], str(calls[0]))

got, calls, _ = run_validate([SCHEMA_TAIL])
check("schema 报错照常抠成清单", isinstance(got, list) and len(got) == 2, str(got))

got, calls, _ = run_validate([COMPLETE_TAIL, GATE_TAIL])
check("完备性门禁拦在前面时会补开关再问一次", len(calls) == 2
      and "--skip-completeness" in calls[1], str(calls))
check("补完开关问到的渠道门禁一样认得出", isinstance(got, P.ChannelGate), repr(got))

got, _, _ = run_validate([u"[render] 崩了,谁也看不懂的新格式"])
check("看不懂就返回 None(绝不返回空清单冒充「通过」)", got is None, repr(got))

got, calls, _ = run_validate(
    [None], help_text="usage: cli.py {prepare,draft,validate,render,status}")
check("--help 里真有 validate 才用 validate 子命令",
      "validate" in calls[0] and "render" not in calls[0], str(calls[0]))


print("\n=== 9c) schema_repair:渠道违规先清,别把重写轮次吃光 ===")


def fake_validate(script):
    """按剧本逐次返回体检结论。返回 (fn, 调用次数容器)。"""
    seen = []

    def _v(path):
        seen.append(path)
        i = len(seen) - 1
        return script[i] if i < len(script) else []
    return _v, seen


HEADLINE_ERR = {"raw": "narratives.headline 长度 26 字 < 30 字",
                "field": "narratives.headline", "op": "<", "need": 30, "got": 26}
NEW_HEADLINE = "创单未付 2403 人是本次最大的转化漏损,应当优先启动促付挽回把人捞回来"

old_rounds, old_check = P.SCHEMA_ROUNDS, P.SCHEMA_CHECK
P.SCHEMA_ROUNDS = 1

d9 = os.path.join(RUN, "sr1")
os.makedirs(d9)
ctx9 = Ctx(d9)
st9 = full_state()
val, vseen = fake_validate([P.ChannelGate(GATE_TAIL), []])
cli9, _ = fake_cli({
    "audience_segments[0].profile_text": "创单后 24 小时未支付,活动触达用户占比偏高",
    "narratives.problems[0].impact": "活动触达用户进站后成单率为 0",
})
info9 = {}
P.schema_repair(ctx9, st9, val, cli9, ma_core.extract_json, info9)
check("渠道违规先在内存里改掉了",
      "广告" not in json.dumps(st9, ensure_ascii=False), json.dumps(st9, ensure_ascii=False)[:100])
# 这条是 fix6c 的核心:MA_SCHEMA_ROUNDS=1 的时候,渠道门禁要是算一轮,
# 体检就再也问不到第二次 —— 一次渠道违规能把整个重写预算吃光
check("改完真的又问了一次(渠道那次不算轮次)", len(vseen) == 2, str(len(vseen)))
check("第二次问到「通过」,如实记账", info9.get("schema_ok") is True, str(info9))
check("渠道改写次数记在 ctx 上", ctx9.channel_rewrites == 1, str(ctx9.channel_rewrites))
check("schema 未解决数清零", ctx9.schema_unresolved == 0, str(ctx9.schema_unresolved))

# 一直清不干净:要封顶、要说清楚,不能死循环
old_ct = P.CHANNEL_TRIES
P.CHANNEL_TRIES = 1
d9b = os.path.join(RUN, "sr2")
os.makedirs(d9b)
ctx9b = Ctx(d9b)
st9b = full_state()
val, vseen = fake_validate([P.ChannelGate(GATE_TAIL)] * 5)
P.schema_repair(ctx9b, st9b, val, fake_cli({})[0], ma_core.extract_json, {})
check("渠道改写封顶,不会无限打转", len(vseen) == 2, str(len(vseen)))
check("放弃的时候说清楚 render 那头还会再修一次",
      any("render 那头还会再修" in w for w in ctx9b.warns), str(ctx9b.warns))
P.CHANNEL_TRIES = old_ct

# 改不动一处(门禁原话抠不出词)→ 直接收手,不要拿改不动的 state 反复问
d9c = os.path.join(RUN, "sr3")
os.makedirs(d9c)
ctx9c = Ctx(d9c)
val, vseen = fake_validate([P.ChannelGate(u"[render] REWRITE_REQUIRED: 看不懂"), []])
P.schema_repair(ctx9c, full_state(), val, fake_cli({})[0], ma_core.extract_json, {})
check("一处都改不上就收手", len(vseen) == 1, str(len(vseen)))

# 开关关掉 = 明确不修,交给 render 那头
old_fix = P.CHANNEL_FIX
P.CHANNEL_FIX = False
d9d = os.path.join(RUN, "sr4")
os.makedirs(d9d)
ctx9d = Ctx(d9d)
val, vseen = fake_validate([P.ChannelGate(GATE_TAIL), []])
P.schema_repair(ctx9d, full_state(), val, fake_cli({})[0], ma_core.extract_json, {})
check("MA_CHANNEL_FIX=0 时不在这一步修,直接跳过", len(vseen) == 1, str(len(vseen)))
check("跳过也要留一句话", any("渠道词汇还没清干净" in w for w in ctx9d.warns), str(ctx9d.warns))
P.CHANNEL_FIX = old_fix

# 轮次用完后的收尾复检又撞上渠道门禁:ChannelGate 没有 len(),
# 不挡住的话 len(left) 会当场 TypeError 把整个润色步骤带崩
d9e = os.path.join(RUN, "sr5")
os.makedirs(d9e)
ctx9e = Ctx(d9e)
st9e = full_state()
val, vseen = fake_validate([[HEADLINE_ERR], P.ChannelGate(GATE_TAIL)])
info9e = {}
crashed = None
try:
    P.schema_repair(ctx9e, st9e, val,
                    fake_cli({"narratives.headline": NEW_HEADLINE})[0],
                    ma_core.extract_json, info9e)
except Exception as exc:                                            # noqa: BLE001
    crashed = repr(exc)
check("收尾复检撞上渠道门禁不会崩", crashed is None, crashed or "")
check("重写确实落地了(否则走不到收尾复检)",
      st9e["narratives"]["headline"] == NEW_HEADLINE, st9e["narratives"]["headline"])
check("收尾复检真的问了", len(vseen) == 2, str(len(vseen)))
check("渠道门禁不冒充「schema 没过 N 条」", info9e.get("schema_ok") is not True
      and "schema_ok" not in info9e, str(info9e))

P.SCHEMA_ROUNDS, P.SCHEMA_CHECK = old_rounds, old_check

ctx9f = Ctx(RUN)
check("validate 是 None(后端问不了)就整步跳过",
      P.schema_repair(ctx9f, full_state(), None, fake_cli({})[0],
                      ma_core.extract_json, {}) is None and not ctx9f.warns)


# ------------------------------------------------------- 10) --meta 那个坑
print("\n=== 10) build_prepare_meta:SKILL.md 自己标了「必须向用户确认」的那条 ===")

m = P.build_prepare_meta(Ctx(RUN, {"activity_id": "A1"}))
check("返回的是字符串,不是 dict", isinstance(m, str), type(m).__name__)
# 这条不是理论问题:ma_core 把 meta 校验成 dict,而 prepare 直接把它塞进 argv,
# subprocess 见到 dict 会当场 TypeError —— 只是至今没人传过 meta 才没炸
check("dict 进 argv 会当场崩,所以这里必须先序列化",
      all(isinstance(x, str) for x in [m]))
d = json.loads(m)
# 2026-07-30 改口径:--meta 里不再造占位符。auto-meta 是 setdefault 合并,
# 提前塞 campaign_name=活动ID / campaign_type=社群进群,会把它从数据
# (activity_name / activity_channel)推真值的路堵死 —— 356352 报告标题
# 显示活动 ID 就是这么来的。兜底挪到 prepare 之后的 apply_meta_defaults。
check("不再造占位:没给 campaign_type 就不出现在 --meta 里", "campaign_type" not in d, str(d))
check("不再造占位:没给 campaign_name 就不出现在 --meta 里(留给 auto-meta 从 activity_name 推)",
      "campaign_name" not in d, str(d))

# apply_meta_defaults:prepare 之后的收尾兜底链
_stA = os.path.join(RUN, "meta_state_a.json")
P._dump(_stA, {"campaign_meta": {"campaign_name": "夏日大促",
                                 "target_channels": ["push", "sms"]}})
ctxA = Ctx(RUN, {"activity_id": "A1"})
cmA = P.apply_meta_defaults(ctxA, _stA)
check("campaign_type 未传 → 用数据 activity_channel(target_channels 第一个)",
      cmA["campaign_type"] == "push", str(cmA))
check("有真名(auto-meta 从 activity_name 推到)就不警告", not ctxA.warns, str(ctxA.warns))
check("最终 campaign_type 同步回 params(Agent 提示词用)",
      ctxA.params.get("campaign_type") == "push", str(ctxA.params.get("campaign_type")))

_stB = os.path.join(RUN, "meta_state_b.json")
P._dump(_stB, {"campaign_meta": {}})
ctxB = Ctx(RUN, {"activity_id": "B7"})
cmB = P.apply_meta_defaults(ctxB, _stB)
check("数据里也没渠道 → campaign_type 默认「活动」", cmB["campaign_type"] == "活动", str(cmB))
check("campaign_name 数据里也没有 → 兜底 activity_id 且要警告(356352 标题那课)",
      cmB["campaign_name"] == "B7" and any("活动 ID" in w for w in ctxB.warns), str(ctxB.warns))
check("兜底结果落回 state 文件", (P._load(_stB)["campaign_meta"]["campaign_type"] == "活动"))

# 口径(2026-07-29 用户确认):target_products 是品类名,默认就取数据里的
# activity_product_name,用户也可以自己指定。所以"没显式给"是正常路径 ——
# 在这儿报警只会让每一单都顶着一条假警报,久了谁都不看 warnings 了。
# 该盯的是 prepare 之后回读到的值像不像品类名(见 check_inferred_products)。
ctx9 = Ctx(RUN, {"activity_id": "A1"})
P.build_prepare_meta(ctx9)
check("没显式给就走默认,只记来源不报警", ctx9.meta_guessed is True and not ctx9.warns,
      str(ctx9.warns))
_st9 = os.path.join(RUN, "tp_state.json")
P._dump(_st9, {"campaign_meta": {"target_products": ["特价机票业务总览"]}})
_got9 = P.check_inferred_products(ctx9, _st9)   # 先跑,再断言 —— 警告是它发的
check("回读到像页面名的值,这才该吵一声",
      _got9 == ["特价机票业务总览"] and any("页面名" in w for w in ctx9.warns),
      str(ctx9.warns))

ctx9b = Ctx(RUN, {"activity_id": "A1",
                  "meta": {"campaign_name": "特价机票 7 月", "target_products": ["机票"]}})
d = json.loads(P.build_prepare_meta(ctx9b))
check("入参给了 dict 就照用", d["target_products"] == ["机票"], str(d))
check("入参给了就不再警告", ctx9b.meta_guessed is False)
check("入参的 campaign_name 优先", d["campaign_name"] == "特价机票 7 月")

ctx9c = Ctx(RUN, {"activity_id": "A1",
                  "meta": '{"target_products": ["酒店"], "campaign_type": "弹屏"}'})
d = json.loads(P.build_prepare_meta(ctx9c))
check("meta 是 JSON 字符串也认(SKILL.md 说两种都收)",
      d["target_products"] == ["酒店"] and d["campaign_type"] == "弹屏", str(d))

ctx9d = Ctx(RUN, {"activity_id": "A1", "meta": "{这不是 JSON"})
P.build_prepare_meta(ctx9d)
check("meta 不是合法 JSON 就告警后忽略,不许整单崩",
      any("不是合法 JSON" in w for w in ctx9d.warns), str(ctx9d.warns))

old_tp = P.TARGET_PRODUCTS
P.TARGET_PRODUCTS = "机票, 酒店/度假"
ctx9e = Ctx(RUN, {"activity_id": "A1"})
d = json.loads(P.build_prepare_meta(ctx9e))
check("环境变量给了也算数(运维不改代码就能纠正)",
      d["target_products"] == ["机票", "酒店", "度假"], str(d))
check("环境变量给了就不再警告", ctx9e.meta_guessed is False)
P.TARGET_PRODUCTS = old_tp

ctx9f = Ctx(RUN, {"activity_id": "A1", "campaign_type": "弹屏活动"})
check("入参 campaign_type 会带进去",
      json.loads(P.build_prepare_meta(ctx9f))["campaign_type"] == "弹屏活动")


# ------------------------------------------------------- 11) 装配层的哨兵
print("\n=== 11) 哨兵:这些接线断了,上面的测试也照样绿 ===")
_src = io.open(os.path.join(os.path.dirname(os.path.abspath(P.__file__)),
                            "ma_pipeline.py"), encoding="utf-8").read()

check("RENDER_FORCE_FLAGS 里绝不能有 --allow-channel-lint",
      "--allow-channel-lint" not in str(P.RENDER_FORCE_FLAGS),
      str([f[0] for f in P.RENDER_FORCE_FLAGS]))
# 它在源码里只该出现在注释和告警文案里(说明「我们没用它」),
# 绝不该以一个独立 argv 词元的形式出现 —— 那才是真的加到命令行上了
_argv_tokens = [ln for ln in _src.splitlines()
                if '"--allow-channel-lint"' in ln or "'--allow-channel-lint'" in ln]
check("--allow-channel-lint 从未作为 argv 词元出现", not _argv_tokens, str(_argv_tokens))
# 「说明没用它」的说法有好几种(注释、告警文案、给 Agent 的硬约束),
# 这里认的是否定词本身,而不是某一句固定的话 —— 否则每加一句合法的说明就挂一次。
_NEG = ("不得用", "不使用", "未使用", "不得使用", "不要用", "不能用", "禁止", "不许")
check("提到它的地方都只是在说明「没用它」",
      all(any(w in ln for w in _NEG)
          for ln in _src.splitlines() if "--allow-channel-lint" in ln),
      str([ln.strip()[:40] for ln in _src.splitlines()
           if "--allow-channel-lint" in ln and not any(w in ln for w in _NEG)]))
check("run_pipeline 真的把质检接进去了",
      'ctx.step("self_critique"' in _src)
check("质检排在 render 之前(SKILL.md 的第 8 步)",
      _src.index('ctx.step("self_critique"') < _src.index('steps.render(ctx, src, sf'))
check("render 之前会问一句 skill status",
      "steps.status(ctx, sf)" in _src)
check("render 接上了渠道改写回调", "on_rewrite=on_rewrite" in _src)
check("prepare 用的是拼好的 meta 字符串", "build_prepare_meta(ctx)" in _src)
check("notes 里会说质检结论", "self_critique 质检" in _src)
check("notes 里会说渠道改写过几次", "渠道词汇门禁触发过" in _src)
check("notes 里会交代品类是显式给的还是默认取的",
      "target_products 走默认" in _src and "由入参显式给出" in _src)
check("prepare 之后真的回读了一次实际取到的品类",
      "check_inferred_products(ctx, sp)" in _src)
check("出参 backend 带上质检结论", '"self_critique": getattr(ctx, "critique", None)' in _src)
check("出参 backend 带上渠道改写次数", '"channel_rewrites"' in _src)
# fix6c 的三处接线:少一处,上面 9)/9b)/9c) 那些直接调函数的测试照样绿,
# 可真跑起来 schema 体检又会被渠道门禁整段挡住(或者反过来把 lint 当成 schema 错误)
check("parse_schema_errors 走的是分段截取,不是整段 parse",
      "for ln in schema_error_lines(text):" in _src)
check("validate 撞上渠道门禁返回 ChannelGate", "return ChannelGate(tail)" in _src)
check("schema_repair 认得出 ChannelGate 并先清渠道词",
      "if isinstance(errs, ChannelGate):" in _src
      and "channel_repair_state(ctx, state, errs.tail" in _src)
check("渠道那一轮排在 rnd += 1 前面(所以不吃重写预算)",
      _src.index("if isinstance(errs, ChannelGate):") < _src.index("\n        rnd += 1"))
check("收尾复检挡住了 ChannelGate(否则 len() 当场崩)",
      "if isinstance(left, ChannelGate):" in _src)
check("润色链路真的把 validate 传给了 schema_repair",
      "schema_repair(ctx, state, validate" in _src)
check("run-tools 的参数按 cli.py 的 argparse 来",
      '"run-tools", "--state"' in _src and '"--tools", "self_critique"' in _src
      and '"--critique-round"' in _src)


print("\n=== 汇总:{} 过 / {} 挂 ===".format(len(OK), len(BAD)))
for b in BAD:
    print("  挂: {}".format(b))
sys.exit(1 if BAD else 0)
