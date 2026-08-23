"""SSE transport helpers kept separate from Agent execution."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import suppress
import json
import logging

from eterion_agent.runtime import AgentEvent, failure


logger = logging.getLogger(__name__)


async def stream_with_heartbeats(
    events: AsyncIterator[AgentEvent],
    heartbeat_seconds: float,
    run_id: str,
) -> AsyncIterator[str]:
    iterator = events.__aiter__()
    pending: asyncio.Task[AgentEvent] | None = asyncio.create_task(anext(iterator))
    try:
        while pending is not None:
            done, _ = await asyncio.wait({pending}, timeout=heartbeat_seconds)
            if not done:
                yield ": keepalive\n\n"
                continue
            try:
                event = pending.result()
            except StopAsyncIteration:
                pending = None
                break
            yield encode_sse(event)
            pending = asyncio.create_task(anext(iterator))
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("Agent SSE stream failed")
        yield encode_sse(
            failure(run_id, "AGENT_SERVICE_ERROR", "Agent 服务执行失败", True)
        )
    finally:
        if pending is not None and not pending.done():
            pending.cancel()
            with suppress(asyncio.CancelledError):
                await pending
        with suppress(Exception):
            await iterator.aclose()


def encode_sse(event: AgentEvent) -> str:
    data = {"runId": event.run_id, "payload": event.payload}
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    return f"event: {event.type}\ndata: {payload}\n\n"
