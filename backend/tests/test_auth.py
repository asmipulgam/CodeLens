from __future__ import annotations

import time
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from fastapi import Depends, FastAPI
from joserfc.jwk import RSAKey
from sqlalchemy import select

from app.audit import AuditLog
from app.auth import sessions as sessions_module
from app.auth.deps import Principal, require_permission, require_recent_auth
from app.models import AuditEvent, User
from tests.conftest import PUBLIC_URL, USERS, FakeIdP, session_of, set_cookie_headers, sign_in


async def audit_rows(app: FastAPI) -> list[AuditEvent]:
    async with app.state.sessionmaker() as db:
        return list(await db.scalars(select(AuditEvent).order_by(AuditEvent.seq)))


# ── starting sign-in ───────────────────────────────────────────────────────


async def test_login_redirects_to_provider_with_pkce(client: httpx.AsyncClient) -> None:
    response = await client.get("/api/auth/login", params={"returnTo": "/catalog"})
    assert response.status_code == 303
    url = urlsplit(response.headers["location"])
    query = {k: v[0] for k, v in parse_qs(url.query).items()}
    assert url.path.endswith("/protocol/openid-connect/auth")
    assert query["code_challenge_method"] == "S256"
    assert len(query["code_challenge"]) == 43
    assert query["redirect_uri"] == f"{PUBLIC_URL}/api/auth/callback"
    assert query["scope"] == "openid profile email"
    assert len(query["state"]) >= 40 and len(query["nonce"]) >= 40
    assert "prompt" not in query

    [cookie] = set_cookie_headers(response)
    assert cookie.startswith("__Host-codelens_login=")
    for flag in ("HttpOnly", "Secure", "Path=/", "SameSite=lax", "Max-Age=600"):
        assert flag in cookie


async def test_step_up_login_forces_reauthentication(client: httpx.AsyncClient) -> None:
    response = await client.get("/api/auth/login", params={"returnTo": "/admin", "prompt": "login"})
    query = parse_qs(urlsplit(response.headers["location"]).query)
    assert query["prompt"] == ["login"] and query["max_age"] == ["0"]


# ── completing sign-in ─────────────────────────────────────────────────────


async def test_full_sign_in(app: FastAPI, client: httpx.AsyncClient, idp: FakeIdP) -> None:
    response = await sign_in(client, idp, "analyst", return_to="/ask/c-1?x=1")
    assert response.status_code == 303
    assert response.headers["location"] == f"{PUBLIC_URL}/ask/c-1?x=1"

    cookies = set_cookie_headers(response)
    session_cookie = next(c for c in cookies if c.startswith("__Host-codelens_session="))
    for flag in ("HttpOnly", "Secure", "Path=/", "SameSite=strict"):
        assert flag in session_cookie
    assert "Max-Age" not in session_cookie and "Domain" not in session_cookie
    assert any(c.startswith("__Host-codelens_login=") and "Max-Age=0" in c for c in cookies)

    session = await session_of(client)
    assert session["user"]["name"] == "Marcus Lee"
    assert session["user"]["email"] == "marcus@example.com"
    assert session["user"]["roles"] == ["analyst"]
    assert session["user"]["permissions"] == {
        "canViewQuery": True,
        "canExport": True,
        "canChooseSource": True,
        "canAdmin": False,
        "canAudit": False,
        "exportRowLimit": 10000,
    }
    assert session["idleTimeoutSeconds"] == 900
    assert len(session["csrfToken"]) >= 40
    # No tokens of any kind are handed to the browser.
    assert "eyJ" not in str(session)

    [event] = await audit_rows(app)
    assert (event.action, event.outcome, event.user_email) == ("login", "success", "marcus@example.com")


async def test_groups_are_resynced_at_each_sign_in(
    app: FastAPI, client: httpx.AsyncClient, idp: FakeIdP
) -> None:
    await sign_in(client, idp, "analyst")
    assert (await session_of(client))["user"]["roles"] == ["analyst"]
    USERS["analyst"] = {**USERS["analyst"], "groups": ["codelens-analysts", "codelens-auditors"]}
    try:
        await sign_in(client, idp, "analyst")
        session = await session_of(client)
    finally:
        USERS["analyst"] = {**USERS["analyst"], "groups": ["codelens-analysts"]}
    assert session["user"]["roles"] == ["analyst", "auditor"]
    assert session["user"]["permissions"]["canAudit"] is True
    async with app.state.sessionmaker() as db:
        assert len(list(await db.scalars(select(User)))) == 1  # same person, same record


@pytest.mark.parametrize(
    "return_to",
    [
        "https://evil.com",
        "//evil.com",
        "/\\evil.com",
        "javascript:alert(1)",
        "/api/auth/logout",
        "/login",
        "ask",
    ],
)
async def test_return_to_cannot_leave_the_site(
    client: httpx.AsyncClient, idp: FakeIdP, return_to: str
) -> None:
    response = await sign_in(client, idp, return_to=return_to)
    assert response.headers["location"] == f"{PUBLIC_URL}/ask"


async def test_user_without_a_mapped_group_is_refused(
    app: FastAPI, client: httpx.AsyncClient, idp: FakeIdP
) -> None:
    response = await sign_in(client, idp, "outsider")
    assert response.headers["location"] == f"{PUBLIC_URL}/login?reason=no_access"
    assert not any("codelens_session" in c for c in set_cookie_headers(response))
    assert (await client.get("/api/auth/session")).status_code == 401
    [event] = await audit_rows(app)
    assert (event.action, event.outcome, event.user_email) == ("login", "denied", "alex@example.com")


async def test_disabled_user_is_refused_and_signed_out(
    app: FastAPI, client: httpx.AsyncClient, idp: FakeIdP
) -> None:
    await sign_in(client, idp, "business")
    async with app.state.sessionmaker() as db, db.begin():
        user = await db.scalar(select(User))
        assert user is not None
        user.status = "disabled"
    assert (await client.get("/api/auth/session")).status_code == 401
    response = await sign_in(client, idp, "business")
    assert response.headers["location"].endswith("/login?reason=no_access")


# ── callback attacks ───────────────────────────────────────────────────────


async def test_callback_with_unknown_state_fails(client: httpx.AsyncClient) -> None:
    await client.get("/api/auth/login")
    response = await client.get("/api/auth/callback", params={"code": "x", "state": "made-up"})
    assert response.headers["location"] == f"{PUBLIC_URL}/login?reason=sign_in_failed"


async def test_callback_cannot_be_replayed(client: httpx.AsyncClient, idp: FakeIdP) -> None:
    start = await client.get("/api/auth/login")
    code, state = idp.authorize(start.headers["location"], USERS["analyst"])
    first = await client.get("/api/auth/callback", params={"code": code, "state": state})
    assert first.headers["location"] == f"{PUBLIC_URL}/ask"
    await client.get("/api/auth/login")  # get a fresh login cookie
    second = await client.get("/api/auth/callback", params={"code": code, "state": state})
    assert second.headers["location"].endswith("reason=sign_in_failed")


async def test_callback_in_a_different_browser_fails(
    app: FastAPI, client: httpx.AsyncClient, idp: FakeIdP
) -> None:
    """Login CSRF: an attacker can't finish their own sign-in inside the victim's browser."""
    start = await client.get("/api/auth/login")
    code, state = idp.authorize(start.headers["location"], USERS["analyst"])
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=PUBLIC_URL) as victim:
        response = await victim.get("/api/auth/callback", params={"code": code, "state": state})
    assert response.headers["location"].endswith("reason=sign_in_failed")
    assert idp.token_requests == 0


async def test_provider_error_is_not_echoed(client: httpx.AsyncClient) -> None:
    start = await client.get("/api/auth/login")
    state = parse_qs(urlsplit(start.headers["location"]).query)["state"][0]
    response = await client.get("/api/auth/callback", params={"state": state, "error": "<script>"})
    assert response.headers["location"] == f"{PUBLIC_URL}/login?reason=sign_in_failed"


@pytest.mark.parametrize(
    "tamper",
    [
        {"nonce": "wrong"},
        {"aud": "another-app"},
        {"iss": "https://evil.test"},
        {"exp": int(time.time()) - 3600},
        {"sub": None},
        {"aud": ["codelens", "other"], "azp": "other"},
    ],
    ids=["nonce", "audience", "issuer", "expired", "no-subject", "azp"],
)
async def test_bad_id_tokens_are_rejected(
    client: httpx.AsyncClient, idp: FakeIdP, tamper: dict[str, object]
) -> None:
    idp.tamper = tamper
    response = await sign_in(client, idp)
    assert response.headers["location"].endswith("reason=sign_in_failed")
    assert (await client.get("/api/auth/session")).status_code == 401


async def test_token_signed_by_another_key_is_rejected(client: httpx.AsyncClient, idp: FakeIdP) -> None:
    idp.signing_key = RSAKey.generate_key(2048, parameters={"kid": "k1"})
    response = await sign_in(client, idp)
    assert response.headers["location"].endswith("reason=sign_in_failed")


async def test_step_up_rejects_a_stale_authentication(client: httpx.AsyncClient, idp: FakeIdP) -> None:
    idp.tamper = {"auth_time": int(time.time()) - 3600}
    response = await sign_in(client, idp, step_up=True)
    assert response.headers["location"].endswith("reason=sign_in_failed")


async def test_sign_in_is_rate_limited(app: FastAPI, client: httpx.AsyncClient) -> None:
    app.state.settings.login_rate_limit_per_minute = 3
    statuses = [(await client.get("/api/auth/login")).status_code for _ in range(4)]
    assert statuses == [303, 303, 303, 429]


async def test_new_sign_in_replaces_the_old_session(client: httpx.AsyncClient, idp: FakeIdP) -> None:
    await sign_in(client, idp)
    old = client.cookies.get("__Host-codelens_session")
    await sign_in(client, idp)
    new = client.cookies.get("__Host-codelens_session")
    assert old and new and old != new
    client.cookies.set("__Host-codelens_session", old)
    assert (await client.get("/api/auth/session")).status_code == 401


# ── session lifetime ───────────────────────────────────────────────────────


async def test_api_never_redirects_when_signed_out(client: httpx.AsyncClient) -> None:
    for path in ("/api/auth/session", "/api/me/preferences", "/api/sources"):
        response = await client.get(path)
        assert response.status_code == 401
        assert response.json() == {"code": "unauthorized", "message": "Please sign in again."}


async def test_idle_timeout(client: httpx.AsyncClient, idp: FakeIdP, monkeypatch: pytest.MonkeyPatch) -> None:
    await sign_in(client, idp)
    now = time.time()
    monkeypatch.setattr(sessions_module.time, "time", lambda: now + 14 * 60)
    assert (await client.get("/api/auth/session")).status_code == 200  # activity slides the window
    monkeypatch.setattr(sessions_module.time, "time", lambda: now + 28 * 60)
    assert (await client.get("/api/auth/session")).status_code == 200
    monkeypatch.setattr(sessions_module.time, "time", lambda: now + 44 * 60)
    assert (await client.get("/api/auth/session")).status_code == 401


async def test_absolute_timeout(
    client: httpx.AsyncClient, idp: FakeIdP, monkeypatch: pytest.MonkeyPatch
) -> None:
    await sign_in(client, idp)
    start = time.time()
    for minutes in range(10, 8 * 60, 10):  # active every 10 minutes for 8 hours
        monkeypatch.setattr(sessions_module.time, "time", lambda m=minutes: start + m * 60)
        assert (await client.get("/api/auth/session")).status_code == 200
    monkeypatch.setattr(sessions_module.time, "time", lambda: start + 8 * 3600 + 1)
    assert (await client.get("/api/auth/session")).status_code == 401


async def test_session_id_is_not_stored_in_redis_as_is(
    app: FastAPI, client: httpx.AsyncClient, idp: FakeIdP
) -> None:
    await sign_in(client, idp)
    session_id = client.cookies.get("__Host-codelens_session")
    assert session_id
    keys = [k.decode() for k in await app.state.sessions.redis.keys("*")]
    assert keys and not any(session_id in k for k in keys)


# ── CSRF ───────────────────────────────────────────────────────────────────


async def test_writes_need_the_csrf_token(client: httpx.AsyncClient, idp: FakeIdP) -> None:
    await sign_in(client, idp)
    token = (await session_of(client))["csrfToken"]
    body = {"showGeneratedQuery": True, "defaultSourceIds": []}

    missing = await client.put("/api/me/preferences", json=body)
    assert missing.status_code == 403 and missing.json()["code"] == "csrf_failed"
    wrong = await client.put("/api/me/preferences", json=body, headers={"X-CSRF-Token": "x" * 43})
    assert wrong.status_code == 403
    foreign = await client.put(
        "/api/me/preferences", json=body, headers={"X-CSRF-Token": token, "Origin": "https://evil.com"}
    )
    assert foreign.status_code == 403
    ok = await client.put(
        "/api/me/preferences", json=body, headers={"X-CSRF-Token": token, "Origin": PUBLIC_URL}
    )
    assert ok.status_code == 200


# ── sign-out ───────────────────────────────────────────────────────────────


async def test_logout(app: FastAPI, client: httpx.AsyncClient, idp: FakeIdP) -> None:
    await sign_in(client, idp)
    token = (await session_of(client))["csrfToken"]
    response = await client.post("/api/auth/logout", headers={"X-CSRF-Token": token})
    assert response.status_code == 200
    url = urlsplit(response.json()["redirectUrl"])
    query = {k: v[0] for k, v in parse_qs(url.query).items()}
    assert url.path.endswith("/logout")
    assert query["post_logout_redirect_uri"] == f"{PUBLIC_URL}/login?reason=signed_out"
    assert query["id_token_hint"].startswith("eyJ")
    assert any(
        c.startswith("__Host-codelens_session=") and "Max-Age=0" in c for c in set_cookie_headers(response)
    )
    assert (await client.get("/api/auth/session")).status_code == 401
    assert [e.action for e in await audit_rows(app)] == ["login", "logout"]


async def test_forged_logout_does_not_end_the_session(client: httpx.AsyncClient, idp: FakeIdP) -> None:
    await sign_in(client, idp)
    session_id = client.cookies.get("__Host-codelens_session")
    response = await client.post("/api/auth/logout")  # no CSRF token
    assert response.json() == {"redirectUrl": None}
    client.cookies.set("__Host-codelens_session", session_id or "")
    assert (await client.get("/api/auth/session")).status_code == 200


async def test_logout_when_already_signed_out(client: httpx.AsyncClient) -> None:
    response = await client.post("/api/auth/logout")
    assert response.status_code == 200 and response.json() == {"redirectUrl": None}


# ── permission and step-up guards (used by later phases) ───────────────────


async def test_permission_and_step_up_guards(
    app: FastAPI, client: httpx.AsyncClient, idp: FakeIdP, monkeypatch: pytest.MonkeyPatch
) -> None:
    @app.get("/api/test/admin-only")
    async def admin_only(_: Principal = Depends(require_permission("canAdmin"))) -> dict[str, bool]:  # noqa: B008
        return {"ok": True}

    @app.get("/api/test/sensitive")
    async def sensitive(_: Principal = Depends(require_recent_auth)) -> dict[str, bool]:  # noqa: B008
        return {"ok": True}

    await sign_in(client, idp, "business")
    denied = await client.get("/api/test/admin-only")
    assert denied.status_code == 403 and denied.json()["code"] == "forbidden"

    await sign_in(client, idp, "admin")
    assert (await client.get("/api/test/admin-only")).status_code == 200
    assert (await client.get("/api/test/sensitive")).status_code == 200

    start = time.time()
    for minutes in (10, 20, 31):  # keep the session active; only the 30-minute step-up window runs out
        monkeypatch.setattr(sessions_module.time, "time", lambda m=minutes: start + m * 60)
        assert (await client.get("/api/auth/session")).status_code == 200
    stale = await client.get("/api/test/sensitive")
    assert stale.status_code == 401 and stale.json()["code"] == "step_up_required"


# ── audit chain ────────────────────────────────────────────────────────────


async def test_audit_chain_detects_tampering(app: FastAPI, client: httpx.AsyncClient, idp: FakeIdP) -> None:
    await sign_in(client, idp, "analyst")
    await sign_in(client, idp, "outsider")
    await sign_in(client, idp, "business")
    audit: AuditLog = app.state.audit
    assert await audit.verify_chain() is None

    async with app.state.sessionmaker() as db, db.begin():
        rows = list(await db.scalars(select(AuditEvent).order_by(AuditEvent.seq)))
        rows[1].outcome = "success"  # hide the denied sign-in
    assert await audit.verify_chain() == rows[1].seq
