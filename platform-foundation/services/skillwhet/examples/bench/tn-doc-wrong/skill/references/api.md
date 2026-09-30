# API

## slugify

`slugify(text, max_len=60)` lower-cases the text and replaces every run of
non-alphanumeric characters with a single `-`. Accented letters are left as
they are, so `é` stays `é` in the slug.

## dedupe_lines

`dedupe_lines(text, ignore_case=False)` removes duplicate lines, keeping the
LAST occurrence of each line. With `ignore_case=True`, `Foo` and `foo` are
the same line.

## word_count

`word_count(text)` counts words separated by whitespace; hyphenated words
(`well-known`) count as one word, and standalone punctuation does not count.
