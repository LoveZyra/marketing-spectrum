#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""全链路门禁:出参与报告里不许出现超长小数 / 科学计数法。

2026-08-17 线上第二次栽在同一类问题上(第一次是 `> 1.5000000000000002`,fix23 只在
模型侧 display 加了哨兵归零)。这次是 `近1年客单价 > -0.000…00010000000180025095`——
那个尾数是 float32(1e-35),LightGBM 的 kZeroThreshold,树内部的零边界常量。

修完之后做一次**全链路盘查**,发现同一类问题还能从另外三条路出来:

  ① 模型侧执行形态 —— _fmt_threshold_exact 按"逐位保真"全精度展开(已修:
     在 _merge_render_clauses 里连算符一起归零);
  ② 规则库侧 —— _sci_to_plain 只认科学计数法,**定点写法**的 `0.0000000001` 直接
     穿过去;_trim_float_noise 对"抹了会变成 0"的值明确拒绝改动(已修:
     crowd_translator.collapse_tiny_thresholds);
  ③ 报告侧 —— report_renderer 读的是 state 原文,不走 build_crowd_rules,是**另一条
     路**(已修:展示前过 _tidy_cond);
  ④ 阈值提示文案 —— `.4g` 对极小值会吐 `3e-05`(已修:_tidy_num)。

这份门禁就是钉住"以后再冒出第五条路时,CI 先红"。红线:
  1) 三个出参字段 + 报告 HTML/MD 里,零长小数、零科学计数法;
  2) 归零是**恒等改写** —— 圈到的人逐行不变(所以算符必须跟着数值一起改);
  3) pandas 与 SQL 严格同源(一边抹噪声另一边不抹,两个形态就圈不同的人);
  4) 引号里的字面量一个字不动;
  5) 真·长小数(抹了会改变取值的)保留,但必须吵一声,不能静默。
"""
from __future__ import annotations

import io
import json
import re
import sys
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from snippets import crowd_translator as ct                      # noqa: E402
from snippets.report_renderer import render_html, render_markdown  # noqa: E402

fails: list[str] = []


def check(label: str, cond: bool, extra: str = "") -> None:
    print(f"{'PASS' if cond else 'FAIL'}  {label}{('  ' + extra) if extra else ''}")
    if not cond:
        fails.append(label)


# 超过 4 位小数 / 任何科学计数法,都算违规
_LONG = re.compile(r"(?<![\w.])-?\d*\.\d{5,}(?![\w.])")   # 5 位起即违规
_SCI = re.compile(r"(?<![\w])-?\d+(?:\.\d+)?[eE][-+]?\d+(?![\w])")


def dirty(text: str) -> list:
    return sorted(set(_LONG.findall(text)) | set(_SCI.findall(text)))


# ── 1. 归零是恒等改写:圈到的人逐行不变 ────────────────────────────────
print("=== 1. 极小阈值归零必须是恒等改写 ===")

_CASES = [
    ("gmv > -1e-35",      "gmv >= 0"),
    ("gmv >= -1e-35",     "gmv >= 0"),
    ("gmv > 1e-35",       "gmv > 0"),
    ("gmv >= 1e-35",      "gmv > 0"),
    ("gmv < -1e-35",      "gmv < 0"),
    ("gmv <= -1e-35",     "gmv < 0"),
    ("gmv < 1e-35",       "gmv <= 0"),
    ("gmv <= 1e-35",      "gmv <= 0"),
    ("gmv > 0.0000000001", "gmv > 0"),          # 定点写法(线上就是这种)
    ("gmv > -0.0000000001", "gmv >= 0"),
]
for _src, _want in _CASES:
    _got = ct.collapse_tiny_thresholds(_src)
    check(f"{_src} → {_want}", _got == _want, _got)

try:
    import pandas as pd

    # 刻意放上取值恰好为 0 的行 —— 只抹数值不动算符就会在这里翻车
    col = pd.Series([-3e-3, 0.0, 0.0, 3e-3, 12.5, 998.0, float("nan")])
    _OPS = {">": "gt", ">=": "ge", "<": "lt", "<=": "le"}
    for _src, _want in _CASES:
        _m = re.match(r"gmv\s*(>=|<=|>|<)\s*(\S+)$", _src)
        _mw = re.match(r"gmv\s*(>=|<=|>|<)\s*(\S+)$", _want)
        a = getattr(col, _OPS[_m.group(1)])(float(_m.group(2))).fillna(False)
        b = getattr(col, _OPS[_mw.group(1)])(float(_mw.group(2))).fillna(False)
        check(f"恒等:{_src} 与 {_want} 圈到的人逐行相同", bool((a == b).all()),
              f"原={list(a)} 改写后={list(b)}")
    check("反证:只抹数值不动算符会丢掉取值为 0 的人(所以两者必须一起改)",
          not bool((col.gt(-1e-35).fillna(False) == col.gt(0.0).fillna(False)).all()))
except ImportError:
    print("SKIP  恒等性用例（无 pandas）")

# 引号里的是值不是阈值,一个字不动
check("引号内字面量不动",
      ct.collapse_tiny_thresholds("a.str.contains('>1e-35') & b > 1e-35")
      == "a.str.contains('>1e-35') & b > 0",
      ct.collapse_tiny_thresholds("a.str.contains('>1e-35') & b > 1e-35"))
# 门槛 2026-08-17 由 1e-6 提到 1e-4,正是为了守住"最多 4 位小数":
# 4 个 rate 型字段的最小可表示非零值是 1/365 ≈ 0.0027(余量 27 倍),
# 规则库阈值出自 round(x, 4)(构造上落不进 (0, 1e-4)) —— 所以 3e-05 归零是恒等的。
check("(0, 1e-4) 的阈值也归零(不再为 0.00003 破 4 位小数的例)",
      ct.collapse_tiny_thresholds("serialid_bonus > 3e-05") == "serialid_bonus > 0",
      ct.collapse_tiny_thresholds("serialid_bonus > 3e-05"))
check("门槛之上的真实阈值一个字不动",
      ct.collapse_tiny_thresholds("serialid_bonus > 0.0027") == "serialid_bonus > 0.0027")
check("恰好 1e-4 是可表示值,不归零",
      ct.collapse_tiny_thresholds("serialid_bonus > 0.0001") == "serialid_bonus > 0.0001")


# ── 2. 全链路:出参三字段 + 报告两形态,一处脏值都不许有 ────────────────
print("\n=== 2. 全链路扫描(把脏值塞进每一个入口) ===")

state = json.loads((ROOT / "examples" / "output_example.json").read_text(encoding="utf-8"))
segs = state["audience_segments"]
# 入口①:规则 seg 的 pandas 条件(无 SQL,报告会退回 pandas 展示)
segs[0]["filter_conditions"] = "gmv > -1e-35 & pre_mkt_touch_cnt >= 2.5000000000000004"
segs[0].pop("filter_conditions_sql", None)
# 入口②:老 state 的模型 seg,SQL 里带定点极小值
segs[1]["filter_conditions"] = "gmv > 0.0000000001"
segs[1]["filter_conditions_sql"] = "gmv > 0.0000000001"
# 入口③:阈值表里的未 round 值(会进规则提示文案)
state.setdefault("thresholds", {})["pre_mkt_touch_cnt"] = {"optimal": 3e-05}
# 入口④:**抹不动**的真值(XGB float32 阈值),执行形态必须保真、展示必须收到 4 位
segs[2]["filter_conditions_sql"] = "gmv > 598.19793701171875"
segs[2]["filter_conditions"] = "gmv > 598.19793701171875"

rules = ct.build_crowd_rules(state)
# 展示字段:一处脏值都不许有
for _k in ("name", "filter_zh", "suggestion"):
    _t = " ".join(str(r.get(_k) or "") for r in rules)
    check(f"出参 {_k}(展示)无脏值", not dirty(_t), str(dirty(_k and _t)[:4]))
# 执行字段:只允许"抹不动的真值"保真存在,不许有哨兵/噪声
for _k in ("sql_filter", "pandas_filter"):
    _t = " ".join(str(r.get(_k) or "") for r in rules)
    _left = [x for x in dirty(_t) if x not in ("598.19793701171875",)]
    check(f"出参 {_k}(执行)无哨兵/噪声", not _left, str(_left[:4]))
check("执行形态保留 XGB 的精确阈值(抹了会翻转边界,oracle 会剔规则)",
      any("598.19793701171875" in (r.get("sql_filter") or "") for r in rules))

_html, _md = render_html(state), render_markdown(state)
check("报告 HTML 无脏值(含折叠里的「原条件」)", not dirty(_html), str(dirty(_html)[:4]))
check("报告 Markdown 无脏值", not dirty(_md), str(dirty(_md)[:4]))
check("报告里的「原条件」也是展示口径(收到 4 位)",
      "598.1979" in _html and "598.19793701171875" not in _html)

# pandas 与 SQL 必须同源 —— 一边抹噪声另一边不抹,两个形态就圈不同的人
_pair = next((r for r in rules if (r.get("pandas_filter") or "").startswith("gmv >= 0 &")), None)
check("pandas 与 SQL 同源(噪声两边一起抹)",
      bool(_pair) and _pair["pandas_filter"].replace(" & ", " AND ") == _pair["sql_filter"],
      f"{_pair and _pair['pandas_filter']} | {_pair and _pair['sql_filter']}")


# ── 3. 真·长小数:保留取值,但不许静默 ─────────────────────────────────
print("\n=== 3. 抹了会改变取值的长小数:保留 + 吵一声 ===")

_buf = io.StringIO()
with redirect_stdout(_buf):
    _kept = ct._trim_float_noise("visit_days >= 27.333333333333332")
_log = _buf.getvalue()
check("真·长小数原样保留(抹了会真的改变圈到的人)",
      "27.333333333333332" in _kept, _kept)
check("但必须打出告警,提示上游漏了 round(x, 4)",
      "round" in _log and "27.333333333333332" in _log, _log.strip()[:100])

_buf2 = io.StringIO()
with redirect_stdout(_buf2):
    _noise = ct._trim_float_noise("x >= 2.5000000000000004")
check("浮点噪声照常抹平,且不吵(那是噪声不是真值)",
      _noise == "x >= 2.5" and not _buf2.getvalue().strip(), f"{_noise} | {_buf2.getvalue()!r}")


# ── 3b. 展示口径:中文条件里的数字一律 ≤4 位 ──────────────────────────
print("\n=== 3b. 中文条件(展示投影)一律 ≤4 位小数 ===")
# 有一类长小数是**抹不动**的:XGB 的阈值本身就是 float32 精确值
# (598.19793701171875),四舍五入会真的挪动边界 —— 2026-08-14 实测把它美化成
# 598.1979 恰好翻转了一行,叶子 oracle 当场剔规则(fix30 缺陷 #2)。
# 所以执行形态必须逐位保真,但**页面展示不必** —— 在 sql_to_zh 这层收到 4 位。
_SQL_EXACT = "gmv > 598.19793701171875 AND visit_days <= 27.333333333333332"
_ZH = ct.sql_to_zh(_SQL_EXACT)
check("中文条件里没有超 4 位小数", not dirty(_ZH), _ZH)
check("收的是四舍五入不是截断", "598.1979" in _ZH and "27.3333" in _ZH, _ZH)
check("执行形态(sql_filter)不受影响,仍逐位保真",
      "598.19793701171875" in _SQL_EXACT)
check("引号里的值不收(那是类别名/LIKE 内容,不是阈值)",
      "0.123456789" in ct.sql_to_zh("activity_name LIKE '%0.123456789%'"),
      ct.sql_to_zh("activity_name LIKE '%0.123456789%'"))
check("已经 ≤4 位的数字一个字不改(fix28 钉着「原条件原文不动」)",
      ct._round_display_nums("x >= 1.0 AND y > 2.5 AND z > 0.0027")
      == "x >= 1.0 AND y > 2.5 AND z > 0.0027",
      ct._round_display_nums("x >= 1.0 AND y > 2.5 AND z > 0.0027"))
check("4 位以内的真实阈值一个字不动",
      ct.sql_to_zh("serialid_bonus > 0.0027").endswith("> 0.0027"),
      ct.sql_to_zh("serialid_bonus > 0.0027"))


# ── 4. 阈值提示文案:.4g 不许吐科学计数法 ─────────────────────────────
print("\n=== 4. 阈值提示文案 ===")

from snippets.diagnostic_engine import _tidy_num as _tn_engine   # noqa: E402
from snippets.report_renderer import _tidy_num as _tn_report     # noqa: E402

for _v, _want in ((3e-05, "0"), (5e-05, "0"), (0.030000000000000006, "0.03"),
                  (0.0001, "0.0001"), (1e-35, "0"), (2.5, "2.5")):
    check(f"报告侧 {_v!r} → {_want}", _tn_report(_v) == _want, _tn_report(_v))
    check(f"规则侧 {_v!r} → {_want}", _tn_engine(_v) == _want, _tn_engine(_v))
check("两处口径同源", all(_tn_report(v) == _tn_engine(v)
                          for v in (3e-05, 5e-05, 0.0001, 0.03, 1e-35, 2.5, 27.3333)))
check("拿不到数不抛(展示层永不崩)", _tn_report(None) == "None")

print()
print("=" * 62)
print("结果:" + ("全部通过" if not fails else f"失败 {len(fails)} 项:" + ", ".join(fails)))
sys.exit(1 if fails else 0)
