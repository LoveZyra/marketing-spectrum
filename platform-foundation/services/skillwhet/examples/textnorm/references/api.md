# API

## slugify

`slugify(text, max_len=60)` lower-cases the text, replaces every run of
non-alphanumeric characters with a single `-`, strips leading and trailing
`-`, and truncates to `max_len` characters without leaving a trailing `-`.
Accented letters are folded to ASCII (`é` → `e`). An empty or all-punctuation
input returns `""`.

## dedupe_lines

`dedupe_lines(text, ignore_case=False)` removes duplicate lines while keeping
the FIRST occurrence and the original order. Trailing whitespace on a line is
ignored when comparing. With `ignore_case=True`, `Foo` and `foo` are the same
line.

## word_count

`word_count(text)` counts words separated by whitespace; hyphenated words
(`well-known`) count as one word, and standalone punctuation does not count.
