"""Open-redirect protection: after sign-in we only ever redirect to a path on our own site."""

from __future__ import annotations

from urllib.parse import urlsplit

DEFAULT_RETURN_TO = "/ask"


def safe_return_to(value: str | None) -> str:
    if not value or len(value) > 2000:
        return DEFAULT_RETURN_TO
    # Must be a single-slash absolute path: rejects "//evil.com", "/\\evil.com", "https://…", "javascript:".
    if not value.startswith("/") or value.startswith("//") or "\\" in value:
        return DEFAULT_RETURN_TO
    if any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in value):
        return DEFAULT_RETURN_TO
    parts = urlsplit(value)
    if parts.scheme or parts.netloc:
        return DEFAULT_RETURN_TO
    # Never bounce back into the sign-in machinery.
    if parts.path.startswith("/api/") or parts.path == "/login":
        return DEFAULT_RETURN_TO
    return value
