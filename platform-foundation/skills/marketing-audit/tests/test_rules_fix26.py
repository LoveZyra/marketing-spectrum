#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""fix26：#5 / #21 叠加长周期画像字段的行为验证。

要点：
  1) 新增的长周期门槛**确实在收紧**（同一份数据，触发人数只减不增）；
  2) 画像字段缺失时**整条 skipped**，绝不退化成"用一天行为下长期结论"；
  3) 非 optimal 的分位数 stat（p25/p75）能被正确解析 —— 这是全库第一次用，
     正好压中 fix23 修的 `or` 误伤 0.0 那个坑（visit_days 的 p25 很可能就是 0）。
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from snippets.diagnostic_engine import DiagnosticEngine  # noqa: E402
from snippets.feature_loader import FeatureLoader  # noqa: E402

RULES = ROOT / "feature_schema" / "diagnostic_rules.yaml"
fails: list[str] = []


def check(label: str, cond: bool, extra: str = "") -> None:
    print(f"{'PASS' if cond else 'FAIL'}  {label}{('  ' + extra) if extra else ''}")
    if not cond:
        fails.append(label)


RNG = np.random.default_rng(20260812)
N = 4000


def make_df(with_profile: bool = True) -> pd.DataFrame:
    d = pd.DataFrame({
        "activity_channel_std": "push",
        "pre_mainflow_event_cnt": RNG.choice([0, 1, 5], N, p=[.5, .2, .3]),
        "pre_is_dormant_user": RNG.integers(0, 2, N),
        "pre_total_event_cnt": RNG.integers(0, 30, N),
        "pre_create_not_complete": RNG.integers(0, 2, N),
        "pre_has_coupon": RNG.integers(0, 2, N),
        "pre_rp_target_product": RNG.integers(0, 2, N),
        "is_converted": RNG.integers(0, 2, N),
        "is_paid": 0,
    })
    if with_profile:
        d["visit_days"] = RNG.integers(0, 90, N)          # 近90天访问天数
        d["serialid_bonus"] = RNG.random(N)               # 近1年促销订单占比
    return d


TH = {
    "pre_total_event_cnt": {"optimal": 10},
    "visit_days": {"p25": 22.0, "optimal": 45.0},        # p25 与 optimal 故意不同
    "serialid_bonus": {"p75": 0.75, "optimal": 0.5},
}

df = make_df(True)
eng = DiagnosticEngine(TH, FeatureLoader(df), rules_path=RULES, cvr_col="is_paid")
res = {r["rule_id"]: r for r in eng.apply_all(df)}

# ── 1. 分位数 stat 解析正确（不是退回 optimal）──
m5 = ((df.pre_mainflow_event_cnt == 0)
      & ((df.pre_is_dormant_user == 1) | (df.pre_total_event_cnt <= 10))
      & (df.visit_days <= 22.0))
check("#5 用的是 visit_days 的 p25（22）而非 optimal（45）",
      res[5]["trigger_cnt"] == int(m5.sum()),
      f"engine={res[5]['trigger_cnt']} manual_p25={int(m5.sum())} "
      f"manual_optimal={int((((df.pre_mainflow_event_cnt==0)&((df.pre_is_dormant_user==1)|(df.pre_total_event_cnt<=10))&(df.visit_days<=45.0))).sum())}")

m21 = ((df.pre_create_not_complete == 1) & (df.pre_has_coupon == 0)
       & (df.pre_rp_target_product == 0) & (df.is_converted == 0)
       & (df.serialid_bonus >= 0.75))
check("#21 用的是 serialid_bonus 的 p75（0.75）而非 optimal（0.5）",
      res[21]["trigger_cnt"] == int(m21.sum()),
      f"engine={res[21]['trigger_cnt']} manual={int(m21.sum())}")

check("#5 记录了两个阈值来源", set(res[5]["threshold_used"]) == {"pre_total_event_cnt", "visit_days"},
      str(res[5]["threshold_used"]))
check("#21 记录了 serialid_bonus 阈值", "serialid_bonus" in res[21]["threshold_used"],
      str(res[21]["threshold_used"]))

# ── 2. 长周期门槛确实在收紧 ──
old5 = ((df.pre_mainflow_event_cnt == 0)
        & ((df.pre_is_dormant_user == 1) | (df.pre_total_event_cnt <= 10)))
old21 = ((df.pre_create_not_complete == 1) & (df.pre_has_coupon == 0)
         & (df.pre_rp_target_product == 0) & (df.is_converted == 0))
check("#5 收紧：触发人数少于旧口径",
      res[5]["trigger_cnt"] < int(old5.sum()),
      f"新 {res[5]['trigger_cnt']} < 旧 {int(old5.sum())}")
check("#21 收紧：触发人数少于旧口径",
      res[21]["trigger_cnt"] < int(old21.sum()),
      f"新 {res[21]['trigger_cnt']} < 旧 {int(old21.sum())}")

# ── 3. 画像缺失 → 整条 skipped，绝不退化 ──
df_np = make_df(False)
res_np = {r["rule_id"]: r for r in DiagnosticEngine(
    TH, FeatureLoader(df_np), rules_path=RULES, cvr_col="is_paid").apply_all(df_np)}
for rid, fld in ((5, "visit_days"), (21, "serialid_bonus")):
    check(f"#{rid} 缺 {fld} 时整条 skipped（不退化成一天口径）",
          res_np[rid]["status"] == "skipped" and fld in str(res_np[rid]["skip_reason"]),
          f"{res_np[rid]['status']} / {res_np[rid]['skip_reason']}")

# ── 4. fix23 的 or-bug 若未修，p25=0.0 会被静默换成 optimal ──
TH0 = dict(TH); TH0["visit_days"] = {"p25": 0.0, "optimal": 45.0}
res0 = {r["rule_id"]: r for r in DiagnosticEngine(
    TH0, FeatureLoader(df), rules_path=RULES, cvr_col="is_paid").apply_all(df)}
m5_zero = ((df.pre_mainflow_event_cnt == 0)
           & ((df.pre_is_dormant_user == 1) | (df.pre_total_event_cnt <= 10))
           & (df.visit_days <= 0.0))
check("p25=0.0 是合法阈值，不得被静默换成 optimal（fix23 回归）",
      res0[5]["trigger_cnt"] == int(m5_zero.sum()),
      f"engine={res0[5]['trigger_cnt']} 期望={int(m5_zero.sum())} "
      f"（若等于 {res[5]['trigger_cnt']} 说明退回了 optimal）")

# ── 5. 两条规则都带 data_note，说明画像依赖 ──
import yaml  # noqa: E402
by = {r["id"]: r for r in yaml.safe_load(RULES.read_text(encoding="utf-8"))["rules"]}
for rid in (5, 21):
    check(f"#{rid} 带 data_note 说明画像依赖", bool(by[rid].get("data_note")))
    check(f"#{rid} 描述里点明了窗口口径",
          "近1天" in by[rid]["description"] and ("近90天" in by[rid]["description"]
                                                 or "近1年" in by[rid]["description"]))

print()
print("=" * 62)
print("结果：" + ("全部通过" if not fails else f"失败 {len(fails)} 项：" + ", ".join(fails)))
sys.exit(1 if fails else 0)
