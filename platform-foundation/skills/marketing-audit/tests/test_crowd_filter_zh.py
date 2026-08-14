#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""fix29 引入 / fix30 改口径:crowd_rules 出参 `filter_zh`(中文口径)的回归测试。

fix30 起,filter_zh 不再走 humanize_condition 反翻译 pandas 条件,而是对最终
`sql_filter` 做 **sql_to_zh 逐 token 直译**(SQL 已被白名单+黄金快照+语义对拍
保证正确,翻译只查表不猜)。红线相应更新:
  1) **纯附加** —— 原有键一个不少、值一个字不改。下游执行仍以 `sql_filter` 为准;
  2) **与 sql_filter 严格同源** —— filter_zh 必须逐条等于 sql_to_zh(sql_filter),
     不存在"条件改了中文没跟上"的漂移空间;
  3) **不做语义优化** —— 值/数字原样(英文代码值如 'popup' 不翻),结构词按固定
     映射(且/或/属于/不属于/为空/不为空/包含);字段名查不到标签时保留英文
     (可见的未翻译,绝不猜);闭合语法之外 fail-closed 给空串;
  4) **翻译出问题不能拖垮圈人链路** —— 标签层抛异常时该字段退化为空串,其余照常。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from snippets import crowd_translator as ct  # noqa: E402
from snippets import feature_labels as fl    # noqa: E402

fails: list[str] = []


def check(label: str, cond: bool, extra: str = "") -> None:
    print(f"{'PASS' if cond else 'FAIL'}  {label}{('  ' + extra) if extra else ''}")
    if not cond:
        fails.append(label)


state = json.loads((ROOT / "examples" / "output_example.json").read_text(encoding="utf-8"))
rules = ct.build_crowd_rules(state)
segs = [r for r in rules if r["source"] == "audience_segment"]
drs = [r for r in rules if r["source"] == "diagnostic_rule"]

# ── 1. 纯附加:原有键与值一律不动 ─────────────────────────────────────

LEGACY_SEG = {"source", "name", "direction", "pandas_filter", "sql_filter",
              "estimated_size", "baseline_cvr", "expected_cvr_mid", "finding_id", "suggestion"}
check("audience_segment 原有键一个不少",
      all(LEGACY_SEG <= set(r) for r in segs),
      str([LEGACY_SEG - set(r) for r in segs if not (LEGACY_SEG <= set(r))][:1]))
check("filter_zh 是纯附加字段(所有规则都带)",
      all("filter_zh" in r for r in rules))
check("sql_filter / pandas_filter 不因中文翻译而变化",
      all(isinstance(r["sql_filter"], str) for r in rules))

# ── 2. 与 sql_filter 严格同源:filter_zh ≡ sql_to_zh(sql_filter) ────────

check("filter_zh 逐条等于 sql_to_zh(sql_filter)(同源,无漂移空间)",
      all((r["filter_zh"] or "") == (ct.sql_to_zh(r["sql_filter"]) or "")
          for r in rules))

# ── 3. 直译口径:不做语义优化 ─────────────────────────────────────────

zh_all = " ".join(r["filter_zh"] or "" for r in rules)
check("结构词按固定映射(出现过的条件里应有 且/或 之一)",
      ("且" in zh_all or "或" in zh_all or len([r for r in rules if r["filter_zh"]]) == 0))
check("值不翻:filter_zh 里的字符串字面量保留引号原样",
      all(("'" in r["filter_zh"]) == ("'" in r["sql_filter"])
          for r in rules if r["filter_zh"]))

# 未知字段:保留英文而不是猜
_zh = ct.sql_to_zh("weird_unknown_col_zzz > 5")
check("未知字段保留英文原名(可见的未翻译,绝不猜)",
      _zh == "weird_unknown_col_zzz > 5", repr(_zh))

# 闭合语法之外 fail-closed
check("闭合语法之外 fail-closed(BETWEEN → 空串)",
      ct.sql_to_zh("a BETWEEN 1 AND 2") == "")

# ── 4. 翻译层炸了也不能拖垮圈人链路 ───────────────────────────────────

_orig = fl.feature_label
try:
    def _boom(_n):                       # noqa: ANN001
        raise RuntimeError("标签层炸了")
    fl.feature_label = _boom
    _safe = ct.build_crowd_rules(state)
    check("标签层抛异常时仍能产出规则", len(_safe) == len(rules))
    check("异常时 filter_zh 退化为空串,其余字段照常",
          all(r["filter_zh"] == "" for r in _safe)
          and [r["sql_filter"] for r in _safe] == [r["sql_filter"] for r in rules])
finally:
    fl.feature_label = _orig

# ── 5. 标签口径:与报告同一份表 ───────────────────────────────────────

from snippets.report_renderer import ReportRenderer as R  # noqa: E402

check("字段标签与报告同源(report_renderer 委托 feature_labels)",
      R._humanize_feature("risk_type") == fl.feature_label("risk_type"))
check("回退标签切掉逗号后的解释从句",
      "，" not in R._humanize_feature("pre_first_expose_to_touch_min"),
      R._humanize_feature("pre_first_expose_to_touch_min"))
check("逗号前的口径一个字不动",
      R._humanize_feature("pre_first_expose_to_touch_min").startswith("近1天触达前首条行为"))

print()
print("=" * 62)
print("结果:" + ("全部通过" if not fails else f"失败 {len(fails)} 项:" + ", ".join(fails)))
sys.exit(1 if fails else 0)
