"""LangChain's LLM cache, stored in Redis, so repeated identical model calls skip Azure entirely.

The cache key is LangChain's: the full prompt plus the model settings. The prompt contains only the
data sources the asking user may use, so two people with different access never share an entry.
"""

from __future__ import annotations

import hashlib
import warnings
from collections.abc import Sequence
from typing import Any

from langchain_core._api.beta_decorator import LangChainBetaWarning
from langchain_core.caches import RETURN_VAL_TYPE, BaseCache
from langchain_core.load import Serializable, dumps, loads
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, Generation
from redis.asyncio import Redis

PREFIX = "codelens:llm-cache:"
ALLOWED_TYPES: list[type[Serializable]] = [Generation, ChatGeneration, AIMessage]


class RedisLlmCache(BaseCache):
    def __init__(self, redis: Redis, ttl_seconds: int = 24 * 3600) -> None:
        self._redis = redis
        self._ttl = ttl_seconds

    @staticmethod
    def _key(prompt: str, llm_string: str) -> str:
        return PREFIX + hashlib.sha256(f"{llm_string}\x00{prompt}".encode()).hexdigest()

    # The pipeline only calls models asynchronously; the sync API is a no-op cache.
    def lookup(self, prompt: str, llm_string: str) -> RETURN_VAL_TYPE | None:
        return None

    def update(self, prompt: str, llm_string: str, return_val: RETURN_VAL_TYPE) -> None:
        return None

    def clear(self, **kwargs: Any) -> None:
        return None

    async def alookup(self, prompt: str, llm_string: str) -> RETURN_VAL_TYPE | None:
        raw = await self._redis.get(self._key(prompt, llm_string))
        if raw is None:
            return None
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", LangChainBetaWarning)
            # Only rebuild the plain result types this cache stores; never models, prompts or clients.
            generations: Sequence[Any] = loads(
                raw.decode() if isinstance(raw, bytes) else raw, allowed_objects=ALLOWED_TYPES
            )
        return list(generations)

    async def aupdate(self, prompt: str, llm_string: str, return_val: RETURN_VAL_TYPE) -> None:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", LangChainBetaWarning)
            value = dumps(list(return_val))
        await self._redis.set(self._key(prompt, llm_string), value, ex=self._ttl)

    async def aclear(self, **kwargs: Any) -> None:
        async for key in self._redis.scan_iter(match=PREFIX + "*", count=500):
            await self._redis.delete(key)
