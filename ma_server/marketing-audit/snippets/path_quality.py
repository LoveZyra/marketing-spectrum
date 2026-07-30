"""行为路径质量维度统计代码片段（用户-活动粒度）。

涉及特征：首末触点 pre_first/last_touch_*；路径序列
pre_path_model_seq / pre_path_detail_seq / pre_path_product_seq；营销首末
pre_is_marketing_first / pre_is_marketing_last；搜索-目标匹配 pre_search_match_target；
历史订单品类 pre_last_order_product；路径断点按 pre_max_funnel_depth 衡量；
营销/主流程历史首末 pre_first/last_mkt_* / pre_first/last_mainflow_*。
"""
from __future__ import annotations

import pandas as pd

from snippets.stats_utils import distribution_shape, wilson_ci

_DEPTH_LABEL = {0: "无主流程", 1: "首页", 2: "列表页", 3: "详情页", 4: "填写页", 5: "支付页"}


def analyze_path_quality(df: pd.DataFrame) -> pd.DataFrame:
    """汇总首末触点 + Top10 路径 + 关键路径比例 + 历史营销路径统计。

    返回含 `_section` 列的 DataFrame，宿主 Agent 应 groupby 此列读取。
    """
    ref = df

    # ── 1. 整体首触点分布（pre_first_touch_model）──────────────────────────
    if "pre_first_touch_model" in ref.columns:
        first_touch = ref["pre_first_touch_model"].value_counts(normalize=True).reset_index()
        first_touch.columns = ["first_touch_model", "rate"]
    else:
        first_touch = pd.DataFrame()

    # ── 2. 整体末触点分布（pre_last_touch_model）──────────────────────────
    if "pre_last_touch_model" in ref.columns:
        last_touch = ref["pre_last_touch_model"].value_counts(normalize=True).reset_index()
        last_touch.columns = ["last_touch_model", "rate"]
    else:
        last_touch = pd.DataFrame()

    # ── 3. Top10 路径模式（含 CVR + Wilson CI）──────────────────────────────
    if "pre_path_model_seq" in ref.columns:
        path_counts = ref["pre_path_model_seq"].value_counts().head(10)
        rows = []
        for path, cnt in path_counts.items():
            row = {"pre_path_model_seq": path, "user_cnt": int(cnt)}
            if "is_converted" in ref.columns:
                sub = ref[ref["pre_path_model_seq"] == path]["is_converted"]
                cvr = float(sub.mean()) if len(sub) > 0 else None
                ci_low, ci_high = wilson_ci(cvr or 0.0, int(cnt))
                row.update({
                    "cvr": round(cvr, 4) if cvr is not None else None,
                    "cvr_ci_low": round(ci_low, 4),
                    "cvr_ci_high": round(ci_high, 4),
                })
            rows.append(row)
        top_paths = pd.DataFrame(rows)
    else:
        top_paths = pd.DataFrame()

    # ── 3b. 路径长度分布（节点数统计）────────────────────────────────────
    if "pre_path_model_seq" in ref.columns:
        _valid_paths = ref["pre_path_model_seq"].dropna().astype(str)
        _valid_paths = _valid_paths[_valid_paths.str.len() > 0]
        path_lengths = _valid_paths.str.count("->") + 1
        shape = distribution_shape(path_lengths)
        path_len_stats = pd.DataFrame([{
            "metric": "path_length_nodes",
            "n": shape["n"],
            "mean": round(shape["mean"], 2) if shape["mean"] is not None else None,
            "p25": shape["p25"],
            "p50": shape["p50"],
            "p75": shape["p75"],
            "p99": shape["p99"],
            "iqr": shape["iqr"],
            "is_long_tail": shape["is_long_tail"],
        }])
    else:
        path_len_stats = pd.DataFrame()

    # ── 4. 历史末次订单品类分布（pre_last_order_product）──────────────────
    if "pre_last_order_product" in ref.columns:
        prev_product_dist = ref["pre_last_order_product"].value_counts().reset_index()
        prev_product_dist.columns = ["last_order_product", "user_cnt"]
    else:
        prev_product_dist = pd.DataFrame()

    # ── 5. 关键路径比例──────────────────────────────────────────────────────
    mkt_first_rate = float(ref["pre_is_marketing_first"].mean()) if "pre_is_marketing_first" in ref.columns else None
    mkt_last_rate  = float(ref["pre_is_marketing_last"].mean())  if "pre_is_marketing_last"  in ref.columns else None
    search_match   = float(ref["pre_search_match_target"].mean()) if "pre_search_match_target" in ref.columns else None

    # ── 6. 高效路径 Top5（CVR 最高且样本量 ≥ 10 的路径）──────────────────
    if not top_paths.empty and "cvr" in top_paths.columns:
        overall_cvr = float(ref["is_converted"].mean()) if "is_converted" in ref.columns else None
        _threshold = (overall_cvr * 1.5) if overall_cvr else 0.0
        high_cvr_paths = (
            top_paths[
                top_paths["cvr"].notna()
                & (top_paths["cvr"] >= _threshold)
                & (top_paths["user_cnt"] >= 10)
            ]
            .sort_values("cvr", ascending=False)
            .head(5)
            .reset_index(drop=True)
            .assign(overall_cvr_baseline=round(overall_cvr, 4) if overall_cvr else None)
        )
    else:
        high_cvr_paths = pd.DataFrame()

    # ── 7. 路径断点分析（按 pre_max_funnel_depth 衡量历史最深漏斗）──────
    if "pre_max_funnel_depth" in ref.columns and "is_converted" in ref.columns:
        bp_grp = (
            ref.groupby("pre_max_funnel_depth", dropna=False)["is_converted"]
               .agg(user_cnt="count", converted="sum")
               .assign(cvr=lambda x: (x["converted"] / x["user_cnt"]).round(4))
               .reset_index()
        )
        bp_grp["depth_label"] = bp_grp["pre_max_funnel_depth"].map(_DEPTH_LABEL).fillna("未知")
        if "pre_is_marketing_last" in ref.columns:
            mkt_last_by_depth = (
                ref.groupby("pre_max_funnel_depth", dropna=False)["pre_is_marketing_last"]
                   .mean()
                   .round(4)
                   .reset_index()
                   .rename(columns={"pre_is_marketing_last": "mkt_last_rate"})
            )
            bp_grp = bp_grp.merge(mkt_last_by_depth, on="pre_max_funnel_depth", how="left")
        breakpoint_df = bp_grp.sort_values("user_cnt", ascending=False).reset_index(drop=True)
    else:
        breakpoint_df = pd.DataFrame()

    # ── 8. 路径回退/跳跃模式（pre_path_model_seq）──────────────────────────
    pattern_rows = []
    if "pre_path_model_seq" in ref.columns and "is_converted" in ref.columns:
        _seqs = ref["pre_path_model_seq"].fillna("").astype(str)
        for pattern_name, pattern_str in [
            ("回退（详情→列表→详情）", "详情->列表->详情"),
            ("回退（填写→详情→填写）", "填写->详情->填写"),
            ("跳跃（首页→支付）",      "首页->支付"),
        ]:
            mask_pattern = _seqs.str.contains(pattern_str, regex=False)
            n = int(mask_pattern.sum())
            if n < 5:
                continue
            cvr = float(ref.loc[mask_pattern, "is_converted"].mean())
            pattern_rows.append({
                "pattern": pattern_name,
                "user_cnt": n,
                "share_pct": round(100 * n / len(ref), 2),
                "cvr": round(cvr, 4),
            })
    path_pattern_df = pd.DataFrame(pattern_rows)

    # ── 9. 营销首尾一致性 2×2 矩阵（pre_is_marketing_first/last）────────────
    mkt_consistency_rows = []
    if (
        "pre_is_marketing_first" in ref.columns
        and "pre_is_marketing_last" in ref.columns
        and "is_converted" in ref.columns
    ):
        for f_val, l_val, label in [
            (1, 1, "首=营销，尾=营销"),
            (1, 0, "首=营销，尾=主流程"),
            (0, 1, "首=主流程，尾=营销"),
            (0, 0, "首=主流程，尾=主流程"),
        ]:
            mask = (ref["pre_is_marketing_first"] == f_val) & (ref["pre_is_marketing_last"] == l_val)
            n = int(mask.sum())
            if n < 5:
                continue
            cvr = float(ref.loc[mask, "is_converted"].mean())
            mkt_consistency_rows.append({
                "mkt_consistency": label, "user_cnt": n, "cvr": round(cvr, 4),
            })
    mkt_consistency_df = pd.DataFrame(mkt_consistency_rows)

    # ── 10. 历史营销渠道分布（首次/末次历史营销渠道）──────────────────────
    mkt_channel_rows = []
    for col, label in [
        ("pre_first_mkt_channel", "首次历史营销渠道"),
        ("pre_last_mkt_channel",  "末次历史营销渠道"),
    ]:
        if col in ref.columns:
            d = ref[col].value_counts().head(10).reset_index()
            d.columns = ["channel", "user_cnt"]
            d.insert(0, "which", label)
            mkt_channel_rows.append(d)
    mkt_channel_df = pd.concat(mkt_channel_rows, ignore_index=True) if mkt_channel_rows else pd.DataFrame()

    # ── 11. 末次主流程页面 × CVR（pre_last_mainflow_detail）──────────────
    last_mainflow_df = pd.DataFrame()
    if "pre_last_mainflow_detail" in ref.columns and "is_converted" in ref.columns:
        last_mainflow_df = (
            ref.groupby("pre_last_mainflow_detail", dropna=False)["is_converted"]
               .agg(user_cnt="count", converted="sum")
               .assign(cvr=lambda x: (x["converted"] / x["user_cnt"]).round(4))
               .sort_values("user_cnt", ascending=False)
               .head(10)
               .reset_index()
        )

    return pd.concat([
        first_touch.assign(_section="首触点类型分布"),
        last_touch.assign(_section="末触点类型分布"),
        top_paths.assign(_section="Top10路径模式"),
        path_len_stats.assign(_section="路径长度分布"),
        prev_product_dist.assign(_section="历史末次订单品类"),
        pd.DataFrame([{
            "is_marketing_first_rate": mkt_first_rate,
            "is_marketing_last_rate":  mkt_last_rate,
            "search_match_target_rate": search_match,
            "_section": "关键路径比例",
        }]),
        high_cvr_paths.assign(_section="高效路径Top5"),
        breakpoint_df.assign(_section="路径断点分析"),
        path_pattern_df.assign(_section="路径回退跳跃模式"),
        mkt_consistency_df.assign(_section="营销首尾一致性矩阵"),
        mkt_channel_df.assign(_section="历史营销渠道首末分布"),
        last_mainflow_df.assign(_section="末次主流程页面创单率"),
    ], ignore_index=True)
