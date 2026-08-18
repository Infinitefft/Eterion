from eterion_agent.config import Settings


def test_loads_model_configuration() -> None:
    settings = Settings.from_env(
        {
            "DEFAULT_MODEL_ID": "deepseek-v4-pro",
            "DEEPSEEK_API_KEY": "secret",
            "DEEPSEEK_BASE_URL": "https://model.test",
            "DEEPSEEK_V4_PRO_MODEL": "deepseek-model",
            "DEEPSEEK_V4_PRO_NAME": "DeepSeek Test",
            "MODEL_TIMEOUT": "30s",
            "AGENT_RUN_TIMEOUT": "2m",
        }
    )

    assert settings.default_model_id == "deepseek-v4-pro"
    assert settings.model_timeout_seconds == 30
    assert settings.run_timeout_seconds == 120
    assert settings.models[0].provider_model == "deepseek-model"
    assert settings.models[0].public_dict()["modelName"] == "DeepSeek Test"
