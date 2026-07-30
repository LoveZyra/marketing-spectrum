"""sample_data — 生成营销审计 skill 的小样本宽表（V2 用户-活动粒度）。

字段族与 feature_registry.yaml / user_activity_features_v2.md 对应。

公开函数：
  - generate_sample(n_rows=2000, seed=42, cvr=0.10) -> pd.DataFrame
  - save_sample_parquet(path, **kwargs) -> str
  - default_campaign_meta() -> dict
"""
from __future__ import annotations

import numpy as np
import pandas as pd

PRODUCTS = ["酒店", "机票", "火车票", "景区", "用车", "汽车票"]
PLATFORMS = ["同程APP", "微信", "艺龙APP"]
PERIODS = ["上午", "下午", "晚上", "深夜"]


def generate_sample(n_rows: int = 2000, seed: int = 42, cvr: float = 0.10) -> pd.DataFrame:
    """生成 n_rows 行用户-活动宽表（V2 字段体系）。"""
    rng = np.random.default_rng(seed)
    df = pd.DataFrame({
        "mapid": [f"u_{i:06d}" for i in range(n_rows)],
    })

    # ── 活动维度信息 ────────────────────────────────────────────────
    df["activity_name"] = "五一酒店大促"
    df["activity_id"] = "act_001"
    df["activity_channel"] = rng.choice(["弹屏", "Push", "短信", "广告", "站内信"], n_rows,
                                          p=[0.20, 0.30, 0.15, 0.20, 0.15])
    df["activity_channel_std"] = df["activity_channel"].map({
        "弹屏": "popup", "Push": "push", "短信": "sms", "广告": "ads", "站内信": "insite_msg",
    })
    df["activity_product_name"] = "酒店"
    df["touch_date"] = "2026-05-01"
    df["touch_period"] = rng.choice(PERIODS, n_rows, p=[0.20, 0.30, 0.35, 0.15])
    df["activity_touch_cnt"] = rng.poisson(1.5, n_rows).clip(1, 8)
    df["activity_click_cnt"] = (rng.poisson(0.3, n_rows)).clip(0, 5)
    df["is_activity_clicked"] = (df["activity_click_cnt"] > 0).astype(int)
    df["activity_over_touch_flag"] = (df["activity_touch_cnt"] >= 5).astype(int)

    # ── 核心标签 ─────────────────────────────────────────────────────
    df["is_converted"] = (rng.random(n_rows) < cvr).astype(int)
    df["is_paid"] = np.where(df["is_converted"] == 1,
                              (rng.random(n_rows) < 0.75).astype(int), 0)
    df["convert_product"] = np.where(df["is_converted"] == 1, "酒店", None)
    converted_mask = df["is_converted"] == 1

    # ── 营销时机匹配 ─────────────────────────────────────────────────
    df["pre_user_active_period"] = rng.choice(PERIODS, n_rows, p=[0.25, 0.35, 0.30, 0.10])
    df["period_mismatch_flag"] = (df["touch_period"] != df["pre_user_active_period"]).astype(int)

    # ── 触达前决策周期 ────────────────────────────────────────────────
    df["pre_first_expose_to_touch_min"] = rng.gamma(3.0, 40, n_rows).round(1)
    df["pre_last_mainflow_to_touch_min"] = rng.gamma(2.0, 20, n_rows).round(1)
    df["pre_last_mkt_to_touch_min"] = rng.gamma(2.0, 60, n_rows).round(1)
    order_exists = rng.random(n_rows) < 0.30
    last_order = np.full(n_rows, np.nan)
    last_order[order_exists] = rng.gamma(2.0, 120, order_exists.sum()).round(1)
    df["pre_last_order_to_touch_min"] = last_order

    # ── 触达前漏斗 ────────────────────────────────────────────────────
    df["pre_max_funnel_depth"] = rng.choice([0, 1, 2, 3, 4, 5], n_rows, p=[0.05, 0.15, 0.25, 0.25, 0.15, 0.15])
    df["pre_target_product_funnel_depth"] = (df["pre_max_funnel_depth"] * (rng.random(n_rows) < 0.7)).astype(int)
    df["pre_funnel_pages_cnt"] = df["pre_max_funnel_depth"].clip(0, 5)
    df["pre_mainflow_event_cnt"] = (df["pre_max_funnel_depth"] * rng.poisson(3, n_rows)).clip(0)
    for col, depth_thresh in [("pre_reached_homepage", 1), ("pre_reached_list", 2),
                               ("pre_reached_detail", 3), ("pre_reached_booking", 4),
                               ("pre_reached_payment", 5)]:
        df[col] = (df["pre_max_funnel_depth"] >= depth_thresh).astype(int)
    df["pre_back_to_list_cnt"] = rng.poisson(0.6, n_rows)
    df["pre_back_to_booking_cnt"] = rng.poisson(0.2, n_rows)
    df["pre_skip_detail_flag"] = (rng.random(n_rows) < 0.12).astype(int)
    df["pre_total_touch_cnt"] = rng.poisson(20, n_rows)
    df["pre_browse_target_product"] = (df["pre_target_product_funnel_depth"] > 0).astype(int)
    df["pre_target_product_visit_cnt"] = (df["pre_browse_target_product"] * rng.poisson(3, n_rows))

    # ── 触达前历史营销 ────────────────────────────────────────────────
    df["pre_mkt_touch_cnt"] = rng.poisson(3, n_rows).clip(0, 20)
    df["pre_mkt_channel_cnt"] = rng.choice([0, 1, 2, 3], n_rows, p=[0.10, 0.40, 0.35, 0.15])
    for ch, rate in [("popup", 0.35), ("push", 0.55), ("sms", 0.22), ("ads", 0.28),
                     ("insite_msg", 0.18), ("activity", 0.40)]:
        touched = (rng.random(n_rows) < rate).astype(int)
        df[f"pre_touched_{ch}"] = touched
        cnt = np.zeros(n_rows, dtype=int)
        cnt[touched == 1] = rng.poisson(2, touched.sum()).clip(1)
        df[f"pre_{ch}_touch_cnt"] = cnt
    df["pre_popup_click_cnt"] = (df["pre_popup_touch_cnt"] * (rng.random(n_rows) < 0.08)).astype(int)
    df["pre_push_click_cnt"] = (df["pre_push_touch_cnt"] * (rng.random(n_rows) < 0.05)).astype(int)
    df["pre_mkt_click_cnt"] = df["pre_popup_click_cnt"] + df["pre_push_click_cnt"]
    df["pre_has_mkt_click"] = (df["pre_mkt_click_cnt"] > 0).astype(int)
    df["pre_popup_click_rate"] = np.where(df["pre_popup_touch_cnt"] > 0,
                                           df["pre_popup_click_cnt"] / df["pre_popup_touch_cnt"].clip(1), None)
    df["pre_push_click_rate"] = np.where(df["pre_push_touch_cnt"] > 0,
                                          df["pre_push_click_cnt"] / df["pre_push_touch_cnt"].clip(1), None)
    df["pre_mkt_fatigue_cnt"] = rng.poisson(0.4, n_rows)
    df["pre_mkt_direct_exit_cnt"] = rng.poisson(0.2, n_rows)
    df["pre_popup_reject_cnt"] = rng.poisson(0.3, n_rows)
    df["pre_funnel_regression_after_mkt"] = rng.poisson(0.3, n_rows)
    df["pre_mkt_trigger_mainflow_cnt"] = rng.poisson(0.5, n_rows)
    df["pre_over_mkt_flag"] = (df["pre_mkt_touch_cnt"] >= 5).astype(int)
    resp_sec = np.full(n_rows, np.nan)
    resp_mask = rng.random(n_rows) < 0.40
    resp_sec[resp_mask] = rng.gamma(2.0, 120, resp_mask.sum()).round(0)
    df["pre_min_mkt_response_sec"] = resp_sec
    df["pre_unique_activity_cnt"] = rng.poisson(1.5, n_rows).clip(0, 10)
    df["pre_mkt_touched_target_product"] = (rng.random(n_rows) < 0.25).astype(int)

    # ── 触达前产品偏好 ────────────────────────────────────────────────
    for prod, browse_col, depth_col, rate in [
        ("hotel",  "pre_browse_hotel",  "pre_hotel_depth",  0.55),
        ("flight", "pre_browse_flight", "pre_flight_depth", 0.32),
        ("train",  "pre_browse_train",  "pre_train_depth",  0.45),
        ("scenic", "pre_browse_scenic", "pre_scenic_depth", 0.18),
    ]:
        browsed = (rng.random(n_rows) < rate).astype(int)
        df[browse_col] = browsed
        depth = np.zeros(n_rows, dtype=int)
        depth[browsed == 1] = rng.choice([1, 2, 3, 4, 5], browsed.sum(), p=[0.10, 0.25, 0.35, 0.20, 0.10])
        df[depth_col] = depth
    for prod, col, rate in [("car", "pre_browse_car", 0.12), ("bus", "pre_browse_bus", 0.08),
                              ("intl", "pre_browse_intl", 0.06)]:
        df[col] = (rng.random(n_rows) < rate).astype(int)
    for prod, col, rate in [("hotel", "pre_hotel_visit_cnt", 0.55), ("flight", "pre_flight_visit_cnt", 0.32),
                              ("train", "pre_train_visit_cnt", 0.45), ("scenic", "pre_scenic_visit_cnt", 0.18),
                              ("car", "pre_car_visit_cnt", 0.12), ("bus", "pre_bus_visit_cnt", 0.08)]:
        browsed_mask = df.get(f"pre_browse_{prod.split('_')[0]}", pd.Series(0, index=df.index)) if prod != "scenic" else df.get("pre_browse_scenic", pd.Series(0, index=df.index))
        cnt = np.zeros(n_rows, dtype=int)
        browse_mask = (rng.random(n_rows) < rate)
        cnt[browse_mask] = rng.poisson(3, browse_mask.sum())
        df[col] = cnt
    df["pre_product_category_cnt"] = df[["pre_browse_hotel", "pre_browse_flight", "pre_browse_train",
                                           "pre_browse_scenic", "pre_browse_car", "pre_browse_bus"]].sum(axis=1)
    df["pre_is_cross_category"] = (df["pre_product_category_cnt"] > 1).astype(int)
    df["pre_target_product_depth"] = df["pre_hotel_depth"]
    df["pre_top_interest_product"] = rng.choice(PRODUCTS[:4] + ["无浏览"], n_rows, p=[0.35, 0.20, 0.25, 0.10, 0.10])
    df["pre_mkt_product_browse_match"] = (df["pre_top_interest_product"] == "酒店").astype(int)
    df["pre_has_search"] = (rng.random(n_rows) < 0.42).astype(int)
    df["pre_search_cnt"] = (df["pre_has_search"] * rng.poisson(2, n_rows))
    for col, rate in [("pre_search_hotel", 0.30), ("pre_search_flight", 0.18),
                       ("pre_search_train", 0.22), ("pre_search_scenic", 0.10)]:
        df[col] = (rng.random(n_rows) < rate).astype(int)
    df["pre_search_target_product"] = (rng.random(n_rows) < 0.28).astype(int)

    # ── 触达前红包偏好 ────────────────────────────────────────────────
    df["pre_coupon_collect_cnt"] = rng.poisson(0.8, n_rows)
    df["pre_has_coupon"] = (df["pre_coupon_collect_cnt"] > 0).astype(int)
    df["pre_unique_coupon_cnt"] = df["pre_coupon_collect_cnt"].clip(0, 5)
    df["pre_has_blackwhale"] = (rng.random(n_rows) < 0.04).astype(int)
    for col, rate in [("pre_rp_hotel", 0.18), ("pre_rp_flight", 0.12), ("pre_rp_train", 0.10),
                       ("pre_rp_scenic", 0.05), ("pre_rp_car", 0.03), ("pre_rp_bus", 0.02),
                       ("pre_rp_vacation", 0.06), ("pre_rp_payment", 0.22),
                       ("pre_rp_blackwhale_card", 0.04)]:
        df[col] = (rng.random(n_rows) < rate).astype(int)
    df["pre_rp_target_product"] = (rng.random(n_rows) < 0.15).astype(int)
    df["pre_unique_coupon_product_cnt"] = rng.poisson(0.5, n_rows).clip(0, 5)
    # 首/末领券品类（供典型案例红包事件展示；无领券时为"无"）
    _has_cp = df["pre_has_coupon"] == 1
    df["pre_first_coupon_product"] = np.where(_has_cp, rng.choice(PRODUCTS, n_rows), "无")
    df["pre_last_coupon_product"] = np.where(_has_cp, rng.choice(PRODUCTS, n_rows), "无")

    # ── 触达前平台/活跃度 ─────────────────────────────────────────────
    df["pre_total_event_cnt"] = rng.poisson(25, n_rows)
    df["pre_active_span_min"] = rng.gamma(3.0, 30, n_rows).astype(int).clip(0)
    df["pre_first_active_hour"] = rng.integers(0, 24, n_rows)
    df["pre_first_active_period"] = rng.choice(PERIODS, n_rows, p=[0.20, 0.30, 0.35, 0.15])
    df["pre_model_diversity"] = rng.poisson(5, n_rows).clip(1)
    df["pre_unique_touchpoints"] = rng.poisson(8, n_rows).clip(1)
    df["pre_app_event_cnt"] = rng.poisson(15, n_rows)
    df["pre_wechat_event_cnt"] = rng.poisson(8, n_rows)
    df["pre_yilong_event_cnt"] = rng.poisson(2, n_rows)
    df["pre_is_cross_platform"] = (rng.random(n_rows) < 0.32).astype(int)
    df["pre_primary_platform"] = rng.choice(PLATFORMS, n_rows, p=[0.55, 0.35, 0.10])
    for col, rate in [("pre_morning_cnt", 5), ("pre_afternoon_cnt", 8), ("pre_evening_cnt", 9), ("pre_night_cnt", 3)]:
        df[col] = rng.poisson(rate, n_rows)
    df["pre_events_per_hour"] = (df["pre_total_event_cnt"] / (df["pre_active_span_min"].clip(1) / 60)).round(2)
    df["pre_homepage_event_cnt"] = rng.poisson(8, n_rows)
    df["pre_homepage_module_cnt"] = rng.choice([1, 2, 3, 4], n_rows, p=[0.20, 0.35, 0.30, 0.15])
    for col, rate in [("pre_banner_exposed", 0.62), ("pre_new_user_zone_exposed", 0.10),
                       ("pre_big_promo_exposed", 0.45), ("pre_kongfu_area_exposed", 0.28),
                       ("pre_waterfall_exposed", 0.78), ("pre_tile_area_exposed", 0.35),
                       ("pre_pending_pay_viewed", 0.08), ("pre_pending_trip_viewed", 0.15),
                       ("pre_ai_entry_exposed", 0.18), ("pre_add_to_desktop_exposed", 0.05),
                       ("pre_viewed_member_assets", 0.18), ("pre_black_whale_interest", 0.03),
                       ("pre_checkin_triggered", 0.12), ("pre_activity_nav_viewed", 0.15),
                       ("pre_highlight_activity_viewed", 0.20)]:
        df[col] = (rng.random(n_rows) < rate).astype(int)
    df["pre_is_dormant_user"] = (df["pre_total_event_cnt"] == 0).astype(int)

    # ── 触达前行为路径 ────────────────────────────────────────────────
    first_touch_models = ["营销", "红包", "主流程", "大首页", "搜索"]
    df["pre_first_touch_model"] = rng.choice(first_touch_models, n_rows, p=[0.32, 0.10, 0.30, 0.20, 0.08])
    df["pre_last_touch_model"] = rng.choice(first_touch_models, n_rows, p=[0.25, 0.18, 0.35, 0.12, 0.10])
    df["pre_is_marketing_first"] = (df["pre_first_touch_model"].isin(["营销", "红包"])).astype(int)
    df["pre_is_marketing_last"] = (df["pre_last_touch_model"].isin(["营销", "红包"])).astype(int)
    paths = ["营销->主流程->主流程", "主流程->营销->主流程", "营销->主流程", "主流程->主流程", "营销->营销->主流程"]
    df["pre_path_model_seq"] = rng.choice(paths, n_rows, p=[0.25, 0.20, 0.25, 0.20, 0.10])
    df["pre_path_detail_seq"] = df["pre_path_model_seq"].str.replace("主流程", "详情页").str.replace("营销", "弹屏")
    # majorname 序列（业务名，与 model_seq 同源对齐）：营销→活动名、主流程→品类页
    _major_map = {"营销": "五一酒店大促", "主流程": "酒店详情", "红包": "酒店红包", "搜索": "酒店搜索"}
    df["pre_path_major_seq"] = df["pre_path_model_seq"].apply(
        lambda s: "->".join(_major_map.get(x, x) for x in str(s).split("->"))
    )
    df["pre_path_product_seq"] = np.where(df["pre_browse_hotel"] == 1, "酒店", "")
    df["pre_search_match_target"] = (rng.random(n_rows) < 0.35).astype(int)
    for col in ["pre_first_touch_detail", "pre_first_touch_platform", "pre_first_touch_majorname",
                "pre_last_touch_detail", "pre_last_touch_platform", "pre_last_touch_majorname",
                "pre_last_mainflow_detail", "pre_last_mainflow_product", "pre_last_mainflow_platform",
                "pre_last_mkt_channel"]:
        df[col] = None

    # ── 触达前历史订单 ────────────────────────────────────────────────
    df["pre_create_order_cnt"] = rng.poisson(0.5, n_rows)
    df["pre_complete_order_cnt"] = (df["pre_create_order_cnt"] * (rng.random(n_rows) < 0.7)).astype(int)
    df["pre_has_create_order"] = (df["pre_create_order_cnt"] > 0).astype(int)
    df["pre_has_complete_order"] = (df["pre_complete_order_cnt"] > 0).astype(int)
    df["pre_complete_product_cnt"] = df["pre_complete_order_cnt"].clip(0, 3)
    df["pre_has_target_product_order"] = (rng.random(n_rows) < 0.12).astype(int)
    df["pre_has_target_product_create"] = (rng.random(n_rows) < 0.18).astype(int)
    df["pre_is_repurchase"] = (df["pre_complete_order_cnt"] >= 2).astype(int)
    df["pre_is_target_product_repurchase"] = (rng.random(n_rows) < 0.05).astype(int)
    df["pre_last_order_product"] = np.where(df["pre_has_complete_order"] == 1,
                                              rng.choice(PRODUCTS, n_rows), None)
    df["pre_create_not_complete"] = (
        (df["pre_has_create_order"] == 1) & (df["pre_has_complete_order"] == 0)
    ).astype(int)

    # ── 跨渠道衔接 ────────────────────────────────────────────────────
    has_ads = (rng.random(n_rows) < 0.25).astype(int)
    df["has_ads_touch"] = has_ads
    df["ads_product_name"] = np.where(has_ads == 1, "酒店", None)
    df["has_insite_touch"] = np.where(has_ads == 1, (rng.random(n_rows) < 0.65).astype(int), 0)
    df["first_insite_product_name"] = np.where(
        (has_ads == 1) & (df["has_insite_touch"] == 1), "酒店", None
    )
    df["ads_no_insite_flag"] = np.where(has_ads == 1, 1 - df["has_insite_touch"], 0).astype(int)
    df["ads_insite_match_flag"] = np.where(
        (has_ads == 1) & (df["has_insite_touch"] == 1),
        (rng.random(n_rows) < 0.72).astype(int), None
    )
    df["insite_multi_channel_match_flag"] = np.where(
        df["pre_mkt_channel_cnt"] >= 2, (rng.random(n_rows) < 0.65).astype(int), None
    )
    df["insite_channel_cnt"] = df["pre_mkt_channel_cnt"].clip(0, 4)
    df["insite_product_cnt"] = rng.choice([1, 2, 3], n_rows, p=[0.65, 0.25, 0.10])

    return df


def save_sample_parquet(path: str, n_rows: int = 2000, seed: int = 42, cvr: float = 0.10) -> str:
    df = generate_sample(n_rows=n_rows, seed=seed, cvr=cvr)
    df.to_parquet(path, index=False)
    return path


def default_campaign_meta(campaign_id: str = "sample_campaign") -> dict:
    return {
        "campaign_id": campaign_id,
        "campaign_name": "样本活动 · 五一大促",
        "campaign_type": "大促",
        "start_date": "2026-05-01",
        "end_date": "2026-05-07",
        "target_products": ["酒店"],
        "activity_product_name": "酒店",
        "target_channels": ["popup", "push", "sms"],
        "target_audience": "近 90 天有酒店浏览但未下单的用户",
        "target_platform": "全平台",
        "discount_type": "满减",
        "discount_value": "满300减50",
        "coupon_validity_h": 24,
        "target_cvr": 0.12,
        "benchmark_cvr": 0.10,
    }


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="Generate V2 marketing-audit sample data.")
    ap.add_argument("--out", default="sample_data_v2.parquet")
    ap.add_argument("--n", type=int, default=2000)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--cvr", type=float, default=0.10)
    args = ap.parse_args()
    p = save_sample_parquet(args.out, n_rows=args.n, seed=args.seed, cvr=args.cvr)
    print(f"saved {args.n} rows → {p}")
