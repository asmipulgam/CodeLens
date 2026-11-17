"""Asking questions (streamed), clarifying, confirming, refreshing, cancelling, exporting, feedback."""

from __future__ import annotations

import re
import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit import AuditLog, AuditRecord
from app.auth.deps import CurrentPrincipal, Principal, require_permission, store_of
from app.auth.sessions import SessionStore
from app.db import get_db
from app.errors import ApiError, not_found, rate_limited
from app.models import Conversation, Feedback, Message, QueryRecord, utcnow
from app.pipeline import results
from app.pipeline.engine import Asker, QueryEngine

router = APIRouter(prefix="/api", tags=["questions"])
Db = Annotated[AsyncSession, Depends(get_db)]
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
MAX_QUESTION_LENGTH = 2000


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AskIn(Strict):
    conversationId: str | None = Field(default=None, max_length=40)
    question: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]
    sourceIds: list[Annotated[str, StringConstraints(max_length=64)]] = Field(
        default_factory=list, max_length=20
    )


class ClarifyIn(Strict):
    optionId: Annotated[str, StringConstraints(max_length=200)]


class EmptyIn(Strict):
    pass


class ExportIn(Strict):
    format: Literal["csv"] = "csv"


class FeedbackIn(Strict):
    queryId: Annotated[str, StringConstraints(max_length=40)]
    rating: Literal["up", "down"]
    reason: Literal["wrong_numbers", "wrong_source", "did_not_answer", "too_slow", "other"] | None = None
    comment: Annotated[str, StringConstraints(max_length=1000)] | None = None


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:20]}"


def asker_of(principal: Principal) -> Asker:
    return Asker(
        user_id=principal.user.id,
        name=principal.user.name,
        email=principal.user.email,
        ip_address=principal.ip_address,
        role_ids=tuple(role.id for role in principal.roles),
        permissions=principal.permissions,
        allowed_source_ids=frozenset(principal.allowed_source_ids),
    )


def _engine(request: Request) -> QueryEngine:
    engine: QueryEngine = request.app.state.engine
    return engine


def _stream(request: Request, principal: Principal, query_id: str, mode: str) -> StreamingResponse:
    return StreamingResponse(
        _engine(request).stream(asker_of(principal), query_id, mode),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


# ── shared by the web API and the MCP server, so both follow exactly the same rules ──


async def check_question_rate(store: SessionStore, limit: int, user_id: str) -> None:
    if await store.hit_rate_limit(f"ask:{user_id}", limit):
        raise rate_limited()


async def own_query(db: AsyncSession, query_id: str, user_id: str) -> QueryRecord:
    record = await db.get(QueryRecord, query_id)
    if record is None or record.user_id != user_id:
        raise not_found("Question not found.")
    return record


async def start_question(
    db: AsyncSession,
    user_id: str,
    question_text: str,
    source_ids: list[str],
    conversation_id: str | None,
) -> QueryRecord:
    """Record a new question (and its conversation) so the engine can answer it."""
    question = _CONTROL.sub("", question_text).strip()
    if not question or len(question) > MAX_QUESTION_LENGTH:
        raise ApiError(400, "invalid", f"Ask a question of 1 to {MAX_QUESTION_LENGTH} characters.")
    conversation = await db.get(Conversation, conversation_id) if conversation_id else None
    if conversation_id and (conversation is None or conversation.owner_id != user_id):
        raise not_found("Conversation not found.")
    now = utcnow()
    if conversation is None:
        conversation = Conversation(
            id=new_id("c"),
            owner_id=user_id,
            title=question[:80],
            pinned=False,
            created_at=now,
            updated_at=now,
        )
        db.add(conversation)
    conversation.updated_at = now

    user_message_id, assistant_id = new_id("m"), new_id("m")
    db.add(
        Message(
            id=user_message_id,
            conversation_id=conversation.id,
            role="user",
            created_at=now,
            payload={
                "id": user_message_id,
                "role": "user",
                "content": question,
                "createdAt": now.isoformat(),
            },
        )
    )
    record = QueryRecord(
        id=new_id("q"),
        user_id=user_id,
        conversation_id=conversation.id,
        assistant_message_id=assistant_id,
        question=question,
        requested_source_ids=list(source_ids),
    )
    db.add(
        Message(
            id=assistant_id,
            conversation_id=conversation.id,
            role="assistant",
            created_at=now,
            payload={
                "id": assistant_id,
                "role": "assistant",
                "createdAt": now.isoformat(),
                "queryId": record.id,
                "status": "running",
                "stage": "understanding",
            },
        )
    )
    db.add(record)
    await db.commit()
    return record


async def start_clarify(db: AsyncSession, record: QueryRecord, option_id: str) -> None:
    option = next((o for o in record.clarification_options if o.get("id") == option_id), None)
    if option is None or record.status != "needs_clarification":
        raise ApiError(400, "invalid", "That option isn't available for this question.")
    record.clarification_choice = option["id"]
    record.status = "running"
    message = await db.scalar(select(Message).where(Message.id == record.assistant_message_id))
    if message is not None:
        payload = {k: v for k, v in message.payload.items() if k != "clarification"}
        message.payload = {**payload, "status": "running", "clarificationAnswer": option.get("label", "")}
    await db.commit()


async def start_confirm(db: AsyncSession, record: QueryRecord) -> None:
    if record.status != "needs_confirmation" or not record.pending_plan:
        raise ApiError(400, "invalid", "This question isn't waiting for confirmation.")
    record.status = "running"
    await db.commit()


# ── web endpoints ──


async def _check_rate(request: Request, principal: Principal) -> None:
    limit = request.app.state.settings.questions_per_minute
    await check_question_rate(store_of(request), limit, principal.user.id)


async def _own_query(db: AsyncSession, query_id: str, principal: Principal) -> QueryRecord:
    return await own_query(db, query_id, principal.user.id)


@router.post("/queries")
async def ask(body: AskIn, principal: CurrentPrincipal, db: Db, request: Request) -> StreamingResponse:
    await _check_rate(request, principal)
    record = await start_question(db, principal.user.id, body.question, body.sourceIds, body.conversationId)
    return _stream(request, principal, record.id, "ask")


@router.post("/queries/{query_id}/clarify")
async def clarify(
    query_id: str, body: ClarifyIn, principal: CurrentPrincipal, db: Db, request: Request
) -> StreamingResponse:
    record = await _own_query(db, query_id, principal)
    await start_clarify(db, record, body.optionId)
    return _stream(request, principal, record.id, "clarify")


@router.post("/queries/{query_id}/confirm")
async def confirm(
    query_id: str, principal: CurrentPrincipal, db: Db, request: Request, body: EmptyIn | None = None
) -> StreamingResponse:
    record = await _own_query(db, query_id, principal)
    await start_confirm(db, record)
    return _stream(request, principal, record.id, "confirm")


@router.post("/queries/{query_id}/refresh")
async def refresh(
    query_id: str, principal: CurrentPrincipal, db: Db, request: Request, body: EmptyIn | None = None
) -> StreamingResponse:
    """Answer the same question again from the live database, bypassing the cache."""
    await _check_rate(request, principal)
    original = await _own_query(db, query_id, principal)
    record = QueryRecord(
        id=new_id("q"),
        user_id=principal.user.id,
        conversation_id=original.conversation_id,
        assistant_message_id=original.assistant_message_id,
        question=original.question,
        requested_source_ids=original.requested_source_ids,
        clarification_choice=original.clarification_choice,
    )
    db.add(record)
    message = await db.scalar(select(Message).where(Message.id == original.assistant_message_id))
    if message is not None:
        message.payload = {**message.payload, "refreshing": True}
    await db.commit()
    return _stream(request, principal, record.id, "refresh")


@router.post("/queries/{query_id}/cancel", status_code=204)
async def cancel(query_id: str, principal: CurrentPrincipal, db: Db, request: Request) -> Response:
    record = await db.get(QueryRecord, query_id)
    if record is not None and record.user_id == principal.user.id and record.status == "running":
        await _engine(request).request_cancel(query_id)
    return Response(status_code=204)


@router.post("/queries/{query_id}/export")
async def export(
    query_id: str,
    principal: Annotated[Principal, Depends(require_permission("canExport"))],
    db: Db,
    request: Request,
    body: ExportIn | None = None,
) -> Response:
    record = await _own_query(db, query_id, principal)
    message = await db.scalar(select(Message).where(Message.id == record.assistant_message_id))
    answer = (message.payload.get("answer") if message else None) or {}
    table = answer.get("result")
    if not table or table.get("kind") != "table" or answer.get("queryId") != record.id:
        raise not_found("Nothing to export for this question.")
    limit = principal.permissions.exportRowLimit
    stamp = utcnow().isoformat(timespec="seconds")
    watermark = (
        f"Confidential — exported from CodeLens by {principal.user.name} <{principal.user.email}> "
        f"at {stamp}. Do not share outside the company."
    )
    body_text = results.to_csv(watermark, table, limit)
    rows = min(len(table["rows"]), limit)
    audit: AuditLog = request.app.state.audit
    await audit.record(
        principal.actor,
        AuditRecord(
            action="export",
            outcome="success",
            query_id=record.id,
            question=record.question,
            sources=answer.get("sources", []),
            rows_returned=rows,
        ),
    )
    return Response(
        content=body_text.encode("utf-8-sig"),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="codelens-export-{stamp[:10]}.csv"'},
    )


@router.post("/feedback", status_code=204)
async def feedback(body: FeedbackIn, principal: CurrentPrincipal, db: Db) -> Response:
    await _own_query(db, body.queryId, principal)
    db.add(
        Feedback(
            id=new_id("fb"),
            query_id=body.queryId,
            user_id=principal.user.id,
            rating=body.rating,
            reason=body.reason,
            comment=_CONTROL.sub("", body.comment) if body.comment else None,
        )
    )
    return Response(status_code=204)
