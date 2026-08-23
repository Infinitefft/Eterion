"""FastAPI entry point for the internal Agent HTTP/SSE service."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse

from eterion_agent.config import Settings
from eterion_agent.runtime import AgentRuntime, DirectModelRuntime, RunInput

from .sse import stream_with_heartbeats


def create_app(
    settings: Settings | None = None,
    runtime: AgentRuntime | None = None,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        resolved_settings = settings or Settings.from_env()
        resolved_runtime = runtime or await DirectModelRuntime.create(resolved_settings)
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
            stream_with_heartbeats(
                agent_runtime.stream(payload),
                heartbeat_seconds,
                payload.run_id,
            ),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    return application


app = create_app()
