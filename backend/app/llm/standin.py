"""A stand-in for the AI model, used until Azure OpenAI is connected (CODELENS_LLM_PROVIDER=standin).

It is not AI: it matches the words of a question against the tables and columns the admin exposed and
builds SQL for common question shapes —

  "How many orders are there?"                 count
  "Total sales by region last month"           sum, grouped, time filter
  "Average order amount by status"             average, grouped
  "Top 5 customers by sales"                   join through customer_id, ranked
  "Show monthly revenue this year"             grouped by month
  "List products"                              rows

Everything it produces goes through exactly the same checks (sql_guard) as the real model's output.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

import sqlglot

from app.llm.base import (
    CannotAnswer,
    ClarifyPlan,
    EntityInfo,
    FieldInfo,
    Plan,
    PlanRequest,
    QueryPlan,
    SourceContext,
    Summary,
    SummaryRequest,
)

MONEY_WORDS = {
    "sale",
    "sales",
    "revenue",
    "income",
    "turnover",
    "spend",
    "spent",
    "value",
    "amount",
    "money",
    "earned",
    "earning",
    "earnings",
    "worth",
    "gmv",
}
METRIC_NAMES = ("revenue", "amount", "total", "value", "sales", "price", "unit_price", "cost")
MONEY_METRICS = ("revenue", "amount", "total", "value", "sales")  # what "sales" or "revenue" usually means
NUMERIC_TYPES = ("int", "numeric", "decimal", "double", "real", "float", "money", "bigint", "smallint")
DATE_TYPES = ("date", "timestamp", "datetime")
TIME_GRAINS = {
    "day": "day",
    "daily": "day",
    "week": "week",
    "weekly": "week",
    "month": "month",
    "monthly": "month",
    "quarter": "quarter",
    "quarterly": "quarter",
    "year": "year",
    "yearly": "year",
    "annual": "year",
    "annually": "year",
}
STOP = {
    "the",
    "a",
    "an",
    "of",
    "for",
    "in",
    "on",
    "by",
    "per",
    "each",
    "and",
    "to",
    "what",
    "which",
    "how",
    "is",
    "are",
    "was",
    "were",
    "show",
    "me",
    "list",
    "give",
    "get",
    "all",
    "our",
    "we",
    "do",
    "did",
    "have",
    "has",
    "many",
    "much",
    "number",
    "count",
    "total",
    "sum",
    "average",
    "avg",
    "mean",
    "top",
    "with",
    "from",
    "this",
    "last",
    "past",
    "year",
    "month",
    "week",
    "day",
    "days",
    "today",
    "yesterday",
    "there",
    "it",
    "that",
    "these",
    "those",
    "please",
    "can",
    "you",
    "tell",
    "about",
}


def _singular(word: str) -> str:
    if word.endswith("ies") and len(word) > 4:
        return word[:-3] + "y"
    if word.endswith("ses") and len(word) > 4:
        return word[:-2]
    if word.endswith("s") and not word.endswith("ss") and len(word) > 3:
        return word[:-1]
    return word


def _words(text: str) -> set[str]:
    raw = re.findall(r"[a-z0-9]+", text.lower())
    return set(raw) | {_singular(w) for w in raw}


def _is(field: FieldInfo, kinds: tuple[str, ...]) -> bool:
    return any(k in field.type.lower() for k in kinds)


def _q(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


@dataclass
class _Candidate:
    source: SourceContext
    entity: EntityInfo
    score: int


class StandInProvider:
    name = "standin"
    reads_results = False

    async def plan(self, request: PlanRequest) -> Plan:
        question = request.question.strip()
        words = _words(question)
        lowered = question.lower()

        candidates = self._rank(request.sources, words, lowered)
        tied: list[_Candidate] = []
        if request.clarification:
            chosen = [c for c in candidates if self._option_id(c) == request.clarification]
            candidates = chosen or candidates
        elif len(candidates) > 1 and candidates[0].score == candidates[1].score:
            tied = _collapse_joinable([c for c in candidates if c.score == candidates[0].score])[:4]
        if len(tied) == 1:
            candidates = tied
        elif tied:
            return ClarifyPlan(
                question="Which data should I use for this?",
                options=[
                    {
                        "id": self._option_id(c),
                        "label": f"{_title(c.entity.name)} ({c.source.name})",
                        "description": c.entity.description or c.source.description,
                    }
                    for c in tied
                ],
            )
        if not candidates:
            return CannotAnswer("I couldn't match this question to any of the data you can ask about.")

        best = candidates[0]
        return self._build(best, words, lowered)

    async def summarise(self, request: SummaryRequest) -> Summary | None:
        return None  # the pipeline's template summary is used

    async def close(self) -> None:
        return None

    # ── ranking ──

    @staticmethod
    def _option_id(candidate: _Candidate) -> str:
        return f"{candidate.source.id}:{candidate.entity.namespace}.{candidate.entity.name}"

    def _rank(self, sources: list[SourceContext], words: set[str], lowered: str = "") -> list[_Candidate]:
        ranked: list[_Candidate] = []
        money = bool(words & MONEY_WORDS) or _aggregate(words, lowered) in ("SUM", "AVG")
        target = _group_target(lowered)
        for source in sources:
            for entity in source.entities:
                score = 0
                stem = _singular(entity.name.lower())
                if stem == target:
                    score += 1  # "… by region": regions is how to group, not what is being asked about
                elif entity.name.lower() in words or stem in words:
                    score += 5  # the question names this table outright
                for part in re.split(r"[_\s]+", entity.name.lower()):
                    if len(part) > 2 and part in words and part != entity.name.lower():
                        score += 1
                for f in entity.fields:
                    if f.masked:
                        continue
                    parts = [p for p in f.name.lower().split("_") if len(p) > 2 and p != "id"]
                    if f.name.lower() in words or any(p in words for p in parts):
                        score += 1
                if money and any(
                    _is(f, NUMERIC_TYPES) and f.name.lower() in MONEY_METRICS for f in entity.fields
                ):
                    score += 2  # money questions are about tables that hold amounts
                if target and any(f.name.lower() == target for f in entity.fields if not f.masked):
                    score += 1  # "by region" fits a table with a region column best
                if score:
                    ranked.append(_Candidate(source, entity, score))
        ranked.sort(key=lambda c: (-c.score, c.entity.kind != "view", c.source.name, c.entity.name))
        return ranked

    # ── building SQL ──

    def _build(self, best: _Candidate, words: set[str], lowered: str) -> Plan:
        source = best.source
        entity = best.entity
        agg = _aggregate(words, lowered)
        top = re.search(r"\b(top|best|biggest|largest)\s*(\d+)?\b", lowered)
        bottom = re.search(r"\b(bottom|worst|smallest|least)\s*(\d+)?\b", lowered)
        rank = top or bottom
        if rank and agg is None:
            agg = "SUM"
        limit = int(rank.group(2)) if rank and rank.group(2) else (10 if rank else None)

        fact, dimension = entity, None
        metric = _metric(entity, words)
        named = metric is not None and _names(metric, words)
        if agg in ("SUM", "AVG") and not named and _fact_for(source, entity, words) is not None:
            metric = None  # "top products by revenue" means order amounts per product, not unit prices
        if agg in ("SUM", "AVG", "MAX", "MIN") and metric is None:
            # e.g. "top customers by sales": customers has no amount; orders does and has customer_id.
            join = _fact_for(source, entity, words)
            if join is None:
                return CannotAnswer(f"{_title(entity.name)} has no amounts to add up.")
            fact, dimension = join
            metric = _metric(fact, words)

        alias_f = "f"
        select: list[str] = []
        joins = ""
        group: list[str] = []
        order = ""
        parts: list[str] = []

        group_target = _group_target(lowered)
        grain = TIME_GRAINS.get(group_target or "") or next(
            (TIME_GRAINS[w] for w in ("monthly", "weekly", "daily", "quarterly", "yearly") if w in words),
            None,
        )
        date_col = _date_field(fact)

        if dimension is not None:
            label = _label_field(dimension)
            fk = f"{_singular(dimension.name.lower())}_id"
            joins = _join(dimension, f"{alias_f}.{_q(fk)}")
            select.append(f"d.{_q(label.name)} AS {_q(_singular(dimension.name.lower()))}")
            group.append(f"d.{_q(label.name)}")
            parts.append(f"matched each {_singular(fact.name)} to its {_singular(dimension.name)}")
        elif grain and date_col is not None:
            select.append(f"DATE_TRUNC('{grain}', {alias_f}.{_q(date_col.name)}) AS {_q(grain)}")
            group.append(f"DATE_TRUNC('{grain}', {alias_f}.{_q(date_col.name)})")
            order = f" ORDER BY {_q(grain)} NULLS FIRST"  # explicit, so MySQL needs no extra sort expression
            parts.append(f"grouped by {grain}")
        elif group_target:
            column = _field_named(fact, group_target)
            lookup = _lookup_for(source, column) if column is not None else None
            if lookup is not None and column is not None:
                label = _label_field(lookup)
                joins = _join(lookup, f"{alias_f}.{_q(column.name)}")
                select.append(f"d.{_q(label.name)} AS {_q(_singular(lookup.name.lower()))}")
                group.append(f"d.{_q(label.name)}")
                parts.append(f"grouped by {_singular(lookup.name)}")
            elif column is not None and not column.masked:
                select.append(f"{alias_f}.{_q(column.name)}")
                group.append(f"{alias_f}.{_q(column.name)}")
                parts.append(f"grouped by {column.name.replace('_', ' ')}")

        if agg is None and group:
            agg = "COUNT"
        if agg == "COUNT":
            select.append(f"COUNT(*) AS {_q('count')}")
            measure = "count"
            parts.insert(0, f"counted {fact.name.replace('_', ' ')}")
        elif agg is not None and metric is not None:
            measure = (
                {"SUM": "total", "AVG": "average", "MAX": "highest", "MIN": "lowest"}[agg] + "_" + metric.name
            )
            expression = f"{agg}({alias_f}.{_q(metric.name)})"
            if agg == "AVG":
                expression = f"ROUND({expression}, 2)"
            select.append(f"{expression} AS {_q(measure)}")
            verb = {
                "SUM": "added up",
                "AVG": "averaged",
                "MAX": "found the highest",
                "MIN": "found the lowest",
            }[agg]
            parts.insert(0, f"{verb} {metric.name.replace('_', ' ')} in {fact.name.replace('_', ' ')}")
        elif agg is not None:
            return CannotAnswer(f"I couldn't tell which amount in {_title(fact.name)} to use.")
        else:
            measure = ""
            shown = list(fact.fields[:8])  # hidden columns are returned empty and marked hidden
            select = [f"{alias_f}.{_q(f.name)}" for f in shown]
            if date_col is not None:
                order = f" ORDER BY {alias_f}.{_q(date_col.name)} DESC NULLS LAST"
            parts.insert(0, f"listed {fact.name.replace('_', ' ')}")

        where, when = _time_filter(lowered, date_col, alias_f)
        if when:
            parts.append(when)
        if rank and measure:
            order = f" ORDER BY {_q(measure)} {'DESC NULLS LAST' if top else 'ASC NULLS FIRST'}"
        elif measure and group and not order:
            order = f" ORDER BY {_q(measure)} DESC NULLS LAST"

        # Identifiers come from the admin-exposed schema and are quoted; sql_guard re-checks the result.
        sql = f"SELECT {', '.join(select)} FROM {_q(fact.namespace)}.{_q(fact.name)} AS {alias_f}{joins}"  # noqa: S608
        if where:
            sql += f" WHERE {where}"
        if group:
            sql += f" GROUP BY {', '.join(group)}"
        sql += order
        if limit:
            sql += f" LIMIT {limit}"

        dialect = {"postgresql": "postgres", "mysql": "mysql"}[source.type]
        if dialect != "postgres":
            sql = sqlglot.transpile(sql, read="postgres", write=dialect)[0]

        explanation = f"I used {source.name} and " + _sentence(parts) + "."
        return QueryPlan(source.id, sql, explanation, _follow_ups(fact, dimension, grain, date_col, when))


# ── helpers ─────────────────────────────────────────────────────────────────


def _collapse_joinable(tied: list[_Candidate]) -> list[_Candidate]:
    """If a tied table is what another tied table points to (orders.customer_id -> customers), keep only
    the one being pointed to: the planner joins the two itself."""
    keep = []
    for candidate in tied:
        stem = _singular(candidate.entity.name.lower())
        points_here = any(
            other is not candidate
            and other.source is candidate.source
            and any(f.name.lower() == f"{stem}_id" for f in other.entity.fields)
            for other in tied
        )
        pointed_from_tie = any(
            other is not candidate
            and other.source is candidate.source
            and any(
                f.name.lower() == f"{_singular(other.entity.name.lower())}_id"
                for f in candidate.entity.fields
            )
            for other in tied
        )
        if points_here or not pointed_from_tie:
            keep.append(candidate)
    return keep or tied


def _join(table: EntityInfo, key: str) -> str:
    return f" JOIN {_q(table.namespace)}.{_q(table.name)} AS d ON d.{_q('id')} = {key}"


def _title(name: str) -> str:
    return name.replace("_", " ").capitalize()


def _sentence(parts: list[str]) -> str:
    return parts[0] if len(parts) == 1 else ", ".join(parts[:-1]) + " and " + parts[-1]


def _aggregate(words: set[str], lowered: str) -> str | None:
    if re.search(r"\bhow many\b|\bnumber of\b|\bcount\b", lowered):
        return "COUNT"
    if words & {"average", "avg", "mean"}:
        return "AVG"
    if re.search(r"\b(highest|maximum|max|largest single|biggest single)\b", lowered):
        return "MAX"
    if re.search(r"\b(lowest|minimum|min)\b", lowered):
        return "MIN"
    if words & (MONEY_WORDS | {"total", "sum"}):
        return "SUM"
    return None


def _names(field: FieldInfo, words: set[str]) -> bool:
    return field.name.lower() in words or any(p in words for p in field.name.lower().split("_") if len(p) > 2)


def _metric(entity: EntityInfo, words: set[str]) -> FieldInfo | None:
    numeric = [
        f for f in entity.fields if _is(f, NUMERIC_TYPES) and not f.masked and not f.name.endswith("id")
    ]
    for f in numeric:  # a metric the question names
        quantity_ok = f.name.lower() != "quantity" or bool(words & {"quantity", "unit", "item"})
        if _names(f, words) and quantity_ok:
            return f
    for name in METRIC_NAMES:
        for f in numeric:
            if f.name.lower() == name:
                return f
    return None


def _date_field(entity: EntityInfo) -> FieldInfo | None:
    return next((f for f in entity.fields if _is(f, DATE_TYPES) and not f.masked), None)


def _label_field(entity: EntityInfo) -> FieldInfo:
    for f in entity.fields:
        if f.name.lower() in ("name", "title", "label") and not f.masked:
            return f
    text = [f for f in entity.fields if not f.masked and not _is(f, NUMERIC_TYPES + DATE_TYPES)]
    return text[0] if text else entity.fields[0]


def _field_named(entity: EntityInfo, word: str) -> FieldInfo | None:
    for f in entity.fields:
        name = f.name.lower()
        if name == word or _singular(name) == word or word in name.split("_"):
            return f
    return None


def _fact_for(
    source: SourceContext, dimension: EntityInfo, words: set[str]
) -> tuple[EntityInfo, EntityInfo] | None:
    fk = f"{_singular(dimension.name.lower())}_id"
    if not any(f.name.lower() == "id" for f in dimension.fields):
        return None
    for entity in source.entities:
        if entity is dimension:
            continue
        if any(f.name.lower() == fk for f in entity.fields) and _metric(entity, words) is not None:
            return entity, dimension
    return None


def _lookup_for(source: SourceContext, column: FieldInfo) -> EntityInfo | None:
    """For a foreign key like region_id, the exposed table it points to (regions), if any."""
    if not column.name.lower().endswith("_id"):
        return None
    stem = column.name.lower()[:-3]
    for entity in source.entities:
        if _singular(entity.name.lower()) == stem and any(f.name.lower() == "id" for f in entity.fields):
            return entity
    return None


def _group_target(lowered: str) -> str | None:
    match = re.search(r"\b(?:by|per|each|across|for each)\s+([a-z_]+)", lowered)
    if not match:
        return None
    word = _singular(match.group(1))
    if word in MONEY_WORDS or word in STOP - {"month", "year", "week", "day"}:
        return None
    return word


def _time_filter(lowered: str, date_col: FieldInfo | None, alias: str) -> tuple[str, str]:
    if date_col is None:
        return "", ""
    col = f"{alias}.{_q(date_col.name)}"
    if re.search(r"\blast month\b|\bprevious month\b", lowered):
        return (
            f"{col} >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month' "
            f"AND {col} < DATE_TRUNC('month', CURRENT_DATE)",
            "kept only last month",
        )
    if re.search(r"\bthis month\b", lowered):
        return f"{col} >= DATE_TRUNC('month', CURRENT_DATE)", "kept only this month"
    if re.search(r"\blast year\b|\bprevious year\b", lowered):
        return (
            f"{col} >= DATE_TRUNC('year', CURRENT_DATE) - INTERVAL '1 year' "
            f"AND {col} < DATE_TRUNC('year', CURRENT_DATE)",
            "kept only last year",
        )
    if re.search(r"\bthis year\b|\byear to date\b|\bytd\b", lowered):
        return f"{col} >= DATE_TRUNC('year', CURRENT_DATE)", "kept only this year"
    days = re.search(r"\b(?:last|past)\s+(\d{1,4})\s+days?\b", lowered)
    if days:
        return (
            f"{col} >= CURRENT_DATE - INTERVAL '{int(days.group(1))} day'",
            f"kept the last {days.group(1)} days",
        )
    if re.search(r"\byesterday\b", lowered):
        return (f"{col} >= CURRENT_DATE - INTERVAL '1 day' AND {col} < CURRENT_DATE", "kept only yesterday")
    if re.search(r"\btoday\b", lowered):
        return f"{col} >= CURRENT_DATE", "kept only today"
    return "", ""


def _follow_ups(
    fact: EntityInfo, dimension: EntityInfo | None, grain: str | None, date_col: FieldInfo | None, when: str
) -> list[str]:
    name = fact.name.replace("_", " ")
    ideas: list[str] = []
    if date_col is not None and grain is None:
        ideas.append(f"Show {name} by month")
    if date_col is not None and "last month" not in when:
        ideas.append(f"How many {name} were there last month?")
    if dimension is None:
        ideas.append(f"How many {name} are there?")
    return ideas[:3]
