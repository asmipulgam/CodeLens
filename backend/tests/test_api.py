from __future__ import annotations

import logging

import httpx
import pytest
from fastapi import FastAPI

from app.auth.return_to import safe_return_to
from app.config import Settings
from app.middleware import StripQueryStringFilter
from app.models import Role
from tests.conftest import PUBLIC_URL, FakeIdP, session_of, sign_in


async def test_security_headers_on_every_response(client: httpx.AsyncClient) -> None:
    for response in (
        await client.get("/api/health"),
        await client.get("/api/auth/session"),
        await client.get("/api/nope"),
    ):
        assert response.headers["cache-control"] == "no-store"
        assert response.headers["x-content-type-options"] == "nosniff"
        assert response.headers["x-frame-options"] == "DENY"
        assert "frame-ancestors 'none'" in response.headers["content-security-policy"]
        assert "server" not in response.headers
    assert (await client.get("/api/health")).headers["strict-transport-security"].startswith("max-age=")


async def test_errors_are_json_without_internals(client: httpx.AsyncClient, idp: FakeIdP) -> None:
    missing = await client.get("/api/does-not-exist")
    assert missing.status_code == 404 and missing.json() == {"code": "not_found", "message": "Not found."}

    await sign_in(client, idp)
    token = (await session_of(client))["csrfToken"]
    bad = await client.put(
        "/api/me/preferences", json={"showGeneratedQuery": "<b>", "extra": 1}, headers={"X-CSRF-Token": token}
    )
    assert bad.status_code == 422
    body = bad.json()
    assert body["code"] == "invalid" and "<b>" not in body["message"]
    assert set(body) == {"code", "message"}


async def test_oversized_body_is_rejected(client: httpx.AsyncClient) -> None:
    response = await client.post("/api/auth/logout", content=b"x" * 1_100_000)
    assert response.status_code == 413 and response.json()["code"] == "too_large"


async def test_preferences_respect_permissions(app: FastAPI, client: httpx.AsyncClient, idp: FakeIdP) -> None:
    async with app.state.sessionmaker() as db, db.begin():
        role = await db.get(Role, "business")
        assert role is not None
        role.source_ids = ["sales-db"]

    await sign_in(client, idp, "business")
    token = (await session_of(client))["csrfToken"]
    assert (await client.get("/api/me/preferences")).json() == {
        "showGeneratedQuery": False,
        "defaultSourceIds": [],
    }

    saved = await client.put(
        "/api/me/preferences",
        json={"showGeneratedQuery": True, "defaultSourceIds": ["sales-db", "hr", "sales-db"]},
        headers={"X-CSRF-Token": token},
    )
    # A business user can't see queries, and has no access to HR.
    assert saved.json() == {"showGeneratedQuery": False, "defaultSourceIds": ["sales-db"]}
    assert (await client.get("/api/me/preferences")).json() == saved.json()


async def test_lists_are_empty_until_built(client: httpx.AsyncClient, idp: FakeIdP) -> None:
    await sign_in(client, idp)
    for path in ("/api/sources", "/api/conversations", "/api/saved-questions"):
        assert (await client.get(path)).json() == []


def test_production_refuses_unsafe_settings() -> None:
    with pytest.raises(RuntimeError) as error:
        Settings(environment="production", _env_file=None).check_production_safety()  # type: ignore[call-arg]
    message = str(error.value)
    for problem in ("PUBLIC_URL", "OIDC_ISSUER", "CLIENT_SECRET", "SECRET_STORE", "LOCAL_SOURCE_HOSTS"):
        assert problem in message

    Settings(  # type: ignore[call-arg]
        environment="production",
        public_url="https://codelens.corp",
        oidc_issuer="https://login.corp",
        oidc_client_secret="a-real-secret",
        secret_store="azure_key_vault",
        key_vault_url="https://codelens-kv.vault.azure.net",
        allow_local_source_hosts=False,
        _env_file=None,
    ).check_production_safety()


def test_development_cookies_without_https() -> None:
    settings = Settings(cookie_secure=False, _env_file=None)  # type: ignore[call-arg]
    assert settings.session_cookie_name == "codelens_session"
    assert Settings(_env_file=None).session_cookie_name == "__Host-codelens_session"  # type: ignore[call-arg]


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (None, "/ask"),
        ("", "/ask"),
        ("/catalog", "/catalog"),
        ("/ask/c-1?x=1#y", "/ask/c-1?x=1#y"),
        ("//evil.com", "/ask"),
        ("/\\evil.com", "/ask"),
        ("https://evil.com", "/ask"),
        ("/ask\nSet-Cookie: x", "/ask"),
        ("/api/auth/login", "/ask"),
        ("/" + "a" * 3000, "/ask"),
    ],
)
def test_safe_return_to(value: str | None, expected: str) -> None:
    assert safe_return_to(value) == expected


def test_access_log_drops_query_strings() -> None:
    record = logging.LogRecord(
        "uvicorn.access",
        logging.INFO,
        "",
        0,
        '%s - "%s %s HTTP/%s" %d',
        ("1.2.3.4", "GET", "/api/auth/callback?code=secret&state=s", "1.1", 303),
        None,
    )
    StripQueryStringFilter().filter(record)
    assert "secret" not in record.getMessage()
    assert "/api/auth/callback" in record.getMessage()


def test_public_url_is_used_for_redirects(settings: Settings) -> None:
    assert settings.redirect_uri == f"{PUBLIC_URL}/api/auth/callback"
