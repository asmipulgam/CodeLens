"""The full question pipeline against the real sample databases from docker-compose.yml: the stand-in
planner's SQL passes sql_guard and runs on PostgreSQL and MySQL. Skipped if the samples aren't running."""

from __future__ import annotations

from typing import Any

import httpx
from fastapi import FastAPI
from sqlalchemy import select

from app.models import Role, Source
from tests.conftest import FakeIdP, signed_in
from tests.test_connectors_live import needs_mysql, needs_pg
from tests.test_queries import ask, final


def _fields(
    *names: str, masked: tuple[str, ...] = (), types: dict[str, str] | None = None
) -> list[dict[str, Any]]:
    return [
        {"name": n, "type": (types or {}).get(n, "text"), "description": "", "masked": n in masked}
        for n in names
    ]


async def _source(
    app: FastAPI,
    source_id: str,
    source_type: str,
    connection: dict[str, Any],
    password: str,
    exposed: list[dict[str, Any]],
) -> None:
    async with app.state.sessionmaker() as db, db.begin():
        db.add(
            Source(
                id=source_id,
                name=source_id,
                type=source_type,
                description="",
                owner="",
                enabled=True,
                status="healthy",
                connection=connection,
                secret_namespace=source_id,
                secret_status={"password": "x"},
                exposed=exposed,
                glossary=[],
                example_questions=[],
                row_limit=500,
                query_timeout_seconds=20,
                cache_ttl_seconds=0,
                schema_snapshot={},
            )
        )
        role = await db.get(Role, "analyst")
        assert role is not None
        role.source_ids = [source_id]
    await app.state.secrets.put(source_id, "password", password)


@needs_pg
async def test_live_postgres(app: FastAPI, client: httpx.AsyncClient, idp: FakeIdP) -> None:
    numeric = {
        "amount": "numeric(12,2)",
        "id": "integer",
        "customer_id": "integer",
        "region_id": "integer",
        "ordered_at": "date",
        "created_at": "date",
    }
    await _source(
        app,
        "pg",
        "postgresql",
        {
            "host": "localhost",
            "port": 5434,
            "database": "company",
            "username": "codelens_reader",
            "sslMode": "require",
        },
        "reader-dev",
        [
            {
                "namespace": "sales",
                "name": "orders",
                "kind": "table",
                "description": "",
                "fields": _fields("id", "customer_id", "amount", "status", "ordered_at", types=numeric),
            },
            {
                "namespace": "sales",
                "name": "customers",
                "kind": "table",
                "description": "",
                "fields": _fields(
                    "id", "name", "email", "region_id", "created_at", masked=("email",), types=numeric
                ),
            },
            {
                "namespace": "sales",
                "name": "regions",
                "kind": "table",
                "description": "",
                "fields": _fields("id", "name", types=numeric),
            },
        ],
    )
    await signed_in(client, idp, "analyst")

    count = final(await ask(client, "How many orders are there?"))["answer"]
    assert count["result"]["rows"] == [{"count": 5000}]

    by_status = final(await ask(client, "Total sales by status"))["answer"]
    assert {r["status"] for r in by_status["result"]["rows"]} == {"paid", "shipped", "cancelled", "refunded"}
    assert by_status["chart"]["type"] == "bar"

    top = final(await ask(client, "Top 3 customers by sales"))["answer"]
    assert len(top["result"]["rows"]) == 3 and top["result"]["columns"][1]["type"] == "currency"

    regions = final(await ask(client, "Customers by region"))["answer"]
    assert sum(r["count"] for r in regions["result"]["rows"]) == 200

    customers = final(await ask(client, "List customers"))["answer"]
    assert all(r["email"] is None for r in customers["result"]["rows"])
    assert customers["result"]["totalRows"] == 200


@needs_mysql
async def test_live_mysql(app: FastAPI, client: httpx.AsyncClient, idp: FakeIdP) -> None:
    await _source(
        app,
        "my",
        "mysql",
        {
            "host": "localhost",
            "port": 3307,
            "database": "sales",
            "username": "codelens_reader",
            "tlsMode": "REQUIRED",
        },
        "reader-dev",
        [
            {
                "namespace": "sales",
                "name": "orders",
                "kind": "table",
                "description": "",
                "fields": _fields(
                    "id",
                    "customer_id",
                    "amount",
                    "status",
                    "ordered_at",
                    types={
                        "amount": "decimal(12,2)",
                        "id": "int",
                        "customer_id": "int",
                        "ordered_at": "date",
                    },
                ),
            },
        ],
    )
    await signed_in(client, idp, "analyst")
    answer = final(await ask(client, "Total sales by status"))["answer"]
    assert {r["status"]: r["total_amount"] for r in answer["result"]["rows"]} == {
        "paid": 4200,
        "shipped": 450.5,
    }
    by_month_event = final(await ask(client, "Orders by month"))
    assert "answer" in by_month_event, by_month_event
    by_month = by_month_event["answer"]
    assert by_month["chart"]["type"] == "line"


async def test_live_sources_need_their_roles(app: FastAPI) -> None:
    async with app.state.sessionmaker() as db:
        assert list(await db.scalars(select(Source))) == []  # nothing leaks between tests
