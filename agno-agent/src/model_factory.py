"""
Agno model factory — maps LLMConfig to the correct Agno model class.
"""
from __future__ import annotations
from src.config import LLMConfig


def make_model(config: LLMConfig):
    provider = config.provider.lower()

    if provider == "anthropic":
        from agno.models.anthropic import Claude
        return Claude(id=config.model_id, api_key=config.api_key)

    if provider == "google":
        from agno.models.google import Gemini
        return Gemini(id=config.model_id, api_key=config.api_key)

    # openai or any openai-compatible provider (deepseek, together, etc.)
    from agno.models.openai import OpenAIChat
    kwargs: dict = {"id": config.model_id, "api_key": config.api_key}
    if config.base_url:
        kwargs["base_url"] = config.base_url
    return OpenAIChat(**kwargs)
