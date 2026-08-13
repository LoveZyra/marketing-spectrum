"""数据驱动阈值计算器。

核心原则
========
所有阈值由数据的创单率/成单率（CVR）决定，而非人工配置。
具体流程：
  1. 对每个需要阈值的字段，按分位数或固定分桶将其分组
  2. 计算每组的 CVR（is_converted 均值）
  3. 找 CVR 变化最显著的切分点（Youden's J / 最大 CVR 差），作为该字段的 'optimal' 阈值
  4. 同时输出各分位数（p25/p50/p75/p90/p95）供参考，但诊断规则应优先使用 'optimal'

不依赖 thresholds.yaml 中任何硬编码值。
"""
from __future__ import annotations

import logging
import warnings
from typing import Any

import numpy as np
import pandas as pd

from .feature_loader import FeatureLoader

logger = logging.getLogger(__name__)

# 分桶粒度：用于分位数分桶的候选分位点数量
_N_QUANTILE_CUTS = 20


def _numeric(series: "pd.Series") -> "pd.Series":
    """把阈值字段强制转为数值型，稳健处理"N+"分桶（如 360d_create_order_count 的 "5+"、
    order_pc/visit_days 等 V2.1 上限分桶字段）。否则 object 列进入 np.percentile/qcut 会触发
    "unsupported operand -: 'str' and 'str'"。策略：去掉首个非数字字符及其之后（"5+"→"5"），
    再 to_numeric；纯非数值列整体变 NaN，由分位数/CVR 计算自动排除并走 fallback。"""
    if pd.api.types.is_numeric_dtype(series):
        return series
    s = series.astype(str).str.replace(r"(?<=\d)[^\d.].*$", "", regex=True).str.strip()
    return pd.to_numeric(s, errors="coerce")


def _percentile_buckets(series: pd.Series, n_cuts: int = _N_QUANTILE_CUTS) -> pd.Series:
    """将连续特征按分位数均匀分桶，返回分桶标签 Series。

    当特征唯一值少于 n_cuts 时，直接按原值分桶。
    """
    uniq = series.dropna().nunique()
    if uniq <= n_cuts:
        return series.astype(str)
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            return pd.qcut(series, q=n_cuts, duplicates="drop", retbins=False).astype(str)
    except Exception:
        # 分桶失败（如全为同一值），退回原值
        return series.astype(str)


def _youden_optimal_split(
    series: pd.Series,
    target: pd.Series,
    candidate_quantiles: tuple = (0.05, 0.1, 0.2, 0.25, 0.3, 0.4, 0.5,
                                   0.6, 0.7, 0.75, 0.8, 0.9, 0.95),
) -> dict:
    """在连续/离散有序特征上，通过遍历候选切分点找 CVR 拐点。

    拐点判据：切分点两侧 CVR 差值最大（类 Youden's J，无需二分类假设）。

    Args:
        series  : 特征值（数值型，允许 NaN，NaN 行排除在计算之外）
        target  : 转化标签（0/1），与 series 同 index

    Returns:
        dict 包含：
          optimal      : 最优切分阈值（feature value）
          cvr_below    : 切分点以下的 CVR
          cvr_above    : 切分点以上的 CVR
          cvr_gap      : 两侧 CVR 差值
          n_below      : 切分点以下行数
          n_above      : 切分点以上行数
          cvr_profile  : 各候选切分点的 CVR 对比表（list of dict）
          method       : "youden_split"
    """
    mask = series.notna() & target.notna()
    s = series[mask]
    t = target[mask]
    n_total = len(s)

    if n_total < 30:
        return _fallback_to_percentile(series, tag="sample_too_small")

    overall_cvr = float(t.mean())

    # fix18(2026-08-04)等价改写:原实现对每个候选切分点反复全列扫描 ——
    # 13 次 quantile(每次 O(n))+ 候选过滤每个 2 次全列扫 + 主循环每 cut 一次布尔
    # 掩码与两次 fancy-index 整列拷贝,合计每字段 ~90 趟 O(n);5.9M 行 × 几十个阈值
    # 字段实测 compute-thresholds 要 17-30 分钟。改为:一次 argsort + 目标列前缀和,
    # 之后"严格小于 cut 的行数"= searchsorted(side='left'),两侧转化和 = 前缀和查表,
    # 每候选 O(log n)。结果与原实现逐位一致:searchsorted(left) ≡ (s<cut).sum();
    # 目标取值 0/1 时前缀和是精确整数,CVR = 整数/整数,与 fancy-index 后 .mean()
    # 完全相同;np.quantile 与 pandas Series.quantile 同为线性插值,数值一致。
    s_arr = s.to_numpy(dtype=float)
    order = np.argsort(s_arr)
    s_sorted = s_arr[order]
    t_prefix = np.cumsum(t.to_numpy(dtype=float)[order])
    total_conv = float(t_prefix[-1])

    def _n_below(cut: float) -> int:
        return int(np.searchsorted(s_sorted, cut, side="left"))

    # 候选切分点取分位数值（去重）。一次向量化调用算全部 13 个分位数
    # (numpy 对多分位点单趟 partition),数值与逐个调用完全相同。
    _qvals = np.quantile(s_sorted, list(candidate_quantiles))
    candidates = sorted(set(float(v) for v in _qvals))
    # 过滤掉边界值（不能将所有样本划入一侧）
    candidates = [c for c in candidates
                  if _n_below(c) >= 10 and (n_total - _n_below(c)) >= 10]

    if not candidates:
        return _fallback_to_percentile(series, tag="no_valid_candidates")

    best: dict[str, Any] = {"cvr_gap": -1.0}
    profile: list[dict] = []

    for cut in candidates:
        n_b = _n_below(cut)
        n_a = n_total - n_b
        if n_b < 5 or n_a < 5:
            continue
        conv_b = float(t_prefix[n_b - 1])
        cvr_b = conv_b / n_b
        cvr_a = (total_conv - conv_b) / n_a
        gap = abs(cvr_a - cvr_b)
        profile.append({
            "threshold": round(cut, 4),
            "n_below": n_b, "cvr_below": round(cvr_b, 4),
            "n_above": n_a, "cvr_above": round(cvr_a, 4),
            "cvr_gap": round(gap, 4),
        })
        if gap > best.get("cvr_gap", -1.0):
            best = {
                "optimal": round(cut, 4),
                "cvr_below": round(cvr_b, 4),
                "cvr_above": round(cvr_a, 4),
                "cvr_gap": round(gap, 4),
                "n_below": n_b,
                "n_above": n_a,
                "overall_cvr": round(overall_cvr, 4),
                "n_total": n_total,
                "method": "youden_split",
            }

    if best.get("cvr_gap", -1.0) <= 0:
        return _fallback_to_percentile(series, tag="no_cvr_gap")

    best["cvr_profile"] = sorted(profile, key=lambda x: x["threshold"])
    return best


def _fallback_to_percentile(series: pd.Series, tag: str = "") -> dict:
    """当 CVR 最优切分不可用时，退回到 p75 分位数作为阈值，并标注原因。"""
    s = series.dropna()
    if len(s) == 0:
        return {"optimal": None, "method": f"empty_series|{tag}"}
    p75 = float(np.percentile(s, 75))
    return {
        "optimal": round(p75, 4),
        "n_total": len(s),
        "method": f"percentile_p75_fallback|{tag}",
        "note": "CVR 最优切分不可用，退回 p75 分位数",
    }


def _compute_percentiles(series: pd.Series, percentiles: list[int]) -> dict:
    """计算指定分位数，返回 {p25: val, p50: val, ...}。

    fix18:一次向量化 np.percentile 调用算全部分位点(原来逐个调用,每次 O(n));
    数值与逐个调用完全相同。整体失败时退回逐个调用,保持原有的单点容错语义。"""
    s = series.dropna()
    if len(s) == 0:
        return {}
    try:
        vals = np.percentile(s, list(percentiles))
        return {f"p{p}": round(float(v), 4) for p, v in zip(percentiles, vals)}
    except Exception:
        result = {}
        for p in percentiles:
            try:
                result[f"p{p}"] = round(float(np.percentile(s, p)), 4)
            except Exception:
                pass
        return result


def _compute_cvr_profile_by_bucket(
    series: pd.Series,
    target: pd.Series,
    bucket_method: str = "percentile",
) -> list[dict]:
    """按分桶计算每桶的 CVR 分布，用于可视化阈值合理性。

    Args:
        bucket_method: "percentile"（分位数分桶）或 "value"（按唯一值分桶）
    """
    # fix18(2026-08-04)等价改写:原实现的 astype(str) 会把整列物化成 Python 字符串
    # (200 万行 ≈ 数秒),groupby(...).groups 再逐桶 fancy-index 拷贝 —— 单字段实测
    # 5.2s,是 compute-thresholds 的第一大耗时。改为 factorize/codes + bincount:
    # 每桶行数与转化和一趟算完。分组键、标签字符串与行序均按原实现逐分支复刻
    # (原值分支按数值升序;字符串分支按字典序 —— 与 groupby 对键排序的行为一致),
    # 目标列 0/1 时 bincount 加权和为精确整数,输出与原实现逐位相同。
    mask = series.notna() & target.notna()
    s = series[mask]
    t = target[mask]
    if len(s) < 10:
        return []

    t_arr = t.to_numpy(dtype=float)

    def _rows_from_codes(codes, labels, order):
        n_grp = np.bincount(codes, minlength=len(labels))
        conv = np.bincount(codes, weights=t_arr, minlength=len(labels))
        rows = []
        for i in order:
            n = int(n_grp[i])
            if n < 3:
                continue
            rows.append({
                "bucket": labels[i],
                "n": n,
                "cvr": round(float(conv[i]) / n, 4),
            })
        return rows

    nu = s.nunique()
    if bucket_method == "value" or nu <= 10:
        # 原实现按原值 groupby:键为数值、升序;标签 = str(值)
        codes, uniques = pd.factorize(s, sort=True)
        labels = [str(u) for u in uniques]
        return _rows_from_codes(codes, labels, range(len(labels)))

    if nu <= _N_QUANTILE_CUTS:
        # 原 _percentile_buckets 低基数分支:astype(str) 后按字符串字典序分组
        codes, uniques = pd.factorize(s, sort=True)
        labels = [str(u) for u in uniques]
        order = sorted(range(len(labels)), key=lambda i: labels[i])
        return _rows_from_codes(codes, labels, order)

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            cat = pd.qcut(s, q=_N_QUANTILE_CUTS, duplicates="drop", retbins=False)
    except Exception:
        # 原 _percentile_buckets 失败分支:退回原值字符串(字典序)
        codes, uniques = pd.factorize(s, sort=True)
        labels = [str(u) for u in uniques]
        order = sorted(range(len(labels)), key=lambda i: labels[i])
        return _rows_from_codes(codes, labels, order)

    codes = cat.cat.codes.to_numpy()
    labels = [str(iv) for iv in cat.cat.categories]
    order = sorted(range(len(labels)), key=lambda i: labels[i])
    return _rows_from_codes(codes, labels, order)


def compute_adaptive_thresholds(
    df: pd.DataFrame,
    loader: FeatureLoader,
    target_col: str = "is_converted",
    eval_col: str | None = None,
) -> dict[str, dict]:
    """计算所有需要阈值字段的数据驱动阈值。

    所有阈值由各字段分组后的创单率/成单率（CVR）决定：
    - 对数值型字段：遍历分位数候选切分点，找使切分点两侧 CVR 差值最大的那个值
    - 同时记录 p25/p50/p75/p90/p95 供参考，但诊断规则使用 'optimal' 字段
    - 样本量不足或无 CVR 变化时，退回到 p75 分位数并标注原因

    Args:
        df         : 用户-活动宽表（tmp_ctj_mktv2_final 粒度）
        loader     : FeatureLoader 实例
        target_col : 转化标签列名（默认 is_converted；也可传 is_paid）

    Returns:
        {
          "activity_touch_cnt": {
            "optimal": 3.0,        # 核心：诊断规则使用此值
            "cvr_below": 0.05,     # 阈值以下的 CVR
            "cvr_above": 0.02,     # 阈值以上的 CVR（通常 CVR 下降说明过度触达）
            "cvr_gap": 0.03,
            "n_below": 8000, "n_above": 2000,
            "n_total": 10000,
            "method": "youden_split",
            "cvr_profile": [...],  # 各候选切分点的 CVR 对比表
            "p25": 1.0, "p50": 1.0, "p75": 2.0, "p90": 3.0, "p95": 4.0,
            "overall_cvr": 0.04,
          },
          ...
        }
    """
    has_target = target_col in df.columns
    target = df[target_col] if has_target else None
    # 展示口径（默认成单率 is_paid）：切分点在 target_col（创单率）上找，但同时按 eval_col
    # 重算两侧 CVR，供正向机会等卡片以成单率展示。
    has_eval = bool(eval_col) and eval_col in df.columns and eval_col != target_col

    thresholds: dict[str, dict] = {}
    fields = loader.threshold_fields()

    if not has_target:
        logger.warning(
            "threshold_computer: '%s' 列不存在，所有字段退回分位数阈值", target_col
        )

    for fmeta in fields:
        name = fmeta["name"]
        series = _numeric(df[name])
        # fix18:dropna/nunique/notna 每字段只算一次(原实现在本循环内重复算 3-4 次,
        # 每次都是整列拷贝+扫描,千万行级下每字段白花数百 ms)。语义完全等价。
        _n_unique = series.dropna().nunique()
        _n_valid = int(series.notna().sum())

        # 计算参考分位数（始终计算，不依赖 CVR）
        pct_list = fmeta.get("threshold_percentiles") or [25, 50, 75, 90, 95]
        pct_vals = _compute_percentiles(series, pct_list)

        if not has_target or _n_unique < 2:
            # 无法计算 CVR，直接退回分位数
            result = _fallback_to_percentile(series, tag="no_target_or_no_variance")
        else:
            result = _youden_optimal_split(series, target)

        # 附加分位数值和字段元信息
        result.update(pct_vals)
        result["field"] = name
        result["field_type"] = fmeta.get("type", "unknown")

        # signal_quality：区分零方差/无CVR区分性/有效阈值三种情况
        method = result.get("method", "")
        n_unique = _n_unique
        if n_unique < 2:
            result["signal_quality"] = "structural_zero_variance"  # 渠道/活动特性导致全量相同
        elif method.startswith("percentile_p75_fallback"):
            result["signal_quality"] = "no_cvr_signal"             # 有方差但CVR无区分性
        else:
            result["signal_quality"] = "threshold_found"           # 找到有效CVR切分点

        # CVR 分桶分布（用于 thresholds_report.md 可读性）
        if has_target and _n_valid >= 10:
            result["cvr_by_bucket"] = _compute_cvr_profile_by_bucket(
                series, target,
                bucket_method="value" if fmeta.get("type") in ("binary", "ordinal") else "percentile",
            )

        # 异常值检测：count/ordinal 类型，p99 >> IQR 时标注
        if fmeta.get("type") in ("count", "ordinal") and _n_valid >= 10:
            p25 = result.get("p25")
            p75 = result.get("p75")
            p99 = float(series.quantile(0.99)) if _n_valid >= 10 else None
            if p25 is not None and p75 is not None and p99 is not None:
                iqr = float(p75) - float(p25)
                if iqr > 0 and p99 > float(p25) + 10 * iqr:
                    result["has_outlier"] = True
                    result["outlier_note"] = (
                        f"p99={p99:.0f} >> IQR={iqr:.0f}（p25={p25}, p75={p75}），"
                        f"建议排查数据上报是否存在异常大值"
                    )

        # 展示口径（eval_col，成单率）：在 target_col 找到的最优切分点上重算两侧 eval CVR
        opt = result.get("optimal")
        if has_eval and opt is not None and result.get("signal_quality") == "threshold_found":
            ev = df[eval_col]
            m = series.notna() & ev.notna()
            below = m & (series < opt)
            above = m & (series >= opt)
            nb, na = int(below.sum()), int(above.sum())
            if nb > 0 and na > 0:
                cvr_b_eval = float(ev[below].mean())
                cvr_a_eval = float(ev[above].mean())
                result["cvr_below_eval"] = round(cvr_b_eval, 4)
                result["cvr_above_eval"] = round(cvr_a_eval, 4)
                result["cvr_gap_eval"] = round(cvr_a_eval - cvr_b_eval, 4)
                result["eval_col"] = eval_col

        thresholds[name] = result
        logger.debug(
            "threshold_computer: %s → optimal=%.4f method=%s",
            name,
            result.get("optimal") or float("nan"),
            result.get("method", "?"),
        )

    return thresholds


def generate_thresholds_report(thresholds: dict[str, dict]) -> str:
    """生成可读的阈值报告 Markdown 文本，供 Agent 参考。

    输出格式示例：
    ## activity_touch_cnt
    - **阈值（optimal）**: 3.0
    - **计算方法**: youden_split
    - **阈值以下 CVR**: 5.00%（n=8000）
    - **阈值以上 CVR**: 2.00%（n=2000）
    - **CVR 差值**: 3.00pp
    - **参考分位数**: p25=1.0, p50=1.0, p75=2.0, p90=3.0, p95=4.0
    """
    lines = ["# 自适应阈值报告\n",
             "> 所有阈值均由活动数据中各特征分组后的创单率/成单率（CVR）决定。\n"]

    # ── 最具区分度字段 TOP（让最强正/负向阈值信号一眼可见）──
    # 42 条规则未必覆盖最强信号（如机票浏览深度→CVR 跃升），此处按 |CVR差| 排序，
    # 供宿主 Agent 直接引用为 narratives 证据，避免强信号被埋在逐字段明细里。
    ranked = []
    for field, info in thresholds.items():
        if info.get("signal_quality") != "threshold_found":
            continue
        gap = info.get("cvr_gap")
        if gap is None:
            continue
        ranked.append((abs(float(gap)), field, info))
    ranked.sort(reverse=True)
    # A3：折叠共线/别名字段——切分签名（低值组CVR/高值组CVR/阈值）相同视为同一信号，
    # 仅保留 |gap| 最大的一行并注明"另有 N 个共线字段"，避免 TOP 表被同一信号刷屏。
    deduped: list = []           # 每项 [extra_collinear, field, info]
    _sig_index: dict = {}
    for _absgap, field, info in ranked:
        sig = (round(float(info.get("cvr_below") or 0), 4),
               round(float(info.get("cvr_above") or 0), 4),
               info.get("optimal"))
        if sig in _sig_index:
            deduped[_sig_index[sig]][0] += 1
            continue
        _sig_index[sig] = len(deduped)
        deduped.append([0, field, info])
    if deduped:
        lines.append("\n## 最具区分度字段 TOP（按 |CVR差| 排序，已折叠共线字段）\n")
        lines.append("> ⭐ 方向＝正向：高值组 CVR 更高（优质人群，可定向/扩量）；方向＝负向：高值组 CVR 更低（抑制因素，应排除/降权）。带 ⚠️ 的字段受异常值影响，置信度降低。\n")
        lines.append("| 字段 | 阈值 | 低值组CVR | 高值组CVR | CVR差 | 方向 | 备注 |")
        lines.append("|---|---:|---:|---:|---:|:---:|---|")
        for extra, field, info in deduped[:12]:
            cvr_b = info.get("cvr_below", 0) or 0
            cvr_a = info.get("cvr_above", 0) or 0
            # 显示差值 = 高值组 − 低值组，符号与方向一致（stored cvr_gap 为绝对值）
            disp_gap = cvr_a - cvr_b
            direction = "🟩 正向" if cvr_a > cvr_b else "🔻 负向"
            note_parts = []
            if info.get("has_outlier"):
                note_parts.append("⚠️ 异常值")
            if extra:
                note_parts.append(f"另有{extra}个共线字段")
            note = "；".join(note_parts)
            lines.append(
                f"| {field} | {info.get('optimal')} | {cvr_b*100:.2f}% | {cvr_a*100:.2f}% "
                f"| {disp_gap*100:+.2f}pp | {direction} | {note} |"
            )
        lines.append("")

    for field, info in sorted(thresholds.items()):
        lines.append(f"\n## {field}")
        optimal = info.get("optimal")
        lines.append(f"- **阈值（optimal）**: {optimal}")
        lines.append(f"- **计算方法**: {info.get('method', '?')}")

        if "cvr_below" in info and "cvr_above" in info:
            n_b = info.get("n_below", "?")
            n_a = info.get("n_above", "?")
            cvr_b = info.get("cvr_below", 0)
            cvr_a = info.get("cvr_above", 0)
            lines.append(f"- **阈值以下 CVR**: {cvr_b*100:.2f}%（n={n_b}）")
            lines.append(f"- **阈值以上 CVR**: {cvr_a*100:.2f}%（n={n_a}）")
            lines.append(f"- **CVR 差值**: {info.get('cvr_gap', 0)*100:.2f}pp")

        if "note" in info:
            lines.append(f"- **备注**: {info['note']}")
        if info.get("has_outlier"):
            lines.append(f"- **⚠️ 异常值警告**: {info['outlier_note']}")

        # 参考分位数
        pct_parts = []
        for p in [10, 25, 50, 75, 90, 95]:
            key = f"p{p}"
            if key in info:
                pct_parts.append(f"{key}={info[key]}")
        if pct_parts:
            lines.append(f"- **参考分位数**: {', '.join(pct_parts)}")

        # CVR 分桶详情（折叠显示）
        profile = info.get("cvr_profile") or info.get("cvr_by_bucket")
        if profile:
            lines.append("<details><summary>CVR 分桶详情</summary>\n")
            lines.append("| 分桶/切分点 | 样本量 | CVR |")
            lines.append("|---|---:|---:|")
            for row in profile[:15]:  # 最多显示 15 行
                bucket = row.get("threshold") or row.get("bucket", "?")
                n = row.get("n") or (row.get("n_below", "") if "n_below" in row else "?")
                cvr_val = row.get("cvr") or row.get("cvr_below", "?")
                cvr_str = f"{cvr_val*100:.2f}%" if isinstance(cvr_val, (int, float)) else str(cvr_val)
                lines.append(f"| {bucket} | {n} | {cvr_str} |")
            lines.append("</details>")

    return "\n".join(lines)
