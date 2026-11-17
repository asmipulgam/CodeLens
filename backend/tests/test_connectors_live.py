"""The real PostgreSQL and MySQL connectors against the sample databases from docker-compose.yml.
Skipped when those aren't running (`docker compose up -d --wait`)."""

from __future__ import annotations

import socket

import pytest

from app.sources.connectors.mysql import MySqlConnector, parse_grants
from app.sources.connectors.postgres import PostgresConnector


def _listening(port: int) -> bool:
    with socket.socket() as sock:
        sock.settimeout(0.5)
        return sock.connect_ex(("127.0.0.1", port)) == 0


needs_pg = pytest.mark.skipif(not _listening(5434), reason="sample Postgres not running")
needs_mysql = pytest.mark.skipif(not _listening(3307), reason="sample MySQL not running")


def pg(user: str, ssl: str = "require", **extra: object) -> dict[str, object]:
    return {
        "host": "localhost",
        "port": 5434,
        "database": "company",
        "username": user,
        "sslMode": ssl,
        **extra,
    }


def my(user: str, tls: str = "REQUIRED") -> dict[str, object]:
    return {"host": "localhost", "port": 3307, "database": "sales", "username": user, "tlsMode": tls}


@needs_pg
@pytest.mark.parametrize(
    ("user", "password", "ok", "read_only", "fragment"),
    [
        ("codelens_reader", "reader-dev", True, True, "read-only account"),
        ("codelens_writer", "writer-dev", True, False, "can change data in sales.orders"),
        ("owner", "owner-dev", True, False, "superuser"),
        ("codelens_reader", "wrong", False, False, "rejected the username or password"),
    ],
)
async def test_postgres_read_only_check(
    user: str, password: str, ok: bool, read_only: bool, fragment: str
) -> None:
    outcome = await PostgresConnector().test(pg(user), {"password": password}, 15)  # type: ignore[arg-type]
    assert (outcome.ok, outcome.read_only) == (ok, read_only), outcome.message
    assert fragment in outcome.message


@needs_pg
async def test_postgres_tls_is_enforced_and_verified() -> None:
    unverified = await PostgresConnector().test(
        pg("codelens_reader", "verify-full"), {"password": "reader-dev"}, 15
    )  # type: ignore[arg-type]
    assert not unverified.ok and "certificate verify failed" in unverified.message
    # The app's own Postgres (5433) has no TLS: CodeLens refuses to talk to it in plain text.
    plain = await PostgresConnector().test(  # type: ignore[arg-type]
        {**pg("codelens"), "port": 5433, "database": "codelens"}, {"password": "codelens"}, 15
    )
    assert not plain.ok and "does not support SSL" in plain.message


@needs_pg
async def test_postgres_discovery_shows_only_readable_tables() -> None:
    namespaces = await PostgresConnector().discover(pg("codelens_reader"), {"password": "reader-dev"}, 15)  # type: ignore[arg-type]
    assert [ns.name for ns in namespaces] == ["sales"]  # hr.salaries is invisible to this account
    entities = {e.name: e for e in namespaces[0].entities}
    assert set(entities) == {"customers", "monthly_revenue", "orders", "products", "regions"}
    assert entities["monthly_revenue"].kind == "view"
    assert ("amount", "numeric(12,2)") in entities["orders"].fields


@needs_mysql
@pytest.mark.parametrize(
    ("user", "password", "read_only", "fragment"),
    [
        ("codelens_reader", "reader-dev", True, "read-only account"),
        ("codelens_writer", "writer-dev", False, "INSERT"),
        ("codelens_role_user", "role-dev", False, "UPDATE"),  # write access through a role is found too
        ("root", "root-dev", False, "and "),
    ],
)
async def test_mysql_read_only_check(user: str, password: str, read_only: bool, fragment: str) -> None:
    outcome = await MySqlConnector().test(my(user), {"password": password}, 15)  # type: ignore[arg-type]
    assert outcome.ok, outcome.message
    assert outcome.read_only is read_only and fragment in outcome.message


@needs_mysql
async def test_mysql_tls_verification_and_discovery() -> None:
    unverified = await MySqlConnector().test(
        my("codelens_reader", "VERIFY_IDENTITY"), {"password": "reader-dev"}, 15
    )  # type: ignore[arg-type]
    assert not unverified.ok and "CERTIFICATE_VERIFY_FAILED" in unverified.message
    namespaces = await MySqlConnector().discover(my("codelens_reader"), {"password": "reader-dev"}, 15)  # type: ignore[arg-type]
    entities = {e.name: e.kind for e in namespaces[0].entities}
    assert entities == {
        "customers": "table",
        "orders": "table",
        "regions": "table",
        "revenue_by_region": "view",
    }


def test_mysql_grant_parsing() -> None:
    assert (
        parse_grants(
            [
                "GRANT USAGE ON *.* TO `r`@`%`",
                "GRANT SELECT, SHOW VIEW ON `sales`.* TO `r`@`%`",
                "GRANT SELECT (`id`, `amount`) ON `sales`.`orders` TO `r`@`%`",
                "GRANT `sales_editor`@`%` TO `r`@`%`",
            ]
        )
        == []
    )
    assert parse_grants(["GRANT SELECT ON `sales`.* TO `r`@`%` WITH GRANT OPTION"]) == ["GRANT OPTION"]
    assert parse_grants(["GRANT ALL PRIVILEGES ON `sales`.* TO `r`@`%`"]) == ["ALL PRIVILEGES"]
    assert parse_grants(["GRANT BACKUP_ADMIN ON *.* TO `r`@`%`"]) == ["BACKUP_ADMIN"]
