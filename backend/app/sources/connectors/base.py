from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Literal, Protocol

from app.sources.fields import ConnectionValue

EntityKind = Literal["table", "view", "collection", "keyPattern"]

# Discovery limits: enough for real schemas, bounded so a huge database can't exhaust memory.
MAX_ENTITIES = 5000
MAX_FIELDS_PER_ENTITY = 500


@dataclass
class ProbeOutcome:
    ok: bool
    message: str
    read_only: bool = False
    latency_ms: int | None = None
    server_version: str | None = None
    warnings: list[str] = field(default_factory=list)


@dataclass
class DiscoveredEntity:
    name: str
    kind: EntityKind
    fields: list[tuple[str, str]]  # (column, type)


@dataclass
class DiscoveredNamespace:
    name: str
    entities: list[DiscoveredEntity]


@dataclass
class QueryOutput:
    columns: list[str]
    rows: list[tuple[object, ...]]


@dataclass
class CostEstimate:
    rows_scanned: int | None = None
    cost: float | None = None


class ConnectorError(Exception):
    """Connecting or querying failed. The message is written for the admin who is setting things up."""


class QueryFailed(ConnectorError):
    """Connected fine, but the database refused or failed the query itself. `detail` is the database's
    own message, kept for logs and the audit trail rather than shown to everyone."""

    def __init__(self, detail: str) -> None:
        super().__init__("The database couldn't run the query for this question.")
        self.detail = detail[:500]


class Connector(Protocol):
    async def test(
        self, connection: dict[str, ConnectionValue], secrets: dict[str, str], time_limit: float
    ) -> ProbeOutcome: ...

    async def discover(
        self, connection: dict[str, ConnectionValue], secrets: dict[str, str], time_limit: float
    ) -> list[DiscoveredNamespace]: ...

    async def run(
        self,
        connection: dict[str, ConnectionValue],
        secrets: dict[str, str],
        sql: str,
        time_limit: float,
        max_rows: int,
    ) -> QueryOutput:
        """Run one already-validated SELECT in a read-only session and return at most max_rows rows."""
        ...

    async def estimate(
        self, connection: dict[str, ConnectionValue], secrets: dict[str, str], sql: str, time_limit: float
    ) -> CostEstimate:
        """Ask the database's planner how much work the query is (EXPLAIN), without running it."""
        ...


def friendly_error(exc: BaseException, host: str) -> str:
    """Turn a driver error into a sentence an admin can act on, without dumping a stack trace.

    Drivers often try several addresses (IPv6, then IPv4) and report every attempt, so the most
    specific cause is checked first: a "password failed" on the second attempt beats a "refused" on the first.
    """
    full = str(exc).strip()
    lowered = full.lower()
    if (
        "password authentication failed" in lowered
        or "access denied" in lowered
        or ("authentication failed" in lowered)
    ):
        return "The database rejected the username or password."
    if "certificate" in lowered or "ssl" in lowered or "tls" in lowered:
        return f"The secure (TLS) connection failed: {_line_with(full, ('certificate', 'ssl', 'tls'))}"
    if ("database" in lowered and "does not exist" in lowered) or "unknown database" in lowered:
        return f"The server was reached but rejected the database name: {_line_with(full, ('database',))}"
    if any(
        marker in lowered
        for marker in (
            "could not translate host name",
            "name or service not known",
            "nodename nor servname",
            "unknown mysql server host",
            "getaddrinfo",
        )
    ):
        return f"Could not find {host}. Check the hostname."
    if "connection refused" in lowered or "can't connect" in lowered:
        return f"{host} refused the connection. Check the port and that the database is running."
    if isinstance(exc, TimeoutError) or "timeout" in lowered or "timed out" in lowered:
        return f"Timed out connecting to {host}. Check the hostname, port and firewall rules."
    return f"Could not connect: {_line_with(full, ())}"


def _line_with(text: str, keywords: tuple[str, ...]) -> str:
    """The most relevant line of a multi-line driver error, trimmed of the driver's prefixes."""
    lines = [line.strip() for line in text.splitlines() if line.strip()] or ["unknown error"]
    chosen = next((ln for ln in lines if any(k in ln.lower() for k in keywords)), lines[-1])
    chosen = re.sub(
        r"^.*?port \d+ failed: ", "", chosen
    )  # libpq: 'connection to server at …, port N failed: '
    wrapped = re.match(r'^\(\d+, ["\'](.*)["\']\)$', chosen)  # PyMySQL: '(2003, "…")'
    if wrapped:
        chosen = wrapped.group(1)
    return chosen.removeprefix("FATAL:").strip()[:200]


def summarise(items: list[str], limit: int = 6) -> str:
    """'a, b, c and 4 more' — keeps long privilege lists readable."""
    unique = list(dict.fromkeys(items))
    if len(unique) <= limit:
        return ", ".join(unique)
    return ", ".join(unique[:limit]) + f" and {len(unique) - limit} more"
