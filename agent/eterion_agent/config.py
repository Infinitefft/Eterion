"""Environment-backed model configuration."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
import os
from pathlib import Path
import re

from dotenv import load_dotenv


DEFAULT_SYSTEM_PROMPT = "你是 Eterion 的 AI 助手。请准确、清晰地回答用户问题。"


@dataclass(frozen=True, slots=True)
class ModelConfig:
    id: str
    model_name: str
    provider: str
    provider_name: str
    icon_url: str
    api_key: str
    base_url: str
    provider_model: str

    def public_dict(self) -> dict[str, str]:
        return {
            "id": self.id,
            "modelName": self.model_name,
            "provider": self.provider,
            "providerName": self.provider_name,
            "icon_url": self.icon_url,
        }


@dataclass(frozen=True, slots=True)
class Settings:
    default_model_id: str
    models: tuple[ModelConfig, ...]
    system_prompt: str
    model_timeout_seconds: float
    run_timeout_seconds: float
    heartbeat_seconds: float = 15.0

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> Settings:
        if environ is None:
            agent_root = Path(__file__).resolve().parents[1]
            load_dotenv(agent_root / ".env")
            environ = os.environ

        models = _load_models(environ)
        if not models:
            models = _load_generic_model(environ)
        if not models:
            raise ValueError("at least one Agent model must be configured")

        default_model_id = _value(environ, "DEFAULT_MODEL_ID", models[0].id)
        if default_model_id not in {model.id for model in models}:
            raise ValueError(f'DEFAULT_MODEL_ID "{default_model_id}" is not configured')

        return cls(
            default_model_id=default_model_id,
            models=tuple(models),
            system_prompt=_value(environ, "SYSTEM_PROMPT", DEFAULT_SYSTEM_PROMPT),
            model_timeout_seconds=_duration_seconds(
                _value(environ, "MODEL_TIMEOUT", "2m"), "MODEL_TIMEOUT"
            ),
            run_timeout_seconds=_duration_seconds(
                _value(environ, "AGENT_RUN_TIMEOUT", "10m"), "AGENT_RUN_TIMEOUT"
            ),
        )


MODEL_DEFINITIONS = (
    {
        "id": "doubao-seed-2-1-pro",
        "provider": "doubao",
        "provider_name": "豆包",
        "model_prefix": "DOUBAO_SEED_2_1_PRO",
        "provider_prefix": "DOUBAO",
        "model_name": "Doubao-Seed-2.1-pro",
        "base_url": "https://ark.cn-beijing.volces.com/api/v3",
        "icon_url": "/model-icons/doubao-seed-2-1-pro.png",
    },
    {
        "id": "deepseek-v4-pro",
        "provider": "deepseek",
        "provider_name": "DeepSeek",
        "model_prefix": "DEEPSEEK_V4_PRO",
        "provider_prefix": "DEEPSEEK",
        "model_name": "DeepSeek-V4-Pro",
        "base_url": "https://api.deepseek.com",
        "icon_url": "/model-icons/deepseek-v4-pro.png",
    },
    {
        "id": "minimax-m2-7",
        "provider": "minimax",
        "provider_name": "MiniMax",
        "model_prefix": "MINIMAX_M2_7",
        "provider_prefix": "MINIMAX",
        "model_name": "MiniMax M2.7",
        "base_url": "https://api.minimaxi.com/v1",
        "icon_url": "/model-icons/minimax-m2-7.png",
    },
)


def _load_models(environ: Mapping[str, str]) -> list[ModelConfig]:
    models: list[ModelConfig] = []
    for definition in MODEL_DEFINITIONS:
        model_prefix = definition["model_prefix"]
        provider_prefix = definition["provider_prefix"]
        provider_model = _value(environ, f"{model_prefix}_MODEL")
        if not provider_model:
            continue

        api_key = _value(environ, f"{provider_prefix}_API_KEY")
        if not api_key:
            raise ValueError(f'{definition["id"]} API key is required')
        models.append(
            ModelConfig(
                id=definition["id"],
                model_name=_value(environ, f"{model_prefix}_NAME", definition["model_name"]),
                provider=definition["provider"],
                provider_name=definition["provider_name"],
                icon_url=_value(environ, f"{provider_prefix}_ICON_URL", definition["icon_url"]),
                api_key=api_key,
                base_url=_value(environ, f"{provider_prefix}_BASE_URL", definition["base_url"]),
                provider_model=provider_model,
            )
        )
    return models


def _load_generic_model(environ: Mapping[str, str]) -> list[ModelConfig]:
    provider_model = _value(environ, "MODEL_NAME")
    api_key = _value(environ, "MODEL_API_KEY")
    if not provider_model and not api_key:
        return []
    if not provider_model or not api_key:
        raise ValueError("MODEL_NAME and MODEL_API_KEY must be configured together")
    return [
        ModelConfig(
            id="default",
            model_name=provider_model,
            provider="openai-compatible",
            provider_name="OpenAI 兼容",
            icon_url="",
            api_key=api_key,
            base_url=_value(environ, "MODEL_BASE_URL"),
            provider_model=provider_model,
        )
    ]


def _value(environ: Mapping[str, str], key: str, fallback: str = "") -> str:
    value = environ.get(key, "").strip()
    return value or fallback


_DURATION_PATTERN = re.compile(r"^(?P<value>\d+(?:\.\d+)?)(?P<unit>ms|s|m|h)$")
_DURATION_MULTIPLIERS = {"ms": 0.001, "s": 1.0, "m": 60.0, "h": 3600.0}


def _duration_seconds(raw: str, key: str) -> float:
    match = _DURATION_PATTERN.fullmatch(raw.strip())
    if match is None:
        raise ValueError(f"{key} must be a positive duration such as 15s, 2m, or 1h")
    value = float(match.group("value")) * _DURATION_MULTIPLIERS[match.group("unit")]
    if value <= 0:
        raise ValueError(f"{key} must be positive")
    return value
