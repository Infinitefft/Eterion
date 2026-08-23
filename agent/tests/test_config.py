import pytest

from eterion_agent.config import Settings
from eterion_agent.models.capabilities import CapabilityStatus


def test_loads_known_model_configuration() -> None:
    settings = Settings.from_env(
        {
            "DEFAULT_MODEL_ID": "deepseek-v4-pro",
            "DEEPSEEK_API_KEY": "secret",
            "DEEPSEEK_BASE_URL": "https://model.test",
            "DEEPSEEK_V4_PRO_MODEL": "deepseek-model",
            "DEEPSEEK_V4_PRO_NAME": "DeepSeek Test",
            "MODEL_TIMEOUT": "30s",
            "AGENT_RUN_TIMEOUT": "2m",
            "AGENT_HEARTBEAT": "5s",
            "AGENT_HOST": "0.0.0.0",
            "AGENT_PORT": "9001",
        }
    )

    assert settings.default_model_id == "deepseek-v4-pro"
    assert settings.model_timeout_seconds == 30
    assert settings.run_timeout_seconds == 120
    assert settings.heartbeat_seconds == 5
    assert settings.host == "0.0.0.0"
    assert settings.port == 9001
    assert settings.models[0].provider_model == "deepseek-model"
    assert settings.models[0].public_dict()["modelName"] == "DeepSeek Test"
    assert settings.models[0].capabilities.text_streaming is CapabilityStatus.VERIFIED
    assert settings.models[0].capabilities.tool_calling is CapabilityStatus.UNKNOWN
    assert "capabilities" not in settings.models[0].public_dict()


def test_loads_generic_openai_compatible_model() -> None:
    settings = Settings.from_env(
        {
            "MODEL_API_KEY": "secret",
            "MODEL_BASE_URL": "https://model.test/v1",
            "MODEL_NAME": "provider-model",
        }
    )

    assert settings.default_model_id == "default"
    assert settings.models[0].provider == "openai-compatible"
    assert settings.models[0].provider_model == "provider-model"


def test_rejects_unknown_default_model() -> None:
    with pytest.raises(ValueError, match="is not configured"):
        Settings.from_env(
            {
                "DEFAULT_MODEL_ID": "missing",
                "DEEPSEEK_API_KEY": "secret",
                "DEEPSEEK_V4_PRO_MODEL": "deepseek-model",
            }
        )


@pytest.mark.parametrize("port", ["abc", "0", "65536"])
def test_rejects_invalid_port(port: str) -> None:
    with pytest.raises(ValueError, match="AGENT_PORT"):
        Settings.from_env(
            {
                "MODEL_API_KEY": "secret",
                "MODEL_NAME": "provider-model",
                "AGENT_PORT": port,
            }
        )
