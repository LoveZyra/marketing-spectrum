"""小模型转化预估。

提供：
  - ModelAnalysisResult dataclass
  - run_model_analysis(df, ...) -> ModelAnalysisResult / None
  - result.to_dict() 返回可 JSON 序列化的结构

依赖：lightgbm 或 xgboost（二选一）、scikit-learn、pandas、numpy
"""
from __future__ import annotations

import warnings
from dataclasses import dataclass, field
from typing import Any, Literal

import numpy as np
import pandas as pd

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

    rules: list[DecisionRule] = []
    for _, leaf in leaves.iterrows():
        path, sql_path = _trace_path_lgb(trees_df, leaf["tree_index"], leaf["node_index"], cat_maps)
        if not path:
            continue
        pred_cvr = 1 / (1 + np.exp(-leaf["value"]))

        precision = recall = 0.0
        n_converted = 0
        sample_count = int(leaf["count"])
        if pred_leaves is not None and y_arr is not None:
            tree_idx = int(leaf["tree_index"])
            # leaf node_index 形如 "0-L3"；LightGBM pred_leaf 给出的是叶子序号
            leaf_id = _lgb_leaf_id(str(leaf["node_index"]))
            if leaf_id is not None and tree_idx < pred_leaves.shape[1]:
                mask = pred_leaves[:, tree_idx] == leaf_id
                hits = int(mask.sum())
                if hits > 0:
                    sample_count = hits  # 使用真实命中数（含 val 集）
                    n_converted = int(y_arr[mask].sum())
                    precision = n_converted / hits
                    recall = (n_converted / n_positives) if n_positives > 0 else 0.0

        rules.append(DecisionRule(
            rule_text=" AND ".join(path),
            rule_sql=" AND ".join(sql_path),
            predicted_cvr=float(pred_cvr),
            sample_count=sample_count,
            lift=float(pred_cvr / overall_cvr) if overall_cvr > 0 else 0,
            precision=float(precision),
            recall=float(recall),
            n_converted=n_converted,
        ))

    rules.sort(key=lambda r: r.predicted_cvr, reverse=True)
    return _dedup_rules(rules, top_n)


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


_SENTINEL_EPS = 1e-20  # 树对二值 0/1 特征的切分哨兵上界（实际切分点约 1e-35）


_MAX_DECIMALS = 4   # 阈值最多保留 4 位小数（业务要求；再多既不可读也无业务意义）


def _fmt_threshold(v: float) -> str:
    """树切分阈值 → 无科学计数法、最多 4 位小数的字符串，rule_text/rule_sql 共用。

    两条硬约束：
      1) 下游（报告展示、org_json、Spark SQL）不出现 `3e-05` 这类科学计数法；
      2) 最多 4 位小数 —— 树切分点是相邻取值的中点，带一堆浮点噪声
         （`2.5000000000000004`、`15.520000000000001`），照抄出去既难读又毫无意义。

    唯一例外：4 位小数会把值抹成 0 的极小阈值（率值特征的 3e-05 等），
    那样等价于把 `> 0.00003` 写成 `> 0`，语义全变。这时才继续加位数，
    取第一个非零写法（仍然不用科学计数法）。

    ⚠ 2026-08-07 修回归：fix20 为消灭科学计数法改成"加位数直到 float 完全相等"，
    结果把浮点噪声全暴露出来（线上出现 `> 2.50000000000000044409`）。
    正确取舍是：可读性优先，噪声级差异（相对 1e-9 以下）不值得保留。
    """
    if v == int(v):
        return str(int(v))
    s = f"{v:.{_MAX_DECIMALS}f}".rstrip("0").rstrip(".")
    if s and float(s) != 0:
        return s
    for nd in (6, 8, 10, 12, 15, 20, 30, 40):   # 极小阈值：加到能表示出非零为止
        s = f"{v:.{nd}f}".rstrip("0").rstrip(".")
        if s and float(s) != 0:
            return s
    return "0"


def _merge_render_clauses(steps: list, cat_maps: dict | None = None) -> tuple[list[str], list[str]]:
    """fix19:LGB/XGB 共用的"结构化路径子句 → (display, SQL)"合并渲染器。

    steps 为根→叶顺序的切分步骤列表:
      ("num", feat, lo, hi)      lo/hi = (阈值, 是否闭边界) 或 None,每步恰有一侧;
      ("cat", feat, names, is_in) names 为已还原的类别名集合(str)。
    两个后端统一享受三件事:
      1) 同特征多次切分合并:数值取最紧上下界(同值时开边界更紧);分类 IN 求交、
         NOT IN 求并,再按 AND 语义 pos-neg 相减 —— 规则更短,圈人 SQL 无冗余;
      2) __NA__ 哨兵不外泄:display 写「空值」,SQL 翻译为 IS NULL / IS NOT NULL 组合
         (哨兵字面量在线上表匹配不到真实 NULL);
      3) 反选清单若补集更小(≤8 且不大于清单),改写为等价 IN(补集),长清单 NOT IN
         可读可执行(注:补集写法对训练中未见过的新类别更保守)。
    边界写法由步骤自带的开闭标记决定:LGB 只产生 <=/>,XGB 只产生 </>=,各保原味。
    """
    num_bounds: dict = {}   # feat -> [lo(值,闭)|None, hi(值,闭)|None]
    cat_sets: dict = {}     # feat -> {"pos": set|None, "neg": set}
    order: list[str] = []

    for step in steps:
        kind, feat = step[0], step[1]
        if feat not in order:
            order.append(feat)
        if kind == "num":
            lo, hi = step[2], step[3]
            slot = num_bounds.setdefault(feat, [None, None])
            if lo is not None and (slot[0] is None or lo[0] > slot[0][0]
                                   or (lo[0] == slot[0][0] and not lo[1])):
                slot[0] = lo    # 下界取更大;同值时开边界(>)比闭边界(>=)更紧
            if hi is not None and (slot[1] is None or hi[0] < slot[1][0]
                                   or (hi[0] == slot[1][0] and not hi[1])):
                slot[1] = hi    # 上界取更小;同值时开边界(<)更紧
        else:
            names, is_in = set(step[2]), step[3]
            slot = cat_sets.setdefault(feat, {"pos": None, "neg": set()})
            if is_in:
                slot["pos"] = names if slot["pos"] is None else (slot["pos"] & names)
            else:
                slot["neg"] |= names

    path: list[str] = []
    sql_path: list[str] = []

    def _render_cat(feat: str, values: set, negated: bool) -> None:
        vals = sorted(str(v) for v in values)
        disp = ",".join("空值" if v == "__NA__" else v for v in vals)
        real = [v for v in vals if v != "__NA__"]
        has_na = len(real) != len(vals)
        quoted = ",".join("'{}'".format(v.replace("'", "''")) for v in real)
        if not negated:
            path.append(f"{feat} in [{disp}]")
        else:
            path.append(f"{feat} not in [{disp}]")
        if not negated:
            if has_na and real:
                sql_path.append(f"({feat} IS NULL OR {feat} IN ({quoted}))")
            elif has_na:
                sql_path.append(f"{feat} IS NULL")
            else:
                sql_path.append(f"{feat} IN ({quoted})")
        else:
            if has_na and real:
                sql_path.append(f"({feat} IS NOT NULL AND {feat} NOT IN ({quoted}))")
            elif has_na:
                sql_path.append(f"{feat} IS NOT NULL")
            else:
                sql_path.append(f"{feat} NOT IN ({quoted})")

    for feat in order:
        if feat in num_bounds:
            lo, hi = num_bounds[feat]
            if lo is not None:
                op = ">=" if lo[1] else ">"
                vs = _fmt_threshold(lo[0])
                path.append(f"{feat}{op}{vs}")
                sql_path.append(f"{feat} {op} {vs}")
            if hi is not None:
                op = "<=" if hi[1] else "<"
                vs = _fmt_threshold(hi[0])
                path.append(f"{feat}{op}{vs}")
                sql_path.append(f"{feat} {op} {vs}")
            continue
        slot = cat_sets[feat]
        pos, neg = slot["pos"], slot["neg"]
        cm = (cat_maps or {}).get(feat)
        if pos is not None:
            merged = pos - neg          # AND 语义:命中集合剔除反选集合
            if merged:
                _render_cat(feat, merged, False)
            else:                        # 极端矛盾路径,退回不合并的两段(保守)
                _render_cat(feat, pos, False)
                if neg:
                    _render_cat(feat, neg, True)
        else:
            if cm:
                comp = {str(c) for c in cm} - {str(v) for v in neg}
                if comp and len(comp) <= min(8, len(neg)):
                    _render_cat(feat, comp, False)
                    continue
            _render_cat(feat, neg, True)

    return path, sql_path


def _trace_path_lgb(trees_df, tree_idx, node_idx, cat_maps=None) -> tuple[list[str], list[str]]:
    """返回 (display_path, sql_path)。

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
        is_cat = isinstance(thresh, str) and "||" in str(thresh)
        if is_cat:
            codes = [c for c in str(thresh).split("||") if c != ""]
            cm = (cat_maps or {}).get(feat)
            names = set()
            for c in codes:
                try:
                    names.add(str(cm[int(c)]) if cm else str(c))
                except (ValueError, IndexError):
                    names.add(str(c))
            # LightGBM：threshold 列出的是走向 left 子节点的类别集合
            steps_rev.append(("cat", feat, names, went_left))
        else:
            if isinstance(thresh, (int, float)) and 0 < thresh < _SENTINEL_EPS:
                # 二值 0/1 特征的哨兵切分（约 1e-35）：左 ≡ <=0，右 ≡ >0
                lo, hi = (None, (0.0, True)) if went_left else ((0.0, False), None)
            elif went_left:
                lo, hi = None, (float(thresh), True)     # 左:feat <= thresh
            else:
                lo, hi = (float(thresh), False), None    # 右:feat > thresh
            steps_rev.append(("num", feat, lo, hi))
        current = parent["node_index"]

    return _merge_render_clauses(list(reversed(steps_rev)), cat_maps)


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

    rules: list[DecisionRule] = []
    for tree_idx, tree_str in enumerate(dump):
        rules.extend(_parse_xgb_tree(
            tree_str, overall_cvr, tree_idx,
            pred_leaves=pred_leaves, y_arr=y_arr, n_positives=n_positives,
            cat_maps=cat_maps))
    rules.sort(key=lambda r: r.predicted_cvr, reverse=True)
    return _dedup_rules(rules, top_n)


def _parse_xgb_tree(tree_str: str, overall_cvr: float, tree_idx: int = 0,
                    pred_leaves: np.ndarray | None = None,
                    y_arr: np.ndarray | None = None,
                    n_positives: int = 0,
                    cat_maps: dict[str, list] | None = None) -> list[DecisionRule]:
    """解析 XGBoost get_dump 文本树。

    切分语法（实测 xgboost 3.x，enable_categorical=True + tree_method="hist"）:
      数值:`[feat<thresh]`  yes ≡ feat < thresh,no ≡ feat >= thresh;
      分类:`[feat:{2,5,8}]` 花括号内为 category code 集合,yes ≡ 类别 ∈ 集合
           （沙箱实证:强正类别不在集合中时落 no 分支、叶值为正,方向与此一致）。
    fix19:DFS 收集结构化步骤,叶节点处交给 _merge_render_clauses 渲染 ——
    与 LightGBM 路径共用 __NA__→空值/IS NULL、NOT IN 补集改写、同特征合并逻辑。
    """
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
                thresh = float(thresh_str)
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
            node_info[node_id] = {"type": "split", "feat": feat, "thresh": thresh,
                                  "kind": kind, "yes": yes, "no": no, "depth": depth}

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
                path, sql_path = _merge_render_clauses(steps, cat_maps)
                rules.append(DecisionRule(
                    rule_text=" AND ".join(path) or "(root leaf)",
                    rule_sql=" AND ".join(sql_path),
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
                dfs(info["yes"], steps + [("cat", feat, names, True)])
                dfs(info["no"], steps + [("cat", feat, names, False)])
            elif 0 < thresh < _SENTINEL_EPS:
                # 哨兵切分（二值特征）：yes(<哨兵)≡<=0，no(>=哨兵)≡>0；源头消掉科学计数法
                dfs(info["yes"], steps + [("num", feat, None, (0.0, True))])
                dfs(info["no"], steps + [("num", feat, (0.0, False), None)])
            else:
                # XGBoost 数值切分 [feat<thresh]：yes=feat<thresh，no=feat>=thresh。
                # 必须是开上界/闭下界（`<`/`>=`），否则二值/计数特征产生 ">1" 这类空条件。
                dfs(info["yes"], steps + [("num", feat, None, (float(thresh), False))])
                dfs(info["no"], steps + [("num", feat, (float(thresh), True), None)])

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
      - n_rules_covered: 实际算了掩码的规则数(掩码解析失败/命中<10 的不计)

    fix20:top_n 默认改为 0 = 覆盖全部规则(原来只算前 5 条)。掩码运算只在验证集上做,
    10 条规则 45 对,开销可忽略;覆盖不全会让下游去冗对拿不到数据的规则失效。
    """
    # fix20:门槛原来硬写 "is_converted",而本函数算的是 target_col(可能是 is_paid)——
    # 目标列换成 is_paid 且数据里没有 is_converted 时,整个 O28 会被静默跳过。改为查真正用到的列。
    if not rules or target_col not in df.columns:
        return {}
    subset = rules if not top_n else rules[:top_n]
    masks, labels, idxs = [], [], []
    for ri, rule in enumerate(subset):
        try:
            m = _apply_rule_mask(df, rule.rule_text)
        except Exception:
            m = None
        if m is not None and m.sum() >= 10:
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
    return {
        "jaccard_matrix": matrix,
        "redundant_pairs": redundant,
        "complementary_pairs": complementary,
        "pairs": pairs,
        "n_rules_covered": len(masks),
    }


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
    rule_ovlp     = _rule_overlap(df_val, rules, target_col=effective_target)        # O28
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
