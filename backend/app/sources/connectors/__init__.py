from __future__ import annotations

from app.sources.connectors.base import Connector, ConnectorError
from app.sources.connectors.mysql import MySqlConnector
from app.sources.connectors.postgres import PostgresConnector
from app.sources.fields import LABELS, SourceType

# SQL Server, Oracle, Snowflake, MongoDB and Redis arrive in phase 4.
CONNECTORS: dict[str, Connector] = {
    "postgresql": PostgresConnector(),
    "mysql": MySqlConnector(),
}


def connector_for(source_type: SourceType) -> Connector:
    connector = CONNECTORS.get(source_type)
    if connector is None:
        raise ConnectorError(
            f"CodeLens can't connect to {LABELS[source_type]} yet. Support is coming in a later update."
        )
    return connector


__all__ = ["CONNECTORS", "Connector", "ConnectorError", "connector_for"]
