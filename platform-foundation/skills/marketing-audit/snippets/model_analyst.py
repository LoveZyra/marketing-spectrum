"""小模型转化预估。

提供：
  - ModelAnalysisResult dataclass
  - run_model_analysis(df, ...) -> ModelAnalysisResult / None
  - result.to_dict() 返回可 JSON 序列化的结构

依赖：lightgbm 或 xgboost（二选一）、scikit-learn、pandas、numpy
"""
from __future__ import annotations

import logging
import os
import re
import warnings
from dataclasses import dataclass, field
from typing import Any, Literal

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

# 模型 seg 是否把缺失值人群圈进交付条件(2026-08-14 业务定夺:默认不圈)。
# 树的真实行为里缺失行确实会落进某些叶子(叶子 oracle 用真实形态逐条验证解析
# 正确性,不受此开关影响);但交付给业务的推送人群不要"画像/行为为空"的部分 ——
# 交付形态在 oracle 之后按本开关重渲染,并用交付形态重算命中数,人数与条件严格
# 一致。要恢复"照树的原样圈(含空值)":export MA_MODEL_SEG_NULL=1。
MODEL_SEG_INCLUDE_NULL = (os.environ.get("MA_MODEL_SEG_NULL", "0").strip()
                          in ("1", "true", "yes", "on"))

warnings.filterwarnings("ignore")

TARGET_COL = "is_paid"   # 模型分析目标：最终支付成单（is_paid）。创单率仅作过程指标，不作建模目标。
# 排除原则：
#   1) 标识符（无预测价值）
#   2) 目标列本身
#   3) 数据泄漏：未转化用户为 NULL、转化用户有值 → fillna(-1) 后等价于直接告诉模型答案
#   4) 高基数字符串（path_*）：树模型无法消化
DEFAULT_EXCLUDE = {
    # ── 标识符（无预测价值）
    "mapid", "deviceid", "unionid", "activity_name", "activity_id",
    "activity_channel", "touch_date",
    # ── 目标列及衍生标签（防止泄漏）
    "is_converted", "is_paid", "convert_product", "convert_time",
    # ── 活动级信息（属于实验条件，不是用户特征，会造成反向因果）
    "activity_product_name", "last_touch_time", "first_touch_time",
    "touch_hour", "touch_period",
    # ── 高基数文本序列（树模型无法消化；nunique > 50 也会被 _prepare_features_with_target 自动剔除）
    "pre_path_model_seq", "pre_path_detail_seq",
    "pre_path_major_seq", "pre_path_product_seq",
    # ── 高基数页面名字段（页面名数量通常远超 50）
    "pre_first_touch_detail", "pre_last_touch_detail",
    "pre_first_touch_majorname", "pre_last_touch_majorname",
    "pre_first_mainflow_detail", "pre_last_mainflow_detail",
    "pre_first_mainflow_product", "pre_last_mainflow_product",
    "pre_first_mkt_activity_name", "pre_last_mkt_activity_name",
    "pre_first_search_detail", "pre_last_search_detail",
    "pre_first_search_product", "pre_last_search_product",
    "pre_last_order_product", "pre_last_coupon_product",
    "pre_first_coupon_product",
    # ── 时间戳字段（不直接入模，用衍生的时间差字段替代）
    "pre_first_event_time", "pre_last_event_time",
    "pre_first_mkt_time", "pre_last_mkt_time",
    "pre_first_mainflow_time", "pre_last_mainflow_time",
    "pre_first_coupon_time", "pre_last_coupon_time",
    "pre_first_search_time", "pre_last_search_time",
    "pre_last_order_time",
    "intotime", "label001", "last_create_order_time",
    # ── 按需求排除（2026-08-05）：timediff 不作为模型特征入模
    #    （仅模型分析口径；统计/漏斗/阈值等其余环节不受影响）
    "timediff",
}

# 整维度排除：维度 13（marketing_scene，活动静态信息与先知场景）是活动级元数据，
# 属实验条件而非用户特征，全部不入模。按 registry dimension 动态取，新增特征自动覆盖。
EXCLUDE_DIMENSIONS = ("marketing_scene",)


def _dimension_exclude() -> set[str]:
    try:
        try:
            from .feature_loader import _load_registry
        except ImportError:
            from feature_loader import _load_registry
        return {r["name"] for r in _load_registry() if r.get("dimension") in EXCLUDE_DIMENSIONS}
    except Exception:
        # 注册表读不到（无 pyyaml 等）时的静态兜底：当前维度 13 的全部字段
        return {"sceneid", "scene_name", "is_today", "scene_has_offline_node"}

ModelBackend = Literal["auto", "xgboost", "lightgbm"]


@dataclass
class FeatureImportance:
    feature: str
    importance: float
    rank: int
    direction: str = ""   # "positive" / "negative" / "mixed" / ""（未知）
    description: str = "" # 来自 feature_registry.yaml 的中文描述


@dataclass
class DecisionRule:
    rule_text: str
    predicted_cvr: float
    sample_count: int
    lift: float
    precision: float = 0.0          # 命中规则的样本中真实转化比例（评估集口径）
    recall: float = 0.0             # 命中规则的转化样本占全部转化样本的比例
    n_converted: int = 0            # 命中规则的真实转化数（审计用）
    rule_sql: str = ""              # 可执行 Spark SQL WHERE（分类切分用 cat_maps 还原 code→name）
    rule_pandas: str = ""           # 可执行 pandas 布尔表达式（与 rule_sql 同源渲染,叶子 oracle 自检/本地计数用）
    # fix19:训练采样(正样本全保留、只采负样本)后的全量外推口径。
    # sample_count 会被回填为全量估计,原始评估集命中数保留在 sample_count_raw;
    # precision_population/lift_population 用分类别采样率无偏还原真实 CVR 口径。
    sample_count_raw: int = 0       # 评估集原始命中数（审计用）
    precision_population: float = 0.0  # 全量口径下的规则真实转化率估计
    lift_population: float = 0.0       # precision_population / 全量整体CVR


@dataclass
class ScoreBucket:
    bucket: str
    score_range: str
    user_count: int
    actual_cvr: float
    predicted_cvr: float


@dataclass
class ModelAnalysisResult:
    backend: str
    n_features: int
    n_samples: int
    overall_cvr: float
    auc: float
    auc_ci_low: float = 0.0
    auc_ci_high: float = 0.0
    pos_weight: float = 1.0  # 训练时使用的 scale_pos_weight，便于审计
    top_features: list[FeatureImportance] = field(default_factory=list)
    decision_rules: list[DecisionRule] = field(default_factory=list)
    score_buckets: list[ScoreBucket] = field(default_factory=list)
    high_score_not_converted: dict = field(default_factory=dict)
    low_score_converted: dict = field(default_factory=dict)
    stratified_auc: dict = field(default_factory=dict)       # O23：{dim: {val: auc}}
    calibration: dict = field(default_factory=dict)          # O26：bins + max_gap + is_well_calibrated
    rule_stability: dict = field(default_factory=dict)       # O25：{rule_text: {dim_val: precision}}
    rule_overlap: dict = field(default_factory=dict)         # O28：jaccard matrix + redundant/complementary
    score_distribution: dict = field(default_factory=dict)   # O29：skewness, kurtosis, pct_above_0.9
    stratified_score_buckets: dict = field(default_factory=dict)  # O30：{dim: [{bucket, dim_val, cvr}]}
    note: str = ""
    # fix19:采样与统计口径审计字段
    sampled: bool = False                 # 输入 df 是否为类别不均衡下采样产物
    class_rates: tuple = (1.0, 1.0)       # (正样本采样率, 负样本采样率)
    true_overall_cvr: float = 0.0         # 全量口径成单率（未采样时 = overall_cvr）
    n_samples_population: int = 0         # 全量口径样本数估计
    stats_scope: str = "val"              # 人群/分桶/校准等统计的计算范围（fix19 起为验证集）

    def to_dict(self) -> dict:
        return {
            "backend": self.backend,
            "auc": round(self.auc, 4),
            "auc_ci": [round(self.auc_ci_low, 4), round(self.auc_ci_high, 4)],
            "auc_ci_low": round(self.auc_ci_low, 4),
            "auc_ci_high": round(self.auc_ci_high, 4),
            "overall_cvr": round(self.overall_cvr, 4),
            "n_samples": self.n_samples,
            "n_features": self.n_features,
            "pos_weight": round(self.pos_weight, 3),
            "top_features": [
                {
                    "rank": f.rank,
                    "feature": f.feature,
                    "importance": round(f.importance, 4),
                    "direction": f.direction,
                    "description": f.description,
                }
                for f in self.top_features
            ],
            "decision_rules": [
                {"rule": r.rule_text, "rule_sql": r.rule_sql,
                 "rule_pandas": r.rule_pandas,
                 "predicted_cvr": round(r.predicted_cvr, 4),
                 "lift": round(r.lift, 2), "sample_count": r.sample_count,
                 "precision": round(r.precision, 4),
                 "recall": round(r.recall, 4),
                 "n_converted": r.n_converted,
                 "sample_count_raw": r.sample_count_raw,
                 "precision_population": round(r.precision_population, 4),
                 "lift_population": round(r.lift_population, 2)}
                for r in self.decision_rules
            ],
            "score_buckets": [
                {"bucket": b.bucket, "score_range": b.score_range,
                 "user_count": b.user_count,
                 "actual_cvr": round(b.actual_cvr, 4),
                 "predicted_cvr": round(b.predicted_cvr, 4)}
                for b in self.score_buckets
            ],
            "high_score_not_converted": self.high_score_not_converted,
            "low_score_converted": self.low_score_converted,
            "stratified_auc": self.stratified_auc,
            "calibration": self.calibration,
            "rule_stability": self.rule_stability,
            "rule_overlap": self.rule_overlap,
            "score_distribution": self.score_distribution,
            "stratified_score_buckets": self.stratified_score_buckets,
            "note": self.note,
            "sampled": self.sampled,
            "class_rates": [round(self.class_rates[0], 6), round(self.class_rates[1], 6)],
            "true_overall_cvr": round(self.true_overall_cvr, 6),
            "n_samples_population": self.n_samples_population,
            "stats_scope": self.stats_scope,
        }


def _resolve_backend(backend: ModelBackend) -> str:
    if backend != "auto":
        return backend
    try:
        import lightgbm  # noqa: F401
        return "lightgbm"
    except ImportError:
        pass
    try:
        import xgboost  # noqa: F401
        return "xgboost"
    except ImportError:
        raise ImportError("请安装 lightgbm 或 xgboost：pip install lightgbm / pip install xgboost")


def _prepare_features_with_target(df: pd.DataFrame, exclude: set[str], target_col: str):
    """构建入模特征矩阵（使用指定目标列 target_col）。

    剔除流程：
      1) `exclude` 集合（DEFAULT_EXCLUDE + 用户自定义）+ 目标列本身
      1b) datetime/timedelta 等绝对时间戳列（树模型无法消化原始时间戳，
          且有意义的时间特征已由上游派生为独立数值列如 touch_hour/pre_active_span_min）
      2) 高基数字符串：`dtype==object` 且 `nunique > 50`（树模型放不进）
      3) 零方差列：fillna 之后 `nunique <= 1`（全部相同值，对模型零贡献）

    返回 (X, y, feature_names, dropped_zero_var)；dropped_zero_var 用于诊断输出。
    """
    feature_cols = [
        c for c in df.columns
        if c not in exclude and c != target_col
        and not pd.api.types.is_datetime64_any_dtype(df[c])
        and (df[c].dtype != object or df[c].nunique() <= 50)
    ]
    X = df[feature_cols].copy()
    y = df[target_col].astype(int)

    # 先把所有 Categorical 转回 object，避免残留 NaN category
    for col in X.columns:
        if hasattr(X[col], "cat"):
            X[col] = X[col].astype(object)

    num_cols = X.select_dtypes(include="number").columns
    str_cols = X.select_dtypes(include="object").columns
    X[num_cols] = X[num_cols].fillna(-1)
    # 先转 str 再 fillna，确保 XGBoost/LightGBM 看到的 category 不含 float NaN
    for col in str_cols:
        X[col] = X[col].astype(str).fillna("__NA__").replace("nan", "__NA__")

    dropped_zero_var = [c for c in X.columns if X[c].nunique(dropna=False) <= 1]
    if dropped_zero_var:
        X = X.drop(columns=dropped_zero_var)
        str_cols = [c for c in str_cols if c not in dropped_zero_var]

    for col in str_cols:
        X[col] = X[col].astype("category")

    return X, y, list(X.columns), dropped_zero_var


def _enrich_with_feature_descriptions(
    top_features: list[FeatureImportance],
    feature_loader: "Any | None",
) -> None:
    """用 FeatureLoader 为 top_features 附加中文描述（in-place）。"""
    if feature_loader is None:
        return
    for fi in top_features:
        try:
            desc = feature_loader.description(fi.feature)
            if desc and desc != fi.feature:
                fi.description = desc  # type: ignore[attr-defined]
        except Exception:
            pass


def _train_and_score(X: pd.DataFrame, y: pd.Series, backend: str):
    """训练模型并返回 (model, scores, auc, auc_ci_low, auc_ci_high, pos_weight)。

    关键改进：
      - 显式处理类不平衡：scale_pos_weight (XGB) / class_weight='balanced' (LGB)
        — 营销转化 CVR 通常 <10%，不处理会让模型偏向预测负类、AUC 虚高
      - 在 val 集上做 500 次 bootstrap，估计 AUC 95% CI，揭示估计的稳定性
    """
    from sklearn.model_selection import train_test_split
    from sklearn.metrics import roc_auc_score

    X_tr, X_val, y_tr, y_val = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y
    )

    n_pos = int((y_tr == 1).sum())
    n_neg = int((y_tr == 0).sum())
    pos_weight = (n_neg / n_pos) if n_pos > 0 else 1.0

    if backend == "lightgbm":
        import lightgbm as lgb
        cat_cols = [c for c in X.columns if X[c].dtype.name == "category"]
        model = lgb.LGBMClassifier(
            n_estimators=200, max_depth=4, learning_rate=0.05,
            num_leaves=31, min_child_samples=30,
            class_weight="balanced",  # 类不平衡处理
            random_state=42, verbose=-1,
            categorical_feature=cat_cols or "auto",
        )
        model.fit(X_tr, y_tr, eval_set=[(X_val, y_val)],
                  callbacks=[lgb.early_stopping(20, verbose=False),
                             lgb.log_evaluation(-1)])
    else:
        import xgboost as xgb
        model = xgb.XGBClassifier(
            n_estimators=200, max_depth=4, learning_rate=0.05,
            enable_categorical=True, tree_method="hist",
            scale_pos_weight=pos_weight,  # 类不平衡处理
            random_state=42, eval_metric="auc",
            early_stopping_rounds=20, verbosity=0,
        )
        model.fit(X_tr, y_tr, eval_set=[(X_val, y_val)], verbose=False)

    # fix19:不再对全量(含训练集)打分 —— 训练集上的分数带 in-sample 乐观偏差,
    # 之前的分桶/高分未转化/校准等统计混着这份偏差。所有分数型统计改在验证集上做
    # (调用方按 val_index 对齐 df/y),顺带省掉一次全量 predict。
    val_scores = model.predict_proba(X_val)[:, 1]
    auc = float(roc_auc_score(y_val, val_scores))
    auc_ci_low, auc_ci_high = _bootstrap_auc_ci(y_val.values, val_scores)
    return model, val_scores, auc, auc_ci_low, auc_ci_high, float(pos_weight), X_val.index


def _bootstrap_auc_ci(y_true: np.ndarray, y_scores: np.ndarray,
                      n_boot: int = 500, alpha: float = 0.05,
                      seed: int = 42) -> tuple[float, float]:
    """val 集上的 AUC 95% bootstrap CI。两类样本不足或方差为 0 时返回 (auc, auc)。"""
    from sklearn.metrics import roc_auc_score

    n = len(y_true)
    if n < 20 or len(np.unique(y_true)) < 2:
        try:
            base = float(roc_auc_score(y_true, y_scores))
            return base, base
        except Exception:
            return 0.0, 0.0

    rng = np.random.default_rng(seed)
    aucs = np.empty(n_boot, dtype=float)
    fills = 0
    for i in range(n_boot):
        idx = rng.integers(0, n, n)
        yb = y_true[idx]
        sb = y_scores[idx]
        if len(np.unique(yb)) < 2:
            aucs[i] = np.nan
            continue
        try:
            aucs[i] = roc_auc_score(yb, sb)
            fills += 1
        except Exception:
            aucs[i] = np.nan
    aucs = aucs[~np.isnan(aucs)]
    if len(aucs) < 10:
        base = float(roc_auc_score(y_true, y_scores))
        return base, base
    low = float(np.quantile(aucs, alpha / 2))
    high = float(np.quantile(aucs, 1 - alpha / 2))
    return low, high


def _extract_importance(model, feature_names: list[str], backend: str,
                        top_n: int) -> list[FeatureImportance]:
    if backend == "lightgbm":
        importances = model.booster_.feature_importance(importance_type="gain")
    else:
        booster = model.get_booster()
        fmap = booster.get_score(importance_type="gain")
        booster_names = booster.feature_names or [f"f{i}" for i in range(len(feature_names))]
        importances = np.array([
            fmap.get(name, fmap.get(f"f{i}", 0))
            for i, name in enumerate(booster_names)
        ])

    total = importances.sum() or 1.0
    normalized = importances / total
    ranked = sorted(zip(feature_names, normalized), key=lambda x: x[1], reverse=True)
    return [
        FeatureImportance(feature=name, importance=float(imp), rank=i + 1)
        for i, (name, imp) in enumerate(ranked[:top_n])
    ]


def _extract_rules_lgb(model, overall_cvr: float, top_n: int,
                       X: pd.DataFrame | None = None,
                       y: pd.Series | None = None) -> list[DecisionRule]:
    """从 LightGBM 树中抽规则，并用真实数据评估 precision/recall。

    若 (X, y) 提供，每条规则用 leaf prediction 重新算 precision/recall；
    否则退回原"叶节点 value 推算 cvr"模式（precision/recall=0）。
    """
    trees_df = model.booster_.trees_to_dataframe()
    # 分类特征 code→名称 映射（pandas category 编码），供 _trace_path_lgb 把 || code 集合还原为可读品类名
    cat_maps: dict[str, list] = {}
    if X is not None:
        for col in X.columns:
            if str(X[col].dtype) == "category":
                cat_maps[col] = list(X[col].cat.categories)
    leaves_all = trees_df[trees_df["left_child"].isna() & trees_df["right_child"].isna()].copy()
    leaves = leaves_all[leaves_all["count"] >= 30]

    # 用 predict(pred_leaf=True) 得到每个样本在每棵树落到的叶节点序号
    pred_leaves = None
    if X is not None and y is not None and len(X) > 0:
        try:
            pred_leaves = model.predict(X, pred_leaf=True)  # shape: (n_samples, n_trees)
        except Exception:
            pred_leaves = None

    y_arr = y.values if y is not None else None
    n_positives = int(y_arr.sum()) if y_arr is not None else 0

    _int_feat = _make_int_feat_checker(X)
    _has_na = _make_has_na_checker(X)
    rules: list[DecisionRule] = []
    for _, leaf in leaves.iterrows():
        path, sql_path, pd_path = _trace_path_lgb(trees_df, leaf["tree_index"], leaf["node_index"],
                                                  cat_maps, is_int_feat=_int_feat, _has_na=_has_na)
        if not path:
            continue
        pred_cvr = 1 / (1 + np.exp(-leaf["value"]))
        rule_pandas = " & ".join(pd_path)

        precision = recall = 0.0
        n_converted = 0
        sample_count = int(leaf["count"])
        if pred_leaves is not None and y_arr is not None:
            tree_idx = int(leaf["tree_index"])
            # leaf node_index 形如 "0-L3"；LightGBM pred_leaf 给出的是叶子序号
            leaf_id = _lgb_leaf_id(str(leaf["node_index"]))
            if leaf_id is not None and tree_idx < pred_leaves.shape[1]:
                mask = pred_leaves[:, tree_idx] == leaf_id
                # 叶子 oracle 自检:渲染出的条件圈的行必须与树真实送进该叶子的行
                # 逐行一致。不一致 = 解析/渲染有 bug,该规则不可信,剔除(fail-closed)。
                if not _oracle_check(rule_pandas, X, mask,
                                     "lgb tree={} leaf={}".format(tree_idx, leaf["node_index"])):
                    continue
                # 交付形态:业务不圈空值人群 → oracle 通过后按剔空值重渲染,
                # 统计(命中/转化/精确率)一并用交付形态重算,人数与条件严格一致。
                if not MODEL_SEG_INCLUDE_NULL:
                    path, sql_path, pd_path = _trace_path_lgb(
                        trees_df, leaf["tree_index"], leaf["node_index"], cat_maps,
                        is_int_feat=_int_feat, _has_na=_has_na, drop_null=True)
                    rule_pandas = " & ".join(pd_path)
                    if "1 = 0" in " ".join(sql_path):
                        continue            # 该叶子人群全是空值行,剔空值后无交付意义
                    m2 = None
                    try:
                        from .diagnostic_engine import eval_condition as _ev
                    except ImportError:
                        from diagnostic_engine import eval_condition as _ev
                    m2 = _ev(rule_pandas, X)
                    if m2 is None:
                        continue
                    mask = np.asarray(m2, dtype=bool)
                hits = int(mask.sum())
                if hits <= 0:
                    continue                # 剔空值后没人了,不出这条
                if hits > 0:
                    sample_count = hits  # 使用真实命中数（含 val 集）
                    n_converted = int(y_arr[mask].sum())
                    precision = n_converted / hits
                    recall = (n_converted / n_positives) if n_positives > 0 else 0.0

        rules.append(DecisionRule(
            rule_text=" AND ".join(path),
            rule_sql=" AND ".join(sql_path),
            rule_pandas=rule_pandas,
            predicted_cvr=float(pred_cvr),
            sample_count=sample_count,
            lift=float(pred_cvr / overall_cvr) if overall_cvr > 0 else 0,
            precision=float(precision),
            recall=float(recall),
            n_converted=n_converted,
        ))

    rules.sort(key=lambda r: r.predicted_cvr, reverse=True)
    return _dedup_rules(rules, top_n)


def _make_has_na_checker(X):
    """列在本单数据里是否真的存在缺失值。按列缓存。

    数据事实门:一列在本活动数据里根本没有空值,渲染出的任何 IS NULL 都是
    空话(本地/线上查询同一批行,永远匹配不到),只添噪声 —— 一律不输出。
    列里真有空值时才如实渲染空值路由。"""
    cache: dict = {}

    def check(feat: str) -> bool:
        if X is None or feat not in getattr(X, "columns", ()):
            return False
        if feat not in cache:
            try:
                cache[feat] = bool(X[feat].isna().any())
            except Exception:  # noqa: BLE001
                cache[feat] = False
        return cache[feat]

    return check


def _make_int_feat_checker(X):
    """列是否整数域(int dtype,或 float 但非空值全是整数)。按列缓存,只算一次。"""
    cache: dict = {}

    def check(feat: str) -> bool:
        if X is None or feat not in getattr(X, "columns", ()):
            return False
        if feat not in cache:
            s = X[feat]
            k = s.dtype.kind
            if k in ("i", "u"):
                cache[feat] = True
            elif k == "f":
                sv = s.dropna()
                try:
                    cache[feat] = bool(len(sv)) and bool((sv == sv.astype("int64")).all())
                except Exception:  # noqa: BLE001
                    cache[feat] = False
            else:
                cache[feat] = False
        return cache[feat]

    return check


def _oracle_check(rule_pandas: str, X, mask_oracle, where: str) -> bool:
    """叶子 oracle 自检:树模型自己就是标准答案。

    渲染出的 pandas 条件在训练数据 X 上圈出的行集合,必须与
    predict(pred_leaf=True) 给出的"真实落入该叶子"的行集合完全一致。
    一致 ⟹ 解析(路径回溯/NaN 路由/code→name/合并/渲染)整条链无错;
    不一致 ⟹ 某环有 bug,调用方应剔除该规则(fail-closed:宁缺勿错)。
    失败率是解析器质量的线上监控指标,应恒为 0。
    """
    if not rule_pandas or X is None or mask_oracle is None:
        return True     # 无 oracle 数据(离线裸调)时不拦,保持旧行为
    try:
        try:
            from .diagnostic_engine import eval_condition
        except ImportError:            # 平铺引用时的兜底
            from diagnostic_engine import eval_condition
        mask = eval_condition(rule_pandas, X)
        if mask is None:
            logger.warning("规则 oracle 自检(%s):条件求值失败,剔除。cond=%s", where, rule_pandas)
            return False
        got = np.asarray(mask, dtype=bool)
        exp = np.asarray(mask_oracle, dtype=bool)
        if got.shape != exp.shape or not np.array_equal(got, exp):
            logger.warning(
                "规则 oracle 自检失败(%s):条件命中 %d 行,叶子实际 %d 行,剔除。cond=%s",
                where, int(got.sum()), int(exp.sum()), rule_pandas)
            return False
        return True
    except Exception as exc:  # noqa: BLE001 —— 自检自身出错也按不通过处理,绝不放行存疑规则
        logger.warning("规则 oracle 自检(%s)异常:%s,剔除。cond=%s", where, exc, rule_pandas)
        return False


def _lgb_leaf_id(node_index: str) -> int | None:
    """从 LightGBM 的 node_index（形如 '0-L3' 或 '0-S5'）取叶节点编号；非叶返回 None。"""
    if "-L" not in node_index:
        return None
    try:
        return int(node_index.rsplit("-L", 1)[1])
    except ValueError:
        return None


MIN_RULE_PRECISION = 0.15  # 真实数据下 precision 低于此值的规则不可用


def _dedup_rules(rules: list[DecisionRule], top_n: int) -> list[DecisionRule]:
    """按 rule_text 去重；同一规则文本由不同 boosting 树多次提出时只保留 lift 最高一条。

    动机：LightGBM/XGBoost 不同树常给出相同切分（如 `mkt_touch_cnt>3.5`），
    若不去重会导致 top_n 实际只覆盖 2-3 条独立规则，信息密度下降。

    精度过滤：若任一规则提供了真实 precision（>0），则过滤 precision < MIN_RULE_PRECISION
    的规则（避免输出"叶子值高但真实命中转化少"的不可用规则）；若所有规则 precision=0
    （表示未传 X/y，无 precision 数据），跳过过滤。
    """
    has_precision_data = any(r.precision > 0 for r in rules)
    if has_precision_data:
        rules = [r for r in rules if r.precision >= MIN_RULE_PRECISION]
    seen: dict[str, DecisionRule] = {}
    for r in rules:
        key = r.rule_text.strip()
        if key not in seen or r.lift > seen[key].lift:
            seen[key] = r
    out = sorted(seen.values(), key=lambda r: (r.predicted_cvr, r.lift), reverse=True)
    return out[:top_n]


# 树切分点「刚好大于 0」的哨兵上界。
# 2026-08-12(fix23)：由 1e-20 上调到 1e-6 —— 实际切分点会落在 1e-10 这类量级，
# 老门槛拦不住，于是渲染成 `> 0.0000000001` 进了报告与 sql_filter。
# 依据（feature_registry 实证）：全表仅 4 个 rate 型 + 2 个金额型字段可能非整数，
# 最小可表示非零值 ≈ 3e-3（促销占比 1/365）；(0, 1e-6) 内不存在任何真实取值，
# 落在那里的切分点必然是树内部产物。门槛比最小真实值仍保守 1000 倍，
# 且对真实数据**选中的行完全不变**（`x > 1e-10` ≡ `x > 0`）。
# 2026-08-17:1e-6 → 1e-4。原来的 1e-6 是"保守 1000 倍"的选择,代价是落在
# [1e-6, 1e-4) 的阈值只能写成 5~6 位小数(`> 0.00003`),破了"最多 4 位小数"那条
# 业务要求 —— 而这个破例其实不必要:
#   · 全表只有 4 个 rate 型字段(pre_popup_click_rate / pre_push_click_rate /
#     pre_events_per_hour / serialid_bonus),分母分别是"每人每天的弹屏曝光数 /
#     Push 曝光数 / 小时数"和"近1年订单数",最细粒度是 1/365 ≈ 2.7e-3;
#   · 规则库阈值出自 threshold_computer 的 round(x, 4),取值只能是 0 或 ≥1e-4,
#     构造上就落不进 (0, 1e-4);
#   → (0, 1e-4) 与 (-1e-4, 0) 内不存在任何真实取值,余量仍有 27 倍。
# 唯一能产生这个区间取值的是树切分点,而它逐条过叶子 oracle:万一某列真有落在
# 这里的取值,那条规则会被剔除+告警,不会带着错圈的人上线。
_SENTINEL_EPS = 1e-4


_MAX_DECIMALS = 4   # 阈值最多保留 4 位小数（业务要求；再多既不可读也无业务意义）



def _fmt_threshold(v: float) -> str:
    """树切分阈值 → 无科学计数法、最多 4 位小数的字符串，rule_text/rule_sql 共用。

    两条硬约束：
      1) 下游（报告展示、org_json、Spark SQL）不出现 `3e-05` 这类科学计数法；
      2) 最多 4 位小数 —— 树切分点是相邻取值的中点，带一堆浮点噪声
         （`2.5000000000000004`、`15.520000000000001`），照抄出去既难读又毫无意义。

    2026-08-17 起**没有例外**:哨兵门槛提到 1e-4(见 _SENTINEL_EPS 的推导),
    (0, 1e-4) 内不存在真实取值,所以抹成 0 是恒等的,不再为 `0.00003` 破例加位数。
    比较位置上的归零由 _merge_render_clauses 连算符一起做(光抹数值会改变人群)。

    ⚠ 2026-08-07 修回归：fix20 为消灭科学计数法改成"加位数直到 float 完全相等"，
    结果把浮点噪声全暴露出来（线上出现 `> 2.50000000000000044409`）。
    正确取舍是：可读性优先，噪声级差异（相对 1e-9 以下）不值得保留。
    """
    if v == int(v):
        return str(int(v))
    if abs(v) < _SENTINEL_EPS:
        # 哨兵区间直接归零：不能靠"第 N 位能否表示出非零"来判，
        # 9.9e-7 在第 6 位会进位成 0.000001，看着非零其实仍在哨兵区间内。
        return "0"
    s = f"{v:.{_MAX_DECIMALS}f}".rstrip("0").rstrip(".")
    # 4 位表示不出非零 ⇒ |v| < 1e-4 ⇒ 哨兵区间,写 0(不再加位数破例)。
    return s if (s and float(s) != 0) else "0"


def _fmt_threshold_exact(v: float) -> str:
    """执行形态(SQL/pandas)的阈值:全精度位置计数,无科学计数法、不四舍五入。

    display 的 _fmt_threshold 只留 4 位小数是给人看的;拿它进 SQL 会把边界挪动
    (oracle 实测:XGB 阈值 598.19793701...,美化成 598.1979 后恰有一行翻转)。
    执行形态必须逐位保真 —— 树怎么比,SQL/pandas 就怎么比。
    """
    f = float(v)
    if f == int(f):
        return str(int(f))
    # 兜底:树内部零哨兵(LightGBM 的 kZeroThreshold = 1e-35f,全精度展开就是三十
    # 几个零)不该走到这里 —— 正常路径上 _merge_render_clauses 已经把它连**算符**
    # 一起归零了(`> -1e-35` → `>= 0`,恒等改写)。
    # 真走到这里说明那一步漏了某条路径:这里只能抹数值、动不了算符,而光抹数值会
    # 改变圈到的人(取值恰好为 0 的行),叶子 oracle 会把那条规则剔掉。所以吵一声,
    # 让"规则莫名消失"能被追到源头,而不是安静地产出一个长串。
    if f != 0 and abs(f) < _SENTINEL_EPS:
        logger.warning("阈值哨兵漏到执行形态渲染层(%r):已按 0 输出,但算符没跟着改,"
                       "该规则大概率会被叶子 oracle 剔除 —— 查 _merge_render_clauses", f)
        return "0"
    return np.format_float_positional(f, trim="-")


def _merge_render_clauses(steps: list, cat_maps: dict | None = None,
                          is_int_feat=None, drop_null: bool = False) -> tuple[list[str], list[str], list[str]]:
    """LGB/XGB 共用的"结构化路径子句 → (display, SQL, pandas)"三形态同源渲染器。

    steps 为根→叶顺序的切分步骤列表(第 5 元 na_included 可省,省略视为 False):
      ("num", feat, lo, hi, na_included)   lo/hi = (阈值, 是否闭边界) 或 None,每步恰有一侧;
      ("cat", feat, names, is_in, na_included)  names 为已还原的类别名集合(str)。
    na_included = 树把缺失值(NaN/NULL)送进了本分支(LGB missing_direction /
    XGB dump 的 missing=)。同特征多步合并时取 AND —— 缺失行要属于合并后的区间,
    必须在每一次切分上都走了缺失方向。

    三形态出自同一循环、共用同一份阈值与空值语义,这是"解析对 ⟹ SQL 对"的根基:
      · display   报告展示(允许取整美化,不参与执行);
      · SQL       出参 push_sql / filter_zh 直译的输入,Hive 方言;
      · pandas    叶子 oracle 自检与 ma-api 本地计数的可执行形态。
    pandas 与 SQL 的空值行为已逐类对齐(pandas 比较对 NaN 为 False ≡ SQL NULL 比较不命中;
    NOT IN 在 pandas 侧显式补 notna,对齐 SQL NOT IN 天然排 NULL 的行为)。

    is_int_feat(feat)->bool(可选):整数域字段的非整阈值钉到 floor+0.5 中点 ——
    1.5000000000000002 → 1.5。整数域上二者对**任何**取值(含采样未见过的)严格等价,
    出参不再冒长尾小数;连续值字段不动(全精度是保真的代价,且极少出现)。

    继承 fix19 的三件事:同特征合并取紧边界/分类交并、__NA__ 哨兵不外泄、
    反选清单补集改写(≤8 且不大于原清单)。
    """
    num_bounds: dict = {}   # feat -> [lo|None, hi|None, na_included]
    cat_sets: dict = {}     # feat -> {"pos": set|None, "neg": set, "na": bool|None}
    order: list[str] = []

    for step in steps:
        kind, feat = step[0], step[1]
        na_inc = (bool(step[4]) if len(step) > 4 else False) and not drop_null
        if feat not in order:
            order.append(feat)
        if kind == "num":
            lo, hi = step[2], step[3]
            slot = num_bounds.setdefault(feat, [None, None, None])
            if lo is not None and (slot[0] is None or lo[0] > slot[0][0]
                                   or (lo[0] == slot[0][0] and not lo[1])):
                slot[0] = lo    # 下界取更大;同值时开边界(>)比闭边界(>=)更紧
            if hi is not None and (slot[1] is None or hi[0] < slot[1][0]
                                   or (hi[0] == slot[1][0] and not hi[1])):
                slot[1] = hi    # 上界取更小;同值时开边界(<)更紧
            slot[2] = na_inc if slot[2] is None else (slot[2] and na_inc)
        else:
            names, is_in = set(str(v) for v in step[2]), step[3]
            real_names = names - {"__NA__"}
            # 空值归属:'__NA__' 在类别全集里(哨兵填充惯例)时由集合逻辑决定 ——
            # IN 含哨兵 ⟹ 空值行属于本分支;NOT IN 不含哨兵 ⟹ 空值行属于本分支
            # (它不在被排除的清单里)。全集无哨兵(真 NaN)时由缺失路由(na_inc)决定。
            universe = {str(c) for c in ((cat_maps or {}).get(feat) or [])}
            if drop_null:
                step_null = False
            elif "__NA__" in universe or "__NA__" in names:
                step_null = ("__NA__" in names) if is_in else ("__NA__" not in names)
            else:
                step_null = na_inc
            slot = cat_sets.setdefault(feat, {"pos": None, "neg": set(), "null": None})
            if is_in:
                slot["pos"] = real_names if slot["pos"] is None else (slot["pos"] & real_names)
            else:
                slot["neg"] |= real_names
            slot["null"] = step_null if slot["null"] is None else (slot["null"] and step_null)

    path: list[str] = []
    sql_path: list[str] = []
    pd_path: list[str] = []

    _IDENT_OK = re.compile(r"^[A-Za-z_]\w*$")

    def _fs(feat: str) -> str:
        """SQL 端字段引用:合法标识符裸写;数字开头等非法名(如 360d_create_order_count)
        加 Hive/Spark 反引号 —— 裸写在线上就是语法错(2026-08-14 生产实锤:该列的
        模型规则全部求值失败被剔)。"""
        return feat if _IDENT_OK.match(feat) else "`{}`".format(feat)

    def _fp(feat: str) -> str:
        """pandas 端字段引用:非法标识符走 _df['col'] 取列(eval 命名空间由
        diagnostic_engine.eval_condition 提供 _df)。"""
        return feat if _IDENT_OK.match(feat) else "_df[{!r}]".format(feat)

    def _pq(v: str) -> str:
        """pandas 字面量(repr 转义,单双引号都安全)。"""
        return repr(str(v))

    def _sq(v: str) -> str:
        return "'{}'".format(str(v).replace("'", "''"))

    def _render_cat(feat: str, pos, neg: set, null_in: bool) -> None:
        """分类子句渲染:值谓词(只含真实类别)与空值门(null_in)解耦。

        null_in = 空值表示行(raw 帧的 NaN/NULL、填充帧的 '__NA__' 类别)属于本分支。
        pandas 侧空值门同时认两种表示(同一份数据里两者互斥,OR/AND 起来在任一帧上
        都恰好正确);SQL 只认 NULL(线上表不会有 '__NA__' 字面量)。
        SQL 侧 IN/NOT IN 天然排 NULL,所以 null_in=False 时值谓词裸用即可。
        """
        fs, fp = _fs(feat), _fp(feat)

        def _in(vals):
            vs = sorted(vals)
            return ("{} IN ({})".format(fs, ",".join(_sq(v) for v in vs)),
                    "{}.isin([{}])".format(fp, ", ".join(_pq(v) for v in vs)),
                    vs)

        def _notin(vals):
            vs = sorted(vals)
            return ("{} NOT IN ({})".format(fs, ",".join(_sq(v) for v in vs)),
                    "~{}.isin([{}])".format(fp, ", ".join(_pq(v) for v in vs)),
                    vs)

        sql_parts, pd_parts, disp_in, disp_out = [], [], [], []
        if pos is not None:
            merged = pos - neg
            if merged:
                s, p, vs = _in(merged)
                sql_parts.append(s); pd_parts.append(p); disp_in = vs
            else:
                # 正类别集为空(IN 清单只剩哨兵,或与反选完全抵消):非空行无解。
                # 真实树不会产生这种路径(子节点区域非空),但渲染必须仍然正确 ——
                # 空集谓词显式写死,空值行归属交给下面的空值门,语义一行不差。
                sql_parts.append("1 = 0")
                pd_parts.append("{}.isin([])".format(fp))
        else:
            cm_real = {str(c) for c in ((cat_maps or {}).get(feat) or [])} - {"__NA__"}
            comp = cm_real - neg
            if cm_real and comp and len(comp) <= min(8, len(neg)):
                s, p, vs = _in(comp)     # 补集更小:改写为等价 IN(空值另走空值门)
                sql_parts.append(s); pd_parts.append(p); disp_in = vs
            elif neg:
                s, p, vs = _notin(neg)
                sql_parts.append(s); pd_parts.append(p); disp_out = vs

        # display:沿用旧样式,空值并进清单展示。
        # 2026-08-17:drop_null(交付形态)下不再往 NOT IN 清单里塞「空值」——
        # 那时每条分支的 null_in 都是 False,这个标注会出现在**每一个**分类子句上,
        # 纯噪声;更要命的是人群命名器(model_interpreter._parse_conds)把它当成一个
        # 真实类别值,起出「非消费频次:空值等人群」这种名字(线上实锤)。
        # 交付形态本来就不圈空值人群,不标反而是准确的;MA_MODEL_SEG_NULL=1 时
        # (drop_null=False)标注仍然有信息量,照旧保留。
        _null_token = [] if (null_in or drop_null) else ["空值"]
        if disp_in or not disp_out:
            path.append("{} in [{}]".format(
                feat, ",".join((["空值"] if null_in else []) + disp_in)))
        if disp_out:
            path.append("{} not in [{}]".format(
                feat, ",".join(_null_token + disp_out))
                + ("(含空值)" if null_in else ""))

        val_sql = " AND ".join(sql_parts)
        val_pd = " & ".join(pd_parts)
        if null_in:
            if val_sql:
                sql_path.append("({} IS NULL OR {})".format(
                    fs, val_sql if len(sql_parts) == 1 else "({})".format(val_sql)))
                pd_path.append("({}.isna() | ({} == '__NA__') | {})".format(
                    fp, fp, val_pd if len(pd_parts) == 1 else "({})".format(val_pd)))
            else:
                sql_path.append("{} IS NULL".format(fs))
                pd_path.append("({}.isna() | ({} == '__NA__'))".format(fp, fp))
        else:
            if val_sql:
                # SQL 的 IN/NOT IN 对 NULL 行天然不命中;pandas 侧 ~isin 会把
                # NaN/'__NA__' 放进来,必须显式关空值门对齐
                sql_path.append(val_sql if len(sql_parts) == 1
                                else "({})".format(val_sql))
                pd_path.append("({}.notna() & ({} != '__NA__') & {})".format(
                    fp, fp, val_pd))
            else:
                sql_path.append("{} IS NOT NULL".format(fs))
                pd_path.append("({}.notna() & ({} != '__NA__'))".format(fp, fp))

    for feat in order:
        if feat in num_bounds:
            lo, hi, na_inc = num_bounds[feat]
            # 树内部零哨兵 → 直接写 0。
            # 线上出现 `近1年客单价 > -0.000…00010000000180025095`:尾数
            # 1.0000000180025095 是 float32(1e-35) 提升成 double 的唯一值,也就是
            # LightGBM 源码里的 kZeroThreshold(1e-35f)—— 树用来分开"零/缺失"与
            # 真实数值的内部常量,不是业务阈值,全精度展开就是三十几个零。
            #
            # ⚠ 数值和算符必须一起动。光把数值抹成 0、算符不动:
            #   `> -1e-35` → `> 0` 会把取值恰好为 0 的人排除掉(而这个切分点存在的
            #   目的恰恰就是把 0 和正值分开),条件与真实叶子对不上,叶子 oracle 会
            #   把整条规则剔掉 —— 人群凭空消失。
            # 下面四种改写都是**恒等**的,依据是 _SENTINEL_EPS 那条论证:真实数据在
            # 0 的两侧邻域内不存在取值(最小可表示非零值 ≈ 3e-3)。
            #   t>0: `> t`/`>= t` ≡ `> 0`  ;  `< t`/`<= t` ≡ `<= 0`
            #   t<0: `> t`/`>= t` ≡ `>= 0` ;  `< t`/`<= t` ≡ `< 0`
            # 三形态(display/SQL/pandas)在这里一次改齐,不会再出现"display 写 0、
            # SQL 写 -1e-35"这种两边圈的人不一样的情况。oracle 仍逐条复验。
            if lo is not None and lo[0] != 0 and abs(float(lo[0])) < _SENTINEL_EPS:
                lo = (0.0, float(lo[0]) < 0)      # 负哨兵 → >=0;正哨兵 → >0
            if hi is not None and hi[0] != 0 and abs(float(hi[0])) < _SENTINEL_EPS:
                hi = (0.0, float(hi[0]) > 0)      # 正哨兵 → <=0;负哨兵 → <0
            if is_int_feat is not None and is_int_feat(feat):
                import math as _math
                # 整数域字段(registry type ∈ count/ordinal/binary)的阈值直接写成整数。
                #
                # 为什么树会给出 27.5:切分点落在**两个相邻观测值之间**,整数列上
                # "27 和 28 之间"就是 27.5。所以 `visit_days <= 27.5` 是树的原话,
                # 不是精度问题 —— 但业务读「近90天访问天数 <= 27.5」只会困惑。
                #
                # 整数域上这四种改写是恒等的(取值只能是整数,落不进 (27, 28)):
                #   `<= k.5` ≡ `< k.5` ≡ `<= k`
                #   `>= k.5` ≡ `>  k.5` ≡ `>= k+1`
                # 先钉到 floor+0.5(把 1.5000000000000002 这类噪声归位),再写成整数。
                # 三形态一起改,叶子 oracle 逐条复验:万一某列被 registry 标错了类型
                # (声明 count 实际有小数),那条规则会被剔除+告警,不会错圈人。
                if lo is not None and float(lo[0]) != int(lo[0]):
                    lo = (_math.floor(float(lo[0])) + 1, True)      # > k.5 → >= k+1
                if hi is not None and float(hi[0]) != int(hi[0]):
                    hi = (_math.floor(float(hi[0])), True)          # <= k.5 → <= k
            disp_parts, sql_parts, pd_parts = [], [], []
            fs, fp = _fs(feat), _fp(feat)
            if lo is not None:
                op = ">=" if lo[1] else ">"
                ve = _fmt_threshold_exact(lo[0])
                disp_parts.append(f"{feat}{op}{_fmt_threshold(lo[0])}")
                sql_parts.append(f"{fs} {op} {ve}")
                pd_parts.append(f"({fp} {op} {ve})")
            if hi is not None:
                op = "<=" if hi[1] else "<"
                ve = _fmt_threshold_exact(hi[0])
                disp_parts.append(f"{feat}{op}{_fmt_threshold(hi[0])}")
                sql_parts.append(f"{fs} {op} {ve}")
                pd_parts.append(f"({fp} {op} {ve})")
            if na_inc and sql_parts:
                # 缺失行属于本分支:整特征的界合成一个子句再 OR IS NULL
                path.append(" AND ".join(disp_parts) + "(含空值)")
                inner_sql = " AND ".join(sql_parts)
                if len(sql_parts) > 1:
                    inner_sql = f"({inner_sql})"
                sql_path.append(f"({inner_sql} OR {fs} IS NULL)")
                inner_pd = " & ".join(pd_parts)
                if len(pd_parts) > 1:
                    inner_pd = f"({inner_pd})"
                pd_path.append(f"({inner_pd} | {fp}.isna())")
            else:
                # 缺失行不属于本分支:pandas 比较对 NaN 天然 False,与 SQL 一致,逐界分列
                path.extend(disp_parts)
                sql_path.extend(sql_parts)
                pd_path.extend(pd_parts)
            continue
        slot = cat_sets[feat]
        _render_cat(feat, slot["pos"], slot["neg"], bool(slot["null"]))

    return path, sql_path, pd_path


def _trace_path_lgb(trees_df, tree_idx, node_idx, cat_maps=None,
                    is_int_feat=None, _has_na=None, drop_null=False) -> tuple[list[str], list[str], list[str]]:
    """返回 (display_path, sql_path, pandas_path)。

    LightGBM 分类切分的 threshold 形如 "1||8||9"（category code 集合，走向 left 子节点）；
    用 cat_maps 把 code 还原为真实品类名。数值切分：哨兵阈值（<1e-20，二值特征）在源头
    转为 <=0 / >0，其余阈值位置计数格式化——rule_text/rule_sql 不出科学计数法。
    fix19:叶→根收集结构化步骤后反转,交给 _merge_render_clauses 统一合并/渲染
    (与 XGBoost 路径共用 __NA__/补集改写/同特征合并逻辑)。
    """
    subtree = trees_df[trees_df["tree_index"] == tree_idx]
    steps_rev: list = []    # 叶→根
    current = node_idx
    for _ in range(20):
        parent_rows = subtree[
            (subtree["left_child"] == current) | (subtree["right_child"] == current)
        ]
        if parent_rows.empty:
            break
        parent = parent_rows.iloc[0]
        feat = parent["split_feature"]
        thresh = parent["threshold"]
        went_left = parent["left_child"] == current
        # 分类切分判定必须看 decision_type=='=='(LGB 的权威标志)。老写法只认
        # threshold 里的 "||" —— 单类别切分的 threshold 就是裸编码("2"),会被
        # 误判成数值比较渲染出 `cat <= 2`(拿类别编码当数字,fix19 起的存量错圈;
        # 2026-08-14 被叶子 oracle 全量拦出后修正)。
        is_cat = (str(parent.get("decision_type") or "") == "==") \
            or (isinstance(thresh, str) and "||" in str(thresh))
        # 缺失值路由(2026-08-14 沙箱实验逐条证实,勿凭直觉改):
        #   missing_type='NaN'/'Zero' → 训练见过缺失,预测时 NaN 走 missing_direction;
        #   missing_type='None'(训练没见过缺失)→ LGB 对 missing_direction 照样填
        #     'left',但那是摆设 —— 预测时 NaN 被当作 0(NaN 行与 0 行逐树同叶),
        #     缺失行归属 = 0 走的那一边;分类切分按"不包含"保守处理。
        # 最后过数据事实门(has_na):列里没有空值就绝不渲染 IS NULL(纯噪声)。
        side = "left" if went_left else "right"
        _mt = str(parent.get("missing_type") or "")
        if _mt in ("NaN", "Zero"):
            na_route = str(parent.get("missing_direction") or "") == side
        elif is_cat:
            na_route = False
        else:
            try:
                na_route = ((0.0 <= float(thresh)) == went_left)   # 0 走左 ⟺ 0<=阈值
            except (TypeError, ValueError):
                na_route = False
        na_inc = na_route and (_has_na is None or _has_na(feat))
        if is_cat:
            codes = [c for c in str(thresh).split("||") if c != ""]
            cm = (cat_maps or {}).get(feat)
            names = set()
            for c in codes:
                try:
                    names.add(str(cm[int(float(c))]) if cm else str(c))
                except (ValueError, IndexError):
                    names.add(str(c))
            # LightGBM：threshold 列出的是走向 left 子节点的类别集合
            steps_rev.append(("cat", feat, names, went_left, na_inc))
        else:
            if isinstance(thresh, (int, float)) and 0 < thresh < _SENTINEL_EPS:
                # 二值 0/1 特征的哨兵切分（约 1e-35）：左 ≡ <=0，右 ≡ >0
                lo, hi = (None, (0.0, True)) if went_left else ((0.0, False), None)
            elif went_left:
                lo, hi = None, (float(thresh), True)     # 左:feat <= thresh
            else:
                lo, hi = (float(thresh), False), None    # 右:feat > thresh
            steps_rev.append(("num", feat, lo, hi, na_inc))
        current = parent["node_index"]

    return _merge_render_clauses(list(reversed(steps_rev)), cat_maps,
                                 is_int_feat=is_int_feat, drop_null=drop_null)


def _extract_rules_xgb(model, overall_cvr: float, top_n: int,
                       X: pd.DataFrame | None = None,
                       y: pd.Series | None = None) -> list[DecisionRule]:
    booster = model.get_booster()
    dump = booster.get_dump(with_stats=True)

    # leaf prediction：XGBoost 的叶节点编号
    pred_leaves = None
    if X is not None and y is not None and len(X) > 0:
        try:
            pred_leaves = np.asarray(model.apply(X))  # shape: (n_samples, n_trees)
            if pred_leaves.ndim == 1:
                # 单树模型时 apply 返回 1 维,统一成 (n,1) 供 [:, tree_idx] 索引
                pred_leaves = pred_leaves.reshape(-1, 1)
        except Exception:
            pred_leaves = None
    y_arr = y.values if y is not None else None
    n_positives = int(y_arr.sum()) if y_arr is not None else 0

    # 分类特征 code→名称 映射（pandas category 编码），用于把树的分类切分还原为可读品类名
    cat_maps: dict[str, list] = {}
    if X is not None:
        for col in X.columns:
            if str(X[col].dtype) == "category":
                cat_maps[col] = list(X[col].cat.categories)

    # oracle 求值用的特征帧要镜像 XGB 的内部量化:它把特征 cast 成 float32 再比阈值,
    # 半个 ULP 内的边界行在 float64 原值上会翻转,好规则被错杀(实测每 seed 都有)。
    # cast 后的 float32 值在 float64 里可精确表示,比较结果与 XGB 内部逐行一致。
    X_oracle = None
    if X is not None:
        X_oracle = X.copy()
        for col in X_oracle.columns:
            if X_oracle[col].dtype.kind == "f":
                X_oracle[col] = X_oracle[col].astype(np.float32)

    _int_feat = _make_int_feat_checker(X)
    rules: list[DecisionRule] = []
    for tree_idx, tree_str in enumerate(dump):
        rules.extend(_parse_xgb_tree(
            tree_str, overall_cvr, tree_idx,
            pred_leaves=pred_leaves, y_arr=y_arr, n_positives=n_positives,
            cat_maps=cat_maps, X_oracle=X_oracle, is_int_feat=_int_feat))
    rules.sort(key=lambda r: r.predicted_cvr, reverse=True)
    return _dedup_rules(rules, top_n)


def _parse_xgb_tree(tree_str: str, overall_cvr: float, tree_idx: int = 0,
                    pred_leaves: np.ndarray | None = None,
                    y_arr: np.ndarray | None = None,
                    n_positives: int = 0,
                    cat_maps: dict[str, list] | None = None,
                    X_oracle: pd.DataFrame | None = None,
                    is_int_feat=None) -> list[DecisionRule]:
    """解析 XGBoost get_dump 文本树。

    切分语法（实测 xgboost 3.x，enable_categorical=True + tree_method="hist"）:
      数值:`[feat<thresh]`  yes ≡ feat < thresh,no ≡ feat >= thresh;
      分类:`[feat:{2,5,8}]` 花括号内为 category code 集合,yes ≡ 类别 ∈ 集合
           （沙箱实证:强正类别不在集合中时落 no 分支、叶值为正,方向与此一致）。
    fix19:DFS 收集结构化步骤,叶节点处交给 _merge_render_clauses 渲染 ——
    与 LightGBM 路径共用 __NA__→空值/IS NULL、NOT IN 补集改写、同特征合并逻辑。
    """
    _hn = _make_has_na_checker(X_oracle)
    lines = tree_str.strip().split("\n")
    node_info: dict[str, dict] = {}
    for line in lines:
        line = line.strip()
        depth = len(line) - len(line.lstrip("\t"))
        line = line.lstrip("\t")
        node_id = line.split(":")[0]
        if "leaf" in line:
            val = float(line.split("leaf=")[1].split(",")[0])
            cover = float(line.split("cover=")[1]) if "cover=" in line else 0
            node_info[node_id] = {"type": "leaf", "value": val, "cover": cover, "depth": depth}
        else:
            # XGBoost 数值切分：`[feat<thresh]`；分类切分：`[feat:1,2,3]`（enable_categorical=True）
            cond = line.split("[", 1)[1].split("]", 1)[0]
            if "<" in cond:
                feat, _, thresh_str = cond.partition("<")
                # XGB 内部用 float32 比较,dump 的十进制只是它的近似打印。
                # 过一遍 float32 再展开成精确 float64 —— 树用哪个值比,我们就用哪个值,
                # 否则边界上的行会翻转(oracle 实测:612.107361 vs 612.10736083984375 差一行)。
                thresh = float(np.float32(float(thresh_str)))
                kind = "numeric"
            elif ":" in cond:
                feat, _, cats = cond.partition(":")
                thresh = cats  # 分类边集合，原样保留供 rule_text 拼接
                kind = "categorical"
            else:
                # 未识别的切分语法 → 跳过本节点
                node_info[node_id] = {"type": "skip", "depth": depth}
                continue
            yes = line.split("yes=")[1].split(",")[0]
            no = line.split("no=")[1].split(",")[0]
            # 缺失值路由:dump 的 missing= 指明 NaN 行走哪个子节点(通常与 yes 同)
            missing = line.split("missing=")[1].split(",")[0] if "missing=" in line else None
            node_info[node_id] = {"type": "split", "feat": feat, "thresh": thresh,
                                  "kind": kind, "yes": yes, "no": no, "missing": missing,
                                  "depth": depth}

    rules: list[DecisionRule] = []

    def dfs(nid, steps):
        info = node_info.get(nid)
        if info is None:
            return
        if info["type"] == "leaf":
            if info["cover"] >= 30:
                pred = 1 / (1 + np.exp(-info["value"]))
                # 真实数据评估
                precision = recall = 0.0
                n_converted = 0
                sample_count = int(info["cover"])
                if (pred_leaves is not None and y_arr is not None
                        and tree_idx < pred_leaves.shape[1]):
                    try:
                        leaf_id = int(nid)
                    except ValueError:
                        leaf_id = None
                    if leaf_id is not None:
                        mask = pred_leaves[:, tree_idx] == leaf_id
                        hits = int(mask.sum())
                        if hits > 0:
                            sample_count = hits
                            n_converted = int(y_arr[mask].sum())
                            precision = n_converted / hits
                            recall = (n_converted / n_positives) if n_positives > 0 else 0.0
                path, sql_path, pd_path = _merge_render_clauses(steps, cat_maps,
                                                                 is_int_feat=is_int_feat)
                rule_pandas = " & ".join(pd_path)
                if (pred_leaves is not None and y_arr is not None
                        and tree_idx < pred_leaves.shape[1]):
                    try:
                        _lid = int(nid)
                    except ValueError:
                        _lid = None
                    if _lid is not None and not _oracle_check(
                            rule_pandas, X_oracle, pred_leaves[:, tree_idx] == _lid,
                            "xgb tree={} leaf={}".format(tree_idx, nid)):
                        return
                # 交付形态:剔空值人群(与 LGB 同一策略,oracle 之后做,统计重算)
                if not MODEL_SEG_INCLUDE_NULL:
                    path, sql_path, pd_path = _merge_render_clauses(
                        steps, cat_maps, is_int_feat=is_int_feat, drop_null=True)
                    rule_pandas = " & ".join(pd_path)
                    if "1 = 0" in " ".join(sql_path):
                        return
                    if X_oracle is not None:
                        try:
                            from .diagnostic_engine import eval_condition as _ev
                        except ImportError:
                            from diagnostic_engine import eval_condition as _ev
                        _m2 = _ev(rule_pandas, X_oracle)
                        if _m2 is None:
                            return
                        _m2 = np.asarray(_m2, dtype=bool)
                        hits2 = int(_m2.sum())
                        if hits2 <= 0:
                            return
                        sample_count = hits2
                        if y_arr is not None:
                            n_converted = int(y_arr[_m2].sum())
                            precision = n_converted / hits2
                            recall = (n_converted / n_positives) if n_positives > 0 else 0.0
                rules.append(DecisionRule(
                    rule_text=" AND ".join(path) or "(root leaf)",
                    rule_sql=" AND ".join(sql_path),
                    rule_pandas=rule_pandas,
                    predicted_cvr=float(pred),
                    sample_count=sample_count,
                    lift=float(pred / overall_cvr) if overall_cvr > 0 else 0,
                    precision=float(precision),
                    recall=float(recall),
                    n_converted=n_converted,
                ))
        elif info["type"] == "skip":
            return
        else:
            feat, thresh = info["feat"], info["thresh"]
            if info.get("kind") == "categorical":
                # 分类切分：thresh 形如 "{2}" 或 "{1,2,3}"（XGBoost category code 集合）；
                # 去花括号、按 code 还原为真实品类值（字段名保持英文原文，方便对应数据表）
                cm = (cat_maps or {}).get(feat)
                raw = str(thresh).strip().strip("{}")
                names = set()
                for c in raw.split(","):
                    c = c.strip()
                    if not c:
                        continue
                    try:
                        names.add(str(cm[int(c)]) if cm else c)
                    except (ValueError, IndexError):
                        names.add(c)
                na_yes = info.get("missing") == info["yes"] and _hn(feat)
                dfs(info["yes"], steps + [("cat", feat, names, True, na_yes)])
                dfs(info["no"], steps + [("cat", feat, names, False, not na_yes and info.get("missing") == info["no"] and _hn(feat))])
            elif 0 < thresh < _SENTINEL_EPS:
                # 哨兵切分（二值特征）：yes(<哨兵)≡<=0，no(>=哨兵)≡>0；源头消掉科学计数法
                na_yes = info.get("missing") == info["yes"] and _hn(feat)
                dfs(info["yes"], steps + [("num", feat, None, (0.0, True), na_yes)])
                dfs(info["no"], steps + [("num", feat, (0.0, False), None, not na_yes and info.get("missing") == info["no"] and _hn(feat))])
            else:
                # XGBoost 数值切分 [feat<thresh]：yes=feat<thresh，no=feat>=thresh。
                # 必须是开上界/闭下界（`<`/`>=`），否则二值/计数特征产生 ">1" 这类空条件。
                na_yes = info.get("missing") == info["yes"] and _hn(feat)
                dfs(info["yes"], steps + [("num", feat, None, (float(thresh), False), na_yes)])
                dfs(info["no"], steps + [("num", feat, (float(thresh), True), None, not na_yes and info.get("missing") == info["no"] and _hn(feat))])

    dfs("0", [])
    return rules


def _build_score_buckets(y: pd.Series, scores: np.ndarray, n_buckets: int) -> list[ScoreBucket]:
    df_tmp = pd.DataFrame({"score": scores, "actual": y.values})
    df_tmp["bucket_idx"] = pd.qcut(df_tmp["score"], q=n_buckets, labels=False, duplicates="drop")
    bucket_labels = {
        n_buckets - 1: f"Top{100 // n_buckets}%",
        n_buckets - 2: f"Top{200 // n_buckets}%",
    }
    buckets = []
    for idx in sorted(df_tmp["bucket_idx"].dropna().unique(), reverse=True):
        grp = df_tmp[df_tmp["bucket_idx"] == idx]
        score_min, score_max = grp["score"].min(), grp["score"].max()
        label = bucket_labels.get(int(idx), f"D{int(idx) + 1}")
        buckets.append(ScoreBucket(
            bucket=label,
            score_range=f"[{score_min:.2f}, {score_max:.2f}]",
            user_count=len(grp),
            actual_cvr=float(grp["actual"].mean()),
            predicted_cvr=float(grp["score"].mean()),
        ))
    return buckets


def _high_score_not_converted(
    df: pd.DataFrame, scores: np.ndarray, y: pd.Series,
    top_features: list[FeatureImportance],
) -> dict:
    """高分未转化人群的"特征画像"。

    每个 Top 特征产出：
      - 数值列：{p25/p50/p75, mean_group, mean_overall, lift_pct, p_value}
      - 类别列：{top3_in_group, top3_in_overall, top_match}

    p_value 来自 Welch t-test (数值) / chi2 (类别)；scipy 不可用时为 None。
    便于宿主 Agent 直接圈人 + 写 finding。
    """
    from snippets.stats_utils import chi2_test, welch_t_test

    threshold = np.percentile(scores, 80)
    mask = (scores >= threshold) & (y.values == 0)
    high_nc = df[mask]
    n_group = int(len(high_nc))
    n_not_converted = int((y == 0).sum())
    if high_nc.empty:
        return {}

    share_pct = round(100 * n_group / max(n_not_converted, 1), 2)
    profile: dict[str, Any] = {
        # 结构化人群画像（建模目标为 is_paid，故"未转化"语义即"未成单"）
        "n": n_group,
        "share_of_not_converted_pct": share_pct,
        "score_threshold": float(threshold),
        "features": {},
    }
    # 子分层：创单未支付 vs 完全未转化（is_order_created 可用时）
    if "is_order_created" in df.columns:
        mask_order_not_paid = mask & (df["is_order_created"].values == 1)
        mask_completely_nc = mask & (df["is_order_created"].values == 0)
        n_order_not_paid = int(mask_order_not_paid.sum())
        n_completely_nc = int(mask_completely_nc.sum())
        profile["n_order_not_paid"] = n_order_not_paid
        profile["n_completely_not_converted"] = n_completely_nc
        profile["order_not_paid_pct"] = round(100 * n_order_not_paid / max(n_group, 1), 2)
        profile["note"] = (
            f"高分未转化中含 {n_order_not_paid} 人已创单未支付（支付环节问题）"
            f"和 {n_completely_nc} 人完全未转化（真正召回对象）"
        )
    for f in top_features[:8]:
        feat = f.feature
        if feat not in df.columns:
            continue
        col = df[feat]
        group_col = high_nc[feat]
        if pd.api.types.is_numeric_dtype(col):
            g = pd.to_numeric(group_col, errors="coerce").replace(-1, np.nan).dropna()
            o = pd.to_numeric(col, errors="coerce").replace(-1, np.nan).dropna()
            if len(g) < 5 or len(o) < 5:
                continue
            _, p_value, _ = welch_t_test(g, o)
            mean_g, mean_o = float(g.mean()), float(o.mean())
            lift_pct = (mean_g / mean_o - 1) if mean_o != 0 else None
            profile["features"][feat] = {
                "type": "numeric",
                "p25": round(float(g.quantile(0.25)), 3),
                "p50": round(float(g.quantile(0.50)), 3),
                "p75": round(float(g.quantile(0.75)), 3),
                "mean_group": round(mean_g, 3),
                "mean_overall": round(mean_o, 3),
                "lift_pct": round(lift_pct, 4) if lift_pct is not None else None,
                "p_value": round(p_value, 4) if not pd.isna(p_value) else None,
                "significant": bool(p_value < 0.05) if not pd.isna(p_value) else False,
            }
        else:
            g_vc = group_col.value_counts(normalize=True).head(3)
            o_vc = col.value_counts(normalize=True).head(3)
            top3_group = [(str(k), round(float(v), 4)) for k, v in g_vc.items()]
            top3_overall = [(str(k), round(float(v), 4)) for k, v in o_vc.items()]
            # 卡方检验：高分未转化人群与其它人在该列的分布是否显著不同
            p_value = None
            try:
                cats = list(set([k for k, _ in top3_group] + [k for k, _ in top3_overall]))
                if cats:
                    g_cnt = [int((group_col.astype(str) == c).sum()) for c in cats]
                    others = df[~mask]
                    o_cnt = [int((others[feat].astype(str) == c).sum()) for c in cats]
                    if sum(g_cnt) > 0 and sum(o_cnt) > 0:
                        _, pv, _ = chi2_test([g_cnt, o_cnt])
                        if not pd.isna(pv):
                            p_value = round(pv, 4)
            except Exception:
                p_value = None
            profile["features"][feat] = {
                "type": "categorical",
                "top3_in_group": top3_group,
                "top3_in_overall": top3_overall,
                "top_match": (
                    bool(top3_group and top3_overall and top3_group[0][0] == top3_overall[0][0])
                    if top3_group and top3_overall else False
                ),
                "p_value": p_value,
                "significant": bool(p_value is not None and p_value < 0.05),
            }
    return profile


def _compute_feature_direction(
    df: pd.DataFrame, feature: str, target: str = TARGET_COL,
) -> str:
    """计算单个特征对转化率的方向性（O27）。

    数值特征：比较 top-20% vs bottom-20% 的实际 CVR。
    类别特征：比较最高频 vs 次高频类别的 CVR。
    "mixed" 阈值按目标基础率自适应（成单率 ~2% 的 1 个百分点差≈创单率 ~7% 的 3 个百分点差）：
    数值差 < 40% 基础率、类别差 < 70% 基础率视为 mixed，避免成单口径下方向全塌为 mixed。
    返回 "positive" / "negative" / "mixed" / ""（无法判断）。
    """
    if feature not in df.columns or target not in df.columns:
        return ""
    col = df[feature]
    y   = df[target]
    base = float(y.mean()) if len(y) else 0.0
    # 基差相对阈值（带极小绝对下限防纯噪声）。绝对下限从 0.008/0.012 降到 0.0005/0.0008：
    # 旧下限在低基数活动（成单率 0.04%）下恒大于 0.40×base（=0.00016），使所有特征方向全塌为
    # mixed（模型摘要 5 个特征全显示「≈」）；下调后中高基数活动行为不变（0.40×base 仍主导），
    # 仅修复稀疏口径下方向判定，与 effective_signal 的相对效应量口径一致。
    thr_num = max(0.0005, 0.40 * base)
    thr_cat = max(0.0008, 0.70 * base)
    try:
        if pd.api.types.is_numeric_dtype(col):
            valid  = col.replace(-1, float("nan")).dropna()
            if len(valid) < 20:
                return ""
            q20 = float(valid.quantile(0.20))
            q80 = float(valid.quantile(0.80))
            mask_top = col >= q80
            mask_bot = col <= q20
            if mask_top.sum() < 5 or mask_bot.sum() < 5:
                return ""
            cvr_top = float(y[mask_top].mean())
            cvr_bot = float(y[mask_bot].mean())
            diff = cvr_top - cvr_bot
            if abs(diff) < thr_num:
                return "mixed"
            return "positive" if diff > 0 else "negative"
        else:
            vc = col.value_counts()
            if len(vc) < 2:
                return ""
            top_cats = vc.index[:2]
            cvr_a = float(y[col == top_cats[0]].mean())
            cvr_b = float(y[col == top_cats[1]].mean())
            diff  = abs(cvr_a - cvr_b)
            if diff < thr_cat:
                return "mixed"
            return "positive" if cvr_a > cvr_b else "negative"
    except Exception:
        return ""


def _low_score_converted(
    df: pd.DataFrame, scores: "np.ndarray", y: pd.Series,
    top_features: list[FeatureImportance],
) -> dict:
    """低分但实际转化人群的画像——模型漏判的隐藏信号（O24）。

    阈值取 scores 的 p20；分析 scores < threshold 且 y==1 的人群。
    输出结构与 _high_score_not_converted 一致，方便 renderer 统一处理。
    """
    from snippets.stats_utils import chi2_test, welch_t_test

    n_converted = int((y == 1).sum())
    pct         = 40 if n_converted < 30 else (30 if n_converted < 50 else 20)  # 小样本自适应扩大低分区间
    threshold   = np.percentile(scores, pct)
    mask        = (scores < threshold) & (y.values == 1)
    low_conv    = df[mask]
    n_group     = int(len(low_conv))
    if low_conv.empty:
        return {}

    share_pct = round(100 * n_group / max(n_converted, 1), 2)
    profile: dict[str, Any] = {
        "n": n_group,
        "share_of_converted_pct": share_pct,
        "score_threshold": float(threshold),
        "note": (
            f"模型漏判人群：{n_group} 名实际转化用户预测分低于 p20，"
            f"占全部转化的 {share_pct}%。"
            "其共同特征指向模型遗漏的重要信号，建议作为特征工程优先方向。"
        ),
        "features": {},
    }
    for f in top_features[:8]:
        feat = f.feature
        if feat not in df.columns:
            continue
        col       = df[feat]
        group_col = low_conv[feat]
        if pd.api.types.is_numeric_dtype(col):
            g = pd.to_numeric(group_col, errors="coerce").replace(-1, np.nan).dropna()
            o = pd.to_numeric(col, errors="coerce").replace(-1, np.nan).dropna()
            if len(g) < 5 or len(o) < 5:
                continue
            _, p_value, _ = welch_t_test(g, o)
            mean_g, mean_o = float(g.mean()), float(o.mean())
            lift_pct = (mean_g / mean_o - 1) if mean_o != 0 else None
            profile["features"][feat] = {
                "type": "numeric",
                "p25": round(float(g.quantile(0.25)), 3),
                "p50": round(float(g.quantile(0.50)), 3),
                "p75": round(float(g.quantile(0.75)), 3),
                "mean_group": round(mean_g, 3),
                "mean_overall": round(mean_o, 3),
                "lift_pct": round(lift_pct, 4) if lift_pct is not None else None,
                "p_value": round(p_value, 4) if not pd.isna(p_value) else None,
                "significant": bool(p_value < 0.05) if not pd.isna(p_value) else False,
            }
        else:
            g_vc = group_col.value_counts(normalize=True).head(3)
            o_vc = col.value_counts(normalize=True).head(3)
            top3_group   = [(str(k), round(float(v), 4)) for k, v in g_vc.items()]
            top3_overall = [(str(k), round(float(v), 4)) for k, v in o_vc.items()]
            p_value = None
            try:
                cats  = list(set([k for k, _ in top3_group] + [k for k, _ in top3_overall]))
                if cats:
                    g_cnt = [int((group_col.astype(str) == c).sum()) for c in cats]
                    others = df[~mask]
                    o_cnt  = [int((others[feat].astype(str) == c).sum()) for c in cats]
                    if sum(g_cnt) > 0 and sum(o_cnt) > 0:
                        _, pv, _ = chi2_test([g_cnt, o_cnt])
                        if not pd.isna(pv):
                            p_value = round(pv, 4)
            except Exception:
                p_value = None
            profile["features"][feat] = {
                "type": "categorical",
                "top3_in_group": top3_group,
                "top3_in_overall": top3_overall,
                "top_match": (
                    bool(top3_group and top3_overall and top3_group[0][0] == top3_overall[0][0])
                    if top3_group and top3_overall else False
                ),
                "p_value": p_value,
                "significant": bool(p_value is not None and p_value < 0.05),
            }
    return profile


def _rule_stability(
    df: pd.DataFrame, rules: list["DecisionRule"],
    dims: list[str] | None = None,
    top_n: int = 5,
    target_col: str = TARGET_COL,
) -> dict:
    """O25：Top 规则在关键子人群中的 precision 稳定性。

    返回 {rule_text: {dim_val: precision}} 嵌套字典。precision 按建模目标列计算。
    """
    dims = dims or ["pre_primary_platform", "pre_first_active_period"]
    if not rules or target_col not in df.columns:
        return {}
    result: dict[str, dict] = {}
    for rule in rules[:top_n]:
        try:
            mask_rule = _apply_rule_mask(df, rule.rule_text)
        except Exception:
            continue
        if mask_rule is None or mask_rule.sum() < 10:
            continue
        sub_results: dict[str, float] = {}
        for dim in dims:
            if dim not in df.columns:
                continue
            for val in df[dim].dropna().unique():
                mask_dim = (df[dim] == val).values
                combo = mask_rule & mask_dim
                n = int(combo.sum())
                if n < 10:
                    continue
                prec = float(df.loc[combo, target_col].mean())
                sub_results[f"{dim}={val}"] = round(prec, 4)
        if sub_results:
            result[rule.rule_text[:60]] = sub_results
    return result


def _apply_rule_mask(df: pd.DataFrame, rule_text: str) -> "np.ndarray | None":
    """将简单条件规则文本解析为 bool 数组（AND 连接的 col op val / col in [...] 格式）。

    fix19:补上分类切分子句 `feat in [a,b]` / `feat not in [a,b]` 的解析 ——
    此前含分类切分的规则整条返回 None,稳定性(O25)/重叠(O28)检验把它们静默跳过。
    `空值` 标签对应 NaN(入模时的 __NA__ 哨兵);not in 按 SQL 语义排除 NULL。
    """
    import re
    conditions = [c.strip() for c in rule_text.split(" AND ")]
    mask = np.ones(len(df), dtype=bool)
    for cond in conditions:
        m_cat = re.match(r"(.+?)\s+(not in|in)\s+\[(.*)\]$", cond)
        if m_cat:
            col, neg = m_cat.group(1).strip(), m_cat.group(2) == "not in"
            if col not in df.columns:
                return None
            vals = [v.strip() for v in m_cat.group(3).split(",") if v.strip() != ""]
            has_na = any(v in ("空值", "__NA__") for v in vals)
            vals = [v for v in vals if v not in ("空值", "__NA__")]
            in_mask = df[col].astype(str).isin(vals).values & df[col].notna().values
            if has_na:
                in_mask |= df[col].isna().values
            if neg:
                cond_mask = ~in_mask
                if not has_na:
                    cond_mask &= df[col].notna().values   # SQL NOT IN 语义:NULL 不命中
            else:
                cond_mask = in_mask
            mask &= cond_mask
            continue
        m = re.match(r"(.+?)\s*(<=|>=|<|>|==|!=)\s*(.+)", cond)
        if not m:
            return None
        col, op, val_str = m.group(1).strip(), m.group(2), m.group(3).strip()
        if col not in df.columns:
            return None
        try:
            val = float(val_str)
        except ValueError:
            val = val_str.strip("'\"")
        col_vals = pd.to_numeric(df[col], errors="coerce") if isinstance(val, float) else df[col]
        if   op == "<=": mask &= (col_vals <= val).fillna(False).values
        elif op == ">=": mask &= (col_vals >= val).fillna(False).values
        elif op == "<":  mask &= (col_vals  < val).fillna(False).values
        elif op == ">":  mask &= (col_vals  > val).fillna(False).values
        elif op == "==": mask &= (col_vals == val).fillna(False).values
        elif op == "!=": mask &= (col_vals != val).fillna(False).values
    return mask


def _rule_overlap(
    df: pd.DataFrame, rules: list["DecisionRule"], top_n: int = 0,
    target_col: str = TARGET_COL,
) -> dict:
    """O28：Top 规则命中人群 Jaccard 相似度矩阵。

    返回：
      - jaccard_matrix: list of {rule_a, rule_b, jaccard}（仅 jaccard > 0.05）
      - redundant_pairs: jaccard > 0.70 的规则对
      - complementary_pairs: jaccard < 0.05 且均 precision > 0.5 的互斥规则对
      - pairs: list of {i, j, jaccard} —— fix20 新增,i/j 是规则在 decision_rules
        里的**下标**(不是截断文本),下游(model_interpreter 选人群)据此做去冗贪心;
        文本标签会被截断/改写,只有下标能稳定 join。
      - n_rules_covered: 实际算了掩码的规则数
      - rules_without_mask: 没算出掩码的规则下标 —— 下游据此判断"去冗数据是否完整",
        缺了要吵出来而不是静默放行(见下)

    fix20:top_n 默认改为 0 = 覆盖全部规则(原来只算前 5 条)。掩码运算开销可忽略;
    覆盖不全会让下游去冗对拿不到数据的规则失效。

    2026-08-17 两处返工(线上出现三条模型人群里两条圈同一批人、去冗没拦住):
      ① 掩码改用 **rule_pandas**(与 rule_sql 同源渲染、已被叶子 oracle 逐行自检的
         交付形态)。原来解析的是 rule_text —— 那是 display 形态,注释里写明"允许取整
         美化,不参与执行",且它不认训练帧的 '__NA__' 哨兵:同一条规则 display 解析
         圈 132 人、交付形态只有 91 人(本地实测)。拿一个近似population算重叠度,
         判重结论当然不可靠。rule_pandas 缺失/求值失败才退回老解析器。
      ② 去掉 `m.sum() >= 10` 这道**静默**跳过。命中少的规则同样要判重 —— 小集合的
         Jaccard 恰恰最容易是 1.0(两条规则圈的就是同一小撮人);跳过的结果是下游
         拿不到这一对,fail-open 放它进人群包。要跳过也得让下游看见(rules_without_mask)。
    """
    # fix20:门槛原来硬写 "is_converted",而本函数算的是 target_col(可能是 is_paid)——
    # 目标列换成 is_paid 且数据里没有 is_converted 时,整个 O28 会被静默跳过。改为查真正用到的列。
    if not rules or target_col not in df.columns:
        return {}
    subset = rules if not top_n else rules[:top_n]
    masks, labels, idxs, missing = [], [], [], []
    for ri, rule in enumerate(subset):
        m = _rule_mask_for_overlap(df, rule)
        if m is None:
            missing.append(ri)
            continue
        masks.append(m)
        labels.append(rule.rule_text[:50])
        idxs.append(ri)

    matrix = []
    pairs = []
    redundant, complementary = [], []
    for i in range(len(masks)):
        for j in range(i + 1, len(masks)):
            inter = int((masks[i] & masks[j]).sum())
            union = int((masks[i] | masks[j]).sum())
            jac = round(inter / union, 4) if union > 0 else 0.0
            pairs.append({"i": idxs[i], "j": idxs[j], "jaccard": jac})
            if jac > 0.05:
                matrix.append({
                    "rule_a": labels[i], "rule_b": labels[j], "jaccard": jac
                })
            if jac > 0.70:
                redundant.append((labels[i], labels[j]))
            elif jac < 0.05:
                prec_a = float(df.loc[masks[i], target_col].mean()) if masks[i].sum() else 0
                prec_b = float(df.loc[masks[j], target_col].mean()) if masks[j].sum() else 0
                if prec_a > 0.5 and prec_b > 0.5:
                    complementary.append((labels[i], labels[j]))
    if missing:
        logger.warning("规则重叠(O28):%d/%d 条规则算不出命中掩码(下标 %s),"
                       "这些规则的去冗判重会失效", len(missing), len(subset), missing[:8])
    return {
        "jaccard_matrix": matrix,
        "redundant_pairs": redundant,
        "complementary_pairs": complementary,
        "pairs": pairs,
        "n_rules_covered": len(masks),
        "n_rules_total": len(subset),
        "rules_without_mask": missing,
    }


def _rule_mask_for_overlap(df: pd.DataFrame, rule) -> "np.ndarray | None":
    """判重用的命中掩码。优先交付形态(rule_pandas),退回 display 解析器。

    为什么必须优先 rule_pandas:它与 rule_sql 出自同一次渲染、被叶子 oracle 逐行
    验证过,是"这条规则真正会圈到的人";rule_text 是展示串,阈值做过美化、也不认
    训练帧的 '__NA__' 哨兵。判重要判的是**交付出去的那批人**,不是展示串的近似。
    """
    cond = getattr(rule, "rule_pandas", "") or ""
    if cond:
        try:
            try:
                from .diagnostic_engine import eval_condition as _ev
            except ImportError:
                from diagnostic_engine import eval_condition as _ev
            m = _ev(cond, df)
            if m is not None:
                return np.asarray(m, dtype=bool)
        except Exception:      # noqa: BLE001 —— 退回老路,不因判重炸掉整份分析
            pass
    try:
        m = _apply_rule_mask(df, getattr(rule, "rule_text", "") or "")
    except Exception:          # noqa: BLE001
        m = None
    return None if m is None else np.asarray(m, dtype=bool)


def _score_distribution(
    y: pd.Series, scores: "np.ndarray",
) -> dict:
    """O29：分数分布形态 + 过度自信检测。"""
    from scipy import stats as scipy_stats
    score_arr = np.asarray(scores, dtype=float)
    skewness = float(scipy_stats.skew(score_arr))
    kurtosis = float(scipy_stats.kurtosis(score_arr))
    pct_above_09 = float((score_arr > 0.9).mean())
    pct_below_01 = float((score_arr < 0.1).mean())
    return {
        "skewness": round(skewness, 4),
        "kurtosis": round(kurtosis, 4),
        "pct_above_0_9": round(pct_above_09, 4),
        "pct_below_0_1": round(pct_below_01, 4),
        "overconfident": bool(pct_above_09 > 0.30),
    }


def _stratified_score_buckets(
    df: pd.DataFrame, y: pd.Series, scores: "np.ndarray",
    n_buckets: int = 5,
    dims: list[str] | None = None,
    min_samples: int = 20,
) -> dict:
    """O30：score_buckets 按关键维度再细分，产出 bucket × dim × CVR 矩阵。"""
    dims = dims or ["pre_primary_platform", "pre_has_mkt_click"]
    score_arr = np.asarray(scores)
    try:
        buckets_cut = pd.Series(pd.qcut(score_arr, q=n_buckets, duplicates="drop"))
    except Exception:
        return {}

    result: dict[str, list] = {}
    for dim in dims:
        if dim not in df.columns:
            continue
        rows = []
        for bucket in buckets_cut.cat.categories:
            mask_b = (buckets_cut == bucket)
            for val in df[dim].dropna().unique():
                mask_d = (df[dim] == val).values
                combo = mask_b & mask_d
                n = int(combo.sum())
                if n < min_samples:
                    continue
                cvr_actual    = float(y.values[combo].mean())
                score_avg     = float(score_arr[combo].mean())
                rows.append({
                    "bucket": str(bucket),
                    "dim_val": str(val),
                    "user_cnt": n,
                    "actual_cvr": round(cvr_actual, 4),
                    "predicted_cvr": round(score_avg, 4),
                    "gap": round(abs(cvr_actual - score_avg), 4),
                })
        if rows:
            result[dim] = rows
    return result


def _stratified_auc(
    df: pd.DataFrame, scores: "np.ndarray", y: pd.Series,
    dims: list[str] | None = None,
    min_samples: int = 50,
) -> dict:
    """分层 AUC：按关键维度的每个取值计算子集 AUC（O23）。

    返回 {dim: {val: auc}} 嵌套字典；子集样本不足或单类时跳过。
    使用全量数据的 scores（与 _build_score_buckets 一致）。
    """
    from sklearn.metrics import roc_auc_score

    dims = dims or ["pre_primary_platform", "pre_first_active_period", "pre_has_mkt_click"]
    result: dict[str, dict[str, float]] = {}
    scores_arr = np.asarray(scores)
    y_arr = y.values

    for dim in dims:
        if dim not in df.columns:
            continue
        dim_result: dict[str, float] = {}
        for val in df[dim].dropna().unique():
            mask = (df[dim] == val).values
            if mask.sum() < min_samples:
                continue
            y_sub = y_arr[mask]
            if len(np.unique(y_sub)) < 2:
                continue
            try:
                auc_sub = float(roc_auc_score(y_sub, scores_arr[mask]))
                dim_result[str(val)] = round(auc_sub, 4)
            except Exception:
                pass
        if dim_result:
            result[dim] = dim_result
    return result


def _calibration(
    y: pd.Series, scores: "np.ndarray", n_bins: int = 10,
) -> dict:
    """校准度分析：预测概率 vs 实际转化率（O26）。

    将预测概率等频分成 n_bins 桶，对比每桶的平均预测概率与实际 CVR。
    返回：
      - bins: list of {bin, predicted_cvr, actual_cvr, gap}
      - max_calibration_gap: 最大校准差
      - is_well_calibrated: max_gap < 0.05
      - overconfident: 高分段（>0.9）占比>30% 且 max_gap > 0.1
    """
    score_series = pd.Series(scores, name="score")
    y_arr = np.asarray(y)
    try:
        bins_cut = pd.qcut(score_series, q=n_bins, duplicates="drop")
    except Exception:
        return {}

    rows = []
    for b in bins_cut.cat.categories:
        mask = (bins_cut == b).values
        if mask.sum() == 0:
            continue
        predicted = float(score_series[mask].mean())
        actual    = float(y_arr[mask].mean())
        rows.append({
            "bin":           str(b),
            "predicted_cvr": round(predicted, 4),
            "actual_cvr":    round(actual, 4),
            "gap":           round(abs(predicted - actual), 4),
            "n":             int(mask.sum()),
        })
    if not rows:
        return {}

    max_gap = max(r["gap"] for r in rows)
    high_score_pct = float((score_series > 0.9).mean())
    return {
        "bins": rows,
        "max_calibration_gap": round(max_gap, 4),
        "is_well_calibrated": bool(max_gap < 0.05),
        "overconfident": bool(high_score_pct > 0.30 and max_gap > 0.10),
        "high_score_pct": round(high_score_pct, 4),
    }


# ── 主入口 ─────────────────────────────────────────────────────────────


def run_model_analysis(
    df: pd.DataFrame,
    backend: ModelBackend = "auto",
    top_n_features: int = 20,
    top_n_rules: int = 10,
    n_buckets: int = 10,
    exclude_cols: set[str] | None = None,
    min_samples: int = 500,
    hard_min_samples: int = 100,
    target_col: str = TARGET_COL,
    feature_loader: "Any | None" = None,
    class_rates: "tuple[float, float] | None" = None,
    true_overall_cvr: "float | None" = None,
) -> ModelAnalysisResult | None:
    """跑一遍小模型路径，返回 ModelAnalysisResult；不可跑则返回 None。

    参数：
        target_col     : 目标列，默认 "is_converted"；也可传 "is_paid" 聚焦成单分析
        feature_loader : FeatureLoader 实例（可选）；传入时 top_features 附带字段描述
        class_rates    : (正样本采样率, 负样本采样率)。调用方做过类别下采样
                         (如 MA_MODEL_SAMPLE 的"正样本全保留、只采负样本")时传入,
                         人数/CVR 按分类别采样率无偏外推回全量口径;None=(1,1)=未采样
        true_overall_cvr: 全量口径成单率(采样时由调用方在全量数据上算好传入);
                         None 时按 class_rates 无偏估计,未采样时即 overall_cvr

    统计口径(fix19):分桶/高分未转化/低分已转化/分层AUC/校准/规则精度等分数型统计
    一律在**验证集(20%)**上计算(训练集分数带 in-sample 乐观偏差),人数字段按
    "验证集→采样集→全量"分类别外推;规则/人群的 `n`、`sample_count` 均为全量估计,
    原始计数保留在 *_raw 字段。

    样本量分级：
      - len(df) < hard_min_samples（默认 100）：直接跳过
      - hard_min_samples <= len(df) < min_samples：仍训练，note 标 [低样本量]
      - len(df) >= min_samples：正常训练

    诊断目标：is_converted 或 is_paid 的高低
    """
    # 动态目标列：支持 is_converted 或 is_paid
    effective_target = target_col if target_col in df.columns else TARGET_COL
    if effective_target not in df.columns:
        return None
    if len(df) < hard_min_samples:
        return ModelAnalysisResult(
            backend="none", n_features=0, n_samples=len(df),
            overall_cvr=float(df[effective_target].mean()) if effective_target in df.columns else 0,
            auc=0.0, note=f"[跳过] 样本量 {len(df)} < hard_min_samples={hard_min_samples}",
        )
    # 低样本警告分三级（独立于 caller 的 min_samples），用于下游 confidence 加权：
    #   n < 200    → 强警告；mq *= 0.3
    #   200-499    → 弱警告；mq *= 0.6
    #   >= 500     → 正常
    n_total = len(df)
    if n_total < 200:
        low_sample_warning = (
            f"[低样本量·强] n={n_total}<200；AUC/特征重要性不可作为运营依据，"
            "仅供方向参考"
        )
    elif n_total < 500:
        low_sample_warning = (
            f"[低样本量·弱] n={n_total}<500；AUC 区间宽，决策规则方向可信但"
            "绝对阈值勿直接用作运营依据"
        )
    else:
        low_sample_warning = ""

    exclude = (exclude_cols or set()) | DEFAULT_EXCLUDE | _dimension_exclude()

    try:
        backend_resolved = _resolve_backend(backend)
    except ImportError as e:
        return ModelAnalysisResult(
            backend="none", n_features=0, n_samples=len(df),
            overall_cvr=float(df[effective_target].mean()) if effective_target in df.columns else 0,
            auc=0.0, note=f"[跳过] {e}",
        )

    # 目标列可能是 is_converted 或 is_paid；在 exclude 中去掉另一个但保留当前目标
    exclude = exclude - {effective_target}

    X, y, feature_names, dropped_zero_var = _prepare_features_with_target(df, exclude, effective_target)
    overall_cvr = float(y.mean())

    if y.nunique() < 2:
        return ModelAnalysisResult(
            backend=backend_resolved, n_features=len(feature_names),
            n_samples=len(df), overall_cvr=overall_cvr, auc=0.0,
            note=f"[跳过] 目标列 {effective_target} 单类",
        )

    pos_rate, neg_rate = (class_rates or (1.0, 1.0))
    pos_rate = float(pos_rate) if pos_rate else 1.0
    neg_rate = float(neg_rate) if neg_rate else 1.0
    sampled = abs(pos_rate - 1.0) > 1e-12 or abs(neg_rate - 1.0) > 1e-12

    model, val_scores, auc, auc_ci_low, auc_ci_high, pos_weight, val_index = _train_and_score(
        X, y, backend_resolved)
    df_val = df.loc[val_index]
    y_val = y.loc[val_index]
    n_pos_all = int((y == 1).sum())
    n_neg_all = int(len(y) - n_pos_all)
    n_pos_val = int((y_val == 1).sum())
    n_neg_val = int(len(y_val) - n_pos_val)
    # 分类别外推系数:验证集 → 采样集 → 全量。分层切分 + 已知采样率,估计无偏。
    pos_scale = (n_pos_all / max(n_pos_val, 1)) / pos_rate
    neg_scale = (n_neg_all / max(n_neg_val, 1)) / neg_rate

    def _pop_n(n_pos_grp: float, n_neg_grp: float) -> int:
        return int(round(n_pos_grp * pos_scale + n_neg_grp * neg_scale))

    n_samples_population = _pop_n(n_pos_val, n_neg_val)
    if true_overall_cvr is not None:
        true_cvr = float(true_overall_cvr)
    else:
        _est_pos = n_pos_all / pos_rate
        _est_all = _est_pos + n_neg_all / neg_rate
        true_cvr = float(_est_pos / _est_all) if _est_all > 0 else overall_cvr

    top_features = _extract_importance(model, feature_names, backend_resolved, top_n_features)

    # O27：为每个 top 特征附加方向性标注和特征描述
    for fi in top_features:
        fi.direction = _compute_feature_direction(df, fi.feature)
    _enrich_with_feature_descriptions(top_features, feature_loader)

    try:
        # fix19:规则的 precision/recall 也在验证集上评估(训练集命中带乐观偏差)
        rules = (_extract_rules_lgb(model, overall_cvr, top_n_rules, X=X.loc[val_index], y=y_val)
                 if backend_resolved == "lightgbm"
                 else _extract_rules_xgb(model, overall_cvr, top_n_rules, X=X.loc[val_index], y=y_val))
    except Exception as e:
        rules = []
        print(f"[model_analyst] 规则提取失败: {e}")

    # fix19:规则人数/CVR 外推到全量口径(sample_count 回填为全量估计,原值留 raw)
    if any(r.precision > 0 or r.n_converted > 0 for r in rules):
        for r in rules:
            _p = int(r.n_converted)
            _ng = max(int(r.sample_count) - _p, 0)
            r.sample_count_raw = int(r.sample_count)
            r.sample_count = _pop_n(_p, _ng)
            _denom = _p * pos_scale + _ng * neg_scale
            r.precision_population = float(_p * pos_scale / _denom) if _denom > 0 else 0.0
            r.lift_population = float(r.precision_population / true_cvr) if true_cvr > 0 else 0.0

    buckets       = _build_score_buckets(y_val, val_scores, n_buckets)
    for b in buckets:
        _bp = b.actual_cvr * b.user_count          # 0/1 均值 × 数量 = 精确正样本数
        b.user_count = _pop_n(_bp, b.user_count - _bp)
    high_nc       = _high_score_not_converted(df_val, val_scores, y_val, top_features)
    if high_nc.get("n"):
        high_nc["n_raw"] = int(high_nc["n"])
        high_nc["n"] = _pop_n(0, high_nc["n_raw"])   # 该人群全为未转化 → 按负类外推
    low_conv      = _low_score_converted(df_val, val_scores, y_val, top_features)   # O24
    if low_conv.get("n"):
        low_conv["n_raw"] = int(low_conv["n"])
        low_conv["n"] = _pop_n(low_conv["n_raw"], 0)  # 该人群全为已转化 → 按正类外推
    strat_auc     = _stratified_auc(df_val, val_scores, y_val)                      # O23
    calib         = _calibration(y_val, val_scores)                                 # O26
    if calib:
        calib["sampled_prior"] = bool(sampled)
        if sampled:
            calib["note"] = ("训练数据为类别下采样产物(正样本全保留),预测概率绝对值反映"
                             "采样先验而非线上先验;桶级校准仅在采样口径内有意义")
    rule_stab     = _rule_stability(df_val, rules, target_col=effective_target)     # O25
    # O28:在**全量帧**上算重叠 —— 规则的交付命中(sample_count)也是在这份帧上算的,
    # 只在 20% 验证集上算会让小人群的命中数掉到个位数,判重跟着失真/失效。
    rule_ovlp     = _rule_overlap(df, rules, target_col=effective_target)           # O28
    score_dist    = _score_distribution(y_val, val_scores)                          # O29
    strat_buckets = _stratified_score_buckets(df_val, y_val, val_scores)            # O30

    # 把零方差剔除信息、目标列追加到 note，便于诊断报告透明展示
    target_note = f"[目标列: {effective_target}]" if effective_target != TARGET_COL else ""
    scope_note = "[统计口径] 分桶/人群/校准/规则精度基于验证集(20%),人数已按类别外推至全量"
    if sampled:
        scope_note += f";训练采样率 正={pos_rate:.4g}/负={neg_rate:.4g}"
    note_parts = [p for p in [target_note, low_sample_warning, scope_note] if p]
    if dropped_zero_var:
        preview = ", ".join(dropped_zero_var[:8])
        more = f"…(共 {len(dropped_zero_var)} 列)" if len(dropped_zero_var) > 8 else ""
        note_parts.append(f"[零方差剔除] {preview}{more}")

    return ModelAnalysisResult(
        backend=backend_resolved,
        n_features=X.shape[1],
        n_samples=len(df),
        overall_cvr=overall_cvr,
        auc=auc,
        auc_ci_low=auc_ci_low,
        auc_ci_high=auc_ci_high,
        pos_weight=pos_weight,
        top_features=top_features,
        decision_rules=rules,
        score_buckets=buckets,
        high_score_not_converted=high_nc,
        low_score_converted=low_conv,
        stratified_auc=strat_auc,
        calibration=calib,
        rule_stability=rule_stab,
        rule_overlap=rule_ovlp,
        score_distribution=score_dist,
        stratified_score_buckets=strat_buckets,
        note=" / ".join(note_parts),
        sampled=sampled,
        class_rates=(pos_rate, neg_rate),
        true_overall_cvr=true_cvr,
        n_samples_population=n_samples_population,
        stats_scope="val",
    )
