"""Direct LangChain model streaming for the Agent service."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
import logging
from typing import Any, Protocol

from langchain_openai import ChatOpenAI

from .config import Settings
from .schema import AgentEvent, RunInput, failure


logger = logging.getLogger(__name__)


class AgentRuntime(Protocol):
    @property
    def default_model_id(self) -> str: ...

    @property
    def models(self) -> list[dict[str, str]]: ...

    def stream(self, request: RunInput) -> AsyncIterator[AgentEvent]: ...

    async def close(self) -> None: ...


class ModelRuntime:
    def __init__(self, settings: Settings, models: dict[str, Any]) -> None:
        self._settings = settings
        self._models = models

    @classmethod
    async def create(cls, settings: Settings) -> ModelRuntime:
        models: dict[str, Any] = {}
        for model_config in settings.models:
            models[model_config.id] = ChatOpenAI(
                model=model_config.provider_model,
                api_key=model_config.api_key,
                base_url=model_config.base_url or None,
                timeout=settings.model_timeout_seconds,
                max_retries=2,
            )
        return cls(settings, models)

    @property
    def default_model_id(self) -> str:
        return self._settings.default_model_id

    @property
    def models(self) -> list[dict[str, str]]:
        return [model.public_dict() for model in self._settings.models]

    async def close(self) -> None:
        return None

    async def stream(self, request: RunInput) -> AsyncIterator[AgentEvent]:
        model = self._models.get(request.model_id)
        if model is None:
            yield failure("MODEL_NOT_AVAILABLE", "所选模型不可用", False)
            return

        yield AgentEvent("started", {"model": request.model_id})
        text_parts: list[str] = []
        messages = [{"role": "system", "content": self._settings.system_prompt}]
        messages.extend(
            {"role": message.role, "content": message.content}
            for message in request.messages
        )

        try:
            async with asyncio.timeout(self._settings.run_timeout_seconds):
                async for chunk in model.astream(messages):
                    text = _chunk_text(chunk)
                    if not text:
                        continue
                    text_parts.append(text)
                    yield AgentEvent("content_delta", {"delta": text})
        except TimeoutError:
            logger.warning("model request timed out", extra={"run_id": request.run_id})
            yield failure("MODEL_REQUEST_FAILED", "模型调用超时", True)
            return
        except Exception:
            logger.exception("model request failed", extra={"run_id": request.run_id})
            yield failure("MODEL_REQUEST_FAILED", "模型调用失败", True)
            return

        full_text = "".join(text_parts)
        if not full_text.strip():
            yield failure("AGENT_EMPTY_RESPONSE", "模型没有返回有效文本", False)
            return
        yield AgentEvent("completed", {"full_text": full_text})


def _chunk_text(chunk: Any) -> str:
    text = getattr(chunk, "text", None)
    if isinstance(text, str) and text:
        return text
    content = getattr(chunk, "content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            str(block.get("text", ""))
            for block in content
            if isinstance(block, dict) and block.get("type") in {"text", "output_text"}
        )
    return ""
