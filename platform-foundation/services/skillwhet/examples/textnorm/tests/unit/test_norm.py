import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
from scripts.norm import dedupe_lines, slugify, word_count


def test_slugify_basic():
    assert slugify("Hello, World!") == "hello-world"


def test_slugify_folds_accents():
    assert slugify("Café déjà vu") == "cafe-deja-vu"


def test_slugify_truncates_without_trailing_dash():
    assert slugify("a b c d e f", max_len=5) == "a-b-c"


def test_dedupe_keeps_first_and_order():
    assert dedupe_lines("b\na\nb\nc\na") == "b\na\nc"


def test_dedupe_ignore_case():
    assert dedupe_lines("Foo\nfoo\nBar", ignore_case=True) == "Foo\nBar"


def test_word_count_ignores_bare_punctuation():
    assert word_count("well-known fact -- really !") == 3
