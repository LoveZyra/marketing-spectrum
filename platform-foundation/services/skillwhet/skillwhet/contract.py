"""CONTRACT.yaml — the single coupling surface between prose and code.

Design rule: the *signature* half of the contract is DERIVED from the AST and
never hand-maintained, so signature drift is structurally impossible. Only the
semantic half (pre/postconditions, side_effects, stability, doc_anchor) is
authored by a human or a model, and that half is what G3 checks.
"""
from __future__ import annotations

import re
from dataclasses import replace
from pathlib import Path

import yaml

from .analysis import ModuleFacts, analyze_source
from .types import Contract, Entrypoint

CONTRACT_NAME = "CONTRACT.yaml"

# stdlib modules a skill may NOT import without declaring them in CONTRACT.allowed_imports:
# process / network / code-loading / deserialisation surfaces. Everything else in
# the standard library is harmless to import (hb: `gc`, `zlib`, `fractions` … used to
# fail G1 because the allowlist was a hand-picked 50-module list, not "the stdlib").
DANGEROUS_STDLIB = frozenset({
    "subprocess", "socket", "socketserver", "ssl", "asyncio", "selectors",
    "ctypes", "multiprocessing", "concurrent", "pty", "tty", "termios", "fcntl", "resource",
    "signal", "pickle", "pickletools", "marshal", "shelve", "dbm", "copyreg",
    "importlib", "imp", "zipimport", "pkgutil", "runpy", "code", "codeop", "builtins",
    "http", "urllib", "ftplib", "smtplib", "poplib", "imaplib", "telnetlib", "xmlrpc",
    "webbrowser", "mailbox", "nntplib",
})

# stdlib modules a skill may always import
DEFAULT_STDLIB_ALLOW = (
    {m for m in __import__("sys").stdlib_module_names if not m.startswith("_")} - DANGEROUS_STDLIB
) | {"__future__"}


def observed_imports(skill_dir: Path) -> set[str]:
    """Top-level imports of every non-test module in the bundle (not only ``scripts/``)."""
    from .fs import iter_skill_files
    root = Path(skill_dir)
    out: set[str] = set()
    for p in iter_skill_files(root, (".py",)):
        rel = p.relative_to(root)
        if rel.parts[0] in ("tests", "test", "node_modules"):
            continue
        try:
            out |= analyze_source(p.read_text(encoding="utf-8")).imports
        except (SyntaxError, UnicodeDecodeError, OSError):
            continue
    return out


def contract_path(skill_dir: Path) -> Path:
    return Path(skill_dir) / CONTRACT_NAME


def load_contract(skill_dir: Path) -> Contract:
    p = contract_path(skill_dir)
    if not p.exists():
        return Contract()
    data = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
    return Contract.from_dict(data)


def save_contract(skill_dir: Path, contract: Contract) -> Path:
    p = contract_path(skill_dir)
    p.write_text(
        yaml.safe_dump(contract.to_dict(), sort_keys=False, allow_unicode=True),
        encoding="utf-8",
    )
    return p


def iter_scripts(skill_dir: Path) -> list[Path]:
    """Public script modules, in stable order. ``_internal/`` is excluded."""
    root = Path(skill_dir) / "scripts"
    if not root.is_dir():
        return []
    out = [
        p for p in sorted(root.rglob("*.py"))
        if "_internal" not in p.relative_to(skill_dir).parts
        and not p.name.startswith("_")
    ]
    return out


def module_key(skill_dir: Path, path: Path) -> str:
    return Path(path).relative_to(skill_dir).as_posix()


def collect_facts(skill_dir: Path) -> dict[str, ModuleFacts]:
    """Analyze every public script. Unparseable modules are skipped (G0 owns them)."""
    facts: dict[str, ModuleFacts] = {}
    for p in iter_scripts(skill_dir):
        try:
            facts[module_key(skill_dir, p)] = analyze_source(p.read_text(encoding="utf-8"))
        except SyntaxError:
            continue
    return facts


# ── Derivation ──────────────────────────────────────────────────────────────


def derive_contract(
    skill_dir: Path,
    *,
    base: Contract | None = None,
    default_stability: str = "experimental",
) -> tuple[Contract, list[str]]:
    """Build (or refresh) a contract from the AST.

    Returns ``(contract, changes)``. Semantic fields on existing entrypoints are
    preserved verbatim; only ``signature`` is overwritten from source, because
    that is the field the AST is authoritative for.
    """
    base = base or Contract()
    facts = collect_facts(skill_dir)
    changes: list[str] = []

    existing = {(e.module, e.id): e for e in base.entrypoints}
    out: list[Entrypoint] = []
    seen: set[tuple[str, str]] = set()

    for module, f in facts.items():
        for qual, sig in f.functions.items():
            if qual.startswith("_") or "._" in qual:
                continue  # private
            key = (module, qual)
            seen.add(key)
            prev = existing.get(key)
            if prev is None:
                out.append(
                    Entrypoint(
                        id=qual,
                        module=module,
                        signature=sig,
                        side_effects=sorted(f.side_effects),
                        stability=default_stability,  # type: ignore[arg-type]
                    )
                )
                changes.append(f"+ entrypoint {module}::{qual}")
            else:
                if prev.signature != sig:
                    changes.append(
                        f"~ signature {module}::{qual}: {prev.signature!r} -> {sig!r}"
                    )
                out.append(replace(prev, signature=sig))

    for key, e in existing.items():
        if key not in seen:
            changes.append(f"- entrypoint {key[0]}::{key[1]} (gone from source)")

    allowed = sorted(set(base.allowed_imports)) or []
    return Contract(version=base.version or 1, allowed_imports=allowed, entrypoints=out), changes


def bootstrap_contract(skill_dir: Path, *, third_party: list[str] | None = None) -> Contract:
    """First-run contract: derive signatures, seed the import allowlist.

    An existing CONTRACT.yaml is the BASE, never a blank one. Starting from
    `Contract()` made `derive_contract` treat every entrypoint as new and
    silently discard the semantic half a maintainer had written — postconditions,
    doc_anchor, stability, and `checks` — which is exactly the half the AST
    cannot regenerate (audit §9.5: it cost a whole benchmark campaign that
    measured nothing, because the `example` checks never reached the run).
    """
    facts = collect_facts(skill_dir)
    observed = {m for f in facts.values() for m in f.imports}
    base = load_contract(skill_dir)
    base.version = base.version or 1
    base.allowed_imports = sorted(set(base.allowed_imports)
                                  | (observed & DEFAULT_STDLIB_ALLOW)
                                  | set(third_party or []))
    contract, _ = derive_contract(skill_dir, base=base)
    return contract


# ── Doc anchors ─────────────────────────────────────────────────────────────

_ANCHOR_RE = re.compile(r"^(?P<path>[^#]+)#(?P<frag>.+)$")
_HEADING_RE = re.compile(r"^\s{0,3}(#{1,6})\s+(?P<text>.+?)\s*#*\s*$", re.MULTILINE)


def slugify(text: str) -> str:
    """GitHub-style heading slug."""
    s = text.strip().lower()
    s = re.sub(r"[^\w\s一-鿿-]", "", s)
    s = re.sub(r"[\s_]+", "-", s)
    return s.strip("-")


def markdown_anchors(md_path: Path) -> set[str]:
    if not md_path.exists():
        return set()
    text = md_path.read_text(encoding="utf-8")
    return {slugify(m.group("text")) for m in _HEADING_RE.finditer(text)}


def resolve_anchor(skill_dir: Path, anchor: str) -> tuple[bool, str]:
    """Check ``references/foo.md#some-heading`` actually exists.

    Returns ``(ok, reason)``.
    """
    if not anchor:
        return True, ""
    m = _ANCHOR_RE.match(anchor)
    if not m:
        return False, f"malformed doc_anchor {anchor!r} (expected 'path.md#heading')"
    rel, frag = m.group("path"), m.group("frag")
    p = Path(skill_dir) / rel
    if not p.exists():
        return False, f"doc_anchor target missing: {rel}"
    want = slugify(frag)
    have = markdown_anchors(p)
    if want not in have:
        return False, f"heading '#{frag}' not found in {rel}"
    return True, ""
