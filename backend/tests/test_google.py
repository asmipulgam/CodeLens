"""Sign in with Google: only allow-listed accounts, never admin, no step-up."""

from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI
from pydantic import ValidationError
from sqlalchemy import select

from app.config import Settings
from app.models import AuditEvent, Role
from tests.conftest import FakeIdP, session_of, sign_in


async def test_both_sign_in_options_are_offered(client: httpx.AsyncClient) -> None:
    response = await client.get("/api/auth/providers")
    assert response.json() == [
        {"id": "company", "label": "your company account"},
        {"id": "google", "label": "Google"},
    ]


async def test_allow_listed_google_account_signs_in(
    app: FastAPI, client: httpx.AsyncClient, google: FakeIdP
) -> None:
    start = await client.get("/api/auth/login", params={"provider": "google"})
    assert start.headers["location"].startswith("https://accounts.google.test/")
    response = await sign_in(client, google, "guest", provider="google")
    assert response.headers["location"].endswith("/ask")

    session = await session_of(client)
    # The email is matched case-insensitively and the roles come from CODELENS_GOOGLE_USERS.
    assert session["user"]["email"] == "Friend.Guest@gmail.test"
    assert session["user"]["roles"] == ["analyst"]
    async with app.state.sessionmaker() as db:
        event = await db.scalar(select(AuditEvent).order_by(AuditEvent.seq.desc()))
    assert event is not None and (event.outcome, event.details) == ("success", "via google")


async def test_other_google_accounts_are_refused(
    app: FastAPI, client: httpx.AsyncClient, google: FakeIdP
) -> None:
    response = await sign_in(client, google, "stranger", provider="google")
    assert response.headers["location"].endswith("/login?reason=no_access")
    assert (await client.get("/api/auth/session")).status_code == 401
    async with app.state.sessionmaker() as db:
        event = await db.scalar(select(AuditEvent).order_by(AuditEvent.seq.desc()))
    assert event is not None and event.outcome == "denied" and event.user_email == "stranger@gmail.test"


async def test_unverified_email_is_refused(client: httpx.AsyncClient, google: FakeIdP) -> None:
    """Someone can't claim an allow-listed address on an account whose email Google hasn't verified."""
    response = await sign_in(client, google, "unverified", provider="google")
    assert response.headers["location"].endswith("reason=sign_in_failed")


async def test_google_token_for_another_app_is_refused(client: httpx.AsyncClient, google: FakeIdP) -> None:
    google.tamper = {"aud": "someone-elses-app.apps.googleusercontent.test"}
    response = await sign_in(client, google, "guest", provider="google")
    assert response.headers["location"].endswith("reason=sign_in_failed")


async def test_company_token_cannot_be_used_as_google(client: httpx.AsyncClient, idp: FakeIdP) -> None:
    """A code from one provider can't be redeemed through the other."""
    start = await client.get("/api/auth/login", params={"provider": "google"})
    code, state = idp.authorize(start.headers["location"], {"sub": "x", "email": "friend.guest@gmail.test"})
    response = await client.get("/api/auth/callback", params={"code": code, "state": state})
    assert response.headers["location"].endswith("reason=sign_in_failed")


async def test_google_users_never_get_admin(app: FastAPI, client: httpx.AsyncClient, google: FakeIdP) -> None:
    await sign_in(client, google, "guest", provider="google")
    # Even if someone later gives this user the admin role directly...
    async with app.state.sessionmaker() as db, db.begin():
        from app.models import User, UserRole

        user = await db.scalar(select(User).where(User.subject == "g-1"))
        assert user is not None and await db.get(Role, "admin") is not None
        db.add(UserRole(user_id=user.id, role_id="admin", origin="manual"))
    session = await session_of(client)
    assert "admin" not in session["user"]["roles"]
    assert session["user"]["permissions"]["canAdmin"] is False
    assert (await client.get("/api/admin/sources")).status_code == 403


async def test_google_sessions_have_no_step_up(client: httpx.AsyncClient, google: FakeIdP) -> None:
    await sign_in(client, google, "guest", provider="google")
    response = await client.get("/api/auth/login", params={"prompt": "login"})
    assert response.headers["location"].endswith("reason=sign_in_failed")


async def test_google_logout_has_no_provider_redirect(client: httpx.AsyncClient, google: FakeIdP) -> None:
    await sign_in(client, google, "guest", provider="google")
    token = (await session_of(client))["csrfToken"]
    response = await client.post("/api/auth/logout", headers={"X-CSRF-Token": token})
    assert response.json() == {"redirectUrl": None}
    assert (await client.get("/api/auth/session")).status_code == 401


async def test_unknown_provider(client: httpx.AsyncClient) -> None:
    response = await client.get("/api/auth/login", params={"provider": "facebook"})
    assert response.headers["location"].endswith("reason=sign_in_failed")


def test_google_admins_are_rejected_in_configuration() -> None:
    with pytest.raises(ValidationError, match="can't have the admin role"):
        Settings(google_users={"boss@gmail.com": ["admin"]}, _env_file=None)  # type: ignore[call-arg]
    with pytest.raises(ValidationError, match="not an email"):
        Settings(google_users={"not-an-email": ["business"]}, _env_file=None)  # type: ignore[call-arg]


def test_google_is_off_until_configured() -> None:
    assert not Settings(_env_file=None).google_enabled  # type: ignore[call-arg]
    assert not Settings(google_client_id="x", google_client_secret="y", _env_file=None).google_enabled  # type: ignore[call-arg]
