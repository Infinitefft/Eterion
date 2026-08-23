"""Stable inputs and events at the execution boundary."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Literal, Protocol

from pydantic import BaseModel, Field, model_validator

from .events import AgentEvent


class MessageInput(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class RunInput(BaseModel):
    run_id: str = Field(min_length=1)
    thread_id: str = Field(min_length=1)
    model_id: str = Field(min_length=1)
    messages: list[MessageInput] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_last_message(self) -> RunInput:
        if self.messages[-1].role != "user":
            raise ValueError("the last message must be a user message")
        return self


class AgentRuntime(Protocol):
    @property
    def default_model_id(self) -> str: ...

    @property
    def models(self) -> list[dict[str, str]]: ...

    def stream(self, request: RunInput) -> AsyncIterator[AgentEvent]: ...

    async def close(self) -> None: ...
