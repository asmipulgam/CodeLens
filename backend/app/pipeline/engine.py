"""Answering one question, streamed to the browser as Server-Sent Events.

understanding → routing → (clarify?) → building → (confirm?) → running → summarising → result

Every step works only with sources the asker may use; every query passes sql_guard; results are masked
before they are cached, stored or summarised; and every outcome is audited.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import time
from collections.abc import AsyncIterator, Awaitable
from dataclasses import dataclass
from typing import Any, TypeVar

from redis.asyncio import Redis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.audit import Actor, AuditLog, AuditRecord
from app.auth.roles import Permissions
from app.config import Settings
from app.llm.base import (
    CannotAnswer,
    ClarifyPlan,
    EntityInfo,
    FieldInfo,
    LlmProvider,
    PlanRequest,
    QueryPlan,
    SourceContext,
    SummaryRequest,
)
from app.models import Conversation, Message, QueryRecord, Source, utcnow
from app.pipeline import results
from app.pipeline.sql_guard import DIALECTS, GuardedQuery, QueryRejected, guard, tables_from_exposed
from app.secrets.store import SecretStore
from app.sources.connectors import CONNECTORS, ConnectorError
from app.sources.connectors.base import QueryFailed
from app.sources.fields import needed_secret_keys

log = logging.getLogger("codelens.pipeline")
T = TypeVar("T")

QUERY_TIME_LIMIT_CAP = 600
CANCEL_PREFIX = "codelens:cancel:"
CACHE_PREFIX = "codelens:result-cache:"
STATS_PREFIX = "codelens:cache-stats:"
WRITE_INTENT = re.compile(
    r"^\s*(?:please\s+|can you\s+|could you\s+)?(delete|remove|drop|truncate|update|insert|alter|create|"
    r"change|modify|erase|wipe|rename|overwrite|reset)\b",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class Asker:
    """A snapshot of who is asking, taken when the request arrived."""

    user_id: str
    name: str
    email: str
    ip_address: str | None
    role_ids: tuple[str, ...]
    permissions: Permissions
    allowed_source_ids: frozenset[str]

    @property
    def actor(self) -> Actor:
        return Actor(self.user_id, self.name, self.email, self.ip_address)


class QueryCancelled(Exception):
    pass


class _Stop(Exception):
    """Ends the run after a terminal event (error / clarification / confirmation) was sent."""


def source_ref(source: Source) -> dict[str, str]:
    return {"id": source.id, "name": source.name, "type": source.type}


def sse(event: dict[str, Any]) -> str:
    return f"event: {event['type']}\ndata: {json.dumps(event, separators=(',', ':'))}\n\n"


def visible_answer(answer: dict[str, Any], permissions: Permissions) -> dict[str, Any]:
    """Generated queries are only shown to roles allowed to see them."""
    if permissions.canViewQuery:
        return answer
    return {k: v for k, v in answer.items() if k != "generatedQueries"}


class QueryEngine:
    def __init__(
        self,
        *,
        settings: Settings,
        sessionmaker: async_sessionmaker[AsyncSession],
        secrets: SecretStore,
        redis: Redis,
        provider: LlmProvider,
        audit: AuditLog,
    ) -> None:
        self.settings = settings
        self.sessionmaker = sessionmaker
        self.secrets = secrets
        self.redis = redis
        self.provider = provider
        self.audit = audit

    # ── public ──

    async def stream(self, asker: Asker, query_id: str, mode: str) -> AsyncIterator[str]:
        """mode: ask | clarify | confirm | refresh"""
        run = _Run(self, asker, query_id, mode)
        try:
            async for event in run.events():
                yield sse(event)
        finally:
            await run.finish()

    async def request_cancel(self, query_id: str) -> None:
        await self.redis.set(CANCEL_PREFIX + query_id, "1", ex=600)


class _Run:
    def __init__(self, engine: QueryEngine, asker: Asker, query_id: str, mode: str) -> None:
        self.e = engine
        self.asker = asker
        self.query_id = query_id
        self.mode = mode
        self.started = time.perf_counter()
        self.record: QueryRecord | None = None
        self.done = False
        self.audit_sources: list[dict[str, str]] = []

    # ── the steps ──

    async def events(self) -> AsyncIterator[dict[str, Any]]:
        async with self.e.sessionmaker() as db:
            self.record = await db.get(QueryRecord, self.query_id)
        record = self.record
        if record is None or record.user_id != self.asker.user_id:
            return
        yield {"type": "started", "queryId": record.id, "conversationId": record.conversation_id}

        try:
            async for event in self._steps(record):
                yield event
        except _Stop:
            return
        except QueryCancelled:
            await self._set_status("cancelled", {"status": "cancelled", "stage": None})
            await self._audit("cancelled")
            self.done = True
        except Exception:
            log.exception("Answering %s failed", self.query_id)
            yield await self._error("internal", "Something went wrong while answering. Please try again.")

    async def _steps(self, record: QueryRecord) -> AsyncIterator[dict[str, Any]]:
        fresh_question = self.mode in ("ask", "refresh")
        if fresh_question:
            yield await self._progress("understanding")
            if WRITE_INTENT.search(record.question):
                yield await self._error(
                    "write_blocked",
                    "CodeLens can only read data. It can't change, add or delete anything.",
                    hint="Ask a question about the data instead, for example how many or how much.",
                    outcome="denied",
                )
                raise _Stop

        if fresh_question:
            yield await self._progress("routing")
        sources = await self._sources(record)
        if not sources:
            yield await self._error(
                "forbidden",
                "You don't have access to any data sources that can answer questions yet.",
                hint="Request access to a data source on the “What can I ask?” page.",
                can_request_access=True,
                outcome="denied",
            )
            raise _Stop
        by_id = {s.id: s for s in sources}

        plan = await self._plan(record, sources)
        if isinstance(plan, ClarifyPlan):
            await self._save_record(clarification_options=plan.options)
            clarification = {"question": plan.question, "options": plan.options}
            await self._set_status(
                "needs_clarification",
                {"status": "needs_clarification", "clarification": clarification, "stage": None},
            )
            self.done = True
            yield {"type": "clarification", "clarification": clarification}
            raise _Stop
        if isinstance(plan, CannotAnswer):
            examples = [q for s in sources for q in s.example_questions][:3]
            hint = (
                ("Try something like: " + " · ".join(examples))
                if examples
                else ("Ask about: " + ", ".join(s.name for s in sources))
            )
            yield await self._error("not_understood", plan.reason, hint=hint)
            raise _Stop

        source = by_id[plan.source_id]
        self.audit_sources = [source_ref(source)]
        yield await self._progress("building")
        guarded, plan, rejection = await self._guard_with_retry(record, plan, source, sources)
        if guarded is None:
            if rejection is not None:
                yield rejection
            raise _Stop
        generated = [{"source": source_ref(source), "language": "sql", "text": guarded.sql}]

        cache_key = self._cache_key(source, guarded)
        cached = (
            None
            if self.mode == "refresh" or source.cache_ttl_seconds <= 0
            else await self._cache_get(cache_key)
        )
        await self._stats(source.id, hit=cached is not None)

        if cached is None:
            if self.mode != "confirm":
                confirmation = await self._maybe_confirm(source, guarded, plan)
                if confirmation is not None:
                    yield confirmation
                    raise _Stop
            yield await self._progress("running")
            try:
                table, total, truncated = await self._execute(source, guarded)
            except QueryFailed as exc:
                log.info("Query %s failed in the database: %s", self.query_id, exc.detail)
                yield await self._error(
                    "not_understood",
                    str(exc),
                    source=source_ref(source),
                    hint="Try rephrasing the question.",
                    details=exc.detail,
                )
                raise _Stop from None
            except ConnectorError as exc:
                text = str(exc)
                code = "timeout" if "too long" in text else "source_offline"
                yield await self._error(
                    code,
                    text,
                    source=source_ref(source),
                    hint="Try a narrower question (a shorter time range or fewer groups)."
                    if code == "timeout"
                    else "Try again in a few minutes.",
                )
                raise _Stop from None
        else:
            table, total, truncated = cached["table"], cached["total"], cached["truncated"]

        yield await self._progress("summarising")
        if cached is not None:
            summary = cached["summary"]
        else:
            summary = await self._summarise(record, plan, table, total, truncated)
        table = {**table, "totalRows": total}

        answer: dict[str, Any] = {
            "queryId": record.id,
            "question": record.question,
            "summary": summary["summary"],
            "highlights": summary["highlights"],
            "sources": [source_ref(source)],
            "freshness": {"status": "cached", "cachedAt": cached["cachedAt"]}
            if cached
            else {"status": "live"},
            "explanation": plan.explanation,
            "generatedQueries": generated,
            "result": table,
            "followUps": _follow_ups(
                record.question, summary.get("follow_ups"), plan.follow_ups, source.example_questions
            ),
            "rowLimit": source.row_limit,
        }
        chart = results.chart_for(table)
        if chart:
            answer["chart"] = chart
        answer["freshness"]["durationMs"] = int((time.perf_counter() - self.started) * 1000)

        if cached is None and source.cache_ttl_seconds > 0:
            await self._cache_put(cache_key, source.cache_ttl_seconds, table, total, truncated, summary)

        await self._set_status(
            "done", {"status": "done", "answer": answer, "stage": None, "refreshing": None}
        )
        await self._audit("success", generated=generated, rows=len(table["rows"]), cached=cached is not None)
        self.done = True
        yield {"type": "result", "answer": visible_answer(answer, self.asker.permissions)}

    # ── routing & planning ──

    async def _sources(self, record: QueryRecord) -> list[Source]:
        allowed = set(self.asker.allowed_source_ids)
        requested = (
            set(record.requested_source_ids) & allowed if self.asker.permissions.canChooseSource else set()
        )
        wanted = requested or allowed
        async with self.e.sessionmaker() as db:
            rows = await db.scalars(select(Source).where(Source.id.in_(wanted), Source.enabled.is_(True)))
            return [s for s in rows if s.type in CONNECTORS and s.type in DIALECTS and s.exposed]

    async def _plan(
        self, record: QueryRecord, sources: list[Source]
    ) -> QueryPlan | ClarifyPlan | CannotAnswer:
        if self.mode == "confirm" and record.pending_plan:
            return QueryPlan(**record.pending_plan)
        return await self.e.provider.plan(
            PlanRequest(
                question=record.question,
                sources=[_context(s) for s in sources],
                history=await self._history(record),
                clarification=record.clarification_choice,
            )
        )

    async def _history(self, record: QueryRecord) -> list[str]:
        async with self.e.sessionmaker() as db:
            rows = await db.scalars(
                select(Message)
                .where(Message.conversation_id == record.conversation_id, Message.role == "user")
                .order_by(Message.seq.desc())
                .limit(4)
            )
            questions = [m.payload.get("content", "") for m in rows]
        return [q for q in reversed(questions) if q != record.question][-3:]

    async def _guard_with_retry(
        self,
        record: QueryRecord,
        plan: QueryPlan,
        source: Source,
        sources: list[Source],
    ) -> tuple[GuardedQuery | None, QueryPlan, dict[str, Any] | None]:
        attempt = plan
        for try_number in range(2):
            try:
                guarded = guard(
                    attempt.sql,
                    source_type=source.type,
                    exposed=tables_from_exposed(source.exposed),
                    row_limit=source.row_limit,
                )
                return guarded, attempt, None
            except QueryRejected as exc:
                log.info("Query for %s rejected: %s", self.query_id, exc)
                if try_number == 0 and self.e.provider.reads_results and self.mode != "confirm":
                    retry = await self.e.provider.plan(
                        PlanRequest(
                            question=record.question,
                            sources=[_context(s) for s in sources],
                            history=await self._history(record),
                            clarification=record.clarification_choice,
                            retry_feedback=str(exc),
                        )
                    )
                    if isinstance(retry, QueryPlan) and retry.source_id == source.id:
                        attempt = retry
                        continue
                writes = "read-only" in str(exc)
                event = await self._error(
                    "write_blocked" if writes else "not_understood",
                    str(exc),
                    hint=None if writes else "Try rephrasing the question.",
                    outcome="denied" if writes else "error",
                )
                return None, attempt, event
        return None, attempt, None

    # ── confirmation, execution, summary ──

    async def _maybe_confirm(
        self, source: Source, guarded: GuardedQuery, plan: QueryPlan
    ) -> dict[str, Any] | None:
        connection, secrets = await self._credentials(source)
        try:
            estimate = await CONNECTORS[source.type].estimate(connection, secrets, guarded.sql, 15)
        except ConnectorError:
            return None  # can't estimate: run it; the timeout still applies
        rows = estimate.rows_scanned or 0
        if rows < self.e.settings.confirm_rows_threshold:
            return None
        confirmation = {
            "message": f"This question needs to read about {rows:,} rows from {source.name}, "
            "so it may be slow. "
            "Run it anyway?",
            "source": source_ref(source),
            "estimate": {"rows": rows},
        }
        await self._save_record(
            pending_plan={
                "source_id": plan.source_id,
                "sql": plan.sql,
                "explanation": plan.explanation,
                "follow_ups": plan.follow_ups,
            }
        )
        await self._set_status(
            "needs_confirmation",
            {"status": "needs_confirmation", "confirmation": confirmation, "stage": None},
        )
        self.done = True
        return {"type": "confirmation", "confirmation": confirmation}

    async def _credentials(self, source: Source) -> tuple[dict[str, Any], dict[str, str]]:
        secrets: dict[str, str] = {}
        for key in needed_secret_keys(source.type, source.connection):  # type: ignore[arg-type]
            value = await self.e.secrets.get(source.secret_namespace, key)
            if value is not None:
                secrets[key] = value
        return source.connection, secrets

    async def _execute(self, source: Source, guarded: GuardedQuery) -> tuple[dict[str, Any], int, bool]:
        connection, secrets = await self._credentials(source)
        connector = CONNECTORS[source.type]
        time_limit = float(min(source.query_timeout_seconds, QUERY_TIME_LIMIT_CAP))
        output = await self._cancellable(
            connector.run(connection, secrets, guarded.sql, time_limit, guarded.limit)
        )
        truncated = len(output.rows) > source.row_limit
        rows = output.rows[: source.row_limit]
        total = len(rows)
        if truncated:
            try:
                counted = await self._cancellable(
                    connector.run(connection, secrets, guarded.count_sql, time_limit, 1)
                )
                total = int(counted.rows[0][0]) if counted.rows else total  # type: ignore[call-overload]
            except ConnectorError:
                total = len(rows)
        return results.build_table(output.columns, rows, guarded.masked_outputs), total, truncated

    async def _summarise(
        self, record: QueryRecord, plan: QueryPlan, table: dict[str, Any], total: int, truncated: bool
    ) -> dict[str, Any]:
        summary = None
        if self.e.provider.reads_results and self.e.settings.ai_shares_result_rows:
            try:
                summary = await self.e.provider.summarise(
                    SummaryRequest(
                        question=record.question,
                        explanation=plan.explanation,
                        columns=table["columns"],
                        rows=table["rows"][:30],
                        total_rows=total,
                    )
                )
            except Exception:
                log.warning("AI summary failed for %s; using the template", self.query_id, exc_info=True)
        if summary is None:
            summary = results.template_summary(record.question, table, total, truncated)
        return {
            "summary": summary.summary,
            "highlights": summary.highlights,
            "follow_ups": summary.follow_ups,
        }

    async def _cancellable(self, work: Awaitable[T]) -> T:
        task = asyncio.ensure_future(work)
        try:
            while True:
                done, _ = await asyncio.wait({task}, timeout=0.5)
                if done:
                    return task.result()
                if await self.e.redis.exists(CANCEL_PREFIX + self.query_id):
                    raise QueryCancelled
        finally:
            if not task.done():
                task.cancel()

    # ── cache ──

    def _cache_key(self, source: Source, guarded: GuardedQuery) -> str:
        # The asker's whole permission scope is part of the key, so cached rows never cross access lines.
        scope = [sorted(self.asker.role_ids), sorted(self.asker.allowed_source_ids)]
        material = json.dumps([source.id, source.schema_version, guarded.sql, scope], separators=(",", ":"))
        return f"{CACHE_PREFIX}{source.id}:{hashlib.sha256(material.encode()).hexdigest()}"

    async def _cache_get(self, key: str) -> dict[str, Any] | None:
        raw = await self.e.redis.get(key)
        return json.loads(raw) if raw else None

    async def _cache_put(
        self, key: str, ttl: int, table: dict[str, Any], total: int, truncated: bool, summary: dict[str, Any]
    ) -> None:
        value = {
            "table": table,
            "total": total,
            "truncated": truncated,
            "summary": summary,
            "cachedAt": utcnow().isoformat(),
        }
        await self.e.redis.set(key, json.dumps(value, separators=(",", ":")), ex=ttl)

    async def _stats(self, source_id: str, *, hit: bool) -> None:
        await self.e.redis.hincrby(STATS_PREFIX + source_id, "hits" if hit else "misses", 1)

    # ── persistence & events ──

    async def _progress(self, stage: str) -> dict[str, Any]:
        if await self.e.redis.exists(CANCEL_PREFIX + self.query_id):
            raise QueryCancelled
        await self._update_message({"stage": stage, "status": "running"})
        return {"type": "progress", "stage": stage}

    async def _error(
        self,
        code: str,
        message: str,
        *,
        hint: str | None = None,
        source: dict[str, str] | None = None,
        can_request_access: bool = False,
        outcome: str = "error",
        details: str | None = None,
    ) -> dict[str, Any]:
        error: dict[str, Any] = {"code": code, "message": message}
        if hint:
            error["hint"] = hint
        if source:
            error["source"] = source
        if can_request_access:
            error["canRequestAccess"] = True
        await self._set_status(
            "error", {"status": "error", "error": error, "stage": None, "refreshing": None}
        )
        await self._audit(outcome, details=details or message)
        self.done = True
        return {"type": "error", "error": error}

    async def _save_record(self, **values: Any) -> None:
        async with self.e.sessionmaker() as db, db.begin():
            record = await db.get(QueryRecord, self.query_id)
            if record is not None:
                for key, value in values.items():
                    setattr(record, key, value)

    async def _set_status(self, status: str, patch: dict[str, Any]) -> None:
        await self._save_record(status=status)
        await self._update_message(patch)

    async def _update_message(self, patch: dict[str, Any]) -> None:
        if self.record is None:
            return
        async with self.e.sessionmaker() as db, db.begin():
            message = await db.scalar(select(Message).where(Message.id == self.record.assistant_message_id))
            if message is None:
                return
            payload = {**message.payload, **patch, "queryId": self.record.id}
            message.payload = {k: v for k, v in payload.items() if v is not None}
            conversation = await db.get(Conversation, self.record.conversation_id)
            if conversation is not None:
                conversation.updated_at = utcnow()

    async def _audit(
        self,
        outcome: str,
        *,
        generated: list[dict[str, Any]] | None = None,
        rows: int | None = None,
        cached: bool | None = None,
        details: str | None = None,
    ) -> None:
        if self.record is None:
            return
        await self.e.audit.record(
            self.asker.actor,
            AuditRecord(
                action="refresh" if self.mode == "refresh" else "query",
                outcome=outcome,  # type: ignore[arg-type]
                query_id=self.record.id,
                question=self.record.question,
                sources=self.audit_sources,
                generated_queries=generated,
                rows_returned=rows,
                cached=cached,
                duration_ms=int((time.perf_counter() - self.started) * 1000),
                details=details,
            ),
        )

    async def finish(self) -> None:
        """If the browser went away mid-answer, record the question as cancelled."""
        if not self.done and self.record is not None:
            try:
                await self._set_status("cancelled", {"status": "cancelled", "stage": None})
                await self._audit("cancelled")
            except Exception:
                log.warning("Couldn't record cancellation of %s", self.query_id, exc_info=True)


def _follow_ups(question: str, *suggestions: list[str] | None) -> list[str]:
    asked = question.strip().lower().rstrip("?")
    seen: list[str] = []
    for group in suggestions:
        for item in group or []:
            if item.strip().lower().rstrip("?") != asked and item not in seen:
                seen.append(item)
    return seen[:3]


def _context(source: Source) -> SourceContext:
    return SourceContext(
        id=source.id,
        name=source.name,
        type=source.type,
        description=source.description,
        entities=tuple(
            EntityInfo(
                e["namespace"],
                e["name"],
                e.get("kind", "table"),
                e.get("description", ""),
                tuple(
                    FieldInfo(f["name"], f.get("type", ""), f.get("description", ""), bool(f.get("masked")))
                    for f in e["fields"]
                ),
            )
            for e in source.exposed
        ),
        glossary=tuple((g["term"], g["definition"]) for g in source.glossary),
        examples=tuple(source.example_questions),
    )
