import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
from scripts.norm import dedupe_lines, slugify, word_count


def test_slugify_empty_and_punctuation_only():
    assert slugify("") == "" and slugify("!!!") == ""


def test_dedupe_trailing_whitespace_is_ignored():
    assert dedupe_lines("a  \na\nb") == "a  \nb"


def test_word_count_empty():
    assert word_count("   ") == 0
