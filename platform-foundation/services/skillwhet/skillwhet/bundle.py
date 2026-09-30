"""Atomic bundles: cross-carrier commits that are all-or-nothing.

Any change touching a ``stable`` entrypoint must move code, contract and prose
in one indivisible commit. Allowing "the code passed so ship the code" is
exactly how contract drift is manufactured.

SkillSmith (2606.01314) measures the value of coupling: locking its tool layer
costs -6.8%, the single largest effect in its ablation.
"""
from __future__ import annotations

import os
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from .contract import collect_facts, derive_contract, load_contract, save_contract
from .fs import iter_skill_files
from .edits import EditReport, apply_bundle_to_dir, apply_doc_edit, editable_path, snapshot
from .gates import build_fast_pyramid, run_pyramid
from .gates.pyramid import PyramidConfig
from .provenance import require_provenance
from .types import Bundle, Contract, PyramidResult


@dataclass
class CommitResult:
    accepted: bool
    bundle: Bundle
    pyramid: PyramidResult | None = None
    edit_reports: list[EditReport] = field(default_factory=list)
    reason: str = ""
    contract_after: Contract | None = None
    extra: dict = field(default_factory=dict)     # pre-promote checks (G6, mutation)

    def to_dict(self) -> dict:
        return {
            "accepted": self.accepted,
            "digest": self.bundle.digest(),
            "origin": self.bundle.origin,
            "reason": self.reason,
            "edits": [r.to_dict() for r in self.edit_reports],
            "pyramid": self.pyramid.to_dict() if self.pyramid else None,
            "extra": self.extra,
        }


def materialize(skill_dir: Path, bundle: Bundle, work: Path) -> tuple[Path, list[EditReport]]:
    """Apply a bundle to a throwaway copy. The original is never touched."""
    cand = snapshot(skill_dir, work)
    reports = apply_bundle_to_dir(cand, bundle.code_edits)

    for de in bundle.doc_edits:
        p = editable_path(cand, de.path, "doc")
        if p is None:
            reports.append(EditReport(de.op, de.path, "", "refused_outside_surface",
                                      "doc edits may only touch SKILL.md and references/*.md"))
            continue
        if not p.exists():
            reports.append(EditReport(de.op, de.path, "", "skipped_doc_missing"))
            continue
        text, rep = apply_doc_edit(p.read_text(encoding="utf-8"), de)
        p.write_text(text, encoding="utf-8")
        reports.append(rep)

    # Signatures are derived, never hand-written, so a code edit that moved a
    # signature updates the contract here rather than drifting from it.
    base = load_contract(cand)
    refreshed, _ = derive_contract(cand, base=base)
    if bundle.contract_delta:
        for e in refreshed.entrypoints:
            patch = bundle.contract_delta.get(e.id)
            if isinstance(patch, dict):
                changed = []
                for k, v in patch.items():
                    if hasattr(e, k) and k != "signature" and getattr(e, k) != v:
                        setattr(e, k, v)
                        changed.append(k)
                if changed:
                    reports.append(EditReport("contract_delta", "CONTRACT.yaml", e.id,
                                              "applied_contract_delta", ",".join(changed)))
    save_contract(cand, refreshed)
    return cand, reports


def stable_drift(pre: Contract, cand_dir: Path) -> list[tuple[str, str, str]]:
    """Stable entrypoints whose signature the candidate changed: (id, old, new).

    Measured against the PRE-edit contract. `materialize` re-derives signatures
    from the candidate AST before the pyramid runs, so G3 alone can never see a
    unilateral drift — it compares the candidate with a contract that was just
    rewritten to match it. This is the check the whole design exists for, and
    the audit found it had no path to fire.
    """
    facts = collect_facts(cand_dir)
    out = []
    for e in pre.entrypoints:
        if e.stability != "stable" or not e.signature:
            continue
        f = facts.get(e.module)
        actual = f.functions.get(e.id) if f else None
        if actual is None or actual != e.signature:
            out.append((e.id, e.signature, actual or "<missing>"))
    return out


def _carries_drift(bundle: Bundle, pre: Contract, drift: list[tuple[str, str, str]]) -> str:
    """'' if the bundle moves contract and prose together with the code, else why not."""
    anchors = {e.id: e.doc_anchor for e in pre.entrypoints}
    touched_docs = {d.path for d in bundle.doc_edits}
    for eid, _old, _new in drift:
        if eid not in (bundle.contract_delta or {}):
            return f"stable entrypoint {eid!r} changed signature without a contract_delta"
        anchor_file = anchors.get(eid, "").split("#")[0]
        if anchor_file and anchor_file not in touched_docs:
            return (f"stable entrypoint {eid!r} changed signature but the bundle does "
                    f"not edit its documentation ({anchor_file})")
    return ""


@dataclass
class Evaluation:
    """A materialised, fully gated candidate that has NOT been promoted.

    Kept alive (its work dir is not deleted) so the caller can compare several
    of them and promote the best one — the SkillOpt "best of K" that a
    promote-the-first-that-passes loop throws away. Call ``discard()`` when
    done; ``commit()`` does this for you.
    """
    result: CommitResult
    cand_dir: Path | None = None
    diff_lines: int = 0
    rank_key: tuple = ()

    @property
    def viable(self) -> bool:
        return self.cand_dir is not None and self.result.pyramid is not None \
            and self.result.pyramid.passed and self.result.reason == "viable"

    def discard(self) -> None:
        if self.cand_dir is not None:
            shutil.rmtree(self.cand_dir, ignore_errors=True)
            self.cand_dir = None


def _diff_lines(skill_dir: Path, cand: Path, bundle: Bundle) -> int:
    """Changed lines across the modules a bundle touches (smaller is better)."""
    import difflib
    n = 0
    for rel in sorted({e.module for e in bundle.code_edits} | {d.path for d in bundle.doc_edits}):
        a = (Path(skill_dir) / rel)
        b = (Path(cand) / rel)
        at = a.read_text(encoding="utf-8").splitlines() if a.is_file() else []
        bt = b.read_text(encoding="utf-8").splitlines() if b.is_file() else []
        n += sum(1 for ln in difflib.unified_diff(at, bt, lineterm="", n=0)
                 if ln[:1] in "+-" and not ln.startswith(("+++", "---")))
    return n


_GATE_BASELINES: dict[tuple[str, str, tuple[str, ...]], dict[str, list[str]]] = {}


def gate_baseline(skill_dir: Path, gates) -> dict[str, list[str]]:
    """Findings the PARENT already has on the relative gates (G1 / G2), as fingerprints.

    Cached per (skill dir, bundle hash, gate names) in memory and in
    ``.evo/gate_baseline.json`` — pyright on a real skill takes seconds, and the
    parent only changes when a round accepts something.
    """
    import json

    from .gates.pyramid import RELATIVE_GATES, finding_key
    from .staging import bundle_hash
    rel = [g for g in gates if getattr(g, "name", "") in RELATIVE_GATES]
    if not rel:
        return {}
    skill_dir = Path(skill_dir)
    names = tuple(sorted(g.name for g in rel))
    digest = bundle_hash(skill_dir)
    key = (str(skill_dir.resolve()), digest, names)
    if key in _GATE_BASELINES:
        return _GATE_BASELINES[key]
    cache = skill_dir / ".evo" / "gate_baseline.json"
    try:
        data = json.loads(cache.read_text(encoding="utf-8"))
        if data.get("hash") == digest and tuple(data.get("gates") or ()) == names:
            _GATE_BASELINES[key] = data["findings"]
            return data["findings"]
    except (OSError, ValueError, KeyError, TypeError):
        pass
    res = run_pyramid(skill_dir, load_contract(skill_dir), rel, short_circuit=False)
    out = {r.gate: [finding_key(f) for f in r.findings] for r in res.results if r.findings}
    _GATE_BASELINES[key] = out
    if cache.parent.is_dir():
        try:
            cache.write_text(json.dumps({"hash": digest, "gates": list(names), "findings": out},
                                        ensure_ascii=False), encoding="utf-8")
        except OSError:
            pass
    return out


def evaluate(
    skill_dir: Path,
    bundle: Bundle,
    *,
    work_root: Path,
    cfg: PyramidConfig | None = None,
    gates=None,
    pre_promote: Callable[[Path, Bundle], tuple[bool, str, dict]] | None = None,
    baseline_tests: dict[str, bool] | None = None,
) -> Evaluation:
    """Materialise + gate + pre-promote checks; never promotes.

    Returns an Evaluation whose ``result.reason`` is ``"viable"`` when every
    check passed. The candidate directory stays on disk until ``discard()``.
    """
    if bundle.is_empty():
        return Evaluation(CommitResult(False, bundle, reason="empty bundle"))
    try:
        require_provenance(bundle)
    except Exception as exc:  # noqa: BLE001 - MissingProvenance and friends
        return Evaluation(CommitResult(False, bundle, reason=f"provenance: {exc}"))

    work = Path(work_root) / f"cand-{bundle.digest()}"
    pre_contract = load_contract(skill_dir)
    cand, reports = materialize(skill_dir, bundle, work)
    ev = Evaluation(CommitResult(False, bundle, edit_reports=reports), cand_dir=cand)

    refused = [r for r in reports if r.status.startswith("refused")]
    if refused:
        ev.result.reason = (f"refused: {refused[0].module} is outside the editable surface")
        ev.discard()
        return ev
    if not any(r.applied for r in reports):
        ev.result.reason = "no edit applied"
        ev.discard()
        return ev

    drift = stable_drift(pre_contract, cand)
    if drift:
        why = _carries_drift(bundle, pre_contract, drift)
        if why:
            ev.result.reason, ev.result.extra = f"contract drift: {why}", {"drift": drift}
            ev.discard()
            return ev

    gate_list = gates or build_fast_pyramid(cfg)
    res = run_pyramid(cand, load_contract(cand), gate_list,
                      baseline_tests=baseline_tests,
                      baseline_findings=gate_baseline(skill_dir, gate_list))
    ev.result.pyramid = res
    if not res.passed:
        ev.result.reason = f"rejected at {res.stopped_at}"
        ev.discard()
        return ev

    extra: dict = {}
    if pre_promote is not None:
        ok, why, extra = pre_promote(cand, bundle)
        ev.result.extra = extra
        if not ok:
            ev.result.reason = why
            ev.discard()
            return ev

    ev.result.reason = "viable"
    ev.diff_lines = _diff_lines(skill_dir, cand, bundle)
    replay = (extra.get("replay") or {})
    mutation = (extra.get("mutation") or {})
    contract_fixed = next((int(r.detail.get("contract_checks_repaired", 0))
                           for r in res.results if r.gate == "G3.contract"), 0)
    # Higher is better on every component: repaired tasks, repaired CONTRACT
    # checks, replay mean, mutation score, then the SMALLER diff (negated).
    # A candidate that repairs more wins outright; ties go to the least
    # invasive change. The contract term exists because minimality is
    # anti-correlated with generality once the visible tasks all pass
    # (measured, REVIEW §9.4): a stated example is the cheapest way to make
    # "handles the general case" visible to a zero-LLM ranking.
    ev.rank_key = (replay.get("repaired", 0), contract_fixed, replay.get("score", 0.0),
                   mutation.get("score", 0.0), -ev.diff_lines)
    return ev


def promote(ev: Evaluation, skill_dir: Path) -> CommitResult:
    """Land a viable evaluation in *skill_dir* and release its work dir."""
    if not ev.viable or ev.cand_dir is None:
        raise ValueError("only a viable evaluation can be promoted")
    try:
        _promote(ev.cand_dir, skill_dir)
        ev.result.accepted = True
        ev.result.reason = "accepted"
        ev.result.contract_after = load_contract(skill_dir)
        return ev.result
    finally:
        ev.discard()


def commit(
    skill_dir: Path,
    bundle: Bundle,
    *,
    work_root: Path,
    cfg: PyramidConfig | None = None,
    gates=None,
    pre_promote: Callable[[Path, Bundle], tuple[bool, str, dict]] | None = None,
    baseline_tests: dict[str, bool] | None = None,
) -> CommitResult:
    """Try one bundle. Either every gate passes and it lands, or nothing changes.

    ``pre_promote(cand_dir, bundle) -> (ok, reason, detail)`` runs after the free
    gates and before promotion. The fast loop uses it for G6 per-patch replay and
    the mutation floor — checks that need a materialised candidate but must not
    be paid for on candidates that already failed a free gate.
    """
    ev = evaluate(skill_dir, bundle, work_root=work_root, cfg=cfg, gates=gates,
                  pre_promote=pre_promote, baseline_tests=baseline_tests)
    if not ev.viable:
        ev.discard()
        return ev.result
    return promote(ev, skill_dir)


def _tree(root: Path) -> dict[Path, Path]:
    return {item.relative_to(root): item for item in iter_skill_files(root)}


def _same(a: Path, b: Path) -> bool:
    try:
        return a.stat().st_size == b.stat().st_size and a.read_bytes() == b.read_bytes()
    except OSError:
        return False


def _promote(cand: Path, target: Path) -> None:
    """Move the candidate's changes into *target*; all of them or none of them.

    Only files that differ are touched. Each is written to a sibling temp file
    and swapped in with ``os.replace``; if any step fails, every file already
    swapped is restored from its backup before the error propagates, so a
    half-applied bundle cannot exist. Hold-out and contract tests are never
    written to at all.
    """
    target = Path(target)
    src, dst = _tree(cand), _tree(target)
    to_write = [rel for rel, p in src.items()
                if rel not in dst or not _same(p, dst[rel])]
    to_delete = [rel for rel in dst if rel not in src]
    protected = ("tests/holdout", "tests/contract")
    for rel in to_write + to_delete:
        if rel.as_posix().startswith(protected):
            raise PermissionError(f"bundle attempted to change {rel}")

    backups: list[tuple[Path, Path | None]] = []      # (final path, backup or None)
    try:
        for rel in to_write:
            final = target / rel
            final.parent.mkdir(parents=True, exist_ok=True)
            bak = None
            if final.exists():
                bak = final.with_name(final.name + ".whet-bak")
                shutil.copy2(final, bak)
            backups.append((final, bak))          # registered BEFORE anything can fail
            tmp = final.with_name(final.name + ".whet-tmp")
            shutil.copy2(src[rel], tmp)
            os.replace(tmp, final)
        for rel in to_delete:
            final = target / rel
            bak = final.with_name(final.name + ".whet-bak")
            shutil.copy2(final, bak)
            backups.append((final, bak))
            final.unlink()
    except Exception:
        for final, bak in reversed(backups):
            if bak is not None and bak.exists():
                os.replace(bak, final)
            elif bak is None and final.exists():
                final.unlink()
        raise
    finally:
        for final, bak in backups:
            if bak is not None and bak.exists():
                bak.unlink()
            tmp = final.with_name(final.name + ".whet-tmp")
            if tmp.exists():
                tmp.unlink()


def needs_atomic_bundle(bundle: Bundle, contract: Contract) -> bool:
    """True when the bundle touches a stable entrypoint and so may not ship alone."""
    stable = {(e.module, e.id) for e in contract.entrypoints if e.stability == "stable"}
    for e in bundle.code_edits:
        if e.op in ("delete_function", "rewrite_module"):
            if any(m == e.module for m, _ in stable):
                return True
        if (e.module, e.symbol) in stable and e.op in (
            "replace_function", "delete_function"
        ):
            return True
    return False
