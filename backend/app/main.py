"""CodeLens backend entry point: `uv run uvicorn --factory app.main:create_app`."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI
from redis.asyncio import Redis

from app.api import admin_roles, admin_sources, auth, conversations, me, queries, sources
from app.audit import AuditLog
from app.auth.oidc import OidcClient
from app.auth.roles import ensure_built_in_roles
from app.auth.sessions import SessionStore
from app.config import Settings, get_settings
from app.db import make_engine, make_sessionmaker
from app.errors import install_error_handlers
from app.llm import make_provider
from app.middleware import BodySizeLimitMiddleware, SecurityHeadersMiddleware, StripQueryStringFilter
from app.pipeline.engine import QueryEngine
from app.secrets.store import make_secret_store


def create_app(
    settings: Settings | None = None,
    *,
    redis: Redis | None = None,
    http: httpx.AsyncClient | None = None,
) -> FastAPI:
    """Build the app. Tests pass in their own Redis and HTTP client (for a fake identity provider)."""
    settings = settings or get_settings()
    settings.check_production_safety()
    logging.getLogger("uvicorn.access").addFilter(StripQueryStringFilter())

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        engine = make_engine(settings.database_url.get_secret_value())
        sessionmaker = make_sessionmaker(engine)
        redis_client = redis or Redis.from_url(settings.redis_url.get_secret_value())
        http_client = http or httpx.AsyncClient(timeout=10.0, follow_redirects=False)

        async with sessionmaker() as db, db.begin():
            await ensure_built_in_roles(db)

        app.state.settings = settings
        app.state.sessionmaker = sessionmaker
        app.state.audit = AuditLog(sessionmaker)
        app.state.secrets = make_secret_store(settings, sessionmaker)
        app.state.sessions = SessionStore(
            redis_client, settings.session_idle_seconds, settings.session_absolute_seconds
        )
        company = OidcClient(
            issuer=settings.oidc_issuer,
            client_id=settings.oidc_client_id,
            client_secret=settings.oidc_client_secret.get_secret_value(),
            redirect_uri=settings.redirect_uri,
            scopes=settings.oidc_scopes,
            groups_claim=settings.oidc_groups_claim,
            http=http_client,
        )
        app.state.oidc_providers = {"company": company}
        if settings.google_enabled and settings.google_client_id and settings.google_client_secret:
            app.state.oidc_providers["google"] = OidcClient(
                provider_id="google",
                label="Google",
                issuer=settings.google_issuer,
                extra_issuers=("accounts.google.com",),
                client_id=settings.google_client_id,
                client_secret=settings.google_client_secret.get_secret_value(),
                redirect_uri=settings.redirect_uri,
                scopes="openid email profile",
                groups_claim="groups",  # unused: Google accounts get roles from CODELENS_GOOGLE_USERS
                http=http_client,
                supports_step_up=False,
                require_verified_email=True,
            )
        app.state.provider = make_provider(settings, redis_client)
        app.state.engine = QueryEngine(
            settings=settings,
            sessionmaker=sessionmaker,
            secrets=app.state.secrets,
            redis=redis_client,
            provider=app.state.provider,
            audit=app.state.audit,
        )
        try:
            yield
        finally:
            await app.state.provider.close()
            await app.state.secrets.close()
            if http is None:
                await http_client.aclose()
            if redis is None:
                await redis_client.aclose()
            await engine.dispose()

    app = FastAPI(
        title="CodeLens API",
        lifespan=lifespan,
        # Interactive API docs only outside production.
        docs_url=None if settings.is_production else "/api/docs",
        redoc_url=None,
        openapi_url=None if settings.is_production else "/api/openapi.json",
    )
    install_error_handlers(app)
    app.add_middleware(SecurityHeadersMiddleware, hsts=settings.public_url.startswith("https://"))
    app.add_middleware(BodySizeLimitMiddleware)

    @app.get("/api/health", include_in_schema=False)
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    app.include_router(auth.router)
    app.include_router(me.router)
    app.include_router(sources.router)
    app.include_router(admin_sources.router)
    app.include_router(admin_roles.router)
    app.include_router(queries.router)
    app.include_router(conversations.router)
    return app
