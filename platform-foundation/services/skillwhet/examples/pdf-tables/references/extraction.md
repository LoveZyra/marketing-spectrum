# Extraction API

## extract_tables

Call `extract_tables(path, pages=None)` to pull every table out of a PDF.
Returns a list of tables; an empty list when the document has none.
It never raises on a well-formed but table-free document.

## normalize_cell

`normalize_cell(raw)` collapses whitespace and strips currency symbols.
