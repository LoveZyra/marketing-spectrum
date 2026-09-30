# Benchmark results

Two campaigns. The `test` column is the generalisation probe — the seeded
knowledge asked a way training never saw — evaluated on S0 and on the winner.

* **2026-09-08**, `claude -p` (fast=haiku, slow=sonnet, eval=opus, target=haiku), `--rounds 2`, **one run per cell**.
* **2026-09-09**, same models, `--repeat 3 --jobs 4` on the four pytest cases: 48 runs, $3.56, 24 min wall.

Read the n=3 table first: it **reverses** two of the n=1 rankings, and §9.4 of
`REVIEW.md` explains why the probe moves at all.

## pytest cases, four configurations, **3 repeats** (`--ablate --repeat 3`)

| config | runs | mean Δ val | mean Δ test (± spread across repeats) | improved | total cost |
|---|---|---|---|---|---|
| full | 12 | +0.750 | **+0.750 ± 0.000** | 12/12 | $0.88 |
| first-wins | 12 | +0.750 | +0.667 ± 0.250 | 12/12 | $0.93 |
| no-refine | 12 | +0.750 | **+0.750 ± 0.000** | 12/12 | $0.85 |
| no-dedup | 12 | +0.750 | +0.500 ± 0.000 | 12/12 | $0.90 |

val is identical everywhere (haiku repairs every seeded defect within one
round). The whole spread lives in `code-currency`'s probe, and it is not a
function of the configuration but of **the winning patch's character class**:

| config | r1 | r2 | r3 | probe |
|---|---|---|---|---|
| full | `re.sub(r'[$€£¥]', '', raw)` | `[$€¥£¢]` | `[$€£¥₹]` | 1, 1, 1 |
| no-refine | `[$€£¥₹]` | `[$€¥£₹¢₽₩₪₦₨₱₡₲₴₵]` | `[\$£€¥₹₽]` | 1, 1, 1 |
| first-wins | `re.sub(r"[\s$]+", " ", raw)` | `[$€£¥]` | `.strip(" $")` | 0, 1, 0 |
| no-dedup | `re.sub(r"[\s$]+", " ", raw)` | same | same | 0, 0, 0 |

Every viable candidate tied on `(repaired, replay, mutation) = (1, 2.5, 0.0)`,
so the rank key fell through to its last component — the smallest diff — and
the one-line `[\s$]+` rewrite is always smaller than adding a currency class.
Minimality is anti-correlated with generality once the visible signals tie.
The fix is an `example` check in `CONTRACT.yaml` (REVIEW §9.4), not a weight.

## the fix, measured: `code-currency-contract` (`--repeat 3`)

Same seeded defect, plus one stated `example` (`"  £ 40 " → "40"`) the baseline
fails. The probe is still the euro test, never trained on, a different input
from the contract example.

| config | probe without the example | probe with it |
|---|---|---|
| full | 3/3 | **3/3** |
| no-refine | 3/3 | **3/3** |
| first-wins | 1/3 | 2/3 |
| no-dedup | **0/3** | **3/3** |
| total | 7/12 | **11/12** |

val is 12/12 in both columns; the second campaign cost $0.70. The selection is
visible in the wiki log — the candidate with half the diff loses:

```
r1 viable, not selected: 63b8c90406c0d30d rank=(1, 0, 2.5, 0.0, -2)
                 chosen: 144b3bf6079e08cc rank=(1, 1, 2.5, 0.0, -5)
```

`first-wins` is the one config that cannot benefit: it disables ranking
altogether, so nothing added to the rank key can help it. That exception is
the mechanism's own control. Per-run table: `bench_contract.md`.

An earlier campaign on this case measured **nothing** (8/12, rank key's second
slot 0 everywhere) because `whet bootstrap` was discarding the authored
CONTRACT.yaml's semantic half, `checks` included — REVIEW §9.5.

The per-run table is `bench_ablate3.md` as printed by `whet bench`; the
n=1 campaign below is kept for the comparison.

## pytest cases, four configurations, one run per cell (2026-09-08)

| config | case | baseline | best | Δ | test S0 → best | rounds | accepted | cost | time |
|---|---|---|---|---|---|---|---|---|---|
| full | code-currency | 0.500 | 1.000 | +0.500 | 0.000 → 1.000 | 2 | 2 | $0.09 | 124s |
| first-wins | code-currency | 0.500 | 1.000 | +0.500 | 0.000 → 0.000 | 2 | 2 | $0.07 | 133s |
| no-refine | code-currency | 0.500 | 1.000 | +0.500 | 0.000 → 0.000 | 2 | 2 | $0.04 | 85s |
| no-dedup | code-currency | 0.500 | 1.000 | +0.500 | 0.000 → 1.000 | 2 | 2 | $0.07 | 134s |
| full | code-two-defects | 0.000 | 1.000 | +1.000 | 0.000 → 1.000 | 2 | 3 | $0.08 | 102s |
| first-wins | code-two-defects | 0.000 | 1.000 | +1.000 | 0.000 → 1.000 | 2 | 3 | $0.10 | 170s |
| no-refine | code-two-defects | 0.000 | 1.000 | +1.000 | 0.000 → 1.000 | 2 | 3 | $0.09 | 152s |
| no-dedup | code-two-defects | 0.000 | 1.000 | +1.000 | 0.000 → 1.000 | 2 | 3 | $0.07 | 133s |
| full | tn-dedupe-count | 0.000 | 1.000 | +1.000 | 0.000 → 1.000 | 2 | 3 | $0.08 | 108s |
| first-wins | tn-dedupe-count | 0.000 | 1.000 | +1.000 | 0.000 → 1.000 | 2 | 3 | $0.05 | 106s |
| no-refine | tn-dedupe-count | 0.000 | 1.000 | +1.000 | 0.000 → 1.000 | 2 | 3 | $0.05 | 102s |
| no-dedup | tn-dedupe-count | 0.000 | 1.000 | +1.000 | 0.000 → 1.000 | 2 | 3 | $0.06 | 123s |
| full | tn-slugify | 0.500 | 1.000 | +0.500 | 0.000 → 0.000 | 2 | 2 | $0.05 | 71s |
| first-wins | tn-slugify | 0.500 | 1.000 | +0.500 | 0.000 → 0.000 | 2 | 2 | $0.04 | 86s |
| no-refine | tn-slugify | 0.500 | 1.000 | +0.500 | 0.000 → 0.000 | 2 | 2 | $0.04 | 82s |
| no-dedup | tn-slugify | 0.500 | 1.000 | +0.500 | 0.000 → 0.000 | 2 | 2 | $0.05 | 92s |

| config | cases | mean Δ val | mean Δ test | improved | total cost |
|---|---|---|---|---|---|
| full | 4 | +0.750 | +0.750 | 4/4 | $0.29 |
| first-wins | 4 | +0.750 | +0.500 | 4/4 | $0.27 |
| no-refine | 4 | +0.750 | +0.500 | 4/4 | $0.22 |
| no-dedup | 4 | +0.750 | +0.750 | 4/4 | $0.24 |

**Superseded.** Repeating each cell three times reversed `no-refine` and
`no-dedup`; the apparent best-of-K / refine advantage was sampling noise.


## prose cases, full configuration

| config | case | baseline | best | Δ | test S0 → best | rounds | accepted | cost | time |
|---|---|---|---|---|---|---|---|---|---|
| full | doc-missing-info | 0.128 | 0.500 | +0.372 | 0.075 → 0.960 | 2 | 1 | $0.54 | 189s |
| full | doc-wrong-statements | 0.653 | 0.967 | +0.313 | 0.000 → 0.975 | 2 | 1 | $0.49 | 168s |
| full | tn-doc-wrong | 0.325 | 0.325 | +0.000 | 0.000 → 0.000 | 2 | 2 | $0.69 | 230s |

| config | cases | mean Δ val | mean Δ test | improved | total cost |
|---|---|---|---|---|---|
| full | 3 | +0.228 | +0.620 | 2/3 | $1.72 |


`tn-doc-wrong` above ran before the ledger fix (an emphasised word, `LAST`, was protected as a constant and G8 blocked both rounds). After the fix:

| config | case | baseline | best | Δ | test S0 → best | rounds | accepted | cost | time |
|---|---|---|---|---|---|---|---|---|---|
| full | tn-doc-wrong | 0.335 | 0.765 | +0.430 | 0.000 → 0.975 | 2 | 1 | $0.45 | 202s |

| config | cases | mean Δ val | mean Δ test | improved | total cost |
|---|---|---|---|---|---|
| full | 1 | +0.430 | +0.975 | 1/1 | $0.45 |


## pairwise judge (`--pairwise-judge`), tn-doc-wrong

Round 1: candidate vs S0 answers on 3 val tasks — 2 wins / 0 losses / 1 tie (the untouched `word_count` doc), accepted; absolute score 0.717; probe 0.000 → 0.975; $0.60.
