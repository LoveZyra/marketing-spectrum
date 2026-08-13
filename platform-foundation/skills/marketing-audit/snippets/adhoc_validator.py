"""Ad-hoc 工具规格 / AST / 输出三类校验（methodology/07_adhoc_tools.md 配套）。

提供给 `adhoc_runner.py` 复用；也可独立调用（如在 PROPOSE 阶段先做静态检查）。
"""
from __future__ import annotations

import ast
from typing import Any

ALLOWED_IMPORTS = {
    "pandas", "numpy", "scipy", "math", "statistics",
    "itertools", "collections",
}
FORBIDDEN_NAMES = {
    "open", "exec", "eval", "__import__", "compile",
    "globals", "locals", "vars", "input", "breakpoint",
}
FORBIDDEN_MODULES = {
    "os", "sys", "subprocess", "socket", "shutil", "pathlib",
    "requests", "urllib", "http", "ftplib", "ctypes", "multiprocessing",
}

REQUIRED_SPEC_FIELDS = (
    "name", "purpose", "created_for_hypothesis",
    "input_columns", "output_schema", "code", "validation_checks",
)
MAX_ROWS = 1000
MAX_CODE_LEN = 8_000


def validate_spec(spec: dict[str, Any]) -> list[str]:
    """检查 spec 强制字段。返回 errors 列表（空表示通过）。"""
    errs: list[str] = []
    if not isinstance(spec, dict):
        return ["spec 必须是 dict"]
    for f in REQUIRED_SPEC_FIELDS:
        if f not in spec or spec[f] in (None, ""):
            errs.append(f"missing required field: {f}")
    if "code" in spec and isinstance(spec["code"], str) and len(spec["code"]) > MAX_CODE_LEN:
        errs.append(f"code length {len(spec['code'])} exceeds {MAX_CODE_LEN}")
    if "input_columns" in spec and not isinstance(spec["input_columns"], list):
        errs.append("input_columns 必须是 list")
    if "validation_checks" in spec and not isinstance(spec["validation_checks"], list):
        errs.append("validation_checks 必须是 list")
    if "validation_checks" in spec and isinstance(spec["validation_checks"], list) and len(spec["validation_checks"]) == 0:
        errs.append("validation_checks 至少需要 1 条 boolean 表达式")
    if "name" in spec and isinstance(spec["name"], str):
        if len(spec["name"]) > 60 or " " in spec["name"]:
            errs.append("name 应为 snake_case 短名 (≤60 字, 无空格)")
    return errs


def validate_ast(code: str) -> list[str]:
    """静态 AST 检查：禁用 import / name / dunder 访问。"""
    issues: list[str] = []
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        return [f"syntax error: {e.msg} at line {e.lineno}"]

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for n in node.names:
                root = n.name.split(".")[0]
                if root in FORBIDDEN_MODULES:
                    issues.append(f"forbidden import: {n.name}")
                elif root not in ALLOWED_IMPORTS:
                    issues.append(f"disallowed import: {n.name}")
        elif isinstance(node, ast.ImportFrom):
            mod = (node.module or "").split(".")[0]
            if mod in FORBIDDEN_MODULES:
                issues.append(f"forbidden import: from {node.module}")
            elif mod and mod not in ALLOWED_IMPORTS:
                issues.append(f"disallowed import: from {node.module}")
        elif isinstance(node, ast.Name) and node.id in FORBIDDEN_NAMES:
            issues.append(f"disallowed name: {node.id}")
        elif isinstance(node, ast.Attribute):
            if node.attr.startswith("__") and node.attr.endswith("__"):
                issues.append(f"disallowed dunder access: .{node.attr}")
        elif isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Name) and func.id in FORBIDDEN_NAMES:
                issues.append(f"disallowed call: {func.id}(...)")
    return issues


def validate_schema(spec: dict, df_columns: list[str]) -> list[str]:
    """schema_check：input_columns 必须全部存在于 df.columns。"""
    cols = set(df_columns)
    missing = [c for c in spec.get("input_columns", []) if c not in cols]
    if missing:
        return [f"missing columns: {missing}"]
    return []


def validate_output(result: Any) -> tuple[list[str], list[dict] | None]:
    """output_check：结果必须是 DataFrame 或 dict；行数 ≤ MAX_ROWS。

    返回 (errors, records)；records 为 list[dict] 形态，便于序列化。
    """
    import pandas as pd
    if isinstance(result, pd.DataFrame):
        if len(result) > MAX_ROWS:
            result = result.head(MAX_ROWS)
        try:
            records = result.to_dict("records")
        except Exception as e:
            return [f"to_dict failed: {e!r}"], None
        return [], records
    if isinstance(result, dict):
        return [], [result]
    return [f"result must be DataFrame or dict, got {type(result).__name__}"], None


def run_checks(spec: dict, df, result) -> list[str]:
    """跑 spec.validation_checks 中的所有 boolean 表达式。"""
    import numpy as np
    import pandas as pd
    issues: list[str] = []
    safe_globals = {"__builtins__": _safe_builtins()}
    safe_locals = {"df": df, "result": result, "np": np, "pd": pd}
    for check_expr in spec.get("validation_checks", []) or []:
        try:
            ok = eval(check_expr, safe_globals, safe_locals)
        except Exception as e:
            issues.append(f"check eval failed: {check_expr!r}: {e!r}")
            continue
        if not ok:
            issues.append(f"check failed: {check_expr}")
    return issues


def _safe_builtins() -> dict:
    safe_names = {
        "len", "min", "max", "sum", "abs", "round", "sorted", "range",
        "list", "dict", "tuple", "set", "frozenset", "int", "float",
        "str", "bool", "bytes", "isinstance", "enumerate", "zip", "map",
        "filter", "any", "all", "reversed", "True", "False", "None",
    }
    import builtins
    return {k: getattr(builtins, k) for k in safe_names if hasattr(builtins, k)}
