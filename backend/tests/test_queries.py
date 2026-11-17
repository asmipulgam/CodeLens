"""Asking questions end to end through the API, with a fake database connector (so every rule can be
checked) and the stand-in planner. tests/test_queries_live.py runs the same flow on a real database."""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select

from app.models import AuditEvent, Feedback, Role, Source
from app.sources import connectors
from app.sources.connectors.base import CostEstimate, ProbeOutcome, QueryOutput
from app.sources.fields import ConnectionValue
from tests.conftest import FakeIdP, signed_in

ORDERS = {
    "namespace": "sales",
    "name": "orders",
    "kind": "table",
    "description": "One row per order",
    "fields": [
        {"name": "id", "type": "integer", "description": "", "masked": False},
        {"name": "amount", "type": "numeric(12,2)", "description": "", "masked": False},
        {"name": "status", "type": "text", "description": "", "masked": False},
        {"name": "ordered_at", "type": "date", "description": "", "masked": False},
    ],
}
CUSTOMERS = {
    "namespace": "sales",
    "name": "customers",
    "kind": "table",
    "description": "",
    "fields": [
        {"name": "id", "type": "integer", "description": "", "masked": False},
        {"name": "name", "type": "text", "description": "", "masked": False},
        {"name": "email", "type": "text", "description": "", "masked": True},
    ],
}


class FakeDb:
    """Answers whatever SQL it is given with configured rows, and records what it was asked."""

    def __init__(self) -> None:
        self.sql: list[str] = []
        self.output = QueryOutput(["status", "total_amount"], [("paid", 300), ("shipped", 120)])
        self.rows_scanned = 10
        self.delay = 0.0

    async def test(self, *_: Any) -> ProbeOutcome:
        return ProbeOutcome(ok=True, message="ok", read_only=True)

    async def discover(self, *_: Any) -> list[Any]:
        return []

    async def run(
        self,
        connection: dict[str, ConnectionValue],
        secrets: dict[str, str],
        sql: str,
        time_limit: float,
        max_rows: int,
    ) -> QueryOutput:
        assert secrets == {"password": "pw"}  # credentials come from the secret store
        self.sql.append(sql)
        if self.delay:
            await asyncio.sleep(self.delay)
        if sql.startswith("SELECT COUNT(*)"):
            return QueryOutput(["count"], [(9999,)])
        return QueryOutput(self.output.columns, self.output.rows[:max_rows])

    async def estimate(self, *_: Any) -> CostEstimate:
        return CostEstimate(rows_scanned=self.rows_scanned)


@pytest.fixture
async def fakedb(app: FastAPI, monkeypatch: pytest.MonkeyPatch) -> FakeDb:
    db = FakeDb()
    monkeypatch.setitem(connectors.CONNECTORS, "postgresql", db)
    await add_source(app, "sales", "Sales", [ORDERS, CUSTOMERS], roles=["analyst", "business"])
    return db


async def add_source(
    app: FastAPI,
    source_id: str,
    name: str,
    exposed: list[dict[str, Any]],
    *,
    roles: list[str],
    ttl: int = 900,
    row_limit: int = 500,
) -> None:
    async with app.state.sessionmaker() as db, db.begin():
        db.add(
            Source(
                id=source_id,
                name=name,
                type="postgresql",
                description="",
                owner="",
                enabled=True,
                status="healthy",
                connection={
                    "host": "db.example",
                    "port": 5432,
                    "database": "x",
                    "username": "r",
                    "sslMode": "require",
                },
                secret_namespace=source_id.replace("-", ""),
                secret_status={"password": "now"},
                exposed=exposed,
                glossary=[],
                example_questions=["How many orders are there?"],
                row_limit=row_limit,
                query_timeout_seconds=30,
                cache_ttl_seconds=ttl,
                schema_snapshot={},
            )
        )
        for role in await db.scalars(select(Role).where(Role.id.in_(roles))):
            role.source_ids = [*role.source_ids, source_id]
    await app.state.secrets.put(source_id.replace("-", ""), "password", "pw")


async def ask(
    client: httpx.AsyncClient, question: str, path: str = "/api/queries", **extra: Any
) -> list[dict[str, Any]]:
    body = {"question": question, "sourceIds": [], **extra} if path == "/api/queries" else extra
    response = await client.post(path, json=body)
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("text/event-stream")
    events = []
    for block in response.text.split("\n\n"):
        data = [line[6:] for line in block.split("\n") if line.startswith("data: ")]
        if data:
            events.append(json.loads(data[0]))
    return events


def final(events: list[dict[str, Any]]) -> dict[str, Any]:
    return events[-1]


async def audit_rows(app: FastAPI, action: str = "query") -> list[AuditEvent]:
    async with app.state.sessionmaker() as db:
        return [
            e for e in await db.scalars(select(AuditEvent).order_by(AuditEvent.seq)) if e.action == action
        ]


# ── the happy path ─────────────────────────────────────────────────────────


async def test_question_is_answered(
    app: FastAPI, client: httpx.AsyncClient, idp: FakeIdP, fakedb: FakeDb
) -> None:
    await signed_in(client, idp, "analyst")
    events = await ask(client, "Total sales by status")
    assert [e["type"] for e in events] == [
        "started",
        "progress",
        "progress",
        "progress",
        "progress",
        "progress",
        "result",
    ]
    assert [e["stage"] for e in events if e["type"] == "progress"] == [
        "understanding",
        "routing",
        "building",
        "running",
        "summarising",
    ]
    answer = final(events)["answer"]
    assert answer["summary"].startswith("paid has the highest total amount ($300.00)")
    assert answer["result"]["columns"][1]["type"] == "currency"
    assert answer["chart"] == {"type": "bar", "x": "status", "series": ["total_amount"]}
    assert answer["freshness"]["status"] == "live"
    assert answer["sources"] == [{"id": "sales", "name": "Sales", "type": "postgresql"}]
    # The analyst sees the exact query that ran: pinned to the schema and limited.
    assert answer["generatedQueries"][0]["text"] == fakedb.sql[0]
    assert '"sales"."orders"' in fakedb.sql[0] and fakedb.sql[0].endswith("LIMIT 501")

    [event] = await audit_rows(app)
    assert (event.outcome, event.question, event.rows_returned, event.cached) == (
        "success",
        "Total sales by status",
        2,
        False,
    )
    assert event.generated_queries[0]["text"] == fakedb.sql[0]  # type: ignore[index]


async def test_business_users_dont_see_queries(
    client: httpx.AsyncClient, idp: FakeIdP, fakedb: FakeDb
) -> None:
    await signed_in(client, idp, "business")
    answer = final(await ask(client, "Total sales by status"))["answer"]
    assert "generatedQueries" not in answer
    conversation_id = (await client.get("/api/conversations")).json()[0]["id"]
    stored = (await client.get(f"/api/conversations/{conversation_id}")).json()
    assert "generatedQueries" not in stored["messages"][1]["answer"]


async def test_hidden_columns_are_never_fetched(
    client: httpx.AsyncClient, idp: FakeIdP, fakedb: FakeDb
) -> None:
    await signed_in(client, idp, "analyst")
    fakedb.output = QueryOutput(["id", "name", "email"], [(1, "Acme", "leak@acme.example")])
    answer = final(await ask(client, "List customers"))["answer"]
    assert 'NULL AS "email"' in fakedb.sql[0]
    email = next(c for c in answer["result"]["columns"] if c["key"] == "email")
    assert email["masked"] is True
    # Even if the database had sent a value, it wouldn't reach the browser.
    assert answer["result"]["rows"][0]["email"] is None and "leak@" not in json.dumps(answer)


async def test_large_results_are_cut_and_counted(
    app: FastAPI, client: httpx.AsyncClient, idp: FakeIdP, fakedb: FakeDb
) -> None:
    await add_source(app, "big", "Big", [ORDERS], roles=["analyst"], row_limit=3)
    await signed_in(client, idp, "analyst")
    fakedb.output = QueryOutput(["status"], [("a",), ("b",), ("c",), ("d",), ("e",)])
    answer = final(await ask(client, "List orders", sourceIds=["big"]))["answer"]
    assert len(answer["result"]["rows"]) == 3 and answer["result"]["totalRows"] == 9999
    assert fakedb.sql[0].endswith("LIMIT 4") and fakedb.sql[1].startswith("SELECT COUNT(*)")


# ── caching ────────────────────────────────────────────────────────────────


async def test_repeat_questions_come_from_the_cache(
    app: FastAPI, client: httpx.AsyncClient, idp: FakeIdP, fakedb: FakeDb
) -> None:
    await signed_in(client, idp, "analyst")
    first = final(await ask(client, "Total sales by status"))["answer"]
    second = final(await ask(client, "Total sales by status"))["answer"]
    assert second["freshness"]["status"] == "cached" and second["freshness"]["cachedAt"]
    assert second["result"] == first["result"]
    assert len(fakedb.sql) == 1  # the database was asked once
    assert [e.cached for e in await audit_rows(app)] == [False, True]

    refreshed = final(await ask(client, "", path=f"/api/queries/{second['queryId']}/refresh"))["answer"]
    assert refreshed["freshness"]["status"] == "live" and len(fakedb.sql) == 2
    assert [e.action for e in await audit_rows(app, "refresh")] == ["refresh"]


async def test_cache_is_not_shared_across_access_levels(
    client: httpx.AsyncClient, idp: FakeIdP, fakedb: FakeDb
) -> None:
    await signed_in(client, idp, "analyst")
    await ask(client, "Total sales by status")
    await signed_in(client, idp, "business")
    answer = final(await ask(client, "Total sales by status"))["answer"]
    assert answer["freshness"]["status"] == "live" and len(fakedb.sql) == 2


async def test_cache_can_be_off(
    app: FastAPI, client: httpx.AsyncClient, idp: FakeIdP, fakedb: FakeDb
) -> None:
    await add_source(app, "live", "Live", [ORDERS], roles=["analyst"], ttl=0)
    await signed_in(client, idp, "analyst")
    for _ in range(2):
        answer = final(await ask(client, "Total sales by status", sourceIds=["live"]))["answer"]
        assert answer["freshness"]["status"] == "live"
    assert len(fakedb.sql) == 2


# ── refusals ───────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "question", ["Delete all cancelled orders", "please update the order amounts", "Drop the customers table"]
)
async def test_requests_to_change_data_are_blocked(
    app: FastAPI, client: httpx.AsyncClient, idp: FakeIdP, fakedb: FakeDb, question: str
) -> None:
    await signed_in(client, idp, "analyst")
    error = final(await ask(client, question))["error"]
    assert error["code"] == "write_blocked"
    assert fakedb.sql == []
    assert (await audit_rows(app))[-1].outcome == "denied"


async def test_no_access_means_no_answer(
    app: FastAPI, client: httpx.AsyncClient, idp: FakeIdP, fakedb: FakeDb
) -> None:
    await signed_in(client, idp, "admin")  # sales was shared with analysts and business users only
    error = final(await ask(client, "Total sales by status"))["error"]
    assert error["code"] == "forbidden" and error["canRequestAccess"] is True
    assert fakedb.sql == []


async def test_choosing_a_source_you_cant_use_is_ignored(
    app: FastAPI, client: httpx.AsyncClient, idp: FakeIdP, fakedb: FakeDb
) -> None:
    await add_source(app, "hr", "HR", [ORDERS], roles=["admin"])
    await signed_in(client, idp, "analyst")
    answer = final(await ask(client, "Total sales by status", sourceIds=["hr"]))["answer"]
    assert answer["sources"][0]["id"] == "sales"


async def test_unanswerable_questions_get_help(
    client: httpx.AsyncClient, idp: FakeIdP, fakedb: FakeDb
) -> None:
    await signed_in(client, idp, "analyst")
    error = final(await ask(client, "What's the weather in Paris?"))["error"]
    assert error["code"] == "not_understood" and "How many orders are there?" in error["hint"]


async def test_database_errors_are_explained(
    client: httpx.AsyncClient, idp: FakeIdP, fakedb: FakeDb, monkeypatch: pytest.MonkeyPatch
) -> None:
    await signed_in(client, idp, "analyst")

    async def broken(*_: Any) -> QueryOutput:
        raise connectors.ConnectorError("The query took too long and was stopped.")

    monkeypatch.setattr(fakedb, "run", broken)
    error = final(await ask(client, "Total sales by status"))["error"]
    assert error["code"] == "timeout" and error["source"]["id"] == "sales"


# ── clarify, confirm, cancel ──────────────────────────────────────────────


async def test_ambiguous_questions_ask_which_data(
    app: FastAPI, client: httpx.AsyncClient, idp: FakeIdP, fakedb: FakeDb
) -> None:
    await add_source(app, "crm", "CRM", [CUSTOMERS], roles=["analyst"])
    await signed_in(client, idp, "analyst")
    fakedb.output = QueryOutput(["count"], [(42,)])
    events = await ask(client, "How many customers are there?")
    clarification = final(events)["clarification"]
    assert {o["id"] for o in clarification["options"]} == {"sales:sales.customers", "crm:sales.customers"}
    assert fakedb.sql == []

    query_id = events[0]["queryId"]
    bad = await client.post(f"/api/queries/{query_id}/clarify", json={"optionId": "made-up"})
    assert bad.status_code == 400
    answer = final(
        await ask(client, "", path=f"/api/queries/{query_id}/clarify", optionId="crm:sales.customers")
    )
    assert answer["answer"]["sources"][0]["id"] == "crm"
    conversation = (await client.get(f"/api/conversations/{events[0]['conversationId']}")).json()
    assert conversation["messages"][1]["clarificationAnswer"] == "Customers (CRM)"


async def test_expensive_queries_need_confirmation(
    app: FastAPI, client: httpx.AsyncClient, idp: FakeIdP, fakedb: FakeDb
) -> None:
    await signed_in(client, idp, "analyst")
    fakedb.rows_scanned = 50_000_000
    events = await ask(client, "Total sales by status")
    confirmation = final(events)["confirmation"]
    assert confirmation["estimate"] == {"rows": 50_000_000} and "50,000,000" in confirmation["message"]
    assert fakedb.sql == []  # nothing ran yet
    answer = final(await ask(client, "", path=f"/api/queries/{events[0]['queryId']}/confirm"))["answer"]
    assert answer["summary"] and len(fakedb.sql) == 1
    again = await client.post(f"/api/queries/{events[0]['queryId']}/confirm", json={})
    assert again.status_code == 400  # a confirmation can't be replayed


async def test_cancel_stops_a_running_question(
    app: FastAPI, client: httpx.AsyncClient, idp: FakeIdP, fakedb: FakeDb
) -> None:
    await signed_in(client, idp, "analyst")
    fakedb.delay = 5

    async def cancel_soon() -> None:
        for _ in range(50):
            await asyncio.sleep(0.1)
            conversations = (await client.get("/api/conversations")).json()
            if conversations:
                detail = (await client.get(f"/api/conversations/{conversations[0]['id']}")).json()
                query_id = detail["messages"][1].get("queryId")
                if detail["messages"][1].get("stage") == "running":
                    assert (await client.post(f"/api/queries/{query_id}/cancel")).status_code == 204
                    return

    started = time.perf_counter()
    events, _ = await asyncio.gather(ask(client, "Total sales by status"), cancel_soon())
    assert time.perf_counter() - started < 4
    assert all(e["type"] in ("started", "progress") for e in events)
    detail = (await client.get(f"/api/conversations/{events[0]['conversationId']}")).json()
    assert detail["messages"][1]["status"] == "cancelled"
    assert (await audit_rows(app))[-1].outcome == "cancelled"


# ── history, saved questions, export, feedback ─────────────────────────────


async def test_conversations_are_private(
    app: FastAPI, client: httpx.AsyncClient, idp: FakeIdP, fakedb: FakeDb
) -> None:
    await signed_in(client, idp, "analyst")
    events = await ask(client, "Total sales by status")
    conversation_id = events[0]["conversationId"]
    follow_up = await ask(client, "How many orders are there?", conversationId=conversation_id)
    assert follow_up[0]["conversationId"] == conversation_id
    detail = (await client.get(f"/api/conversations/{conversation_id}")).json()
    assert [m["role"] for m in detail["messages"]] == ["user", "assistant", "user", "assistant"]
    assert detail["title"] == "Total sales by status"
    renamed = await client.patch(
        f"/api/conversations/{conversation_id}", json={"title": "Sales", "pinned": True}
    )
    assert renamed.json()["pinned"] is True

    await signed_in(client, idp, "business")
    assert (await client.get(f"/api/conversations/{conversation_id}")).status_code == 404
    hijack = await client.post(
        "/api/queries", json={"question": "x", "sourceIds": [], "conversationId": conversation_id}
    )
    assert hijack.status_code == 404
    assert (await client.post(f"/api/queries/{events[0]['queryId']}/refresh", json={})).status_code == 404
    assert (await client.get("/api/conversations")).json() == []

    await signed_in(client, idp, "analyst")
    assert (await client.delete(f"/api/conversations/{conversation_id}")).status_code == 204
    assert (await client.get("/api/conversations")).json() == []


async def test_saved_questions(client: httpx.AsyncClient, idp: FakeIdP, fakedb: FakeDb) -> None:
    await signed_in(client, idp, "analyst")
    created = await client.post(
        "/api/saved-questions", json={"question": "Total sales by status", "sourceIds": ["sales", "not-mine"]}
    )
    assert created.status_code == 201 and created.json()["sourceIds"] == ["sales"]
    again = await client.post(
        "/api/saved-questions", json={"question": "Total sales by status", "sourceIds": []}
    )
    assert again.status_code == 200 and again.json()["id"] == created.json()["id"]
    assert len((await client.get("/api/saved-questions")).json()) == 1
    await signed_in(client, idp, "business")
    await client.delete(f"/api/saved-questions/{created.json()['id']}")  # someone else's: no effect
    await signed_in(client, idp, "analyst")
    assert len((await client.get("/api/saved-questions")).json()) == 1


async def test_export(app: FastAPI, client: httpx.AsyncClient, idp: FakeIdP, fakedb: FakeDb) -> None:
    await signed_in(client, idp, "analyst")
    fakedb.output = QueryOutput(["status", "total_amount"], [("=cmd|' /C calc'!A0", 5), ("paid", 7)])
    answer = final(await ask(client, "Total sales by status"))["answer"]
    response = await client.post(f"/api/queries/{answer['queryId']}/export", json={"format": "csv"})
    assert response.status_code == 200
    assert response.headers["content-disposition"].startswith('attachment; filename="codelens-export-')
    text = response.content.decode("utf-8-sig")
    assert text.startswith("Confidential — exported from CodeLens by Marcus Lee <marcus@example.com>")
    assert "\r\n'=cmd" in text
    [event] = await audit_rows(app, "export")
    assert event.rows_returned == 2

    await signed_in(client, idp, "business")
    business_answer = final(await ask(client, "Total sales by status"))["answer"]
    denied = await client.post(f"/api/queries/{business_answer['queryId']}/export", json={"format": "csv"})
    assert denied.status_code == 403


async def test_feedback(app: FastAPI, client: httpx.AsyncClient, idp: FakeIdP, fakedb: FakeDb) -> None:
    await signed_in(client, idp, "analyst")
    answer = final(await ask(client, "Total sales by status"))["answer"]
    response = await client.post(
        "/api/feedback",
        json={
            "queryId": answer["queryId"],
            "rating": "down",
            "reason": "wrong_numbers",
            "comment": "Looks low",
        },
    )
    assert response.status_code == 204
    async with app.state.sessionmaker() as db:
        [item] = list(await db.scalars(select(Feedback)))
    assert (item.rating, item.reason, item.comment) == ("down", "wrong_numbers", "Looks low")
    await signed_in(client, idp, "business")
    other = await client.post("/api/feedback", json={"queryId": answer["queryId"], "rating": "up"})
    assert other.status_code == 404


async def test_questions_are_rate_limited(
    app: FastAPI, client: httpx.AsyncClient, idp: FakeIdP, fakedb: FakeDb
) -> None:
    app.state.settings.questions_per_minute = 2
    await signed_in(client, idp, "analyst")
    statuses = [
        (
            await client.post("/api/queries", json={"question": "Total sales by status", "sourceIds": []})
        ).status_code
        for _ in range(3)
    ]
    assert statuses == [200, 200, 429]


async def test_question_validation(client: httpx.AsyncClient, idp: FakeIdP, fakedb: FakeDb) -> None:
    await signed_in(client, idp, "analyst")
    assert (await client.post("/api/queries", json={"question": "", "sourceIds": []})).status_code == 422
    assert (
        await client.post("/api/queries", json={"question": "x" * 2001, "sourceIds": []})
    ).status_code == 422
    del client.headers["X-CSRF-Token"]
    assert (await client.post("/api/queries", json={"question": "hi", "sourceIds": []})).status_code == 403
