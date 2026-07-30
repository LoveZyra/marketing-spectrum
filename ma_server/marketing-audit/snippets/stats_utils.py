"""统计推断工具函数。

为 6 维度诊断 snippet 提供统一的显著性检验与置信区间能力：
  - wilson_ci(p, n)            比例的 Wilson 区间（替代正态近似，小样本仍稳健）
  - chi2_test(table)           卡方独立性检验（列联表）
  - welch_t_test(a, b)         均值差异（Welch 修正，方差不等也可用）
  - bootstrap_ci(values, fn)   通用 bootstrap CI（统计量任意）
  - power_warning(n)           样本量警示文案

依赖：scipy（lightgbm/xgboost 会带入）；若环境无 scipy，chi2_test / welch_t_test
会返回 (nan, nan, nan) 并在 note 中标注；其余函数零外部依赖。
"""
from __future__ import annotations

import math
from typing import Callable, Iterable, Sequence

import numpy as np
import pandas as pd

try:
    from scipy import stats as _scipy_stats
    _HAS_SCIPY = True
except ImportError:
    _scipy_stats = None
    _HAS_SCIPY = False


_Z_95 = 1.959963984540054  # 双侧 alpha=0.05


def wilson_ci(p: float, n: int, alpha: float = 0.05) -> tuple[float, float]:
    """Wilson score 区间（比例的稳健 CI）。

    与正态近似 (p ± z*sqrt(p(1-p)/n)) 相比，Wilson 在 n 小、p 接近 0/1 时仍正确。
    返回 (low, high)，已 clip 到 [0, 1]。n<=0 时返回 (0.0, 1.0)。
    """
    if n is None or n <= 0:
        return 0.0, 1.0
    if p is None or math.isnan(p):
        return 0.0, 1.0
    p = max(0.0, min(1.0, float(p)))
    z = _Z_95 if abs(alpha - 0.05) < 1e-9 else _z_from_alpha(alpha)
    denom = 1.0 + z * z / n
    center = (p + z * z / (2 * n)) / denom
    margin = (z / denom) * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    low = max(0.0, center - margin)
    high = min(1.0, center + margin)
    return low, high


def chi2_test(table: Sequence[Sequence[int]] | pd.DataFrame) -> tuple[float, float, int]:
    """对列联表跑卡方独立性检验，返回 (chi2, p_value, dof)。

    table 形如 [[a, b], [c, d]] 或同形 DataFrame。任一行/列全 0、或 scipy 未安装时
    返回 (nan, nan, 0)。
    """
    if not _HAS_SCIPY:
        return float("nan"), float("nan"), 0
    arr = np.asarray(table, dtype=float)
    if arr.ndim != 2 or arr.size == 0:
        return float("nan"), float("nan"), 0
    if (arr.sum(axis=0) == 0).any() or (arr.sum(axis=1) == 0).any():
        return float("nan"), float("nan"), 0
    chi2, p, dof, _ = _scipy_stats.chi2_contingency(arr)
    return float(chi2), float(p), int(dof)


def welch_t_test(a: Iterable[float], b: Iterable[float]) -> tuple[float, float, float]:
    """Welch's t-test（不假设两组方差相等）。

    返回 (t_stat, p_value, df)。两组样本量 < 2、方差均为 0、或 scipy 未安装时
    返回 (nan, nan, nan)。
    """
    if not _HAS_SCIPY:
        return float("nan"), float("nan"), float("nan")
    a_arr = np.asarray(list(a), dtype=float)
    b_arr = np.asarray(list(b), dtype=float)
    a_arr = a_arr[~np.isnan(a_arr)]
    b_arr = b_arr[~np.isnan(b_arr)]
    if len(a_arr) < 2 or len(b_arr) < 2:
        return float("nan"), float("nan"), float("nan")
    if np.var(a_arr) == 0 and np.var(b_arr) == 0:
        return float("nan"), float("nan"), float("nan")
    res = _scipy_stats.ttest_ind(a_arr, b_arr, equal_var=False)
    df = _welch_df(a_arr, b_arr)
    return float(res.statistic), float(res.pvalue), float(df)


def bootstrap_ci(
    values: Sequence[float],
    stat_fn: Callable[[np.ndarray], float] = np.mean,
    n_boot: int = 1000,
    alpha: float = 0.05,
    seed: int = 42,
) -> tuple[float, float]:
    """通用 bootstrap 百分位 CI。

    对 values 做 n_boot 次有放回重采样，每次计算 stat_fn，取 [alpha/2, 1-alpha/2]
    分位数作为 CI。len(values) < 2 时返回 (nan, nan)。
    """
    arr = np.asarray(values, dtype=float)
    arr = arr[~np.isnan(arr)]
    if len(arr) < 2:
        return float("nan"), float("nan")
    rng = np.random.default_rng(seed)
    n = len(arr)
    boots = np.empty(n_boot, dtype=float)
    for i in range(n_boot):
        sample = arr[rng.integers(0, n, n)]
        boots[i] = stat_fn(sample)
    low = float(np.quantile(boots, alpha / 2))
    high = float(np.quantile(boots, 1 - alpha / 2))
    return low, high


def power_warning(n: int, min_n: int = 30) -> str | None:
    """样本量分级警示。返回供 finding.detail 直接拼接的中文短语，或 None。"""
    if n is None or n < 0:
        return None
    if n < min_n:
        return f"样本量过小 (n={n}<{min_n})，结论仅作方向参考"
    if n < 100:
        return f"样本量偏小 (n={n})，置信度建议 ≤0.7"
    return None


def severity_from_pvalue(severity: str, p_value: float | None, alpha: float = 0.05) -> str:
    """统计显著性判定的统一降级规则：p_value 不显著时把 severity 降一级。

    用法：在维度判定阶段，先按业务阈值定 severity，再调用本函数据 p_value 复核。
    p_value 为 None / nan 时保持原 severity（无法判定）。
    """
    if p_value is None or (isinstance(p_value, float) and math.isnan(p_value)):
        return severity
    if p_value <= alpha:
        return severity
    if severity == "high":
        return "mid"
    if severity == "mid":
        return "low"
    return severity


def distribution_shape(values: Iterable[float], long_tail_ratio: float = 5.0) -> dict:
    """单序列的分布形状描述。

    返回 dict（可 JSON 序列化）：
      n, mean, p25, p50, p75, p99, iqr, is_long_tail (p99/p50 > long_tail_ratio),
      is_multimodal (KDE 双峰简化检测；样本 < 50 或 scipy 不可用时为 None)

    用于替代单一 mean，揭示长尾、双峰等隐藏结构。
    """
    arr = np.asarray(list(values), dtype=float)
    arr = arr[~np.isnan(arr)]
    n = int(len(arr))
    if n == 0:
        return {"n": 0, "mean": None, "p25": None, "p50": None, "p75": None,
                "p99": None, "iqr": None, "is_long_tail": None, "is_multimodal": None}
    p25, p50, p75, p99 = (
        float(np.quantile(arr, 0.25)),
        float(np.quantile(arr, 0.5)),
        float(np.quantile(arr, 0.75)),
        float(np.quantile(arr, 0.99)),
    )
    iqr = p75 - p25
    is_long_tail = bool(p99 > long_tail_ratio * p50) if p50 > 0 else None
    is_multimodal = _detect_multimodal(arr) if n >= 50 else None
    return {
        "n": n,
        "mean": float(np.mean(arr)),
        "p25": p25, "p50": p50, "p75": p75, "p99": p99,
        "iqr": float(iqr),
        "is_long_tail": is_long_tail,
        "is_multimodal": is_multimodal,
    }


def _detect_multimodal(arr: np.ndarray) -> bool | None:
    """KDE 双峰简化检测：找出 KDE 曲线上的局部极大值个数。

    scipy 不可用或方差为 0 时返回 None；否则返回是否检测到 >=2 个峰。
    """
    if not _HAS_SCIPY or np.var(arr) == 0:
        return None
    try:
        kde = _scipy_stats.gaussian_kde(arr)
    except Exception:
        return None
    lo, hi = float(np.min(arr)), float(np.max(arr))
    if hi == lo:
        return False
    grid = np.linspace(lo, hi, 200)
    y = kde(grid)
    # 找局部极大：y[i] > y[i-1] 且 y[i] > y[i+1]
    peaks = (y[1:-1] > y[:-2]) & (y[1:-1] > y[2:])
    # 只保留显著峰：> 0.3 * y_max
    threshold = 0.3 * float(np.max(y))
    significant_peaks = int(np.sum(peaks & (y[1:-1] > threshold)))
    return significant_peaks >= 2


# ── 内部辅助 ──────────────────────────────────────────────────────────


def _z_from_alpha(alpha: float) -> float:
    if not _HAS_SCIPY:
        return _Z_95
    return float(_scipy_stats.norm.ppf(1 - alpha / 2))


def _welch_df(a: np.ndarray, b: np.ndarray) -> float:
    va, vb = np.var(a, ddof=1), np.var(b, ddof=1)
    na, nb = len(a), len(b)
    if va == 0 and vb == 0:
        return float("nan")
    num = (va / na + vb / nb) ** 2
    denom = (va / na) ** 2 / (na - 1) + (vb / nb) ** 2 / (nb - 1)
    return num / denom if denom > 0 else float("nan")
