"""12 维全量描述统计（用户-活动粒度：mapid + activity_name + activity_id + activity_channel）。

涉及特征：营销渠道触达 pre_*_touch_cnt；产品偏好 pre_browse_* / pre_*_depth；
平台 pre_primary_platform / pre_events_per_hour；行为路径 pre_path_model_seq / pre_is_marketing_first；
会员权益 pre_* 前缀。第 12 维为诊断规则覆盖率汇总（diagnostic_rules_summary），
需传入 diagnostic_engine 实例，缺失时跳过该维度。
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Any

import numpy as np
import pandas as pd

if TYPE_CHECKING:
    from .diagnostic_engine import DiagnosticEngine

# 渠道名称 → 触达计数列映射
_V2_CHANNEL_TOUCH_COLS: dict[str, str] = {
    "popup":      "pre_popup_touch_cnt",
    "push":       "pre_push_touch_cnt",
    "sms":        "pre_sms_touch_cnt",
    "ads":        "pre_ads_touch_cnt",
    "insite_msg": "pre_insite_msg_touch_cnt",
    "activity":   "pre_activity_touch_cnt",
}

# 业务上对未转化用户必然为 NULL 的时间类字段，不纳入覆盖率计算
_BUSINESS_NULL_COLS = {
    "convert_time", "pre_last_order_time",
    "pre_first_event_time", "pre_last_event_time",
    "pre_first_mkt_time", "pre_last_mkt_time",
    "pre_first_mainflow_time", "pre_last_mainflow_time",
    "pre_first_coupon_time", "pre_last_coupon_time",
    "pre_first_search_time", "pre_last_search_time",
}


def compute_data_overview(
    df: pd.DataFrame,
    campaign_id: str | None = None,
    target_product: str | None = None,
    diagnostic_engine: "DiagnosticEngine | None" = None,
) -> dict:
    """从特征宽表计算 12 维全量聚合指标。

    所有字段缺失安全跳过，返回值可直接 JSON 序列化。

    Args:
        target_product     : 活动目标品类（如"机票"），传入后 CVR 仅统计该品类转化
        diagnostic_engine  : DiagnosticEngine 实例，传入后计算第 12 维诊断规则汇总
    """
    overview: dict = {}
    target = "is_converted"
    has_target = target in df.columns

    if has_target and target_product and "activity_product_name" in df.columns:
        df = df.copy()
        df["_is_target_converted"] = (
            (df[target] == 1) & (df["activity_product_name"] == target_product)
        ).astype(int)
        target = "_is_target_converted"

    # ── 工具函数 ────────────────────────────────────────────────────────────
    def safe_mean(col: str) -> float | None:
        return round(float(df[col].mean()), 4) if col in df.columns else None

    def safe_cvr_by(groupby_col: str) -> list[dict]:
        if groupby_col not in df.columns or not has_target:
            return []
        g = df.groupby(groupby_col)[target].agg(["mean", "count"]).reset_index()
        g.columns = [groupby_col, "cvr", "user_cnt"]
        g["cvr"] = g["cvr"].round(4)
        return g.sort_values("user_cnt", ascending=False).head(8).to_dict("records")

    def safe_pct(col: str) -> dict:
        if col not in df.columns:
            return {}
        try:
            d = df[col].value_counts(normalize=True).round(4).head(8).to_dict()
            return {str(k): v for k, v in d.items()}
        except Exception:
            return {}

    def safe_desc(col: str, pcts: tuple = (0.1, 0.25, 0.5, 0.75, 0.9)) -> dict:
        if col not in df.columns:
            return {}
        total = len(df)
        s_raw = df[col]
        null_cnt = int(s_raw.isna().sum())
        s = s_raw.dropna()
        valid_cnt = len(s)
        result: dict[str, Any] = {
            "null_cnt": null_cnt,
            "null_rate": round(null_cnt / total, 4) if total else 0,
            "valid_cnt": valid_cnt,
        }
        if valid_cnt == 0:
            return result
        try:
            result["mean"] = round(float(s.mean()), 2)
            result["median"] = round(float(s.median()), 2)
            for p in pcts:
                result[f"p{int(p * 100)}"] = round(float(s.quantile(p)), 2)
        except Exception:
            pass
        return result

    # ── 1. 数据基础 ──────────────────────────────────────────────────────────
    _null_rates = {col: float(df[col].isna().mean()) for col in df.columns}
    _coverage_cols = [c for c in df.columns if c not in _BUSINESS_NULL_COLS]
    overview["data_basic"] = {
        "total_rows": len(df),
        "total_columns": len(df.columns),
        "null_rate_by_col": {
            col: round(_null_rates[col], 3)
            for col in df.columns
            if _null_rates[col] > 0.1
        },
        "feature_coverage_pct": round(
            float((df[_coverage_cols].notna().mean() > 0.5).mean()), 3
        ) if _coverage_cols else 0.0,
        "activity_channel_dist": safe_pct("activity_channel_std"),
        "touch_date_range": {
            "min": str(df["touch_date"].min()) if "touch_date" in df.columns else None,
            "max": str(df["touch_date"].max()) if "touch_date" in df.columns else None,
        },
    }

    # ── 2. 整体转化 ──────────────────────────────────────────────────────────
    if has_target:
        converted = int(df[target].sum())
        total = len(df)
        order_created = int(df["pre_create_order_cnt"].sum()) if "pre_create_order_cnt" in df.columns else None
        paid = int(df["is_paid"].sum()) if "is_paid" in df.columns else None
        overview["conversion_summary"] = {
            "total_users": total,
            "converted": converted,
            "not_converted": total - converted,
            "overall_cvr": round(converted / total, 4) if total else 0,
            "paid": paid,
            "paid_rate": round(paid / total, 4) if paid is not None and total else None,
        }
        key_cols = [
            "pre_total_event_cnt", "pre_mainflow_event_cnt", "pre_mkt_touch_cnt",
            "pre_coupon_collect_cnt", "pre_max_funnel_depth", "activity_touch_cnt",
        ]
        comp = {}
        for col in key_cols:
            if col not in df.columns:
                continue
            cv = df[df[target] == 1][col].replace(-1, np.nan).mean()
            nc = df[df[target] == 0][col].replace(-1, np.nan).mean()
            comp[col] = {
                "converted_mean": round(float(cv), 2) if pd.notna(cv) else None,
                "not_converted_mean": round(float(nc), 2) if pd.notna(nc) else None,
            }
        overview["conversion_summary"]["key_feature_comparison"] = comp

    # ── 3. 平台 & 活跃度 ─────────────────────────────────────────────────────
    overview["platform"] = {
        "primary_platform_dist": safe_pct("pre_primary_platform"),
        "cvr_by_platform": safe_cvr_by("pre_primary_platform"),
        "cross_platform_rate": safe_mean("pre_is_cross_platform"),
        "active_period_dist": safe_pct("pre_first_active_period"),
        "user_active_period_dist": safe_pct("pre_user_active_period"),
        "cvr_by_active_period": safe_cvr_by("pre_first_active_period"),
        "pre_events_per_hour": safe_desc("pre_events_per_hour"),
        "pre_total_event_cnt": safe_desc("pre_total_event_cnt"),
        "pre_active_span_min": safe_desc("pre_active_span_min"),
        "dormant_user_rate": safe_mean("pre_is_dormant_user"),
    }

    # ── 4. 转化漏斗 ─────────────────────────────────────────────────────────
    overview["funnel"] = {
        "funnel_depth_dist": safe_pct("pre_max_funnel_depth"),
        "cvr_by_funnel_depth": safe_cvr_by("pre_max_funnel_depth"),
        "skip_detail_rate": safe_mean("pre_skip_detail_flag"),
        "back_to_list_dist": safe_desc("pre_back_to_list_cnt"),
        "back_to_booking_dist": safe_desc("pre_back_to_booking_cnt"),
        "mainflow_event_cnt": safe_desc("pre_mainflow_event_cnt"),
        "reached_detail_rate": safe_mean("pre_reached_detail"),
        "reached_booking_rate": safe_mean("pre_reached_booking"),
        "reached_payment_rate": safe_mean("pre_reached_payment"),
    }

    # ── 5. 决策周期（度量行为到触达的时间差）──────────────────────────
    overview["decision_cycle"] = {
        col: safe_desc(col)
        for col in [
            "pre_first_expose_to_touch_min",
            "pre_last_mainflow_to_touch_min",
            "pre_last_mkt_to_touch_min",
            "pre_last_order_to_touch_min",
        ]
    }

    # ── 6. 营销渠道（历史 + 当次）───────────────────────────────────────────
    channels = {}
    for ch_name, touch_col in _V2_CHANNEL_TOUCH_COLS.items():
        if touch_col not in df.columns:
            continue
        touched_mask = df[touch_col] > 0
        touched_cnt = int(touched_mask.sum())
        cvr_touched, cvr_not = None, None
        if has_target and touched_cnt > 0:
            cvr_touched = round(float(df.loc[touched_mask, target].mean()), 4)
        if has_target and (~touched_mask).sum() > 0:
            cvr_not = round(float(df.loc[~touched_mask, target].mean()), 4)
        channels[ch_name] = {
            "historically_touched_cnt": touched_cnt,
            "historically_touched_rate": round(touched_cnt / len(df), 4) if len(df) > 0 else 0,
            "avg_touch_cnt": round(float(df.loc[touched_mask, touch_col].mean()), 2) if touched_cnt > 0 else 0,
            "cvr_if_touched": cvr_touched,
            "cvr_if_not_touched": cvr_not,
        }
    overview["marketing_channels"] = {
        "channels": channels,
        "current_activity_channel_dist": safe_pct("activity_channel_std"),
        "cvr_by_current_channel": safe_cvr_by("activity_channel_std"),
        "mkt_trigger_mainflow_dist": safe_desc("pre_mkt_trigger_mainflow_cnt"),
        "mkt_fatigue_cnt_dist": safe_desc("pre_mkt_fatigue_cnt"),
        "over_touch_flag_rate": safe_mean("activity_over_touch_flag"),
        "has_any_touch_rate": float((df["pre_mkt_touch_cnt"] > 0).mean()) if "pre_mkt_touch_cnt" in df.columns else None,
        "min_response_sec": safe_desc("pre_min_mkt_response_sec"),
    }

    # ── 7. 产品偏好 ──────────────────────────────────────────────────────────
    product_browse_map = {
        "hotel":  "pre_browse_hotel",
        "flight": "pre_browse_flight",
        "train":  "pre_browse_train",
        "scenic": "pre_browse_scenic",
        "car":    "pre_browse_car",
        "bus":    "pre_browse_bus",
        "intl":   "pre_browse_intl",
    }
    products: dict[str, dict] = {}
    for prod, browse_col in product_browse_map.items():
        if browse_col not in df.columns:
            continue
        mask = df[browse_col] == 1
        products[prod] = {
            "browse_rate": round(float(df[browse_col].mean()), 4),
            "cvr_if_browsed": round(float(df.loc[mask, target].mean()), 4) if has_target and mask.sum() > 0 else None,
            "cvr_if_not_browsed": round(float(df.loc[~mask, target].mean()), 4) if has_target and (~mask).sum() > 0 else None,
        }
    overview["product_preference"] = {
        "products": products,
        "top_interest_product_dist": safe_pct("pre_top_interest_product"),
        "cross_category_browse_rate": safe_mean("pre_is_cross_category"),
        "mkt_product_browse_match_rate": safe_mean("pre_mkt_product_browse_match"),
        "target_product_visit_cnt": safe_desc("pre_target_product_visit_cnt"),
        "search_target_product_rate": safe_mean("pre_search_target_product"),
    }

    # ── 8. 优惠使用 ──────────────────────────────────────────────────────────
    rp_cols = [c for c in df.columns if c.startswith("pre_rp_") and c != "pre_rp_target_product"]
    has_coupon_mask = (df["pre_coupon_collect_cnt"] > 0) if "pre_coupon_collect_cnt" in df.columns else pd.Series(False, index=df.index)
    coupon_cvr_comp: dict = {}
    if has_target and "pre_coupon_collect_cnt" in df.columns:
        coupon_cvr_comp = {
            "cvr_with_coupon": round(float(df.loc[has_coupon_mask, target].mean()), 4) if has_coupon_mask.sum() > 0 else None,
            "cvr_without_coupon": round(float(df.loc[~has_coupon_mask, target].mean()), 4) if (~has_coupon_mask).sum() > 0 else None,
            "users_with_coupon": int(has_coupon_mask.sum()),
            "users_without_coupon": int((~has_coupon_mask).sum()),
        }
    overview["coupon_usage"] = {
        "pre_coupon_collect_cnt": safe_desc("pre_coupon_collect_cnt", pcts=(0.25, 0.5, 0.75, 0.9)),
        "rp_collect_rates": {col: safe_mean(col) for col in rp_cols},
        "rp_target_product_rate": safe_mean("pre_rp_target_product"),
        "has_blackwhale_rate": safe_mean("pre_has_blackwhale"),
        "cvr_comparison": coupon_cvr_comp,
    }

    # ── 9. 首页内容触达 ────────────────────────────────────────────────────
    homepage_exposure_cols = [
        c for c in df.columns
        if (c.endswith("_exposed") or c.endswith("_viewed")) and c.startswith("pre_")
    ]
    exp_cvr: dict = {}
    if has_target:
        for col in homepage_exposure_cols:
            mask = df[col] == 1
            if mask.sum() > 10:
                exp_cvr[col] = round(float(df.loc[mask, target].mean()), 4)

    intent_signal_cols = [
        c for c in [
            "pre_pending_pay_viewed", "pre_pending_trip_viewed",
            "pre_add_to_desktop_exposed", "pre_new_user_zone_exposed",
            "pre_ai_entry_exposed",
        ]
        if c in df.columns
    ]
    intent_signal_cvr: dict = {}
    if has_target:
        for col in intent_signal_cols:
            mask = df[col] == 1
            n = int(mask.sum())
            if n < 5:
                continue
            intent_signal_cvr[col] = {
                "touch_rate": round(float(df[col].mean()), 4),
                "user_cnt": n,
                "cvr_if_touched": round(float(df.loc[mask, target].mean()), 4),
            }

    overview["homepage_exposure"] = {
        "homepage_event_cnt": safe_desc("pre_homepage_event_cnt"),
        "homepage_module_cnt": safe_desc("pre_homepage_module_cnt"),
        "exposure_rates": {col: safe_mean(col) for col in homepage_exposure_cols},
        "cvr_by_exposure": exp_cvr,
        "intent_signal_cvr": intent_signal_cvr,
    }

    # ── 10. 行为路径 ─────────────────────────────────────────────────────────
    overview["behavior_path"] = {
        "first_touch_model_dist": safe_pct("pre_first_touch_model"),
        "last_touch_model_dist": safe_pct("pre_last_touch_model"),
        "is_marketing_first_rate": safe_mean("pre_is_marketing_first"),
        "is_marketing_last_rate": safe_mean("pre_is_marketing_last"),
        "search_match_target_rate": safe_mean("pre_search_match_target"),
        "top_paths": (
            df["pre_path_model_seq"].value_counts().head(10).reset_index()
              .rename(columns={"pre_path_model_seq": "path", "count": "freq"})
              .to_dict("records")
        ) if "pre_path_model_seq" in df.columns else [],
        "last_mkt_channel_dist": safe_pct("pre_last_mkt_channel"),
    }

    # ── 11. 会员权益 ─────────────────────────────────────────────────────────
    member_cols_v2 = [
        "pre_viewed_member_assets", "pre_black_whale_interest", "pre_checkin_triggered",
        "pre_activity_nav_viewed", "pre_highlight_activity_viewed",
    ]
    member_cvr: dict = {}
    if has_target:
        for col in member_cols_v2:
            if col not in df.columns:
                continue
            mask = df[col] == 1
            if mask.sum() > 10:
                member_cvr[col] = round(float(df.loc[mask, target].mean()), 4)
    overview["member_rights"] = {
        "engagement_rates": {col: safe_mean(col) for col in member_cols_v2},
        "cvr_by_engagement": member_cvr,
    }

    # ── 12. 诊断规则汇总（需传入 diagnostic_engine）─────────────────────────
    if diagnostic_engine is not None:
        try:
            rule_summary_df = diagnostic_engine.rule_summary(df)
            # 仅保留关键列，避免 JSON 过大
            overview["diagnostic_rules_summary"] = rule_summary_df[[
                "rule_id", "category", "name", "status",
                "trigger_rate", "trigger_cnt", "total_cnt",
                "cvr_triggered", "cvr_not_triggered", "cvr_gap",
            ]].to_dict("records")
        except Exception as e:
            overview["diagnostic_rules_summary"] = {"error": str(e)}
    else:
        overview["diagnostic_rules_summary"] = None

    # ── run meta ────────────────────────────────────────────────────────────
    overview["run_meta"] = {
        "campaign_id": campaign_id,
        "dimensions_executed": [k for k in overview.keys()],
    }

    return overview
