"""Development-only auto sign-in: no sign-in page, never in production."""

from __future__ import annotations

import time

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select

from app.auth import sessions as sessions_module
from app.config import Settings
from app.models import AuditEvent, User


@pytest.fixture
def auto(app: FastAPI) -> FastAPI:
    app.state.settings.dev_auto_login = True
    return app


async def test_first_visit_is_signed_in_as_local_developer(auto: FastAPI, client: httpx.AsyncClient) -> None:
    response = await client.get("/api/auth/session")
    assert response.status_code == 200
    session = response.json()
    assert session["user"]["name"] == "Local Developer"
    assert session["user"]["roles"] == ["admin", "analyst"]
    assert session["user"]["permissions"]["canAdmin"] is True
    cookie = response.headers["set-cookie"]
    assert "HttpOnly" in cookie and "SameSite=strict" in cookie

    # The same session is reused afterwards, and the CSRF token still protects writes.
    again = await client.get("/api/auth/session")
    assert again.json()["csrfToken"] == session["csrfToken"]
    assert (
        await client.put("/api/me/preferences", json={"showGeneratedQuery": True, "defaultSourceIds": []})
    ).status_code == 403

    async with auto.state.sessionmaker() as db:
        users = list(await db.scalars(select(User)))
        events = list(await db.scalars(select(AuditEvent)))
    assert [u.email for u in users] == ["developer@localhost"]
    assert [(e.action, e.details) for e in events] == [("login", "development auto sign-in")]


async def test_admin_changes_need_no_re_sign_in(
    auto: FastAPI, client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    await client.get("/api/auth/session")
    start = time.time()
    for minutes in (10, 20, 31):
        monkeypatch.setattr(sessions_module.time, "time", lambda m=minutes: start + m * 60)
        assert (await client.get("/api/auth/session")).status_code == 200
    session = (await client.get("/api/auth/session")).json()
    assert session["recentAuthUntil"] == session["expiresAt"]
    assert (
        await client.patch(
            "/api/admin/sources/nope", json={"enabled": True}, headers={"X-CSRF-Token": session["csrfToken"]}
        )
    ).status_code == 404  # not 401


async def test_off_by_default(client: httpx.AsyncClient) -> None:
    assert (await client.get("/api/auth/session")).status_code == 401


def test_refused_in_production() -> None:
    with pytest.raises(RuntimeError, match="DEV_AUTO_LOGIN"):
        Settings(  # type: ignore[call-arg]
            environment="production",
            public_url="https://codelens.corp",
            oidc_issuer="https://login.corp",
            oidc_client_secret="real",
            secret_store="azure_key_vault",
            key_vault_url="https://kv.vault.azure.net",
            allow_local_source_hosts=False,
            dev_auto_login=True,
            _env_file=None,
        ).check_production_safety()
