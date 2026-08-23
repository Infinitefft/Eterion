"""Normalized events emitted by every Agent runtime.

These events describe Agent execution rather than a transport envelope. The Go
adapter can add thread sequence numbers, timestamps, and message identifiers
without knowing anything about LangChain, DeepAgents, or provider chunks.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, TypeAlias


JsonValue: TypeAlias = (
    str | int | float | bool | None | list["JsonValue"] | dict[str, "JsonValue"]
)

AgentEventType: TypeAlias = Literal[
    "run.started",
    "run.completed",
    "run.failed",
    "thinking.delta",
    "thinking.completed",
    "content.started",
    "content.delta",
    "content.completed",
    "tool.started",
    "tool.completed",
    "tool.failed",
]


@dataclass(frozen=True, slots=True)
class AgentEvent:
    type: AgentEventType
    run_id: str
    payload: dict[str, JsonValue]


def failure(run_id: str, code: str, message: str, retryable: bool) -> AgentEvent:
    return AgentEvent(
        "run.failed",
        run_id,
        {
            "error": {
                "code": code,
                "message": message,
                "retryable": retryable,
            }
        },
    )
