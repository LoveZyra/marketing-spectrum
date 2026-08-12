#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""fix23：阈值占位符解析（`or` 误伤合法 0.0）的回归测试。

核心断言有两条：
  1) **现存全部规则解析结果逐字不变** —— 这个修复是潜伏 bug 的修复，
     不允许改变任何现有规则的判定；
  2) 合法的 0.0 阈值不再被静默换成 optimal，且降级时必须留痕。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import yaml  # noqa: E402

from snippets.diagnostic_engine import _resolve_threshold_placeholder as R  # noqa: E402

fails: list[str] = []


def check(label: str, cond: bool, extra: str = "") -> None:
    print(f"{'PASS' if cond else 'FAIL'}  {label}{('  ' + extra) if extra else ''}")
    if not cond:
        fails.append(label)


def old_impl(template: str, th: dict) -> str:
    """修复前的实现，用于逐条对拍。"""
    pattern = re.compile(r"threshold\(['\"]([^'\"]+)['\"]\s*,\s*['\"]([^'\"]+)['\"]\)")
    out = template
    for m in pattern.finditer(template):
        field, stat = m.group(1), m.group(2)
        ft = th.get(field, {})
        v = ft.get(stat) or ft.get("optimal")
        if v is None:
            v = float("inf")
        out = out.replace(m.group(0), str(v))
    return out


# ── 1. 现存规则：改前改后逐字一致（这是本次修复的硬约束）──────────────

rules = yaml.safe_load((ROOT / "feature_schema" / "diagnostic_rules.yaml")
                       .read_text(encoding="utf-8"))["rules"]
fields = sorted({tf["field"] for r in rules for tf in (r.get("threshold_fields") or [])})

# 造几套阈值表，覆盖正常值 / 0 值 / 缺失三种形态
TH_SETS = [
    {f: {"optimal": 3.0} for f in fields},
    {f: {"optimal": 0.0} for f in fields},                      # ← 老实现的雷区
    {f: {"optimal": 0.0, "p75": 0.0, "p90": 7.0} for f in fields},
    {},                                                          # 全缺失
]
diff = []
for i, th in enumerate(TH_SETS):
    for r in rules:
        tmpl = r.get("condition_template")
        if not tmpl or "threshold(" not in tmpl:
            continue
        if R(tmpl, th)[0] != old_impl(tmpl, th):
            diff.append(f"set{i}/rule{r['id']}")
n_with_th = sum(1 for r in rules if "threshold(" in (r.get("condition_template") or ""))
check(f"现存 {n_with_th} 条带阈值规则 × 4 套阈值表，解析结果逐字不变",
      not diff, "; ".join(diff))

# ── 2. 合法 0.0 不再被换成 optimal ────────────────────────────────────

th = {"pre_popup_touch_cnt": {"p75": 0.0, "optimal": 3.0}}
tmpl = "pre_popup_touch_cnt >= threshold('pre_popup_touch_cnt', 'p75')"
got, warns = R(tmpl, th)
check("合法 0.0 阈值被正确取用（不再串成 optimal）",
      got == "pre_popup_touch_cnt >= 0.0", got)
check("取到 0.0 时不产生回退告警", not warns, str(warns))
check("对拍：老实现在此处确实会串值",
      old_impl(tmpl, th) == "pre_popup_touch_cnt >= 3.0", old_impl(tmpl, th))

# ── 3. 真缺失时回退到 optimal，且必须留痕 ─────────────────────────────

th2 = {"x": {"optimal": 5.0}}
got2, warns2 = R("x >= threshold('x', 'p90')", th2)
check("请求的分位数没算过 → 回退 optimal", got2 == "x >= 5.0", got2)
check("回退必须留痕（老实现是静默的）",
      any("回退到 optimal" in w for w in warns2), str(warns2))

# ── 4. 全缺失仍走 inf 哨兵 ────────────────────────────────────────────

got3, warns3 = R("y >= threshold('y', 'optimal')", {})
check("字段完全没有阈值 → inf 哨兵（规则不触发）", "inf" in got3, got3)
check("并给出未计算告警", any("使用 inf" in w for w in warns3), str(warns3))

# ── 5. optimal 本身为 0.0 时不得退化成 inf ────────────────────────────

got4, warns4 = R("z >= threshold('z', 'optimal')", {"z": {"optimal": 0.0}})
check("optimal=0.0 是合法值，不得被当成缺失", got4 == "z >= 0.0", got4)
check("optimal=0.0 时不报未计算", not warns4, str(warns4))

print()
print("=" * 62)
print("结果：" + ("全部通过" if not fails else f"失败 {len(fails)} 项：" + ", ".join(fails)))
sys.exit(1 if fails else 0)
