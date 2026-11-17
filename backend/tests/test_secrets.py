from __future__ import annotations

import base64
from typing import Any

import pytest
from cryptography.exceptions import InvalidTag
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine

from app.config import Settings
from app.db import Base, make_sessionmaker
from app.models import LocalSecret
from app.secrets.store import LocalSecretStore, make_secret_store, secret_name

KEY = base64.b64encode(b"k" * 32).decode()


@pytest.fixture
async def store(tmp_path: Any) -> Any:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/s.db")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield LocalSecretStore(make_sessionmaker(engine), KEY), make_sessionmaker(engine)
    await engine.dispose()


async def test_round_trip_and_encryption(store: Any) -> None:
    secrets, sessionmaker = store
    await secrets.put("abc123", "password", "hunter2-very-secret")
    assert await secrets.get("abc123", "password") == "hunter2-very-secret"
    async with sessionmaker() as db:
        row = await db.scalar(select(LocalSecret))
    assert row.name == "codelens-abc123-password"
    assert b"hunter2" not in row.ciphertext

    await secrets.put("abc123", "password", "rotated")
    assert await secrets.get("abc123", "password") == "rotated"
    await secrets.delete("abc123", ["password"])
    assert await secrets.get("abc123", "password") is None


async def test_ciphertext_cannot_be_moved_to_another_secret(store: Any) -> None:
    secrets, sessionmaker = store
    await secrets.put("aaa", "password", "for-source-a")
    await secrets.put("bbb", "password", "for-source-b")
    async with sessionmaker() as db, db.begin():
        a = await db.get(LocalSecret, "codelens-aaa-password")
        b = await db.get(LocalSecret, "codelens-bbb-password")
        b.nonce, b.ciphertext = a.nonce, a.ciphertext
    with pytest.raises(InvalidTag):
        await secrets.get("bbb", "password")


async def test_wrong_key_cannot_decrypt(store: Any) -> None:
    secrets, sessionmaker = store
    await secrets.put("abc", "password", "x")
    other = LocalSecretStore(sessionmaker, base64.b64encode(b"z" * 32).decode())
    with pytest.raises(InvalidTag):
        await other.get("abc", "password")


def test_secret_names_are_safe() -> None:
    assert secret_name("a1b2", "privateKeyPassphrase") == "codelens-a1b2-privateKeyPassphrase"
    for bad in ("../x", "a-b", "a b", ""):
        with pytest.raises(ValueError):
            secret_name(bad, "password")


def test_local_store_needs_a_key() -> None:
    with pytest.raises(RuntimeError, match="LOCAL_SECRETS_KEY"):
        make_secret_store(Settings(_env_file=None), None)  # type: ignore[arg-type,call-arg]
    with pytest.raises(ValueError, match="32 bytes"):
        LocalSecretStore(None, base64.b64encode(b"short").decode())  # type: ignore[arg-type]
