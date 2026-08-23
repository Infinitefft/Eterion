import asyncio
from dataclasses import replace
from types import SimpleNamespace

from eterion_agent.config import Settings
from eterion_agent.models import ModelConfig
from eterion_agent.runtime import DirectModelRuntime, MessageInput, RunInput


class FakeModel:
    def __init__(self, chunks: list[object] | None = None) -> None:
        self.messages: list[dict[str, str]] = []
        self._chunks = chunks if chunks is not None else [
            SimpleNamespace(content="你"),
            SimpleNamespace(content="好"),
        ]

    async def astream(self, messages: list[dict[str, str]]):
        self.messages = messages
        for chunk in self._chunks:
            yield chunk


class FailingModel:
    async def astream(self, messages: list[dict[str, str]]):
        yield SimpleNamespace(content="部分")
        raise RuntimeError("provider failed")


class SlowModel:
    async def astream(self, messages: list[dict[str, str]]):
        await asyncio.sleep(0.05)
        yield SimpleNamespace(content="late")


def settings() -> Settings:
    return Settings(
        default_model_id="model-a",
        models=(
            ModelConfig(
                id="model-a",
                model_name="Model A",
                provider="test",
                provider_name="Test",
                icon_url="",
                api_key="secret",
                base_url="https://model.test",
                provider_model="provider-model",
            ),
        ),
        system_prompt="system prompt",
        model_timeout_seconds=30,
        run_timeout_seconds=30,
    )


def request(model_id: str = "model-a") -> RunInput:
    return RunInput(
        run_id="run-1",
        thread_id="thread-1",
        model_id=model_id,
        messages=[MessageInput(role="user", content="hello")],
    )


def test_streams_normalized_content_events() -> None:
    async def run() -> None:
        model = FakeModel()
        runtime = DirectModelRuntime(settings(), {"model-a": model})
        events = [event async for event in runtime.stream(request())]

        assert [event.type for event in events] == [
            "run.started",
            "content.started",
            "content.delta",
            "content.delta",
            "content.completed",
            "run.completed",
        ]
        assert events[-2].payload["content"] == "你好"
        assert events[-2].payload["status"] == "completed"
        assert all(event.run_id == "run-1" for event in events)
        assert model.messages[0] == {"role": "system", "content": "system prompt"}

    asyncio.run(run())


def test_rejects_unknown_model() -> None:
    async def run() -> None:
        runtime = DirectModelRuntime(settings(), {})
        events = [event async for event in runtime.stream(request("missing"))]
        assert [event.type for event in events] == ["run.failed"]
        assert events[0].payload["error"]["code"] == "MODEL_NOT_AVAILABLE"

    asyncio.run(run())


def test_empty_response_closes_content_and_run() -> None:
    async def run() -> None:
        runtime = DirectModelRuntime(settings(), {"model-a": FakeModel([])})
        events = [event async for event in runtime.stream(request())]

        assert [event.type for event in events] == [
            "run.started",
            "content.started",
            "content.completed",
            "run.failed",
        ]
        assert events[-2].payload["status"] == "failed"
        assert events[-1].payload["error"]["code"] == "AGENT_EMPTY_RESPONSE"

    asyncio.run(run())


def test_provider_failure_preserves_partial_content() -> None:
    async def run() -> None:
        runtime = DirectModelRuntime(settings(), {"model-a": FailingModel()})
        events = [event async for event in runtime.stream(request())]

        assert events[-2].type == "content.completed"
        assert events[-2].payload["content"] == "部分"
        assert events[-2].payload["status"] == "failed"
        assert events[-1].type == "run.failed"

    asyncio.run(run())


def test_timeout_closes_content_and_run() -> None:
    async def run() -> None:
        timeout_settings = replace(settings(), run_timeout_seconds=0.001)
        runtime = DirectModelRuntime(timeout_settings, {"model-a": SlowModel()})
        events = [event async for event in runtime.stream(request())]

        assert events[-2].type == "content.completed"
        assert events[-2].payload["status"] == "failed"
        assert events[-1].type == "run.failed"
        assert events[-1].payload["error"]["message"] == "模型调用超时"

    asyncio.run(run())
