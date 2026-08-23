"""Normalize provider chunks into frontend-facing content deltas.

Thinking and tool-call chunks will get their own adapters when those execution
paths are implemented; raw provider payloads must never become the IM contract.
"""

from __future__ import annotations

from typing import Any


def extract_content_delta(chunk: Any) -> str:
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
