"""Static impact map: which tasks can a code edit possibly affect? (REVIEW §1.10)

For pytest tasks the answer is knowable without running anything: the test
calls skill symbols (`evidence.test_targets`), and symbols call other symbols
(the module call graph). A candidate that edits `normalize_cell` can only
change tasks whose transitive call set reaches `normalize_cell`; replaying
the rest for G6 is wasted work.

Agent / simulation tasks have no static mapping and are always replayed.
Deterministic, zero model calls, and conservative: an unresolvable call
(dynamic dispatch, star import) marks the caller as reaching EVERYTHING.
"""
from __future__ import annotations

import ast
from dataclasses import dataclass, field
from pathlib import Path

from .evidence import TaskRecord, test_targets
from .fs import iter_skill_files


@dataclass
class CallGraph:
    # "scripts/x.py::func" -> callees in the same form; "*" means unknown
    edges: dict[str, set[str]] = field(default_factory=dict)

    def reach(self, sym: str) -> set[str]:
        seen: set[str] = set()
        todo = [sym]
        while todo:
            cur = todo.pop()
            if cur in seen:
                continue
            seen.add(cur)
            todo.extend(self.edges.get(cur, set()))
        return seen


def _qual(module: str, name: str) -> str:
    return f"{module}::{name}"


def call_graph(skill_dir: Path) -> CallGraph:
    """Callees per function, resolved within the skill's own scripts/."""
    skill_dir = Path(skill_dir)
    g = CallGraph()
    modules: dict[str, ast.Module] = {}
    for p in iter_skill_files(skill_dir, (".py",)):
        rel = p.relative_to(skill_dir).as_posix()
        if not rel.startswith("scripts/"):
            continue
        try:
            modules[rel] = ast.parse(p.read_text(encoding="utf-8"))
        except SyntaxError:
            continue
    defined: dict[str, set[str]] = {m: {n.name for n in ast.walk(t)
                                        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}
                                    for m, t in modules.items()}
    for rel, tree in modules.items():
        # local name -> module it was imported from (within scripts/)
        imported: dict[str, tuple[str, str]] = {}
        star = False
        for n in ast.walk(tree):
            if isinstance(n, ast.ImportFrom) and n.module and n.module.startswith("scripts"):
                src = n.module.replace(".", "/") + ".py"
                for a in n.names:
                    if a.name == "*":
                        star = True
                    else:
                        imported[a.asname or a.name] = (src, a.name)
        for fn in ast.walk(tree):
            if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            key = _qual(rel, fn.name)
            callees: set[str] = set()
            for c in ast.walk(fn):
                if not isinstance(c, ast.Call):
                    continue
                f = c.func
                if isinstance(f, ast.Name):
                    if f.id in defined.get(rel, set()):
                        callees.add(_qual(rel, f.id))
                    elif f.id in imported:
                        callees.add(_qual(*imported[f.id]))
                    elif star:
                        callees.add("*")
                elif isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name):
                    # scripts.other.func(...) via `import scripts.other as other`
                    for m in modules:
                        if m.endswith(f"/{f.value.id}.py") and f.attr in defined.get(m, set()):
                            callees.add(_qual(m, f.attr))
                # any other callee (stdlib, method on an object) is outside the skill
            g.edges[key] = callees
    return g


def tasks_touching(skill_dir: Path, tasks: list[TaskRecord],
                   symbols: set[tuple[str, str]]) -> list[TaskRecord]:
    """Tasks whose test can reach any of *symbols* ((module, name) pairs).

    Non-pytest tasks are always included. A test whose targets cannot be
    resolved, or a reach set containing "*", is included too (conservative).
    """
    if not symbols:
        return list(tasks)
    g = call_graph(skill_dir)
    wanted = {_qual(m, n) for m, n in symbols if n != "*"}
    whole = {m for m, n in symbols if n == "*"}          # whole-module edits
    edited_modules = {m for m, _ in symbols}
    out: list[TaskRecord] = []
    for t in tasks:
        if not ("::" in t.id and t.id.split("::")[0].endswith(".py")):
            out.append(t)
            continue
        targets = test_targets(skill_dir, t.id)
        if not targets:
            out.append(t)
            continue
        hit = False
        for mod, name in targets:
            reach = g.reach(_qual(mod, name))
            if "*" in reach or reach & wanted or (mod in edited_modules and
                                                   _qual(mod, name) not in g.edges):
                hit = True
                break
            if whole and any(q.split("::")[0] in whole for q in reach):
                hit = True
                break
        if hit:
            out.append(t)
    return out


def bundle_symbols(bundle) -> set[tuple[str, str]]:
    """(module, symbol) pairs a bundle edits; whole-module ops mark every function."""
    out: set[tuple[str, str]] = set()
    for e in bundle.code_edits:
        if e.op in ("rewrite_module", "add_import") or not e.symbol:
            out.add((e.module, "*"))
        else:
            out.add((e.module, e.symbol.split(".")[-1]))
    return out
