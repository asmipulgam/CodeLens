"""Where data-source credentials live. They are write-only from the API's point of view: the API can
store, use and delete them, but no endpoint ever returns one.

- `AzureKeyVaultSecretStore` — production. Authenticates with the backend's managed identity
  (DefaultAzureCredential), so there is no key or password in configuration.
- `LocalSecretStore` — development only: AES-256-GCM ciphertext in the app database.
"""

from __future__ import annotations

import base64
import os
import re
from typing import Protocol

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import Settings
from app.models import LocalSecret

_NAME_PART = re.compile(r"^[A-Za-z0-9]+$")


def secret_name(namespace: str, key: str) -> str:
    """Key Vault names allow only letters, digits and dashes. The namespace is random per source,
    so names never reveal which database a secret belongs to, and a deleted source's soft-deleted
    secrets can't collide with a new source of the same name."""
    if not _NAME_PART.match(namespace) or not _NAME_PART.match(key):
        raise ValueError("Invalid secret name part")
    return f"codelens-{namespace}-{key}"


class SecretStore(Protocol):
    async def put(self, namespace: str, key: str, value: str) -> None: ...
    async def get(self, namespace: str, key: str) -> str | None: ...
    async def delete(self, namespace: str, keys: list[str]) -> None: ...
    async def close(self) -> None: ...


class LocalSecretStore:
    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession], key_b64: str) -> None:
        key = base64.b64decode(key_b64)
        if len(key) != 32:
            raise ValueError("CODELENS_LOCAL_SECRETS_KEY must be base64 of exactly 32 bytes")
        self._aead = AESGCM(key)
        self._sessionmaker = sessionmaker

    async def put(self, namespace: str, key: str, value: str) -> None:
        name = secret_name(namespace, key)
        nonce = os.urandom(12)
        # The name is authenticated data, so a ciphertext can't be swapped onto another secret.
        ciphertext = self._aead.encrypt(nonce, value.encode(), name.encode())
        async with self._sessionmaker() as db, db.begin():
            row = await db.get(LocalSecret, name)
            if row is None:
                db.add(LocalSecret(name=name, nonce=nonce, ciphertext=ciphertext))
            else:
                row.nonce, row.ciphertext = nonce, ciphertext

    async def get(self, namespace: str, key: str) -> str | None:
        name = secret_name(namespace, key)
        async with self._sessionmaker() as db:
            row = await db.get(LocalSecret, name)
        if row is None:
            return None
        return self._aead.decrypt(row.nonce, row.ciphertext, name.encode()).decode()

    async def delete(self, namespace: str, keys: list[str]) -> None:
        names = [secret_name(namespace, key) for key in keys]
        if names:
            async with self._sessionmaker() as db, db.begin():
                await db.execute(delete(LocalSecret).where(LocalSecret.name.in_(names)))

    async def close(self) -> None:
        return None


class AzureKeyVaultSecretStore:
    def __init__(self, vault_url: str, *, purge_on_delete: bool) -> None:
        # Imported here so development and tests don't need Azure libraries initialised.
        from azure.identity.aio import DefaultAzureCredential
        from azure.keyvault.secrets.aio import SecretClient

        self._credential = DefaultAzureCredential(exclude_interactive_browser_credential=True)
        self._client = SecretClient(vault_url=vault_url, credential=self._credential)
        self._purge = purge_on_delete

    async def put(self, namespace: str, key: str, value: str) -> None:
        await self._client.set_secret(
            secret_name(namespace, key), value, content_type="text/plain", tags={"app": "codelens"}
        )

    async def get(self, namespace: str, key: str) -> str | None:
        from azure.core.exceptions import ResourceNotFoundError

        try:
            secret = await self._client.get_secret(secret_name(namespace, key))
        except ResourceNotFoundError:
            return None
        return secret.value

    async def delete(self, namespace: str, keys: list[str]) -> None:
        from azure.core.exceptions import ResourceNotFoundError

        for key in keys:
            name = secret_name(namespace, key)
            try:
                await self._client.delete_secret(name)
            except ResourceNotFoundError:
                continue
            if self._purge:
                await self._client.purge_deleted_secret(name)

    async def close(self) -> None:
        await self._client.close()
        await self._credential.close()


def make_secret_store(settings: Settings, sessionmaker: async_sessionmaker[AsyncSession]) -> SecretStore:
    if settings.secret_store == "azure_key_vault":  # noqa: S105
        if not settings.key_vault_url:
            raise RuntimeError(
                "CODELENS_KEY_VAULT_URL is required when CODELENS_SECRET_STORE=azure_key_vault"
            )
        return AzureKeyVaultSecretStore(
            settings.key_vault_url, purge_on_delete=settings.key_vault_purge_on_delete
        )
    if settings.local_secrets_key is None:
        raise RuntimeError(
            "CODELENS_LOCAL_SECRETS_KEY is required for the local secret store. Generate one with: "
            'python -c "import os,base64;print(base64.b64encode(os.urandom(32)).decode())"'
        )
    return LocalSecretStore(sessionmaker, settings.local_secrets_key.get_secret_value())
