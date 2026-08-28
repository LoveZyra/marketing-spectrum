#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""/result 公开契约的离线回归（2026-08-12,随 fix19 新增）。

为什么单开一套:`/result` 的 rules 投影是**唯一**对外出口,加一个字段就是改接口契约,
而这段逻辑此前埋在 handler 里、没有任何用例守着 —— fix18.1 加 suggestion 时就是靠人眼盯的。

盯三件事:
  1) 六个字段,一个不多一个不少,顺序固定(调用方按顺序读 JSON 的不在少数);
  2) skill 侧的内部键(pandas_filter / _signal_type / suggestion_source / _seg_index …)
     **一个都不许漏出去**;
  3) filter_zh 缺失/为 None 时给空串,不给 null —— 中文口径是展示用的,
     调用方不该为了它写判空分支。
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from ma_core import (CROWD_OP_ALTER, CROWD_OP_CREATE,   # noqa: E402
                     PUBLIC_EXCLUDED_KEYS, PUBLIC_RULE_KEYS, SUGGEST_PREFIXES,
                     SUGGEST_PREFIX_EXCLUDE, SUGGEST_PREFIX_OPTIMIZE, SUGGEST_PREFIX_PUSH,
                     crowd_operation, public_excluded, public_rules, public_suggestion)

_pass = _fail = 0


def check(label, cond, extra=""):
    global _pass, _fail
    print("{}  {}{}".format("PASS" if cond else "FAIL", label, ("  " + str(extra)) if extra else ""))
    if cond:
        _pass += 1
    else:
        _fail += 1


FULL = {
    "source": "audience_segment",
    "name": "创单未付待促付人群",
    "finding_id": "fnd_r41",
    "direction": "push",
    "direction_raw": "促付",
    "direction_fixed": True,
    "direction_from_skill": "exclude",
    "pandas_filter": "(is_converted == 1) & (is_paid == 0)",
    "sql_filter": "(is_converted = 1) AND (is_paid = 0)",
    "filter_zh": "（已转化）且（未成单）",
    "estimated_size": 288,
    "baseline_cvr": 0.1974,
    "expected_cvr_mid": 0.31,
    "suggestion": "触发补付提醒（3小时内），提升支付完成率。",
    "suggestion_source": "index",
    "_seg_index": 3,
    "_signal_type": "causal",
    "crowd": "push",
}

out = public_rules({"rules": [FULL]})
check("投影出一条", len(out) == 1)
r = out[0]

check("字段名与顺序都固定为六个", tuple(r.keys()) == PUBLIC_RULE_KEYS, tuple(r.keys()))
check("六个字段的值逐个正确(direction 是人群包操作类型,不是原始 push/exclude)",
      [r["name"], r["finding_id"], r["sql_filter"], r["filter_zh"], r["direction"], r["suggestion"]]
      == [FULL["name"], FULL["finding_id"], FULL["sql_filter"], FULL["filter_zh"],
          CROWD_OP_ALTER, SUGGEST_PREFIX_OPTIMIZE + FULL["suggestion"]],
      "direction={} suggestion={}".format(r["direction"], r["suggestion"]))

LEAK = ("pandas_filter", "_signal_type", "suggestion_source", "_seg_index", "estimated_size",
        "baseline_cvr", "expected_cvr_mid", "direction_raw", "direction_fixed",
        "direction_from_skill", "source", "crowd")
for k in LEAK:
    check("内部键不外泄:{}".format(k), k not in r)

# filter_zh 的三种缺失形态都要收敛成空串
for label, seg in (("缺字段", {k: v for k, v in FULL.items() if k != "filter_zh"}),
                   ("值为 None", dict(FULL, filter_zh=None)),
                   ("值为空串", dict(FULL, filter_zh=""))):
    got = public_rules({"rules": [seg]})[0]
    check("filter_zh {} → 空串而非 null".format(label), got["filter_zh"] == "", repr(got["filter_zh"]))

# 老 skill(未升级)产出的 crowd_rules 里没有 filter_zh —— 接口不能因此挂掉
old_seg = {k: v for k, v in FULL.items() if k not in ("filter_zh", "suggestion")}
got = public_rules({"rules": [old_seg]})[0]
check("老版 skill 的规则也能投影(向后兼容;suggestion 缺失时只给前缀,不凭空编话术)",
      tuple(got.keys()) == PUBLIC_RULE_KEYS and got["filter_zh"] == ""
      and got["suggestion"] == SUGGEST_PREFIX_OPTIMIZE, repr(got["suggestion"]))

# 边界
check("spec 为空 → 空列表", public_rules({}) == [] and public_rules(None) == [])
check("rules 为 None → 空列表", public_rules({"rules": None}) == [])
check("非 dict 的条目直接跳过,不炸",
      public_rules({"rules": ["垃圾", None, FULL]}) == [r])

# ── excluded_rules 的公开契约(2026-08-14 新增顶层字段)────────────────────

EXC_FULL = {
    "name": "跨渠道高频疲劳人群",
    "finding_id": "fnd_r37",
    "direction": "exclude",
    "direction_raw": None,
    "filter_zh": "近1天营销渠道种数 >= 3 且 主流程行为次数 = 0",
    "sql_filter": "insite_channel_cnt >= 3 AND pre_mainflow_event_cnt = 0",  # ← 绝不能外泄
    "pandas_filter": "(insite_channel_cnt >= 3) & (pre_mainflow_event_cnt == 0)",
    "estimated_size": 49477,
    "suggestion": "暂缓推送,优先以红包等低成本方式激活",
    "suggestion_source": "index",
    "_seg_index": 5,
    "reason": "direction=exclude,按接口口径不参与推送",
}

eout = public_excluded({"excluded_rules": [EXC_FULL]})
check("excluded 投影出一条", len(eout) == 1)
e = eout[0]
check("excluded 字段名与顺序固定为八个", tuple(e.keys()) == PUBLIC_EXCLUDED_KEYS, tuple(e.keys()))
check("excluded 值逐个正确",
      [e["name"], e["finding_id"], e["filter_zh"], e["direction"],
       e["direction_raw"], e["estimated_size"], e["suggestion"], e["reason"]]
      == [EXC_FULL["name"], EXC_FULL["finding_id"], EXC_FULL["filter_zh"], EXC_FULL["direction"],
          EXC_FULL["direction_raw"], EXC_FULL["estimated_size"], EXC_FULL["suggestion"],
          EXC_FULL["reason"]])
check("★ 排除规则的 sql_filter 绝不外泄(7/28 事故红线)", "sql_filter" not in e)
for k in ("pandas_filter", "suggestion_source", "_seg_index", "sql_filter"):
    check("excluded 内部键不外泄:{}".format(k), k not in e)

# 促付:direction 归 exclude,但 direction_raw 必须留着,否则调用方分不出"不推"和"换方式推"
_cx = public_excluded({"excluded_rules": [dict(EXC_FULL, finding_id="fnd_r41",
                                               direction="exclude", direction_raw="促付")]})[0]
check("促付人群的 direction_raw 带出去了", _cx["direction_raw"] == "促付")

# filter_zh 缺失三形态 → 空串
for label, seg in (("缺字段", {k: v for k, v in EXC_FULL.items() if k != "filter_zh"}),
                   ("值为 None", dict(EXC_FULL, filter_zh=None)),
                   ("值为空串", dict(EXC_FULL, filter_zh=""))):
    g = public_excluded({"excluded_rules": [seg]})[0]
    check("excluded filter_zh {} → 空串而非 null".format(label), g["filter_zh"] == "")

check("excluded 边界:空/None/垃圾条目",
      public_excluded({}) == [] and public_excluded(None) == []
      and public_excluded({"excluded_rules": None}) == []
      and public_excluded({"excluded_rules": ["垃圾", None, EXC_FULL]}) == [e])

# rules[] 六字段契约不因新增而改变
check("rules[] 六字段契约未受影响", tuple(public_rules({"rules": [FULL]})[0].keys()) == PUBLIC_RULE_KEYS)


# ── fix22:direction = 人群包操作类型(create / alter)──────────────────────

OP_CASES = [
    ("模型产出 + push → create", "fnd_model_decision_rule", "push", CROWD_OP_CREATE),
    ("规则产出 + push → alter", "fnd_r41", "push", CROWD_OP_ALTER),
    ("正向信号 + push → alter", "fnd_pos_pre_target_product_funnel_depth", "push", CROWD_OP_ALTER),
    ("规则产出 + exclude → alter", "fnd_r37", "exclude", CROWD_OP_ALTER),
    ("模型产出 + exclude → alter(理论不该出现,保守落 alter)",
     "fnd_model_decision_rule", "exclude", CROWD_OP_ALTER),
    ("未来新前缀 + push → alter(认不出就不新建人群包,保守侧)", "fnd_新前缀", "push", CROWD_OP_ALTER),
    ("finding_id 缺失 → alter", None, "push", CROWD_OP_ALTER),
    ("direction 缺失 → alter", "fnd_model_x", None, CROWD_OP_ALTER),
]
for label, fid, d, want in OP_CASES:
    got = crowd_operation({"finding_id": fid, "direction": d})
    check("操作类型:{}".format(label), got == want, "got={}".format(got))

check("操作类型:非 dict 不炸", crowd_operation(None) == CROWD_OP_ALTER)
check("操作类型:大小写/空格不敏感",
      crowd_operation({"finding_id": "fnd_model_x", "direction": " PUSH "}) == CROWD_OP_CREATE)

# 出参里只出现这两个值,原始 push/exclude 不外泄
_mix = [{"name": "模型人群", "finding_id": "fnd_model_decision_rule", "direction": "push",
         "sql_filter": "a=1"},
        {"name": "规则人群", "finding_id": "fnd_r41", "direction": "push", "sql_filter": "b=1"},
        {"name": "排除人群", "finding_id": "fnd_r37", "direction": "exclude", "sql_filter": "c=1"}]
_proj = public_rules({"rules": _mix})
check("出参 direction 取值只有 create / alter",
      {x["direction"] for x in _proj} <= {CROWD_OP_CREATE, CROWD_OP_ALTER},
      str([x["direction"] for x in _proj]))
check("出参 direction 逐条正确",
      [x["direction"] for x in _proj] == [CROWD_OP_CREATE, CROWD_OP_ALTER, CROWD_OP_ALTER],
      str([x["direction"] for x in _proj]))
check("原始 push/exclude 不出现在出参里",
      not any(x["direction"] in ("push", "exclude") for x in _proj))

# ── fix23:suggestion 分档前缀 ────────────────────────────────────────────

PFX_CASES = [
    ("模型产出 + push → 建议推送", "fnd_model_decision_rule", "push", SUGGEST_PREFIX_PUSH),
    ("规则产出 + push → 建议优化", "fnd_r41", "push", SUGGEST_PREFIX_OPTIMIZE),
    ("正向信号 + push → 建议优化", "fnd_pos_x", "push", SUGGEST_PREFIX_OPTIMIZE),
    ("规则产出 + exclude → 建议排除", "fnd_r37", "exclude", SUGGEST_PREFIX_EXCLUDE),
    ("模型产出 + exclude → 建议排除", "fnd_model_x", "exclude", SUGGEST_PREFIX_EXCLUDE),
    ("未来新前缀 + push → 建议优化", "fnd_新前缀", "push", SUGGEST_PREFIX_OPTIMIZE),
]
for label, fid, d, want in PFX_CASES:
    got_s = public_suggestion({"finding_id": fid, "direction": d, "suggestion": "某句文案"})
    check("前缀:{}".format(label), got_s == want + "某句文案", got_s)

check("前缀:幂等 —— 已带同一前缀不叠加",
      public_suggestion({"finding_id": "fnd_r37", "direction": "exclude",
                         "suggestion": SUGGEST_PREFIX_EXCLUDE + "暂缓推送"})
      == SUGGEST_PREFIX_EXCLUDE + "暂缓推送")
check("前缀:幂等 —— 连续重复前缀也只留一个",
      public_suggestion({"finding_id": "fnd_r37", "direction": "exclude",
                         "suggestion": SUGGEST_PREFIX_EXCLUDE * 3 + "暂缓推送"})
      == SUGGEST_PREFIX_EXCLUDE + "暂缓推送")
check("前缀:自纠正 —— 上游带错前缀会被换成对的",
      public_suggestion({"finding_id": "fnd_r37", "direction": "exclude",
                         "suggestion": SUGGEST_PREFIX_PUSH + "暂缓推送"})
      == SUGGEST_PREFIX_EXCLUDE + "暂缓推送")
check("前缀:文案为空时只给前缀,不凭空编业务话术",
      public_suggestion({"finding_id": "fnd_model_x", "direction": "push",
                         "suggestion": ""}) == SUGGEST_PREFIX_PUSH)
check("前缀:非 dict 不炸", public_suggestion(None) is None)

# ★ 促付回归点:归一化后是 push,必须是【建议优化】而不是【建议排除】
check("★ 前缀:促付人群(direction_raw=促付,已救回 push)是建议优化",
      public_suggestion({"finding_id": "fnd_r41", "direction": "push",
                         "direction_raw": "促付", "suggestion": "促付提醒"})
      == SUGGEST_PREFIX_OPTIMIZE + "促付提醒")

# 出参里三档都能出现,且每条恰好一个前缀
_mix2 = [{"name": "模型人群", "finding_id": "fnd_model_decision_rule", "direction": "push",
          "sql_filter": "a=1", "suggestion": "优先投放"},
         {"name": "规则人群", "finding_id": "fnd_r41", "direction": "push",
          "sql_filter": "b=1", "suggestion": "推送支付提醒"},
         {"name": "排除人群", "finding_id": "fnd_r37", "direction": "exclude",
          "sql_filter": "c=1", "suggestion": "暂缓推送"}]
_p2 = public_rules({"rules": _mix2})
check("出参:三档前缀齐出",
      [s["suggestion"].split("】")[0] + "】" for s in _p2]
      == [SUGGEST_PREFIX_PUSH, SUGGEST_PREFIX_OPTIMIZE, SUGGEST_PREFIX_EXCLUDE],
      str([s["suggestion"] for s in _p2]))
check("出参:每条恰好一个前缀(不叠加)",
      all(sum(s["suggestion"].count(p) for p in SUGGEST_PREFIXES) == 1 for s in _p2))
check("出参:create 恒为建议推送(模型 seg 全是 push)",
      all(s["suggestion"].startswith(SUGGEST_PREFIX_PUSH)
          for s in _p2 if s["direction"] == CROWD_OP_CREATE))

print()
print("=== 汇总:{} 过 / {} 挂 ===".format(_pass, _fail))
sys.exit(1 if _fail else 0)
