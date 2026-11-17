"""Conversation history and saved questions. Everything here is the caller's own, and nobody else's."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import CurrentPrincipal
from app.db import get_db
from app.errors import not_found
from app.models import Conversation, Message, QueryRecord, SavedQuestion
from app.pipeline.engine import visible_answer

router = APIRouter(prefix="/api", tags=["conversations"])
Db = Annotated[AsyncSession, Depends(get_db)]


class ConversationPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)] | None = (
        None
    )
    pinned: bool | None = None


class SavedQuestionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    question: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]
    sourceIds: list[Annotated[str, StringConstraints(max_length=64)]] = Field(
        default_factory=list, max_length=20
    )


def _iso(value: datetime) -> str:
    return (value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)).isoformat()


def _summary(c: Conversation) -> dict[str, Any]:
    return {"id": c.id, "title": c.title, "pinned": c.pinned, "updatedAt": _iso(c.updated_at)}


async def _own(db: AsyncSession, conversation_id: str, principal: CurrentPrincipal) -> Conversation:
    conversation = await db.get(Conversation, conversation_id)
    if conversation is None or conversation.owner_id != principal.user.id:
        raise not_found("Conversation not found.")
    return conversation


@router.get("/conversations")
async def list_conversations(principal: CurrentPrincipal, db: Db) -> list[dict[str, Any]]:
    rows = await db.scalars(
        select(Conversation)
        .where(Conversation.owner_id == principal.user.id)
        .order_by(Conversation.updated_at.desc())
        .limit(200)
    )
    return [_summary(c) for c in rows]


@router.get("/conversations/{conversation_id}")
async def get_conversation(conversation_id: str, principal: CurrentPrincipal, db: Db) -> dict[str, Any]:
    conversation = await _own(db, conversation_id, principal)
    messages = await db.scalars(
        select(Message).where(Message.conversation_id == conversation.id).order_by(Message.seq)
    )
    out = []
    for message in messages:
        payload = dict(message.payload)
        if "answer" in payload:
            payload["answer"] = visible_answer(payload["answer"], principal.permissions)
        out.append(payload)
    return {**_summary(conversation), "messages": out}


@router.patch("/conversations/{conversation_id}")
async def update_conversation(
    conversation_id: str, body: ConversationPatch, principal: CurrentPrincipal, db: Db
) -> dict[str, Any]:
    conversation = await _own(db, conversation_id, principal)
    if body.title is not None:
        conversation.title = body.title
    if body.pinned is not None:
        conversation.pinned = body.pinned
    return _summary(conversation)


@router.delete("/conversations/{conversation_id}", status_code=204)
async def delete_conversation(conversation_id: str, principal: CurrentPrincipal, db: Db) -> Response:
    conversation = await _own(db, conversation_id, principal)
    # Explicit deletes, so SQLite (tests) behaves like PostgreSQL's ON DELETE CASCADE.
    await db.execute(delete(Message).where(Message.conversation_id == conversation.id))
    await db.execute(delete(QueryRecord).where(QueryRecord.conversation_id == conversation.id))
    await db.delete(conversation)
    return Response(status_code=204)


@router.get("/saved-questions")
async def list_saved(principal: CurrentPrincipal, db: Db) -> list[dict[str, Any]]:
    rows = await db.scalars(
        select(SavedQuestion)
        .where(SavedQuestion.user_id == principal.user.id)
        .order_by(SavedQuestion.created_at.desc())
    )
    return [_saved(s) for s in rows]


@router.post("/saved-questions", status_code=201)
async def save_question(
    body: SavedQuestionIn, principal: CurrentPrincipal, db: Db, response: Response
) -> dict[str, Any]:
    existing = await db.scalar(
        select(SavedQuestion).where(
            SavedQuestion.user_id == principal.user.id, SavedQuestion.question == body.question
        )
    )
    if existing is not None:
        response.status_code = 200
        return _saved(existing)
    count = len(
        list(await db.scalars(select(SavedQuestion.id).where(SavedQuestion.user_id == principal.user.id)))
    )
    if count >= 100:
        from app.errors import ApiError

        raise ApiError(400, "invalid", "You can save up to 100 questions. Remove some first.")
    allowed = principal.allowed_source_ids
    saved = SavedQuestion(
        id=f"sq-{uuid.uuid4().hex[:16]}",
        user_id=principal.user.id,
        question=body.question,
        source_ids=[s for s in body.sourceIds if s in allowed],
    )
    db.add(saved)
    await db.flush()
    return _saved(saved)


@router.delete("/saved-questions/{saved_id}", status_code=204)
async def delete_saved(saved_id: str, principal: CurrentPrincipal, db: Db) -> Response:
    await db.execute(
        delete(SavedQuestion).where(SavedQuestion.id == saved_id, SavedQuestion.user_id == principal.user.id)
    )
    return Response(status_code=204)


def _saved(s: SavedQuestion) -> dict[str, Any]:
    return {"id": s.id, "question": s.question, "sourceIds": s.source_ids, "createdAt": _iso(s.created_at)}
