from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal

from app.pipeline import results


def test_cells_are_json_safe() -> None:
    assert results.to_cell(Decimal("12.50")) == 12.5
    assert results.to_cell(Decimal("3000.00")) == 3000
    assert results.to_cell(date(2026, 1, 2)) == "2026-01-02"
    assert results.to_cell(datetime(2026, 1, 1, tzinfo=UTC)) == "2026-01-01"  # DATE_TRUNC output
    assert results.to_cell(datetime(2026, 1, 1, 9, 30)) == "2026-01-01T09:30:00"
    assert results.to_cell(b"\x00\x01") == "(binary data)"
    assert results.to_cell("x" * 5000) == "x" * 1000


def test_table_columns_types_and_masking() -> None:
    table = results.build_table(
        ["region", "total_amount", "count", "email"],
        [("Europe", Decimal("10.5"), 3, "secret@example.com"), ("Asia", Decimal("20"), 4, "x@example.com")],
        masked={"email"},
    )
    types = {c["key"]: (c["type"], c.get("masked", False)) for c in table["columns"]}
    assert types == {
        "region": ("string", False),
        "total_amount": ("currency", False),
        "count": ("number", False),
        "email": ("string", True),
    }
    # Even if a hidden value somehow arrived, it never leaves as anything but null.
    assert [row["email"] for row in table["rows"]] == [None, None]


def test_duplicate_column_names_get_unique_keys() -> None:
    table = results.build_table(["name", "name"], [("a", "b")], set())
    assert [c["key"] for c in table["columns"]] == ["name", "name_2"]


def test_chart_only_when_it_fits() -> None:
    grouped = results.build_table(["status", "total_amount"], [("paid", 1), ("shipped", 2)], set())
    assert results.chart_for(grouped) == {"type": "bar", "x": "status", "series": ["total_amount"]}
    monthly = results.build_table(["month", "count"], [(date(2026, 1, 1), 1), (date(2026, 2, 1), 2)], set())
    assert results.chart_for(monthly)["type"] == "line"  # type: ignore[index]
    single = results.build_table(["count"], [(5,)], set())
    assert results.chart_for(single) is None
    listing = results.build_table(["id", "name", "category"], [(1, "a", "b"), (2, "c", "d")], set())
    assert results.chart_for(listing) is None


def test_template_summaries() -> None:
    single = results.build_table(["total_amount"], [(Decimal("1234567.5"),)], set())
    assert results.template_summary("q", single, 1, False).summary == "The total amount is $1,234,568."
    grouped = results.build_table(
        ["region", "total_amount"], [("Asia", 50), ("Europe", 900), ("Africa", 10)], set()
    )
    summary = results.template_summary("q", grouped, 3, False)
    assert summary.summary.startswith(
        "Europe has the highest total amount ($900.00), followed by Asia ($50.00)"
    )
    assert summary.highlights[0] == {"label": "Europe", "value": "$900.00"}
    empty = results.build_table(["a"], [], set())
    assert results.template_summary("q", empty, 0, False).summary == "No matching data was found."
    listing = results.build_table(["name", "email"], [("a", "x")], {"email"})
    text = results.template_summary("q", listing, 900, True).summary
    assert (
        "900 matching rows" in text
        and "Showing the first 1" in text
        and "Hidden by data policy: email" in text
    )


def test_csv_neutralises_formulas_and_watermarks() -> None:
    table = results.build_table(
        ["name", "amount"], [('=HYPERLINK("http://evil")', -5), ("+1", 3), ("@x", 1)], set()
    )
    text = results.to_csv("Confidential — exported by Marcus", table, limit=2)
    lines = text.strip().split("\r\n")
    assert lines[0] == "Confidential — exported by Marcus"
    assert lines[2].startswith("\"'=HYPERLINK") and lines[2].endswith(",-5")  # numbers stay numbers
    assert lines[3] == "'+1,3"
    assert len(lines) == 4  # the export row limit applies
