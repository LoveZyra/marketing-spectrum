"""营销归因维度统计代码片段（用户-活动粒度）。

涉及特征：渠道触达计数 pre_*_touch_cnt（二进制触达由 >0 派生）；渠道点击
pre_*_click_cnt / pre_*_click_rate；营销触发主流程 pre_mkt_trigger_mainflow_cnt；
营销响应时效 pre_min_mkt_response_sec（秒）；当次渠道 activity_channel_std；
末次历史营销渠道 pre_last_mkt_channel。
"""
from __future__ import annotations

import pandas as pd

from snippets.stats_utils import chi2_test, wilson_ci

# 渠道名称 → 计数字段映射
_V2_CHANNELS: dict[str, dict[str, str | None]] = {
    "popup":      {"touch_cnt": "pre_popup_touch_cnt",    "click_cnt": "pre_popup_click_cnt",   "click_rate": "pre_popup_click_rate"},
    "push":       {"touch_cnt": "pre_push_touch_cnt",     "click_cnt": "pre_push_click_cnt",    "click_rate": "pre_push_click_rate"},
    "sms":        {"touch_cnt": "pre_sms_touch_cnt",      "click_cnt": None,                    "click_rate": None},
    "ads":        {"touch_cnt": "pre_ads_touch_cnt",      "click_cnt": None,                    "click_rate": None},
    "insite_msg": {"touch_cnt": "pre_insite_msg_touch_cnt", "click_cnt": None,                  "click_rate": None},
    "activity":   {"touch_cnt": "pre_activity_touch_cnt", "click_cnt": None,                    "click_rate": None},
}


def analyze_attribution(df: pd.DataFrame) -> pd.DataFrame:
    """汇总营销归因统计：历史渠道触达/点击 + 触达频次-创单率曲线 + 渠道组合效应。

    `渠道触达与点击` 段额外输出每渠道的 Wilson CI 与触达 vs 未触达的卡方 p-value。
    """
    ref = df

    # ── 1. 各历史渠道触达统计（含 CVR 对比）────────────────────────────────
    channel_stats = []
    for ch_name, cols in _V2_CHANNELS.items():
        touch_cnt_col = cols["touch_cnt"]
        click_cnt_col = cols.get("click_cnt")
        click_rate_col = cols.get("click_rate")

        if touch_cnt_col not in ref.columns:
            continue

        # 派生二进制触达标志：历史有该渠道触达
        touched_mask = ref[touch_cnt_col] > 0
        touched_cnt = int(touched_mask.sum())
        if touched_cnt == 0:
            continue

        avg_touch_cnt = round(float(ref.loc[touched_mask, touch_cnt_col].mean()), 2)
        avg_click_rate = round(float(ref[click_rate_col].mean()), 4) if click_rate_col and click_rate_col in ref.columns else None

        cvr_touched, cvr_not, p_value = None, None, None
        cvr_ci_low, cvr_ci_high = None, None
        n_not = int((~touched_mask).sum())

        if "is_converted" in ref.columns:
            if touched_cnt > 0:
                conv_t = int(ref.loc[touched_mask, "is_converted"].sum())
                cvr_touched = round(conv_t / touched_cnt, 4)
                cvr_ci_low, cvr_ci_high = wilson_ci(cvr_touched, touched_cnt)
            if n_not > 0:
                cvr_not = round(float(ref.loc[~touched_mask, "is_converted"].mean()), 4)
            if touched_cnt > 0 and n_not > 0:
                conv_n = int(ref.loc[~touched_mask, "is_converted"].sum())
                table = [
                    [conv_t, touched_cnt - conv_t],
                    [conv_n, n_not - conv_n],
                ]
                _, p_value, _ = chi2_test(table)
                if isinstance(p_value, float):
                    p_value = round(p_value, 4) if not pd.isna(p_value) else None

        channel_stats.append({
            "channel": ch_name,
            "touched_cnt": touched_cnt,
            "touched_rate": round(touched_cnt / len(ref), 4) if len(ref) > 0 else 0,
            "avg_touch_cnt_per_user": avg_touch_cnt,
            "avg_click_rate": avg_click_rate,
            "cvr_if_touched": cvr_touched,
            "cvr_if_touched_ci_low": round(cvr_ci_low, 4) if cvr_ci_low is not None else None,
            "cvr_if_touched_ci_high": round(cvr_ci_high, 4) if cvr_ci_high is not None else None,
            "cvr_if_not_touched": cvr_not,
            "cvr_diff_p_value": p_value,
            "n_touched": touched_cnt,
            "n_not_touched": n_not,
        })

    channel_df = (
        pd.DataFrame(channel_stats).sort_values("touched_cnt", ascending=False).reset_index(drop=True)
        if channel_stats else pd.DataFrame()
    )

    # ── 2. 当次活动渠道 CVR 对比（activity_channel_std）──────────────────────
    current_ch_df = pd.DataFrame()
    if "activity_channel_std" in ref.columns and "is_converted" in ref.columns:
        current_ch_df = (
            ref.groupby("activity_channel_std", dropna=False)["is_converted"]
               .agg(user_cnt="count", converted="sum")
               .assign(cvr=lambda x: (x["converted"] / x["user_cnt"]).round(4))
               .reset_index()
               .sort_values("user_cnt", ascending=False)
               .reset_index(drop=True)
        )

    # ── 3. 营销直接触发主流程（pre_mkt_trigger_mainflow_cnt）─────────────────
    trigger_rows = []
    if "pre_mkt_trigger_mainflow_cnt" in ref.columns:
        for val, label in [(0, "从未触发"), (1, "触发过1次"), (2, "触发过2次+")]:
            mask = (ref["pre_mkt_trigger_mainflow_cnt"] == val) if val < 2 \
                   else (ref["pre_mkt_trigger_mainflow_cnt"] >= 2)
            n = int(mask.sum())
            row: dict = {"mkt_trigger_mainflow": label, "user_cnt": n,
                         "pct": round(n / len(ref), 4) if len(ref) > 0 else 0}
            if "is_converted" in ref.columns and n > 0:
                row["cvr"] = round(float(ref.loc[mask, "is_converted"].mean()), 4)
            trigger_rows.append(row)
    trigger_df = pd.DataFrame(trigger_rows)

    # ── 4. 末次历史营销渠道分布（pre_last_mkt_channel）──────────────────────
    if "pre_last_mkt_channel" in ref.columns:
        last_ch = ref["pre_last_mkt_channel"].value_counts().reset_index()
    else:
        last_ch = pd.DataFrame()

    # ── 5. 营销响应时效（pre_min_mkt_response_sec，转换为分钟便于阅读）────────
    if "pre_min_mkt_response_sec" in ref.columns:
        _valid = ref["pre_min_mkt_response_sec"].dropna()
        mkt_gap = pd.DataFrame([{
            "unit": "分钟（pre_min_mkt_response_sec / 60）",
            "n_valid": len(_valid),
            "n_null": int(ref["pre_min_mkt_response_sec"].isna().sum()),
            "mean": round(float((_valid / 60).mean()), 2) if len(_valid) > 0 else None,
            "p25": round(float((_valid / 60).quantile(0.25)), 2) if len(_valid) > 0 else None,
            "p50": round(float((_valid / 60).quantile(0.50)), 2) if len(_valid) > 0 else None,
            "p75": round(float((_valid / 60).quantile(0.75)), 2) if len(_valid) > 0 else None,
            "p90": round(float((_valid / 60).quantile(0.90)), 2) if len(_valid) > 0 else None,
        }])
    else:
        mkt_gap = pd.DataFrame()

    # ── 6. 历史触达总次数-创单率曲线（pre_mkt_touch_cnt 分桶）────────────────
    if "pre_mkt_touch_cnt" in ref.columns and "is_converted" in ref.columns:
        _bins   = [-1, 0, 1, 2, 3, 5, float("inf")]
        _labels = ["0次", "1次", "2次", "3次", "4-5次", "6次+"]
        _tmp = ref.copy()
        _tmp["_touch_bucket"] = pd.cut(
            _tmp["pre_mkt_touch_cnt"], bins=_bins, labels=_labels, right=True
        )
        touch_cvr_df = (
            _tmp.groupby("_touch_bucket", observed=True)["is_converted"]
                .agg(user_cnt="count", converted="sum")
                .assign(cvr=lambda x: (x["converted"] / x["user_cnt"]).round(4))
                .reset_index()
                .rename(columns={"_touch_bucket": "mkt_touch_bucket"})
        )
        cis = touch_cvr_df.apply(
            lambda r: wilson_ci(r["cvr"], int(r["user_cnt"])), axis=1
        )
        touch_cvr_df["cvr_ci_low"]  = [round(c[0], 4) for c in cis]
        touch_cvr_df["cvr_ci_high"] = [round(c[1], 4) for c in cis]
    else:
        touch_cvr_df = pd.DataFrame()

    # ── 7. 当日触达次数-创单率曲线（activity_touch_cnt 分桶）────────────────
    if "activity_touch_cnt" in ref.columns and "is_converted" in ref.columns:
        _bins2  = [0, 1, 2, 3, 4, float("inf")]
        _labels2 = ["1次", "2次", "3次", "4次", "5次+"]
        _tmp2 = ref.copy()
        _tmp2["_act_bucket"] = pd.cut(
            _tmp2["activity_touch_cnt"], bins=_bins2, labels=_labels2, right=True
        )
        act_touch_cvr = (
            _tmp2.groupby("_act_bucket", observed=True)["is_converted"]
                 .agg(user_cnt="count", converted="sum")
                 .assign(cvr=lambda x: (x["converted"] / x["user_cnt"]).round(4))
                 .reset_index()
                 .rename(columns={"_act_bucket": "activity_touch_bucket"})
        )
        cis2 = act_touch_cvr.apply(
            lambda r: wilson_ci(r["cvr"], int(r["user_cnt"])), axis=1
        )
        act_touch_cvr["cvr_ci_low"]  = [round(c[0], 4) for c in cis2]
        act_touch_cvr["cvr_ci_high"] = [round(c[1], 4) for c in cis2]
    else:
        act_touch_cvr = pd.DataFrame()

    # ── 8. 渠道组合效应（历史 touched 标志组合 CVR）────────────────────────
    # 构造 touched 标志（从 pre_*_touch_cnt > 0 派生）
    combo_rows = []
    avail_channels = [
        (ch, cols["touch_cnt"])
        for ch, cols in _V2_CHANNELS.items()
        if cols["touch_cnt"] in ref.columns and int((ref[cols["touch_cnt"]] > 0).sum()) > 10
    ]
    if len(avail_channels) >= 2 and "is_converted" in ref.columns:
        top_channels = sorted(
            avail_channels,
            key=lambda x: int((ref[x[1]] > 0).sum()),
            reverse=True
        )[:4]
        for i, (ca_name, ca_col) in enumerate(top_channels):
            for cb_name, cb_col in top_channels[i + 1:]:
                ca_mask = ref[ca_col] > 0
                cb_mask = ref[cb_col] > 0
                for a_v, b_v, label in [
                    (True,  True,  f"{ca_name}+{cb_name}（双触达）"),
                    (True,  False, f"仅{ca_name}"),
                    (False, True,  f"仅{cb_name}"),
                    (False, False, "均未触达"),
                ]:
                    mask = (ca_mask == a_v) & (cb_mask == b_v)
                    n = int(mask.sum())
                    if n < 10:
                        continue
                    cvr = float(ref.loc[mask, "is_converted"].mean())
                    combo_rows.append({
                        "channel_a": ca_name, "channel_b": cb_name,
                        "combo": label, "user_cnt": n, "cvr": round(cvr, 4),
                    })
    combo_df = pd.DataFrame(combo_rows)

    return pd.concat([
        channel_df.assign(_section="历史渠道触达与点击"),
        current_ch_df.assign(_section="当次活动渠道创单率"),
        trigger_df.assign(_section="营销触发主流程分布"),
        last_ch.assign(_section="末次历史营销渠道分布"),
        mkt_gap.assign(_section="营销响应时效"),
        touch_cvr_df.assign(_section="历史触达次数-创单率曲线"),
        act_touch_cvr.assign(_section="当日触达次数-创单率曲线"),
        combo_df.assign(_section="渠道组合效应"),
    ], ignore_index=True)
