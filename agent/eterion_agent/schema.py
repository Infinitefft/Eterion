"""Request and stream event schemas shared with the Go adapter."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator


class MessageInput(BaseModel):
    role: Literal["system", "user", "assistant"]
    content: str


class RunInput(BaseModel):
    run_id: str = Field(min_length=1)
    chat_id: str = Field(min_length=1)
    model_id: str = Field(min_length=1)
    messages: list[MessageInput] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_last_message(self) -> RunInput:
        if self.messages[-1].role != "user":
            raise ValueError("the last message must be a user message")
        return self


@dataclass(frozen=True, slots=True)
class AgentEvent:
    name: str
    data: dict[str, Any]


def failure(code: str, message: str, retryable: bool) -> AgentEvent:
    return AgentEvent(
        "error",
        {"error": {"code": code, "message": message, "retryable": retryable}},
    )
