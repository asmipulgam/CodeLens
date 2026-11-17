"""Settings, read from environment variables (prefix CODELENS_) or a .env file.

Production refuses to start with development-only values (see `check_production_safety`).
"""

from __future__ import annotations

from functools import lru_cache
from typing import Literal
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

DEV_CLIENT_SECRET = "dev-only-change-me"  # noqa: S105 - matches the local Keycloak realm, never valid in production


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="CODELENS_", env_file=".env", extra="ignore")

    environment: Literal["development", "test", "production"] = "development"

    # Where people open CodeLens. Redirect and cookie decisions are based on this, never on the Host header.
    public_url: str = "http://localhost:5173"

    database_url: SecretStr = SecretStr("postgresql+psycopg://codelens:codelens@localhost:5433/codelens")
    redis_url: SecretStr = SecretStr("redis://localhost:6379/0")

    # ── Sign-in (any OpenID Connect provider: Keycloak, Entra ID, Okta, Google) ──
    oidc_issuer: str = "http://localhost:8080/realms/codelens"
    oidc_client_id: str = "codelens"
    oidc_client_secret: SecretStr = SecretStr(DEV_CLIENT_SECRET)
    oidc_scopes: str = "openid profile email"
    # Claim that lists the user's groups. Entra ID: "groups" (object IDs) or "roles" (app roles).
    oidc_groups_claim: str = "groups"
    # Identity-provider group -> CodeLens role ids. A user's roles from groups are re-synced at every sign-in.
    group_role_map: dict[str, list[str]] = Field(
        default_factory=lambda: {
            "codelens-business": ["business"],
            "codelens-analysts": ["analyst"],
            "codelens-admins": ["admin"],
            "codelens-auditors": ["auditor"],
        }
    )
    # Roles given to every signed-in employee. Empty = people outside the mapped groups cannot sign in.
    default_roles: list[str] = Field(default_factory=list)

    # ── Optional second sign-in: Google accounts on an explicit allow-list ──
    # Create an OAuth client (Web application) in Google Cloud Console; see README "Sign in with Google".
    google_client_id: str | None = None
    google_client_secret: SecretStr | None = None
    google_issuer: str = "https://accounts.google.com"
    # Only these Google accounts may sign in, each with its CodeLens roles. Anyone else is refused.
    # Example: {"someone@gmail.com": ["business"], "analyst.contractor@gmail.com": ["analyst"]}
    google_users: dict[str, list[str]] = Field(default_factory=dict)

    # ── Answering questions ──
    # "standin" answers common questions without AI (until Azure OpenAI is set up); "azure_openai" uses
    # the company's Azure OpenAI deployment through its managed identity.
    llm_provider: Literal["standin", "azure_openai"] = "standin"
    azure_openai_endpoint: str | None = None  # https://<resource>.openai.azure.com
    azure_openai_deployment: str | None = None
    azure_openai_api_version: str = "2024-10-21"
    # Whether result rows (masked, at most 30) may be sent to the AI to write the summary. False = the
    # summary is written from a template and no result data ever reaches the model.
    ai_shares_result_rows: bool = True
    # Ask the person to confirm before running a query the database expects to read this many rows.
    confirm_rows_threshold: int = 5_000_000
    questions_per_minute: int = 20

    # ── Development only: skip sign-in ──
    # Every visitor is signed in automatically as a local developer with these roles. The app refuses to
    # start in production with this on. Turn it off to get the sign-in page back.
    dev_auto_login: bool = False
    dev_auto_login_roles: list[str] = Field(default_factory=lambda: ["admin", "analyst"])

    # ── Sessions ──
    session_idle_seconds: int = Field(default=15 * 60, ge=60)
    session_absolute_seconds: int = Field(default=8 * 3600, ge=300)
    # Admin changes need a sign-in at most this old; otherwise the API answers 401 step_up_required.
    step_up_max_age_seconds: int = Field(default=30 * 60, ge=60)
    cookie_secure: bool = True

    # ── Where data-source credentials are stored ──
    # azure_key_vault in production. "local" encrypts them into the app database (development only).
    secret_store: Literal["local", "azure_key_vault"] = "local"  # noqa: S105
    local_secrets_key: SecretStr | None = None  # base64 of 32 random bytes
    key_vault_url: str | None = None  # https://<vault-name>.vault.azure.net
    # Purge (not only soft-delete) secrets when a source is deleted. Needs the "purge" permission.
    key_vault_purge_on_delete: bool = False
    # Production refuses data sources on loopback / link-local addresses (protects services next to CodeLens).
    allow_local_source_hosts: bool = True

    # Sign-in attempts per IP per minute (login + callback).
    login_rate_limit_per_minute: int = 30

    @field_validator("public_url", "oidc_issuer")
    @classmethod
    def _strip_trailing_slash(cls, value: str) -> str:
        return value.rstrip("/")

    @field_validator("google_users")
    @classmethod
    def _check_google_users(cls, value: dict[str, list[str]]) -> dict[str, list[str]]:
        clean: dict[str, list[str]] = {}
        for email, roles in value.items():
            if "@" not in email:
                raise ValueError(f"{email!r} is not an email address")
            if "admin" in roles:
                # Google can't be told to force a fresh login (MFA) for admin changes, so admins
                # must use the company sign-in.
                raise ValueError(f"{email}: Google accounts can't have the admin role")
            clean[email.strip().lower()] = list(roles)
        return clean

    @property
    def google_enabled(self) -> bool:
        return bool(self.google_client_id and self.google_client_secret and self.google_users)

    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    @property
    def public_origin(self) -> str:
        parts = urlsplit(self.public_url)
        return f"{parts.scheme}://{parts.netloc}"

    @property
    def session_cookie_name(self) -> str:
        # The __Host- prefix makes browsers reject the cookie unless it is Secure, Path=/ and has no Domain.
        return "__Host-codelens_session" if self.cookie_secure else "codelens_session"

    @property
    def login_cookie_name(self) -> str:
        return "__Host-codelens_login" if self.cookie_secure else "codelens_login"

    @property
    def redirect_uri(self) -> str:
        return f"{self.public_url}/api/auth/callback"

    def check_production_safety(self) -> None:
        """Refuse to start in production with settings that are only acceptable on a laptop."""
        if not self.is_production:
            return
        problems: list[str] = []
        if not self.public_url.startswith("https://"):
            problems.append("CODELENS_PUBLIC_URL must use https")
        if not self.oidc_issuer.startswith("https://"):
            problems.append("CODELENS_OIDC_ISSUER must use https")
        if not self.cookie_secure:
            problems.append("CODELENS_COOKIE_SECURE must be true")
        if self.oidc_client_secret.get_secret_value() in ("", DEV_CLIENT_SECRET):
            problems.append("CODELENS_OIDC_CLIENT_SECRET is missing or is the development value")
        if self.secret_store != "azure_key_vault":  # noqa: S105
            problems.append("CODELENS_SECRET_STORE must be azure_key_vault")
        elif not (self.key_vault_url or "").startswith("https://"):
            problems.append("CODELENS_KEY_VAULT_URL must be set (https://<vault>.vault.azure.net)")
        if self.dev_auto_login:
            problems.append("CODELENS_DEV_AUTO_LOGIN must be false (it skips sign-in)")
        if self.allow_local_source_hosts:
            problems.append("CODELENS_ALLOW_LOCAL_SOURCE_HOSTS must be false")
        if problems:
            raise RuntimeError("Unsafe production configuration: " + "; ".join(problems))


@lru_cache
def get_settings() -> Settings:
    return Settings()
