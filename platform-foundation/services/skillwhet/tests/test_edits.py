"""Structured edits must be surgical: everything not targeted stays byte-identical."""
from __future__ import annotations

import ast
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from skillwhet.edits import apply_code_edit, apply_doc_edit  # noqa: E402
from skillwhet.types import CodeEdit, DocEdit  # noqa: E402

SRC = '''"""Module docstring."""
from __future__ import annotations

import re  # keep this comment


def alpha(x: int) -> int:
    # a meaningful comment inside alpha
    return x + 1


class Helper:
    def beta(self, y: str) -> str:
        """Beta docstring."""
        return y.strip()


def gamma(z: float) -> float:
    return z * 2.0
'''


def edit(**kw) -> CodeEdit:
    kw.setdefault("module", "scripts/m.py")
    return CodeEdit(**kw)


# ── The reason libcst exists in this design ─────────────────────────────────

def test_replace_preserves_comments_and_formatting():
    out, rep = apply_code_edit(SRC, edit(
        op="replace_function", symbol="alpha",
        content="def alpha(x: int) -> int:\n    return x + 2\n",
    ))
    assert rep.applied
    assert "# keep this comment" in out, "unrelated comments must survive"
    assert '"""Module docstring."""' in out
    assert "# a meaningful comment inside alpha" not in out, "targeted body is replaced"
    assert "Beta docstring" in out
    assert "return x + 2" in out


def test_ast_unparse_would_have_destroyed_it():
    """Documents *why* libcst is mandatory rather than a style preference."""
    round_tripped = ast.unparse(ast.parse(SRC))
    assert "# keep this comment" not in round_tripped
    assert "# a meaningful comment inside alpha" not in round_tripped


def test_replace_touches_only_the_target_region():
    out, _ = apply_code_edit(SRC, edit(
        op="replace_function", symbol="alpha",
        content="def alpha(x: int) -> int:\n    return x + 2\n",
    ))
    before_a, after_a = SRC.split("def alpha", 1)[0], SRC.split("class Helper", 1)[1]
    assert out.startswith(before_a)
    assert out.endswith(after_a)


# ── Addressing ──────────────────────────────────────────────────────────────

def test_method_addressed_by_qualified_name():
    out, rep = apply_code_edit(SRC, edit(
        op="replace_function", symbol="Helper.beta",
        content='def beta(self, y: str) -> str:\n    """New."""\n    return y.upper()\n',
    ))
    assert rep.applied
    assert "y.upper()" in out
    assert "def alpha" in out and "def gamma" in out


def test_unknown_symbol_is_a_no_op_not_a_corruption():
    out, rep = apply_code_edit(SRC, edit(
        op="replace_function", symbol="nope",
        content="def nope() -> None:\n    pass\n",
    ))
    assert rep.status == "skipped_symbol_not_found"
    assert out == SRC


def test_delete_function():
    out, rep = apply_code_edit(SRC, edit(op="delete_function", symbol="gamma"))
    assert rep.applied
    assert "def gamma" not in out
    assert "def alpha" in out


def test_add_function_refuses_duplicate():
    out, rep = apply_code_edit(SRC, edit(
        op="add_function", symbol="alpha",
        content="def alpha(x: int) -> int:\n    return 0\n",
    ))
    assert rep.status == "skipped_symbol_exists"
    assert out == SRC


def test_add_import_goes_after_existing_imports():
    out, rep = apply_code_edit(SRC, edit(op="add_import", content="import json"))
    assert rep.applied
    lines = out.splitlines()
    assert lines.index("import json") > lines.index("import re  # keep this comment")
    assert ast.parse(out)


def test_add_import_is_idempotent():
    once, _ = apply_code_edit(SRC, edit(op="add_import", content="import json"))
    twice, rep = apply_code_edit(once, edit(op="add_import", content="import json"))
    assert rep.status == "skipped_import_exists"
    assert twice == once


# ── Failure containment ─────────────────────────────────────────────────────

def test_unparseable_content_is_rejected_not_written():
    out, rep = apply_code_edit(SRC, edit(
        op="replace_function", symbol="alpha", content="def alpha(:\n",
    ))
    assert rep.status == "error"
    assert out == SRC


def test_multi_function_content_is_rejected():
    out, rep = apply_code_edit(SRC, edit(
        op="replace_function", symbol="alpha",
        content="def a() -> None: pass\ndef b() -> None: pass\n",
    ))
    assert rep.status == "error"
    assert out == SRC


def test_every_applied_edit_leaves_parseable_source():
    for e in [
        edit(op="replace_function", symbol="alpha",
             content="def alpha(x: int) -> int:\n    return x\n"),
        edit(op="delete_function", symbol="gamma"),
        edit(op="add_import", content="import json"),
        edit(op="add_function", symbol="delta",
             content="def delta() -> None:\n    pass\n"),
    ]:
        out, rep = apply_code_edit(SRC, e)
        assert rep.applied, rep.status
        ast.parse(out)  # post-condition of every code edit


# ── Prose edits ─────────────────────────────────────────────────────────────

DOC = """# Title

## Section A
alpha text

<!-- SLOW_UPDATE_START -->
epoch guidance, owned by the slow update process
<!-- SLOW_UPDATE_END -->
"""


def test_doc_append_lands_before_protected_region():
    out, rep = apply_doc_edit(DOC, DocEdit(op="append", path="d.md", content="new rule"))
    assert rep.applied
    assert out.index("new rule") < out.index("<!-- SLOW_UPDATE_START -->")


def test_doc_edit_cannot_touch_protected_region():
    out, rep = apply_doc_edit(DOC, DocEdit(
        op="replace", path="d.md", target="epoch guidance", content="hijacked",
    ))
    assert rep.status == "skipped_protected_region"
    assert out == DOC


def test_doc_edit_strips_smuggled_markers():
    out, _ = apply_doc_edit(DOC, DocEdit(
        op="append", path="d.md",
        content="<!-- SLOW_UPDATE_START -->sneaky<!-- SLOW_UPDATE_END -->",
    ))
    assert out.count("<!-- SLOW_UPDATE_START -->") == 1
