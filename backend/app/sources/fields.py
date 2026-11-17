"""Connection settings each database type accepts — the server-side twin of the frontend's
`connectionFields.ts`. Anything not listed here is rejected, so a request can't smuggle extra
driver options (for example a different TLS setting or a local file path) into a connection."""

from __future__ import annotations

import ipaddress
import re
import socket
from dataclasses import dataclass
from typing import Literal

SourceType = Literal["postgresql", "mysql", "sqlserver", "oracle", "snowflake", "mongodb", "redis"]
SOURCE_TYPES: tuple[SourceType, ...] = (
    "postgresql",
    "mysql",
    "sqlserver",
    "oracle",
    "snowflake",
    "mongodb",
    "redis",
)

Kind = Literal["text", "number", "secret", "select", "checkbox"]

HOSTNAME = re.compile(r"^[A-Za-z0-9.-]{1,253}$")
HOST_LIST = re.compile(r"^\s*[A-Za-z0-9.-]+(:\d{1,5})?(\s*,\s*[A-Za-z0-9.-]+(:\d{1,5})?)*\s*$")
IDENTIFIER = re.compile(r"^[A-Za-z0-9_$.\-]{1,128}$")
USERNAME_PATTERN = re.compile(r"^[A-Za-z0-9_$.@\-]{1,128}$")  # Azure SQL style user@server is allowed


@dataclass(frozen=True)
class Field:
    key: str
    label: str
    kind: Kind
    required: bool = False
    options: tuple[str, ...] = ()
    default: str | int | bool | None = None
    show_if: tuple[str, str] | None = None


HOST = Field("host", "Host", "text", required=True)
DATABASE = Field("database", "Database name", "text", required=True)
USERNAME = Field("username", "Username", "text", required=True)
PASSWORD = Field("password", "Password", "secret", required=True)


def _port(default: int) -> Field:
    return Field("port", "Port", "number", required=True, default=default)


FIELDS: dict[SourceType, tuple[Field, ...]] = {
    "postgresql": (
        HOST,
        _port(5432),
        DATABASE,
        USERNAME,
        PASSWORD,
        Field(
            "sslMode",
            "TLS / SSL",
            "select",
            options=("verify-full", "verify-ca", "require"),
            default="verify-full",
        ),
    ),
    "mysql": (
        HOST,
        _port(3306),
        DATABASE,
        USERNAME,
        PASSWORD,
        Field(
            "tlsMode",
            "TLS",
            "select",
            options=("VERIFY_IDENTITY", "VERIFY_CA", "REQUIRED"),
            default="VERIFY_IDENTITY",
        ),
    ),
    "sqlserver": (
        HOST,
        _port(1433),
        DATABASE,
        USERNAME,
        PASSWORD,
        Field("encrypt", "Encryption", "select", options=("strict", "mandatory"), default="strict"),
    ),
    "oracle": (
        HOST,
        _port(1521),
        Field("serviceName", "Service name", "text", required=True),
        USERNAME,
        PASSWORD,
        Field("useTls", "Use TLS (TCPS)", "checkbox", default=True),
    ),
    "snowflake": (
        Field("account", "Account identifier", "text", required=True),
        Field("warehouse", "Warehouse", "text", required=True),
        Field("database", "Database", "text", required=True),
        Field("schema", "Default schema", "text"),
        Field("role", "Role", "text", required=True),
        USERNAME,
        Field("authMethod", "Authentication", "select", options=("keypair", "password"), default="keypair"),
        Field("privateKey", "Private key (PEM)", "secret", required=True, show_if=("authMethod", "keypair")),
        Field("privateKeyPassphrase", "Private key passphrase", "secret", show_if=("authMethod", "keypair")),
        Field("password", "Password", "secret", required=True, show_if=("authMethod", "password")),
    ),
    "mongodb": (
        Field("hosts", "Hosts", "text", required=True),
        Field("replicaSet", "Replica set", "text"),
        DATABASE,
        Field("authSource", "Authentication database", "text", default="admin"),
        USERNAME,
        PASSWORD,
        Field("tls", "Use TLS", "checkbox", default=True),
    ),
    "redis": (
        HOST,
        _port(6379),
        Field("dbIndex", "Database number", "number", default=0),
        Field("username", "ACL username", "text", required=True),
        PASSWORD,
        Field("tls", "Use TLS", "checkbox", default=True),
    ),
}

LABELS: dict[SourceType, str] = {
    "postgresql": "PostgreSQL",
    "mysql": "MySQL",
    "sqlserver": "SQL Server",
    "oracle": "Oracle",
    "snowflake": "Snowflake",
    "mongodb": "MongoDB",
    "redis": "Redis",
}

ConnectionValue = str | int | bool


class ConnectionInvalid(ValueError):
    def __init__(self, errors: dict[str, str]) -> None:
        super().__init__("; ".join(f"{key}: {message}" for key, message in errors.items()))
        self.errors = errors


def _visible(field: Field, values: dict[str, ConnectionValue]) -> bool:
    if field.show_if is None:
        return True
    key, expected = field.show_if
    return values.get(key) == expected


def secret_keys(source_type: SourceType) -> list[str]:
    return [f.key for f in FIELDS[source_type] if f.kind == "secret"]


def normalise_connection(
    source_type: SourceType,
    connection: dict[str, ConnectionValue],
    secrets: dict[str, str],
    stored_secret_keys: set[str],
) -> tuple[dict[str, ConnectionValue], dict[str, str]]:
    """Validate and clean connection settings and new secrets. Returns (connection, secrets) with
    defaults applied and hidden fields dropped. Raises ConnectionInvalid listing every problem."""
    fields = {f.key: f for f in FIELDS[source_type]}
    errors: dict[str, str] = {}

    for key in connection:
        field = fields.get(key)
        if field is None or field.kind == "secret":
            errors[key] = "is not a setting for this database type"
    for key in secrets:
        field = fields.get(key)
        if field is None or field.kind != "secret":
            errors[key] = "is not a credential for this database type"
    if errors:
        raise ConnectionInvalid(errors)

    clean: dict[str, ConnectionValue] = {}
    for field in fields.values():
        if field.kind == "secret":
            continue
        raw = connection.get(field.key, field.default)
        if raw is None or raw == "":
            if field.required:
                errors[field.key] = f"{field.label} is required"
            continue
        if field.kind == "number":
            if isinstance(raw, bool) or not (
                isinstance(raw, int) or (isinstance(raw, str) and raw.isdigit())
            ):
                errors[field.key] = f"{field.label} must be a whole number"
                continue
            number = int(raw)
            low = 1 if field.key == "port" else 0
            if not low <= number <= 65535:
                errors[field.key] = f"{field.label} is out of range"
                continue
            clean[field.key] = number
        elif field.kind == "checkbox":
            if not isinstance(raw, bool):
                errors[field.key] = f"{field.label} must be true or false"
                continue
            clean[field.key] = raw
        else:
            if not isinstance(raw, str):
                errors[field.key] = f"{field.label} must be text"
                continue
            text = raw.strip()
            if field.kind == "select" and text not in field.options:
                errors[field.key] = f"{field.label} must be one of {', '.join(field.options)}"
                continue
            if field.key == "host" and not HOSTNAME.match(text):
                errors[field.key] = "Enter a hostname or IP address only (no protocol, path or credentials)"
                continue
            if field.key == "hosts" and (len(text) > 1000 or not HOST_LIST.match(text)):
                errors[field.key] = "Use host:port pairs separated by commas, with no credentials"
                continue
            pattern = USERNAME_PATTERN if field.key == "username" else IDENTIFIER
            if field.key not in ("host", "hosts") and not pattern.match(text):
                errors[field.key] = f"{field.label} contains characters that aren't allowed"
                continue
            clean[field.key] = text

    # Drop settings that only apply to another option (e.g. password vs key-pair sign-in).
    clean = {k: v for k, v in clean.items() if _visible(fields[k], clean)}
    clean_secrets: dict[str, str] = {}
    for field in fields.values():
        if field.kind != "secret" or not _visible(field, clean):
            continue
        value = secrets.get(field.key, "")
        if value:
            if len(value) > 16_384:
                errors[field.key] = f"{field.label} is too long"
            elif field.key == "privateKey" and "PRIVATE KEY" not in value:
                errors[field.key] = "Paste the full PEM private key, including the BEGIN/END lines"
            else:
                clean_secrets[field.key] = value
        elif field.required and field.key not in stored_secret_keys:
            errors[field.key] = f"{field.label} is required"
    if errors:
        raise ConnectionInvalid(errors)
    return clean, clean_secrets


def needed_secret_keys(source_type: SourceType, connection: dict[str, ConnectionValue]) -> list[str]:
    return [f.key for f in FIELDS[source_type] if f.kind == "secret" and _visible(f, connection)]


def hosts_of(source_type: SourceType, connection: dict[str, ConnectionValue]) -> list[str]:
    if source_type == "mongodb":
        return [
            part.strip().split(":")[0] for part in str(connection.get("hosts", "")).split(",") if part.strip()
        ]
    if source_type == "snowflake":
        return []  # Snowflake hosts are derived from the account identifier
    return [str(connection.get("host", ""))]


def is_local_address(host: str) -> bool:
    """True if the host is, or resolves to, a loopback / link-local / unspecified address."""
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return False  # unresolvable: the connection test will report it
    for info in infos:
        address = ipaddress.ip_address(info[4][0])
        if address.is_loopback or address.is_link_local or address.is_unspecified:
            return True
    return False
