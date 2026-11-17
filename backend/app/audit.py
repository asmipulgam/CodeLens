"""Append-only audit log with a hash chain.

Each event is written in its own transaction, so a denied action is still recorded even though the
request that triggered it fails and rolls back.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models import AuditEvent, utcnow

AuditAction = Literal[
    "query",
    "refresh",
    "export",
    "login",
    "logout",
    "source_created",
    "source_updated",
    "source_deleted",
    "role_changed",
    "access_requested",
    "access_decision",
    "cache_cleared",
]
AuditOutcome = Literal["success", "denied", "error", "cancelled"]

GENESIS_HASH = "0" * 64
_CHAIN_LOCK_KEY = 0x434C4155  # arbitrary constant for pg_advisory_xact_lock


@dataclass(frozen=True)
class Actor:
    id: str | None
    name: str
    email: str
    ip_address: str | None = None


@dataclass
class AuditRecord:
    action: AuditAction
    outcome: AuditOutcome
    details: str | None = None
    query_id: str | None = None
    question: str | None = None
    sources: list[dict[str, Any]] = field(default_factory=list)
    generated_queries: list[dict[str, Any]] | None = None
    rows_returned: int | None = None
    cached: bool | None = None
    duration_ms: int | None = None


def _event_hash(prev_hash: str, payload: dict[str, Any]) -> str:
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256((prev_hash + canonical).encode()).hexdigest()


def _utc_iso(value: datetime) -> str:
    # Databases hand timestamps back in different zones (or naive, in SQLite); hash one canonical form.
    aware = value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)
    return aware.isoformat()


def _hashed_fields(event: AuditEvent) -> dict[str, Any]:
    return {
        "id": event.id,
        "timestamp": _utc_iso(event.timestamp),
        "user_id": event.user_id,
        "user_name": event.user_name,
        "user_email": event.user_email,
        "action": event.action,
        "outcome": event.outcome,
        "query_id": event.query_id,
        "question": event.question,
        "sources": event.sources,
        "generated_queries": event.generated_queries,
        "rows_returned": event.rows_returned,
        "cached": event.cached,
        "duration_ms": event.duration_ms,
        "ip_address": event.ip_address,
        "details": event.details,
    }


class AuditLog:
    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self._sessionmaker = sessionmaker

    async def record(self, actor: Actor, record: AuditRecord) -> AuditEvent:
        async with self._sessionmaker() as session, session.begin():
            if session.get_bind().dialect.name == "postgresql":
                # Serialise writers so the chain has no forks.
                await session.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": _CHAIN_LOCK_KEY})
            prev = await session.scalar(select(AuditEvent.hash).order_by(AuditEvent.seq.desc()).limit(1))
            event = AuditEvent(
                id=f"au-{uuid.uuid4().hex[:20]}",
                timestamp=utcnow(),
                user_id=actor.id,
                user_name=actor.name,
                user_email=actor.email,
                ip_address=actor.ip_address,
                action=record.action,
                outcome=record.outcome,
                query_id=record.query_id,
                question=record.question,
                sources=record.sources,
                generated_queries=record.generated_queries,
                rows_returned=record.rows_returned,
                cached=record.cached,
                duration_ms=record.duration_ms,
                details=record.details,
                prev_hash=prev or GENESIS_HASH,
            )
            event.hash = _event_hash(event.prev_hash, _hashed_fields(event))
            session.add(event)
        return event

    async def verify_chain(self) -> int | None:
        """Return the seq of the first event whose hash doesn't match, or None if the chain is intact."""
        async with self._sessionmaker() as session:
            prev = GENESIS_HASH
            for event in await session.scalars(select(AuditEvent).order_by(AuditEvent.seq)):
                if event.prev_hash != prev or event.hash != _event_hash(prev, _hashed_fields(event)):
                    return event.seq
                prev = event.hash
        return None
