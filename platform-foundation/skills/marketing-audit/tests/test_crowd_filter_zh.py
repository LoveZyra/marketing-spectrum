#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""fix29：crowd_rules 出参新增 `filter_zh`（中文口径）的回归测试。

这个字段会一路进 API 出参（`crowd_spec.rules[]` → `/result` 的 rules），所以红线是：
  1) **纯附加** —— 原有键一个不少、值一个字不改。下游执行仍以 `sql_filter` 为准；
  2) **翻不动就空串** —— `humanize_condition` 翻不出时会原样回显输入，
     那种情况必须交空串，绝不能把英文伪装成中文口径发出去；
  3) **翻译出问题不能拖垮圈人链路** —— 渲染层抛异常时该字段退化为空串，其余照常。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from snippets import crowd_translator as ct  # noqa: E402

fails: list[str] = []


def check(label: str, cond: bool, extra: str = "") -> None:
    print(f"{'PASS' if cond else 'FAIL'}  {label}{('  ' + extra) if extra else ''}")
    if not cond:
        fails.append(label)


state = json.loads((ROOT / "examples" / "output_example.json").read_text(encoding="utf-8"))
rules = ct.build_crowd_rules(state)
segs = [r for r in rules if r["source"] == "audience_segment"]

# ── 1. 纯附加：原有键与值一律不动 ─────────────────────────────────────

LEGACY_SEG = {"source", "name", "direction", "pandas_filter", "sql_filter",
              "estimated_size", "baseline_cvr", "expected_cvr_mid", "finding_id", "suggestion"}
check("audience_segment 原有键一个不少",
      all(LEGACY_SEG <= set(r) for r in segs),
      str([sorted(LEGACY_SEG - set(r)) for r in segs if not LEGACY_SEG <= set(r)][:1]))
check("每条都带上了 filter_zh", all("filter_zh" in r for r in rules))

for r, s in zip(segs, state.get("audience_segments", [])):
    check(f"pandas_filter 逐字未变：{(s.get('filter_conditions') or '')[:24]}",
          r["pandas_filter"] == (s.get("filter_conditions") or ""))
check("sql_filter 不受影响（仍是英文可执行口径）",
      all(("SELECT" not in (r["sql_filter"] or "")) and (r["sql_filter"] or "") for r in segs))
check("filter_zh 与 pandas_filter 不是同一串（中文≠原文）",
      all(r["filter_zh"] != r["pandas_filter"] for r in segs if r["filter_zh"]))

# ── 2. 翻不动 → 空串，不回显英文 ──────────────────────────────────────

check("filter_zh() 对翻不动的输入交空串",
      ct.filter_zh("weird_unknown_col_zzz") == "" and ct.filter_zh("") == "",
      repr(ct.filter_zh("weird_unknown_col_zzz")))
check("filter_zh() 对真条件能翻出中文",
      "近1天" in ct.filter_zh("pre_create_order_cnt >= 1"),
      ct.filter_zh("pre_create_order_cnt >= 1"))

_bad = json.loads(json.dumps(state))
for s_ in _bad.get("audience_segments", []):
    s_["filter_conditions"] = "weird_unknown_col_zzz > 5"
_r = [r for r in ct.build_crowd_rules(_bad) if r["source"] == "audience_segment"]
check("整批翻不动时不产生假中文（英文原样留在 pandas/sql，中文列为空或不含中文标点）",
      all("且" not in (r["filter_zh"] or "") for r in _r))

# ── 3. 翻译炸了也不能拖垮圈人链路 ─────────────────────────────────────

import snippets.report_renderer as _rr  # noqa: E402

_orig = _rr.humanize_condition
try:
    def _boom(_c):                       # noqa: ANN001
        raise RuntimeError("翻译层炸了")
    _rr.humanize_condition = _boom
    _safe = ct.build_crowd_rules(state)
    check("渲染层抛异常时仍能产出规则", len(_safe) == len(rules))
    check("异常时 filter_zh 退化为空串，其余字段照常",
          all(r["filter_zh"] == "" for r in _safe)
          and [r["sql_filter"] for r in _safe] == [r["sql_filter"] for r in rules])
finally:
    _rr.humanize_condition = _orig

# ── 4. 与报告附录同源（同一条件在两处必须是同一句话）───────────────────

from snippets.report_renderer import humanize_condition as H  # noqa: E402

check("与报告附录「筛选条件（中文）」同一套翻译",
      all(r["filter_zh"] == (H(r["pandas_filter"]) if H(r["pandas_filter"]) != r["pandas_filter"] else "")
          for r in segs))

# ── 5. 标签不再是带解释从句的整句描述（fix29 回退口径收窄）─────────────

from snippets.report_renderer import ReportRenderer as R  # noqa: E402

check("回退标签切掉逗号后的解释从句",
      "，" not in R._humanize_feature("pre_first_expose_to_touch_min"),
      R._humanize_feature("pre_first_expose_to_touch_min"))
check("逗号前的口径一个字不动",
      R._humanize_feature("pre_first_expose_to_touch_min").startswith("近1天触达前首条行为"))

print()
print("=" * 62)
print("结果：" + ("全部通过" if not fails else f"失败 {len(fails)} 项：" + ", ".join(fails)))
sys.exit(1 if fails else 0)
