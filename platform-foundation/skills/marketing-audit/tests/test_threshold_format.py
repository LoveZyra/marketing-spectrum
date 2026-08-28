#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""fix23：极小阈值渲染回归测试。

盯住两件事：
  1) 报告 / sql_filter 里**永远不出现** `0.0000000001` 这类无意义长串，也不出现科学计数法；
  2) 真实字段的阈值精度**一点不动**（3e-03 / 0.12345 / 2.5 …）。

关键断言是「选中的行不变」——把 `> 1e-10` 收成 `> 0` 不是取近似，
而是在最小可表示非零值 ≈ 3e-3 的列上**完全等价**。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from snippets.crowd_translator import _sci_to_plain, pandas_to_sql  # noqa: E402
from snippets.model_analyst import (  # noqa: E402
    _SENTINEL_EPS, _fmt_threshold, _fmt_threshold_exact, _merge_render_clauses,
)
from snippets.model_interpreter import _SENTINEL_EPS as _EPS2  # noqa: E402
from snippets.model_interpreter import _fmt_threshold as _fmt2  # noqa: E402

fails: list[str] = []


def check(label: str, cond: bool, extra: str = "") -> None:
    print(f"{'PASS' if cond else 'FAIL'}  {label}{('  ' + extra) if extra else ''}")
    if not cond:
        fails.append(label)


# ── 1. 用户实际报出来的串必须消失 ─────────────────────────────────────

for v in (1e-10, 5e-11, 1e-8, 1e-7, 9.9e-7):
    check(f"模型侧 {v!r} 不再产出长串", _fmt_threshold(v) == "0", _fmt_threshold(v))
    check(f"解释器侧 {v!r} 不再产出长串", _fmt2(v) == "0", _fmt2(v))

out = _sci_to_plain("pre_popup_click_rate > 1e-10")
check("SQL 侧 1e-10 不再写成 0.0000000001", "0.0000000001" not in out, out)

# ── 2. 全链路：任何输出都不得含科学计数法或 >6 位小数 ─────────────────

_LONG = re.compile(r"0\.0{6,}\d")
_SCI = re.compile(r"\d[eE][+-]?\d")

samples = [
    "pre_popup_click_rate > 1e-10",
    "serialid_bonus >= 5e-11 & pre_events_per_hour < 3e-08",
    "pre_push_click_rate > 1e-35",
    "activity_touch_cnt >= 4.0 & pre_popup_click_rate > 1e-10",
]
for s in samples:
    sql = pandas_to_sql(s)
    check(f"SQL 无长串：{s[:38]}", not _LONG.search(sql), sql)
    check(f"SQL 无科学计数法：{s[:38]}", not _SCI.search(sql), sql)

# ── 3. 真实精度一点不能动 ─────────────────────────────────────────────

KEEP = {
    2.5000000000000004: "2.5",       # 浮点噪声 → 收干净
    15.520000000000001: "15.52",
    0.5: "0.5",
    4.5: "4.5",
    0.0027: "0.0027",                # 促销占比 1/365 量级：真实值，必须原样
    0.01: "0.01",                    # 金额一分钱
    0.0417: "0.0417",                # 行为密度 1/24
    3.0: "3",
}
for v, want in KEEP.items():
    check(f"真实阈值不变 {v!r} → {want}", _fmt_threshold(v) == want, _fmt_threshold(v))
    check(f"真实阈值不变(解释器) {v!r} → {want}", _fmt2(v) == want, _fmt2(v))

check("手写规则精度不受影响 0.12345",
      "0.12345" in pandas_to_sql("serialid_bonus > 0.12345"),
      pandas_to_sql("serialid_bonus > 0.12345"))
check("min_trigger_rate 0.05 不受影响",
      "0.05" in pandas_to_sql("x > 0.05"), pandas_to_sql("x > 0.05"))

# ── 4. 核心：收成 > 0 之后，选中的行完全不变 ─────────────────────────

try:
    import numpy as np
    import pandas as pd

    rng = np.random.default_rng(20260812)
    n = 20000
    # 4 个 rate 字段的真实形态：大量 0 + 若干「分母为个位/百位」的比值
    df = pd.DataFrame({
        "pre_popup_click_rate": rng.choice([0.0, 0.5, 0.25, 0.1, 1.0], n, p=[.7, .1, .1, .05, .05]),
        "serialid_bonus": rng.choice([0.0, 1 / 365, 0.05, 0.2], n, p=[.6, .2, .1, .1]),
        "pre_events_per_hour": rng.choice([0.0, 1 / 24, 2.5, 11.0], n, p=[.5, .2, .2, .1]),
    })
    same_all = True
    for col in df.columns:
        for eps in (1e-10, 5e-11, 1e-8, 9.9e-7, 3e-05, 9.9e-05):
            a = (df[col] > eps).sum()
            b = (df[col] > 0).sum()
            if a != b:
                same_all = False
                print(f"      差异: {col} eps={eps} {a} vs {b}")
    check("等价性：`> 极小值` 与 `> 0` 在 rate 字段上选中同一批行(含 3e-05/9.9e-05)",
          same_all)

    # 2026-08-17:门槛由 1e-6 提到 1e-4(为了守住"最多 4 位小数"),余量随之从
    # 2700 倍降到 27 倍 —— 仍然是"真实取值够不着"的量级,但这条断言要如实反映余量。
    minpos = min(float(df[c][df[c] > 0].min()) for c in df.columns)
    check("等价性前提：最小可表示非零值(1/365)至少 20 倍于门槛",
          minpos > _SENTINEL_EPS * 20,
          f"min={minpos:.6g}  eps={_SENTINEL_EPS:g}  余量={minpos / _SENTINEL_EPS:.0f}x")
except ImportError:
    print("SKIP  等价性用例（无 pandas/numpy）")

# ── 4b. 树内部零哨兵:2026-08-17 线上又出长串 ─────────────────────────
#
# 线上出现:近1年客单价 > -0.00000000000000000000000000000000000010000000180025095
# 尾数 1.0000000180025095 不是浮点噪声,是 float32(1e-35) 提升成 double 的唯一值,
# 也就是 LightGBM 的 kZeroThreshold(1e-35f)—— 树内部的零边界常量,不是业务阈值。
# fix23 只给 display 的 _fmt_threshold 加了哨兵归零,执行形态按"逐位保真"原样展开,
# 于是三十几个零进了 sql_filter,也进了报告的中文条件。
#
# 口径:在 _merge_render_clauses 里把数值和**算符**一起归零 —— 光抹数值会把取值
# 恰好为 0 的人排除掉(而这个切分点存在的目的恰恰就是把 0 和正值分开),那是改变
# 人群,叶子 oracle 会把整条规则剔掉。四种改写都是恒等的,红线就是"圈到的人不变"。

import numpy as _np  # noqa: E402

_LGB_ZERO = float(_np.float32(1e-35))          # LightGBM kZeroThreshold 的真身
check("线上那个尾数确实是 float32(1e-35)(不是随机浮点噪声)",
      repr(_LGB_ZERO).startswith("1.0000000180025095e-35"), repr(_LGB_ZERO))


def _render_one(bound, side):
    steps = [("num", "gmv", bound if side == "lo" else None,
              None if side == "lo" else bound, False)]
    return _merge_render_clauses(steps, {}, drop_null=True)


# 四种恒等改写:数值一律写 0,算符按哨兵符号定
_EXPECT = [
    ("lo", (-_LGB_ZERO, False), "gmv >= 0"),   # > 负哨兵  ≡ >= 0
    ("lo", (-_LGB_ZERO, True),  "gmv >= 0"),   # >= 负哨兵 ≡ >= 0
    ("lo", (_LGB_ZERO,  False), "gmv > 0"),    # > 正哨兵  ≡ > 0
    ("lo", (_LGB_ZERO,  True),  "gmv > 0"),    # >= 正哨兵 ≡ > 0
    ("hi", (_LGB_ZERO,  True),  "gmv <= 0"),   # <= 正哨兵 ≡ <= 0
    ("hi", (_LGB_ZERO,  False), "gmv <= 0"),   # <  正哨兵 ≡ <= 0
    ("hi", (-_LGB_ZERO, True),  "gmv < 0"),    # <= 负哨兵 ≡ < 0
    ("hi", (-_LGB_ZERO, False), "gmv < 0"),    # <  负哨兵 ≡ < 0
]
for _side, _b, _want in _EXPECT:
    _d, _sq, _pd = _render_one(_b, _side)
    check(f"哨兵 {_b!r}({_side}) 渲染成 {_want}", _sq[0] == _want, _sq[0])
    check(f"哨兵 {_b!r}({_side}) display 与 SQL 同口径",
          _d[0].replace(" ", "") == _want.replace(" ", ""), f"{_d[0]} vs {_want}")

# ★红线★ 恒等:归零前后圈到的人**逐行相同**(数据里刻意放了取值恰好为 0 的行)
try:
    import pandas as _pd2

    _col = _pd2.Series([-3e-3, 0.0, 0.0, 3e-3, 12.5, 998.0, float("nan")])
    _CMP = {(">",): "gt", (">=",): "ge", ("<",): "lt", ("<=",): "le"}
    for _side, _b, _want in _EXPECT:
        _t, _closed = _b
        if _side == "lo":
            _orig = (_col.ge(_t) if _closed else _col.gt(_t))
        else:
            _orig = (_col.le(_t) if _closed else _col.lt(_t))
        _orig = _orig.fillna(False)
        _, _, _pdp = _render_one(_b, _side)
        _got = _pd2.eval(_pdp[0], local_dict={"gmv": _col}).fillna(False)
        check(f"归零不改变圈到的人:{_want}", bool((_orig == _got).all()),
              f"原={list(_orig)} 改写后={list(_got)}")

    # 反证:只抹数值、不动算符,确实会把取值为 0 的人丢掉 —— 钉住"为什么算符必须跟着改"
    check("反证:只抹数值不动算符会改变人群(所以两者必须一起改)",
          not bool((_col.gt(-_LGB_ZERO).fillna(False) == _col.gt(0.0).fillna(False)).all()))
except ImportError:
    print("SKIP  执行形态等价性用例（无 pandas）")

# 兜底层:哨兵万一漏到 _fmt_threshold_exact,输出 0 而不是长串(并会打 WARNING)
for v in (-_LGB_ZERO, _LGB_ZERO, 1e-10, -1e-31, 9.9e-7):
    check(f"兜底:{v!r} 不展开成长串", _fmt_threshold_exact(v) == "0", _fmt_threshold_exact(v))

# 真实阈值一位不动 —— fix30 缺陷 #2/#3 的回归(598.19793701… 美化成 4 位会翻转边界)
for v in (2.5, -3.5, 27.5, 598.19793701171875, 0.0001, -0.0001, 0.003, 1.0000000180025095):
    check(f"真实阈值 {v!r} 在执行形态里一位不动",
          float(_fmt_threshold_exact(v)) == float(v), _fmt_threshold_exact(v))

# 端到端:三形态里都不许再出现超长小数,真实阈值原样保留
_disp, _sql, _pdp = _merge_render_clauses(
    [("num", "gmv", (-_LGB_ZERO, False), None, False),
     ("num", "visit_days", None, (27.5, True), False)],
    {}, drop_null=True)
_LONG = re.compile(r"\d*\.\d{5,}")   # 超过 4 位小数即违规
for _tag, _txt in (("SQL", " AND ".join(_sql)), ("pandas", " & ".join(_pdp)),
                   ("display", " AND ".join(_disp))):
    check(f"端到端:{_tag} 里没有超 4 位小数", not _LONG.search(_txt), _txt)
check("端到端:哨兵那一条写成 gmv >= 0", "gmv >= 0" in " AND ".join(_sql), " AND ".join(_sql))
check("端到端:真实阈值 27.5 原样保留", "27.5" in " AND ".join(_sql), " AND ".join(_sql))


# ── 4c. 整数域字段的阈值写整数,不出 .5 ───────────────────────────────
#
# 树的切分点落在**两个相邻观测值之间**,整数列上"27 和 28 之间"就是 27.5 ——
# 所以 `近90天访问天数 <= 27.5` 是树的原话,不是精度问题。但业务读不懂。
# 整数域上(registry type ∈ count/ordinal/binary)这四种改写是恒等的:
#   `<= k.5` ≡ `< k.5` ≡ `<= k` ; `>= k.5` ≡ `> k.5` ≡ `>= k+1`
# 红线仍是"圈到的人逐行不变"。

_INT_F = lambda f: f in ("visit_days", "insite_channel_cnt")   # noqa: E731

_INTCASES = [
    (("num", "visit_days", (27.5, False), None, False), "visit_days >= 28"),
    (("num", "visit_days", (27.5, True), None, False),  "visit_days >= 28"),
    (("num", "visit_days", None, (27.5, True), False),  "visit_days <= 27"),
    (("num", "visit_days", None, (27.5, False), False), "visit_days <= 27"),
    # 浮点噪声先钉位再写整数(fix23 的 1.5000000000000002 一并覆盖)
    (("num", "visit_days", (1.5000000000000002, False), None, False), "visit_days >= 2"),
]
for _step, _want in _INTCASES:
    _d, _sq, _pd = _merge_render_clauses([_step], {}, is_int_feat=_INT_F, drop_null=True)
    check(f"整数域阈值写整数:{_step[2] or _step[3]} → {_want}", _sq[0] == _want, _sq[0])
    check("display 与 SQL 同口径", _d[0].replace(" ", "") == _want.replace(" ", ""), _d[0])

try:
    import pandas as _pd3

    _col = _pd3.Series([0, 26, 27, 28, 29, 100])
    for _step, _want in _INTCASES:
        _lo, _hi = _step[2], _step[3]
        _orig = ((_col.ge(_lo[0]) if _lo[1] else _col.gt(_lo[0])) if _lo
                 else (_col.le(_hi[0]) if _hi[1] else _col.lt(_hi[0])))
        _, _, _pdp = _merge_render_clauses([_step], {}, is_int_feat=_INT_F, drop_null=True)
        _got = _pd3.eval(_pdp[0], local_dict={"visit_days": _col})
        check(f"恒等:{_want} 与原阈值圈到的人逐行相同", bool((_orig == _got).all()),
              f"原={list(_orig)} 改写后={list(_got)}")
except ImportError:
    print("SKIP  整数域等价性用例（无 pandas）")

# 连续值字段不动 —— 它没有"取值只能是整数"这个前提
_d2, _sq2, _ = _merge_render_clauses(
    [("num", "some_rate", None, (27.5, True), False)], {}, is_int_feat=_INT_F, drop_null=True)
check("非整数域字段的 .5 阈值原样保留", _sq2[0] == "some_rate <= 27.5", _sq2[0])


# ── 5. 两处常量必须同步 ───────────────────────────────────────────────

check("model_analyst 与 model_interpreter 的哨兵常量一致",
      _SENTINEL_EPS == _EPS2, f"{_SENTINEL_EPS} vs {_EPS2}")
check("哨兵门槛为 1e-4(4 位小数表示得出的最小非零值,不再为 0.00003 破例)",
      _SENTINEL_EPS == 1e-4, str(_SENTINEL_EPS))

print()
print("=" * 62)
print("结果：" + ("全部通过" if not fails else f"失败 {len(fails)} 项：" + ", ".join(fails)))
sys.exit(1 if fails else 0)
