"""Server-side sessions in Redis. The browser only ever holds an opaque random id in an HttpOnly cookie.

Redis keys use a SHA-256 of the id, so someone who can read Redis still can't replay a cookie.
"""

from __future__ import annotations

import hashlib
import json
import secrets
import time
from dataclasses import asdict, dataclass

from redis.asyncio import Redis

SESSION_PREFIX = "codelens:session:"
USER_SESSIONS_PREFIX = "codelens:user-sessions:"
LOGIN_PREFIX = "codelens:login:"
LOGIN_TTL_SECONDS = 600


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


@dataclass
class SessionData:
    user_id: str
    csrf_token: str
    created_at: float
    last_seen_at: float
    absolute_expires_at: float
    auth_time: float  # when the person last actually authenticated at the identity provider
    id_token_hint: str  # used only to end the identity-provider session on logout
    provider: str = "company"  # which sign-in was used (company or google)


@dataclass
class LoginTransaction:
    state: str
    nonce: str
    code_verifier: str
    return_to: str
    binding_digest: str  # ties the transaction to the browser that started it
    step_up: bool
    created_at: float
    provider: str = "company"


class SessionStore:
    def __init__(self, redis: Redis, idle_seconds: int, absolute_seconds: int) -> None:
        self.redis = redis
        self.idle_seconds = idle_seconds
        self.absolute_seconds = absolute_seconds

    # ── sessions ──

    async def create(
        self, user_id: str, auth_time: float, id_token_hint: str, provider: str = "company"
    ) -> tuple[str, SessionData]:
        now = time.time()
        session_id = secrets.token_urlsafe(32)
        data = SessionData(
            user_id=user_id,
            csrf_token=secrets.token_urlsafe(32),
            created_at=now,
            last_seen_at=now,
            absolute_expires_at=now + self.absolute_seconds,
            auth_time=auth_time,
            id_token_hint=id_token_hint,
            provider=provider,
        )
        key = SESSION_PREFIX + _digest(session_id)
        async with self.redis.pipeline(transaction=True) as pipe:
            pipe.set(key, json.dumps(asdict(data)), ex=self.idle_seconds)
            pipe.sadd(USER_SESSIONS_PREFIX + user_id, _digest(session_id))
            pipe.expire(USER_SESSIONS_PREFIX + user_id, self.absolute_seconds)
            await pipe.execute()
        return session_id, data

    async def load(self, session_id: str, *, touch: bool = True) -> SessionData | None:
        """Return the session if it is still within both the idle and the absolute limit."""
        if not session_id or len(session_id) > 128:
            return None
        key = SESSION_PREFIX + _digest(session_id)
        raw = await self.redis.get(key)
        if raw is None:
            return None
        data = SessionData(**json.loads(raw))
        now = time.time()
        if now >= data.absolute_expires_at or now - data.last_seen_at >= self.idle_seconds:
            await self.destroy(session_id, data.user_id)
            return None
        if touch:
            data.last_seen_at = now
            ttl = int(min(self.idle_seconds, data.absolute_expires_at - now)) + 1
            await self.redis.set(key, json.dumps(asdict(data)), ex=ttl)
        return data

    async def destroy(self, session_id: str, user_id: str | None = None) -> None:
        digest = _digest(session_id)
        await self.redis.delete(SESSION_PREFIX + digest)
        if user_id:
            await self.redis.srem(USER_SESSIONS_PREFIX + user_id, digest)

    async def destroy_all_for_user(self, user_id: str) -> None:
        """Sign a user out everywhere (e.g. when an admin disables them)."""
        members = await self.redis.smembers(USER_SESSIONS_PREFIX + user_id)
        keys = [SESSION_PREFIX + (m.decode() if isinstance(m, bytes) else m) for m in members]
        if keys:
            await self.redis.delete(*keys)
        await self.redis.delete(USER_SESSIONS_PREFIX + user_id)

    # ── sign-in transactions (state, nonce, PKCE verifier) ──

    async def save_login(self, txn: LoginTransaction) -> None:
        await self.redis.set(LOGIN_PREFIX + _digest(txn.state), json.dumps(asdict(txn)), ex=LOGIN_TTL_SECONDS)

    async def take_login(self, state: str) -> LoginTransaction | None:
        """Fetch and delete in one step, so a callback URL can never be used twice."""
        if not state or len(state) > 128:
            return None
        raw = await self.redis.getdel(LOGIN_PREFIX + _digest(state))
        return LoginTransaction(**json.loads(raw)) if raw else None

    # ── simple fixed-window rate limit ──

    async def hit_rate_limit(self, bucket: str, limit: int, window_seconds: int = 60) -> bool:
        """Count one attempt; return True if the caller is over the limit."""
        key = f"codelens:ratelimit:{bucket}:{int(time.time() // window_seconds)}"
        async with self.redis.pipeline(transaction=True) as pipe:
            pipe.incr(key)
            pipe.expire(key, window_seconds + 1)
            count, _ = await pipe.execute()
        return int(count) > limit


def binding_digest(binding: str) -> str:
    return _digest(binding)
