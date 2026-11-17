from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

# SQLite (used in tests) only auto-increments INTEGER primary keys.
BigIntPK = BigInteger().with_variant(Integer(), "sqlite")


def utcnow() -> datetime:
    return datetime.now(UTC)


class User(Base):
    __tablename__ = "users"
    __table_args__ = (UniqueConstraint("issuer", "subject"),)

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    issuer: Mapped[str] = mapped_column(String(500))
    subject: Mapped[str] = mapped_column(String(255))
    email: Mapped[str] = mapped_column(String(320), index=True)
    name: Mapped[str] = mapped_column(String(200))
    groups: Mapped[list[str]] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String(20), default="active")  # active | disabled
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_active_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    role_links: Mapped[list[UserRole]] = relationship(
        back_populates="user", cascade="all, delete-orphan", lazy="selectin"
    )


class Role(Base):
    __tablename__ = "roles"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    description: Mapped[str] = mapped_column(Text, default="")
    permissions: Mapped[dict[str, Any]] = mapped_column(JSON)
    source_ids: Mapped[list[str]] = mapped_column(JSON, default=list)
    built_in: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class UserRole(Base):
    """A role held by a user. origin='group' rows are replaced at every sign-in; 'manual' rows are kept."""

    __tablename__ = "user_roles"

    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    role_id: Mapped[str] = mapped_column(ForeignKey("roles.id", ondelete="CASCADE"), primary_key=True)
    origin: Mapped[str] = mapped_column(String(10), primary_key=True)  # group | manual

    user: Mapped[User] = relationship(back_populates="role_links")
    role: Mapped[Role] = relationship(lazy="selectin")


class Preference(Base):
    __tablename__ = "preferences"

    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    show_generated_query: Mapped[bool] = mapped_column(Boolean, default=False)
    default_source_ids: Mapped[list[str]] = mapped_column(JSON, default=list)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class AuditEvent(Base):
    """Append-only. In PostgreSQL a trigger rejects UPDATE/DELETE/TRUNCATE (see the first migration),
    and each row stores the hash of the previous one so any tampering breaks the chain."""

    __tablename__ = "audit_events"

    seq: Mapped[int] = mapped_column(BigIntPK, primary_key=True, autoincrement=True)
    id: Mapped[str] = mapped_column(String(40), unique=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    user_id: Mapped[str | None] = mapped_column(String(40), index=True)
    user_name: Mapped[str] = mapped_column(String(200), default="")
    user_email: Mapped[str] = mapped_column(String(320), default="")
    action: Mapped[str] = mapped_column(String(40), index=True)
    outcome: Mapped[str] = mapped_column(String(20))
    query_id: Mapped[str | None] = mapped_column(String(40), index=True)
    question: Mapped[str | None] = mapped_column(Text)
    sources: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    generated_queries: Mapped[list[dict[str, Any]] | None] = mapped_column(JSON)
    rows_returned: Mapped[int | None] = mapped_column(Integer)
    cached: Mapped[bool | None] = mapped_column(Boolean)
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    ip_address: Mapped[str | None] = mapped_column(String(64))
    details: Mapped[str | None] = mapped_column(Text)
    prev_hash: Mapped[str] = mapped_column(String(64))
    hash: Mapped[str] = mapped_column(String(64))


class Source(Base):
    """A connected company database. Connection settings here are non-secret only; passwords and keys
    live in the secret store under `secret_namespace`, and only their "is set" status is kept here."""

    __tablename__ = "sources"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    name: Mapped[str] = mapped_column(String(80))
    type: Mapped[str] = mapped_column(String(20))
    description: Mapped[str] = mapped_column(Text, default="")
    owner: Mapped[str] = mapped_column(String(200), default="")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    status: Mapped[str] = mapped_column(String(20), default="healthy")  # healthy | degraded | offline
    status_message: Mapped[str] = mapped_column(Text, default="")
    last_checked_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    connection: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    secret_namespace: Mapped[str] = mapped_column(String(40), unique=True)
    secret_status: Mapped[dict[str, str]] = mapped_column(JSON, default=dict)  # key -> updatedAt (ISO)
    exposed: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    glossary: Mapped[list[dict[str, str]]] = mapped_column(JSON, default=list)
    example_questions: Mapped[list[str]] = mapped_column(JSON, default=list)
    row_limit: Mapped[int] = mapped_column(Integer, default=500)
    query_timeout_seconds: Mapped[int] = mapped_column(Integer, default=30)
    cache_ttl_seconds: Mapped[int] = mapped_column(Integer, default=900)
    # Bumped whenever what the AI may see changes; part of the query-plan cache key (phase 3).
    schema_version: Mapped[int] = mapped_column(Integer, default=1)
    # Last schema discovered by the server, used to validate exposures if the database is briefly unreachable.
    schema_snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_by: Mapped[str | None] = mapped_column(String(40))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class LocalSecret(Base):
    """Development-only secret store: AES-256-GCM ciphertext. Production uses Azure Key Vault."""

    __tablename__ = "local_secrets"

    name: Mapped[str] = mapped_column(String(127), primary_key=True)
    nonce: Mapped[bytes] = mapped_column(LargeBinary(12))
    ciphertext: Mapped[bytes] = mapped_column(LargeBinary)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class Conversation(Base):
    __tablename__ = "conversations"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(120))
    pinned: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)


class Message(Base):
    """One chat message. `payload` holds the frontend's message shape (status, answer, error, …).
    Answers are stored after masking, so hidden values never reach this table."""

    __tablename__ = "messages"

    seq: Mapped[int] = mapped_column(BigIntPK, primary_key=True, autoincrement=True)
    id: Mapped[str] = mapped_column(String(40), unique=True)
    conversation_id: Mapped[str] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), index=True
    )
    role: Mapped[str] = mapped_column(String(10))  # user | assistant
    payload: Mapped[dict[str, Any]] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class QueryRecord(Base):
    """One question being answered: what was asked, what was chosen along the way, and its outcome."""

    __tablename__ = "queries"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    conversation_id: Mapped[str] = mapped_column(ForeignKey("conversations.id", ondelete="CASCADE"))
    assistant_message_id: Mapped[str] = mapped_column(String(40))
    question: Mapped[str] = mapped_column(Text)
    requested_source_ids: Mapped[list[str]] = mapped_column(JSON, default=list)
    clarification_options: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    clarification_choice: Mapped[str | None] = mapped_column(String(200))
    # A validated plan waiting for the person to confirm an expensive query.
    pending_plan: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(30), default="running")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class SavedQuestion(Base):
    __tablename__ = "saved_questions"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    question: Mapped[str] = mapped_column(Text)
    source_ids: Mapped[list[str]] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Feedback(Base):
    __tablename__ = "feedback"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    query_id: Mapped[str] = mapped_column(ForeignKey("queries.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    rating: Mapped[str] = mapped_column(String(4))
    reason: Mapped[str | None] = mapped_column(String(30))
    comment: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
