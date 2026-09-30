import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
from scripts.extract import extract_tables, normalize_cell


def test_normalize_cell_strips_currency():
    assert normalize_cell("  $ 1 234 ") == "1 234"


def test_extract_tables_splits_on_blank_line(tmp_path):
    f = tmp_path / "doc.txt"
    f.write_text("a|b\nc|d\n\ne|f\n", encoding="utf-8")
    assert extract_tables(str(f)) == [[["a", "b"], ["c", "d"]], [["e", "f"]]]
