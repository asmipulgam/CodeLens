from __future__ import annotations

from redis.asyncio import Redis

from app.config import Settings
from app.llm.base import LlmProvider


def make_provider(settings: Settings, redis: Redis) -> LlmProvider:
    if settings.llm_provider == "azure_openai":
        from app.llm.azure import AzureOpenAIProvider
        from app.llm.cache import RedisLlmCache

        if not (settings.azure_openai_endpoint and settings.azure_openai_deployment):
            raise RuntimeError(
                "CODELENS_AZURE_OPENAI_ENDPOINT and CODELENS_AZURE_OPENAI_DEPLOYMENT are required "
                "when CODELENS_LLM_PROVIDER=azure_openai"
            )
        return AzureOpenAIProvider.from_settings(
            settings.azure_openai_endpoint,
            settings.azure_openai_deployment,
            settings.azure_openai_api_version,
            RedisLlmCache(redis),
        )
    from app.llm.standin import StandInProvider

    return StandInProvider()
