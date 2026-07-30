"""缺数据回退策略（用户-活动粒度特征宽表）。

主入口：
    ensure_required_fields(df, mode="all") -> (df, caveats)
    ensure_field(df, field) -> (df, fallback_used, caveat)

字段命名：触达前行为统一为 pre_* 前缀。
"""
from __future__ import annotations

from typing import Any, Callable

import numpy as np
import pandas as pd


def _has_col(df: pd.DataFrame, col: str) -> bool:
    return col in df.columns and df[col].notna().any()


def _has_cols(df: pd.DataFrame, cols: list[str]) -> bool:
    return all(c in df.columns for c in cols)


def _split_seq(s: Any) -> list[str]:
    if s is None or (isinstance(s, float) and np.isnan(s)):
        return []
    return [x for x in str(s).split("->") if x]


def _caveat(field: str, issue: str, fallback: str | None, n_derived: int = 0,
            n_nan_left: int = 0, impact: str = "") -> dict:
    out: dict[str, Any] = {"field": field, "issue": issue}
    if fallback:
        out["fallback"] = fallback
    if n_derived:
        out["n_derived"] = n_derived
    if n_nan_left:
        out["n_nan_left"] = n_nan_left
    out["impact"] = impact or "对应维度可继续运行"
    return out


# ── 各字段 fallback 规则 ───────────────────────────────────────────


def _fb_is_converted(df: pd.DataFrame) -> tuple[pd.DataFrame, str, dict] | None:
    if _has_col(df, "convert_time"):
        df = df.copy()
        df["is_converted"] = df["convert_time"].notna().astype(int)
        return df, "convert_time IS NOT NULL", _caveat(
            "is_converted", "原列缺失", "convert_time IS NOT NULL",
            n_derived=int(df["is_converted"].sum()),
            impact="CVR 以 convert_time 非空为准；与真实成单可能有 <2% 偏差",
        )
    return None


def _fb_pre_first_active_period(df: pd.DataFrame) -> tuple[pd.DataFrame, str, dict] | None:
    if not _has_col(df, "pre_first_active_hour"):
        return None
    df = df.copy()
    h = df["pre_first_active_hour"]
    df["pre_first_active_period"] = np.where(
        (h >= 6) & (h <= 11), "上午",
        np.where((h >= 12) & (h <= 17), "下午",
                 np.where((h >= 18) & (h <= 22), "晚上", "深夜"))
    )
    return df, "pre_first_active_hour 桶映射", _caveat(
        "pre_first_active_period", "原列缺失", "pre_first_active_hour ∈ [6,11]→上午…",
        n_derived=int(df["pre_first_active_period"].notna().sum()),
    )


def _fb_pre_events_per_hour(df: pd.DataFrame) -> tuple[pd.DataFrame, str, dict] | None:
    if not _has_cols(df, ["pre_total_event_cnt", "pre_active_span_min"]):
        return None
    df = df.copy()
    span_h = (df["pre_active_span_min"].clip(lower=1) / 60.0)
    df["pre_events_per_hour"] = df["pre_total_event_cnt"] / span_h
    return df, "pre_total_event_cnt / max(pre_active_span_min/60, 1/60)", _caveat(
        "pre_events_per_hour", "原列缺失", "派生自 pre_total_event_cnt 与 pre_active_span_min",
        n_derived=int(df["pre_events_per_hour"].notna().sum()),
        impact="极短停留用户被 clip 到 1 分钟",
    )


def _fb_pre_primary_platform(df: pd.DataFrame) -> tuple[pd.DataFrame, str, dict] | None:
    cols = [c for c in ["pre_app_event_cnt", "pre_wechat_event_cnt", "pre_yilong_event_cnt"]
            if c in df.columns]
    if len(cols) < 2:
        return None
    name_map = {
        "pre_app_event_cnt": "同程APP",
        "pre_wechat_event_cnt": "微信",
        "pre_yilong_event_cnt": "艺龙APP",
    }
    df = df.copy()
    df["pre_primary_platform"] = df[cols].idxmax(axis=1).map(name_map)
    return df, "argmax(pre_*_event_cnt)", _caveat(
        "pre_primary_platform", "原列缺失", "按各平台事件数取最大",
        n_derived=int(df["pre_primary_platform"].notna().sum()),
        impact="同等事件数存在 ties，可能与原口径有 <5% 差异",
    )


def _fb_pre_is_cross_platform(df: pd.DataFrame) -> tuple[pd.DataFrame, str, dict] | None:
    cols = [c for c in ["pre_app_event_cnt", "pre_wechat_event_cnt", "pre_yilong_event_cnt"]
            if c in df.columns]
    if len(cols) < 2:
        return None
    df = df.copy()
    df["pre_is_cross_platform"] = (df[cols].gt(0).sum(axis=1) >= 2).astype(int)
    return df, "≥2 个平台 pre_*_event_cnt > 0", _caveat(
        "pre_is_cross_platform", "原列缺失", "派生自各平台事件数",
        n_derived=int(df["pre_is_cross_platform"].sum()),
    )


def _fb_pre_is_marketing_first(df: pd.DataFrame) -> tuple[pd.DataFrame, str, dict] | None:
    if _has_col(df, "pre_first_touch_model"):
        df = df.copy()
        df["pre_is_marketing_first"] = (df["pre_first_touch_model"] == "营销").astype(int)
        return df, "pre_first_touch_model == '营销'", _caveat(
            "pre_is_marketing_first", "原列缺失", "pre_first_touch_model == '营销'",
            n_derived=int(df["pre_is_marketing_first"].sum()),
        )
    if _has_col(df, "pre_path_model_seq"):
        df = df.copy()
        df["pre_is_marketing_first"] = df["pre_path_model_seq"].apply(
            lambda s: int(_split_seq(s)[:1] == ["营销"])
        )
        return df, "pre_path_model_seq 首元素 == '营销'", _caveat(
            "pre_is_marketing_first", "原列缺失", "pre_path_model_seq 首节点",
            n_derived=int(df["pre_is_marketing_first"].sum()),
        )
    return None


def _fb_pre_is_marketing_last(df: pd.DataFrame) -> tuple[pd.DataFrame, str, dict] | None:
    if _has_col(df, "pre_last_touch_model"):
        df = df.copy()
        df["pre_is_marketing_last"] = (df["pre_last_touch_model"] == "营销").astype(int)
        return df, "pre_last_touch_model == '营销'", _caveat(
            "pre_is_marketing_last", "原列缺失", "pre_last_touch_model == '营销'",
            n_derived=int(df["pre_is_marketing_last"].sum()),
        )
    if _has_col(df, "pre_path_model_seq"):
        df = df.copy()
        df["pre_is_marketing_last"] = df["pre_path_model_seq"].apply(
            lambda s: int((_split_seq(s) or [""])[-1] == "营销")
        )
        return df, "pre_path_model_seq 末元素 == '营销'", _caveat(
            "pre_is_marketing_last", "原列缺失", "pre_path_model_seq 末节点",
            n_derived=int(df["pre_is_marketing_last"].sum()),
        )
    return None


def _fb_pre_top_interest_product(df: pd.DataFrame) -> tuple[pd.DataFrame, str, dict] | None:
    pairs = [
        ("酒店",  "pre_hotel_depth"  if "pre_hotel_depth"  in df.columns else "pre_browse_hotel"),
        ("机票",  "pre_flight_depth" if "pre_flight_depth" in df.columns else "pre_browse_flight"),
        ("火车票", "pre_train_depth"  if "pre_train_depth"  in df.columns else "pre_browse_train"),
        ("景区",  "pre_scenic_depth" if "pre_scenic_depth" in df.columns else "pre_browse_scenic"),
    ]
    have = [(name, col) for name, col in pairs if col in df.columns]
    if len(have) < 2:
        return None
    df = df.copy()
    mat = pd.DataFrame({name: df[col] for name, col in have}).fillna(0)
    chosen = mat.idxmax(axis=1)
    no_browse_mask = mat.sum(axis=1) == 0
    df["pre_top_interest_product"] = np.where(no_browse_mask, "无浏览", chosen)
    return df, "argmax(pre_*_depth or pre_browse_*)", _caveat(
        "pre_top_interest_product", "原列缺失", "按浏览深度取最大品类",
        n_derived=int((df["pre_top_interest_product"] != "无浏览").sum()),
        impact="ties 按枚举顺序选第一个",
    )


def _fb_pre_is_cross_category(df: pd.DataFrame) -> tuple[pd.DataFrame, str, dict] | None:
    cols = [c for c in df.columns if c.startswith("pre_browse_")]
    if len(cols) < 2:
        return None
    df = df.copy()
    df["pre_is_cross_category"] = (df[cols].fillna(0).gt(0).sum(axis=1) > 1).astype(int)
    return df, "sum(pre_browse_*) > 1", _caveat(
        "pre_is_cross_category", "原列缺失", "≥2 个 pre_browse_* 列为 1",
        n_derived=int(df["pre_is_cross_category"].sum()),
    )


def _fb_pre_is_dormant_user(df: pd.DataFrame) -> tuple[pd.DataFrame, str, dict] | None:
    if _has_col(df, "pre_total_event_cnt"):
        df = df.copy()
        df["pre_is_dormant_user"] = (df["pre_total_event_cnt"].fillna(0) == 0).astype(int)
        return df, "pre_total_event_cnt == 0", _caveat(
            "pre_is_dormant_user", "原列缺失", "派生自 pre_total_event_cnt == 0",
            n_derived=int(df["pre_is_dormant_user"].sum()),
        )
    return None


def _fb_pre_mkt_product_browse_match(df: pd.DataFrame) -> tuple[pd.DataFrame, str, dict] | None:
    if not _has_cols(df, ["pre_top_interest_product", "activity_product_name"]):
        return None
    df = df.copy()
    df["pre_mkt_product_browse_match"] = (
        df["pre_top_interest_product"].fillna("") == df["activity_product_name"].fillna("")
    ).astype(int)
    return df, "pre_top_interest_product == activity_product_name", _caveat(
        "pre_mkt_product_browse_match", "原列缺失", "兴趣品类 == 活动品类",
        n_derived=int(df["pre_mkt_product_browse_match"].sum()),
    )


FALLBACK_RULES: dict[str, Callable[[pd.DataFrame], "tuple[pd.DataFrame, str, dict] | None"]] = {
    "is_converted":                _fb_is_converted,
    "pre_first_active_period":     _fb_pre_first_active_period,
    "pre_events_per_hour":         _fb_pre_events_per_hour,
    "pre_primary_platform":        _fb_pre_primary_platform,
    "pre_is_cross_platform":       _fb_pre_is_cross_platform,
    "pre_is_marketing_first":      _fb_pre_is_marketing_first,
    "pre_is_marketing_last":       _fb_pre_is_marketing_last,
    "pre_top_interest_product":    _fb_pre_top_interest_product,
    "pre_is_cross_category":       _fb_pre_is_cross_category,
    "pre_is_dormant_user":         _fb_pre_is_dormant_user,
    "pre_mkt_product_browse_match": _fb_pre_mkt_product_browse_match,
}


def ensure_field(df: pd.DataFrame, field: str) -> tuple[pd.DataFrame, str | None, dict | None]:
    if _has_col(df, field):
        return df, None, None
    rule = FALLBACK_RULES.get(field)
    if rule is None:
        return df, None, _caveat(
            field, "原列缺失且无 fallback 规则", None,
            impact="该字段相关 finding 全部跳过；如有派生逻辑请在 FALLBACK_RULES 注册",
        )
    res = rule(df)
    if res is None:
        return df, None, _caveat(
            field, "原列缺失，依赖列也不足", None,
            impact="该字段相关 finding 全部跳过",
        )
    return res


def ensure_required_fields(
    df: pd.DataFrame, mode: str | list[str] = "all"
) -> tuple[pd.DataFrame, list[dict]]:
    caveats: list[dict] = []
    targets = list(FALLBACK_RULES.keys()) if mode == "all" else list(mode)
    for field in targets:
        df, _, caveat = ensure_field(df, field)
        if caveat is not None:
            caveats.append(caveat)
    return df, caveats
