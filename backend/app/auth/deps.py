"""Request guards: who is calling, did the request come from our own page, and may they do this?"""

from __future__ import annotations

import hmac
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, timedelta
from typing import Annotated

from fastapi import Depends, Request, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit import Actor
from app.auth.roles import Permissions, combine_permissions, roles_of
from app.auth.sessions import SessionData, SessionStore
from app.config import Settings
from app.db import get_db
from app.errors import csrf_failed, forbidden, step_up_required, unauthorized
from app.models import Role, User, utcnow

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
LAST_ACTIVE_RESOLUTION = timedelta(minutes=1)


@dataclass
class Principal:
    user: User
    roles: list[Role]
    permissions: Permissions
    session_id: str
    session: SessionData
    ip_address: str | None

    @property
    def actor(self) -> Actor:
        return Actor(id=self.user.id, name=self.user.name, email=self.user.email, ip_address=self.ip_address)

    @property
    def allowed_source_ids(self) -> set[str]:
        ids: set[str] = set()
        for role in self.roles:
            ids.update(role.source_ids)
        return ids


def settings_of(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


def store_of(request: Request) -> SessionStore:
    store: SessionStore = request.app.state.sessions
    return store


def client_ip(request: Request) -> str | None:
    # Uvicorn rewrites request.client from X-Forwarded-For only for proxies listed in --forwarded-allow-ips.
    return request.client.host if request.client else None


def check_same_origin(request: Request, settings: Settings) -> None:
    """Second CSRF layer: a browser always sends Origin on cross-origin writes, so reject a foreign one."""
    origin = request.headers.get("origin")
    if origin is not None and origin != settings.public_origin:
        raise csrf_failed()


DEV_PROVIDER = "dev"


async def _dev_auto_login(
    request: Request, response: Response, db: AsyncSession, settings: Settings
) -> tuple[str, SessionData]:
    """Development only: sign the visitor in as a local developer, without any sign-in page."""
    from app.audit import AuditLog, AuditRecord
    from app.auth.roles import sync_group_roles

    user = await db.scalar(
        select(User).where(User.issuer == "codelens-dev", User.subject == "local-developer")
    )
    if user is None:
        user = User(
            id="u-local-developer",
            issuer="codelens-dev",
            subject="local-developer",
            email="developer@localhost",
            name="Local Developer",
            groups=[],
            status="active",
        )
        user.role_links = []
        db.add(user)
        await db.flush()
    await sync_group_roles(db, user, set(settings.dev_auto_login_roles))
    await db.commit()

    session_id, session = await store_of(request).create(user.id, time.time(), "", DEV_PROVIDER)
    response.set_cookie(
        settings.session_cookie_name,
        session_id,
        path="/",
        secure=settings.cookie_secure,
        httponly=True,
        samesite="strict",
    )
    audit: AuditLog = request.app.state.audit
    await audit.record(
        Actor(id=user.id, name=user.name, email=user.email, ip_address=client_ip(request)),
        AuditRecord(action="login", outcome="success", details="development auto sign-in"),
    )
    return session_id, session


async def get_principal(
    request: Request, response: Response, db: Annotated[AsyncSession, Depends(get_db)]
) -> Principal:
    settings = settings_of(request)
    store = store_of(request)

    session_id = request.cookies.get(settings.session_cookie_name, "")
    session = await store.load(session_id) if session_id else None
    if session is None and settings.dev_auto_login and not settings.is_production:
        session_id, session = await _dev_auto_login(request, response, db, settings)
    if session is None:
        raise unauthorized()

    if request.method not in SAFE_METHODS:
        check_same_origin(request, settings)
        sent = request.headers.get("x-csrf-token", "")
        if not sent or not hmac.compare_digest(sent, session.csrf_token):
            raise csrf_failed()

    user = await db.scalar(select(User).where(User.id == session.user_id))
    if user is None or user.status != "active":
        await store.destroy(session_id, session.user_id)
        raise unauthorized()

    now = utcnow()
    last_active = user.last_active_at
    if last_active is not None and last_active.tzinfo is None:  # SQLite returns naive UTC
        last_active = last_active.replace(tzinfo=UTC)
    if last_active is None or now - last_active > LAST_ACTIVE_RESOLUTION:
        user.last_active_at = now

    roles = roles_of(user)
    if session.provider == "google":
        # Admin rights need a sign-in that can enforce a fresh login (MFA); Google can't.
        roles = [role for role in roles if not role.permissions.get("canAdmin")]
    return Principal(
        user=user,
        roles=roles,
        permissions=combine_permissions(roles),
        session_id=session_id,
        session=session,
        ip_address=client_ip(request),
    )


CurrentPrincipal = Annotated[Principal, Depends(get_principal)]


def require_permission(name: str) -> Callable[[Principal], Awaitable[Principal]]:
    if name not in Permissions.model_fields:
        raise ValueError(f"Unknown permission {name}")

    async def dependency(principal: CurrentPrincipal) -> Principal:
        if not getattr(principal.permissions, name):
            raise forbidden()
        return principal

    return dependency


async def require_recent_auth(principal: CurrentPrincipal, request: Request) -> Principal:
    """For sensitive admin changes: the person must have signed in at the identity provider recently."""
    if principal.session.provider == DEV_PROVIDER:
        return principal  # development auto sign-in has no identity provider to re-authenticate with
    if time.time() - principal.session.auth_time > settings_of(request).step_up_max_age_seconds:
        raise step_up_required()
    return principal
