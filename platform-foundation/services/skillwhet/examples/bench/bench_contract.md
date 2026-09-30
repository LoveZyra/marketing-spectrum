| config | case | rep | baseline | best | Δ | test S0 → best | rounds | accepted | cost | time |
|---|---|---|---|---|---|---|---|---|---|---|
| first-wins | code-currency-contract | 1 | 0.500 | 1.000 | +0.500 | 0.000 → 1.000 | 2 | 2 | $0.05 | 101s |
| first-wins | code-currency-contract | 2 | 0.500 | 1.000 | +0.500 | 0.000 → 0.000 | 2 | 2 | $0.05 | 99s |
| first-wins | code-currency-contract | 3 | 0.500 | 1.000 | +0.500 | 0.000 → 1.000 | 2 | 2 | $0.04 | 74s |
| full | code-currency-contract | 1 | 0.500 | 1.000 | +0.500 | 0.000 → 1.000 | 2 | 2 | $0.07 | 137s |
| full | code-currency-contract | 2 | 0.500 | 1.000 | +0.500 | 0.000 → 1.000 | 2 | 2 | $0.06 | 118s |
| full | code-currency-contract | 3 | 0.500 | 1.000 | +0.500 | 0.000 → 1.000 | 2 | 2 | $0.05 | 105s |
| no-dedup | code-currency-contract | 1 | 0.500 | 1.000 | +0.500 | 0.000 → 1.000 | 2 | 2 | $0.05 | 99s |
| no-dedup | code-currency-contract | 2 | 0.500 | 1.000 | +0.500 | 0.000 → 1.000 | 2 | 2 | $0.04 | 78s |
| no-dedup | code-currency-contract | 3 | 0.500 | 1.000 | +0.500 | 0.000 → 1.000 | 2 | 2 | $0.07 | 125s |
| no-refine | code-currency-contract | 1 | 0.500 | 1.000 | +0.500 | 0.000 → 1.000 | 2 | 2 | $0.07 | 124s |
| no-refine | code-currency-contract | 2 | 0.500 | 1.000 | +0.500 | 0.000 → 1.000 | 2 | 2 | $0.05 | 96s |
| no-refine | code-currency-contract | 3 | 0.500 | 1.000 | +0.500 | 0.000 → 1.000 | 2 | 2 | $0.07 | 124s |

| config | runs | mean Δ val | mean Δ test (± spread across repeats) | improved | total cost |
|---|---|---|---|---|---|
| full | 3 | +0.500 | +1.000 ± 0.000 | 3/3 | $0.19 |
| first-wins | 3 | +0.500 | +0.667 ± 1.000 | 3/3 | $0.15 |
| no-refine | 3 | +0.500 | +1.000 ± 0.000 | 3/3 | $0.19 |
| no-dedup | 3 | +0.500 | +1.000 ± 0.000 | 3/3 | $0.17 |
