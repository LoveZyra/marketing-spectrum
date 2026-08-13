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

from ma_core import PUBLIC_RULE_KEYS, public_rules   # noqa: E402

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
check("六个字段的值逐个正确",
      [r["name"], r["finding_id"], r["sql_filter"], r["filter_zh"], r["direction"], r["suggestion"]]
      == [FULL["name"], FULL["finding_id"], FULL["sql_filter"], FULL["filter_zh"],
          FULL["direction"], FULL["suggestion"]])

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
check("老版 skill 的规则也能投影(向后兼容)",
      tuple(got.keys()) == PUBLIC_RULE_KEYS and got["filter_zh"] == "" and got["suggestion"] is None)

# 边界
check("spec 为空 → 空列表", public_rules({}) == [] and public_rules(None) == [])
check("rules 为 None → 空列表", public_rules({"rules": None}) == [])
check("非 dict 的条目直接跳过,不炸",
      public_rules({"rules": ["垃圾", None, FULL]}) == [r])

print()
print("=== 汇总:{} 过 / {} 挂 ===".format(_pass, _fail))
sys.exit(1 if _fail else 0)
