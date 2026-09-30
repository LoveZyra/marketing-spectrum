"""Deterministic AST analysis: imports, signatures, side effects.

No LLM, no subprocess. Everything here is pure stdlib ``ast`` so it runs in
milliseconds and gives identical answers on every machine.
"""
from __future__ import annotations

import ast
from dataclasses import dataclass, field

# ── Side-effect signatures ──────────────────────────────────────────────────

_NETWORK_MODULES = {
    "socket", "ssl", "requests", "httpx", "aiohttp", "urllib", "urllib3",
    "http", "ftplib", "smtplib", "telnetlib", "paramiko", "websockets",
    "boto3", "botocore",
}
_SUBPROCESS_MODULES = {"subprocess", "pty", "multiprocessing", "asyncio.subprocess"}
_SUBPROCESS_CALLS = {
    "os.system", "os.popen", "os.execv", "os.execve", "os.execl", "os.execlp",
    "os.spawnv", "os.spawnl", "os.fork", "os.posix_spawn", "pty.spawn",
}
_TMP_MODULES = {"tempfile"}

_WRITE_MODES = set("wax+")

# Calls that mutate the filesystem regardless of an ``open`` mode string.
_FS_WRITE_CALLS = {
    "os.remove", "os.unlink", "os.rmdir", "os.mkdir", "os.makedirs",
    "os.rename", "os.replace", "os.truncate", "os.chmod", "os.chown",
    "shutil.copy", "shutil.copy2", "shutil.copyfile", "shutil.copytree",
    "shutil.move", "shutil.rmtree", "shutil.make_archive",
}
_PATH_WRITE_METHODS = {
    "write_text", "write_bytes", "mkdir", "touch", "unlink", "rmdir",
    "rename", "replace", "symlink_to", "hardlink_to", "chmod",
}
# Unambiguous even when the receiver is an expression (`Path(p).write_text`):
# no common non-filesystem type has these method names.
_PATH_WRITE_METHODS_STRICT = _PATH_WRITE_METHODS - {"rename", "replace"}

# ── Dangerous constructs (G1) ───────────────────────────────────────────────

DANGEROUS_CALLS = {
    "eval": "eval() executes arbitrary expressions",
    "exec": "exec() executes arbitrary statements",
    "compile": "compile() builds executable code objects",
    "__import__": "__import__() bypasses the static import allowlist",
    "globals": "globals() enables dynamic attribute injection",
    "vars": "vars() enables dynamic attribute injection",
    "breakpoint": "breakpoint() drops into an interactive debugger",
}
DANGEROUS_QUALIFIED = {
    "os.system": "os.system() runs a shell command",
    "os.popen": "os.popen() runs a shell command",
    "pickle.load": "pickle.load() can execute arbitrary code on untrusted data",
    "pickle.loads": "pickle.loads() can execute arbitrary code on untrusted data",
    "marshal.loads": "marshal.loads() is unsafe on untrusted data",
    "yaml.load": "yaml.load() without SafeLoader can construct arbitrary objects",
    "importlib.import_module": "dynamic import bypasses the static allowlist",
    "ctypes.CDLL": "ctypes loads native code",
    "shutil.rmtree": "recursive delete — must be explicitly declared",
}


@dataclass
class ModuleFacts:
    """Everything G1/G2/G3 need to know about one module, from one AST walk."""

    imports: set[str] = field(default_factory=set)          # top-level module names
    import_lines: dict[str, int] = field(default_factory=dict)
    side_effects: set[str] = field(default_factory=set)
    effect_sites: list[tuple[str, str, int]] = field(default_factory=list)  # (effect, what, line)
    dangerous: list[tuple[str, str, int]] = field(default_factory=list)     # (name, why, line)
    functions: dict[str, str] = field(default_factory=dict)  # qualname -> signature
    func_lines: dict[str, int] = field(default_factory=dict)
    annotated: dict[str, bool] = field(default_factory=dict)  # qualname -> fully annotated


class _Walker(ast.NodeVisitor):
    def __init__(self) -> None:
        self.f = ModuleFacts()
        self._alias: dict[str, str] = {}   # local name -> real dotted module
        self._scope: list[str] = []
        # Dataflow, shallow but load-bearing: `w = open` then `w(p, "w")`,
        # `s = os.system` then `s(cmd)`. Without this, a one-line alias defeats
        # the whole denylist. Function-scope only; no interprocedural tracking.
        self._callable_alias: dict[str, str] = {}
        self._star_modules: list[str] = []
        # Functions in THIS module whose return value is a resolvable callable:
        # `def get(): return os.system` makes `get()(cmd)` a shell call. Filled
        # by a pre-pass so definition order does not matter.
        self._returns_callable: dict[str, str] = {}

    # -- assignments: track aliases of dangerous callables ------------------
    def _bind(self, target: ast.expr, value: ast.expr) -> None:
        """Record every name an assignment binds to a resolvable callable."""
        if isinstance(target, ast.Name):
            src = self._resolve_value(value)
            if src:
                self._callable_alias[target.id] = src
            else:
                self._callable_alias.pop(target.id, None)
        elif isinstance(target, (ast.Tuple, ast.List)) and \
                isinstance(value, (ast.Tuple, ast.List)) and \
                len(target.elts) == len(value.elts):
            for t, v in zip(target.elts, value.elts):
                self._bind(t, v)

    def visit_Assign(self, node: ast.Assign) -> None:
        for t in node.targets:                    # a = b = os.system
            self._bind(t, node.value)
        self.generic_visit(node)

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:     # s: object = os.system
        if node.value is not None:
            self._bind(node.target, node.value)
        self.generic_visit(node)

    def visit_NamedExpr(self, node: ast.NamedExpr) -> None:     # (s := os.system)(c)
        self._bind(node.target, node.value)
        self.generic_visit(node)

    @staticmethod
    def _strip_builtins(name: str) -> str:
        for pre in ("__builtins__.", "builtins."):
            if name.startswith(pre):
                return name[len(pre):]
        return name

    def _resolve_value(self, node: ast.expr) -> str:
        """Dotted name this expression evaluates to, if statically knowable."""
        if isinstance(node, ast.NamedExpr):                      # (s := os.system)
            return self._resolve_value(node.value)
        name = self._callee_name(node)
        if not name and isinstance(node, ast.Attribute):         # sys.modules["os"].system
            base = self._resolve_value(node.value)
            if base:
                return self._strip_builtins(f"{base}.{node.attr}")
        if name:
            base = name.split(".")[0]
            if base in self._callable_alias:
                return self._strip_builtins(self._callable_alias[base] + name[len(base):])
            if base in self._alias:
                return self._strip_builtins(self._alias[base] + name[len(base):])
            # `from os import *` then `system(c)`: the bare name belongs to the
            # star-imported module if any denylisted entry says so.
            if "." not in name:
                for mod in self._star_modules:
                    q = f"{mod}.{name}"
                    if q in DANGEROUS_QUALIFIED or q in _SUBPROCESS_CALLS or q in _FS_WRITE_CALLS:
                        return q
            return self._strip_builtins(name)
        # getattr(os, "sys" + "tem") → "os.system"
        if isinstance(node, ast.Call):
            fn = self._callee_name(node.func)
            if fn in self._returns_callable and not node.args and not node.keywords:
                return self._returns_callable[fn]          # helper() → what helper returns
            if fn == "getattr" and len(node.args) >= 2:
                obj = self._resolve_value(node.args[0])
                attr = _const_str(node.args[1])
                if obj and attr:
                    return self._strip_builtins(f"{obj}.{attr}")
            if fn in ("__import__", "importlib.import_module") and node.args:
                mod = _const_str(node.args[0])
                if mod:
                    return mod
        # __builtins__["eval"] / builtins.eval / sys.modules["os"] / os.__dict__["system"]
        if isinstance(node, ast.Subscript):
            obj = self._resolve_value(node.value)
            key = _const_str(node.slice)
            if key:
                if obj in ("__builtins__", "builtins"):
                    return key
                if obj == "sys.modules":
                    return key
                if obj.endswith(".__dict__"):
                    return f"{obj[:-len('.__dict__')]}.{key}"
        return ""

    # -- imports -----------------------------------------------------------
    def visit_Import(self, node: ast.Import) -> None:
        for a in node.names:
            root = a.name.split(".")[0]
            self.f.imports.add(root)
            self.f.import_lines.setdefault(root, node.lineno)
            self._alias[a.asname or a.name.split(".")[0]] = a.name
            self._note_module_effect(a.name, node.lineno)
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        if node.level:  # relative import — internal, not a dependency
            self.generic_visit(node)
            return
        mod = node.module or ""
        root = mod.split(".")[0]
        if root:
            self.f.imports.add(root)
            self.f.import_lines.setdefault(root, node.lineno)
            self._note_module_effect(mod, node.lineno)
        for a in node.names:
            if a.name == "*":
                # Every name the module exports is now bare and untraceable —
                # the one construct that defeats a static denylist by design.
                self._star_modules.append(mod)
                self.f.dangerous.append(
                    (f"from {mod} import *", "star import hides which names are "
                     "bound; the denylist cannot be applied statically", node.lineno))
                continue
            self._alias[a.asname or a.name] = f"{mod}.{a.name}" if mod else a.name
        self.generic_visit(node)

    def _note_module_effect(self, dotted: str, line: int) -> None:
        root = dotted.split(".")[0]
        if root in _NETWORK_MODULES:
            self._add_effect("network", f"import {dotted}", line)
        elif root in _SUBPROCESS_MODULES:
            self._add_effect("subprocess", f"import {dotted}", line)
        elif root in _TMP_MODULES:
            self._add_effect("filesystem:tmp", f"import {dotted}", line)

    def _add_effect(self, effect: str, what: str, line: int) -> None:
        self.f.side_effects.add(effect)
        self.f.effect_sites.append((effect, what, line))

    # -- functions ---------------------------------------------------------
    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self._handle_func(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self._handle_func(node)

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        self._scope.append(node.name)
        self.generic_visit(node)
        self._scope.pop()

    def _handle_func(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        qual = ".".join([*self._scope, node.name])
        self.f.functions[qual] = render_signature(node)
        self.f.func_lines[qual] = node.lineno
        self.f.annotated[qual] = is_fully_annotated(node)
        self._scope.append(node.name)
        self.generic_visit(node)
        self._scope.pop()

    # -- calls -------------------------------------------------------------
    def _flag(self, name: str, resolved: str, line: int, *, via: str = "") -> None:
        """Denylist checks for one callable reference (a call or an argument)."""
        suffix = f" (passed as {via})" if via else ""
        if name in DANGEROUS_CALLS:
            self.f.dangerous.append((name, DANGEROUS_CALLS[name] + suffix, line))
        elif resolved in DANGEROUS_CALLS:
            self.f.dangerous.append((resolved, DANGEROUS_CALLS[resolved] + suffix, line))
        for cand in (name, resolved):
            if cand in DANGEROUS_QUALIFIED:
                self.f.dangerous.append((cand, DANGEROUS_QUALIFIED[cand] + suffix, line))
                break
        for cand in (name, resolved):
            if cand in _SUBPROCESS_CALLS:
                self._add_effect("subprocess", cand, line)
                break
            if cand in _FS_WRITE_CALLS:
                eff = ("filesystem:tmp" if cand.startswith("tempfile")
                       else "filesystem:workspace")
                self._add_effect(eff, cand, line)
                break

    def visit_Call(self, node: ast.Call) -> None:
        name = self._callee_name(node.func)
        # A call through an alias, a star import, a getattr/__builtins__ lookup
        # or a subscript resolves to the underlying callable before any
        # denylist check.
        resolved_dyn = self._resolve_value(node.func)
        if resolved_dyn and (not name or resolved_dyn != self._strip_builtins(name)):
            name = resolved_dyn
        # `map(os.system, cmds)`, `Pool().map(subprocess.run, ...)`: a dangerous
        # callable handed to something else is still a dangerous call.
        for arg in [*node.args, *(kw.value for kw in node.keywords)]:
            if isinstance(arg, (ast.Name, ast.Attribute)):
                r = self._resolve_value(arg)
                if r and (r in DANGEROUS_QUALIFIED or r in _SUBPROCESS_CALLS
                          or r in DANGEROUS_CALLS or r in _FS_WRITE_CALLS):
                    self._flag(r, r, node.lineno, via="argument")
        # Path(p).open("w") / Path(p).write_text(...) — the receiver is a call,
        # so _callee_name is empty and the name-based checks below never see it.
        if isinstance(node.func, ast.Attribute) and not name:
            if node.func.attr == "open":
                self._check_open(node, method=True)
            elif node.func.attr in _PATH_WRITE_METHODS_STRICT:
                self._add_effect("filesystem:workspace", f".{node.func.attr}()", node.lineno)
        if name:
            resolved = resolved_dyn or self._strip_builtins(name)
            # getattr(<module>, <dynamic string>) is itself a red flag when the
            # string is not statically resolvable: it exists to evade this walker.
            if name == "getattr" and len(node.args) >= 2 and not _const_str(node.args[1]):
                self.f.dangerous.append(
                    ("getattr(dynamic)", "attribute name built at runtime evades the "
                     "static denylist", node.lineno))

            self._flag(name, resolved, node.lineno)

            root = resolved.split(".")[0]
            if root in _NETWORK_MODULES and "." in resolved:
                self._add_effect("network", resolved, node.lineno)
            if root in _SUBPROCESS_MODULES and "." in resolved:
                self._add_effect("subprocess", resolved, node.lineno)
            if root in _TMP_MODULES:
                self._add_effect("filesystem:tmp", resolved, node.lineno)

            # open(path, "w") and Path(...).write_text(...)
            if name in ("open", "io.open") or resolved in ("builtins.open", "io.open"):
                self._check_open(node)
            attr = name.rsplit(".", 1)[-1]
            if attr in _PATH_WRITE_METHODS:
                self._add_effect("filesystem:workspace", f".{attr}()", node.lineno)

        self.generic_visit(node)

    def _check_open(self, node: ast.Call, *, method: bool = False) -> None:
        mode = ""
        idx = 0 if method else 1                # Path.open(mode) vs open(path, mode)
        if len(node.args) > idx and isinstance(node.args[idx], ast.Constant):
            mode = str(node.args[idx].value or "")
        for kw in node.keywords:
            if kw.arg == "mode" and isinstance(kw.value, ast.Constant):
                mode = str(kw.value.value or "")
        if set(mode) & _WRITE_MODES:
            self._add_effect("filesystem:workspace", f'open(mode="{mode}")', node.lineno)
        elif not mode and (len(node.args) > idx or any(kw.arg == "mode" for kw in node.keywords)):
            # A mode that is not a literal cannot be proven read-only; assume write.
            self._add_effect("filesystem:workspace", "open(mode=<dynamic>)", node.lineno)

    @staticmethod
    def _callee_name(node: ast.expr) -> str:
        parts: list[str] = []
        cur: ast.expr | None = node
        while True:
            if isinstance(cur, ast.Attribute):
                parts.append(cur.attr)
                cur = cur.value
            elif isinstance(cur, ast.Name):
                parts.append(cur.id)
                break
            else:
                return ""
        return ".".join(reversed(parts))


def _const_str(node: ast.expr) -> str:
    """Fold a constant string expression: "sys" + "tem" → "system"."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left, right = _const_str(node.left), _const_str(node.right)
        if left and right:
            return left + right
    if isinstance(node, ast.JoinedStr):
        parts = [_const_str(v) if not isinstance(v, ast.FormattedValue) else ""
                 for v in node.values]
        return "".join(parts) if all(parts) else ""
    return ""


def render_signature(node: ast.FunctionDef | ast.AsyncFunctionDef) -> str:
    """Render a signature string that is stable across formatting changes."""
    a = node.args
    out: list[str] = []

    def one(arg: ast.arg, default: ast.expr | None = None) -> str:
        s = arg.arg
        if arg.annotation is not None:
            s += f": {ast.unparse(arg.annotation)}"
        if default is not None:
            s += f" = {ast.unparse(default)}"
        return s

    pos = list(a.posonlyargs) + list(a.args)
    pad = [None] * (len(pos) - len(a.defaults)) + list(a.defaults)
    for i, arg in enumerate(pos):
        out.append(one(arg, pad[i]))
        if a.posonlyargs and i == len(a.posonlyargs) - 1:
            out.append("/")
    if a.vararg is not None:
        out.append("*" + one(a.vararg))
    elif a.kwonlyargs:
        out.append("*")
    for arg, d in zip(a.kwonlyargs, a.kw_defaults):
        out.append(one(arg, d))
    if a.kwarg is not None:
        out.append("**" + one(a.kwarg))

    ret = f" -> {ast.unparse(node.returns)}" if node.returns is not None else ""
    prefix = "async " if isinstance(node, ast.AsyncFunctionDef) else ""
    return f"{prefix}{node.name}({', '.join(out)}){ret}"


def is_fully_annotated(node: ast.FunctionDef | ast.AsyncFunctionDef) -> bool:
    a = node.args
    args = list(a.posonlyargs) + list(a.args) + list(a.kwonlyargs)
    if a.vararg is not None:
        args.append(a.vararg)
    if a.kwarg is not None:
        args.append(a.kwarg)
    for i, arg in enumerate(args):
        if arg.arg in ("self", "cls") and i == 0:
            continue
        if arg.annotation is None:
            return False
    return node.returns is not None


def _prepass_returns(tree: ast.AST, w: "_Walker") -> None:
    """Record module-level functions that return a dangerous callable.

    Uses a throwaway walker over the module's imports so `return os.system`
    resolves through the same alias table the real walk will build.
    """
    scout = _Walker()
    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            scout.visit(node)
    for node in tree.body:
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for sub in ast.walk(node):
            if isinstance(sub, ast.Return) and sub.value is not None:
                r = scout._resolve_value(sub.value)
                if r and (r in DANGEROUS_CALLS or r in DANGEROUS_QUALIFIED
                          or r in _SUBPROCESS_CALLS or r in _FS_WRITE_CALLS):
                    w._returns_callable[node.name] = r
                    break


def returned_callables(source: str) -> dict[str, str]:
    """Module-level functions that return a dangerous callable: name → callable."""
    w = _Walker()
    try:
        _prepass_returns(ast.parse(source), w)
    except SyntaxError:
        return {}
    return dict(w._returns_callable)


def analyze_source(source: str, *, imported_returns: dict[str, str] | None = None) -> ModuleFacts:
    """Walk one module. Raises SyntaxError on unparseable input (that is G0's job).

    ``imported_returns`` maps LOCAL names of functions imported from other
    skill modules to the dangerous callable they return, so that
    ``from scripts.helpers import get`` + ``get()(cmd)`` resolves across the
    module boundary (built by the G1 gate from `returned_callables`).
    """
    tree = ast.parse(source)
    w = _Walker()
    _prepass_returns(tree, w)
    for name, target in (imported_returns or {}).items():
        w._returns_callable.setdefault(name, target)
    w.visit(tree)
    if not w.f.side_effects:
        w.f.side_effects.add("none")
    return w.f
