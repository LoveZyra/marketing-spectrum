"""
case_extractor.py — 从原始 CSV 中提取每种问题类型的典型用户案例。

在 cli prepare 末尾调用：case_pool = extract_case_pool(df, state)
写入 state['case_pool']，供 LLM 在 synthesis 阶段生成 typical_case 叙述。
"""
from __future__ import annotations
import re
from typing import Any

import numpy as np
import pandas as pd

def _sint(row, key, default: int = 0) -> int:
    """从 row 取整数；NaN/None/非法值回退 default，避免 int(NaN) 崩溃（鲁棒性）。"""
    v = row.get(key, default)
    try:
        if pd.isna(v):
            return default
    except (TypeError, ValueError):
        pass
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


# ── 问题模式定义 ──────────────────────────────────────────────────────
# requires: 必须存在于 DataFrame 才启用此模式
# filter_fn: 接收 df，返回 filtered df（候选用户池）
# rank_by / rank_asc: 在候选池中如何排序以取代表性用户
#   取较极端用户（默认 95% 分位，规避绝对脏数据），使案例"问题最突出"、运营更易理解
# key_features: 提取哪些字段放入 case

_PATTERNS: list[dict] = [
    {
        "pattern_id": "category_mismatch",
        "label": "品类错配",
        "requires": ["pre_mkt_product_browse_match"],
        "filter_fn": lambda df: df[
            (df["pre_mkt_product_browse_match"] == 0) & (df["is_converted"] == 0)
        ],
        "rank_by": None,  # 取中位数行
        # 前 3 个作为展示指标：浏览品类数 / 最深兴趣品类 / 目标品类浏览次数
        # （直接体现"想买的没推、推的没看"，避免裸露 0/1 浏览标志位）
        "key_features": [
            "pre_product_category_cnt", "pre_top_interest_product", "pre_target_product_visit_cnt",
            "pre_target_product_depth", "pre_max_funnel_depth",
            "pre_flight_visit_cnt", "pre_hotel_visit_cnt", "pre_train_visit_cnt",
            "pre_mkt_product_browse_match", "activity_touch_cnt", "is_converted",
        ],
    },
    {
        "pattern_id": "marketing_fatigue",
        "label": "营销疲劳",
        "requires": ["pre_mkt_touch_cnt"],
        "filter_fn": lambda df: df[
            (df["is_converted"] == 0) & (df["pre_mkt_touch_cnt"] >= 5)
        ],
        "rank_by": "pre_mkt_touch_cnt",
        "key_features": [
            "pre_mkt_touch_cnt", "pre_mkt_direct_exit_cnt", "pre_mkt_fatigue_cnt",
            "pre_popup_reject_cnt", "pre_push_touch_cnt", "pre_popup_touch_cnt",
            "activity_touch_cnt", "pre_over_mkt_flag",
            "pre_max_funnel_depth", "is_converted",
        ],
    },
    {
        "pattern_id": "no_mainflow",
        "label": "落地即离",
        "requires": ["pre_max_funnel_depth"],
        "filter_fn": lambda df: df[
            (df["is_converted"] == 0) & (df["pre_max_funnel_depth"] == 0)
        ],
        "rank_by": None,
        "key_features": [
            "pre_max_funnel_depth", "pre_mainflow_event_cnt", "pre_funnel_pages_cnt",
            "activity_click_cnt", "pre_reached_homepage", "pre_reached_list",
            "pre_mkt_product_browse_match", "pre_total_event_cnt", "is_converted",
        ],
    },
    {
        "pattern_id": "high_intent_unconverted",
        "label": "高意向未转化",
        "requires": ["pre_max_funnel_depth"],
        "filter_fn": lambda df: df[
            (df["is_converted"] == 0) & (df["pre_max_funnel_depth"] >= 3)
        ],
        "rank_by": "pre_max_funnel_depth",
        "key_features": [
            "pre_max_funnel_depth", "pre_mainflow_event_cnt", "pre_reached_payment",
            "pre_create_order_cnt", "pre_complete_order_cnt",
            "pre_target_product_depth", "pre_coupon_collect_cnt",
            "pre_last_coupon_product", "pre_rp_target_product",
            "pre_back_to_booking_cnt", "is_converted",
        ],
    },
    {
        "pattern_id": "cross_category",
        "label": "跨品类比价",
        "requires": ["pre_is_cross_category"],
        "filter_fn": lambda df: df[
            (df["is_converted"] == 0) & (df["pre_is_cross_category"] == 1)
        ],
        "rank_by": "pre_train_depth",
        # 前 3 个展示指标：浏览品类数 / 最深兴趣品类 / 目标品类浏览次数
        "key_features": [
            "pre_product_category_cnt", "pre_top_interest_product", "pre_target_product_visit_cnt",
            "pre_train_depth", "pre_flight_depth",
            "pre_is_cross_category", "pre_target_product_depth",
            "pre_mkt_product_browse_match", "is_converted",
        ],
    },
    {
        "pattern_id": "ads_mismatch",
        "label": "广告站内不匹配",
        "requires": ["ads_insite_match_flag"],
        "filter_fn": lambda df: df[
            (df["is_converted"] == 0) & (df["ads_insite_match_flag"] == 0)
        ],
        "rank_by": None,
        # 优先收窄到"站外、站内都是可识别真实品类且不同"的清晰双产品错配（如 机票→度假），
        # 帮助用户更直观理解；无此类样本时返回空、退回全体候选
        "refine_fn": lambda df: _ads_double_product_subset(df),
        "key_features": [
            "ads_product_name", "first_insite_product_name", "pre_max_funnel_depth",
            "ads_insite_match_flag", "has_ads_touch", "has_insite_touch",
            "activity_touch_cnt", "is_converted",
        ],
    },
    {
        "pattern_id": "funnel_regression",
        "label": "漏斗回退",
        "requires": ["pre_back_to_booking_cnt"],
        "filter_fn": lambda df: df[
            (df["is_converted"] == 0)
            & (df["pre_back_to_booking_cnt"] > 0)
            & (df["pre_max_funnel_depth"] >= 3)
        ],
        "rank_by": "pre_back_to_booking_cnt",
        "key_features": [
            "pre_max_funnel_depth", "pre_back_to_booking_cnt", "pre_back_to_list_cnt",
            "pre_mainflow_event_cnt", "pre_reached_payment", "pre_funnel_regression_after_mkt",
            "pre_coupon_collect_cnt", "pre_last_coupon_product", "pre_rp_target_product",
            "is_converted",
        ],
    },
    {
        "pattern_id": "created_not_paid",
        "label": "创单未付",
        "requires": ["is_converted", "is_paid"],
        "filter_fn": lambda df: df[
            (df["is_converted"] == 1) & (df["is_paid"] == 0)
        ],
        "rank_by": None,
        "key_features": [
            "pre_max_funnel_depth", "pre_mainflow_event_cnt", "pre_reached_payment",
            "pre_create_order_cnt", "pre_coupon_collect_cnt", "pre_last_coupon_product",
            "pre_target_product_depth", "is_converted", "is_paid",
        ],
    },
    {
        "pattern_id": "post_order_disturb",
        "label": "成单后打扰",
        "requires": ["pre_has_complete_order", "pre_last_order_to_touch_min"],
        "filter_fn": lambda df: df[
            (df["pre_has_complete_order"] == 1) & (df["is_converted"] == 0)
        ],
        "rank_by": None,
        "key_features": [
            "pre_last_order_to_touch_min", "pre_complete_order_cnt", "pre_last_order_product",
            "activity_touch_cnt", "pre_has_complete_order", "is_converted",
        ],
    },
    {
        "pattern_id": "high_cvr_positive",
        "label": "高转化典型",
        "requires": [],
        "filter_fn": lambda df: df[
            (df["is_converted"] == 1) & (df["pre_max_funnel_depth"] >= 3)
        ],
        "rank_by": "pre_mainflow_event_cnt",
        "key_features": [
            "pre_max_funnel_depth", "pre_mainflow_event_cnt", "pre_coupon_collect_cnt",
            "pre_mkt_product_browse_match", "pre_target_product_depth",
            "pre_reached_payment", "is_converted",
        ],
    },
]


# ── 主入口 ────────────────────────────────────────────────────────────

def extract_case_pool(df: pd.DataFrame, state: dict | None = None) -> dict[str, dict]:
    """
    对每种问题模式，从 df 中选出 1 个代表性用户并提取关键特征。
    返回 case_pool dict，key=pattern_id，供 LLM synthesis 阶段使用。
    """
    pool: dict[str, dict] = {}
    for pat in _PATTERNS:
        pid = pat["pattern_id"]
        # 检查必要列是否存在
        missing = [c for c in pat["requires"] if c not in df.columns]
        if missing:
            continue
        # 过滤候选用户
        try:
            candidates = pat["filter_fn"](df)
        except Exception:
            continue
        if candidates.empty:
            continue

        row = _select_case_user(candidates, pat)
        if row is None:
            continue

        key_feats = _extract_features(row, pat["key_features"])
        path_events = _build_path_events(row, pid)
        user_id = _mask_user_id(row)

        pool[pid] = {
            "pattern_id":   pid,
            "pattern_label": pat["label"],
            "user_id":      user_id,
            "n_candidates": int(len(candidates)),
            "key_features": key_feats,
            "path_events":  path_events,
            "touch_hour":   _sint(row, "touch_hour", 10),
            "is_converted": _sint(row, "is_converted", 0),
        }
        # 品类错配/跨品类：指定展示指标（最多浏览品类 + 次数 + 目标品类浏览次数），
        # 避免裸露 0/1 浏览标志位 / 误导性的"浏览品类数"（实为不同 product_name 数）
        dm = _category_display_metrics(row, pid)
        if dm:
            pool[pid]["display_metrics"] = dm

    return pool


# ── 辅助函数 ──────────────────────────────────────────────────────────

def _select_representative(df: pd.DataFrame, rank_by: str | None,
                           rank_asc: bool = False, extreme_q: float = 0.95) -> pd.Series | None:
    """选取较极端的代表用户，使案例"问题最突出"、运营更易理解。

    - 有 rank_by：取该指标的高分位行（默认 95%；规避绝对极端值带来的脏数据），
      如营销疲劳取触达次数最多者、高意向取漏斗最深者。
    - 无 rank_by：退化为按 `pre_total_event_cnt` 取高分位（行为最丰富者，
      行为路径更长、案例更直观）。
    - 二者皆缺：取中位数行。
    rank_asc=True 时取低分位（如"越小越极端"的指标）。
    """
    if df.empty:
        return None
    metric = rank_by if (rank_by and rank_by in df.columns) else None
    if metric is None and "pre_total_event_cnt" in df.columns:
        metric = "pre_total_event_cnt"
    if metric:
        col = pd.to_numeric(df[metric], errors="coerce").fillna(0)
        q = float(col.quantile((1.0 - extreme_q) if rank_asc else extreme_q))
        # 找最接近该分位的真实行（保证取到数据库里真实存在的极端用户）
        idx = (col - q).abs().idxmin()
    else:
        idx = df.index[len(df) // 2]
    return df.loc[idx]


# ── 问题契合度选人（picks the user who most clearly exhibits the problem）──────
#
# 设计：每个问题不只看单一极端指标，而是用"问题契合度分(fit score)"——把该问题的
# 全部定义性特征加权求和，选取契合度高分位（默认 92%，既清晰又避开绝对脏值）的真实用户。
# 这样典型案例与"被诊断出的问题"高度一致：疲劳案例必是反复触达+疲劳退出，品类错配案例
# 必是重度浏览他类且目标品类零浏览，漏斗回退案例必是多次回退……运营一眼对得上结论。

def _col(df: pd.DataFrame, name: str) -> pd.Series:
    if name in df.columns:
        return pd.to_numeric(df[name], errors="coerce").fillna(0.0)
    return pd.Series(0.0, index=df.index)


def _fit_category_mismatch(df: pd.DataFrame) -> pd.Series:
    # 重度浏览某非目标品类 + 目标品类主流程零浏览 = 最硬的错配
    visit_cols = ["pre_flight_visit_cnt", "pre_hotel_visit_cnt", "pre_train_visit_cnt",
                  "pre_scenic_visit_cnt", "pre_car_visit_cnt", "pre_bus_visit_cnt"]
    depth_cols = ["pre_flight_depth", "pre_hotel_depth", "pre_train_depth", "pre_scenic_depth"]
    max_visit = pd.concat([_col(df, c) for c in visit_cols], axis=1).max(axis=1)
    max_depth = pd.concat([_col(df, c) for c in depth_cols], axis=1).max(axis=1)
    target_zero = (_col(df, "pre_target_product_visit_cnt") == 0).astype(float)
    # 行为更立体者更适合做案例：除浏览次数外，叠加「非目标品类漏斗深度」(列表→详情→填写)
    # 与「主流程事件数」，让选出的代表路径更丰富、更有说服力（避免浅浏览一两次的薄路径个体）。
    base = (max_visit + 5.0 * target_zero + _col(df, "pre_max_funnel_depth")
            + 2.0 * max_depth + 0.2 * _col(df, "pre_mainflow_event_cnt"))
    # ⭐ 优先从「最大错配主体群」选代表：错配人群中占比最高的非目标兴趣品类（如火车票）。
    # 诊断/行动通常建议"剔除最大错配群体"，案例须落在该群体内，二者才一致；否则会选到某个
    # 浏览次数极端但属小众品类的个体（如重度浏览酒店者），与"剔除火车票"的建议对不上。
    if "pre_top_interest_product" in df.columns:
        interest = df["pre_top_interest_product"].astype(str)
        vc = interest[~interest.isin(["无浏览", "", "nan", "None"])].value_counts()
        if len(vc):
            dominant = vc.index[0]
            base = base + 100.0 * (interest == dominant).astype(float)
    return base


def _fit_marketing_fatigue(df: pd.DataFrame) -> pd.Series:
    return (_col(df, "pre_mkt_touch_cnt") + 2.0 * _col(df, "pre_mkt_fatigue_cnt")
            + 2.0 * _col(df, "pre_mkt_direct_exit_cnt") + _col(df, "pre_popup_reject_cnt"))


def _fit_no_mainflow(df: pd.DataFrame) -> pd.Series:
    # 行为很多、营销触达很多，却从未进主流程
    return _col(df, "pre_total_event_cnt") + 2.0 * _col(df, "pre_mkt_touch_cnt")


def _fit_high_intent(df: pd.DataFrame) -> pd.Series:
    return (3.0 * _col(df, "pre_max_funnel_depth") + _col(df, "pre_mainflow_event_cnt")
            + 5.0 * _col(df, "pre_create_order_cnt"))


def _fit_cross_category(df: pd.DataFrame) -> pd.Series:
    # 两个品类都浏览得深 = 典型比价：取各品类漏斗深度的"最高两项之和"
    depth_cols = ["pre_hotel_depth", "pre_flight_depth", "pre_train_depth", "pre_scenic_depth"]
    depths = pd.concat([_col(df, c) for c in depth_cols], axis=1)
    # fix18(2026-08-04)等价改写:原 apply(axis=1) 逐行起 Python lambda,千万行级
    # 是 prepare 的显著热点之一。_col 已 fillna(0) 保证无 NaN,np.sort 每行取
    # 最大两项之和与原 sorted(reverse=True)[:2] 逐位一致(两数相加满足交换律)。
    vals = np.sort(depths.to_numpy(dtype=float), axis=1)
    top2 = pd.Series(vals[:, -2:].sum(axis=1), index=depths.index)
    return top2 + 0.1 * _col(df, "pre_product_category_cnt")


def _fit_ads_mismatch(df: pd.DataFrame) -> pd.Series:
    # 最清晰的站内外错配 = 站外广告品类与站内承接品类**都是可识别的真实品类且不同**
    # （如 站外推「机票」→站内承接「度假」），强力优先；否则退而取站外品类可识别者，
    # 避开 ads_product_name 为渠道/版本名（历史版本APP/客户端运营）的脏样本。
    if "ads_product_name" in df.columns and "first_insite_product_name" in df.columns:
        am = df["ads_product_name"].fillna("").map(lambda s: _match_product(str(s)))
        im = df["first_insite_product_name"].fillna("").map(lambda s: _match_product(str(s)))
        clean = pd.Series(
            [100.0 if (a and b and a != b) else (3.0 if a else 0.0) for a, b in zip(am, im)],
            index=df.index)
    else:
        clean = pd.Series(0.0, index=df.index)
    return (clean + _col(df, "pre_max_funnel_depth") + _col(df, "activity_touch_cnt")
            + 0.1 * _col(df, "pre_mainflow_event_cnt"))


def _fit_funnel_regression(df: pd.DataFrame) -> pd.Series:
    return (2.0 * _col(df, "pre_back_to_booking_cnt") + _col(df, "pre_back_to_list_cnt")
            + _col(df, "pre_funnel_regression_after_mkt"))


def _fit_high_cvr_positive(df: pd.DataFrame) -> pd.Series:
    return (2.0 * _col(df, "pre_max_funnel_depth") + 5.0 * _col(df, "is_paid")
            + _col(df, "pre_mainflow_event_cnt"))


def _fit_created_not_paid(df: pd.DataFrame) -> pd.Series:
    # 创单未付：取触达前已逼近支付（到过支付页/漏斗深、行为多）的用户，最贴近"临门一脚漏付"
    return (2.0 * _col(df, "pre_reached_payment") + _col(df, "pre_max_funnel_depth")
            + 0.1 * _col(df, "pre_mainflow_event_cnt") + _col(df, "pre_create_order_cnt"))


def _fit_post_order_disturb(df: pd.DataFrame) -> pd.Series:
    # 成单后打扰：成单到触达间隔越短越典型；叠加成单次数与当日触达次数
    lt = _col(df, "pre_last_order_to_touch_min")
    proximity = 1000.0 / (lt + 1.0)   # 间隔越小分越高
    return proximity + _col(df, "pre_complete_order_cnt") + _col(df, "activity_touch_cnt")


_PATTERN_FIT: dict = {
    "category_mismatch": _fit_category_mismatch,
    "marketing_fatigue": _fit_marketing_fatigue,
    "no_mainflow":       _fit_no_mainflow,
    "high_intent_unconverted": _fit_high_intent,
    "cross_category":    _fit_cross_category,
    "ads_mismatch":      _fit_ads_mismatch,
    "funnel_regression": _fit_funnel_regression,
    "high_cvr_positive": _fit_high_cvr_positive,
    "created_not_paid":  _fit_created_not_paid,
    "post_order_disturb": _fit_post_order_disturb,
}


def _select_by_fit(candidates: pd.DataFrame, scores: pd.Series, q: float = 0.92) -> pd.Series | None:
    """取问题契合度高分位（默认 92%）的真实用户：清晰体现问题，又避开绝对极端脏值。"""
    s = scores.reindex(candidates.index).fillna(0.0)
    if float(s.max()) <= 0:
        return None  # 无区分度，交回退处理
    qv = float(s.quantile(q))
    idx = (s - qv).abs().idxmin()
    return candidates.loc[idx]


def _select_case_user(candidates: pd.DataFrame, pat: dict) -> pd.Series | None:
    """优先按问题契合度选人；无契合函数或无区分度时退化为单指标高分位选人。"""
    # 可选：先收窄到"最清晰"的候选子集（如站内外双产品错配）；子集为空则用全体
    refine = pat.get("refine_fn")
    if refine is not None:
        try:
            narrowed = refine(candidates)
            if narrowed is not None and not narrowed.empty:
                candidates = narrowed
        except Exception:
            pass
    fit_fn = _PATTERN_FIT.get(pat.get("pattern_id"))
    if fit_fn is not None:
        try:
            row = _select_by_fit(candidates, fit_fn(candidates))
            if row is not None:
                return row
        except Exception:
            pass
    return _select_representative(candidates, pat.get("rank_by"), pat.get("rank_by_asc", False))


def _mask_user_id(row: pd.Series) -> str:
    """脱敏用户 ID：取 mapid 后 6 位。"""
    mid = str(row.get("mapid", "") or "")
    suffix = re.sub(r"\D", "", mid)[-6:] if mid else "000000"
    return f"U{suffix}***"


def _extract_features(row: pd.Series, cols: list[str]) -> dict[str, Any]:
    """提取指定列的值，自动转换类型，跳过缺失列。"""
    out: dict[str, Any] = {}
    for c in cols:
        if c not in row.index:
            continue
        val = row[c]
        if pd.isna(val):
            out[c] = None
        elif isinstance(val, (np.integer,)):
            out[c] = int(val)
        elif isinstance(val, (np.floating,)):
            out[c] = round(float(val), 4)
        elif isinstance(val, (np.bool_,)):
            out[c] = bool(val)
        else:
            out[c] = val
    return out


# 纯 UI 事件噪声词（不含业务信息），用于路径去噪
_UI_NOISE = re.compile(
    r"(曝光|点击|关闭|刷新|提醒|上报|接口|失活|导航|启动|tab|Tab|TAB|顶部栏|底部|待支付|待出行"
    r"|算法策略|banner|Banner|瀑布流|iOS|Android|新瓷片|引导文案|广场|创作中心"
    r"|权益外显|二楼item|频道|搜索推荐|首页tab|首页顶栏金刚位|一级金刚区|二级金刚区)",
    re.IGNORECASE,
)

# 各问题模式下"与问题最相关"的 modelname：路径展示时优先保留这些节点，其余压缩为省略号。
# 首末行为始终保留，故此处只约束中段关键节点的选取。
_PATTERN_KEY_MODELS: dict[str, set] = {
    "marketing_fatigue":       {"营销", "红包"},   # 反复营销骚扰
    "no_mainflow":             {"营销", "红包"},   # 无主流程，看到底被推了什么
    "ads_mismatch":            {"营销"},           # 站外广告→站内承接
    "category_mismatch":       {"主流程", "搜索"}, # 真实浏览/搜索的品类
    "cross_category":          {"主流程", "搜索"}, # 跨品类比价
    "high_intent_unconverted": {"主流程"},         # 深漏斗主流程
    "funnel_regression":       {"主流程"},         # 主流程回退
    "high_cvr_positive":       {"主流程", "红包"}, # 转化链路
    "created_not_paid":        {"主流程"},         # 创单前深漏斗
    "post_order_disturb":      {"营销"},           # 成单后被营销打扰
}

# 主流程漏斗页深度（越深越关键）：漏斗类/高意向问题优先展示深层页面而非首页/列表
_FUNNEL_RANK: dict[str, float] = {
    "支付页": 5, "填写页": 4, "详情页": 3, "列表页": 2, "搜索页": 2, "搜索": 2,
    "项目首页": 1, "大首页": 0.5, "首页": 0.5,
}

# 以营销渠道本身为核心证据的问题：保留全部营销触点（含 iOS生态/OPPO预装/客户端运营 等渠道名）；
# 其余问题（品类/漏斗）里这些营销渠道噪声不展示。
_MKT_PATTERNS = {"marketing_fatigue", "no_mainflow", "ads_mismatch"}

# 主流程品类标准化（覆盖国际机票/酒店等长词；用于"是否真实产品浏览"判定与非目标加权）
_PRODUCTS: list[tuple[str, str]] = [
    ("国际机票", "机票"), ("机票", "机票"), ("国际酒店", "酒店"), ("酒店", "酒店"),
    ("火车票", "火车票"), ("门票", "景区"), ("景区", "景区"), ("租车", "用车"),
    ("用车", "用车"), ("汽车票", "汽车票"), ("度假", "度假"), ("邮轮", "邮轮"),
]


def _match_product(s: str) -> str | None:
    """从 majorname 里识别标准化品类；无品类词返回 None（多为错标渠道名/UI 文案）。"""
    s = s or ""
    for raw, std in _PRODUCTS:
        if raw in s:
            return std
    return None


def _ads_double_product_subset(df: pd.DataFrame) -> "pd.DataFrame":
    """收窄到「站外广告品类、站内承接品类都是可识别真实品类且不同」的清晰双产品错配候选，
    并**结合营销活动目标品类**优先选取：① 站内承接==目标品类（站外≠本活动）最直观；
    ② 否则站外广告==目标品类；③ 都没有则取任意双产品错配。"""
    if "ads_product_name" not in df.columns or "first_insite_product_name" not in df.columns:
        return df.iloc[0:0]
    am = df["ads_product_name"].fillna("").map(lambda s: _match_product(str(s)))
    im = df["first_insite_product_name"].fillna("").map(lambda s: _match_product(str(s)))
    diff = pd.Series([bool(a) and bool(b) and a != b for a, b in zip(am, im)], index=df.index)
    if not diff.any():
        return df.iloc[0:0]
    sub, am_s, im_s = df[diff], am[diff], im[diff]
    target = ""
    if "activity_product_name" in df.columns and len(df):
        target = _clean_product(df["activity_product_name"].iloc[0]) or ""
    if target:
        insite_t = (im_s == target)               # 站内承接==本活动目标品类（最相关）
        if insite_t.any():
            return sub[insite_t.values]
        ads_t = (am_s == target)                  # 站外广告==本活动目标品类
        if ads_t.any():
            return sub[ads_t.values]
    return sub


def _node_relevance(model: str, detail: str, major: str,
                    pattern_id: str | None, target: str) -> float | None:
    """给单个触点打"与问题相关性"分；返回 None 表示该节点应丢弃。

    - 营销/红包节点：营销类问题（疲劳/落地即离/站内外）保留全部触点；品类/漏斗问题里
      丢弃广告渠道噪声触点（iOS生态/banner/曝光等），避免无关营销噪声挤占。
    - 主流程节点：majorname 必须可识别为某品类（否则多为错标渠道名，丢弃）；按漏斗页深度加分；
      品类问题中"非目标品类"浏览额外加权（揭示真实兴趣）。
    - 其余（公共页面/搜索等）：UI 噪声丢弃，命中关键 model 给高分否则作上下文。
    """
    major = (major or "").strip()
    key_models = _PATTERN_KEY_MODELS.get(pattern_id or "", set())
    base = 2.0 if model in key_models else 0.3

    if model in ("营销", "红包"):
        if pattern_id not in _MKT_PATTERNS and _UI_NOISE.search(major):
            return None  # 品类/漏斗问题不展示营销渠道噪声
        if pattern_id == "ads_mismatch" and detail == "广告投放":
            base += 2.0  # 站外广告触点
        return base

    if _UI_NOISE.search(major):
        return None      # banner/曝光/iOS 等纯 UI 噪声

    if model == "主流程":
        prod = _match_product(major)
        if prod is None:
            return None  # 主流程节点须关于某品类，否则多为错标渠道名
        # 仅当主流程是该问题关键 model 时叠加漏斗深度/非目标加权；
        # 否则（如营销疲劳）主流程只作上下文，分数保持低位，避免挤占营销触点
        if "主流程" in key_models:
            base += _FUNNEL_RANK.get(detail, 0.0)
            if pattern_id in ("category_mismatch", "cross_category") and target and prod != target:
                base += 4.0  # 非目标品类的真实浏览 = 该问题最关键证据
        return base

    return base


def _split_seq(raw) -> list[str]:
    """把 `a->b->c` 或 `a|b|c` 序列切成节点列表，去空白。"""
    if raw is None:
        return []
    s = str(raw).strip()
    if not s or s.lower() == "nan":
        return []
    return [p.strip() for p in re.split(r"->|\|", s) if p.strip()]


def _fmt_node(model: str, detail: str, major: str, maxlen: int = 16) -> str:
    """把单个触点的三维信息拼成 `modelname:detailname:majorname`（去空/去重复段/截断超长文案）。"""
    parts: list[str] = []
    for x in (model, detail, major):
        x = (x or "").strip()
        if not x or x.lower() == "nan" or x in parts:
            continue
        if len(x) > maxlen:        # 截断超长 majorname（如短信全文），避免撑爆路径
            x = x[:maxlen] + "…"
        parts.append(x)
    return ":".join(parts)


def _build_behavior_path(row: pd.Series, pattern_id: str | None = None,
                         max_nodes: int = 7) -> str:
    """把触达前 modelname / detailname / majorname 三条时序序列合并为
    `model:detail:major → … → model:detail:major` 的用户行为路径，
    **聚焦与问题最相关的关键节点**，其余压缩为省略号 `⋯`。

    选取规则：
      - 三序列同源同长，按下标对齐 zip；按 `_node_relevance` 丢弃纯 UI 噪声、折叠相邻重复。
      - **首次行为（路径起点）与最近一次行为（最接近触达）始终保留**。
      - 中段按相关性打分（疲劳看营销、漏斗/高意向看深层漏斗页、品类问题看非目标品类浏览、
        站内外看广告投放）取最关键的若干个；**重复出现的同一节点合并为 `节点×N`**，
        既去冗余又保留"反复浏览/反复触达"的强度信号。
      - 被跳过的非关键中段以 `⋯` 表示，使路径长短反映真实跳跃而非固定 N 步。
    缺 majorname 序列时退化为 model:detail；三序列皆缺返回空串。
    """
    model_seq  = _split_seq(row.get("pre_path_model_seq"))
    detail_seq = _split_seq(row.get("pre_path_detail_seq"))
    major_seq  = _split_seq(row.get("pre_path_major_seq"))
    n = max(len(model_seq), len(detail_seq), len(major_seq))
    if n == 0:
        return ""
    target = _clean_product(row.get("activity_product_name"))

    # 解析为节点记录：折叠相邻重复(累计 ×N)，被丢弃的非关键节点(公共页面/UI噪声)不直接删除，
    # 而是在下一个关键节点上记 gap_before=True，渲染时以 ⋯ 体现"中间略过了若干非重点步骤"，
    # 使路径既突出重点、又如实反映真实跳跃（不再把 21 步的旅程压成看似 3 步）。
    recs: list[dict] = []
    prev_key: tuple | None = None
    pending_gap = False
    for i in range(n):
        m = model_seq[i]  if i < len(model_seq)  else ""
        d = detail_seq[i] if i < len(detail_seq) else ""
        j = major_seq[i]  if i < len(major_seq)  else ""
        score = _node_relevance(m, d, j, pattern_id, target)
        node = _fmt_node(m, d, j)
        if score is None or not node:
            pending_gap = True        # 非关键节点被略过 → 标记跳跃
            prev_key = None           # 阻断跨噪声的"相邻"误折叠
            continue
        if recs and (m, j) == prev_key:   # 真·相邻重复 → 累计次数（保留反复浏览强度）
            recs[-1]["count"] += 1
            continue
        prev_key = (m, j)
        # 仅"可识别漏斗页"的主流程节点参与漏斗深度/回退判定，
        # 避免 detail 错标为渠道名（短信/酒店等）的节点产生伪回退
        fdepth = _FUNNEL_RANK.get(d) if m == "主流程" else None
        recs.append({"str": node, "score": score, "fdepth": fdepth, "regress": False,
                     "count": 1, "gap_before": pending_gap})
        pending_gap = False

    if not recs:
        return ""
    # 漏斗回退标记：主流程节点漏斗深度低于"上一个主流程节点"→ 回退（犹豫/比价信号）
    prev_fd: float | None = None
    for r in recs:
        fd = r["fdepth"]
        if fd is not None:
            r["regress"] = prev_fd is not None and fd < prev_fd
            prev_fd = fd
    # 漏斗回退问题：提升回退节点权重，确保"回退的那一跳"被选中展示
    if pattern_id == "funnel_regression":
        for r in recs:
            if r["regress"]:
                r["score"] += 5.0

    cnt = len(recs)
    for idx, r in enumerate(recs):
        r["i"] = idx

    # 选展示节点：≤max_nodes 全保留；否则 首+末 始终保留，中段按相关性取 top(max_nodes-2)
    if cnt <= max_nodes:
        keep = set(range(cnt))
    else:
        keep = {0, cnt - 1}
        mids = sorted(recs[1:-1], key=lambda r: (-r["score"], -r["i"]))[:max_nodes - 2]
        keep.update(r["i"] for r in mids)
    displayed = sorted(keep)

    # 关键节点：相关性最高；同分时取重复次数最多（反复浏览/触达信号更强）
    ki = max(displayed, key=lambda i: (recs[i]["score"], recs[i]["count"]))

    # 输出：节点前若有被略过的非重点步骤(gap_before)或被略过的关键中段(下标不连续) → 插 ⋯；
    #       重复节点标 ×N，回退节点标 ↩回退，关键节点加粗标红。
    out: list[str] = []
    prev_i: int | None = None
    for i in displayed:
        if out and (recs[i]["gap_before"] or (prev_i is not None and i > prev_i + 1)):
            out.append("⋯")
        s = recs[i]["str"]
        if recs[i]["count"] > 1:
            s += f"×{recs[i]['count']}"
        if pattern_id == "funnel_regression" and recs[i]["regress"]:
            s += "↩回退"
        if i == ki and recs[i]["score"] >= 2.0:
            s = f"**{s}**"
        out.append(s)
        prev_i = i
    return " → ".join(out)


# 各品类红包标志位 → 中文品类名（仅有 0/1 标志，无每品类张数/金额）
_RP_CAT_FIELDS: list[tuple[str, str]] = [
    ("pre_rp_flight", "机票"), ("pre_rp_hotel", "酒店"), ("pre_rp_train", "火车票"),
    ("pre_rp_scenic", "景区"), ("pre_rp_car", "用车"), ("pre_rp_bus", "汽车票"),
    ("pre_rp_vacation", "度假"),
]


def _clean_product(v) -> str:
    s = str(v or "").strip()
    return "" if s.lower() in ("", "nan", "无") else s


def _coupon_event(row: pd.Series, hour: int) -> dict | None:
    """构造红包行为事件，展示用户领取的**各品类红包覆盖情况**与首末轨迹。

    基础数据仅含各品类是否领过（0/1 标志）+ 首/末领券品类，
    **无每品类张数、无红包金额/面额**；故展示"覆盖了哪些品类"与首末品类，不编造金额/张数。"""
    cnt = _sint(row, "pre_coupon_collect_cnt", 0)
    if cnt <= 0:
        return None
    cats = [zh for f, zh in _RP_CAT_FIELDS if _sint(row, f, 0) == 1]
    if _sint(row, "pre_rp_blackwhale_card", 0) or _sint(row, "pre_has_blackwhale", 0):
        cats.append("黑鲸卡")
    if _sint(row, "pre_rp_payment", 0):
        cats.append("支付券")
    first_rp = _clean_product(row.get("pre_first_coupon_product"))
    last_rp  = _clean_product(row.get("pre_last_coupon_product"))
    target   = _clean_product(row.get("activity_product_name"))

    desc = f"触达前领券 {cnt} 次"
    if cats:
        desc += f"，覆盖 {len(cats)} 个品类：{'、'.join(cats)}"
    # 首→末领券品类轨迹（体现兴趣迁移）
    if first_rp and last_rp and first_rp != last_rp:
        desc += f"；首张「{first_rp}」→ 最近「{last_rp}」"
    elif last_rp:
        desc += f"；最近一次「{last_rp}」"
    # 活动目标品类券有无（机票活动用户常无机票券，是价格错配信号）
    if target:
        has_t = (target in cats) or bool(_sint(row, "pre_rp_target_product", 0))
        desc += f"；{'含' if has_t else '缺'}活动目标「{target}」券"
    return {
        "time": f"{max(hour-1, 0):02d}:30",
        "action": desc,
        "type": "normal",
        "note": "coupon_behavior（仅品类覆盖，无张数/金额）",
    }


# 标准品类 → 主流程访问次数字段（用于"真实兴趣 vs 目标品类"对比）
_VISIT_CNT_FIELD: dict[str, str] = {
    "机票": "pre_flight_visit_cnt", "酒店": "pre_hotel_visit_cnt", "火车票": "pre_train_visit_cnt",
    "景区": "pre_scenic_visit_cnt", "用车": "pre_car_visit_cnt", "汽车票": "pre_bus_visit_cnt",
}


def _browsed_categories_ranked(row: pd.Series) -> list[tuple[str, int]]:
    """各品类主流程浏览次数（>0），按次数降序返回 [(品类, 次数), ...]。"""
    items = [(prod, _sint(row, field, 0)) for prod, field in _VISIT_CNT_FIELD.items()]
    items = [(c, n) for c, n in items if n > 0]
    items.sort(key=lambda x: -x[1])
    return items


def _most_browsed_category(row: pd.Series) -> tuple[str, int]:
    """返回用户浏览次数最多的品类及其次数（基于各品类主流程访问次数）。"""
    ranked = _browsed_categories_ranked(row)
    return ranked[0] if ranked else ("", 0)


def _category_display_metrics(row: pd.Series, pattern_id: str) -> list[dict] | None:
    """品类相关问题的展示指标（口径：`*_visit_cnt` 均为触达前 modelname='主流程' 事件数）。

    - 品类错配：最多浏览品类 + 该品类主流程浏览次数 + 目标品类主流程浏览次数
      （目标浏览=0 时友好展示"从未浏览"并标红，最直观的错配信号）。
    - 跨品类比价：浏览品类数 + 第1/第2 浏览品类及次数（目标口径不适用，避免与"最多浏览"打架）。
    """
    if pattern_id == "cross_category":
        ranked = _browsed_categories_ranked(row)
        if len(ranked) >= 2:
            return [
                {"val": str(len(ranked)), "label": "主流程浏览品类数"},
                {"val": f"{ranked[0][0]} {ranked[0][1]}次", "label": "浏览最多品类"},
                {"val": f"{ranked[1][0]} {ranked[1][1]}次", "label": "次多浏览品类"},
            ]
        return None  # 不足两类，退回默认 key_features 指标
    if pattern_id != "category_mismatch":
        return None
    top_cat, top_cnt = _most_browsed_category(row)
    target = _clean_product(row.get("activity_product_name")) or "目标品类"
    target_cnt = _sint(row, "pre_target_product_visit_cnt", 0)
    if target_cnt == 0:
        target_metric = {"val": "从未浏览", "label": f"目标「{target}」主流程浏览", "alert": True}
    else:
        target_metric = {"val": str(target_cnt), "label": f"目标「{target}」主流程浏览次数"}
    return [
        {"val": top_cat or "无浏览", "label": "主流程浏览最多品类"},
        {"val": str(top_cnt), "label": "该品类主流程浏览次数"},
        target_metric,
    ]


def _build_path_events(row: pd.Series, pattern_id: str) -> list[dict]:
    """从行数据构建 3-4 个行为时序事件，用于 LLM 生成叙述时参考。"""
    hour = _sint(row, "touch_hour", 10)
    events: list[dict] = []

    # ── 活动前用户行为路径（model:detail:major 三维合并；聚焦问题相关节点）
    behavior_path = _build_behavior_path(row, pattern_id)
    if behavior_path:
        events.append({
            "time": f"{max(hour-1, 0):02d}:00",
            "action": f"用户行为路径：{behavior_path}",
            "type": "normal",
            "note": "触达前行为路径（modelname:detailname:majorname）",
        })

    # ── 活动前红包行为（若有；基础数据无金额，仅品类信息）
    ce = _coupon_event(row, hour)
    if ce:
        events.append(ce)

    # ── 活动触达
    events.append({
        "time": f"{hour:02d}:00",
        "action": "触达本次营销活动",
        "type": "normal",
        "note": "activity_touch",
    })

    # ── 模式专属事件
    if pattern_id == "category_mismatch":
        match_val = row.get("pre_mkt_product_browse_match", 0)
        top, top_visits = _most_browsed_category(row)   # 与展示指标口径一致
        target = _clean_product(row.get("activity_product_name")) or "目标品类"
        target_visits = _sint(row, "pre_target_product_visit_cnt", 0)
        target_depth = _sint(row, "pre_target_product_depth", 0)
        # 对比：浏览最多品类的主流程强度 vs 目标品类的主流程浏览强度
        if top and top != target:
            tgt_part = (f"目标「{target}」从未进入主流程"
                        if target_visits == 0 else
                        f"目标「{target}」仅主流程浏览 {target_visits} 次(漏斗{target_depth})")
            action = (f"主流程浏览最多「{top}」{top_visits} 次 vs {tgt_part}"
                      " —— 推送品类与用户兴趣错配")
        else:
            action = f"落地页展示「{target}」活动，与用户历史兴趣不匹配"
        events.append({
            "time": f"{hour:02d}:01",
            "action": action,
            "type": "issue",
            "note": f"browse_match={match_val}",
        })
        events.append({
            "time": f"{hour:02d}:02",
            "action": "页面关闭，无后续行为",
            "type": "normal",
        })

    elif pattern_id == "marketing_fatigue":
        touch_cnt = _sint(row, "pre_mkt_touch_cnt", 0)
        direct_exit = _sint(row, "pre_mkt_direct_exit_cnt", 0)
        events.append({
            "time": f"{hour:02d}:01",
            "action": f"历史累计营销触达 {touch_cnt} 次，直接退出 {direct_exit} 次",
            "type": "issue",
            "note": "marketing_fatigue_signal",
        })
        events.append({
            "time": f"{hour:02d}:02",
            "action": "本次触达后直接退出，未产生任何点击",
            "type": "normal",
        })

    elif pattern_id == "no_mainflow":
        events.append({
            "time": f"{hour:02d}:01",
            "action": "进入活动落地页后未进入任何主流程页面",
            "type": "issue",
        })
        events.append({
            "time": f"{hour:02d}:02",
            "action": "离开，转化率 0%",
            "type": "normal",
        })

    elif pattern_id == "high_intent_unconverted":
        depth = _sint(row, "pre_max_funnel_depth", 0)
        orders = _sint(row, "pre_create_order_cnt", 0)
        events.append({
            "time": f"{hour:02d}:01",
            "action": f"进入主流程，漏斗深度 {depth}（含预订页）",
            "type": "normal",
        })
        if orders > 0:
            events.append({
                "time": f"{hour:02d}:05",
                "action": f"创建订单 {orders} 次，但未完成支付",
                "type": "issue",
                "note": "遗单",
            })
        else:
            events.append({
                "time": f"{hour:02d}:05",
                "action": "到达预订页后回退，未创建订单",
                "type": "issue",
            })

    elif pattern_id == "cross_category":
        ranked = _browsed_categories_ranked(row)
        if len(ranked) >= 2:
            (c1, n1), (c2, n2) = ranked[0], ranked[1]
            action = f"同时浏览「{c1}」{n1}次、「{c2}」{n2}次等 {len(ranked)} 个品类，比价后未决策离开"
        elif ranked:
            action = f"浏览「{ranked[0][0]}」{ranked[0][1]}次后跨品类比价、未决策离开"
        else:
            action = "跨品类比价后未决策，离开"
        events.append({
            "time": f"{hour:02d}:10",
            "action": action,
            "type": "issue",
        })

    elif pattern_id == "ads_mismatch":
        ads_prod = str(row.get("ads_product_name", "") or "广告品类")
        insite_prod = str(row.get("first_insite_product_name", "") or "站内品类")
        events.append({
            "time": f"{hour:02d}:01",
            "action": f"广告承接：{ads_prod} → 站内：{insite_prod}（品类不一致）",
            "type": "issue",
        })
        events.append({
            "time": f"{hour:02d}:02",
            "action": "落地内容与预期不符，立即离开",
            "type": "normal",
        })

    elif pattern_id == "funnel_regression":
        back_cnt = _sint(row, "pre_back_to_booking_cnt", 0)
        events.append({
            "time": f"{hour:02d}:01",
            "action": "进入预订页面，但反复回退到列表页",
            "type": "issue",
            "note": f"back_to_booking={back_cnt}次",
        })
        events.append({
            "time": f"{hour:02d}:15",
            "action": "最终未提交订单，流失",
            "type": "normal",
        })

    elif pattern_id == "created_not_paid":
        depth = _sint(row, "pre_max_funnel_depth", 0)
        reached_pay = _sint(row, "pre_reached_payment", 0)
        events.append({
            "time": f"{hour:02d}:03",
            "action": f"触达当日创建订单（历史漏斗已达深度 {depth}"
                      + ("、到过支付页" if reached_pay else "") + "）",
            "type": "normal",
            "note": "is_converted=1",
        })
        events.append({
            "time": f"{hour:02d}:20",
            "action": "订单停留待支付，最终未完成付款流失",
            "type": "issue",
            "note": "is_paid=0（创单→支付漏损）",
        })

    elif pattern_id == "post_order_disturb":
        _m = row.get("pre_last_order_to_touch_min", 0)
        mins = int(_m) if pd.notna(_m) else 0
        last_prod = _clean_product(row.get("pre_last_order_product")) or "已购品类"
        events.append({
            "time": f"{hour:02d}:01",
            "action": f"距上次「{last_prod}」成单仅 {mins} 分钟即被本次营销触达",
            "type": "issue",
            "note": "post_order_disturb",
        })
        events.append({
            "time": f"{hour:02d}:02",
            "action": "成单后立即被打扰，体验受损且无新增转化",
            "type": "normal",
        })

    elif pattern_id == "high_cvr_positive":
        depth = _sint(row, "pre_max_funnel_depth", 0)
        events.append({
            "time": f"{hour:02d}:01",
            "action": f"进入主流程，漏斗深度 {depth}",
            "type": "normal",
        })
        events.append({
            "time": f"{hour:02d}:08",
            "action": "完成预订支付，成功转化",
            "type": "success",
        })

    return events
