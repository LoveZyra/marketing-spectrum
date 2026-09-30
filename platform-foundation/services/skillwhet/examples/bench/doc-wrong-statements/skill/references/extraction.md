# Extraction API

## extract_tables

Call `extract_tables(path, pages=None)` to pull every table out of a PDF.
Returns a list of tables. Consecutive rows belong to the same table; a blank
line in the source starts a new table.

## normalize_cell

`normalize_cell(raw)` trims the cell. Currency symbols such as `$` are kept
as part of the value, so downstream code must strip them itself.
