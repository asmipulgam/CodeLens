"""Sign-in, session and sign-out endpoints.

Browser-navigation endpoints (login, callback) answer with redirects. Everything the frontend calls
with fetch answers with JSON — an expired session is a 401, never a redirect.
"""

from __future__ import annotations

import logging
import secrets
import time
import uuid
from datetime import UTC, datetime
from typing import Annotated

import httpx
from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit import Actor, AuditLog, AuditRecord
from app.auth.deps import CurrentPrincipal, check_same_origin, client_ip, settings_of, store_of
from app.auth.oidc import Identity, OidcClient, OidcError, pkce_pair
from app.auth.return_to import safe_return_to
from app.auth.roles import Permissions, roles_from_groups, sync_group_roles
from app.auth.sessions import LoginTransaction, binding_digest
from app.config import Settings
from app.db import get_db
from app.errors import rate_limited
from app.models import User, utcnow

log = logging.getLogger("codelens.auth")
router = APIRouter(prefix="/api/auth", tags=["auth"])


class SessionUserOut(BaseModel):
    id: str
    name: str
    email: str
    roles: list[str]
    permissions: Permissions


class SessionOut(BaseModel):
    user: SessionUserOut
    csrfToken: str
    expiresAt: str
    idleTimeoutSeconds: int
    # Until when sensitive admin changes are allowed without signing in again (step-up).
    recentAuthUntil: str


class LogoutOut(BaseModel):
    redirectUrl: str | None = None


class ProviderOut(BaseModel):
    id: str
    label: str


def _providers(request: Request) -> dict[str, OidcClient]:
    providers: dict[str, OidcClient] = request.app.state.oidc_providers
    return providers


def _audit(request: Request) -> AuditLog:
    audit: AuditLog = request.app.state.audit
    return audit


def _to_login(settings: Settings, reason: str) -> RedirectResponse:
    return RedirectResponse(f"{settings.public_url}/login?reason={reason}", status_code=303)


def _set_cookie(
    response: Response, settings: Settings, name: str, value: str, *, same_site: str, max_age: int | None
) -> None:
    response.set_cookie(
        name,
        value,
        max_age=max_age,
        path="/",
        secure=settings.cookie_secure,
        httponly=True,
        samesite=same_site,  # type: ignore[arg-type]
    )


async def _check_rate(request: Request) -> None:
    settings = settings_of(request)
    if await store_of(request).hit_rate_limit(
        f"login:{client_ip(request)}", settings.login_rate_limit_per_minute
    ):
        raise rate_limited()


# ── GET /api/auth/providers ──────────────────────────────────────────────────


@router.get("/providers", response_model=list[ProviderOut])
async def providers(request: Request) -> list[ProviderOut]:
    """The sign-in buttons to show. Public: it reveals only which providers are switched on."""
    return [ProviderOut(id=p.provider_id, label=p.label) for p in _providers(request).values()]


# ── GET /api/auth/login ──────────────────────────────────────────────────────


@router.get("/login", include_in_schema=False)
async def login(
    request: Request,
    returnTo: str | None = None,
    prompt: str | None = None,
    provider: str | None = None,
) -> Response:
    await _check_rate(request)
    settings = settings_of(request)
    store = store_of(request)
    step_up = prompt == "login"

    if provider is None and step_up:
        # "Confirm it's you" re-uses whichever sign-in the current session came from.
        current = request.cookies.get(settings.session_cookie_name, "")
        data = await store.load(current, touch=False) if current else None
        provider = data.provider if data else None
    client = _providers(request).get(provider or "company")
    if client is None or (step_up and not client.supports_step_up):
        return _to_login(settings, "sign_in_failed")

    # A random value in a cookie binds the sign-in to this browser. Several tabs may share it.
    binding = request.cookies.get(settings.login_cookie_name, "")
    if not (32 <= len(binding) <= 128):
        binding = secrets.token_urlsafe(32)

    verifier, challenge = pkce_pair()
    txn = LoginTransaction(
        state=secrets.token_urlsafe(32),
        nonce=secrets.token_urlsafe(32),
        code_verifier=verifier,
        return_to=safe_return_to(returnTo),
        binding_digest=binding_digest(binding),
        step_up=step_up,
        created_at=time.time(),
        provider=client.provider_id,
    )
    try:
        url = await client.authorization_url(
            state=txn.state, nonce=txn.nonce, code_challenge=challenge, step_up=txn.step_up
        )
    except (httpx.HTTPError, OidcError, ValueError):
        log.exception("Identity provider is unreachable or misconfigured")
        return _to_login(settings, "sign_in_failed")

    await store.save_login(txn)
    response = RedirectResponse(url, status_code=303)
    # Lax (not Strict): the identity provider sends the browser back to us with a cross-site redirect.
    _set_cookie(response, settings, settings.login_cookie_name, binding, same_site="lax", max_age=600)
    return response


# ── GET /api/auth/callback ───────────────────────────────────────────────────


async def _upsert_user(db: AsyncSession, identity: Identity) -> User:
    user = await db.scalar(
        select(User).where(User.issuer == identity.issuer, User.subject == identity.subject)
    )
    if user is None:
        user = User(
            id=f"u-{uuid.uuid4().hex[:16]}",
            issuer=identity.issuer,
            subject=identity.subject,
            email=identity.email,
            name=identity.name,
            groups=identity.groups,
            status="active",
        )
        user.role_links = []
        db.add(user)
    else:
        user.email, user.name, user.groups = identity.email, identity.name, identity.groups
    user.last_login_at = utcnow()
    await db.flush()
    return user


@router.get("/callback", include_in_schema=False)
async def callback(
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db)],
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
) -> Response:
    await _check_rate(request)
    settings = settings_of(request)
    store = store_of(request)
    audit = _audit(request)

    txn = await store.take_login(state or "")
    binding = request.cookies.get(settings.login_cookie_name, "")
    if txn is None or not binding or not secrets.compare_digest(binding_digest(binding), txn.binding_digest):
        log.warning("Sign-in callback with unknown, expired or foreign state")
        return _to_login(settings, "sign_in_failed")
    if error or not code:
        log.info("Identity provider returned an error: %s", (error or "no code")[:64])
        return _to_login(settings, "sign_in_failed")

    client = _providers(request).get(txn.provider)
    if client is None:
        return _to_login(settings, "sign_in_failed")
    try:
        identity = await client.exchange_code(
            code=code,
            code_verifier=txn.code_verifier,
            nonce=txn.nonce,
            step_up_since=txn.created_at if txn.step_up else None,
        )
    except (httpx.HTTPError, OidcError, KeyError, ValueError) as exc:
        log.warning("Sign-in failed: %s", exc)
        return _to_login(settings, "sign_in_failed")

    user = await _upsert_user(db, identity)
    if client.provider_id == "google":
        # Only allow-listed Google accounts, with exactly the roles listed for them. Never admin.
        role_ids = set(settings.google_users.get(identity.email.strip().lower(), [])) - {"admin"}
    else:
        role_ids = roles_from_groups(identity.groups, settings.group_role_map, settings.default_roles)
    await sync_group_roles(db, user, role_ids)
    actor = Actor(id=user.id, name=user.name, email=user.email, ip_address=client_ip(request))

    if user.status != "active" or not user.role_links:
        await db.commit()  # keep the user record so admins can see who tried and grant access
        reason = (
            "account disabled"
            if user.status != "active"
            else f"no CodeLens role for this {client.label} account"
        )
        await audit.record(actor, AuditRecord(action="login", outcome="denied", details=reason))
        return _to_login(settings, "no_access")

    # Never reuse a session id across a sign-in (prevents session fixation).
    old_session = request.cookies.get(settings.session_cookie_name)
    if old_session:
        await store.destroy(old_session)
    session_id, _ = await store.create(user.id, identity.auth_time, identity.id_token, client.provider_id)
    await db.commit()
    await audit.record(
        actor,
        AuditRecord(
            action="login",
            outcome="success",
            details=f"via {client.provider_id}{' (step-up)' if txn.step_up else ''}",
        ),
    )

    response = RedirectResponse(f"{settings.public_url}{txn.return_to}", status_code=303)
    # No Max-Age: the cookie dies with the browser; the server enforces idle and absolute limits anyway.
    _set_cookie(
        response, settings, settings.session_cookie_name, session_id, same_site="strict", max_age=None
    )
    response.delete_cookie(settings.login_cookie_name, path="/", secure=settings.cookie_secure, httponly=True)
    return response


# ── GET /api/auth/session ────────────────────────────────────────────────────


@router.get("/session", response_model=SessionOut)
async def session(principal: CurrentPrincipal, request: Request) -> SessionOut:
    settings = settings_of(request)
    return SessionOut(
        user=SessionUserOut(
            id=principal.user.id,
            name=principal.user.name,
            email=principal.user.email,
            roles=[role.id for role in principal.roles],
            permissions=principal.permissions,
        ),
        csrfToken=principal.session.csrf_token,
        expiresAt=datetime.fromtimestamp(principal.session.absolute_expires_at, UTC).isoformat(),
        idleTimeoutSeconds=settings.session_idle_seconds,
        recentAuthUntil=datetime.fromtimestamp(
            principal.session.absolute_expires_at
            if principal.session.provider == "dev"  # no re-authentication in development auto sign-in
            else principal.session.auth_time + settings.step_up_max_age_seconds,
            UTC,
        ).isoformat(),
    )


# ── POST /api/auth/logout ────────────────────────────────────────────────────


@router.post("/logout", response_model=LogoutOut)
async def logout(request: Request, response: Response) -> LogoutOut:
    """Works even if the session already expired, so the browser always ends up signed out."""
    settings = settings_of(request)
    store = store_of(request)
    check_same_origin(request, settings)
    response.delete_cookie(
        settings.session_cookie_name, path="/", secure=settings.cookie_secure, httponly=True
    )

    session_id = request.cookies.get(settings.session_cookie_name, "")
    data = await store.load(session_id, touch=False) if session_id else None
    if data is None:
        return LogoutOut()
    sent = request.headers.get("x-csrf-token", "")
    if not sent or not secrets.compare_digest(sent, data.csrf_token):
        # Don't let a forged request sign someone out, but don't reveal anything either.
        return LogoutOut()

    await store.destroy(session_id, data.user_id)
    async with request.app.state.sessionmaker() as db:
        user = await db.get(User, data.user_id)
    if user is not None:
        await _audit(request).record(
            Actor(id=user.id, name=user.name, email=user.email, ip_address=client_ip(request)),
            AuditRecord(action="logout", outcome="success"),
        )
    client = _providers(request).get(data.provider)
    if client is None:
        return LogoutOut()
    url = await client.end_session_url(
        id_token_hint=data.id_token_hint,
        post_logout_redirect_uri=f"{settings.public_url}/login?reason=signed_out",
    )
    return LogoutOut(redirectUrl=url)
