"""Data sources: the admin wizard API and what employees see. Uses a fake connector so every rule can
be exercised without a database; tests/test_connectors_live.py covers the real drivers."""

from __future__ import annotations

import time
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select

from app.auth import sessions as sessions_module
from app.models import AuditEvent, Role, Source
from app.sources import connectors
from app.sources.connectors.base import DiscoveredEntity, DiscoveredNamespace, ProbeOutcome
from app.sources.fields import ConnectionValue
from tests.conftest import FakeIdP, signed_in

PASSWORD = "s3cret-pa55word"


class FakeConnector:
    def __init__(self) -> None:
        self.ok = True
        self.read_only = True
        self.calls: list[tuple[str, dict[str, ConnectionValue], dict[str, str]]] = []
        self.namespaces = [
            DiscoveredNamespace(
                "sales",
                [
                    DiscoveredEntity(
                        "orders",
                        "table",
                        [("id", "integer"), ("amount", "numeric(12,2)"), ("status", "text")],
                    ),
                    DiscoveredEntity("customers", "table", [("name", "text"), ("email", "text")]),
                ],
            ),
        ]

    async def test(
        self, connection: dict[str, ConnectionValue], secrets: dict[str, str], time_limit: float
    ) -> ProbeOutcome:
        self.calls.append(("test", connection, secrets))
        if not self.ok:
            return ProbeOutcome(ok=False, message="localhost refused the connection.")
        return ProbeOutcome(
            ok=True,
            read_only=self.read_only,
            latency_ms=12,
            server_version="PostgreSQL 17.6",
            message="Read-only." if self.read_only else "This account is not read-only: it can change data.",
        )

    async def discover(
        self, connection: dict[str, ConnectionValue], secrets: dict[str, str], time_limit: float
    ) -> list[DiscoveredNamespace]:
        self.calls.append(("discover", connection, secrets))
        return self.namespaces


@pytest.fixture
def fake(monkeypatch: pytest.MonkeyPatch) -> FakeConnector:
    connector = FakeConnector()
    monkeypatch.setitem(connectors.CONNECTORS, "postgresql", connector)
    return connector


CONNECTION = {
    "host": "db.internal.example",
    "port": 5432,
    "database": "company",
    "username": "codelens_reader",
    "sslMode": "verify-full",
}


def config(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "name": "Sales Database",
        "type": "postgresql",
        "description": "Orders and customers.",
        "connection": dict(CONNECTION),
        "secrets": {"password": PASSWORD},
        "exposed": [
            {
                "namespace": "sales",
                "name": "orders",
                "kind": "table",
                "description": "One row per order",
                "fields": [
                    {"name": "id", "type": "x", "description": "", "masked": False},
                    {"name": "amount", "type": "x", "description": "Order value in USD", "masked": False},
                ],
            },
            {
                "namespace": "sales",
                "name": "customers",
                "kind": "table",
                "description": "",
                "fields": [{"name": "email", "type": "", "description": "", "masked": True}],
            },
        ],
        "glossary": [{"term": "Revenue", "definition": "Sum of paid order amounts"}],
        "exampleQuestions": ["What were sales last month?"],
        "roleIds": ["business", "analyst"],
        "rowLimit": 500,
        "queryTimeoutSeconds": 30,
        "cacheTtlSeconds": 900,
    }
    body.update(overrides)
    return body


async def create(client: httpx.AsyncClient, **overrides: Any) -> dict[str, Any]:
    response = await client.post("/api/admin/sources", json=config(**overrides))
    assert response.status_code == 201, response.text
    data: dict[str, Any] = response.json()
    return data


async def audit_actions(app: FastAPI) -> list[tuple[str, str, str | None]]:
    async with app.state.sessionmaker() as db:
        rows = await db.scalars(select(AuditEvent).order_by(AuditEvent.seq))
        return [(e.action, e.outcome, e.details) for e in rows if e.action != "login"]


# ── creating ───────────────────────────────────────────────────────────────


async def test_create_source(
    app: FastAPI, client: httpx.AsyncClient, idp: FakeIdP, fake: FakeConnector
) -> None:
    await signed_in(client, idp, "admin")
    detail = await create(client)

    assert detail["id"] == "sales-database"
    assert detail["status"] == "healthy" and detail["enabled"] is True and detail["owner"] == "Dana Okafor"
    assert detail["roleIds"] == ["analyst", "business"]
    assert detail["secrets"] == {
        "password": {"isSet": True, "updatedAt": detail["secrets"]["password"]["updatedAt"]}
    }
    # Types come from the database, not from what the browser sent.
    assert [f["type"] for f in detail["exposed"][0]["fields"]] == ["integer", "numeric(12,2)"]
    assert detail["exposed"][1]["fields"][0]["masked"] is True
    assert PASSWORD not in str(detail)

    # The connection was tested with the typed password, and the server ran its own discovery.
    assert [call[0] for call in fake.calls] == ["test", "discover"]
    assert fake.calls[0][2] == {"password": PASSWORD}

    async with app.state.sessionmaker() as db:
        roles = {r.id: r.source_ids for r in await db.scalars(select(Role))}
        source = await db.get(Source, "sales-database")
    assert roles["business"] == ["sales-database"] and roles["admin"] == []
    assert source is not None and PASSWORD not in str(source.connection)
    # Stored under a random namespace, so a secret's name doesn't reveal the database it opens.
    assert list(app.state.secrets.values) == [(source.secret_namespace, "password")]
    assert "sales" not in source.secret_namespace
    assert await audit_actions(app) == [
        ("source_created", "success", "Exposed 2 tables/collections to roles: analyst, business")
    ]


async def test_secrets_are_write_only(client: httpx.AsyncClient, idp: FakeIdP, fake: FakeConnector) -> None:
    await signed_in(client, idp, "admin")
    created = await create(client)
    for path in ("/api/admin/sources", f"/api/admin/sources/{created['id']}"):
        response = await client.get(path)
        assert PASSWORD not in response.text and "s3cret" not in response.text


async def test_writable_account_is_refused(
    app: FastAPI, client: httpx.AsyncClient, idp: FakeIdP, fake: FakeConnector
) -> None:
    await signed_in(client, idp, "admin")
    fake.read_only = False
    response = await client.post("/api/admin/sources", json=config())
    assert response.status_code == 400 and response.json()["code"] == "not_read_only"
    async with app.state.sessionmaker() as db:
        assert list(await db.scalars(select(Source))) == []
    assert app.state.secrets.values == {}


async def test_unreachable_database_is_refused(
    client: httpx.AsyncClient, idp: FakeIdP, fake: FakeConnector
) -> None:
    await signed_in(client, idp, "admin")
    fake.ok = False
    response = await client.post("/api/admin/sources", json=config())
    assert response.status_code == 400 and response.json()["code"] == "connection_failed"


@pytest.mark.parametrize(
    ("exposed", "problem"),
    [
        (
            [{"namespace": "hr", "name": "salaries", "kind": "table", "fields": [{"name": "salary"}]}],
            "hr.salaries",
        ),
        (
            [{"namespace": "sales", "name": "orders", "kind": "table", "fields": [{"name": "secret_col"}]}],
            "secret_col",
        ),
        ([], "at least one"),
    ],
)
async def test_only_real_tables_can_be_exposed(
    client: httpx.AsyncClient, idp: FakeIdP, fake: FakeConnector, exposed: list[dict[str, Any]], problem: str
) -> None:
    await signed_in(client, idp, "admin")
    response = await client.post("/api/admin/sources", json=config(exposed=exposed))
    assert response.status_code == 400, response.text
    assert problem in response.json()["message"]


@pytest.mark.parametrize(
    ("connection", "secrets", "fragment"),
    [
        ({**CONNECTION, "host": "db.example/../etc"}, {"password": "x"}, "hostname"),
        ({**CONNECTION, "host": "user:pw@db.example"}, {"password": "x"}, "hostname"),
        ({**CONNECTION, "sslMode": "disable"}, {"password": "x"}, "TLS / SSL must be one of"),
        ({**CONNECTION, "sslrootcert": "/etc/passwd"}, {"password": "x"}, "not a setting"),
        ({**CONNECTION, "port": 70000}, {"password": "x"}, "Port is out of range"),
        ({**CONNECTION, "database": "x; DROP"}, {"password": "x"}, "characters that aren't allowed"),
        (CONNECTION, {}, "Password is required"),
        (CONNECTION, {"password": "x", "apiKey": "y"}, "not a credential"),
    ],
)
async def test_connection_settings_are_validated(
    client: httpx.AsyncClient,
    idp: FakeIdP,
    fake: FakeConnector,
    connection: dict[str, Any],
    secrets: dict[str, str],
    fragment: str,
) -> None:
    await signed_in(client, idp, "admin")
    response = await client.post(
        "/api/admin/sources/test", json={"type": "postgresql", "connection": connection, "secrets": secrets}
    )
    assert response.status_code == 400, response.text
    assert fragment in response.json()["message"]
    assert fake.calls == []  # nothing was attempted


async def test_types_without_a_connector_yet(client: httpx.AsyncClient, idp: FakeIdP) -> None:
    await signed_in(client, idp, "admin")
    response = await client.post(
        "/api/admin/sources/test",
        json={
            "type": "redis",
            "connection": {"host": "cache.internal", "port": 6379, "username": "reader", "tls": True},
            "secrets": {"password": "x"},
        },
    )
    assert response.json() == {
        "ok": False,
        "readOnly": False,
        "latencyMs": None,
        "serverVersion": None,
        "warnings": [],
        "message": "CodeLens can't connect to Redis yet. Support is coming in a later update.",
    }


async def test_local_hosts_are_refused_when_configured(
    app: FastAPI, client: httpx.AsyncClient, idp: FakeIdP, fake: FakeConnector
) -> None:
    app.state.settings.allow_local_source_hosts = False
    await signed_in(client, idp, "admin")
    for host in ("localhost", "127.0.0.1", "169.254.169.254"):
        response = await client.post(
            "/api/admin/sources/test",
            json={
                "type": "postgresql",
                "connection": {**CONNECTION, "host": host},
                "secrets": {"password": "x"},
            },
        )
        assert response.status_code == 400 and "own network" in response.json()["message"], host


# ── editing ────────────────────────────────────────────────────────────────


async def test_edit_keeps_stored_password(
    app: FastAPI, client: httpx.AsyncClient, idp: FakeIdP, fake: FakeConnector
) -> None:
    await signed_in(client, idp, "admin")
    created = await create(client)
    fake.calls.clear()

    # The wizard tests an edited connection without retyping the password.
    probe = await client.post(
        "/api/admin/sources/test",
        json={
            "sourceId": created["id"],
            "type": "postgresql",
            "connection": CONNECTION,
            "secrets": {},
        },
    )
    assert probe.json()["ok"] is True
    assert fake.calls[0][2] == {"password": PASSWORD}

    updated = await client.put(
        f"/api/admin/sources/{created['id']}",
        json=config(
            secrets={},
            description="Updated",
            roleIds=["analyst"],
        ),
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["description"] == "Updated" and updated.json()["roleIds"] == ["analyst"]
    assert updated.json()["secrets"]["password"]["isSet"] is True
    async with app.state.sessionmaker() as db:
        source = await db.get(Source, created["id"])
        assert source is not None and source.schema_version == 2
    assert await app.state.secrets.get(source.secret_namespace, "password") == PASSWORD


async def test_edit_replaces_password(
    app: FastAPI, client: httpx.AsyncClient, idp: FakeIdP, fake: FakeConnector
) -> None:
    await signed_in(client, idp, "admin")
    created = await create(client)
    await client.put(f"/api/admin/sources/{created['id']}", json=config(secrets={"password": "new-one"}))
    async with app.state.sessionmaker() as db:
        source = await db.get(Source, created["id"])
    assert source is not None
    assert await app.state.secrets.get(source.secret_namespace, "password") == "new-one"
    assert (await audit_actions(app))[-1][2] == "Settings and credentials updated; roles: analyst, business"


async def test_edit_while_database_is_down_uses_last_schema(
    client: httpx.AsyncClient, idp: FakeIdP, fake: FakeConnector
) -> None:
    await signed_in(client, idp, "admin")
    created = await create(client)
    fake.ok = False
    response = await client.put(
        f"/api/admin/sources/{created['id']}", json=config(secrets={}, description="New")
    )
    assert response.status_code == 200 and response.json()["status"] == "offline"
    # ...but a changed connection must be proven.
    moved = await client.put(
        f"/api/admin/sources/{created['id']}",
        json=config(secrets={}, connection={**CONNECTION, "host": "db2.example"}),
    )
    assert moved.status_code == 400 and moved.json()["code"] == "connection_failed"


async def test_type_cannot_change(client: httpx.AsyncClient, idp: FakeIdP, fake: FakeConnector) -> None:
    await signed_in(client, idp, "admin")
    created = await create(client)
    body = config(type="mysql", connection={**CONNECTION, "tlsMode": "REQUIRED"})
    body["connection"].pop("sslMode")
    response = await client.put(f"/api/admin/sources/{created['id']}", json=body)
    assert response.status_code == 400


# ── enabling, checking, deleting ───────────────────────────────────────────


async def test_disable_check_and_delete(
    app: FastAPI, client: httpx.AsyncClient, idp: FakeIdP, fake: FakeConnector
) -> None:
    await signed_in(client, idp, "admin")
    created = await create(client)
    source_id = created["id"]

    assert (await client.patch(f"/api/admin/sources/{source_id}", json={"enabled": False})).json()[
        "enabled"
    ] is False
    fake.read_only = False
    assert (await client.post(f"/api/admin/sources/{source_id}/check")).json()["status"] == "degraded"
    fake.ok = False
    assert (await client.post(f"/api/admin/sources/{source_id}/check")).json()["status"] == "offline"

    assert (await client.delete(f"/api/admin/sources/{source_id}")).status_code == 204
    assert (await client.get(f"/api/admin/sources/{source_id}")).status_code == 404
    assert app.state.secrets.values == {}
    async with app.state.sessionmaker() as db:
        assert all(source_id not in r.source_ids for r in await db.scalars(select(Role)))
    assert [a[0] for a in await audit_actions(app)] == ["source_created", "source_updated", "source_deleted"]


# ── who may do what ────────────────────────────────────────────────────────


async def test_non_admins_cannot_manage_sources(
    client: httpx.AsyncClient, idp: FakeIdP, fake: FakeConnector
) -> None:
    await signed_in(client, idp, "analyst")
    probe = {"type": "postgresql", "connection": CONNECTION, "secrets": {"password": "x"}}
    for method, path, body in [
        ("GET", "/api/admin/sources", None),
        ("POST", "/api/admin/sources", config()),
        ("POST", "/api/admin/sources/test", probe),
        ("POST", "/api/admin/sources/discover", probe),
    ]:
        response = await client.request(method, path, json=body)
        assert response.status_code == 403, (method, path)
    assert fake.calls == []


async def test_changes_need_a_recent_sign_in(
    client: httpx.AsyncClient, idp: FakeIdP, fake: FakeConnector, monkeypatch: pytest.MonkeyPatch
) -> None:
    await signed_in(client, idp, "admin")
    created = await create(client)
    await client.patch(f"/api/admin/sources/{created['id']}", json={"enabled": False})

    start = time.time()
    for minutes in (10, 20, 31):  # stay active so only the step-up window (30 min) runs out
        monkeypatch.setattr(sessions_module.time, "time", lambda m=minutes: start + m * 60)
        assert (await client.get("/api/auth/session")).status_code == 200

    for method, path, body in [
        ("POST", "/api/admin/sources", config(name="Another")),
        ("PUT", f"/api/admin/sources/{created['id']}", config()),
        ("DELETE", f"/api/admin/sources/{created['id']}", None),
        ("PATCH", f"/api/admin/sources/{created['id']}", {"enabled": True}),
    ]:
        response = await client.request(method, path, json=body)
        assert response.status_code == 401 and response.json()["code"] == "step_up_required", (method, path)
    # Turning a source off is always allowed, as is testing a connection.
    assert (
        await client.patch(f"/api/admin/sources/{created['id']}", json={"enabled": False})
    ).status_code == 200


async def test_writes_need_csrf(client: httpx.AsyncClient, idp: FakeIdP, fake: FakeConnector) -> None:
    await signed_in(client, idp, "admin")
    del client.headers["X-CSRF-Token"]
    response = await client.post("/api/admin/sources", json=config())
    assert response.status_code == 403 and response.json()["code"] == "csrf_failed"


async def test_discover_refuses_writable_accounts(
    client: httpx.AsyncClient, idp: FakeIdP, fake: FakeConnector
) -> None:
    await signed_in(client, idp, "admin")
    probe = {"type": "postgresql", "connection": CONNECTION, "secrets": {"password": "x"}}
    assert (await client.post("/api/admin/sources/discover", json=probe)).json()["namespaces"][0][
        "name"
    ] == "sales"
    fake.read_only = False
    response = await client.post("/api/admin/sources/discover", json=probe)
    assert response.status_code == 400 and response.json()["code"] == "not_read_only"


# ── what employees see ─────────────────────────────────────────────────────


async def test_employee_source_list_and_catalog(
    app: FastAPI, client: httpx.AsyncClient, idp: FakeIdP, fake: FakeConnector
) -> None:
    await signed_in(client, idp, "admin")
    sales = await create(client, roleIds=["business"])
    hr = await create(client, name="HR", roleIds=["admin"])
    hidden = await create(client, name="Old billing", roleIds=["business"])
    await client.patch(f"/api/admin/sources/{hidden['id']}", json={"enabled": False})

    await signed_in(client, idp, "business")
    listing = (await client.get("/api/sources")).json()
    assert [(s["id"], s["access"]) for s in listing] == [(hr["id"], "none"), (sales["id"], "granted")]
    assert listing[0]["exampleQuestions"] == []  # no details about sources you can't use

    catalog = (await client.get(f"/api/sources/{sales['id']}/catalog")).json()
    assert [e["name"] for e in catalog["entities"]] == ["orders", "customers"]
    assert catalog["entities"][1]["fields"] == [
        {"name": "email", "type": "text", "description": "", "masked": True}
    ]
    assert catalog["glossary"] == [{"term": "Revenue", "definition": "Sum of paid order amounts"}]
    assert "connection" not in catalog["source"] and "host" not in str(catalog)

    denied = await client.get(f"/api/sources/{hr['id']}/catalog")
    assert denied.status_code == 403
    assert (await client.get(f"/api/sources/{hidden['id']}/catalog")).status_code == 404


async def test_session_says_how_long_step_up_lasts(client: httpx.AsyncClient, idp: FakeIdP) -> None:
    await signed_in(client, idp, "admin")
    session = (await client.get("/api/auth/session")).json()
    until = datetime.fromisoformat(session["recentAuthUntil"])
    assert 29 * 60 < (until - datetime.now(UTC)).total_seconds() <= 30 * 60


async def test_admin_role_list_for_the_wizard(
    client: httpx.AsyncClient, idp: FakeIdP, fake: FakeConnector
) -> None:
    await signed_in(client, idp, "business")
    assert (await client.get("/api/admin/roles")).status_code == 403
    await signed_in(client, idp, "admin")
    created = await create(client, roleIds=["analyst"])
    roles = {r["id"]: r for r in (await client.get("/api/admin/roles")).json()}
    assert set(roles) == {"business", "analyst", "admin", "auditor"}
    assert roles["analyst"]["sourceIds"] == [created["id"]]
    assert roles["admin"]["memberCount"] == 1 and roles["business"]["memberCount"] == 1
    assert roles["admin"]["permissions"]["canAdmin"] is True and roles["admin"]["builtIn"] is True
