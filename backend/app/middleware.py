"""Pure-ASGI middleware (safe for streamed responses): security headers and a request size cap."""

from __future__ import annotations

import logging
import re

from starlette.types import ASGIApp, Message, Receive, Scope, Send

SECURITY_HEADERS: list[tuple[bytes, bytes]] = [
    (b"cache-control", b"no-store"),
    (b"pragma", b"no-cache"),
    (b"x-content-type-options", b"nosniff"),
    (b"x-frame-options", b"DENY"),
    (b"referrer-policy", b"no-referrer"),
    (b"content-security-policy", b"default-src 'none'; frame-ancestors 'none'; base-uri 'none'"),
    (b"cross-origin-resource-policy", b"same-origin"),
]
MAX_BODY_BYTES = 1_000_000


class SecurityHeadersMiddleware:
    def __init__(self, app: ASGIApp, *, hsts: bool) -> None:
        self.app = app
        self.headers = list(SECURITY_HEADERS)
        if hsts:
            self.headers.append((b"strict-transport-security", b"max-age=63072000; includeSubDomains"))

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                names = {name for name, _ in self.headers}
                existing = [(k, v) for k, v in message.get("headers", []) if k.lower() not in names]
                existing = [(k, v) for k, v in existing if k.lower() != b"server"]
                message["headers"] = existing + self.headers
            await send(message)

        await self.app(scope, receive, send_with_headers)


class BodySizeLimitMiddleware:
    """Reject oversized bodies early (nginx also limits this; this is the backend's own guard)."""

    def __init__(self, app: ASGIApp, max_bytes: int = MAX_BODY_BYTES) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        for name, value in scope.get("headers", []):
            if name == b"content-length" and value.isdigit() and int(value) > self.max_bytes:
                await _too_large(send)
                return

        received = 0

        async def limited_receive() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_bytes:
                    raise _BodyTooLarge
            return message

        try:
            await self.app(scope, limited_receive, send)
        except _BodyTooLarge:
            await _too_large(send)


class _BodyTooLarge(Exception):
    pass


async def _too_large(send: Send) -> None:
    body = b'{"code":"too_large","message":"The request is too large."}'
    await send(
        {
            "type": "http.response.start",
            "status": 413,
            "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())],
        }
    )
    await send({"type": "http.response.body", "body": body})


class StripQueryStringFilter(logging.Filter):
    """Access logs must not contain query strings (sign-in callbacks carry one-time codes)."""

    _query = re.compile(r"\?[^ \"]*")

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, tuple) and len(record.args) >= 3:
            path = record.args[2]
            if isinstance(path, str):
                record.args = (*record.args[:2], self._query.sub("", path), *record.args[3:])
        return True
