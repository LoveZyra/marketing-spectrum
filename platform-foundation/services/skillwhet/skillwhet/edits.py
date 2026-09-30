"""Round-trip-safe structured code edits, via libcst.

Why libcst and not ``ast``: ``ast.unparse()`` discards every comment and
re-formats the whole file, so a one-function change produces a whole-file diff.
That destroys human reviewability and makes the bloat metric meaningless.
libcst preserves every byte it does not explicitly touch.
"""
from __future__ import annotations

import re
import shutil
from dataclasses import dataclass
from pathlib import Path

import libcst as cst

from .types import CodeEdit, DocEdit


class EditError(Exception):
    pass


@dataclass
class EditReport:
    op: str
    module: str
    symbol: str
    status: str
    detail: str = ""

    @property
    def applied(self) -> bool:
        return self.status.startswith("applied")

    def to_dict(self) -> dict:
        return {
            "op": self.op, "module": self.module, "symbol": self.symbol,
            "status": self.status, "detail": self.detail,
        }


def _is_import_line(node: cst.CSTNode) -> bool:
    return isinstance(node, cst.SimpleStatementLine) and all(
        isinstance(s, (cst.Import, cst.ImportFrom)) for s in node.body
    )


def _parse_function(src: str) -> cst.FunctionDef:
    func, _ = _parse_function_block(src)
    return func


def _parse_function_block(src: str) -> tuple[cst.FunctionDef, list[cst.SimpleStatementLine]]:
    """One function plus the imports it ships with. Anything else is an error.

    Models routinely return ``import math`` above the function they rewrote;
    silently dropping it produced code that raised NameError at G4. Anything
    that is neither an import nor the one function is refused rather than
    ignored, so a model cannot smuggle module-level side effects in.
    """
    try:
        mod = cst.parse_module(src.strip() + "\n")
    except Exception as exc:  # noqa: BLE001 - surfaced as EditError
        raise EditError(f"content is not parseable Python: {exc}") from exc
    funcs = [s for s in mod.body if isinstance(s, cst.FunctionDef)]
    imports = [s for s in mod.body if _is_import_line(s)]
    if len(funcs) != 1:
        raise EditError(
            f"content must contain exactly one top-level function, found {len(funcs)}"
        )
    other = [s for s in mod.body if s not in funcs and s not in imports]
    if other:
        raise EditError(
            "content may contain only the function and its imports; found "
            + ", ".join(type(s).__name__ for s in other[:3])
        )
    return funcs[0], imports


def _import_keys(node: cst.CSTNode) -> set[tuple[str, str, str]]:
    """(module, name, alias) triples an import statement binds."""
    keys: set[tuple[str, str, str]] = set()
    stmts = node.body if isinstance(node, cst.SimpleStatementLine) else [node]
    for s in stmts:
        if isinstance(s, cst.Import):
            for a in s.names:
                keys.add(("", _dotted(a.name), a.asname.name.value if a.asname else ""))
        elif isinstance(s, cst.ImportFrom):
            mod = _dotted(s.module) if s.module is not None else ""
            mod = "." * len(s.relative) + mod
            if isinstance(s.names, cst.ImportStar):
                keys.add((mod, "*", ""))
            else:
                for a in s.names:
                    keys.add((mod, _dotted(a.name), a.asname.name.value if a.asname else ""))
    return keys


def _dotted(node) -> str:
    if isinstance(node, cst.Name):
        return node.value
    if isinstance(node, cst.Attribute):
        return f"{_dotted(node.value)}.{node.attr.value}"
    return ""


def _existing_imports(module: cst.Module) -> set[tuple[str, str, str]]:
    keys: set[tuple[str, str, str]] = set()
    for node in module.body:
        if _is_import_line(node):
            keys |= _import_keys(node)
    return keys


def _add_missing_imports(module: cst.Module,
                         imports: list[cst.SimpleStatementLine]) -> cst.Module:
    have = _existing_imports(module)
    for imp in imports:
        if _import_keys(imp) <= have:
            continue
        module = module.visit(_ImportInserter(imp))
        have |= _import_keys(imp)
    return module


class _FunctionTransformer(cst.CSTTransformer):
    """Locate a function by dotted qualified name and replace/remove it."""

    def __init__(self, target: str, new_node: cst.FunctionDef | None) -> None:
        self.target = target
        self.new_node = new_node
        self.hit = 0
        self._scope: list[str] = []

    # -- scope tracking ----------------------------------------------------
    def visit_ClassDef(self, node: cst.ClassDef) -> bool:
        self._scope.append(node.name.value)
        return True

    def leave_ClassDef(self, orig: cst.ClassDef, updated: cst.ClassDef) -> cst.ClassDef:
        self._scope.pop()
        return updated

    def visit_FunctionDef(self, node: cst.FunctionDef) -> bool:
        self._scope.append(node.name.value)
        return True

    def leave_FunctionDef(self, orig: cst.FunctionDef, updated: cst.FunctionDef):
        qual = ".".join(self._scope)
        self._scope.pop()
        if qual != self.target:
            return updated
        self.hit += 1
        if self.new_node is None:
            return cst.RemoveFromParent()
        # A freshly parsed function has no leading blank lines, so splicing it in
        # naively collapses the vertical spacing around it and produces exactly
        # the whole-file diff noise libcst was chosen to avoid. Carry the
        # original node's leading lines over, unless the replacement brings its
        # own comment block (in which case the author meant it).
        new_has_comment = any(
            ln.comment is not None for ln in self.new_node.leading_lines
        )
        if new_has_comment:
            return self.new_node
        return self.new_node.with_changes(leading_lines=orig.leading_lines)


class _ImportInserter(cst.CSTTransformer):
    """Insert an import after the existing import block (or after the docstring)."""

    def __init__(self, stmt: cst.BaseStatement) -> None:
        self.stmt = stmt
        self.done = False

    def leave_Module(self, orig: cst.Module, updated: cst.Module) -> cst.Module:
        body = list(updated.body)
        idx = 0
        for i, node in enumerate(body):
            if isinstance(node, cst.SimpleStatementLine) and any(
                isinstance(s, (cst.Import, cst.ImportFrom)) for s in node.body
            ):
                idx = i + 1
            elif i == 0 and isinstance(node, cst.SimpleStatementLine) and any(
                isinstance(s, cst.Expr) and isinstance(s.value, cst.SimpleString)
                for s in node.body
            ):
                idx = 1
        body.insert(idx, self.stmt)
        self.done = True
        return updated.with_changes(body=body)


def _normalize_symbol(symbol: str, module: str, content: str) -> str:
    """Models return the symbol in several spellings; accept them all.

    ``scripts.cells.normalize_cell`` / ``cells.normalize_cell`` /
    ``normalize_cell`` all mean the same function in ``scripts/cells.py``. If
    the symbol is still empty, fall back to the ``def`` name in *content*.
    Found by the first real-model run: haiku's fix was correct and rejected as
    "symbol not found" purely on this spelling.
    """
    sym = (symbol or "").strip()
    mod_dotted = module.replace("\\", "/").removesuffix(".py").replace("/", ".")
    for prefix in (mod_dotted + ".", mod_dotted.split(".")[-1] + "."):
        if sym.startswith(prefix):
            sym = sym[len(prefix):]
            break
    if not sym and content:
        try:
            for stmt in cst.parse_module(content.strip() + "\n").body:
                if isinstance(stmt, cst.FunctionDef):
                    sym = stmt.name.value
                    break
        except Exception:  # noqa: BLE001
            pass
    return sym


def apply_code_edit(source: str, edit: CodeEdit) -> tuple[str, EditReport]:
    """Apply one edit to one module's source. Pure function."""
    if edit.op in ("replace_function", "delete_function", "add_function"):
        norm = _normalize_symbol(edit.symbol, edit.module, edit.content)
        if norm != edit.symbol:
            edit = CodeEdit(**{**edit.to_dict(), "symbol": norm})
    rep = EditReport(op=edit.op, module=edit.module, symbol=edit.symbol, status="unknown")
    try:
        module = cst.parse_module(source)
    except Exception as exc:  # noqa: BLE001
        rep.status = "skipped_unparseable_source"
        rep.detail = str(exc)
        return source, rep

    try:
        if edit.op == "replace_function":
            new, imports = _parse_function_block(edit.content)
            t = _FunctionTransformer(edit.symbol, new)
            out = module.visit(t)
            if t.hit == 0 and new.name.value != edit.symbol:
                # last resort: the def name inside the content is authoritative
                t = _FunctionTransformer(new.name.value, new)
                out = module.visit(t)
                if t.hit:
                    rep.symbol = new.name.value
            if t.hit == 0:
                rep.status = "skipped_symbol_not_found"
                return source, rep
            if t.hit > 1:
                rep.status = "skipped_ambiguous_symbol"
                rep.detail = f"{t.hit} matches for {edit.symbol!r}"
                return source, rep
            out = _add_missing_imports(out, imports)
            rep.status = "applied_replace_function"
            return out.code, rep

        if edit.op == "delete_function":
            t = _FunctionTransformer(edit.symbol, None)
            out = module.visit(t)
            if t.hit == 0:
                rep.status = "skipped_symbol_not_found"
                return source, rep
            rep.status = "applied_delete_function"
            return out.code, rep

        if edit.op == "add_function":
            new, imports = _parse_function_block(edit.content)
            probe = _FunctionTransformer(edit.symbol or new.name.value, new)
            module.visit(probe)
            if probe.hit:
                rep.status = "skipped_symbol_exists"
                return source, rep
            module = _add_missing_imports(module, imports)
            body = list(module.body)
            body.append(cst.EmptyLine())
            body.append(new)
            rep.status = "applied_add_function"
            return module.with_changes(body=body).code, rep

        if edit.op == "rewrite_module":
            # Reserved for P1 (formatter / autofix): the tool is deterministic and
            # the result still has to clear G0-G5, so whole-file replacement is
            # safe here and nowhere else.
            try:
                cst.parse_module(edit.content)
            except Exception as exc:  # noqa: BLE001
                raise EditError(f"rewritten module is not parseable: {exc}") from exc
            if edit.content == source:
                rep.status = "skipped_no_change"
                return source, rep
            rep.status = "applied_rewrite_module"
            return edit.content, rep

        if edit.op == "add_import":
            stmt_src = edit.content.strip()
            try:
                parsed = cst.parse_statement(stmt_src + "\n")
            except Exception as exc:  # noqa: BLE001
                raise EditError(f"import statement not parseable: {exc}") from exc
            if not _is_import_line(parsed):
                raise EditError("add_import content must be an import statement")
            if _import_keys(parsed) <= _existing_imports(module):
                rep.status = "skipped_import_exists"
                return source, rep
            ins = _ImportInserter(parsed)
            out = module.visit(ins)
            rep.status = "applied_add_import"
            return out.code, rep

        rep.status = "skipped_unknown_op"
        return source, rep

    except EditError as exc:
        rep.status = "error"
        rep.detail = str(exc)
        return source, rep


# ── The optimizer-visible surface ───────────────────────────────────────────
#
# Every path a bundle names is resolved through `editable_path`. Anything
# outside this surface — hold-out tests, contract tests, `.evo/`, `..`,
# absolute paths, symlinks that escape — is refused, not "skipped": a bundle
# that reaches for tests/holdout is a reward hack, and the audit showed one
# landing in the live skill before this existed.

CODE_EDIT_ROOTS = ("scripts",)
DOC_EDIT_FILES = ("SKILL.md",)
DOC_EDIT_ROOTS = ("references",)
FORBIDDEN_PARTS = (".evo", "..")


def editable_path(root: Path, rel: str, kind: str) -> Path | None:
    """Resolve *rel* under *root*; None unless it lies inside the editable surface."""
    root = Path(root).resolve()
    if not rel or rel.startswith(("/", "\\")) or ":" in rel[:3]:
        return None
    try:
        p = (root / rel).resolve()
        r = p.relative_to(root)
    except (ValueError, OSError):
        return None
    parts = r.parts
    if not parts or any(x in FORBIDDEN_PARTS for x in parts):
        return None
    if kind == "code":
        return p if parts[0] in CODE_EDIT_ROOTS and p.suffix == ".py" else None
    if kind == "doc":
        if r.as_posix() in DOC_EDIT_FILES:
            return p
        return p if parts[0] in DOC_EDIT_ROOTS and p.suffix == ".md" else None
    return None


def apply_bundle_to_dir(skill_dir: Path, code_edits: list[CodeEdit]) -> list[EditReport]:
    """Apply code edits in place. Caller is responsible for working on a copy."""
    reports: list[EditReport] = []
    by_module: dict[str, list[CodeEdit]] = {}
    for e in code_edits:
        by_module.setdefault(e.module, []).append(e)

    for module, edits in by_module.items():
        path = editable_path(skill_dir, module, "code")
        if path is None:
            reports.extend(
                EditReport(e.op, module, e.symbol, "refused_outside_surface",
                           "code edits may only touch scripts/*.py")
                for e in edits
            )
            continue
        if not path.exists():
            if all(e.op == "add_function" for e in edits):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("", encoding="utf-8")
            else:
                reports.extend(
                    EditReport(e.op, module, e.symbol, "skipped_module_missing")
                    for e in edits
                )
                continue
        src = path.read_text(encoding="utf-8")
        for e in edits:
            src, rep = apply_code_edit(src, e)
            reports.append(rep)
        path.write_text(src, encoding="utf-8")
    return reports


# ── Prose edits (SkillOpt's four atomic ops) ────────────────────────────────

PROTECTED_REGIONS = (
    ("<!-- SLOW_UPDATE_START -->", "<!-- SLOW_UPDATE_END -->"),
    ("<!-- LEARNED_START -->", "<!-- LEARNED_END -->"),
)


def _in_protected(text: str, target: str) -> bool:
    """True when the target overlaps a protected block or either of its markers.

    Overlap, not containment: a target that starts one character before the
    START marker and runs into the block would otherwise delete the marker
    and the guidance with it.
    """
    if not target:
        return False
    i = text.find(target)
    if i == -1:
        return False
    j = i + len(target)
    for start, end in PROTECTED_REGIONS:
        s, e = text.find(start), text.find(end)
        lo = min(x for x in (s, e) if x != -1) if (s != -1 or e != -1) else -1
        if lo == -1:
            continue
        hi = max(s + len(start) if s != -1 else -1, e + len(end) if e != -1 else -1)
        if i < hi and j > lo:
            return True
    return False


def locate(text: str, target: str) -> tuple[int, int] | None:
    """Where *target* is in *text*: exact, else whitespace-insensitive, else the
    closest contiguous line block (ratio ≥ 0.85).

    Models quote the sentence they want replaced from memory — a wrapped line,
    a dropped backtick — and an exact-match `replace` silently became a no-op
    while an `append` in the same bundle landed, leaving the wrong sentence
    next to its correction (measured on the first real slow-loop run).
    """
    if not target:
        return None
    i = text.find(target)
    if i != -1:
        return i, i + len(target)
    tokens = target.split()
    if not tokens:
        return None
    rx = r"\s*".join(re.escape(t) for t in tokens)
    m = re.search(rx, text)
    if m:
        return m.start(), m.end()
    # line-block similarity
    import difflib
    lines = text.splitlines(keepends=True)
    tgt_lines = target.strip().splitlines()
    n = max(1, len(tgt_lines))
    best, best_ratio = None, 0.0
    norm_t = " ".join(target.split())
    offsets = [0]
    for ln in lines:
        offsets.append(offsets[-1] + len(ln))
    for a in range(len(lines)):
        for b in (a + n, a + n + 1, a + n - 1):
            if b <= a or b > len(lines):
                continue
            block = " ".join("".join(lines[a:b]).split())
            r = difflib.SequenceMatcher(None, norm_t, block).ratio()
            if r > best_ratio:
                best, best_ratio = (offsets[a], offsets[b]), r
    if best is not None and best_ratio >= 0.85:
        s_, e_ = best
        while e_ > s_ and text[e_ - 1] == "\n":
            e_ -= 1
        return s_, e_
    return None


def apply_doc_edit(text: str, edit: DocEdit) -> tuple[str, EditReport]:
    rep = EditReport(op=edit.op, module=edit.path, symbol="", status="unknown")
    content = edit.content
    for start, end in PROTECTED_REGIONS:
        content = content.replace(start, "").replace(end, "")

    span = locate(text, edit.target) if edit.target else None
    if span is not None:
        # re-express the target as the text actually found, so the protected-
        # region check and the edit itself agree on what is being touched
        found = text[span[0]:span[1]]
        if found != edit.target:
            rep.detail = f"target matched fuzzily ({len(edit.target)}→{len(found)} chars)"
            edit = DocEdit(op=edit.op, path=edit.path, content=edit.content, target=found)
    if edit.target and _in_protected(text, edit.target):
        rep.status = "skipped_protected_region"
        return text, rep

    if edit.op == "append":
        earliest = min(
            (i for i in (text.find(s) for s, _ in PROTECTED_REGIONS) if i != -1),
            default=-1,
        )
        if earliest != -1:
            rep.status = "applied_append_before_protected"
            return text[:earliest].rstrip() + "\n\n" + content + "\n\n" + text[earliest:], rep
        rep.status = "applied_append"
        return text.rstrip() + "\n\n" + content + "\n", rep

    if edit.op == "insert_after":
        if not edit.target or edit.target not in text:
            rep.status = "skipped_target_not_found"
            rep.detail = f"target={edit.target[:100]!r}"
            return text, rep
        idx = text.index(edit.target) + len(edit.target)
        nl = text.find("\n", idx)
        at = nl + 1 if nl != -1 else len(text)
        rep.status = "applied_insert_after"
        return text[:at] + "\n" + content + "\n" + text[at:], rep

    if edit.op == "replace":
        if not edit.target or edit.target not in text:
            rep.status = "skipped_target_not_found"
            rep.detail = f"target={edit.target[:100]!r}"
            return text, rep
        rep.status = "applied_replace"
        return text.replace(edit.target, content, 1), rep

    if edit.op == "delete":
        if not edit.target or edit.target not in text:
            rep.status = "skipped_target_not_found"
            rep.detail = f"target={edit.target[:100]!r}"
            return text, rep
        rep.status = "applied_delete"
        return text.replace(edit.target, "", 1), rep

    rep.status = "skipped_unknown_op"
    return text, rep


def snapshot(skill_dir: Path, dest: Path) -> Path:
    """Copy a skill into a scratch dir so candidates never touch the original."""
    dest = Path(dest)
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(skill_dir, dest, ignore=shutil.ignore_patterns(".evo", "__pycache__"))
    return dest
