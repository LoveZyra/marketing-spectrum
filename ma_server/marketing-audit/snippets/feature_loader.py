"""特征注册表加载器 — 声明层与数据层之间的桥梁。

设计原则
========
所有分析 snippet 通过 FeatureLoader 访问字段，而非直接 df[col]。
新增或重命名特征时只需修改 feature_schema/feature_registry.yaml，
snippet 代码零修改。
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

try:
    import yaml
    _YAML_OK = True
except ImportError:
    _YAML_OK = False

logger = logging.getLogger(__name__)

_REGISTRY_PATH = Path(__file__).resolve().parent.parent / "feature_schema" / "feature_registry.yaml"


def _load_registry(path: Path | None = None) -> list[dict]:
    p = path or _REGISTRY_PATH
    if not _YAML_OK:
        raise ImportError("pyyaml 未安装，请执行: pip install pyyaml")
    with open(p, encoding="utf-8") as f:
        data = yaml.safe_load(f)
    return data.get("features", [])


class FeatureLoader:
    """从 feature_registry.yaml 驱动的特征访问层。

    用法
    ----
    loader = FeatureLoader(df)
    touch_cnt = loader.get("activity_touch_cnt")   # 安全取列，缺失返回 fallback 填充的 Series
    if loader.available("pre_mainflow_event_cnt", "activity_touch_cnt"):
        ...
    """

    def __init__(
        self,
        df: pd.DataFrame,
        registry_path: Path | str | None = None,
    ) -> None:
        self._df = df
        self._registry: list[dict] = _load_registry(
            Path(registry_path) if registry_path else None
        )
        # 构建快速索引
        self._meta: dict[str, dict] = {r["name"]: r for r in self._registry}
        # 检查缺失字段并记录
        self._missing: set[str] = {
            r["name"] for r in self._registry if r["name"] not in df.columns
        }
        self._present: set[str] = {
            r["name"] for r in self._registry if r["name"] in df.columns
        }
        if self._missing:
            logger.debug(
                "FeatureLoader: %d 个注册字段不在 df 中: %s",
                len(self._missing),
                sorted(self._missing)[:10],
            )

    # ── 基础访问 ─────────────────────────────────────────────────────────

    def get(self, name: str, default: Any = None) -> pd.Series:
        """安全取列。字段缺失时返回以 fallback 值填充的 Series。

        fallback 优先级：
          1. 调用方传入的 default 参数
          2. feature_registry.yaml 中该字段的 fallback 值
          3. np.nan（字段 fallback 为 null 时）
        """
        if name in self._df.columns:
            return self._df[name]
        meta = self._meta.get(name, {})
        fill = default if default is not None else meta.get("fallback")
        logger.debug("FeatureLoader.get: '%s' 字段缺失，返回填充值 %r", name, fill)
        return pd.Series(fill, index=self._df.index, name=name, dtype=object)

    def get_fillna(self, name: str) -> pd.Series:
        """取列并用注册的 fallback 值填充 NaN（字段存在时也做 fillna）。"""
        s = self.get(name)
        meta = self._meta.get(name, {})
        fallback = meta.get("fallback")
        if fallback is not None and s.isna().any():
            s = s.fillna(fallback)
        return s

    def available(self, *names: str) -> bool:
        """检查所有字段是否同时存在于 df。"""
        return all(n in self._df.columns for n in names)

    def any_available(self, *names: str) -> bool:
        """检查是否有任意一个字段存在于 df。"""
        return any(n in self._df.columns for n in names)

    # ── 字段集合查询 ─────────────────────────────────────────────────────

    def fields_for_dimension(self, dimension: str) -> list[str]:
        """返回某分析维度下所有已注册字段名（不区分 df 是否存在）。"""
        return [r["name"] for r in self._registry if r.get("dimension") == dimension]

    def present_fields_for_dimension(self, dimension: str) -> list[str]:
        """返回某分析维度下存在于 df 的字段名。"""
        return [
            r["name"]
            for r in self._registry
            if r.get("dimension") == dimension and r["name"] in self._df.columns
        ]

    def fields_for_rule(self, rule_id: int) -> list[str]:
        """返回某诊断规则关联的所有已注册字段名。"""
        return [
            r["name"]
            for r in self._registry
            if rule_id in r.get("diagnostic_rules", [])
        ]

    def threshold_fields(self) -> list[dict]:
        """返回所有需要计算阈值的字段及其方法配置。

        返回格式:
            [{"name": "field", "type": "count", "threshold_method": "optimal_split",
              "threshold_percentiles": [75, 90, 95]}, ...]
        """
        return [
            {
                "name": r["name"],
                "type": r.get("type"),
                "threshold_method": r.get("threshold_method", "none"),
                "threshold_percentiles": r.get("threshold_percentiles", [75, 90, 95]),
            }
            for r in self._registry
            if r.get("threshold_method", "none") != "none"
            and r["name"] in self._df.columns
        ]

    def fields_by_type(self, *types: str) -> list[str]:
        """返回指定类型的所有字段名（仅返回 df 中存在的）。"""
        return [
            r["name"]
            for r in self._registry
            if r.get("type") in types and r["name"] in self._df.columns
        ]

    # ── 元数据查询 ───────────────────────────────────────────────────────

    def meta(self, name: str) -> dict:
        """返回字段的注册元数据（字段不在注册表时返回空 dict）。"""
        return self._meta.get(name, {})

    def description(self, name: str) -> str:
        """返回字段的中文描述。"""
        return self._meta.get(name, {}).get("description", name)

    def fallback(self, name: str) -> Any:
        """返回字段的 fallback 值。"""
        return self._meta.get(name, {}).get("fallback")

    # ── 统计便利方法 ─────────────────────────────────────────────────────

    def safe_mean(self, name: str) -> float | None:
        """返回字段均值，字段缺失时返回 None。"""
        if name not in self._df.columns:
            return None
        try:
            return round(float(self._df[name].mean()), 4)
        except Exception:
            return None

    def safe_pct(self, name: str, top_n: int = 8) -> dict:
        """返回字段的 Top-N 值频率分布。"""
        if name not in self._df.columns:
            return {}
        try:
            d = self._df[name].value_counts(normalize=True).round(4).head(top_n).to_dict()
            return {str(k): v for k, v in d.items()}
        except Exception:
            return {}

    def safe_desc(self, name: str, pcts: tuple = (0.1, 0.25, 0.5, 0.75, 0.9)) -> dict:
        """返回字段的描述统计，NULL 单独统计不丢样本。"""
        if name not in self._df.columns:
            return {}
        total = len(self._df)
        s_raw = self._df[name]
        null_cnt = int(s_raw.isna().sum())
        s = s_raw.dropna()
        valid_cnt = len(s)
        result: dict = {
            "null_cnt": null_cnt,
            "null_rate": round(null_cnt / total, 4) if total else 0,
            "valid_cnt": valid_cnt,
        }
        if valid_cnt == 0:
            return result
        try:
            result["mean"] = round(float(s.mean()), 2)
            result["median"] = round(float(s.median()), 2)
            for p in pcts:
                result[f"p{int(p * 100)}"] = round(float(s.quantile(p)), 2)
        except Exception:
            pass
        return result

    def cvr_by(self, groupby_col: str, target: str = "is_converted", top_n: int = 8) -> list[dict]:
        """按 groupby_col 分组计算 CVR。"""
        if not self.available(groupby_col, target):
            return []
        try:
            g = (
                self._df.groupby(groupby_col)[target]
                .agg(["mean", "count"])
                .reset_index()
            )
            g.columns = [groupby_col, "cvr", "user_cnt"]
            g["cvr"] = g["cvr"].round(4)
            return g.sort_values("user_cnt", ascending=False).head(top_n).to_dict("records")
        except Exception:
            return []

    # ── 诊断辅助 ─────────────────────────────────────────────────────────

    @property
    def missing_fields(self) -> list[str]:
        """返回注册但 df 中缺失的字段列表。"""
        return sorted(self._missing)

    @property
    def present_fields(self) -> list[str]:
        """返回注册且 df 中存在的字段列表。"""
        return sorted(self._present)

    def coverage_report(self) -> dict:
        """返回字段覆盖率摘要，供 data_overview 使用。"""
        by_dim: dict[str, dict] = {}
        for r in self._registry:
            dim = r.get("dimension", "unknown")
            if dim not in by_dim:
                by_dim[dim] = {"total": 0, "present": 0}
            by_dim[dim]["total"] += 1
            if r["name"] in self._df.columns:
                by_dim[dim]["present"] += 1
        return {
            "total_registered": len(self._registry),
            "total_present": len(self._present),
            "coverage_rate": round(len(self._present) / max(len(self._registry), 1), 3),
            "by_dimension": {
                dim: {**v, "coverage": round(v["present"] / max(v["total"], 1), 3)}
                for dim, v in by_dim.items()
            },
        }
