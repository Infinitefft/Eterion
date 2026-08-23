from collections.abc import AsyncIterator

from fastapi.testclient import TestClient

from eterion_agent.api.app import create_app
from eterion_agent.config import Settings
from eterion_agent.runtime import AgentEvent, RunInput


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
        yield AgentEvent("run.started", request.run_id, {"modelId": request.model_id})
        yield AgentEvent("content.started", request.run_id, {"format": "markdown"})
        yield AgentEvent("content.delta", request.run_id, {"delta": "你好"})
        yield AgentEvent(
            "content.completed",
            request.run_id,
            {
                "content": "你好",
                "format": "markdown",
                "status": "completed",
                "error": None,
            },
        )
        yield AgentEvent("run.completed", request.run_id, {})

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
        assert models.json() == {
            "default_model_id": "model-a",
            "models": [
                {
                    "id": "model-a",
                    "modelName": "Model A",
                    "provider": "test",
                    "providerName": "Test",
                    "icon_url": "",
                }
            ],
        }

        response = client.post(
            "/runs",
            json={
                "run_id": "run-1",
                "thread_id": "thread-1",
                "model_id": "model-a",
                "messages": [{"role": "user", "content": "hello"}],
            },
        )
        assert response.status_code == 200
        assert "event: content.delta" in response.text
        assert '"runId":"run-1"' in response.text
        assert '"content":"你好"' in response.text
