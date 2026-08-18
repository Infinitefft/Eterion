from collections.abc import AsyncIterator

from fastapi.testclient import TestClient

from eterion_agent.app import create_app
from eterion_agent.config import Settings
from eterion_agent.schema import AgentEvent, RunInput


class FakeRuntime:
    @property
    def default_model_id(self) -> str:
        return "model-a"

    @property
    def models(self) -> list[dict[str, str]]:
        return [
            {
                "id": "model-a",
                "modelName": "Model A",
                "provider": "test",
                "providerName": "Test",
                "icon_url": "",
            }
        ]

    async def stream(self, request: RunInput) -> AsyncIterator[AgentEvent]:
        yield AgentEvent("started", {"model": request.model_id})
        yield AgentEvent("content_delta", {"delta": "你好"})
        yield AgentEvent("completed", {"full_text": "你好"})

    async def close(self) -> None:
        return None


def test_models_and_run_routes_have_no_version_prefix() -> None:
    settings = Settings(
        default_model_id="model-a",
        models=(),
        system_prompt="system",
        model_timeout_seconds=30,
        run_timeout_seconds=30,
        heartbeat_seconds=0.01,
    )
    app = create_app(settings, FakeRuntime())

    with TestClient(app) as client:
        models = client.get("/models")
        assert models.status_code == 200
        assert models.json()["default_model_id"] == "model-a"

        response = client.post(
            "/runs",
            json={
                "run_id": "run-1",
                "chat_id": "chat-1",
                "model_id": "model-a",
                "messages": [{"role": "user", "content": "hello"}],
            },
        )
        assert response.status_code == 200
        assert "event: content_delta" in response.text
        assert '"full_text":"你好"' in response.text
