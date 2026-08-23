"""Explicit model capability metadata.

OpenAI-compatible endpoints share a request shape, but reasoning and tool-call
streams still vary by provider. Unknown capabilities stay disabled until they
are covered by a provider contract test.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


class CapabilityStatus(StrEnum):
    VERIFIED = "verified"
    UNKNOWN = "unknown"
    UNSUPPORTED = "unsupported"


@dataclass(frozen=True, slots=True)
class ModelCapabilities:
    text_streaming: CapabilityStatus = CapabilityStatus.VERIFIED
    thinking_streaming: CapabilityStatus = CapabilityStatus.UNKNOWN
    tool_calling: CapabilityStatus = CapabilityStatus.UNKNOWN
    parallel_tool_calls: CapabilityStatus = CapabilityStatus.UNKNOWN
