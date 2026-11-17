"""What the query pipeline asks of a language model, independent of which one is used."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass(frozen=True)
class FieldInfo:
    name: str
    type: str
    description: str
    masked: bool


@dataclass(frozen=True)
class EntityInfo:
    namespace: str
    name: str
    kind: str
    description: str
    fields: tuple[FieldInfo, ...]


@dataclass(frozen=True)
class SourceContext:
    """Everything the model may know about one data source: only what the admin exposed."""

    id: str
    name: str
    type: str  # postgresql | mysql
    description: str
    entities: tuple[EntityInfo, ...]
    glossary: tuple[tuple[str, str], ...] = ()
    examples: tuple[str, ...] = ()


@dataclass
class PlanRequest:
    question: str
    sources: list[SourceContext]
    history: list[str] = field(default_factory=list)  # earlier questions in this conversation
    clarification: str | None = None  # the option the person picked, if they were asked to clarify
    retry_feedback: str | None = None  # why the previous attempt was rejected


@dataclass
class QueryPlan:
    source_id: str
    sql: str
    explanation: str
    follow_ups: list[str] = field(default_factory=list)


@dataclass
class ClarifyPlan:
    question: str
    options: list[dict[str, str]]  # {id, label, description?}


@dataclass
class CannotAnswer:
    reason: str


Plan = QueryPlan | ClarifyPlan | CannotAnswer


@dataclass
class SummaryRequest:
    question: str
    explanation: str
    columns: list[dict[str, Any]]  # {key, label, type, masked}
    rows: list[dict[str, Any]]  # already masked; at most a few dozen
    total_rows: int


@dataclass
class Summary:
    summary: str
    highlights: list[dict[str, str]]
    follow_ups: list[str]


class LlmProvider(Protocol):
    name: str
    # True when the provider is a real model that may be shown result rows (subject to settings).
    reads_results: bool

    async def plan(self, request: PlanRequest) -> Plan: ...

    async def summarise(self, request: SummaryRequest) -> Summary | None:
        """None means "use the built-in template summary"."""
        ...

    async def close(self) -> None: ...
