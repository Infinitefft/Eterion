"""Baseline direct-to-model runtime used before graph orchestration is enabled."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
import logging
from typing import Any

from eterion_agent.config import Settings
from eterion_agent.models.factory import build_model_clients
from eterion_agent.models.streaming import extract_content_delta

from .contracts import RunInput
from .events import AgentEvent, JsonValue, failure


logger = logging.getLogger(__name__)


class DirectModelRuntime:
    """Stream plain model content while preserving the future runtime seam."""

    def __init__(self, settings: Settings, models: dict[str, Any]) -> None:
        self._settings = settings
        self._models = models

    @classmethod
    async def create(cls, settings: Settings) -> DirectModelRuntime:
        return cls(
            settings,
            build_model_clients(settings.models, settings.model_timeout_seconds),
        )

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
            yield failure(
                request.run_id,
                "MODEL_NOT_AVAILABLE",
                "所选模型不可用",
                False,
            )
            return

        yield AgentEvent("run.started", request.run_id, {"modelId": request.model_id})
        yield AgentEvent("content.started", request.run_id, {"format": "markdown"})
        text_parts: list[str] = []
        messages = [{"role": "system", "content": self._settings.system_prompt}]
        messages.extend(
            {"role": message.role, "content": message.content}
            for message in request.messages
        )

        try:
            async with asyncio.timeout(self._settings.run_timeout_seconds):
                async for chunk in model.astream(messages):
                    text = extract_content_delta(chunk)
                    if not text:
                        continue
                    text_parts.append(text)
                    yield AgentEvent("content.delta", request.run_id, {"delta": text})
        except TimeoutError:
            logger.warning("model request timed out", extra={"run_id": request.run_id})
            error: dict[str, JsonValue] = {
                "code": "MODEL_REQUEST_FAILED",
                "message": "模型调用超时",
                "retryable": True,
            }
            yield AgentEvent(
                "content.completed",
                request.run_id,
                _failed_content_payload(text_parts, error),
            )
            yield failure(request.run_id, "MODEL_REQUEST_FAILED", "模型调用超时", True)
            return
        except Exception:
            logger.exception("model request failed", extra={"run_id": request.run_id})
            error = {
                "code": "MODEL_REQUEST_FAILED",
                "message": "模型调用失败",
                "retryable": True,
            }
            yield AgentEvent(
                "content.completed",
                request.run_id,
                _failed_content_payload(text_parts, error),
            )
            yield failure(request.run_id, "MODEL_REQUEST_FAILED", "模型调用失败", True)
            return

        full_text = "".join(text_parts)
        if not full_text.strip():
            error = {
                "code": "AGENT_EMPTY_RESPONSE",
                "message": "模型没有返回有效文本",
                "retryable": False,
            }
            yield AgentEvent(
                "content.completed",
                request.run_id,
                _failed_content_payload(text_parts, error),
            )
            yield failure(
                request.run_id,
                "AGENT_EMPTY_RESPONSE",
                "模型没有返回有效文本",
                False,
            )
            return
        yield AgentEvent(
            "content.completed",
            request.run_id,
            {
                "content": full_text,
                "format": "markdown",
                "status": "completed",
                "error": None,
            },
        )
        yield AgentEvent("run.completed", request.run_id, {})


def _failed_content_payload(
    text_parts: list[str],
    error: dict[str, JsonValue],
) -> dict[str, JsonValue]:
    return {
        "content": "".join(text_parts),
        "format": "markdown",
        "status": "failed",
        "error": error,
    }
