"""转化漏斗维度统计代码片段（用户-活动粒度）。

涉及特征：漏斗深度 pre_max_funnel_depth（1-5）；各阶段到达标志
pre_reached_homepage/list/detail/booking/payment；跳过详情页 pre_skip_detail_flag；
漏斗倒退 pre_back_to_list_cnt / pre_back_to_booking_cnt；决策周期
pre_first_expose_to_touch_min / pre_last_mainflow_to_touch_min / pre_last_mkt_to_touch_min
（度量行为到触达时刻的时间差）。
"""
from __future__ import annotations

import pandas as pd

from snippets.stats_utils import (
    chi2_test,
    distribution_shape,
    wilson_ci,
)

# 漏斗深度值到阶段名称的映射
_DEPTH_LABEL = {
    0: "无主流程",
    1: "首页",
    2: "列表页",
    3: "详情页",
    4: "填写页",
    5: "支付页",
}


def analyze_funnel(df: pd.DataFrame) -> pd.DataFrame:
    """汇总转化漏斗 6 块原始统计。

    返回的 DataFrame 含 `_section` 列用于区分段落，宿主 Agent 应 groupby 此列读取。
    所有缺字段都会安全跳过，不抛异常。
    """
    ref = df

    # ── 1. 漏斗深度分布（按 pre_max_funnel_depth 计，附 CVR 对比）─────────────
    if "pre_max_funnel_depth" in ref.columns:
        depth_col = "pre_max_funnel_depth"
        depth_grp = (
            ref.groupby(depth_col, dropna=False)
               .size()
               .reset_index(name="user_cnt")
        )
        depth_grp["depth_label"] = depth_grp[depth_col].map(_DEPTH_LABEL).fillna("未知")
        total = len(ref)
        depth_grp["pct"] = (depth_grp["user_cnt"] / total).round(4)

        if "is_converted" in ref.columns:
            cvr_by_depth = (
                ref.groupby(depth_col, dropna=False)["is_converted"]
                   .mean()
                   .round(4)
                   .reset_index()
                   .rename(columns={"is_converted": "cvr"})
            )
            depth_grp = depth_grp.merge(cvr_by_depth, on=depth_col, how="left")

        funnel_depth_df = depth_grp.sort_values(depth_col)
    else:
        funnel_depth_df = pd.DataFrame()

    # ── 2. 各阶段到达率 & CVR（pre_reached_* 标志位）──────────────────────────
    stage_flags = [
        ("homepage",  "pre_reached_homepage",  "首页"),
        ("list",      "pre_reached_list",       "列表页"),
        ("detail",    "pre_reached_detail",     "详情页"),
        ("booking",   "pre_reached_booking",    "填写页"),
        ("payment",   "pre_reached_payment",    "支付页"),
    ]
    stage_rows = []
    for stage_key, col, label in stage_flags:
        if col not in ref.columns:
            continue
        n_reached = int(ref[col].sum())
        row: dict = {
            "stage": label,
            "reached_cnt": n_reached,
            "reached_rate": round(n_reached / len(ref), 4) if len(ref) > 0 else 0,
        }
        if "is_converted" in ref.columns and n_reached > 0:
            mask = ref[col] == 1
            row["cvr_if_reached"] = round(float(ref.loc[mask, "is_converted"].mean()), 4)
            not_mask = ~mask
            if not_mask.sum() > 0:
                row["cvr_if_not_reached"] = round(float(ref.loc[not_mask, "is_converted"].mean()), 4)
            if n_reached > 10 and not_mask.sum() > 10:
                conv_r = int(ref.loc[mask, "is_converted"].sum())
                conv_nr = int(ref.loc[not_mask, "is_converted"].sum())
                _, pv, _ = chi2_test([
                    [conv_r, n_reached - conv_r],
                    [conv_nr, not_mask.sum() - conv_nr],
                ])
                row["p_value"] = round(pv, 4) if not pd.isna(pv) else None
        stage_rows.append(row)
    stage_reach_df = pd.DataFrame(stage_rows)

    # ── 3. 跳过详情页对比（pre_skip_detail_flag）──────────────────────────────
    if "pre_skip_detail_flag" in ref.columns and "is_converted" in ref.columns:
        skip_detail = (
            ref.groupby("pre_skip_detail_flag")["is_converted"]
               .agg(["mean", "count", "sum"])
               .rename(columns={"mean": "cvr", "count": "user_cnt", "sum": "converted_cnt"})
               .reset_index()
        )
        cis = skip_detail.apply(
            lambda r: wilson_ci(r["cvr"], int(r["user_cnt"])), axis=1)
        skip_detail["ci_low"] = [round(c[0], 4) for c in cis]
        skip_detail["ci_high"] = [round(c[1], 4) for c in cis]
        if len(skip_detail) == 2:
            r0, r1 = skip_detail.iloc[0], skip_detail.iloc[1]
            table = [
                [int(r0["converted_cnt"]), int(r0["user_cnt"] - r0["converted_cnt"])],
                [int(r1["converted_cnt"]), int(r1["user_cnt"] - r1["converted_cnt"])],
            ]
            _, p_val, _ = chi2_test(table)
            skip_detail["diff_p_value"] = round(p_val, 4) if not pd.isna(p_val) else None
        else:
            skip_detail["diff_p_value"] = None
    else:
        skip_detail = pd.DataFrame()

    # ── 4. 漏斗倒退分布（pre_back_to_list_cnt + pre_back_to_booking_cnt）──────
    regression_rows = []
    for col, label in [
        ("pre_back_to_list_cnt",    "详情→列表 (犹豫/比价)"),
        ("pre_back_to_booking_cnt", "填写→详情 (中断)"),
    ]:
        if col not in ref.columns:
            continue
        shape = distribution_shape(ref[col].dropna())
        row = {
            "regression_type": label,
            "n": shape["n"],
            "mean": round(shape["mean"], 2) if shape["mean"] is not None else None,
            "p50": shape["p50"],
            "p75": shape["p75"],
            "p90": shape.get("p99"),  # 用 p99 作为高倒退人群阈值参考
            "pct_gt0": round(float((ref[col] > 0).mean()), 4) if col in ref.columns else None,
        }
        if "is_converted" in ref.columns:
            mask_gt0 = ref[col] > 0
            if mask_gt0.sum() > 5:
                row["cvr_with_regression"] = round(float(ref.loc[mask_gt0, "is_converted"].mean()), 4)
            mask_0 = ref[col] == 0
            if mask_0.sum() > 5:
                row["cvr_no_regression"] = round(float(ref.loc[mask_0, "is_converted"].mean()), 4)
        regression_rows.append(row)
    regression_df = pd.DataFrame(regression_rows)

    # ── 5. 触达前决策周期（度量行为到触达的时间差，非到创单）──────────────
    decision_cols = [
        c for c in [
            "pre_first_expose_to_touch_min",
            "pre_last_mainflow_to_touch_min",
            "pre_last_mkt_to_touch_min",
        ] if c in ref.columns
    ]
    if decision_cols:
        rows = []
        for col in decision_cols:
            shape = distribution_shape(ref[col].dropna())
            rows.append({
                "metric": col,
                "n": shape["n"],
                "mean": round(shape["mean"], 2) if shape["mean"] is not None else None,
                "p25": round(shape["p25"], 2) if shape["p25"] is not None else None,
                "p50": round(shape["p50"], 2) if shape["p50"] is not None else None,
                "p75": round(shape["p75"], 2) if shape["p75"] is not None else None,
                "p99": round(shape["p99"], 2) if shape["p99"] is not None else None,
                "iqr": round(shape["iqr"], 2) if shape["iqr"] is not None else None,
                "is_long_tail": shape["is_long_tail"],
                "is_multimodal": shape["is_multimodal"],
            })
        decision_stats = pd.DataFrame(rows)
    else:
        decision_stats = pd.DataFrame()

    # ── 6. 逐层漏斗 CVR 曲线（pre_max_funnel_depth × CVR）────────────────────
    if "is_converted" in ref.columns and "pre_max_funnel_depth" in ref.columns:
        funnel_cvr_by_depth = (
            ref.groupby("pre_max_funnel_depth", dropna=False)["is_converted"]
               .agg(user_cnt="count", converted="sum")
               .assign(cvr=lambda x: (x["converted"] / x["user_cnt"]).round(4))
               .reset_index()
        )
        funnel_cvr_by_depth["depth_label"] = (
            funnel_cvr_by_depth["pre_max_funnel_depth"].map(_DEPTH_LABEL).fillna("未知")
        )
    else:
        funnel_cvr_by_depth = pd.DataFrame()

    result = pd.concat([
        funnel_depth_df.assign(_section="漏斗深度分布"),
        stage_reach_df.assign(_section="各阶段到达率"),
        skip_detail.assign(_section="跳过详情页对比"),
        regression_df.assign(_section="漏斗倒退分布"),
        decision_stats.assign(_section="触达前决策周期"),
        funnel_cvr_by_depth.assign(_section="逐层漏斗创单率"),
    ], ignore_index=True)

    return result
