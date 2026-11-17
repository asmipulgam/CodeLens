"""Data-source rules shared by the admin endpoints (and, later, the query pipeline)."""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass
from typing import Any

from app.config import Settings
from app.errors import ApiError
from app.models import Source
from app.secrets.store import SecretStore
from app.sources.connectors import ConnectorError, connector_for
from app.sources.connectors.base import DiscoveredNamespace, ProbeOutcome
from app.sources.fields import (
    ConnectionInvalid,
    ConnectionValue,
    SourceType,
    hosts_of,
    is_local_address,
    needed_secret_keys,
    normalise_connection,
)

PROBE_TIMEOUT_SECONDS = 15.0
_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def clean_text(value: str, limit: int) -> str:
    """Admin-written text is shown to users and given to the AI as context: strip control characters."""
    return _CONTROL_CHARS.sub("", value).strip()[:limit]


def invalid(message: str) -> ApiError:
    return ApiError(400, "invalid", message)


@dataclass
class ResolvedConnection:
    type: SourceType
    connection: dict[str, ConnectionValue]
    new_secrets: dict[str, str]
    secrets: dict[str, str]  # everything needed to connect (new + stored)


async def resolve_connection(
    *,
    settings: Settings,
    store: SecretStore,
    source_type: SourceType,
    connection: dict[str, ConnectionValue],
    new_secrets: dict[str, str],
    existing: Source | None,
) -> ResolvedConnection:
    """Validate settings, apply the host policy, and fill in stored secrets that weren't replaced."""
    stored_keys = set(existing.secret_status) if existing else set()
    try:
        clean, clean_secrets = normalise_connection(source_type, connection, new_secrets, stored_keys)
    except ConnectionInvalid as exc:
        raise invalid("Check the connection settings: " + "; ".join(exc.errors.values()) + ".") from exc

    if not settings.allow_local_source_hosts:
        hosts = hosts_of(source_type, clean)
        local = await asyncio.gather(*(asyncio.to_thread(is_local_address, host) for host in hosts))
        if any(local):
            raise invalid("Data sources can't point at this server's own network (localhost or link-local).")

    secrets = dict(clean_secrets)
    for key in needed_secret_keys(source_type, clean):
        if key not in secrets and existing is not None and key in existing.secret_status:
            value = await store.get(existing.secret_namespace, key)
            if value is not None:
                secrets[key] = value
    return ResolvedConnection(source_type, clean, clean_secrets, secrets)


async def test_connection(resolved: ResolvedConnection) -> ProbeOutcome:
    try:
        connector = connector_for(resolved.type)
    except ConnectorError as exc:
        return ProbeOutcome(ok=False, message=str(exc))
    return await connector.test(resolved.connection, resolved.secrets, PROBE_TIMEOUT_SECONDS)


async def discover(resolved: ResolvedConnection) -> list[DiscoveredNamespace]:
    try:
        return await connector_for(resolved.type).discover(
            resolved.connection, resolved.secrets, PROBE_TIMEOUT_SECONDS
        )
    except ConnectorError as exc:
        raise ApiError(400, "connection_failed", str(exc)) from exc


def require_read_only(outcome: ProbeOutcome) -> None:
    if not outcome.ok:
        raise ApiError(400, "connection_failed", outcome.message)
    if not outcome.read_only:
        raise ApiError(400, "not_read_only", outcome.message)


def snapshot_of(namespaces: list[DiscoveredNamespace]) -> dict[str, Any]:
    return {
        "namespaces": [
            {
                "name": ns.name,
                "entities": [
                    {"name": e.name, "kind": e.kind, "fields": [{"name": n, "type": t} for n, t in e.fields]}
                    for e in ns.entities
                ],
            }
            for ns in namespaces
        ]
    }


def validate_exposed(exposed: list[dict[str, Any]], snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    """Every exposed table and column must really exist (as seen by the server, not the browser).
    Types are taken from the database; descriptions and masking come from the admin."""
    known: dict[tuple[str, str], dict[str, Any]] = {
        (ns["name"], entity["name"]): entity
        for ns in snapshot.get("namespaces", [])
        for entity in ns["entities"]
    }
    problems: list[str] = []
    clean: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for entity in exposed:
        key = (entity["namespace"], entity["name"])
        found = known.get(key)
        if found is None:
            problems.append(f"{entity['namespace']}.{entity['name']} was not found")
            continue
        if key in seen:
            continue
        seen.add(key)
        types = {f["name"]: f["type"] for f in found["fields"]}
        fields = []
        for field in entity["fields"]:
            if field["name"] not in types:
                problems.append(f"column {field['name']} was not found in {entity['name']}")
                continue
            fields.append(
                {
                    "name": field["name"],
                    "type": types[field["name"]],
                    "description": clean_text(field.get("description", ""), 500),
                    "masked": bool(field.get("masked", False)),
                }
            )
        if not fields:
            problems.append(f"choose at least one column of {entity['name']}")
            continue
        clean.append(
            {
                "namespace": entity["namespace"],
                "name": entity["name"],
                "kind": found["kind"],
                "description": clean_text(entity.get("description", ""), 1000),
                "fields": fields,
            }
        )
    if problems:
        raise invalid("Some of the chosen data isn't available: " + "; ".join(problems[:10]) + ".")
    if not clean:
        raise invalid("Choose at least one table or collection people can ask about.")
    return clean
