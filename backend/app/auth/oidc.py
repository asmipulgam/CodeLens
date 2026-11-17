"""Minimal OpenID Connect client: Authorization Code flow with PKCE (S256), nonce, and ID-token checks.

Kept deliberately small so every security check is visible here rather than inside a framework.
Tokens never reach the browser; only the ID token is kept (server-side) as a logout hint.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import time
from dataclasses import dataclass, replace
from typing import Any
from urllib.parse import urlencode

import httpx
from joserfc import jwt
from joserfc.errors import JoseError
from joserfc.jwk import KeySet

ALLOWED_ALGORITHMS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384"]
DISCOVERY_TTL_SECONDS = 3600
JWKS_MIN_REFRESH_SECONDS = 60
CLOCK_LEEWAY_SECONDS = 60


class OidcError(Exception):
    """Sign-in failed. The message is for server logs only; users see a generic message."""


@dataclass(frozen=True)
class Identity:
    issuer: str
    subject: str
    email: str
    name: str
    groups: list[str]
    auth_time: float
    id_token: str


def pkce_pair() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


class OidcClient:
    def __init__(
        self,
        *,
        issuer: str,
        client_id: str,
        client_secret: str,
        redirect_uri: str,
        scopes: str,
        groups_claim: str,
        http: httpx.AsyncClient,
        provider_id: str = "company",
        label: str = "your company account",
        extra_issuers: tuple[str, ...] = (),
        supports_step_up: bool = True,
        require_verified_email: bool = False,
    ) -> None:
        self.provider_id = provider_id
        self.label = label
        # Google signs some tokens with iss "accounts.google.com" (no scheme); both are genuine.
        self.accepted_issuers = (issuer, *extra_issuers)
        # Providers that can't be forced to re-authenticate (e.g. Google) can't do step-up.
        self.supports_step_up = supports_step_up
        self.require_verified_email = require_verified_email
        self.issuer = issuer
        self.client_id = client_id
        self._client_secret = client_secret
        self.redirect_uri = redirect_uri
        self.scopes = scopes
        self.groups_claim = groups_claim
        self._http = http
        self._metadata: dict[str, Any] | None = None
        self._metadata_at = 0.0
        self._jwks: KeySet | None = None
        self._jwks_at = 0.0

    # ── provider metadata ──

    async def metadata(self) -> dict[str, Any]:
        if self._metadata is None or time.time() - self._metadata_at > DISCOVERY_TTL_SECONDS:
            response = await self._http.get(f"{self.issuer}/.well-known/openid-configuration")
            response.raise_for_status()
            data = response.json()
            if data.get("issuer") != self.issuer:
                raise OidcError("Discovery document issuer does not match the configured issuer")
            for name in ("authorization_endpoint", "token_endpoint", "jwks_uri"):
                if not isinstance(data.get(name), str):
                    raise OidcError(f"Discovery document is missing {name}")
            self._metadata, self._metadata_at = data, time.time()
        return self._metadata

    async def _keyset(self, *, force: bool = False) -> KeySet:
        stale = time.time() - self._jwks_at > DISCOVERY_TTL_SECONDS
        may_refresh = time.time() - self._jwks_at > JWKS_MIN_REFRESH_SECONDS
        if self._jwks is None or stale or (force and may_refresh):
            response = await self._http.get((await self.metadata())["jwks_uri"])
            response.raise_for_status()
            self._jwks, self._jwks_at = KeySet.import_key_set(response.json()), time.time()
        return self._jwks

    # ── the flow ──

    async def authorization_url(self, *, state: str, nonce: str, code_challenge: str, step_up: bool) -> str:
        params = {
            "response_type": "code",
            "client_id": self.client_id,
            "redirect_uri": self.redirect_uri,
            "scope": self.scopes,
            "state": state,
            "nonce": nonce,
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
        }
        if step_up:
            # Force a fresh login (and MFA) even if the identity provider still has a session.
            params["prompt"] = "login"
            params["max_age"] = "0"
        return f"{(await self.metadata())['authorization_endpoint']}?{urlencode(params)}"

    async def exchange_code(
        self, *, code: str, code_verifier: str, nonce: str, step_up_since: float | None
    ) -> Identity:
        metadata = await self.metadata()
        response = await self._http.post(
            metadata["token_endpoint"],
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": self.redirect_uri,
                "code_verifier": code_verifier,
            },
            auth=(self.client_id, self._client_secret),
            headers={"Accept": "application/json"},
        )
        if response.status_code != 200:
            raise OidcError(f"Token endpoint returned {response.status_code}")
        id_token = response.json().get("id_token")
        if not isinstance(id_token, str):
            raise OidcError("Token response has no id_token")
        claims = await self._validate_id_token(id_token, nonce)

        auth_time = float(claims.get("auth_time") or claims["iat"])
        if step_up_since is not None and auth_time < step_up_since - CLOCK_LEEWAY_SECONDS:
            raise OidcError("Step-up sign-in did not re-authenticate the user")

        if self.require_verified_email and claims.get("email_verified") is not True:
            raise OidcError("The provider has not verified this account's email address")
        return replace(self.identity_from_claims(claims), auth_time=auth_time, id_token=id_token)

    async def _validate_id_token(self, id_token: str, nonce: str) -> dict[str, Any]:
        try:
            try:
                token = jwt.decode(id_token, await self._keyset(), algorithms=ALLOWED_ALGORITHMS)
            except JoseError:
                # The provider may have rotated its signing keys; refetch once and retry.
                token = jwt.decode(id_token, await self._keyset(force=True), algorithms=ALLOWED_ALGORITHMS)
            registry = jwt.JWTClaimsRegistry(
                leeway=CLOCK_LEEWAY_SECONDS,
                iss={"essential": True, "values": list(self.accepted_issuers)},
                sub={"essential": True},
                exp={"essential": True},
                iat={"essential": True},
            )
            registry.validate(token.claims)
        except JoseError as exc:
            raise OidcError(f"ID token rejected: {exc.__class__.__name__}") from exc

        claims = token.claims
        audience = claims.get("aud")
        audiences = audience if isinstance(audience, list) else [audience]
        if self.client_id not in audiences:
            raise OidcError("ID token audience does not include this client")
        if len(audiences) > 1 and claims.get("azp") != self.client_id:
            raise OidcError("ID token azp does not match this client")
        if not hmac.compare_digest(str(claims.get("nonce", "")), nonce):
            raise OidcError("ID token nonce mismatch")
        return claims

    async def validate_access_token(self, token: str, audience: str) -> dict[str, Any]:
        """Check an OAuth access token (a JWT) that this provider issued for `audience`.

        Used by the MCP endpoint, where AI assistants send `Authorization: Bearer <token>`. The audience
        check is what stops a token issued for any other app (including our own web sign-in, whose
        tokens are for the client id) from being replayed here.
        """
        try:
            try:
                decoded = jwt.decode(token, await self._keyset(), algorithms=ALLOWED_ALGORITHMS)
            except JoseError:
                decoded = jwt.decode(token, await self._keyset(force=True), algorithms=ALLOWED_ALGORITHMS)
            jwt.JWTClaimsRegistry(
                leeway=CLOCK_LEEWAY_SECONDS,
                iss={"essential": True, "value": self.issuer},
                sub={"essential": True},
                exp={"essential": True},
            ).validate(decoded.claims)
        except (JoseError, ValueError) as exc:
            raise OidcError(f"Access token rejected: {exc.__class__.__name__}") from exc

        claims = decoded.claims
        audiences = claims.get("aud")
        if audience not in (audiences if isinstance(audiences, list) else [audiences]):
            raise OidcError("Access token was not issued for CodeLens")
        # Keycloak labels its tokens; refuse ID and refresh tokens even if they somehow carry our audience.
        kind = str(claims.get("typ", "Bearer")).lower()
        if kind not in ("bearer", "at+jwt"):
            raise OidcError("Not an access token")
        return claims

    def identity_from_claims(self, claims: dict[str, Any]) -> Identity:
        email = claims.get("email") or claims.get("preferred_username") or claims.get("upn") or ""
        name = claims.get("name") or " ".join(
            part for part in (claims.get("given_name"), claims.get("family_name")) if part
        )
        groups = claims.get(self.groups_claim) or []
        if isinstance(groups, str):
            groups = [groups]
        return Identity(
            issuer=self.issuer,
            subject=str(claims["sub"]),
            email=str(email),
            name=str(name or email or "Unknown user"),
            groups=[str(group) for group in groups if isinstance(group, str | int)],
            auth_time=float(claims.get("auth_time") or claims.get("iat") or time.time()),
            id_token="",
        )

    async def end_session_url(self, *, id_token_hint: str, post_logout_redirect_uri: str) -> str | None:
        try:
            endpoint = (await self.metadata()).get("end_session_endpoint")
        except (httpx.HTTPError, OidcError):
            return None
        if not isinstance(endpoint, str):
            return None
        params = {
            "id_token_hint": id_token_hint,
            "post_logout_redirect_uri": post_logout_redirect_uri,
            "client_id": self.client_id,
        }
        return f"{endpoint}?{urlencode(params)}"
