# Seeded-defect benchmark cases

Each case is one of the example skills (`pdf-tables`, `textnorm`) with defects seeded and a task file.
`whet bench --cases examples/bench` trains every case under the full
configuration (and, with `--ablate`, under first-wins / no-refine / no-dedup)
and prints baseline / best / test / cost per case.

| case | runner | seeded defects |
|---|---|---|
| code-currency | pytest | wrong result: currency symbols no longer stripped |
| code-currency-contract | pytest | same defect, plus a stated `example` check in CONTRACT.yaml |
| code-two-defects | pytest | two crashes: `#` lines raise, `None` raises |
| doc-wrong-statements | agent | references contradict the code on two points |
| doc-missing-info | agent | references say almost nothing; the answers exist only in the code |
| tn-slugify | pytest | `textnorm`: accents not folded, truncation leaves a trailing `-` |
| tn-dedupe-count | pytest | `textnorm`: `dedupe_lines` ignores case/whitespace options, `word_count` counts punctuation |
| tn-doc-wrong | agent | `textnorm`: references say accents are kept and the LAST duplicate survives |

The `test` split of every case is a **generalisation probe**: the seeded
knowledge asked in a way training never saw (a `€` cell where training only
showed `$`; a trailing comment where training showed leading ones). It is
evaluated once, at the end, on S0 and on the winner.

`code-currency-contract` is the control for §9.4 of `REVIEW.md`: it differs
from `code-currency` by one line of `CONTRACT.yaml` — a stated `example`
(`"  £ 40 " → "40"`) that the seeded skill fails. The probe stays the euro
test, a different input the optimizer never sees. Comparing the two isolates
what making a stated behaviour executable does to which patch the search
selects (7/12 → 11/12 on the probe).

`--repeat N` runs each cell N times (scratch dirs get an `-rN` suffix) and
`--jobs N` runs N cells in parallel; the summary then reports the spread of
the per-repeat means. One run per cell is not enough to rank configurations —
that was learned the expensive way (`RESULTS.md`).

Cases are copied to a scratch directory before training; the originals are never touched.
