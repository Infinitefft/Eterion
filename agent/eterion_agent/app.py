"""FastAPI entry point for the internal Agent HTTP/SSE service."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
import json
import logging

from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse

from .config import Settings
from .runtime import AgentRuntime, ModelRuntime
from .schema import AgentEvent, RunInput, failure


logger = logging.getLogger(__name__)


def create_app(
    settings: Settings | None = None,
    runtime: AgentRuntime | None = None,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        resolved_settings = settings or Settings.from_env()
        resolved_runtime = runtime or await ModelRuntime.create(resolved_settings)
        application.state.settings = resolved_settings
        application.state.runtime = resolved_runtime
        try:
            yield
        finally:
            await resolved_runtime.close()

    application = FastAPI(
        title="Eterion Agent Service",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )

    @application.get("/healthz")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @application.get("/models")
    async def models(request: Request) -> dict[str, object]:
        agent_runtime: AgentRuntime = request.app.state.runtime
        return {
            "default_model_id": agent_runtime.default_model_id,
            "models": agent_runtime.models,
        }

    @application.post("/runs")
    async def run_agent(payload: RunInput, request: Request) -> StreamingResponse:
        agent_runtime: AgentRuntime = request.app.state.runtime
        heartbeat_seconds = request.app.state.settings.heartbeat_seconds
        return StreamingResponse(
            _stream_with_heartbeats(agent_runtime.stream(payload), heartbeat_seconds),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    return application


async def _stream_with_heartbeats(
    events: AsyncIterator[AgentEvent],
    heartbeat_seconds: float,
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
        yield encode_sse(failure("AGENT_SERVICE_ERROR", "Agent 服务执行失败", True))
    finally:
        if pending is not None and not pending.done():
            pending.cancel()
            with suppress(asyncio.CancelledError):
                await pending
        with suppress(Exception):
            await iterator.aclose()


def encode_sse(event: AgentEvent) -> str:
    payload = json.dumps(event.data, ensure_ascii=False, separators=(",", ":"))
    return f"event: {event.name}\ndata: {payload}\n\n"


app = create_app()
