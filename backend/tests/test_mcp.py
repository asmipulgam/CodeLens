"""The MCP server: AI assistants asking questions through CodeLens at /api/mcp, with real (fake-IdP-signed)
access tokens, so every token check runs for real, and the same fake database as test_queries."""

from __future__ import annotations

import time
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from joserfc import jwt
from joserfc.jwk import RSAKey
from sqlalchemy import select

from app.config import Settings
from app.models import AuditEvent, Conversation
from tests.conftest import ISSUER, PUBLIC_URL, USERS, FakeIdP
from tests.test_queries import CUSTOMERS, FakeDb, add_source, fakedb  # noqa: F401  (fakedb is a fixture)

MCP_URL = f"{PUBLIC_URL}/api/mcp"
HEADERS = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}


@pytest.fixture
def settings(settings: Settings, request: pytest.FixtureRequest) -> Settings:
    # Tests can add settings with @pytest.mark.parametrize("settings", [{...}], indirect=True).
    return settings.model_copy(update={"mcp_enabled": True, **getattr(request, "param", {})})


def access_token(idp: FakeIdP, who: str = "analyst", *, key: RSAKey | None = None, **claims: Any) -> str:
    now = int(time.time())
    body = {
        "iss": ISSUER,
        "aud": MCP_URL,
        "iat": now,
        "exp": now + 300,
        "azp": "claude-desktop",
        "typ": "Bearer",
        "scope": "openid email profile",
        **USERS[who],
        **claims,
    }
    return jwt.encode(
        {"alg": "RS256", "kid": "k1"}, {k: v for k, v in body.items() if v is not None}, key or idp.key
    )


async def rpc(
    client: httpx.AsyncClient, token: str | None, method: str, params: dict[str, Any] | None = None
) -> httpx.Response:
    headers = dict(HEADERS)
    if token:
        headers["Authorization"] = f"Bearer {token}"
    message: dict[str, Any] = {"jsonrpc": "2.0", "id": 1, "method": method}
    if params is not None:
        message["params"] = params
    return await client.post("/api/mcp", json=message, headers=headers)


async def call(
    client: httpx.AsyncClient, token: str, tool: str, arguments: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Call a tool; returns the structured result, or {"error": text} when the tool reported an error."""
    response = await rpc(client, token, "tools/call", {"name": tool, "arguments": arguments or {}})
    assert response.status_code == 200, response.text
    result = response.json()["result"]
    if result.get("isError"):
        return {"error": " ".join(part.get("text", "") for part in result["content"])}
    structured: dict[str, Any] = result["structuredContent"]
    return structured


# ── sign-in: only genuine, unexpired tokens issued for CodeLens ──────────────


async def test_no_token_points_the_assistant_to_sign_in(client: httpx.AsyncClient) -> None:
    response = await rpc(client, None, "tools/list")
    assert response.status_code == 401
    assert (
        f'resource_metadata="{PUBLIC_URL}/.well-known/oauth-protected-resource/api/mcp"'
        in response.headers["www-authenticate"]
    )
    metadata = (await client.get("/.well-known/oauth-protected-resource/api/mcp")).json()
    assert metadata["resource"] == MCP_URL and metadata["authorization_servers"] == [ISSUER]


@pytest.mark.parametrize(
    "bad",
    [
        {"aud": "codelens"},  # a token for the web app (or any other app) can't be replayed here
        {"aud": "https://other.example/api/mcp"},
        {"iss": "https://evil.example/realms/codelens"},
        {"exp": int(time.time()) - 600},
        {"typ": "ID"},  # an ID token is not an access token
        {"typ": "Refresh"},
        {"sub": None},
    ],
)
async def test_bad_tokens_are_refused(client: httpx.AsyncClient, idp: FakeIdP, bad: dict[str, Any]) -> None:
    assert (await rpc(client, access_token(idp, **bad), "tools/list")).status_code == 401


async def test_token_signed_by_another_key_is_refused(client: httpx.AsyncClient, idp: FakeIdP) -> None:
    forged = access_token(idp, key=RSAKey.generate_key(2048, parameters={"kid": "k1"}))
    assert (await rpc(client, forged, "tools/list")).status_code == 401
    assert (await rpc(client, "not-a-jwt", "tools/list")).status_code == 401


async def test_only_approved_assistant_apps(app: FastAPI, client: httpx.AsyncClient, idp: FakeIdP) -> None:
    app.state.settings.mcp_allowed_client_ids = ["copilot"]
    try:
        assert (await rpc(client, access_token(idp, azp="claude-desktop"), "tools/list")).status_code == 401
        assert (await rpc(client, access_token(idp, azp="copilot"), "tools/list")).status_code == 200
    finally:
        app.state.settings.mcp_allowed_client_ids = []


async def test_requests_must_name_our_host(client: httpx.AsyncClient, idp: FakeIdP) -> None:
    """DNS-rebinding protection: a page on another site can't drive the endpoint through the browser."""
    response = await client.post(
        "/api/mcp",
        json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
        headers={**HEADERS, "Authorization": f"Bearer {access_token(idp)}", "Origin": "https://evil.example"},
    )
    assert response.status_code in (400, 403, 421)


async def test_mcp_is_off_unless_enabled(tmp_path: Any, idp: FakeIdP) -> None:
    from app.main import create_app

    app = create_app(Settings(**{**_base_settings(tmp_path), "mcp_enabled": False}))
    assert not any(getattr(route, "path", "") == "/api/mcp" for route in app.routes)


def _base_settings(tmp_path: Any) -> dict[str, Any]:
    return {
        "environment": "test",
        "public_url": PUBLIC_URL,
        "database_url": f"sqlite+aiosqlite:///{tmp_path}/x.db",
        "oidc_issuer": ISSUER,
        "_env_file": None,
    }


# ── the tools ────────────────────────────────────────────────────────────────


async def test_tools_are_all_read_only(client: httpx.AsyncClient, idp: FakeIdP) -> None:
    tools = (await rpc(client, access_token(idp), "tools/list")).json()["result"]["tools"]
    assert {t["name"] for t in tools} == {
        "list_data_sources",
        "describe_data_source",
        "ask_question",
        "answer_clarification",
        "confirm_query",
    }
    assert all(t["annotations"]["readOnlyHint"] and not t["annotations"]["destructiveHint"] for t in tools)


async def test_analyst_asks_a_question(
    app: FastAPI, client: httpx.AsyncClient, idp: FakeIdP, fakedb: FakeDb
) -> None:
    token = access_token(idp, "analyst")
    sources = await call(client, token, "list_data_sources")
    assert [s["id"] for s in sources["sources"]] == ["sales"]

    answer = await call(client, token, "ask_question", {"question": "Total sales by status"})
    assert answer["status"] == "answered"
    assert answer["rows"] == [
        {"status": "paid", "total_amount": 300},
        {"status": "shipped", "total_amount": 120},
    ]
    assert answer["sources"][0]["id"] == "sales"
    assert answer["query"]["text"].startswith("SELECT")  # analysts may see the query
    assert answer["open_in_codelens"].startswith(f"{PUBLIC_URL}/ask/c-")
    assert fakedb.sql  # it really ran, through the same pipeline as the web app

    async with app.state.sessionmaker() as db:
        events = list(await db.scalars(select(AuditEvent).where(AuditEvent.action == "query")))
        conversations = list(await db.scalars(select(Conversation)))
    assert [(e.outcome, e.details, e.user_email) for e in events] == [
        ("success", "via MCP", "marcus@example.com")
    ]
    assert len(conversations) == 1  # also shows up in the person's CodeLens history


async def test_business_users_never_get_the_query(
    client: httpx.AsyncClient, idp: FakeIdP, fakedb: FakeDb
) -> None:
    answer = await call(
        client, access_token(idp, "business"), "ask_question", {"question": "Total sales by status"}
    )
    assert answer["status"] == "answered" and "query" not in answer


async def test_hidden_columns_stay_hidden(client: httpx.AsyncClient, idp: FakeIdP, fakedb: FakeDb) -> None:
    from app.sources.connectors.base import QueryOutput

    fakedb.output = QueryOutput(["name", "email"], [("Ann", "ann@example.com"), ("Bo", "bo@example.com")])
    answer = await call(client, access_token(idp), "ask_question", {"question": "List customers"})
    assert [row["email"] for row in answer["rows"]] == [None, None]
    assert next(c for c in answer["columns"] if c["key"] == "email")["hidden"] is True


async def test_rows_sent_to_the_assistant_are_capped(
    app: FastAPI, client: httpx.AsyncClient, idp: FakeIdP, fakedb: FakeDb
) -> None:
    app.state.settings.mcp_max_rows = 1
    answer = await call(client, access_token(idp), "ask_question", {"question": "Total sales by status"})
    assert answer["rows_shown"] == 1 and answer["total_rows"] == 2 and "Showing 1 of 2" in answer["note"]


async def test_writes_are_refused(client: httpx.AsyncClient, idp: FakeIdP, fakedb: FakeDb) -> None:
    result = await call(
        client, access_token(idp), "ask_question", {"question": "Delete all cancelled orders"}
    )
    assert "can only read data" in result["error"]
    assert not fakedb.sql


async def test_people_without_a_role_get_nothing(
    client: httpx.AsyncClient, idp: FakeIdP, fakedb: FakeDb
) -> None:
    token = access_token(idp, "outsider")
    for tool, arguments in [
        ("list_data_sources", {}),
        ("ask_question", {"question": "Total sales by status"}),
    ]:
        assert "don't have a CodeLens role" in (await call(client, token, tool, arguments))["error"]
    assert not fakedb.sql


async def test_sources_outside_the_role_are_invisible(
    app: FastAPI, client: httpx.AsyncClient, idp: FakeIdP, fakedb: FakeDb
) -> None:
    await add_source(app, "hr", "HR", [CUSTOMERS], roles=["admin"])
    token = access_token(idp, "analyst")
    assert [s["id"] for s in (await call(client, token, "list_data_sources"))["sources"]] == ["sales"]
    assert (
        "don't have access"
        in (await call(client, token, "describe_data_source", {"source_id": "hr"}))["error"]
    )
    catalog = await call(client, token, "describe_data_source", {"source_id": "sales"})
    assert {e["name"] for e in catalog["entities"]} == {"orders", "customers"}


async def test_clarification_round_trip(
    app: FastAPI, client: httpx.AsyncClient, idp: FakeIdP, fakedb: FakeDb
) -> None:
    await add_source(app, "crm", "CRM", [CUSTOMERS], roles=["analyst"])
    token = access_token(idp)
    first = await call(client, token, "ask_question", {"question": "How many customers are there?"})
    assert first["status"] == "needs_clarification" and len(first["options"]) == 2
    option = next(o for o in first["options"] if o["id"].startswith("crm:"))

    # Someone else's token can't continue this question.
    other = access_token(idp, "business")
    stolen = await call(
        client, other, "answer_clarification", {"query_id": first["query_id"], "option_id": option["id"]}
    )
    assert "not found" in stolen["error"]

    answer = await call(
        client, token, "answer_clarification", {"query_id": first["query_id"], "option_id": option["id"]}
    )
    assert answer["status"] == "answered" and answer["sources"][0]["id"] == "crm"


async def test_slow_queries_wait_for_confirmation(
    app: FastAPI, client: httpx.AsyncClient, idp: FakeIdP, fakedb: FakeDb
) -> None:
    fakedb.rows_scanned = app.state.settings.confirm_rows_threshold + 1
    token = access_token(idp)
    first = await call(client, token, "ask_question", {"question": "Total sales by status"})
    assert first["status"] == "needs_confirmation" and not fakedb.sql
    answer = await call(client, token, "confirm_query", {"query_id": first["query_id"]})
    assert answer["status"] == "answered" and fakedb.sql


async def test_rate_limit_is_shared_with_the_web_app(
    app: FastAPI, client: httpx.AsyncClient, idp: FakeIdP, fakedb: FakeDb
) -> None:
    app.state.settings.questions_per_minute = 1
    token = access_token(idp)
    assert (await call(client, token, "ask_question", {"question": "Total sales by status"}))[
        "status"
    ] == "answered"
    assert "error" in await call(client, token, "ask_question", {"question": "Total sales by status"})


async def test_roles_follow_the_token_groups(client: httpx.AsyncClient, idp: FakeIdP, fakedb: FakeDb) -> None:
    """Someone moved out of the analyst group loses analyst access on their next call."""
    assert (await call(client, access_token(idp, "analyst"), "list_data_sources"))["sources"]
    demoted = access_token(idp, "analyst", groups=["marketing"])
    assert "don't have a CodeLens role" in (await call(client, demoted, "list_data_sources"))["error"]


@pytest.mark.parametrize("settings", [{"dev_auto_login": True}], indirect=True)
async def test_dev_auto_login_needs_no_token(client: httpx.AsyncClient, fakedb: FakeDb) -> None:
    """Like the web app: in development, a local assistant connects without signing in."""
    sources = await call(client, "", "list_data_sources")
    assert [s["id"] for s in sources["sources"]] == ["sales"]


async def test_production_never_skips_sign_in(tmp_path: Any) -> None:
    settings = Settings(**{**_base_settings(tmp_path), "environment": "production", "dev_auto_login": True})
    with pytest.raises(RuntimeError, match="DEV_AUTO_LOGIN"):
        settings.check_production_safety()
