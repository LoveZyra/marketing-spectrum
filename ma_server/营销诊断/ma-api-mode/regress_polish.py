# -*- coding: utf-8 -*-
"""润色回归:模型把文案写出来了,我们这边要接得住。

2026-07-29 real_c_001 那一单:CLI exit=0、跑了 138.94s、stdout 开头就是
```json\n{"fills": {"findings[0].detail": "2,403名用户创单后未支付…"
—— 文案写得挺好,但 extract_json 返回 None,49 个空槽一个没填,
报告整篇 [待润色],最后被 skill 的 completeness 门禁拦下,只能 --skip-completeness 硬产。

这里把模型可能吐出来的各种"不那么标准"的 JSON 都试一遍,
再加一层:整段解析不了时按 path 逐条抠,已经写完的条目不该跟着废掉。

用法:python3 regress_polish.py
"""
import io
import json
import os
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


# ------------------------------------------------------------------ 1) extract_json
print("\n=== 1) extract_json 认得出模型的各种写法 ===")
SLOTS = ["findings[0].detail", "narratives.problems[0].title", "narratives.headline"]
V1 = "2,403名用户创单后未支付,成单率0%,是当前最大转化漏损点。"
V2 = "跨渠道高频触达反而压低了成单率"
V3 = "促付缺口2403单,是本次最值得先动的一块"

BODY = json.dumps({"fills": {SLOTS[0]: V1, SLOTS[1]: V2, SLOTS[2]: V3}},
                  ensure_ascii=False, indent=2)

CASES = [
    ("裸 JSON", BODY, 3),
    ("套 ```json 代码块", "好的,已按要求生成:\n```json\n" + BODY + "\n```\n", 3),
    ("套 ``` 无语言标记", "```\n" + BODY + "\n```", 3),
    ("前面先把格式示范了一遍",
     '我会输出 {"fills": {"<path>": "<文案>"}} 这样的结构。\n```json\n' + BODY + "\n```", 3),
    ("文案里带花括号",
     json.dumps({"fills": {SLOTS[0]: "占位符写作 {mapid},共 2,403 人"}},
                ensure_ascii=False), 1),
    ("尾逗号", BODY.replace('"\n  }', '",\n  }', 1), 3),
    ("末尾被截断", '{"fills": {\n "%s": "%s",\n "%s": "%s",\n "%s": "促付缺口'
     % (SLOTS[0], V1, SLOTS[1], V2, SLOTS[2]), 2),
    ("没套 fills 直接给 path 表",
     json.dumps({SLOTS[0]: V1, SLOTS[1]: V2, SLOTS[2]: V3}, ensure_ascii=False), 3),
    ("字符串里有裸换行",
     '{"fills": {"%s": "第一句\n第二句"}}' % SLOTS[0], 1),
]
for label, text, want in CASES:
    got = P.fills_from_output(text, SLOTS)
    check(label, len(got) == want, "拿到 {} 条,期望 {} 条".format(len(got), want))

check("垃圾输入不炸", P.fills_from_output("模型今天不想干活", SLOTS) == {})
check("空输入不炸", P.fills_from_output("", SLOTS) == {})
check("只认问过的 path",
      P.fills_from_output(json.dumps({"fills": {"我编的.key": "x", SLOTS[0]: V1}},
                                     ensure_ascii=False), SLOTS) == {SLOTS[0]: V1})

# ------------------------------------------------------------------ 2) 骨架句识别
print("\n=== 2) skill 自带的骨架填充句也得进空槽 ===")
DRAFTS = [
    "[待润色]",
    "补充现象+数据叙述",
    "补充业务影响",
    "补充业务根因与建议方向",
    "指标现状→目标",
    "论断式标题",
    "(基于上面的数据补一句影响)",
    "（基于人群规模补充业务影响）",
]
for d in DRAFTS:
    check("认得出草稿句: " + d[:16], P._is_draft_text(d))

KEEP = [
    "2,403名用户创单后未支付,成单率0%,是当前最大转化漏损点,需立即促付挽回。",
    "建议对高潜人群补充一轮定向触达,预计可提升成单率 1.2pp。",
    "跨渠道高频疲劳人群成单率 2.12%,低于对照组 4.02%。",
    # 2026-07-29 job_...105131:这三条是上一版真踩过的坑。"填写"在营销漏斗里是名词
    # (填写页),被当成祈使词后凭空多了 2 个空槽,模型改好的文案又被同一道判断退件。
    "填写页营销打断",
    "填写页3分钟内营销触达仅0.14%触发但转化率高达13.04%",
    "填写页后3分钟内触达用户CVR 13.04%远超未触达2.12%,属高意向用户",
    # 以"补充"开头但带了数字/句读 —— 是写完的成品,不是骨架标签
    "补充一轮定向触达,预计提升 1.2pp。",
]
for k in KEEP:
    check("不误伤正常文案: " + k[:14], not P._is_draft_text(k))

print("\n--- 统计块里的维度标签不许当草稿 ---")
# 这棵树照着 job_20260729_105131 的 state_draft 摆:上一版把左边这几个
# 维度标签当成「填写…」祈使句发给模型,回写成整句话,报告的分组维度就废了。
TREE = {
    "agent_structured_stats": {
        "funnel_diagnosis": [{"depth_label": "填写页", "stage": "填写页",
                              "regression_type": "填写→详情 (中断)"}],
        "path_quality": [{"pre_last_mainflow_detail": "填写页",
                          "note": "补充业务影响"}],
    },
    "data_overview": {"diagnostic_rules_summary": [
        {"name": "填写页营销打断", "display_name": "填写页营销打断"}]},
    "narratives": {"problems": [{"impact": "补充业务影响", "title": P.PLACEHOLDER}]},
    "findings": [{"detail": "[待润色]"}],
}
slots = P.collect_placeholders(TREE)
check("统计块的维度标签一个都不进空槽",
      not any(s.startswith("agent_structured_stats") for s in slots), str(slots))
check("规则目录的业务名词不进空槽",
      not any(s.startswith("data_overview") for s in slots), str(slots))
check("正文里的骨架句照收", "narratives.problems[0].impact" in slots, str(slots))
check("正文里的 [待润色] 照收",
      "narratives.problems[0].title" in slots and "findings[0].detail" in slots, str(slots))
check("正文空槽不多不少", len(slots) == 3, str(slots))

# 显式占位符跑到统计块里也得认 —— 那是 skill 自己落的记号,没有歧义
check("显式占位符在哪棵树上都算草稿",
      P.collect_placeholders({"agent_structured_stats": {"x": ["[待润色]"]}})
      == ["agent_structured_stats.x[0]"])

# ------------------------------------------------------------------ 3) polish_state 全链路
print("\n=== 3) polish_state:模型写对了就必须填进去 ===")
RUN = "/tmp/regress_polish"
os.makedirs(RUN, exist_ok=True)


class Ctx(object):
    def __init__(self, run):
        self.run = run
        self.logs = []
        self.warns = []

    def path(self, name):
        return os.path.join(self.run, name)

    def log(self, m):
        self.logs.append(m)

    def warn(self, m):
        self.warns.append(m)
        self.logs.append("WARN " + m)


def make_draft():
    return {
        "_stage": "draft",
        "_draft": True,
        "campaign_meta": {"activity_id": "REGRESS", "date": "2026-07-29"},
        "data_overview": {"total": 100000},
        "audience_segments": [{"name": "创单未付待促付人群", "direction": "push",
                               "finding_id": "fnd_r41", "expected_cvr_mid": 0.031}],
        "narratives": {
            "headline": P.PLACEHOLDER,
            "problems": [{"_draft": True, "title": P.PLACEHOLDER,
                          "narrative": "补充现象+数据叙述",
                          "impact": "补充业务影响",
                          "root_cause": "补充业务根因与建议方向"}],
        },
        "action_plan": {"priority_actions": [
            {"title": P.PLACEHOLDER, "description": P.PLACEHOLDER,
             "expected_impact": "（基于人群规模补充预期）"}]},
    }


draft_path = os.path.join(RUN, "state_draft.json")
P._dump(draft_path, make_draft())
probe = P.collect_placeholders(P._load(draft_path))
check("骨架句被收进空槽(不只是 [待润色])", len(probe) == 8,
      "收到 {} 处: {}".format(len(probe), probe))

STDOUTS = {}


def cli_good(prompt, timeout):
    slots = [ln.split('"path": "')[1].split('"')[0]
             for ln in prompt.splitlines() if '"path": "' in ln]
    def _one(i, p):
        # 短版。多数字段够用,但 narratives.headline 有 30 字下限,顶不上 ——
        # 真实模型也会犯这个错(job_20260729_114613 就写了 26 字,render 直接 exit=2)。
        # 这里模拟"看得懂 rule、写够字数"的模型;写不够的那种在下面第 5 节单独试。
        s = "第{}条:2,403名用户创单后未支付,建议立即促付挽回。".format(i + 1)
        need = P.min_len_for(p)
        if need and len(s) < need:
            s = ("第{}条:2,403名用户创单后未支付、成单率为0%,"
                 "建议本周内启动定向促付挽回动作。".format(i + 1))
        return s

    body = {"fills": {p: _one(i, p) for i, p in enumerate(slots)}}
    out = "好的,已生成:\n```json\n" + json.dumps(body, ensure_ascii=False, indent=1) + "\n```"
    STDOUTS[len(STDOUTS)] = out
    return {"exit_code": 0, "elapsed_sec": 1.0, "stdout": out, "timed_out": False}


ctx = Ctx(RUN)
full_path, info = P.polish_state(ctx, draft_path, cli_good, ma_core.extract_json)
state = P._load(full_path)
left = P.collect_placeholders(state)
check("空槽全填上了", info.get("filled") == len(probe),
      "filled={} slots={}".format(info.get("filled"), info.get("slots")))
check("state 里已经没有草稿句", not left, "还剩 {}".format(left))
check("没被判降级", not info.get("degraded"), str(info.get("reason")))
check("_stage 置 full", state.get("_stage") == "full")
check("嵌套 _draft 清干净", "_draft" not in state.get("narratives", {}).get("problems", [{}])[0])
check("落盘了完整 stdout", any(f.startswith("polish_stdout") for f in os.listdir(RUN)),
      str([f for f in os.listdir(RUN)])[:120])


# 第一轮整段解析不了 → 应该退到分批重试,而不是整单降级
print("\n--- 第一轮返回废话,第二轮正常 ---")
STATE2 = {"n": 0}


def cli_flaky(prompt, timeout):
    STATE2["n"] += 1
    if STATE2["n"] == 1:
        return {"exit_code": 0, "elapsed_sec": 1.0,
                "stdout": "我需要更多上下文才能写。", "timed_out": False}
    return cli_good(prompt, timeout)


P._dump(draft_path, make_draft())
ctx2 = Ctx(RUN)
full2, info2 = P.polish_state(ctx2, draft_path, cli_flaky, ma_core.extract_json)
check("第一轮失手后靠分批救回来", info2.get("filled") == len(probe),
      "filled={} rounds={}".format(info2.get("filled"), info2.get("rounds")))
check("重试次数记进了出参", (info2.get("calls") or 0) >= 2, str(info2.get("calls")))

# 模型彻底不合作 → 优雅降级,不能抛
print("\n--- 模型彻底不合作 ---")


def cli_dead(prompt, timeout):
    return {"exit_code": 1, "elapsed_sec": 0.0, "stdout": "", "timed_out": False}


P._dump(draft_path, make_draft())
ctx3 = Ctx(RUN)
full3, info3 = P.polish_state(ctx3, draft_path, cli_dead, ma_core.extract_json)
check("彻底失败时优雅降级", info3.get("degraded") and info3.get("filled") == 0,
      str(info3.get("reason")))
check("降级时仍然产出 state_full", os.path.exists(full3))

# ------------------------------------------------------------------ 4) 标签里的千分位
print("\n=== 4) 标签里的千分位逗号不能把短标签切成半截 ===")
# real_c_001 的报告里,「核心问题 → 对应行动」那一列实际渲染出来是:
#   控制49 / 挽回2 / 纠正19 / 倾斜资源给3
# 四格全废。state 里原文是完整的,是渲染器按标点切短标签时,
# 千分位那个半角逗号排在冒号前面,一刀切在了数字中间。
import re as _re

# 渲染器切短标签的口径(照着现象反推:半角逗号排在全角冒号前面就被切中)
_chip = lambda s: _re.split(r"[,\uff0c:\uff1a;\uff1b]", s)[0]

REAL_TITLES = [
    ("挽回2,403名创单未付用户\uff1a推送支付提醒及限时优惠", "2403"),
    ("控制49,477人触达频次\uff1a建立全局频次上限机制", "49477"),
    ("纠正19,891人品类错配\uff1a按浏览行为匹配推送品类", "19891"),
    ("倾斜资源给3,152名高潜用户\uff1a深度2+重点运营", "3152"),
]
for raw, num in REAL_TITLES:
    tree = {"action_plan": {"priority_actions": [{"title": raw}]}}
    fixed = P.strip_label_thousands(tree)
    neu = tree["action_plan"]["priority_actions"][0]["title"]
    check("标签去千分位: " + raw[:8], num in neu and "," not in neu, neu)
    check("切出来的短标签带完整数字: " + _chip(neu), num in _chip(neu), _chip(neu))
    check("改动有留痕: " + raw[:6],
          len(fixed) == 1 and fixed[0][0] == "action_plan.priority_actions[0].title",
          str(fixed))
    # 修之前是什么样,钉住:这就是用户截图里那一列
    check("修之前确实被切成半截: " + _chip(raw), num not in _chip(raw), _chip(raw))

print("\n--- 只动标签、只动数字中间的逗号 ---")
TREE4 = {
    "action_plan": {"priority_actions": [
        {"title": "控制49,477人触达频次\uff1a建立全局频次上限机制",
         "description": "对49,477名触达过度用户设置全局频次上限,每日不超过2次"}]},
    "findings": [{"detail": "2,403名用户创单后未支付,成单率0%"}],
    "audience_segments": [{"name": "深度2,3,4 高潜人群"}],
    "narratives": {"headline": "本次最该动的是那49,477人的频次"},
    "data_overview": {"diagnostic_rules_summary": [{"name": "填写页营销打断"}]},
}
paths = [p for p, _, _ in P.strip_label_thousands(TREE4)]
pa = TREE4["action_plan"]["priority_actions"][0]
check("正文 description 保留千分位", "49,477" in pa["description"], pa["description"][:20])
check("正文 detail 保留千分位", "2,403" in TREE4["findings"][0]["detail"])
check("headline 也归标签,一起去掉",
      "49477" in TREE4["narratives"]["headline"], TREE4["narratives"]["headline"])
check("「深度2,3,4」不是千分位,别乱动",
      TREE4["audience_segments"][0]["name"] == "深度2,3,4 高潜人群",
      TREE4["audience_segments"][0]["name"])
check("没有数字的标签一个不碰",
      TREE4["data_overview"]["diagnostic_rules_summary"][0]["name"] == "填写页营销打断")
check("改动清单只列真改了的",
      sorted(paths) == ["action_plan.priority_actions[0].title", "narratives.headline"],
      str(paths))
check("全角逗号当千分位也要去掉",
      P.strip_label_thousands({"title": "控制49\uff0c477人"}) and True)

print("\n--- polish_state 落盘时要顺手修掉 ---")
D4 = os.path.join(RUN, "state_draft4.json")
P._dump(D4, {"_stage": "draft", "campaign_meta": {"activity_id": "REGRESS"},
             "action_plan": {"priority_actions": [
                 {"title": "控制49,477人触达频次\uff1a建立全局频次上限机制",
                  "description": "对49,477名用户设置频次上限"}]}})
ctx4 = Ctx(RUN)
full4, info4 = P.polish_state(ctx4, D4, cli_good, ma_core.extract_json)
t4 = P._load(full4)["action_plan"]["priority_actions"][0]["title"]
check("state_full 里的标题已经不带千分位", "49477" in t4 and "," not in t4, t4)
check("修了几处记进出参", info4.get("label_thousands_fixed"), str(info4.get("label_thousands_fixed")))
check("没有空槽时也要修(走的是提前返回那条路)", True)

# ------------------------------------------------------------------ 5) 字数下限
print("\n=== 5) skill 的字数下限:写太短跟没写一样,都要重写 ===")

# job_20260729_114613 的真实 headline,26 字,render 报
#   · headline 长度 26 字 < 30 字 → aborted due to schema errors → exit=2
REAL_SHORT = "2403人创单未付，立即启动促付挽回是最高优先级行动"
check("真实翻车的那句确实不足 30 字", len(REAL_SHORT) == 26, str(len(REAL_SHORT)))
check("short_fields 抓得到",
      P.short_fields({"narratives": {"headline": REAL_SHORT}}) == ["narratives.headline"])
check("没有下限要求的字段不受牵连",
      P.short_fields({"narratives": {"problems": [{"title": "太短"}]}}) == [])
check("写够了就不该再报",
      P.short_fields({"narratives": {"headline": "x" * 30}}) == [])
check("空串归空槽管,不在这儿重复报",
      P.short_fields({"narratives": {"headline": "   "}}) == [])
check("下限会拼进提示词的 rule 里", "30" in P.rule_for("narratives.headline"),
      P.rule_for("narratives.headline")[-30:])
check("_str_at 取得回原文", P._str_at({"narratives": {"headline": REAL_SHORT}},
                                  "narratives.headline") == REAL_SHORT)

print("\n--- 模型写太短时,润色循环要把它当成待补项再问一遍 ---")


def cli_stubborn(prompt, timeout):
    """怎么问都只写 26 字的模型 —— 测的是我们认不认得出、记不记账。"""
    slots = [ln.split('"path": "')[1].split('"')[0]
             for ln in prompt.splitlines() if '"path": "' in ln]
    body = {"fills": {p: REAL_SHORT for p in slots}}
    return {"exit_code": 0, "elapsed_sec": 1.0, "timed_out": False,
            "stdout": json.dumps(body, ensure_ascii=False)}


D5 = os.path.join(RUN, "state_draft5.json")
P._dump(D5, {"_stage": "draft", "campaign_meta": {"activity_id": "REGRESS"},
             "narratives": {"headline": REAL_SHORT}})
ctx5 = Ctx(RUN)
full5, info5 = P.polish_state(ctx5, D5, cli_stubborn, ma_core.extract_json)
check("没有空槽,但写太短也要进待补清单", info5["slots"] == 1, str(info5["slots"]))
check("问过模型(不是直接放行)", info5["calls"] >= 1, str(info5["calls"]))
check("仍然太短要在出参里点名", info5.get("too_short"), str(info5.get("too_short")))
check("点名要带字数,方便一眼看出差多少",
      info5.get("too_short") and "26" in info5["too_short"][0] and "30" in info5["too_short"][0],
      str(info5.get("too_short")))
check("日志里要有警告", any("最小字数" in w for w in ctx5.warns), str(ctx5.warns[-1:]))
check("这种情况算降级", info5["degraded"] is True, info5.get("reason"))

D6 = os.path.join(RUN, "state_draft6.json")
P._dump(D6, {"_stage": "draft", "campaign_meta": {"activity_id": "REGRESS"},
             "narratives": {"headline": "[待润色]"}})
ctx6 = Ctx(RUN)
full6, info6 = P.polish_state(ctx6, D6, cli_good, ma_core.extract_json)
h6 = P._load(full6)["narratives"]["headline"]
check("守规矩的模型能一次过", len(h6) >= 30 and not info6.get("too_short"), h6)
check("过了就不该报降级", info6["degraded"] is False, info6.get("reason"))

# ------------------------------------------------------------------ 6) render 门禁
print("\n=== 6) render 被门禁拦下要硬闯,不许掉回本地骨架页 ===")

SCHEMA_TAIL = ("[render] schema validate: 1 errors\n"
               "  \u00b7 headline \u957f\u5ea6 26 \u5b57 < 30 \u5b57\n"
               "[render] aborted due to schema errors (use --skip-validate to force)")
GATE_TAIL = "ERROR: INCOMPLETE_REPORT: 12 draft placeholders remain"


class GateCtx(Ctx):
    def __init__(self, run):
        Ctx.__init__(self, run)
        self.rundir = run
        self.render_forced = False
        self.skill_degraded = False


def fake_run(tails):
    """前 len(tails) 次按给定 stderr 尾巴失败,之后成功并写出 html。返回 (fn, 调用记录)。"""
    calls = []

    def _run(ctx, cmd, timeout=None, code="E_STEP_FAILED"):
        calls.append(list(cmd))
        i = len(calls) - 1
        if i < len(tails):
            raise P.StepError(code, "子命令失败 exit=2",
                              {"exit_code": 2, "tail": tails[i]})
        with open(os.path.join(ctx.rundir, "diagnosis_report.html"), "w",
                  encoding="utf-8") as fh:
            fh.write("<html>正版模板</html>")
        return {"exit_code": 0}
    return _run, calls


def run_render(tails):
    d = os.path.join(RUN, "gate")
    if not os.path.isdir(d):
        os.makedirs(d)
    html = os.path.join(d, "diagnosis_report.html")
    if os.path.exists(html):
        os.remove(html)
    sf = os.path.join(d, "state_full.json")
    P._dump(sf, {"_stage": "full", "campaign_meta": {"activity_id": "GATE"},
                 "narratives": {"headline": "x" * 40}})
    st = P.SkillSteps()
    st._help = ""                      # 跳过 _ensure 里的 cli.py 探测
    fn, calls = fake_run(tails)
    ctx = GateCtx(d)
    old = P.run_cmd
    P.run_cmd = fn
    try:
        st.render(ctx, None, sf)
    finally:
        P.run_cmd = old
    body = io.open(html, encoding="utf-8").read() if os.path.exists(html) else ""
    return ctx, calls, body


c1, calls1, body1 = run_render([SCHEMA_TAIL])
check("schema 门禁 → 补 --skip-validate 重试",
      len(calls1) == 2 and "--skip-validate" in calls1[1], str(calls1[-1][-3:]))
check("第一次调用不该自带开关", "--skip-validate" not in calls1[0], str(calls1[0][-3:]))
check("硬闯之后拿到的是正版模板,不是骨架页", "正版模板" in body1, body1[:40])
check("没有被判 skill 降级", c1.skill_degraded is False)
check("但要标记 render 是硬闯出来的", c1.render_forced is True)
check("告警里说清是哪道门禁", any("schema" in w for w in c1.warns), str(c1.warns))
check("告警里如实说明副作用",
      any("字数" in w or "格式硬规矩" in w for w in c1.warns), str(c1.warns))
check("真实报错落了盘",
      os.path.exists(os.path.join(RUN, "gate", "skill_error_render_gate_skip-validate.txt")))

c2, calls2, body2 = run_render([GATE_TAIL])
check("完备性门禁那条老路没被改坏",
      len(calls2) == 2 and "--skip-completeness" in calls2[1], str(calls2[-1][-3:]))

c3, calls3, body3 = run_render([SCHEMA_TAIL, GATE_TAIL])
check("两道门禁接连拦也要接得住(这是老代码做不到的)",
      len(calls3) == 3 and "--skip-validate" in calls3[2]
      and "--skip-completeness" in calls3[2], str(calls3[-1][-4:]))
check("接连拦下之后照样出正版模板", "正版模板" in body3, body3[:40])

# 认不出来的错就不该硬闯 —— 那是真出事了,该降级该报警
d7 = os.path.join(RUN, "gate7")
if not os.path.isdir(d7):
    os.makedirs(d7)
sf7 = os.path.join(d7, "state_full.json")
P._dump(sf7, {"_stage": "full", "narratives": {"headline": "x" * 40}})
st7 = P.SkillSteps()
st7._help = ""
fn7, calls7 = fake_run(["Traceback: MemoryError"] * 5)
ctx7 = GateCtx(d7)
_old = P.run_cmd
P.run_cmd = fn7
try:
    st7.render(ctx7, None, sf7)
finally:
    P.run_cmd = _old
check("认不出的报错只试一次,不乱加开关", len(calls7) == 1, str(len(calls7)))
check("认不出的报错要老实降级", ctx7.skill_degraded is True)
check("降级产出的是本地骨架页",
      os.path.exists(os.path.join(d7, "diagnosis_report.html")))


# ------------------------------------------------------------------ 7) schema 闭环
print("\n=== 7) 不硬编码 skill 的规矩,现问现学 ===")

# job_20260729_114613 的原始 stderr,一个字没改
REAL_TAIL = (
    "[render] loading /home/ubuntu/demo/ma-api-mode/jobs/job_x/run/state_full.json\n"
    "[render] schema validate: 1 errors\n"
    "  \u00b7 headline \u957f\u5ea6 26 \u5b57 < 30 \u5b57 "
    "(\u5f53\u524d: 2403\u4eba\u521b\u5355\u672a\u4ed8\uff0c"
    "\u7acb\u5373\u542f\u52a8\u4fc3\u4ed8\u633d\u56de\u662f\u6700\u9ad8\u4f18\u5148\u7ea7"
    "\u884c\u52a8)\n"
    "[render] aborted due to schema errors (use --skip-validate to force)")

errs = P.parse_schema_errors(REAL_TAIL)
check("真实报错解析出 1 条", len(errs) == 1, str(errs))
check("认出字段名", errs and errs[0]["field"] == "headline", str(errs[:1]))
check("认出下限 30", errs and errs[0]["need"] == 30, str(errs[:1]))
check("认出当前 26", errs and errs[0]["got"] == 26, str(errs[:1]))
check("认出是「短了」不是「长了」", errs and errs[0]["op"] == "<", str(errs[:1]))
check("翻成人话时带上「至少」和字数",
      "30" in P._need_text(errs[0]) and "至少" in P._need_text(errs[0]),
      P._need_text(errs[0]))
check("非 bullet 行不当报错收", all("loading" not in e["raw"] for e in errs), str(errs))

# 结构抠不出来的照样留着 —— skill 以后换措辞,原文丢给模型也比丢掉强
odd = P.parse_schema_errors("  · action_plan[2].owner 必须是运营/产品/技术之一")
check("抠不出数字的报错也保留原文", len(odd) == 1 and odd[0]["need"] is None, str(odd))
check("抠不出数字时至少认得出字段", odd and odd[0]["field"] == "action_plan[2].owner",
      str(odd))
check("这种报错原样转给模型",
      "运营" in P._need_text(odd[0]) and "原话" in P._need_text(odd[0]),
      P._need_text(odd[0]))
check("英文报错也认",
      P.parse_schema_errors("  * headline length 26 < 30")[0]["need"] == 30)
check("空文本不炸", P.parse_schema_errors("") == [])

ST7 = {"campaign_meta": {"activity_id": "REGRESS"},
       "narratives": {"headline": REAL_SHORT, "problems": [{"title": "标题A"}]},
       "action_plan": [{"detail": "先做A"}, {"detail": "再做B"}]}
check("叶子名 → 全路径", P.paths_for_field(ST7, "headline") == ["narratives.headline"],
      str(P.paths_for_field(ST7, "headline")))
check("给了全路径就直接用",
      P.paths_for_field(ST7, "narratives.headline") == ["narratives.headline"])
check("同名字段多处命中就都给",
      P.paths_for_field(ST7, "detail") == ["action_plan[0].detail", "action_plan[1].detail"],
      str(P.paths_for_field(ST7, "detail")))
check("定位不到就老实给空(交给 render 兜底)", P.paths_for_field(ST7, "nope") == [])
check("字段名为空不炸", P.paths_for_field(ST7, None) == [])

print("\n--- 体检 → 重写 → 复检 ---")


def fake_validate(script):
    """按 script 逐次返回;返回记录塞进 seen 方便断言调了几次。"""
    seen = []

    def _v(path):
        i = min(len(seen), len(script) - 1)
        seen.append(path)
        return script[i]
    return _v, seen


LONG = "2403名用户创单后未支付、成单率为0%,建议本周内启动定向促付挽回动作以补回缺口"
check("重写样例本身得够长", len(LONG) >= 30, str(len(LONG)))


def cli_repair(prompt, timeout):
    paths = [ln.split('"path": "')[1].split('"')[0]
             for ln in prompt.splitlines() if '"path": "' in ln]
    return {"exit_code": 0, "elapsed_sec": 1.0, "timed_out": False,
            "stdout": json.dumps({"fills": {p: LONG for p in paths}},
                                 ensure_ascii=False)}


def run_repair(script, cli=cli_repair, state=None):
    ctx = Ctx(RUN)
    st = state if state is not None else {
        "campaign_meta": {"activity_id": "REGRESS"},
        "narratives": {"headline": REAL_SHORT}}
    info = {"calls": 0}
    v, seen = fake_validate(script)
    P.schema_repair(ctx, st, v, cli, ma_core.extract_json, info)
    return ctx, st, info, seen


ERR1 = [{"raw": "headline 长度 26 字 < 30 字", "field": "headline",
         "op": "<", "need": 30, "got": 26}]

c7, s7, i7, seen7 = run_repair([ERR1, []])
check("报错了就去重写", s7["narratives"]["headline"] == LONG, s7["narratives"]["headline"])
check("重写完要复检", len(seen7) == 2, str(len(seen7)))
check("复检过了要记 schema_ok", i7.get("schema_ok") is True, str(i7))
check("改了哪几处要留痕", i7.get("schema_repaired") == ["narratives.headline"], str(i7))
check("原始报错也要留痕(出了事好查)", i7.get("schema_errors"), str(i7.get("schema_errors")))
check("重写要真去问模型", i7["calls"] == 1, str(i7["calls"]))
check("修好了就要把欠账抹掉", getattr(c7, "schema_unresolved", 0) == 0,
      str(getattr(c7, "schema_unresolved", None)))
check("提示词落了盘", os.path.exists(os.path.join(RUN, "repair_prompt_schema_r1.txt")))
check("模型原话也落了盘", os.path.exists(os.path.join(RUN, "repair_stdout_schema_r1.txt")))

c8, s8, i8, seen8 = run_repair([[]])
check("一次就过就不该惊动模型", i8["calls"] == 0, str(i8["calls"]))
check("一次就过只问一遍", len(seen8) == 1, str(len(seen8)))
check("一次就过也要记 schema_ok", i8.get("schema_ok") is True, str(i8))
check("一次就过不该有欠账", getattr(c8, "schema_unresolved", 0) == 0)

# 问不出来(validate 返回 None)—— 不猜、不改、不记通过
c9, s9, i9, seen9 = run_repair([None])
check("问不出来就不动手", s9["narratives"]["headline"] == REAL_SHORT)
check("问不出来不许记成通过", "schema_ok" not in i9, str(i9))
check("问不出来也不该去问模型", i9["calls"] == 0, str(i9["calls"]))
check("问不出来不许凭空记欠账", getattr(c9, "schema_unresolved", 0) == 0)

# 模型改了还是不过 —— 轮次用完要如实说没过
c10, s10, i10, seen10 = run_repair([ERR1, ERR1, ERR1, ERR1])
check("最多改 {} 轮".format(P.SCHEMA_ROUNDS), i10["calls"] == P.SCHEMA_ROUNDS,
      str(i10["calls"]))
check("没修好要如实记 schema_ok=False", i10.get("schema_ok") is False, str(i10))
check("没修好要出警告", any("仍有" in w for w in c10.warns), str(c10.warns))
check("没修好要把条数记到 ctx 上(notes 靠它说人话)",
      getattr(c10, "schema_unresolved", 0) == len(ERR1),
      str(getattr(c10, "schema_unresolved", None)))


def cli_deaf(prompt, timeout):
    return {"exit_code": 0, "elapsed_sec": 1.0, "timed_out": False, "stdout": "我改好了。"}


c11, s11, i11, seen11 = run_repair([ERR1, ERR1, ERR1], cli=cli_deaf)
check("模型一条都没落地就别耗轮次", i11["calls"] == 1, str(i11["calls"]))
check("一条没落地要出警告", any("没落地" in w for w in c11.warns), str(c11.warns))
check("提前收手也不许把欠账吞掉",
      getattr(c11, "schema_unresolved", 0) == len(ERR1),
      str(getattr(c11, "schema_unresolved", None)))

# 报错定位不到字段 —— 不该瞎改,也不该去问模型
c12, s12, i12, seen12 = run_repair(
    [[{"raw": "总分不够", "field": None, "op": None, "need": None, "got": None}]])
check("定位不到字段就不问模型", i12["calls"] == 0, str(i12["calls"]))
check("定位不到字段也要留下报错原文", i12.get("schema_errors") == ["总分不够"], str(i12))
check("定位不到字段更要记欠账(这条只能靠 render 强制开关)",
      getattr(c12, "schema_unresolved", 0) == 1,
      str(getattr(c12, "schema_unresolved", None)))

# 开关关掉
_old_check = P.SCHEMA_CHECK
P.SCHEMA_CHECK = False
c13, s13, i13, seen13 = run_repair([ERR1, []])
P.SCHEMA_CHECK = _old_check
check("MA_SCHEMA_CHECK=0 时整段跳过", len(seen13) == 0 and i13["calls"] == 0, str(i13))

# validate 自己炸了 —— 得兜住,不能把整条润色链带下水
def v_boom(path):
    raise RuntimeError("skill 不见了")


ctx14 = Ctx(RUN)
s14 = {"narratives": {"headline": REAL_SHORT}}
i14 = {"calls": 0}
P.schema_repair(ctx14, s14, v_boom, cli_repair, ma_core.extract_json, i14)
check("validate 炸了不许把润色带崩", s14["narratives"]["headline"] == REAL_SHORT)
check("validate 炸了要留一句警告", any("体检" in w for w in ctx14.warns), str(ctx14.warns))
check("validate 炸了不许记成通过", "schema_ok" not in i14, str(i14))

# polish_state 接得上:模型第一轮写太短,体检把它捞回来
print("\n--- polish_state 串起来 ---")
D7 = os.path.join(RUN, "state_draft7.json")
P._dump(D7, {"_stage": "draft", "campaign_meta": {"activity_id": "REGRESS"},
             "narratives": {"headline": REAL_SHORT}})
ctx15 = Ctx(RUN)
v15, seen15 = fake_validate([ERR1, []])
full15, info15 = P.polish_state(ctx15, D7, cli_repair, ma_core.extract_json, validate=v15)
check("polish_state 会带着 validate 走一遍", len(seen15) >= 1, str(len(seen15)))
check("串起来之后短句被换掉了",
      P._load(full15)["narratives"]["headline"] == LONG,
      P._load(full15)["narratives"]["headline"])
check("不传 validate 就跟以前一模一样(老调用方不受影响)",
      P.polish_state(Ctx(RUN), D7, cli_good, ma_core.extract_json)[1]["slots"] == 1)

print("\n--- 欠账要写进 notes(给人看的那份) ---")


_src_notes = io.open(os.path.join(os.path.dirname(os.path.abspath(P.__file__)),
                                  "ma_pipeline.py"), encoding="utf-8").read()
check("notes 里确实读的是 ctx.schema_unresolved",
      'getattr(ctx, "schema_unresolved", 0)' in _src_notes)
check("notes 那句话点名了去哪儿查明细",
      "polish.schema_errors" in _src_notes)
check("出参 backend 里带上体检结论", '"schema_ok": polish_info.get("schema_ok")' in _src_notes)
check("出参 backend 里带上强制开关明细", '"render_flags"' in _src_notes)

print("\n--- SkillSteps.validate 怎么问 skill ---")


def probe_validate(tails, help_text=""):
    d = os.path.join(RUN, "vd")
    if not os.path.isdir(d):
        os.makedirs(d)
    sf = os.path.join(d, "state.json")
    P._dump(sf, {"narratives": {"headline": REAL_SHORT}})
    st = P.SkillSteps()
    st._help = help_text
    fn, calls = fake_run(tails)
    ctx = GateCtx(d)
    old = P.run_cmd
    P.run_cmd = fn
    try:
        return st.validate(ctx, sf), calls
    finally:
        P.run_cmd = old


r1, k1 = probe_validate([REAL_TAIL])
check("schema 报错 → 返回清单", r1 and r1[0]["need"] == 30, str(r1))
check("没见过 validate 子命令就拿 render 空跑", "render" in k1[0], str(k1[0][:4]))
check("空跑要写去临时目录,别覆盖正式产物",
      "_schema_check" in " ".join(k1[0]), str(k1[0][-2:]))

r2, k2 = probe_validate([])
check("render 跑通 → 空清单(体检通过)", r2 == [], str(r2))

r3, k3 = probe_validate(["Traceback (most recent call last): MemoryError"])
check("看不懂的失败 → None,绝不当成通过", r3 is None, str(r3))

# 这条是最坏路径:子命令压根不存在,argparse 的报错里带 validate 这个词
r4, k4 = probe_validate(
    ["usage: cli.py ...\ncli.py: error: argument sub: invalid choice: 'validate'"])
check("「子命令不存在」不许被当成体检通过", r4 is None, str(r4))

r5, k5 = probe_validate(["ERROR: INCOMPLETE_REPORT: 12 draft placeholders remain",
                         REAL_TAIL])
check("完备性门禁挡在前面要补开关再问一次", len(k5) == 2, str(len(k5)))
check("补的是 --skip-completeness", "--skip-completeness" in k5[1], str(k5[1][-2:]))
check("绕过完备性之后问到了 schema", r5 and r5[0]["need"] == 30, str(r5))

r6, k6 = probe_validate(["ERROR: INCOMPLETE_REPORT: x", "ERROR: INCOMPLETE_REPORT: x"],)
check("两次都只有完备性 → 说明问不到 schema,返回 None", r6 is None, str(r6))

r7v, k7v = probe_validate([REAL_TAIL], help_text="usage: cli.py {prepare,render,validate}")
check("--help 里真有 validate 才用它", "validate" in k7v[0], str(k7v[0][:4]))


print("\n=== 汇总:{} 过 / {} 挂 ===".format(len(OK), len(BAD)))
for b in BAD:
    print("  挂: {}".format(b))
sys.exit(1 if BAD else 0)
