# SkillWhet · 砺

> *To whet is to sharpen an existing blade — not to forge a new one.*
> 本系统只**打磨已有的 skill**，不负责创造新 skill —— 这是它与 SkillAlchemy / SkillFoundry 那类工作的分界。

Joint evolution of agent-skill **prose** and **code**, behind a zero-LLM gate pyramid.

Prose and code differ by 2–3 orders of magnitude in *verification* cost, so they
get two loops: code runs a fast loop whose gates cost nothing, prose runs a slow
loop whose gate is a full rollout. `CONTRACT.yaml` is the coupling surface
between them, and it is what makes interface drift a millisecond check instead
of an unlocalisable score drop.

## Status

Every module is implemented and wired into the main loop. 195 offline tests:
50 regression tests for the 48 findings of the 2026-09-07 audit (`REVIEW.md`
§2, all fixed) and 43 for the effectiveness mechanisms of `REVIEW.md` §1
(best-of-K, refine-with-findings, AST dedup, frontier focus, task synthesis,
trajectory + counterfactual attribution, separate doc measurement, guidance
citations/cap/retirement, judge median, gap monitor, result cache, contract
examples).

Measured with real models through `claude -p` on the seeded-defect benchmark
(`whet bench`, `examples/bench/RESULTS.md`; 7 cases over two example skills):
every case improved under every configuration, and the generalisation probes
— the seeded knowledge asked a way training never saw — went from 0 to ≥0.96
in all but one case (whose probe turned out to be tied to the reference
implementation). The prose loop rewrites wrong sentences in place (0% bloat).

Repeating the ablation three times per cell (48 runs) **overturned** the
single-run result: the configurations are indistinguishable on val, and the
probe differences came from which patch happened to win, not from the
configuration. Chasing that produced the sharpest finding so far — when every
visible signal ties, the search's last tie-break is the smallest diff, and
minimality is anti-correlated with generality (`REVIEW.md` §9.4). The answer
is a stated `example` check in `CONTRACT.yaml`, which makes the general case
observable to a zero-LLM ranking: on the same seeded defect the generalisation
probe goes from 7/12 to **11/12**, and the only configuration that does not
benefit is the one that disables ranking altogether.

| Component | State |
|---|---|
| `types` · `analysis` (alias-aware dataflow) · `contract` · `contract_tests` (incl. `example`) · `edits` | ✅ |
| `gates/` G0–G5 + pyramid + `assert_free`; G4/G5 relative to baseline | ✅ |
| `sandbox` — netns isolation, rlimits, timeout | ✅ |
| `backend` — `claude -p` (default), mock/scripted, OpenAI-compatible, `no_llm`, cost tracking | ✅ |
| `evidence` — tasks, splits, traceback parsing, clustering | ✅ |
| `attribute` — four-way routing | ✅ |
| `propose/` — P1 rules, P2 defect, P3 capability, doc (with governance advice + meta skill) | ✅ |
| `bundle` — atomic cross-carrier commit, pre-promote hook | ✅ |
| `runner` — pytest + agent + multi-turn simulation | ✅ |
| `expensive` — G6 per-patch replay, G7 hold-out, G8 governance | ✅ |
| `evolve_tests` — red-only admission, AST monotonicity, alternate rounds | ✅ |
| `slow_update` — longitudinal compare, protected SKILL.md field, optimizer meta-skill | ✅ |
| `simulate` — intent state machine, dual-sided verification (SkillEvo) | ✅ |
| `harvest` — Claude Code transcripts → redacted digests → rubric tasks | ✅ |
| `mutation` · `wiki` · `ledger` · `provenance` | ✅ |
| `staging` — stage → review → adopt, sha256-pinned | ✅ |
| `trainer` · `loops` · `cli` | ✅ |

Out of scope: non-Python scripts. Not yet measured: standard-benchmark numbers
(the harness is ready; a dataset is needed) and the prose loop on a real
document task set (`--runner agent|simulate|mixed` is wired; bring tasks).

## Quickstart

All model calls go through `claude -p` by default (fast loop: haiku, slow
loop: sonnet, evaluator: opus). Pass `--fast-backend mock` etc. to run offline.

```bash
pip install -e ".[gates,test]"

# does this backend return parseable JSON for every schema we use? (~$0.04)
whet probe --model haiku

# derive the contract from source (signatures are never hand-written)
whet bootstrap examples/pdf-tables        # freeze S0, derive contract, capture ledger

# run the free gate pyramid: G0 parse → G1 security → G2 static → G3 contract → G4/G5 tests
whet gate examples/pdf-tables -v

# run the evolution loop on a working copy (.evo/current); the live skill is untouched
whet train examples/pdf-tables --rounds 2 --tasks tasks.json
whet train examples/pdf-tables --tasks tasks.json --runner mixed   # pytest + agent + simulate tasks
whet status examples/pdf-tables
whet adopt examples/pdf-tables            # explicit; training never writes the live skill

# mine tasks from your own Claude Code sessions (secrets redacted before any model call)
whet harvest --project my-repo --out tasks.json
whet harvest --dry-run                    # list sessions, no model calls

# one multi-turn simulated-user run against a skill
whet simulate examples/pdf-tables --scenario scenario.json

# how noisy is the judge? same split, N times, spread per task (no training)
whet eval examples/pdf-tables --tasks tasks.json --split val --repeat 3 --runner agent --judge-samples 3

# the seeded-defect benchmark: every case in examples/bench, one table
whet bench --cases examples/bench --out bench.json            # add --ablate for first-wins / no-refine / no-dedup
whet bench --cases examples/bench --ablate --repeat 3 --jobs 4   # n=3 per cell, 4 in parallel

# see each gate stop the defect it exists for
python3 examples/demo.py

pytest -q
```

Useful `train` flags: `--runner agent|simulate|mixed` with `--target-model`
(the frozen model the skill is loaded into), `--judge-samples 3` (median of
three rubric verdicts) and `--pairwise-judge` (G7 as a side-by-side sign test
against the last accepted answers); `--synthesize-every 2` (grow the train set with
variants of agent tasks); `--counterfactual-budget N` / `--retire-budget N`
(prose-section ablation and guidance retirement, N roll-outs per round);
`--refine`, `--first-wins`, `--no-dedup`, `--escalate-after` (search);
`--mutation-floor 0.5`, `--no-replay`, `--tests-every N`, `--no-slow-update`,
`--no-meta-skill`, `--no-cache`.

## The gate pyramid

| Gate | Checks | Tool | Cost |
|---|---|---|---|
| G0 parse | syntax, libcst round-trip | `ast` + `libcst` | ~2ms |
| G1 security | import allowlist, dangerous calls through aliases / `getattr` / `__import__`, side-effect containment | AST visitor + `bandit` | ~130ms |
| G2 static | lint, types, complexity, anti-bloat rules | `ruff` + `pyright` | ~800ms |
| G3 contract | signature drift, doc-anchor liveness, effect containment, generated contract tests (relative to baseline) | `ast` + `pytest` | ~200ms |
| G4 unit | visible tests, judged **relative to baseline** (only regressions reject) | `pytest` | ~230ms |
| G5 holdout | tests the optimizer never sees, same relative rule | `pytest` | ~250ms |

Every one is deterministic and **costs zero model calls**. `assert_free()` enforces
that structurally: a fast-loop gate that needs an LLM is misdesigned.

After G0–G5 a candidate still has to pass the pre-promote hook: its repro test
must be **red before the fix and green after it**, G6 per-patch replay must
show no regression and at least one repaired task, and (optionally) the
mutation floor. Survivors of the same defect cluster are then ranked
`(tasks repaired, CONTRACT checks repaired, replay mean, mutation, −diff)` and
the best one lands in the working copy. The contract term is there because the
last one is dangerous alone: with everything else tied, "smallest diff" picks
the patch that handles `$` over the one that handles every currency symbol
(measured — `REVIEW.md` §9.4). G7 (hold-out
aggregate; strictly greater, or a tie backed by G6-verified train repairs) and
G8 (governance, dual-anchor S₀ / S_{t-1}) run once per round; a rejected round
rolls the working copy back to the last accepted state.

Code edits can only touch `scripts/*.py`, prose edits only `SKILL.md` and
`references/*.md` — the hold-out suite, contract tests and `.evo/` are outside
the optimizer's reach by construction, not by prompt.

## Backend: `claude -p`

`ClaudeCLIBackend` shells out to
`claude -p --output-format json --tools "" --no-session-persistence --max-turns 1`,
prompt on stdin, with a preamble that forbids tool use. Cost from the JSON
envelope is summed into `stats.cost_usd` and printed by `whet train`.
Measured: haiku ≈ $0.005/call, sonnet ≈ $0.009/call with cache hits.
