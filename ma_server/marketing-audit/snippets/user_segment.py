"""用户兴趣分群维度统计代码片段（用户-活动粒度）。

涉及特征：品类浏览 pre_browse_*；品类深度 pre_*_depth；跨品类 pre_is_cross_category；
品类匹配度 pre_mkt_product_browse_match；最高兴趣品类 pre_top_interest_product；
目标品类搜索 pre_search_target_product；目标品类红包 pre_rp_target_product；
渠道触达由 pre_*_touch_cnt>0 派生；首页/模块曝光 pre_* 前缀。
"""
from __future__ import annotations

import pandas as pd

# V2 品类浏览字段映射（品类名 → (browse_flag, depth_col)）
_V2_PRODUCTS: dict[str, tuple[str, str | None]] = {
    "hotel":  ("pre_browse_hotel",  "pre_hotel_depth"),
    "flight": ("pre_browse_flight", "pre_flight_depth"),
    "train":  ("pre_browse_train",  "pre_train_depth"),
    "scenic": ("pre_browse_scenic", "pre_scenic_depth"),
    "car":    ("pre_browse_car",    None),
    "bus":    ("pre_browse_bus",    None),
    "intl":   ("pre_browse_intl",   None),
}

# V2 渠道历史触达计数字段
_V2_TOUCH_CNT_COLS: dict[str, str] = {
    "popup":      "pre_popup_touch_cnt",
    "push":       "pre_push_touch_cnt",
    "sms":        "pre_sms_touch_cnt",
    "ads":        "pre_ads_touch_cnt",
    "insite_msg": "pre_insite_msg_touch_cnt",
}


def analyze_user_segment(df: pd.DataFrame) -> pd.DataFrame:
    """汇总品类偏好 + 首页模块曝光 + 跨品类与匹配度统计。"""
    ref = df

    # ── 1. 品类浏览率与深度（含各品类 CVR 对比）──────────────────────────────
    product_stats = []
    for product, (browse_col, depth_col) in _V2_PRODUCTS.items():
        if browse_col not in ref.columns:
            continue
        row: dict = {
            "product": product,
            "browse_rate": round(float(ref[browse_col].mean()), 4),
            "avg_depth": round(float(ref[depth_col].mean()), 2) if depth_col and depth_col in ref.columns else None,
        }
        if "is_converted" in ref.columns:
            mask = ref[browse_col] == 1
            row["cvr_if_browsed"] = round(float(ref.loc[mask, "is_converted"].mean()), 4) if mask.sum() > 0 else None
            row["cvr_if_not_browsed"] = round(float(ref.loc[~mask, "is_converted"].mean()), 4) if (~mask).sum() > 0 else None
        product_stats.append(row)
    product_df = pd.DataFrame(product_stats)

    # ── 2. 跨品类浏览与品类匹配度──────────────────────────────────────────────
    cross_browse = float(ref["pre_is_cross_category"].mean()) if "pre_is_cross_category" in ref.columns else None
    match_rate = float(ref["pre_mkt_product_browse_match"].mean()) if "pre_mkt_product_browse_match" in ref.columns else None

    # ── 3. 首页/内容曝光模块率（pre_*_exposed / pre_*_viewed）────────────────
    homepage_cols = [c for c in ref.columns if (c.endswith("_exposed") or c.endswith("_viewed")) and c.startswith("pre_")]
    if homepage_cols:
        homepage_stats = ref[homepage_cols].mean().reset_index()
        homepage_stats.columns = ["module", "exposure_rate"]
    else:
        homepage_stats = pd.DataFrame()

    # ── 4. 最高兴趣品类分布（pre_top_interest_product）──────────────────────
    if "pre_top_interest_product" in ref.columns:
        top_interest = ref["pre_top_interest_product"].value_counts(normalize=True).reset_index()
    else:
        top_interest = pd.DataFrame()

    # ── 5. 品类浏览组合 × CVR──────────────────────────────────────────────────
    browse_flag_cols = [
        c for c in ["pre_browse_hotel", "pre_browse_flight", "pre_browse_train", "pre_browse_scenic"]
        if c in ref.columns
    ]
    if browse_flag_cols and "is_converted" in ref.columns:
        _tmp = ref[browse_flag_cols + ["is_converted"]].copy()
        _cnt = _tmp[browse_flag_cols].sum(axis=1)
        _label_map = {0: "无品类浏览", 1: "单品类", 2: "双品类", 3: "三品类+"}
        _tmp["_combo_label"] = _cnt.map(lambda n: _label_map.get(min(n, 3), "三品类+"))
        combo_cvr = (
            _tmp.groupby("_combo_label")["is_converted"]
                .agg(user_cnt="count", converted="sum")
                .assign(cvr=lambda x: (x["converted"] / x["user_cnt"]).round(4))
                .reset_index()
                .rename(columns={"_combo_label": "browse_combo"})
        )
    else:
        combo_cvr = pd.DataFrame()

    # ── 6. 品类浏览深度 × CVR──────────────────────────────────────────────────
    depth_cvr_rows = []
    if "is_converted" in ref.columns:
        for product, (_, depth_col) in _V2_PRODUCTS.items():
            if depth_col is None or depth_col not in ref.columns:
                continue
            for depth_val in sorted(ref[depth_col].dropna().unique()):
                mask = ref[depth_col] == depth_val
                n = int(mask.sum())
                if n < 5:
                    continue
                depth_cvr_rows.append({
                    "product": product,
                    "browse_depth": int(depth_val),
                    "user_cnt": n,
                    "cvr": round(float(ref.loc[mask, "is_converted"].mean()), 4),
                })
    depth_cvr_df = pd.DataFrame(depth_cvr_rows)

    # ── 7. 品类一致性信号 × CVR──────────────────────────────────────────────
    consistency_rows = []
    for col, label in [
        ("pre_search_target_product",    "搜索-目标品类一致"),
        ("pre_rp_target_product",        "红包-目标品类一致"),
        ("pre_mkt_product_browse_match", "浏览-营销品类匹配"),
    ]:
        if col not in ref.columns or "is_converted" not in ref.columns:
            continue
        for val, lbl in [(1, f"{label}=是"), (0, f"{label}=否")]:
            mask = ref[col] == val
            n = int(mask.sum())
            if n < 5:
                continue
            consistency_rows.append({
                "consistency_signal": lbl,
                "user_cnt": n,
                "cvr": round(float(ref.loc[mask, "is_converted"].mean()), 4),
            })
    consistency_df = pd.DataFrame(consistency_rows)

    # ── 8. 品类×当次渠道创单率矩阵──────────────────────────────────────────────
    browse_channel_rows = []
    if "activity_channel_std" in ref.columns and "is_converted" in ref.columns:
        for product, (browse_col, _) in _V2_PRODUCTS.items():
            if browse_col not in ref.columns:
                continue
            sub = ref[ref[browse_col] == 1]
            if len(sub) < 20:
                continue
            ch_grp = (
                sub.groupby("activity_channel_std", dropna=False)["is_converted"]
                   .agg(user_cnt="count", converted="sum")
                   .assign(cvr=lambda x: (x["converted"] / x["user_cnt"]).round(4))
                   .reset_index()
            )
            ch_grp.insert(0, "product", product)
            browse_channel_rows.append(ch_grp[ch_grp["user_cnt"] >= 10])
    browse_channel_df = pd.concat(browse_channel_rows, ignore_index=True) if browse_channel_rows else pd.DataFrame()

    return pd.concat([
        product_df.assign(_section="品类浏览率与深度"),
        homepage_stats.assign(_section="首页模块曝光率"),
        top_interest.assign(_section="最高兴趣品类分布"),
        pd.DataFrame([{
            "cross_browse_rate": cross_browse,
            "mkt_product_browse_match_rate": match_rate,
            "_section": "跨品类与匹配度",
        }]),
        combo_cvr.assign(_section="品类组合-创单率"),
        depth_cvr_df.assign(_section="品类浏览深度-创单率"),
        consistency_df.assign(_section="品类一致性信号-创单率"),
        browse_channel_df.assign(_section="品类×渠道创单率矩阵"),
    ], ignore_index=True)
