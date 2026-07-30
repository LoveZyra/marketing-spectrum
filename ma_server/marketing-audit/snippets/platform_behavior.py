"""平台与活跃度维度统计代码片段（用户-活动粒度）。

涉及特征：主平台 pre_primary_platform；各平台行为量 pre_app/wechat/yilong_event_cnt；
活跃时段 pre_first_active_period；用户主活跃时段 pre_user_active_period（用于时机匹配诊断）；
行为密度 pre_events_per_hour；跨平台 pre_is_cross_platform；沉默用户 pre_is_dormant_user。
"""
from __future__ import annotations

import pandas as pd

from snippets.stats_utils import (
    chi2_test,
    distribution_shape,
    wilson_ci,
)

_MEMBER_COLS_V2 = [
    "pre_viewed_member_assets",
    "pre_black_whale_interest",
    "pre_checkin_triggered",
    "pre_activity_nav_viewed",
    "pre_highlight_activity_viewed",
    "pre_pending_pay_viewed",
    "pre_pending_trip_viewed",
]


def analyze_platform_behavior(df: pd.DataFrame) -> pd.DataFrame:
    """汇总平台分布 + 各平台行为量 + 活跃时段 + 会员权益关注率 + 行为密度 + 跨平台。"""
    ref = df

    # ── 1. 主平台分布（含 CVR + CI + 显著性）──────────────────────────────────
    if "pre_primary_platform" in ref.columns:
        platform_dist = ref["pre_primary_platform"].value_counts(normalize=True).reset_index()
        platform_dist.columns = ["platform", "share"]
        if "is_converted" in ref.columns:
            grp = (
                ref.groupby("pre_primary_platform")["is_converted"]
                   .agg(["mean", "count", "sum"])
            )
            grp.columns = ["cvr", "user_cnt", "converted_cnt"]
            grp = grp.reset_index().rename(columns={"pre_primary_platform": "platform"})
            platform_dist = platform_dist.merge(grp, on="platform", how="left")
            total_conv = int(ref["is_converted"].sum())
            total_n = len(ref)
            cis = platform_dist.apply(
                lambda r: wilson_ci(r.get("cvr", 0) or 0, int(r.get("user_cnt") or 0)),
                axis=1)
            platform_dist["cvr_ci_low"]  = [round(c[0], 4) for c in cis]
            platform_dist["cvr_ci_high"] = [round(c[1], 4) for c in cis]
            p_vals = []
            for _, r in platform_dist.iterrows():
                n_p = int(r.get("user_cnt") or 0)
                c_p = int(r.get("converted_cnt") or 0)
                n_o = total_n - n_p
                c_o = total_conv - c_p
                if n_p > 0 and n_o > 0:
                    _, pv, _ = chi2_test([[c_p, n_p - c_p], [c_o, n_o - c_o]])
                    p_vals.append(round(pv, 4) if not pd.isna(pv) else None)
                else:
                    p_vals.append(None)
            platform_dist["vs_others_p_value"] = p_vals
    else:
        platform_dist = pd.DataFrame()

    # ── 2. 各平台行为量均值──────────────────────────────────────────────────
    platform_evt_cols = [
        c for c in ["pre_app_event_cnt", "pre_wechat_event_cnt", "pre_yilong_event_cnt"]
        if c in ref.columns
    ]
    if platform_evt_cols:
        platform_evt = ref[platform_evt_cols].mean().reset_index()
        platform_evt.columns = ["platform", "avg_events"]
    else:
        platform_evt = pd.DataFrame()

    # ── 3. 活跃时段分布（首次行为时段 + 用户主活跃时段）────────────────────
    period_dfs = []
    for col, label in [
        ("pre_first_active_period", "首次行为时段"),
        ("pre_user_active_period",  "历史主活跃时段"),
        ("touch_period",            "当次触达时段"),
    ]:
        if col in ref.columns:
            d = ref[col].value_counts(normalize=True).reset_index()
            d.columns = ["period", "share"]
            d.insert(0, "period_type", label)
            period_dfs.append(d)
    period_dist = pd.concat(period_dfs, ignore_index=True) if period_dfs else pd.DataFrame()

    # ── 4. 时机匹配诊断（period_mismatch_flag × CVR）────────────────────────
    mismatch_df = pd.DataFrame()
    if "period_mismatch_flag" in ref.columns and "is_converted" in ref.columns:
        mismatch_cvr = (
            ref.groupby("period_mismatch_flag")["is_converted"]
               .agg(user_cnt="count", converted="sum")
               .assign(cvr=lambda x: (x["converted"] / x["user_cnt"]).round(4))
               .reset_index()
        )
        mismatch_cvr["label"] = mismatch_cvr["period_mismatch_flag"].map(
            {0: "时机匹配", 1: "时机不匹配（骚扰）"}
        )
        mismatch_df = mismatch_cvr

    # ── 5. 会员权益关注率──────────────────────────────────────────────────────
    avail_member_cols = [c for c in _MEMBER_COLS_V2 if c in ref.columns]
    if avail_member_cols:
        member_stats = ref[avail_member_cols].mean().reset_index()
        member_stats.columns = ["feature", "rate"]
        if "is_converted" in ref.columns:
            cvr_rows = []
            for col in avail_member_cols:
                mask = ref[col] == 1
                if mask.sum() > 10:
                    cvr_rows.append({"feature": col, "cvr_if_triggered": round(float(ref.loc[mask, "is_converted"].mean()), 4)})
            cvr_df = pd.DataFrame(cvr_rows)
            if not cvr_df.empty:
                member_stats = member_stats.merge(cvr_df, on="feature", how="left")
    else:
        member_stats = pd.DataFrame()

    # ── 6. 行为密度分布（pre_events_per_hour）────────────────────────────────
    if "pre_events_per_hour" in ref.columns:
        shape = distribution_shape(ref["pre_events_per_hour"].dropna())
        density_stats = pd.DataFrame([{
            "metric": "pre_events_per_hour",
            "n": shape["n"],
            "mean": round(shape["mean"], 3) if shape["mean"] is not None else None,
            "p25": round(shape["p25"], 3) if shape["p25"] is not None else None,
            "p50": round(shape["p50"], 3) if shape["p50"] is not None else None,
            "p75": round(shape["p75"], 3) if shape["p75"] is not None else None,
            "p99": round(shape["p99"], 3) if shape["p99"] is not None else None,
            "iqr": round(shape["iqr"], 3) if shape["iqr"] is not None else None,
            "is_long_tail": shape["is_long_tail"],
            "is_multimodal": shape["is_multimodal"],
        }])
    else:
        density_stats = pd.DataFrame()

    # ── 7. 跨平台使用率──────────────────────────────────────────────────────
    cross_platform = float(ref["pre_is_cross_platform"].mean()) if "pre_is_cross_platform" in ref.columns else None

    # ── 8. 行为密度-创单率曲线──────────────────────────────────────────────
    if "pre_events_per_hour" in ref.columns and "is_converted" in ref.columns:
        _bins   = [0, 1, 2, 5, 10, 20, float("inf")]
        _labels = ["0-1", "1-2", "2-5", "5-10", "10-20", "20+"]
        _tmp = ref.copy()
        _tmp["_eph_bucket"] = pd.cut(
            _tmp["pre_events_per_hour"], bins=_bins, labels=_labels, right=False
        )
        eph_cvr = (
            _tmp.groupby("_eph_bucket", observed=True)["is_converted"]
                .agg(user_cnt="count", converted="sum")
                .assign(cvr=lambda x: (x["converted"] / x["user_cnt"]).round(4))
                .reset_index()
                .rename(columns={"_eph_bucket": "eph_bucket"})
        )
        eph_cvr["cvr_ci_low"]  = eph_cvr.apply(
            lambda r: round(wilson_ci(r["cvr"], int(r["user_cnt"]))[0], 4), axis=1)
        eph_cvr["cvr_ci_high"] = eph_cvr.apply(
            lambda r: round(wilson_ci(r["cvr"], int(r["user_cnt"]))[1], 4), axis=1)
    else:
        eph_cvr = pd.DataFrame()

    # ── 9. 时段-创单率曲线（pre_first_active_period × CVR）──────────────────
    if "pre_first_active_period" in ref.columns and "is_converted" in ref.columns:
        period_cvr = (
            ref.groupby("pre_first_active_period", dropna=False)["is_converted"]
               .agg(user_cnt="count", converted="sum")
               .assign(cvr=lambda x: (x["converted"] / x["user_cnt"]).round(4))
               .reset_index()
        )
        cis = period_cvr.apply(lambda r: wilson_ci(r["cvr"], int(r["user_cnt"])), axis=1)
        period_cvr["cvr_ci_low"]  = [round(c[0], 4) for c in cis]
        period_cvr["cvr_ci_high"] = [round(c[1], 4) for c in cis]
    else:
        period_cvr = pd.DataFrame()

    # ── 10. 时段×平台创单率矩阵──────────────────────────────────────────────
    if (
        "pre_first_active_period" in ref.columns
        and "pre_primary_platform" in ref.columns
        and "is_converted" in ref.columns
    ):
        period_platform_cvr = (
            ref.groupby(["pre_first_active_period", "pre_primary_platform"], dropna=False)["is_converted"]
               .agg(user_cnt="count", converted="sum")
               .assign(cvr=lambda x: (x["converted"] / x["user_cnt"]).round(4))
               .reset_index()
        )
        period_platform_cvr = period_platform_cvr[period_platform_cvr["user_cnt"] >= 10].reset_index(drop=True)
    else:
        period_platform_cvr = pd.DataFrame()

    # ── 11. 沉默用户特征（pre_is_dormant_user）──────────────────────────────
    dormant_df = pd.DataFrame()
    if "pre_is_dormant_user" in ref.columns and "is_converted" in ref.columns:
        dormant_cvr = (
            ref.groupby("pre_is_dormant_user")["is_converted"]
               .agg(user_cnt="count", converted="sum")
               .assign(cvr=lambda x: (x["converted"] / x["user_cnt"]).round(4))
               .reset_index()
        )
        dormant_cvr["label"] = dormant_cvr["pre_is_dormant_user"].map({0: "活跃用户", 1: "沉默用户"})
        dormant_df = dormant_cvr

    return pd.concat([
        platform_dist.assign(_section="主平台分布"),
        platform_evt.assign(_section="各平台行为量"),
        period_dist.assign(_section="活跃时段分布"),
        mismatch_df.assign(_section="时机匹配诊断"),
        member_stats.assign(_section="会员权益关注率"),
        density_stats.assign(_section="行为密度分布"),
        pd.DataFrame([{"cross_platform_rate": cross_platform, "_section": "跨平台使用率"}]),
        eph_cvr.assign(_section="行为密度-创单率曲线"),
        period_cvr.assign(_section="时段-创单率曲线"),
        period_platform_cvr.assign(_section="时段×平台创单率矩阵"),
        dormant_df.assign(_section="沉默用户创单率"),
    ], ignore_index=True)
