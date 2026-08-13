"""Ad-hoc 临时工具沙箱执行器（methodology/07_adhoc_tools.md 配套）。

入口：
    run_adhoc(spec, df, timeout_s=30)   → run_result dict
    attach_evidence(state, spec, run_result, hypothesis_id=None) → ev_id

run_adhoc 内部依次跑：spec validate → ast check → schema check → execute → output check → run validation_checks。
任一失败 → status=failed，附 stage 与 errors。
"""
from __future__ import annotations

import hashlib
import time
import uuid
from typing import TYPE_CHECKING, Any

from . import adhoc_validator as av

if TYPE_CHECKING:
    import pandas as pd


def run_adhoc(spec: dict[str, Any], df: "pd.DataFrame", timeout_s: int = 30) -> dict[str, Any]:
    """沙箱执行一条 ad-hoc 工具规格。

    返回:
        {"status": "validated" | "failed",
         "stage": "spec_check"|"ast_check"|"schema_check"|"execute"|"output_check"|"validation"|None,
         "code_hash": str | None,
         "elapsed_ms": int,
         "n_rows": int | None,
         "records": list[dict] | None,
         "errors": list[str] | None,
         "fallback_hint": str | None}
    """
    t0 = time.time()
    code = spec.get("code", "") if isinstance(spec, dict) else ""
    code_hash = hashlib.sha256(code.encode("utf-8")).hexdigest()[:12] if code else None

    # 1) spec
    errs = av.validate_spec(spec)
    if errs:
        return _fail("spec_check", errs, code_hash, t0)

    # 2) AST
    errs = av.validate_ast(code)
    if errs:
        return _fail("ast_check", errs, code_hash, t0)

    # 3) schema
    errs = av.validate_schema(spec, list(df.columns))
    if errs:
        return _fail("schema_check", errs, code_hash, t0,
                     fallback_hint="调用 data_fallback.ensure_field 派生缺失列后重试")

    # 4) execute（在受限 namespace 中）
    import numpy as np
    import pandas as pd
    safe_globals: dict[str, Any] = {"__builtins__": av._safe_builtins()}
    safe_locals: dict[str, Any] = {"df": df, "pd": pd, "np": np}
    try:
        _exec_with_timeout(code, safe_globals, safe_locals, timeout_s)
    except TimeoutError:
        return _fail("execute", [f"timeout after {timeout_s}s"], code_hash, t0)
    except Exception as e:
        return _fail("execute", [repr(e)], code_hash, t0)

    if "result" not in safe_locals:
        return _fail("execute", ["code must assign final result to variable `result`"], code_hash, t0)

    # 5) output 类型
    errs, records = av.validate_output(safe_locals["result"])
    if errs:
        return _fail("output_check", errs, code_hash, t0)

    # 6) validation_checks
    errs = av.run_checks(spec, df, safe_locals["result"])
    if errs:
        return _fail("validation", errs, code_hash, t0)

    return {
        "status": "validated",
        "stage": None,
        "code_hash": code_hash,
        "elapsed_ms": int((time.time() - t0) * 1000),
        "n_rows": len(records) if records else 0,
        "records": records,
        "errors": None,
        "fallback_hint": None,
    }


def attach_evidence(
    state: dict[str, Any],
    spec: dict[str, Any],
    run_result: dict[str, Any],
    hypothesis_id: str | None = None,
) -> str:
    """把成功的 run_result 挂到 state.adhoc_evidences / adhoc_tools / hypothesis.evidence_ids。

    返回 ev_id。仅当 run_result.status == "validated" 才落库。
    """
    if run_result.get("status") != "validated":
        raise ValueError(f"cannot attach failed run: stage={run_result.get('stage')}, errors={run_result.get('errors')}")

    code_hash = run_result["code_hash"]
    tool_id = f"tool_{code_hash[:8]}"
    ev_id = f"ev_adhoc_{uuid.uuid4().hex[:8]}"
    records = run_result.get("records") or []

    state.setdefault("adhoc_tools", [])
    state.setdefault("adhoc_evidences", [])

    if not any(t.get("code_hash") == code_hash for t in state["adhoc_tools"]):
        state["adhoc_tools"].append({
            "id": tool_id,
            "name": spec.get("name"),
            "purpose": spec.get("purpose"),
            "created_for_hypothesis": hypothesis_id or spec.get("created_for_hypothesis"),
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "code": spec.get("code"),
            "code_hash": code_hash,
            "input_columns": spec.get("input_columns"),
            "output_schema": spec.get("output_schema"),
            "validation_checks": spec.get("validation_checks"),
            "severity_cap": spec.get("severity_cap"),
            "status": "validated",
            "promoted_to": None,
        })

    state["adhoc_evidences"].append({
        "id": ev_id,
        "tool_id": tool_id,
        "name": spec.get("name"),
        "code_hash": code_hash,
        "result_table": records[:200],
        "result_summary": _summarize(records, spec),
        "n_rows": len(records),
    })

    if hypothesis_id:
        for h in state.get("hypotheses", []) or []:
            if h.get("id") == hypothesis_id:
                h.setdefault("evidence_ids", []).append(ev_id)
                break

    return ev_id


# ── 私有辅助 ──────────────────────────────────────────────────────────


def _fail(stage: str, errors: list[str], code_hash: str | None, t0: float,
          fallback_hint: str | None = None) -> dict[str, Any]:
    return {
        "status": "failed",
        "stage": stage,
        "code_hash": code_hash,
        "elapsed_ms": int((time.time() - t0) * 1000),
        "n_rows": None,
        "records": None,
        "errors": errors,
        "fallback_hint": fallback_hint,
    }


def _exec_with_timeout(code: str, g: dict, l: dict, timeout_s: int) -> None:
    """硬超时执行用户 ad-hoc 代码。

    平台策略：
      - POSIX（Linux/macOS）：SIGALRM 进程内硬中断（最轻量，零开销）
      - 全平台兜底：multiprocessing.Process + process.terminate() 真正硬 kill
        子进程被 SIGTERM/Windows TerminateProcess 强制结束，无论 C 调用是否在跑
        代价是 ~50ms 启动开销 + 数据需要 pickle 传输

    返回值通过 multiprocessing.Queue 回传 `l` 中 `result` 变量。
    任何超时 / 异常都会抛出，外层 try/except 捕获后包装成 status=failed。
    """
    import signal as _signal
    if hasattr(_signal, "SIGALRM"):
        def _handler(signum, frame):
            raise TimeoutError(f"adhoc execution exceeded {timeout_s}s")
        old = _signal.signal(_signal.SIGALRM, _handler)
        _signal.alarm(timeout_s)
        try:
            exec(code, g, l)
        finally:
            _signal.alarm(0)
            _signal.signal(_signal.SIGALRM, old)
        return

    # 非 POSIX：multiprocessing 子进程硬隔离
    import multiprocessing as _mp

    # 准备传给子进程的最小 locals（df 是必须，其他纯函数）
    df = l.get("df")
    parent_conn, child_conn = _mp.Pipe(duplex=False)
    ctx = _mp.get_context("spawn")  # Windows 必须用 spawn
    proc = ctx.Process(
        target=_adhoc_subprocess_target,
        args=(code, df, child_conn),
        daemon=True,
    )
    proc.start()
    proc.join(timeout=timeout_s)
    if proc.is_alive():
        proc.terminate()
        proc.join(timeout=1.0)
        if proc.is_alive():
            proc.kill()
        raise TimeoutError(f"adhoc execution exceeded {timeout_s}s")

    # 子进程结束：读取返回
    if not parent_conn.poll():
        raise RuntimeError("adhoc subprocess died without returning result")
    msg = parent_conn.recv()
    if msg.get("error"):
        raise RuntimeError(msg["error"])
    l["result"] = msg.get("result")


def _adhoc_subprocess_target(code: str, df, conn) -> None:
    """运行在子进程中：受限 namespace 执行用户代码，把 result 通过 Pipe 回传。"""
    try:
        from . import adhoc_validator as _av
        import numpy as _np
        import pandas as _pd
        safe_globals = {"__builtins__": _av._safe_builtins()}
        ns = {"df": df, "pd": _pd, "np": _np}
        exec(code, safe_globals, ns)
        conn.send({"result": ns.get("result"), "error": None})
    except Exception as e:
        conn.send({"result": None, "error": f"{type(e).__name__}: {e}"})
    finally:
        conn.close()


def _summarize(records: list[dict], spec: dict) -> str:
    """生成短摘要（≤200 字）："""
    if not records:
        return "[empty]"
    n = len(records)
    first = records[0]
    keys = list(first.keys())[:5]
    sample = ", ".join(f"{k}={first[k]!r}" for k in keys)
    return f"{spec.get('name', 'adhoc')} n_rows={n}; first_row({sample})"
