#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""fix21 冒烟测试：软下线 / scope_filter / min_trigger_rate / 新规则 #45 / #11-#43 重划。"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ma.snippets.diagnostic_engine import (  # noqa: E402
    BELOW_MIN_TRIGGER_STATUS, RULE_DISABLED_STATUS, DiagnosticEngine,
)
from ma.snippets.feature_loader import FeatureLoader  # noqa: E402

RNG = np.random.default_rng(20260812)
N = 4000


def make_df(channel: str = "push") -> pd.DataFrame:
    d = pd.DataFrame({
        "mapid": np.arange(N),
        "activity_channel_std": channel,
        "activity_name": "国庆酒店红包提醒" if channel == "sms" else "国庆酒店大促",
        "activity_touch_cnt": RNG.integers(1, 8, N),
        "pre_mainflow_event_cnt": RNG.integers(0, 20, N),
        "pre_total_event_cnt": RNG.integers(0, 50, N),
        "pre_is_dormant_user": RNG.integers(0, 2, N),
        "pre_popup_reject_cnt": RNG.integers(0, 3, N),
        "pre_popup_touch_cnt": RNG.integers(0, 4, N),
        "pre_push_touch_cnt": RNG.integers(0, 4, N),
        "pre_sms_touch_cnt": RNG.integers(0, 4, N),
        "pre_insite_msg_touch_cnt": RNG.integers(0, 4, N),
        "pre_target_product_visit_cnt": RNG.integers(0, 3, N),
        "pre_browse_target_product": RNG.integers(0, 2, N),
        "pre_mkt_product_browse_match": RNG.integers(0, 2, N),
        "is_converted": RNG.integers(0, 2, N),
        "is_paid": 0,
        "period_mismatch_flag": RNG.integers(0, 2, N),
        "pre_last_mainflow_detail": "酒店详情页",
        "pre_last_mainflow_to_touch_min": RNG.integers(0, 120, N),
        "pre_back_to_list_cnt": RNG.integers(0, 5, N),
        "pre_back_to_booking_cnt": RNG.integers(0, 3, N),
        "pre_complete_order_cnt": RNG.integers(0, 6, N),
        "pre_create_not_complete": RNG.integers(0, 2, N),
        "pre_reached_booking": RNG.integers(0, 2, N),
        "pre_funnel_regression_after_mkt": RNG.integers(0, 3, N),
    })
    # is_paid：只让 2% 的创单转成成单 → #41 触发率约 49%，先验证不被门槛拦
    d.loc[d.sample(frac=0.02, random_state=1).index, "is_paid"] = 1
    return d


THRESHOLDS = {
    "activity_touch_cnt": {"optimal": 4},
    "pre_total_event_cnt": {"optimal": 10},
    "pre_last_mainflow_to_touch_min": {"optimal": 30},
    "pre_back_to_list_cnt": {"optimal": 3},
    "pre_complete_order_cnt": {"optimal": 3},
    "insite_total_touch_cnt": {"optimal": 5},
}

RULES = Path(__file__).resolve().parent / "feature_schema" / "diagnostic_rules.yaml"
REG = Path(__file__).resolve().parent / "feature_schema" / "feature_registry.yaml"

fails: list[str] = []


def check(label: str, cond: bool, extra: str = "") -> None:
    print(f"{'PASS' if cond else 'FAIL'}  {label}{('  ' + extra) if extra else ''}")
    if not cond:
        fails.append(label)


df_push = make_df("push")
loader = FeatureLoader(df_push, registry_path=REG)
eng = DiagnosticEngine(THRESHOLDS, loader, rules_path=RULES, cvr_col="is_paid")

res = {r["rule_id"]: r for r in eng.apply_all(df_push)}

# 1. 软下线
for rid in (15, 16, 17, 18, 24, 40, 46):
    check(f"#{rid} 软下线 → status=disabled",
          res[rid]["status"] == RULE_DISABLED_STATUS, res[rid]["status"])

summary = eng.rule_summary(df_push)
check("下线规则不进 rule_summary",
      not set(summary["rule_id"]) & {15, 16, 17, 18, 24, 40, 46},
      f"summary 共 {len(summary)} 条")
check("在用规则全部进 rule_summary", len(summary) == 28, f"{len(summary)} 条")

# 2. scope_filter：非广告活动上 #45 不适用
check("#45 在 push 活动上 not_applicable",
      res[45]["status"] == "not_applicable", str(res[45]["skip_reason"]))

df_ads = make_df("ads")
res_ads = {r["rule_id"]: r for r in DiagnosticEngine(
    THRESHOLDS, loader, rules_path=RULES, cvr_col="is_paid").apply_all(df_ads)}
check("#45 在 ads 活动上正常评估",
      res_ads[45]["status"] in ("triggered", "not_triggered"),
      f"status={res_ads[45]['status']} trigger_rate={res_ads[45]['trigger_rate']}")
check("#45 输出对照阈值 insite_total_touch_cnt",
      res_ads[45].get("threshold_reference", {}).get("insite_total_touch_cnt") == 5,
      str(res_ads[45].get("threshold_reference")))
# 手算核对
expect = int((((df_ads.pre_popup_touch_cnt + df_ads.pre_push_touch_cnt
                + df_ads.pre_sms_touch_cnt + df_ads.pre_insite_msg_touch_cnt) >= 3)
              & (df_ads.pre_mainflow_event_cnt == 0)).sum())
check("#45 触发行数与手算一致",
      res_ads[45]["trigger_cnt"] == expect,
      f"engine={res_ads[45]['trigger_cnt']} manual={expect}")

# 3. min_trigger_rate
check("#41 触发率高时正常上报",
      res[41]["status"] == "triggered",
      f"trigger_rate={res[41]['trigger_rate']}")
df_low = df_push.copy()
df_low["is_converted"] = 0
df_low.loc[df_low.sample(n=100, random_state=7).index, "is_converted"] = 1  # 2.5%
res_low = {r["rule_id"]: r for r in DiagnosticEngine(
    THRESHOLDS, loader, rules_path=RULES, cvr_col="is_paid").apply_all(df_low)}
check("#41 触发率 2.5% 被 min_trigger_rate 拦下",
      res_low[41]["status"] == BELOW_MIN_TRIGGER_STATUS,
      f"{res_low[41]['status']} / {res_low[41]['skip_reason']}")

# 4. #11 与 #43 重划后的重叠度
m11 = ((df_push.pre_target_product_visit_cnt == 0) & (df_push.pre_browse_target_product == 0))
m43 = m11 & (df_push.pre_mainflow_event_cnt > 0)
jac = (m11 & m43).sum() / max((m11 | m43).sum(), 1)
check("#11 触发行数与引擎一致", res[11]["trigger_cnt"] == int(m11.sum()),
      f"engine={res[11]['trigger_cnt']} manual={int(m11.sum())}")
check("#43 触发行数与引擎一致", res[43]["trigger_cnt"] == int(m43.sum()),
      f"engine={res[43]['trigger_cnt']} manual={int(m43.sum())}")
print(f"      #11/#43 Jaccard = {jac:.3f}（≥0.9 说明分层无效，需合并）")

# 5. #7 改写
check("#7 已改名为「成单后推送过急」", res[7]["name"] == "成单后推送过急", res[7]["name"])
check("#7 severity 降为 mid",
      summary.loc[summary.rule_id == 7, "severity_base"].iloc[0] == "mid")

# 6. recommendations / applies_to 落到 summary
check("summary 带 recommendations",
      all(len(x) > 0 for x in summary["recommendations"]),
      f"最短 {min(len(x) for x in summary['recommendations'])} 条")
check("summary 带 applies_to", "applies_to" in summary.columns)
check("#45 applies_to=广告投放",
      summary.loc[summary.rule_id == 45, "applies_to"].iloc[0] == "广告投放")

# 7. 不变性：未改动的规则在同一份数据上结果与旧引擎一致
UNCHANGED = [1, 2, 4, 5, 6, 12, 13, 14, 19, 20, 21, 23, 25, 27, 33, 34, 35, 37, 38, 39, 42, 44]
old_sys = str(Path(__file__).resolve().parent.parent)
import importlib.util  # noqa: E402
spec = importlib.util.spec_from_file_location("old_engine", "/tmp/engine.bak.py")
# 旧引擎带相对 import，无法单文件加载 → 改用旧 yaml + 新引擎交叉验证条件未变
import yaml  # noqa: E402
old_rules = {r["id"]: r for r in yaml.safe_load(
    open("/tmp/rules.bak.yaml", encoding="utf-8"))["rules"]}
new_rules = {r["id"]: r for r in yaml.safe_load(
    open(RULES, encoding="utf-8"))["rules"]}
same = all(
    old_rules[i]["condition_template"] == new_rules[i]["condition_template"]
    and old_rules[i]["severity_base"] == new_rules[i]["severity_base"]
    and old_rules[i]["required_fields"] == new_rules[i]["required_fields"]
    for i in UNCHANGED
)
check("22 条未改动规则的条件/严重度/字段逐字未变", same)
_ = old_sys

# 8. registry 引用清理
reg_txt = Path(REG).read_text(encoding="utf-8")
import re as _re  # noqa: E402
refs = set()
for m in _re.finditer(r"diagnostic_rules:\s*\[([^\]]*)\]", reg_txt):
    refs |= {int(x) for x in _re.findall(r"\d+", m.group(1))}
check("registry 不再引用已下线规则",
      not refs & {15, 16, 17, 18, 24, 40}, str(sorted(refs & {15, 16, 17, 18, 24, 40})))
check("registry 已挂上 #45", 45 in refs)

print()
print("=" * 60)
print(f"结果：{'全部通过' if not fails else '失败 ' + str(len(fails)) + ' 项：' + ', '.join(fails)}")
sys.exit(1 if fails else 0)
