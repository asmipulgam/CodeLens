"""Admin: connect, edit, test and remove data sources (the six-step wizard)."""

from __future__ import annotations

import logging
import re
import uuid
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit import AuditLog, AuditRecord
from app.auth.deps import Principal, require_permission, require_recent_auth
from app.db import get_db
from app.errors import ApiError, not_found
from app.models import Role, Source, utcnow
from app.secrets.store import SecretStore
from app.sources import service
from app.sources.fields import ConnectionValue, SourceType, needed_secret_keys

log = logging.getLogger("codelens.sources")
router = APIRouter(prefix="/api/admin/sources", tags=["admin: sources"])

Admin = Annotated[Principal, Depends(require_permission("canAdmin"))]
Db = Annotated[AsyncSession, Depends(get_db)]
CACHE_TTL_OPTIONS = (0, 60, 300, 900, 3600, 21_600, 86_400)

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=128)]
ShortText = Annotated[str, StringConstraints(max_length=1000)]


async def admin_with_recent_auth(principal: Admin, request: Request) -> Principal:
    """Sensitive changes need the admin role AND a recent sign-in (step-up)."""
    return await require_recent_auth(principal, request)


RecentAdmin = Annotated[Principal, Depends(admin_with_recent_auth)]


# ── request / response shapes (camelCase to match the frontend) ──────────────


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ExposedFieldIn(Strict):
    name: Name
    type: Annotated[str, StringConstraints(max_length=200)] = ""  # ignored: the server uses the real type
    description: Annotated[str, StringConstraints(max_length=500)] = ""
    masked: bool = False


class ExposedEntityIn(Strict):
    namespace: Name
    name: Name
    kind: Literal["table", "view", "collection", "keyPattern"]
    description: ShortText = ""
    fields: list[ExposedFieldIn] = Field(min_length=1, max_length=500)


class GlossaryTermIn(Strict):
    term: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
    definition: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]


ConnectionIn = Annotated[dict[str, ConnectionValue], Field(max_length=20)]
SecretsIn = Annotated[dict[str, Annotated[str, StringConstraints(max_length=16_384)]], Field(max_length=10)]


class SourceConfigIn(Strict):
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=2, max_length=80)]
    type: SourceType
    description: ShortText = ""
    connection: ConnectionIn
    secrets: SecretsIn = Field(default_factory=dict)
    exposed: list[ExposedEntityIn] = Field(max_length=2000)
    glossary: list[GlossaryTermIn] = Field(default_factory=list, max_length=100)
    exampleQuestions: list[Annotated[str, StringConstraints(max_length=300)]] = Field(
        default_factory=list, max_length=20
    )
    roleIds: list[Annotated[str, StringConstraints(max_length=64)]] = Field(min_length=1, max_length=50)
    rowLimit: int = Field(ge=1, le=100_000)
    queryTimeoutSeconds: int = Field(ge=5, le=600)
    cacheTtlSeconds: int


class ProbeIn(Strict):
    sourceId: str | None = None
    type: SourceType
    connection: ConnectionIn
    secrets: SecretsIn = Field(default_factory=dict)


class EnabledIn(Strict):
    enabled: bool


class AdminSourceOut(BaseModel):
    id: str
    name: str
    type: str
    description: str
    status: str
    lastCheckedAt: str
    owner: str
    enabled: bool
    exposedCount: int
    cacheTtlSeconds: int


class SecretStatusOut(BaseModel):
    isSet: bool
    updatedAt: str | None = None


class AdminSourceDetailOut(AdminSourceOut):
    connection: dict[str, ConnectionValue]
    secrets: dict[str, SecretStatusOut]
    exposed: list[dict[str, Any]]
    glossary: list[dict[str, str]]
    exampleQuestions: list[str]
    roleIds: list[str]
    rowLimit: int
    queryTimeoutSeconds: int


class ConnectionTestOut(BaseModel):
    ok: bool
    message: str
    latencyMs: int | None = None
    serverVersion: str | None = None
    readOnly: bool
    warnings: list[str]


# ── helpers ───────────────────────────────────────────────────────────────────


def _iso(value: datetime) -> str:
    return (value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)).isoformat()


def to_admin_source(source: Source) -> AdminSourceOut:
    return AdminSourceOut(
        id=source.id,
        name=source.name,
        type=source.type,
        description=source.description,
        status=source.status,
        lastCheckedAt=_iso(source.last_checked_at),
        owner=source.owner,
        enabled=source.enabled,
        exposedCount=len(source.exposed),
        cacheTtlSeconds=source.cache_ttl_seconds,
    )


async def _role_ids_for(db: AsyncSession, source_id: str) -> list[str]:
    roles = await db.scalars(select(Role).order_by(Role.id))
    return [role.id for role in roles if source_id in role.source_ids]


async def to_detail(db: AsyncSession, source: Source) -> AdminSourceDetailOut:
    return AdminSourceDetailOut(
        **to_admin_source(source).model_dump(),
        connection=source.connection,
        secrets={key: SecretStatusOut(isSet=True, updatedAt=at) for key, at in source.secret_status.items()},
        exposed=source.exposed,
        glossary=source.glossary,
        exampleQuestions=source.example_questions,
        roleIds=await _role_ids_for(db, source.id),
        rowLimit=source.row_limit,
        queryTimeoutSeconds=source.query_timeout_seconds,
    )


def _store(request: Request) -> SecretStore:
    store: SecretStore = request.app.state.secrets
    return store


def _audit(request: Request) -> AuditLog:
    audit: AuditLog = request.app.state.audit
    return audit


def _ref(source: Source) -> dict[str, str]:
    return {"id": source.id, "name": source.name, "type": source.type}


async def _get_source(db: AsyncSession, source_id: str) -> Source:
    source = await db.get(Source, source_id)
    if source is None:
        raise not_found("Data source not found.")
    return source


async def _slug(db: AsyncSession, name: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:30] or "source"
    candidate = base
    while await db.get(Source, candidate) is not None:
        candidate = f"{base}-{uuid.uuid4().hex[:4]}"
    return candidate


async def _set_roles(db: AsyncSession, source_id: str, role_ids: list[str]) -> None:
    wanted = set(role_ids)
    roles = list(await db.scalars(select(Role)))
    unknown = wanted - {role.id for role in roles}
    if unknown:
        raise service.invalid("Unknown role: " + ", ".join(sorted(unknown)) + ".")
    for role in roles:
        has = source_id in role.source_ids
        if role.id in wanted and not has:
            role.source_ids = [*role.source_ids, source_id]
        elif role.id not in wanted and has:
            role.source_ids = [sid for sid in role.source_ids if sid != source_id]


def _clean_describe(body: SourceConfigIn) -> dict[str, Any]:
    if body.cacheTtlSeconds not in CACHE_TTL_OPTIONS:
        raise service.invalid("Choose one of the offered cache durations.")
    return {
        "name": service.clean_text(body.name, 80),
        "description": service.clean_text(body.description, 1000),
        "glossary": [
            {"term": service.clean_text(g.term, 100), "definition": service.clean_text(g.definition, 500)}
            for g in body.glossary
        ],
        "example_questions": [q for q in (service.clean_text(q, 300) for q in body.exampleQuestions) if q],
        "row_limit": body.rowLimit,
        "query_timeout_seconds": body.queryTimeoutSeconds,
        "cache_ttl_seconds": body.cacheTtlSeconds,
    }


async def _resolve(
    request: Request,
    source_type: SourceType,
    connection: dict[str, ConnectionValue],
    secrets: dict[str, str],
    existing: Source | None,
) -> service.ResolvedConnection:
    return await service.resolve_connection(
        settings=request.app.state.settings,
        store=_store(request),
        source_type=source_type,
        connection=connection,
        new_secrets=secrets,
        existing=existing,
    )


async def _write_secrets(
    store: SecretStore, source: Source, resolved: service.ResolvedConnection
) -> list[str]:
    """Store new secrets and drop ones the connection no longer uses. Returns the keys written."""
    now = utcnow().isoformat()
    status = dict(source.secret_status)
    for key, value in resolved.new_secrets.items():
        await store.put(source.secret_namespace, key, value)
        status[key] = now
    unused = [key for key in status if key not in needed_secret_keys(resolved.type, resolved.connection)]
    if unused:
        await store.delete(source.secret_namespace, unused)
        for key in unused:
            status.pop(key)
    source.secret_status = status
    return list(resolved.new_secrets)


# ── endpoints ────────────────────────────────────────────────────────────────


@router.get("", response_model=list[AdminSourceOut])
async def list_sources(_: Admin, db: Db) -> list[AdminSourceOut]:
    return [to_admin_source(s) for s in await db.scalars(select(Source).order_by(Source.name))]


@router.post("/test", response_model=ConnectionTestOut)
async def test_connection(body: ProbeIn, _: Admin, db: Db, request: Request) -> ConnectionTestOut:
    existing = await _get_source(db, body.sourceId) if body.sourceId else None
    if existing is not None and existing.type != body.type:
        raise service.invalid("The database type of an existing source can't change.")
    resolved = await _resolve(request, body.type, body.connection, body.secrets, existing)
    outcome = await service.test_connection(resolved)
    return ConnectionTestOut(
        ok=outcome.ok,
        message=outcome.message,
        latencyMs=outcome.latency_ms,
        serverVersion=outcome.server_version,
        readOnly=outcome.ok and outcome.read_only,
        warnings=outcome.warnings,
    )


@router.post("/discover")
async def discover(body: ProbeIn, _: Admin, db: Db, request: Request) -> dict[str, Any]:
    existing = await _get_source(db, body.sourceId) if body.sourceId else None
    if existing is not None and existing.type != body.type:
        raise service.invalid("The database type of an existing source can't change.")
    resolved = await _resolve(request, body.type, body.connection, body.secrets, existing)
    # Never show the structure of a database through a writable account.
    service.require_read_only(await service.test_connection(resolved))
    return service.snapshot_of(await service.discover(resolved))


@router.get("/{source_id}", response_model=AdminSourceDetailOut)
async def get_source(source_id: str, _: Admin, db: Db) -> AdminSourceDetailOut:
    return await to_detail(db, await _get_source(db, source_id))


@router.post("", response_model=AdminSourceDetailOut, status_code=201)
async def create_source(
    body: SourceConfigIn, principal: RecentAdmin, db: Db, request: Request
) -> AdminSourceDetailOut:
    describe = _clean_describe(body)
    resolved = await _resolve(request, body.type, body.connection, body.secrets, None)
    outcome = await service.test_connection(resolved)
    service.require_read_only(outcome)
    snapshot = service.snapshot_of(await service.discover(resolved))
    exposed = service.validate_exposed([e.model_dump() for e in body.exposed], snapshot)

    source = Source(
        id=await _slug(db, describe["name"]),
        type=body.type,
        owner=principal.user.name,
        enabled=True,
        status="healthy",
        status_message=outcome.message,
        last_checked_at=utcnow(),
        connection=resolved.connection,
        secret_namespace=uuid.uuid4().hex,
        secret_status={},
        exposed=exposed,
        schema_snapshot=snapshot,
        created_by=principal.user.id,
        **describe,
    )
    db.add(source)
    await _set_roles(db, source.id, body.roleIds)
    store = _store(request)
    await _write_secrets(store, source, resolved)
    try:
        await db.commit()
    except Exception:
        await store.delete(source.secret_namespace, list(source.secret_status))
        raise
    await _audit(request).record(
        principal.actor,
        AuditRecord(
            action="source_created",
            outcome="success",
            sources=[_ref(source)],
            details=f"Exposed {len(exposed)} tables/collections to roles: {', '.join(sorted(body.roleIds))}",
        ),
    )
    return await to_detail(db, source)


@router.put("/{source_id}", response_model=AdminSourceDetailOut)
async def update_source(
    source_id: str, body: SourceConfigIn, principal: RecentAdmin, db: Db, request: Request
) -> AdminSourceDetailOut:
    source = await _get_source(db, source_id)
    if body.type != source.type:
        raise service.invalid("The database type of an existing source can't change.")
    describe = _clean_describe(body)
    resolved = await _resolve(request, body.type, body.connection, body.secrets, source)
    connection_changed = bool(resolved.new_secrets) or resolved.connection != source.connection

    outcome = await service.test_connection(resolved)
    if outcome.ok or connection_changed:
        # New settings must be proven; unchanged ones must still be read-only if reachable.
        service.require_read_only(outcome)
        snapshot = service.snapshot_of(await service.discover(resolved))
        source.schema_snapshot = snapshot
        source.status, source.status_message, source.last_checked_at = "healthy", outcome.message, utcnow()
    else:
        # Database briefly unreachable and only descriptions/access changed: use the last snapshot.
        snapshot = source.schema_snapshot
        source.status, source.status_message, source.last_checked_at = "offline", outcome.message, utcnow()
    exposed = service.validate_exposed([e.model_dump() for e in body.exposed], snapshot)

    if (exposed, describe["glossary"], describe["description"]) != (
        source.exposed,
        source.glossary,
        source.description,
    ):
        source.schema_version += 1
    source.exposed = exposed
    source.connection = resolved.connection
    for key, value in describe.items():
        setattr(source, key, value)
    await _set_roles(db, source.id, body.roleIds)
    replaced = await _write_secrets(_store(request), source, resolved)
    await db.commit()

    details = "Settings and credentials updated" if replaced else "Settings updated"
    await _audit(request).record(
        principal.actor,
        AuditRecord(
            action="source_updated",
            outcome="success",
            sources=[_ref(source)],
            details=f"{details}; roles: {', '.join(sorted(body.roleIds))}",
        ),
    )
    return await to_detail(db, source)


@router.patch("/{source_id}", response_model=AdminSourceOut)
async def set_enabled(
    source_id: str, body: EnabledIn, principal: Admin, db: Db, request: Request
) -> AdminSourceOut:
    source = await _get_source(db, source_id)
    if body.enabled and not source.enabled:
        await require_recent_auth(principal, request)  # re-enabling is sensitive
    if body.enabled != source.enabled:
        source.enabled = body.enabled
        await db.commit()
        await _audit(request).record(
            principal.actor,
            AuditRecord(
                action="source_updated",
                outcome="success",
                sources=[_ref(source)],
                details="Enabled" if body.enabled else "Disabled",
            ),
        )
    return to_admin_source(source)


@router.delete("/{source_id}", status_code=204)
async def delete_source(source_id: str, principal: RecentAdmin, db: Db, request: Request) -> Response:
    source = await _get_source(db, source_id)
    try:
        await _store(request).delete(source.secret_namespace, list(source.secret_status))
    except Exception as exc:
        log.exception("Deleting stored credentials failed for %s", source.id)
        raise ApiError(
            502,
            "secret_store_failed",
            "Couldn't delete the stored credentials, so nothing was removed. Try again.",
        ) from exc
    ref = _ref(source)
    for role in await db.scalars(select(Role)):
        if source.id in role.source_ids:
            role.source_ids = [sid for sid in role.source_ids if sid != source.id]
    await db.delete(source)
    await db.commit()
    await _audit(request).record(
        principal.actor,
        AuditRecord(
            action="source_deleted",
            outcome="success",
            sources=[ref],
            details="Stored credentials deleted",
        ),
    )
    return Response(status_code=204)


@router.post("/{source_id}/check", response_model=AdminSourceOut)
async def check_source(source_id: str, _: Admin, db: Db, request: Request) -> AdminSourceOut:
    source = await _get_source(db, source_id)
    resolved = await _resolve(request, source.type, source.connection, {}, source)  # type: ignore[arg-type]
    outcome = await service.test_connection(resolved)
    if not outcome.ok:
        source.status = "offline"
    elif not outcome.read_only:
        source.status = "degraded"  # the account gained write access; fix it before people rely on it
    else:
        source.status = "healthy"
    source.status_message, source.last_checked_at = outcome.message, utcnow()
    return to_admin_source(source)
