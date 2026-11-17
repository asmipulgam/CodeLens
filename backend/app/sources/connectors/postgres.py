from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator, Coroutine
from contextlib import asynccontextmanager
from typing import Any

import psycopg

from app.sources.connectors.base import (
    MAX_ENTITIES,
    MAX_FIELDS_PER_ENTITY,
    ConnectorError,
    CostEstimate,
    DiscoveredEntity,
    DiscoveredNamespace,
    ProbeOutcome,
    QueryFailed,
    QueryOutput,
    friendly_error,
    summarise,
)
from app.sources.fields import ConnectionValue

# All queries skip system schemas (pg_catalog, information_schema, pg_toast*, pg_temp*).

# Role attributes that make an account able to change data or the server.
ROLE_ATTRIBUTES_SQL = """
SELECT rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls
FROM pg_roles WHERE rolname = current_user
"""

# Any relation this account could change: INSERT/UPDATE/DELETE/TRUNCATE (owners have all of these).
WRITABLE_RELATIONS_SQL = """
SELECT n.nspname || '.' || c.relname
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'
  AND (has_table_privilege(c.oid, 'INSERT') OR has_table_privilege(c.oid, 'UPDATE')
       OR has_table_privilege(c.oid, 'DELETE') OR has_table_privilege(c.oid, 'TRUNCATE'))
ORDER BY 1 LIMIT 5
"""

# Schemas where the account could create objects (a way to write data).
CREATE_SCHEMAS_SQL = """
SELECT n.nspname FROM pg_namespace n
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'
  AND has_schema_privilege(n.oid, 'CREATE')
ORDER BY 1 LIMIT 5
"""

DISCOVER_SQL = """
SELECT n.nspname, c.relname, c.relkind, a.attname, format_type(a.atttypid, a.atttypmod)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'
  AND has_schema_privilege(n.oid, 'USAGE') AND has_table_privilege(c.oid, 'SELECT')
ORDER BY n.nspname, c.relname, a.attnum
"""


class PostgresConnector:
    @asynccontextmanager
    async def _connect(
        self, connection: dict[str, ConnectionValue], secrets: dict[str, str], time_limit: float
    ) -> AsyncIterator[psycopg.AsyncConnection[Any]]:
        ssl_mode = str(connection.get("sslMode", "verify-full"))
        params: dict[str, Any] = {
            "host": connection["host"],
            "port": connection["port"],
            "dbname": connection["database"],
            "user": connection["username"],
            "password": secrets.get("password", ""),
            "sslmode": ssl_mode,
            "connect_timeout": max(2, int(time_limit)),
            "application_name": "codelens",
            # Belt and braces: even a mis-granted account can't write in this session.
            "options": f"-c default_transaction_read_only=on -c statement_timeout={int(time_limit * 1000)}",
            "autocommit": True,
        }
        if ssl_mode in ("verify-full", "verify-ca"):
            params["sslrootcert"] = "system"  # the operating system's trusted CAs
        try:
            conn = await psycopg.AsyncConnection.connect(**params)
        except psycopg.Error as exc:
            raise ConnectorError(friendly_error(exc, str(connection["host"]))) from exc
        try:
            yield conn
        finally:
            await conn.close()

    async def test(
        self, connection: dict[str, ConnectionValue], secrets: dict[str, str], time_limit: float
    ) -> ProbeOutcome:
        host = str(connection["host"])
        started = time.perf_counter()
        try:
            async with asyncio.timeout(time_limit):
                async with self._connect(connection, secrets, time_limit) as conn:
                    latency = int((time.perf_counter() - started) * 1000)
                    version = await _scalar(conn, "SHOW server_version")
                    attributes = await (await conn.execute(ROLE_ATTRIBUTES_SQL)).fetchone()
                    writable = [
                        row[0] for row in await (await conn.execute(WRITABLE_RELATIONS_SQL)).fetchall()
                    ]
                    creatable = [row[0] for row in await (await conn.execute(CREATE_SCHEMAS_SQL)).fetchall()]
        except ConnectorError as exc:
            return ProbeOutcome(ok=False, message=str(exc))
        except (TimeoutError, psycopg.Error, OSError) as exc:
            return ProbeOutcome(ok=False, message=friendly_error(exc, host))

        problems: list[str] = []
        if attributes and any(attributes):
            names = ["superuser", "create roles", "create databases", "replication", "bypass row security"]
            problems.append(
                "the account has " + ", ".join(n for n, on in zip(names, attributes, strict=True) if on)
            )
        if writable:
            problems.append("it can change data in " + summarise(writable))
        if creatable:
            problems.append("it can create objects in schema " + summarise(creatable))

        warnings: list[str] = []
        if connection.get("sslMode") == "require":
            warnings.append(
                "The server's certificate isn't verified. Use certificate verification in production."
            )
        if problems:
            message = "This account is not read-only: " + "; ".join(problems) + ". Use a SELECT-only account."
        else:
            message = "Connected over an encrypted connection with a read-only account."
        return ProbeOutcome(
            ok=True,
            message=message,
            read_only=not problems,
            latency_ms=latency,
            server_version=f"PostgreSQL {version}",
            warnings=warnings,
        )

    async def discover(
        self, connection: dict[str, ConnectionValue], secrets: dict[str, str], time_limit: float
    ) -> list[DiscoveredNamespace]:
        try:
            async with asyncio.timeout(time_limit):
                async with self._connect(connection, secrets, time_limit) as conn:
                    rows = await (await conn.execute(DISCOVER_SQL)).fetchall()
        except (TimeoutError, psycopg.Error, OSError) as exc:
            raise ConnectorError(friendly_error(exc, str(connection["host"]))) from exc

        namespaces: dict[str, dict[str, DiscoveredEntity]] = {}
        count = 0
        for schema, table, relkind, column, column_type in rows:
            entities = namespaces.setdefault(schema, {})
            entity = entities.get(table)
            if entity is None:
                if count >= MAX_ENTITIES:
                    continue
                count += 1
                entity = entities[table] = DiscoveredEntity(
                    table, "view" if relkind in ("v", "m") else "table", []
                )
            if len(entity.fields) < MAX_FIELDS_PER_ENTITY:
                entity.fields.append((column, column_type))
        return [DiscoveredNamespace(name, list(entities.values())) for name, entities in namespaces.items()]

    async def run(
        self,
        connection: dict[str, ConnectionValue],
        secrets: dict[str, str],
        sql: str,
        time_limit: float,
        max_rows: int,
    ) -> QueryOutput:
        async def go() -> QueryOutput:
            async with self._connect(connection, secrets, time_limit) as conn, conn.transaction():
                await conn.execute("SET TRANSACTION READ ONLY")
                cur = await conn.execute(sql)  # validated by sql_guard
                columns = [d.name for d in cur.description or []]
                rows = await cur.fetchmany(max_rows)
            return QueryOutput(columns, [tuple(r) for r in rows])

        result: QueryOutput = await _guarded(go(), str(connection["host"]), time_limit)
        return result

    async def estimate(
        self, connection: dict[str, ConnectionValue], secrets: dict[str, str], sql: str, time_limit: float
    ) -> CostEstimate:
        async def go() -> CostEstimate:
            async with self._connect(connection, secrets, time_limit) as conn, conn.transaction():
                await conn.execute("SET TRANSACTION READ ONLY")
                row = await (await conn.execute("EXPLAIN (FORMAT JSON) " + sql)).fetchone()
            plan = (row[0] if row else [{}])[0].get("Plan", {})
            return CostEstimate(rows_scanned=_scanned_rows(plan), cost=float(plan.get("Total Cost", 0)))

        result: CostEstimate = await _guarded(go(), str(connection["host"]), time_limit)
        return result


async def _scalar(conn: psycopg.AsyncConnection[Any], sql: str) -> str:
    row = await (await conn.execute(sql)).fetchone()
    return str(row[0]) if row else ""


def _scanned_rows(node: dict[str, Any]) -> int:
    """Rows the planner expects to read from tables (sum over scan nodes)."""
    own = int(node.get("Plan Rows", 0)) if "Scan" in str(node.get("Node Type", "")) else 0
    return own + sum(_scanned_rows(child) for child in node.get("Plans", []))


async def _guarded(coro: Coroutine[Any, Any, Any], host: str, time_limit: float) -> Any:
    try:
        async with asyncio.timeout(time_limit + 2):
            return await coro
    except (TimeoutError, psycopg.errors.QueryCanceled) as exc:
        raise ConnectorError("The query took too long and was stopped.") from exc
    except psycopg.errors.ReadOnlySqlTransaction as exc:
        raise ConnectorError("The database refused to change data (read-only).") from exc
    except psycopg.OperationalError as exc:
        raise ConnectorError(friendly_error(exc, host)) from exc
    except psycopg.Error as exc:
        raise QueryFailed(str(exc)) from exc
