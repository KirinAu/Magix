from __future__ import annotations
from pydantic import BaseModel


class LLMConfig(BaseModel):
    provider: str
    model_id: str
    api_key: str
    base_url: str | None = None
    strip_thinking: bool = False


class HistoryMessage(BaseModel):
    role: str   # "user" | "assistant" | "tool"
    content: str


class RunRequest(BaseModel):
    config: LLMConfig
    message: str
    current_code: str = ""
    current_library: str = "gsap"
    history: list[HistoryMessage] = []
    images: list[dict] = []
