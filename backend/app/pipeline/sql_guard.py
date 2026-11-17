"""The gate every generated SQL query passes before it touches a database.

The AI (or the stand-in planner) proposes SQL; this module decides. It parses the query instead of
pattern-matching text, and only lets through:

- exactly one read-only statement (SELECT / WITH … SELECT / UNION of SELECTs) — no INTO, no FOR UPDATE;
- tables the admin exposed for this source, and only their exposed columns (`SELECT *` expands to those);
- functions the parser recognises — unknown ones such as pg_sleep, dblink or load_file are refused;
- hidden (masked) columns only where they can't leak: as a bare output column, which is replaced by
  NULL so the value is never even fetched, or as the direct argument of COUNT;
- a row limit no higher than the source's limit (plus one, to detect truncation).

The read-only database account and read-only session are the backstop if anything here were missed.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import sqlglot
from sqlglot import exp
from sqlglot.errors import OptimizeError, ParseError
from sqlglot.optimizer.qualify import qualify
from sqlglot.optimizer.scope import traverse_scope

DIALECTS = {"postgresql": "postgres", "mysql": "mysql"}

# Statement and clause types that change data, schema, session or locks.
FORBIDDEN_NODES: tuple[type[exp.Expression], ...] = (
    exp.Insert,
    exp.Update,
    exp.Delete,
    exp.Merge,
    exp.Create,
    exp.Drop,
    exp.Alter,
    exp.Command,
    exp.Into,
    exp.Lock,
    exp.Set,
    exp.Transaction,
    exp.Commit,
    exp.Rollback,
    exp.Use,
    exp.Copy,
    exp.LoadData,
    exp.Grant,
    exp.TruncateTable,
)


class QueryRejected(ValueError):
    """The query isn't allowed. The message is safe to show the person who asked."""


@dataclass(frozen=True)
class ExposedColumn:
    name: str
    type: str
    masked: bool


@dataclass(frozen=True)
class ExposedTable:
    namespace: str
    name: str
    columns: tuple[ExposedColumn, ...]


@dataclass
class GuardedQuery:
    sql: str  # what will run (row limit applied)
    count_sql: str  # the same query without the limit, wrapped in COUNT(*), used when results are truncated
    tables: list[tuple[str, str]]
    masked_outputs: set[str]  # output column names whose values are hidden (always NULL)
    limit: int


def tables_from_exposed(exposed: list[dict[str, Any]]) -> list[ExposedTable]:
    return [
        ExposedTable(
            e["namespace"],
            e["name"],
            tuple(ExposedColumn(f["name"], f.get("type", ""), bool(f.get("masked"))) for f in e["fields"]),
        )
        for e in exposed
    ]


def guard(sql: str, *, source_type: str, exposed: list[ExposedTable], row_limit: int) -> GuardedQuery:
    dialect = DIALECTS.get(source_type)
    if dialect is None:
        raise QueryRejected("Questions can't be answered from this type of database yet.")
    if not sql or len(sql) > 20_000:
        raise QueryRejected("The generated query was empty or too long.")

    try:
        statements = [s for s in sqlglot.parse(sql, read=dialect) if s is not None]
    except ParseError as exc:
        raise QueryRejected("The generated query couldn't be read.") from exc
    if len(statements) != 1:
        raise QueryRejected("Only a single query is allowed.")
    tree = statements[0]

    if not isinstance(tree, exp.Query):
        raise QueryRejected("Only read-only questions are allowed. CodeLens can't change data.")
    for node in tree.walk():
        if isinstance(node, FORBIDDEN_NODES):
            raise QueryRejected("Only read-only questions are allowed. CodeLens can't change data.")
        if isinstance(node, exp.Anonymous):
            raise QueryRejected(f"The function {node.name}() isn't allowed in questions.")

    # Only exposed tables. CTE names are local to the query, so they're allowed as table references.
    by_name = {(t.namespace.lower(), t.name.lower()): t for t in exposed}
    unqualified: dict[str, list[ExposedTable]] = {}
    for entry in exposed:
        unqualified.setdefault(entry.name.lower(), []).append(entry)
    cte_names = {cte.alias_or_name.lower() for cte in tree.find_all(exp.CTE)}
    used: list[tuple[str, str]] = []
    for table in tree.find_all(exp.Table):
        name, db = table.name.lower(), (table.db or "").lower()
        if not db and name in cte_names:
            continue
        if table.catalog:
            raise QueryRejected(f"The table {table.sql(dialect)} isn't available.")
        match = by_name.get((db, name)) if db else None
        if match is None and not db:
            candidates = unqualified.get(name, [])
            match = candidates[0] if len(candidates) == 1 else None
        if match is None:
            raise QueryRejected(f"The table {table.sql(dialect)} isn't one you can ask about.")
        # Always run against the exact exposed table, whatever search path the database has.
        table.set("db", exp.to_identifier(match.namespace))
        used.append((match.namespace, match.name))

    schema: dict[str, object] = {}
    for t in exposed:
        tables: dict[str, object] = schema.setdefault(t.namespace, {})  # type: ignore[assignment]
        tables[t.name] = {c.name: (c.type or "text") for c in t.columns}
    try:
        tree = qualify(
            tree, schema=schema, dialect=dialect, quote_identifiers=True, validate_qualify_columns=True
        )
    except OptimizeError as exc:
        raise QueryRejected(f"The query refers to data that isn't available: {_short(exc)}") from exc

    masked = {
        (t.namespace.lower(), t.name.lower(), c.name.lower()) for t in exposed for c in t.columns if c.masked
    }
    masked_outputs = _apply_masking(tree, masked, dialect)

    for star in tree.find_all(exp.Star):
        if not isinstance(star.parent, exp.Count):
            raise QueryRejected("The query must name the columns it returns.")

    limited, limit = _apply_limit(tree, row_limit)
    count_sql = exp.select("COUNT(*)").from_(tree.copy().subquery("q")).sql(dialect)
    return GuardedQuery(
        sql=limited.sql(dialect),
        count_sql=count_sql,
        tables=sorted(set(used)),
        masked_outputs=masked_outputs,
        limit=limit,
    )


def _short(exc: Exception) -> str:
    return str(exc).split(". Line")[0][:160]


def _apply_masking(tree: exp.Query, masked: set[tuple[str, str, str]], dialect: str) -> set[str]:
    """Replace bare hidden output columns with NULL; refuse hidden columns anywhere they could leak."""
    if not masked:
        return set()
    outermost = tree if isinstance(tree, exp.Select) else None
    masked_outputs: set[str] = set()

    for scope in traverse_scope(tree):
        for column in scope.columns:
            source = scope.sources.get(column.table)
            if not isinstance(source, exp.Table):
                continue
            key = ((source.db or "").lower(), source.name.lower(), column.name.lower())
            if key not in masked:
                continue
            parent = column.parent
            if isinstance(parent, exp.Count) or (
                isinstance(parent, exp.Distinct) and isinstance(parent.parent, exp.Count)
            ):
                continue  # counting hidden values reveals nothing about them
            if (
                outermost is not None
                and scope.expression is outermost
                and isinstance(parent, exp.Alias)
                and parent.parent is outermost
                and parent in outermost.expressions
            ):
                alias = parent.alias
                parent.set("this", exp.Null())
                masked_outputs.add(alias)
                continue
            raise QueryRejected(
                f"The column {column.name} is hidden by data policy. It can be counted, but not filtered, "
                "grouped or sorted by."
            )
    return masked_outputs


def _apply_limit(tree: exp.Query, row_limit: int) -> tuple[exp.Query, int]:
    cap = max(1, row_limit) + 1  # one extra row tells us the result was cut off
    existing = tree.args.get("limit")
    if isinstance(existing, exp.Limit):
        value = existing.expression
        if not (isinstance(value, exp.Literal) and value.is_int):
            raise QueryRejected("The query's row limit must be a plain number.")
        cap = min(cap, int(value.this))
    return tree.limit(cap), cap
