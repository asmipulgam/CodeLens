"""Turn database rows into the frontend's answer shape: typed columns, safe values, a chart when it
helps, and a plain-English summary when the AI isn't writing one."""

from __future__ import annotations

import csv
import io
import re
from datetime import date, datetime, time
from decimal import Decimal
from typing import Any

from app.llm.base import Summary

MONEY_NAME = re.compile(r"(amount|revenue|price|cost|sales|spend|value|income|turnover|gmv)", re.IGNORECASE)
MAX_TEXT = 1000
ISO_DATE_TEXT = re.compile(r"^\d{4}-\d{2}-\d{2}(?:[ T]00:00:00)?$")  # e.g. MySQL DATE_ADD results


def to_cell(value: object) -> str | int | float | bool | None:
    """JSON-safe cell values. Database text is untrusted: it is only ever rendered as text by the UI."""
    if value is None or isinstance(value, bool | int | str):
        return value[:MAX_TEXT] if isinstance(value, str) else value
    if isinstance(value, float):
        return round(value, 6)
    if isinstance(value, Decimal):
        number = float(value)
        return int(number) if number.is_integer() and abs(number) < 2**53 else round(number, 6)
    if isinstance(value, datetime):
        if value.time() == time(0) and (value.tzinfo is None or value.utcoffset() is not None):
            return value.date().isoformat()  # DATE_TRUNC results: show as a date, not midnight UTC
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, bytes | bytearray | memoryview):
        return "(binary data)"
    return str(value)[:MAX_TEXT]


def column_type(key: str, values: list[object]) -> str:
    sample = next((v for v in values if v is not None), None)
    if isinstance(sample, bool):
        return "boolean"
    if isinstance(sample, int | float | Decimal):
        if key.lower() in ("id",) or key.lower().endswith("_id") or key.lower() == "count":
            return "number"
        return "currency" if MONEY_NAME.search(key) else "number"
    if isinstance(sample, datetime):
        return (
            "date"
            if all(v is None or (isinstance(v, datetime) and v.time() == time(0)) for v in values)
            else "datetime"
        )
    if isinstance(sample, date):
        return "date"
    if isinstance(sample, str) and all(
        v is None or (isinstance(v, str) and ISO_DATE_TEXT.match(v)) for v in values
    ):
        return "date"
    return "string"


def label_of(key: str) -> str:
    return key.replace("_", " ").strip().capitalize() or key


def build_table(columns: list[str], raw_rows: list[tuple[object, ...]], masked: set[str]) -> dict[str, Any]:
    keys = _unique_keys(columns)
    out_columns: list[dict[str, Any]] = []
    for index, key in enumerate(keys):
        values = [row[index] for row in raw_rows]
        column: dict[str, Any] = {"key": key, "label": label_of(key), "type": column_type(key, values)}
        if columns[index] in masked:
            column.update(masked=True, type="string")
        if column["type"] == "currency":
            column["currency"] = "USD"
        out_columns.append(column)
    rows = [
        {key: (None if out_columns[i].get("masked") else to_cell(row[i])) for i, key in enumerate(keys)}
        for row in raw_rows
    ]
    for column in out_columns:
        if column["type"] == "date":
            for row in rows:
                value = row[column["key"]]
                if isinstance(value, str):
                    row[column["key"]] = value[:10]
    return {"kind": "table", "columns": out_columns, "rows": rows, "totalRows": len(rows)}


def _unique_keys(columns: list[str]) -> list[str]:
    seen: dict[str, int] = {}
    keys = []
    for name in columns:
        base = name or "column"
        seen[base] = seen.get(base, 0) + 1
        keys.append(base if seen[base] == 1 else f"{base}_{seen[base]}")
    return keys


def chart_for(table: dict[str, Any]) -> dict[str, Any] | None:
    """A chart only when the shape clearly suits one: one category or date column plus one to three
    numeric columns in the same unit, and between 2 and 60 rows."""
    columns = table["columns"]
    rows = table["rows"]
    if not 2 <= len(rows) <= 60:
        return None
    numeric = [c for c in columns if c["type"] in ("number", "currency") and not c["key"].endswith("id")]
    others = [c for c in columns if c not in numeric and not c.get("masked")]
    if len(others) != 1 or not 1 <= len(numeric) <= 3 or len({c["type"] for c in numeric}) != 1:
        return None
    x = others[0]
    return {
        "type": "line" if x["type"] in ("date", "datetime") else "bar",
        "x": x["key"],
        "series": [c["key"] for c in numeric],
    }


def format_value(value: object, kind: str) -> str:
    if value is None:
        return "—"
    if isinstance(value, int | float) and not isinstance(value, bool):
        if kind == "currency":
            return f"${value:,.0f}" if abs(value) >= 1000 else f"${value:,.2f}"
        return f"{value:,.0f}" if float(value).is_integer() else f"{value:,.2f}"
    return str(value)


def template_summary(question: str, table: dict[str, Any], total_rows: int, truncated: bool) -> Summary:
    """A plain description of the result, used when the AI doesn't write one (or isn't given rows)."""
    columns = table["columns"]
    rows = table["rows"]
    numeric = [c for c in columns if c["type"] in ("number", "currency") and not c["key"].endswith("id")]
    others = [c for c in columns if c not in numeric]
    if not rows:
        return Summary("No matching data was found.", [], [])

    if len(rows) == 1 and numeric and not others:
        parts = [f"{c['label'].lower()} is {format_value(rows[0][c['key']], c['type'])}" for c in numeric]
        sentence = "The " + " and the ".join(parts) + "."
        return Summary(
            sentence,
            [{"label": c["label"], "value": format_value(rows[0][c["key"]], c["type"])} for c in numeric[:3]],
            [],
        )

    if len(numeric) == 1 and len(others) == 1:
        measure, x = numeric[0], others[0]
        values = [
            (r[x["key"]], r[measure["key"]]) for r in rows if isinstance(r[measure["key"]], int | float)
        ]
        total = sum(v for _, v in values)
        if x["type"] in ("date", "datetime"):
            first, last = values[0], values[-1]
            low = min(values, key=lambda item: item[1])
            high = max(values, key=lambda item: item[1])
            sentence = (
                f"From {first[0]} to {last[0]}, {measure['label'].lower()} ranged from "
                f"{format_value(low[1], measure['type'])} ({low[0]}) to "
                f"{format_value(high[1], measure['type'])} "
                f"({high[0]})."
            )
            highlights = [
                {"label": "Highest", "value": f"{format_value(high[1], measure['type'])} ({high[0]})"},
                {"label": "Lowest", "value": f"{format_value(low[1], measure['type'])} ({low[0]})"},
                {"label": "Total", "value": format_value(total, measure["type"])},
            ]
        else:
            ranked = sorted(values, key=lambda item: item[1], reverse=True)
            best = format_value(ranked[0][1], measure["type"])
            lead = f"{ranked[0][0]} has the highest {measure['label'].lower()} ({best})"
            if len(ranked) > 1:
                lead += f", followed by {ranked[1][0]} ({format_value(ranked[1][1], measure['type'])})"
            sentence = f"{lead}. That's across {len(ranked)} {x['label'].lower()} values."
            highlights = [
                {"label": str(name), "value": format_value(v, measure["type"])} for name, v in ranked[:3]
            ]
        return Summary(sentence, highlights, [])

    sentence = f"Found {total_rows:,} matching row{'s' if total_rows != 1 else ''}."
    if truncated:
        sentence += f" Showing the first {len(rows):,}."
    hidden = [c["label"].lower() for c in columns if c.get("masked")]
    if hidden:
        sentence += f" Hidden by data policy: {', '.join(hidden)}."
    return Summary(sentence, [{"label": "Rows", "value": f"{total_rows:,}"}], [])


FORMULA_START = ("=", "+", "-", "@", "\t", "\r")


def csv_safe(value: object) -> str:
    """Stop spreadsheet apps from running cell contents as formulas (CSV injection)."""
    if value is None:
        return ""
    if isinstance(value, bool | int | float):
        return str(value)
    text = str(value)
    return "'" + text if text.startswith(FORMULA_START) else text


def to_csv(watermark: str, table: dict[str, Any], limit: int) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\r\n")
    writer.writerow([watermark])
    columns = table["columns"]
    writer.writerow([csv_safe(c["label"]) for c in columns])
    for row in table["rows"][:limit]:
        writer.writerow([csv_safe(row.get(c["key"])) for c in columns])
    return buffer.getvalue()
