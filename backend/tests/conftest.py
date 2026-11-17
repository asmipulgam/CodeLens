"""Test harness: the real app with SQLite, an in-memory Redis, and a fake OpenID Connect provider
that signs real tokens — so signature, nonce, audience and PKCE checks all run for real."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import secrets
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from fakeredis import FakeAsyncRedis
from fastapi import FastAPI
from joserfc import jwt
from joserfc.jwk import RSAKey
from sqlalchemy.ext.asyncio import create_async_engine

from app.config import Settings
from app.db import Base
from app.main import create_app

PUBLIC_URL = "https://codelens.test"
ISSUER = "https://idp.test/realms/codelens"
CLIENT_ID = "codelens"
CLIENT_SECRET = "test-secret"


@dataclass
class PendingCode:
    nonce: str
    challenge: str
    redirect_uri: str
    claims: dict[str, Any]


@dataclass
class FakeIdP:
    issuer: str = ISSUER
    client_id: str = CLIENT_ID
    client_secret: str = CLIENT_SECRET
    key: RSAKey = field(default_factory=lambda: RSAKey.generate_key(2048, parameters={"kid": "k1"}))
    codes: dict[str, PendingCode] = field(default_factory=dict)
    # Tests set these to make the provider misbehave.
    tamper: dict[str, Any] = field(default_factory=dict)
    signing_key: RSAKey | None = None
    token_requests: int = 0
    has_logout: bool = True  # Google publishes no end-session endpoint

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == urlsplit(self.issuer).path + "/.well-known/openid-configuration":
            base = f"{self.issuer}/protocol/openid-connect"
            metadata = {
                "issuer": self.issuer,
                "authorization_endpoint": f"{base}/auth",
                "token_endpoint": f"{base}/token",
                "jwks_uri": f"{base}/certs",
            }
            if self.has_logout:
                metadata["end_session_endpoint"] = f"{base}/logout"
            return httpx.Response(200, json=metadata)
        if path.endswith("/certs"):
            return httpx.Response(200, json={"keys": [self.key.as_dict(private=False)]})
        if path.endswith("/token"):
            return self._token(request)
        return httpx.Response(404)

    def _token(self, request: httpx.Request) -> httpx.Response:
        self.token_requests += 1
        expected = "Basic " + base64.b64encode(f"{self.client_id}:{self.client_secret}".encode()).decode()
        if request.headers.get("authorization") != expected:
            return httpx.Response(401, json={"error": "invalid_client"})
        form = {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
        pending = self.codes.pop(form.get("code", ""), None)
        if pending is None or form.get("redirect_uri") != pending.redirect_uri:
            return httpx.Response(400, json={"error": "invalid_grant"})
        digest = hashlib.sha256(form.get("code_verifier", "").encode()).digest()
        if base64.urlsafe_b64encode(digest).rstrip(b"=").decode() != pending.challenge:
            return httpx.Response(400, json={"error": "invalid_grant", "error_description": "PKCE"})
        now = int(time.time())
        claims = {
            "iss": self.issuer,
            "aud": self.client_id,
            "sub": "sub-1",
            "iat": now,
            "exp": now + 300,
            "auth_time": now,
            "nonce": pending.nonce,
            **pending.claims,
            **self.tamper,
        }
        claims = {k: v for k, v in claims.items() if v is not None}
        token = jwt.encode({"alg": "RS256", "kid": "k1"}, claims, self.signing_key or self.key)
        return httpx.Response(200, json={"id_token": token, "access_token": "unused", "token_type": "Bearer"})

    def authorize(self, authorize_url: str, claims: dict[str, Any]) -> tuple[str, str]:
        """Play the user signing in at the provider. Returns (code, state) for the callback."""
        query = {k: v[0] for k, v in parse_qs(urlsplit(authorize_url).query).items()}
        assert query["response_type"] == "code"
        assert query["code_challenge_method"] == "S256"
        code = secrets.token_urlsafe(16)
        self.codes[code] = PendingCode(query["nonce"], query["code_challenge"], query["redirect_uri"], claims)
        return code, query["state"]


USERS = {
    "analyst": {
        "sub": "sub-marcus",
        "email": "marcus@example.com",
        "name": "Marcus Lee",
        "groups": ["codelens-analysts"],
    },
    "business": {
        "sub": "sub-priya",
        "email": "priya@example.com",
        "name": "Priya Shah",
        "groups": ["codelens-business"],
    },
    "admin": {
        "sub": "sub-dana",
        "email": "dana@example.com",
        "name": "Dana Okafor",
        "groups": ["codelens-admins"],
    },
    "outsider": {"sub": "sub-alex", "email": "alex@example.com", "name": "Alex Kim", "groups": ["marketing"]},
}


class MemorySecretStore:
    def __init__(self) -> None:
        self.values: dict[tuple[str, str], str] = {}

    async def put(self, namespace: str, key: str, value: str) -> None:
        self.values[(namespace, key)] = value

    async def get(self, namespace: str, key: str) -> str | None:
        return self.values.get((namespace, key))

    async def delete(self, namespace: str, keys: list[str]) -> None:
        for key in keys:
            self.values.pop((namespace, key), None)

    async def close(self) -> None:
        return None


@pytest.fixture
def idp() -> FakeIdP:
    return FakeIdP()


GOOGLE_ISSUER = "https://accounts.google.test"
GOOGLE_CLIENT_ID = "codelens.apps.googleusercontent.test"
GOOGLE_USERS = {
    "guest": {
        "sub": "g-1",
        "email": "Friend.Guest@gmail.test",
        "email_verified": True,
        "name": "Friend Guest",
    },
    "stranger": {"sub": "g-2", "email": "stranger@gmail.test", "email_verified": True, "name": "Stranger"},
    "unverified": {"sub": "g-3", "email": "friend.guest@gmail.test", "email_verified": False, "name": "Fake"},
}


@pytest.fixture
def google() -> FakeIdP:
    return FakeIdP(
        issuer=GOOGLE_ISSUER, client_id=GOOGLE_CLIENT_ID, client_secret="google-secret", has_logout=False
    )


@pytest.fixture
def settings(tmp_path: Any) -> Settings:
    return Settings(
        environment="test",
        public_url=PUBLIC_URL,
        database_url=f"sqlite+aiosqlite:///{tmp_path}/codelens.db",
        oidc_issuer=ISSUER,
        oidc_client_id=CLIENT_ID,
        oidc_client_secret=CLIENT_SECRET,
        google_client_id=GOOGLE_CLIENT_ID,
        google_client_secret="google-secret",
        google_issuer=GOOGLE_ISSUER,
        google_users={"friend.guest@gmail.test": ["analyst"]},
        cookie_secure=True,
        local_secrets_key=base64.b64encode(b"k" * 32).decode(),
        _env_file=None,  # type: ignore[call-arg]
    )


@pytest.fixture
async def app(settings: Settings, idp: FakeIdP, google: FakeIdP) -> AsyncIterator[FastAPI]:
    engine = create_async_engine(settings.database_url.get_secret_value())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    await engine.dispose()

    def route(request: httpx.Request) -> httpx.Response:
        return (google if request.url.host == "accounts.google.test" else idp).handler(request)

    http = httpx.AsyncClient(transport=httpx.MockTransport(route))
    application = create_app(settings, redis=FakeAsyncRedis(), http=http)

    # Run startup and shutdown in one task, as uvicorn does (the MCP session manager's task group requires
    # it; pytest-asyncio would otherwise run fixture setup and teardown in different tasks).
    started, stop = asyncio.Event(), asyncio.Event()

    async def lifespan() -> None:
        async with application.router.lifespan_context(application):
            started.set()
            await stop.wait()

    task = asyncio.create_task(lifespan())
    await asyncio.wait([task, asyncio.create_task(started.wait())], return_when=asyncio.FIRST_COMPLETED)
    if task.done():
        task.result()  # startup failed: raise its error
    # SQLite allows one writer at a time, so the encrypted local store (its own transaction) would
    # deadlock with the request's transaction here; it is tested on its own in test_secrets.py.
    application.state.secrets = MemorySecretStore()
    application.state.engine.secrets = application.state.secrets
    yield application
    stop.set()
    await task
    await http.aclose()


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=PUBLIC_URL) as c:
        yield c


async def sign_in(
    client: httpx.AsyncClient,
    idp: FakeIdP,
    who: str = "analyst",
    *,
    return_to: str = "/ask",
    step_up: bool = False,
    provider: str | None = None,
) -> httpx.Response:
    """Run the whole browser sign-in dance and return the callback response."""
    params = {"returnTo": return_to}
    if step_up:
        params["prompt"] = "login"
    if provider:
        params["provider"] = provider
    start = await client.get("/api/auth/login", params=params)
    assert start.status_code == 303, start.text
    code, state = idp.authorize(start.headers["location"], {**USERS, **GOOGLE_USERS}[who])
    return await client.get("/api/auth/callback", params={"code": code, "state": state})


async def session_of(client: httpx.AsyncClient) -> dict[str, Any]:
    response = await client.get("/api/auth/session")
    assert response.status_code == 200, response.text
    data: dict[str, Any] = response.json()
    return data


def set_cookie_headers(response: httpx.Response) -> list[str]:
    return response.headers.get_list("set-cookie")


def dumps(value: Any) -> str:
    return json.dumps(value)


async def signed_in(client: httpx.AsyncClient, idp: FakeIdP, who: str = "admin") -> httpx.AsyncClient:
    """Sign in and send the CSRF token on every later request, as the frontend does."""
    response = await sign_in(client, idp, who)
    assert response.status_code == 303
    client.headers["X-CSRF-Token"] = (await session_of(client))["csrfToken"]
    return client
