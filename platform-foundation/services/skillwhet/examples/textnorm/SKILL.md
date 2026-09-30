---
name: textnorm
description: Normalise free text into slugs, deduplicated lines and word counts.
---

# Text normalisation

Three helpers, all pure functions on strings: `slugify`, `dedupe_lines`,
`word_count`. See `references/api.md` for the exact behaviour of each.
Never call the shell; never read or write files.
