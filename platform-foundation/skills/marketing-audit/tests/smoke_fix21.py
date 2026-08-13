#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""fix21 冒烟测试：软下线 / scope_filter / min_trigger_rate / 新规则 #45 / #11-#43 重划。"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

# skill 目录名可能含连字符，不能当包名 import；把 skill 根目录加进 sys.path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from snippets.diagnostic_engine import (  # noqa: E402
    BELOW_MIN_TRIGGER_STATUS, RULE_DISABLED_STATUS, DiagnosticEngine,
)
from snippets.feature_loader import FeatureLoader  # noqa: E402

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

RULES = ROOT / "feature_schema" / "diagnostic_rules.yaml"
REG = ROOT / "feature_schema" / "feature_registry.yaml"

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

# 7. 不变性：fix21 未改动的规则，条件/严重度/字段必须与冻结快照逐字一致
#    #5/#21 已于 fix26 有意改动（叠加长周期画像字段修正窗口口径），从快照中移除
#    快照在 fix21 落地时对照 fix20 备份验证通过后冻结，此后作为长期回归基线
#    （不再依赖 /tmp 备份文件，脚本可在任意机器上独立运行）
import yaml  # noqa: E402

FROZEN = json.loads(r"""
{
  "1": {
    "condition_template": "(pre_mainflow_event_cnt == 0) & (activity_touch_cnt > 0)",
    "severity_base": "mid",
    "required_fields": [
      "pre_mainflow_event_cnt",
      "activity_touch_cnt"
    ]
  },
  "2": {
    "condition_template": "activity_touch_cnt >= threshold('activity_touch_cnt', 'optimal')",
    "severity_base": "mid",
    "required_fields": [
      "activity_touch_cnt"
    ]
  },
  "4": {
    "condition_template": "(risk_type == '风险用户') | (finance_revenue_after < 0) | (timediff < 10)",
    "severity_base": "high",
    "required_fields": [
      "risk_type",
      "finance_revenue_after",
      "timediff"
    ]
  },
  "6": {
    "condition_template": "period_mismatch_flag == 1",
    "severity_base": "mid",
    "required_fields": [
      "period_mismatch_flag"
    ]
  },
  "12": {
    "condition_template": "insite_multi_channel_match_flag == 0",
    "severity_base": "high",
    "required_fields": [
      "insite_multi_channel_match_flag"
    ]
  },
  "13": {
    "condition_template": "(has_ads_touch == 1) & (ads_insite_match_flag == 0)",
    "severity_base": "high",
    "required_fields": [
      "has_ads_touch",
      "ads_insite_match_flag"
    ]
  },
  "14": {
    "condition_template": "ads_no_insite_flag == 1",
    "severity_base": "high",
    "required_fields": [
      "ads_no_insite_flag"
    ]
  },
  "19": {
    "condition_template": "(pre_is_marketing_first == 0) & (pre_has_coupon == 0) & (pre_has_mkt_click == 0) & ((pre_skip_detail_flag == 1) | ((pre_back_to_list_cnt == 0) & (pre_is_cross_category == 0) & (pre_funnel_pages_cnt <= 3)))",
    "severity_base": "mid",
    "required_fields": [
      "pre_is_marketing_first",
      "pre_has_coupon",
      "pre_has_mkt_click",
      "pre_skip_detail_flag",
      "pre_back_to_list_cnt",
      "pre_is_cross_category",
      "pre_funnel_pages_cnt"
    ]
  },
  "20": {
    "condition_template": "(activity_touch_cnt >= threshold('activity_touch_cnt', 'optimal')) & (is_converted == 0) & (pre_mkt_trigger_mainflow_cnt == 0)",
    "severity_base": "high",
    "required_fields": [
      "activity_touch_cnt",
      "is_converted",
      "pre_mkt_trigger_mainflow_cnt"
    ]
  },
  "23": {
    "condition_template": "(pre_is_cross_category == 1) & (pre_reached_detail == 1) & (is_converted == 0)",
    "severity_base": "low",
    "required_fields": [
      "pre_is_cross_category",
      "pre_reached_detail",
      "is_converted"
    ]
  },
  "25": {
    "condition_template": "(pre_create_order_cnt >= 2) & (pre_create_not_complete == 1) & (is_converted == 0)",
    "severity_base": "high",
    "required_fields": [
      "pre_create_order_cnt",
      "pre_create_not_complete",
      "is_converted"
    ]
  },
  "27": {
    "condition_template": "(pre_max_funnel_depth <= 1) & (pre_mkt_touch_cnt > 0) & (activity_touch_cnt > 0)",
    "severity_base": "mid",
    "required_fields": [
      "pre_max_funnel_depth",
      "pre_mkt_touch_cnt",
      "activity_touch_cnt"
    ]
  },
  "33": {
    "condition_template": "activity_touch_cnt >= threshold('activity_touch_cnt', 'optimal')",
    "severity_base": "mid",
    "required_fields": [
      "activity_touch_cnt"
    ]
  },
  "34": {
    "condition_template": "pre_mkt_channel_cnt >= threshold('pre_mkt_channel_cnt', 'optimal')",
    "severity_base": "mid",
    "required_fields": [
      "pre_mkt_channel_cnt"
    ]
  },
  "35": {
    "condition_template": "pre_popup_touch_cnt >= threshold('pre_popup_touch_cnt', 'optimal')",
    "severity_base": "mid",
    "required_fields": [
      "pre_popup_touch_cnt"
    ]
  },
  "37": {
    "condition_template": "insite_channel_cnt >= threshold('insite_channel_cnt', 'optimal')",
    "severity_base": "mid",
    "required_fields": [
      "insite_channel_cnt"
    ]
  },
  "38": {
    "condition_template": "pre_unique_activity_cnt >= threshold('pre_unique_activity_cnt', 'optimal')",
    "severity_base": "low",
    "required_fields": [
      "pre_unique_activity_cnt"
    ]
  },
  "39": {
    "condition_template": "(pre_reached_booking == 1) & (pre_popup_reject_cnt > 0) & (is_converted == 0)",
    "severity_base": "mid",
    "required_fields": [
      "pre_reached_booking",
      "pre_popup_reject_cnt",
      "is_converted"
    ]
  },
  "42": {
    "condition_template": "(pre_last_coupon_platform.notna()) & (pre_last_coupon_platform != pre_primary_platform)",
    "severity_base": "low",
    "required_fields": [
      "pre_last_coupon_platform",
      "pre_primary_platform"
    ]
  },
  "44": {
    "condition_template": "(is_today == 1) & (scene_has_offline_node == 1)",
    "severity_base": "mid",
    "required_fields": [
      "is_today",
      "scene_has_offline_node"
    ]
  }
}
""")
_new_rules = {str(r["id"]): r for r in yaml.safe_load(
    open(RULES, encoding="utf-8"))["rules"]}
_drift = []
for rid, exp in FROZEN.items():
    cur = _new_rules.get(rid)
    if cur is None:
        _drift.append(f"#{rid} 规则消失")
        continue
    for k, v in exp.items():
        if cur.get(k) != v:
            _drift.append(f"#{rid}.{k}")
check("22 条未改动规则与冻结快照逐字一致", not _drift, "; ".join(_drift) if _drift else "")

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
