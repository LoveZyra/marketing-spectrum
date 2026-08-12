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
from snippets.model_analyst import _SENTINEL_EPS, _fmt_threshold  # noqa: E402
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
        for eps in (1e-10, 5e-11, 1e-8, 9.9e-7):
            a = (df[col] > eps).sum()
            b = (df[col] > 0).sum()
            if a != b:
                same_all = False
                print(f"      差异: {col} eps={eps} {a} vs {b}")
    check("等价性：`> 1e-10` 与 `> 0` 在 rate 字段上选中同一批行", same_all)

    minpos = min(float(df[c][df[c] > 0].min()) for c in df.columns)
    check("等价性前提：最小可表示非零值远大于门槛",
          minpos > _SENTINEL_EPS * 100, f"min={minpos:.6g}  eps={_SENTINEL_EPS:g}")
except ImportError:
    print("SKIP  等价性用例（无 pandas/numpy）")

# ── 5. 两处常量必须同步 ───────────────────────────────────────────────

check("model_analyst 与 model_interpreter 的哨兵常量一致",
      _SENTINEL_EPS == _EPS2, f"{_SENTINEL_EPS} vs {_EPS2}")
check("哨兵门槛为 1e-6", _SENTINEL_EPS == 1e-6, str(_SENTINEL_EPS))

print()
print("=" * 62)
print("结果：" + ("全部通过" if not fails else f"失败 {len(fails)} 项：" + ", ".join(fails)))
sys.exit(1 if fails else 0)
