"""Create provider clients without leaking SDK details into Agent runtime code."""

from __future__ import annotations

from typing import Any

from langchain_openai import ChatOpenAI

from .catalog import ModelConfig


def build_model_clients(
    models: tuple[ModelConfig, ...],
    timeout_seconds: float,
) -> dict[str, Any]:
    return {
        model.id: ChatOpenAI(
            model=model.provider_model,
            api_key=model.api_key,
            base_url=model.base_url or None,
            timeout=timeout_seconds,
            max_retries=2,
        )
        for model in models
    }
