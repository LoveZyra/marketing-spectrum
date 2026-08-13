"""价格敏感度维度统计代码片段（用户-活动粒度）。

涉及特征：领券计数 pre_coupon_collect_cnt；各品类红包 pre_rp_*；黑鲸
pre_has_blackwhale / pre_rp_blackwhale_card；目标品类红包 pre_rp_target_product；
领券时序用首末领券时间戳 pre_first/last_coupon_time。
"""
from __future__ import annotations

import pandas as pd

from snippets.stats_utils import chi2_test, wilson_ci


def analyze_price_sensitivity(df: pd.DataFrame) -> pd.DataFrame:
    """汇总优惠券领取分布 + 品类红包 + 领券 vs 未领券 CVR。

    额外输出各组的 Wilson CI 以及组间差异的卡方 p_value。
    """
    ref = df

    # ── 1. 领券数分布（pre_coupon_collect_cnt）────────────────────────────────
    if "pre_coupon_collect_cnt" in ref.columns:
        coupon_dist = (
            ref["pre_coupon_collect_cnt"]
            .describe(percentiles=[0.25, 0.5, 0.75, 0.9])
            .reset_index()
        )
    else:
        coupon_dist = pd.DataFrame()

    # ── 2. 各品类红包领取率（pre_rp_*）──────────────────────────────────────
    rp_cols = [
        c for c in ref.columns
        if c.startswith("pre_rp_") and c != "pre_rp_target_product"
    ]
    if rp_cols:
        rp_stats = ref[rp_cols].mean().reset_index()
        rp_stats.columns = ["coupon_type", "collect_rate"]
    else:
        rp_stats = pd.DataFrame()

    # ── 3. 关键比例指标──────────────────────────────────────────────────────
    price_driven_rate = float(ref["pre_rp_target_product"].mean()) if "pre_rp_target_product" in ref.columns else None
    blackwhale_rate = float(ref["pre_rp_blackwhale_card"].mean()) if "pre_rp_blackwhale_card" in ref.columns else None
    has_blackwhale_rate = float(ref["pre_has_blackwhale"].mean()) if "pre_has_blackwhale" in ref.columns else None

    # ── 4. 领券 vs 未领券 CVR 对比（含 Wilson CI 与卡方 p_value）────────────
    if "pre_coupon_collect_cnt" in ref.columns and "is_converted" in ref.columns:
        tagged = ref.assign(has_coupon=(ref["pre_coupon_collect_cnt"] > 0).astype(int))
        coupon_cvr = (
            tagged.groupby("has_coupon")["is_converted"]
                  .agg(["mean", "count", "sum"])
                  .rename(columns={"mean": "cvr", "count": "user_cnt", "sum": "converted_cnt"})
                  .reset_index()
        )
        coupon_cvr["ci_low"] = coupon_cvr.apply(
            lambda r: round(wilson_ci(r["cvr"], int(r["user_cnt"]))[0], 4), axis=1)
        coupon_cvr["ci_high"] = coupon_cvr.apply(
            lambda r: round(wilson_ci(r["cvr"], int(r["user_cnt"]))[1], 4), axis=1)
        if len(coupon_cvr) == 2:
            r0 = coupon_cvr.iloc[0]
            r1 = coupon_cvr.iloc[1]
            table = [
                [int(r0["converted_cnt"]), int(r0["user_cnt"] - r0["converted_cnt"])],
                [int(r1["converted_cnt"]), int(r1["user_cnt"] - r1["converted_cnt"])],
            ]
            _, p_val, _ = chi2_test(table)
            coupon_cvr["diff_p_value"] = round(p_val, 4) if not pd.isna(p_val) else None
        else:
            coupon_cvr["diff_p_value"] = None
    else:
        coupon_cvr = pd.DataFrame()

    # ── 5. 领券数量-创单率曲线（pre_coupon_collect_cnt 分桶）────────────────
    if "pre_coupon_collect_cnt" in ref.columns and "is_converted" in ref.columns:
        _bins   = [-1, 0, 1, 2, 3, 4, float("inf")]
        _labels = ["0张", "1张", "2张", "3张", "4张", "5张+"]
        _tmp = ref.copy()
        _tmp["_cnt_bucket"] = pd.cut(
            _tmp["pre_coupon_collect_cnt"], bins=_bins, labels=_labels, right=True
        )
        coupon_cnt_cvr = (
            _tmp.groupby("_cnt_bucket", observed=True)["is_converted"]
                .agg(user_cnt="count", converted="sum")
                .assign(cvr=lambda x: (x["converted"] / x["user_cnt"]).round(4))
                .reset_index()
                .rename(columns={"_cnt_bucket": "coupon_cnt_bucket"})
        )
        coupon_cnt_cvr["cvr_ci_low"] = coupon_cnt_cvr.apply(
            lambda r: round(wilson_ci(r["cvr"], int(r["user_cnt"]))[0], 4), axis=1
        )
        coupon_cnt_cvr["cvr_ci_high"] = coupon_cnt_cvr.apply(
            lambda r: round(wilson_ci(r["cvr"], int(r["user_cnt"]))[1], 4), axis=1
        )
    else:
        coupon_cnt_cvr = pd.DataFrame()

    # ── 6. 目标品类红包匹配度 × 创单率（pre_rp_target_product）──────────────
    rp_match_rows = []
    if "pre_rp_target_product" in ref.columns and "is_converted" in ref.columns:
        for val, label in [(1, "已领目标品类红包"), (0, "未领目标品类红包")]:
            mask = ref["pre_rp_target_product"] == val
            n = int(mask.sum())
            if n == 0:
                continue
            cvr = float(ref.loc[mask, "is_converted"].mean())
            ci_low, ci_high = wilson_ci(cvr, n)
            rp_match_rows.append({
                "rp_match": label,
                "user_cnt": n,
                "cvr": round(cvr, 4),
                "cvr_ci_low": round(ci_low, 4),
                "cvr_ci_high": round(ci_high, 4),
            })
    rp_match_df = pd.DataFrame(rp_match_rows)

    # ── 7. 黑鲸会员兴趣 × CVR──────────────────────────────────────────────────
    blackwhale_cvr_rows = []
    if "pre_has_blackwhale" in ref.columns and "is_converted" in ref.columns:
        for val, label in [(1, "有黑鲸领取"), (0, "无黑鲸领取")]:
            mask = ref["pre_has_blackwhale"] == val
            n = int(mask.sum())
            if n < 5:
                continue
            cvr = float(ref.loc[mask, "is_converted"].mean())
            blackwhale_cvr_rows.append({
                "blackwhale": label, "user_cnt": n, "cvr": round(cvr, 4),
            })
    blackwhale_cvr_df = pd.DataFrame(blackwhale_cvr_rows)

    return pd.concat([
        coupon_dist.assign(_section="领券数分布"),
        rp_stats.assign(_section="品类红包领取率"),
        coupon_cvr.assign(_section="领券 vs 未领券创单率"),
        coupon_cnt_cvr.assign(_section="领券数量-创单率曲线"),
        rp_match_df.assign(_section="目标品类红包匹配-创单率"),
        blackwhale_cvr_df.assign(_section="黑鲸会员兴趣-创单率"),
        pd.DataFrame([{
            "price_driven_rate": price_driven_rate,
            "blackwhale_rate": blackwhale_rate,
            "has_blackwhale_rate": has_blackwhale_rate,
            "_section": "关键比例指标",
        }]),
    ], ignore_index=True)
