"""MySQL / MariaDB. PyMySQL is synchronous, so each call runs in a worker thread."""

from __future__ import annotations

import asyncio
import re
import ssl
import time
from typing import Any

import pymysql
import pymysql.cursors

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

READ_ONLY_PRIVILEGES = {"USAGE", "SELECT", "SHOW VIEW", "SHOW DATABASES"}
GRANT_LINE = re.compile(r"^GRANT (?P<privs>.+?) ON (?P<target>\S+) TO ", re.IGNORECASE)

DISCOVER_SQL = """
SELECT c.TABLE_NAME, t.TABLE_TYPE, c.COLUMN_NAME, c.COLUMN_TYPE
FROM information_schema.COLUMNS c
JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
WHERE c.TABLE_SCHEMA = %s
ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION
"""


def _ssl_context(mode: str) -> ssl.SSLContext:
    context = ssl.create_default_context()
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    if mode == "VERIFY_CA":
        context.check_hostname = False
    elif mode == "REQUIRED":
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
    return context


def _connect(connection: dict[str, ConnectionValue], secrets: dict[str, str], time_limit: float) -> Any:
    conn = pymysql.connect(
        host=str(connection["host"]),
        port=int(connection["port"]),
        user=str(connection["username"]),
        password=secrets.get("password", ""),
        database=str(connection["database"]),
        ssl=_ssl_context(str(connection.get("tlsMode", "VERIFY_IDENTITY"))),
        connect_timeout=max(2, int(time_limit)),
        read_timeout=max(2, int(time_limit)),
        write_timeout=max(2, int(time_limit)),
        charset="utf8mb4",
        autocommit=True,
        init_command="SET SESSION TRANSACTION READ ONLY",
        local_infile=False,
    )
    # PyMySQL quietly falls back to plain text if the server doesn't offer TLS; refuse that.
    with conn.cursor() as cur:
        cur.execute("SHOW SESSION STATUS LIKE 'Ssl_cipher'")
        row = cur.fetchone()
    if not row or not row[1]:
        conn.close()
        raise ConnectorError(
            "The server doesn't support encrypted (TLS) connections, so CodeLens won't use it."
        )
    return conn


def _split_top_level(text: str) -> list[str]:
    """Split on commas that aren't inside parentheses: "SELECT (`a`, `b`), INSERT" -> 2 parts."""
    parts, depth, current = [], 0, ""
    for char in text:
        depth += {"(": 1, ")": -1}.get(char, 0)
        if char == "," and depth == 0:
            parts.append(current)
            current = ""
        else:
            current += char
    return [*parts, current]


def parse_grants(lines: list[str]) -> list[str]:
    """Return the privileges in SHOW GRANTS output that go beyond reading."""
    extra: list[str] = []
    for line in lines:
        match = GRANT_LINE.match(line)
        if not match:
            continue
        if "WITH GRANT OPTION" in line.upper():
            extra.append("GRANT OPTION")
        privs = match.group("privs")
        if privs.startswith("`") or privs.startswith("'"):
            continue  # a role grant (GRANT `role`@`%` TO ...); its privileges are listed via USING
        for raw in _split_top_level(privs):
            name = raw.split("(")[0].strip().upper()  # "SELECT (col)" -> SELECT
            if name and name not in READ_ONLY_PRIVILEGES and name not in extra:
                extra.append(name)
    return extra


def _test_sync(
    connection: dict[str, ConnectionValue], secrets: dict[str, str], time_limit: float
) -> ProbeOutcome:
    started = time.perf_counter()
    conn = _connect(connection, secrets, time_limit)
    try:
        latency = int((time.perf_counter() - started) * 1000)
        with conn.cursor() as cur:
            cur.execute("SELECT VERSION()")
            version = str(cur.fetchone()[0])
            cur.execute("SET ROLE ALL")
            cur.execute("SELECT CURRENT_ROLE()")
            roles = str(cur.fetchone()[0])
            query = "SHOW GRANTS FOR CURRENT_USER()"
            if roles and roles.upper() != "NONE":
                query += f" USING {roles}"  # value comes from the server, not from user input
            cur.execute(query)
            grants = [str(row[0]) for row in cur.fetchall()]
    finally:
        conn.close()

    extra = parse_grants(grants)
    warnings: list[str] = []
    if connection.get("tlsMode") == "REQUIRED":
        warnings.append(
            "The server's certificate isn't verified. Use certificate verification in production."
        )
    product = "MariaDB" if "mariadb" in version.lower() else "MySQL"
    if extra:
        message = (
            f"This account is not read-only: it has {summarise(extra)}. Use an account with only SELECT."
        )
    else:
        message = "Connected over an encrypted connection with a read-only account."
    return ProbeOutcome(
        ok=True,
        message=message,
        read_only=not extra,
        latency_ms=latency,
        server_version=f"{product} {version.split('-')[0]}",
        warnings=warnings,
    )


def _discover_sync(
    connection: dict[str, ConnectionValue], secrets: dict[str, str], time_limit: float
) -> list[DiscoveredNamespace]:
    conn = _connect(connection, secrets, time_limit)
    try:
        with conn.cursor() as cur:
            cur.execute(DISCOVER_SQL, (str(connection["database"]),))
            rows = cur.fetchall()
    finally:
        conn.close()
    entities: dict[str, DiscoveredEntity] = {}
    for table, table_type, column, column_type in rows:
        entity = entities.get(table)
        if entity is None:
            if len(entities) >= MAX_ENTITIES:
                continue
            entity = entities[table] = DiscoveredEntity(
                table, "view" if table_type == "VIEW" else "table", []
            )
        if len(entity.fields) < MAX_FIELDS_PER_ENTITY:
            entity.fields.append((column, column_type))
    return [DiscoveredNamespace(str(connection["database"]), list(entities.values()))]


def _run_sync(
    connection: dict[str, ConnectionValue],
    secrets: dict[str, str],
    sql: str,
    time_limit: float,
    max_rows: int,
) -> QueryOutput:
    conn = _connect(connection, secrets, time_limit)
    try:
        with conn.cursor() as cur:
            cur.execute(f"SET SESSION MAX_EXECUTION_TIME = {int(time_limit * 1000)}")
            cur.execute("START TRANSACTION READ ONLY")
            cur.execute(sql)  # validated by sql_guard
            columns = [d[0] for d in cur.description or []]
            rows = cur.fetchmany(max_rows)
            cur.execute("ROLLBACK")
    finally:
        conn.close()
    return QueryOutput(columns, [tuple(r) for r in rows])


def _estimate_sync(
    connection: dict[str, ConnectionValue], secrets: dict[str, str], sql: str, time_limit: float
) -> CostEstimate:
    import json

    conn = _connect(connection, secrets, time_limit)
    try:
        with conn.cursor() as cur:
            cur.execute("EXPLAIN FORMAT=JSON " + sql)
            plan = json.loads(cur.fetchone()[0])
    finally:
        conn.close()
    block = plan.get("query_block", {})
    scanned = 0

    def walk(node: object) -> None:
        nonlocal scanned
        if isinstance(node, dict):
            if "rows_examined_per_scan" in node:
                scanned += int(node["rows_examined_per_scan"])
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(block)
    cost = float(block.get("cost_info", {}).get("query_cost", 0) or 0)
    return CostEstimate(rows_scanned=scanned, cost=cost)


class MySqlConnector:
    async def test(
        self, connection: dict[str, ConnectionValue], secrets: dict[str, str], time_limit: float
    ) -> ProbeOutcome:
        try:
            async with asyncio.timeout(time_limit + 2):
                return await asyncio.to_thread(_test_sync, connection, secrets, time_limit)
        except ConnectorError as exc:
            return ProbeOutcome(ok=False, message=str(exc))
        except (TimeoutError, pymysql.MySQLError, OSError) as exc:
            return ProbeOutcome(ok=False, message=friendly_error(exc, str(connection["host"])))

    async def discover(
        self, connection: dict[str, ConnectionValue], secrets: dict[str, str], time_limit: float
    ) -> list[DiscoveredNamespace]:
        try:
            async with asyncio.timeout(time_limit + 2):
                return await asyncio.to_thread(_discover_sync, connection, secrets, time_limit)
        except ConnectorError:
            raise
        except (TimeoutError, pymysql.MySQLError, OSError) as exc:
            raise ConnectorError(friendly_error(exc, str(connection["host"]))) from exc

    async def run(
        self,
        connection: dict[str, ConnectionValue],
        secrets: dict[str, str],
        sql: str,
        time_limit: float,
        max_rows: int,
    ) -> QueryOutput:
        result: QueryOutput = await _guarded(
            asyncio.to_thread(_run_sync, connection, secrets, sql, time_limit, max_rows),
            str(connection["host"]),
            time_limit,
        )
        return result

    async def estimate(
        self, connection: dict[str, ConnectionValue], secrets: dict[str, str], sql: str, time_limit: float
    ) -> CostEstimate:
        result: CostEstimate = await _guarded(
            asyncio.to_thread(_estimate_sync, connection, secrets, sql, time_limit),
            str(connection["host"]),
            time_limit,
        )
        return result


async def _guarded(coro: Any, host: str, time_limit: float) -> Any:
    try:
        async with asyncio.timeout(time_limit + 2):
            return await coro
    except ConnectorError:
        raise
    except TimeoutError as exc:
        raise ConnectorError("The query took too long and was stopped.") from exc
    except pymysql.MySQLError as exc:
        if exc.args and exc.args[0] in (3024, 1317):  # max_execution_time exceeded / interrupted
            raise ConnectorError("The query took too long and was stopped.") from exc
        if exc.args and exc.args[0] == 1792:  # write in a read-only transaction
            raise ConnectorError("The database refused to change data (read-only).") from exc
        if (
            isinstance(exc, pymysql.OperationalError)
            and exc.args
            and exc.args[0] in (2003, 2005, 2006, 2013, 1045)
        ):
            raise ConnectorError(friendly_error(exc, host)) from exc  # couldn't connect / lost the connection
        raise QueryFailed(str(exc)) from exc
