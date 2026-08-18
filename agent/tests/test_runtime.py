import asyncio
from types import SimpleNamespace

from eterion_agent.config import ModelConfig, Settings
from eterion_agent.runtime import ModelRuntime
from eterion_agent.schema import MessageInput, RunInput


class FakeModel:
    def __init__(self) -> None:
        self.messages: list[dict[str, str]] = []

    async def astream(self, messages: list[dict[str, str]]):
        self.messages = messages
        yield SimpleNamespace(content="你")
        yield SimpleNamespace(content="好")


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
        chat_id="chat-1",
        model_id=model_id,
        messages=[MessageInput(role="user", content="hello")],
    )


def test_streams_model_content() -> None:
    async def run() -> None:
        model = FakeModel()
        runtime = ModelRuntime(settings(), {"model-a": model})
        events = [event async for event in runtime.stream(request())]

        assert [event.name for event in events] == [
            "started",
            "content_delta",
            "content_delta",
            "completed",
        ]
        assert events[-1].data["full_text"] == "你好"
        assert model.messages[0] == {"role": "system", "content": "system prompt"}

    asyncio.run(run())


def test_rejects_unknown_model() -> None:
    async def run() -> None:
        runtime = ModelRuntime(settings(), {})
        events = [event async for event in runtime.stream(request("missing"))]
        assert len(events) == 1
        assert events[0].name == "error"
        assert events[0].data["error"]["code"] == "MODEL_NOT_AVAILABLE"

    asyncio.run(run())
