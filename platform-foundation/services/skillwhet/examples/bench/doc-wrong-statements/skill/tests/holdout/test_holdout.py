import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
from scripts.extract import extract_tables, normalize_cell


def test_empty_document_returns_empty_list(tmp_path):
    f = tmp_path / "empty.txt"
    f.write_text("", encoding="utf-8")
    assert extract_tables(str(f)) == []


def test_normalize_cell_is_idempotent():
    once = normalize_cell(" $12.50 ")
    assert normalize_cell(once) == once
