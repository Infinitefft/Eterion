"""Single source of truth for configured model instances."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

from .capabilities import ModelCapabilities


@dataclass(frozen=True, slots=True)
class ModelDefinition:
    id: str
    provider: str
    provider_name: str
    model_prefix: str
    provider_prefix: str
    model_name: str
    base_url: str
    icon_url: str
    capabilities: ModelCapabilities = ModelCapabilities()


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
    capabilities: ModelCapabilities = ModelCapabilities()

    def public_dict(self) -> dict[str, str]:
        """Keep the existing frontend model-list response stable."""
        return {
            "id": self.id,
            "modelName": self.model_name,
            "provider": self.provider,
            "providerName": self.provider_name,
            "icon_url": self.icon_url,
        }


MODEL_DEFINITIONS = (
    ModelDefinition(
        id="doubao-seed-2-1-pro",
        provider="doubao",
        provider_name="豆包",
        model_prefix="DOUBAO_SEED_2_1_PRO",
        provider_prefix="DOUBAO",
        model_name="Doubao-Seed-2.1-pro",
        base_url="https://ark.cn-beijing.volces.com/api/v3",
        icon_url="/model-icons/doubao-seed-2-1-pro.png",
    ),
    ModelDefinition(
        id="deepseek-v4-pro",
        provider="deepseek",
        provider_name="DeepSeek",
        model_prefix="DEEPSEEK_V4_PRO",
        provider_prefix="DEEPSEEK",
        model_name="DeepSeek-V4-Pro",
        base_url="https://api.deepseek.com",
        icon_url="/model-icons/deepseek-v4-pro.png",
    ),
    ModelDefinition(
        id="minimax-m2-7",
        provider="minimax",
        provider_name="MiniMax",
        model_prefix="MINIMAX_M2_7",
        provider_prefix="MINIMAX",
        model_name="MiniMax M2.7",
        base_url="https://api.minimaxi.com/v1",
        icon_url="/model-icons/minimax-m2-7.png",
    ),
)


def load_model_catalog(environ: Mapping[str, str]) -> tuple[ModelConfig, ...]:
    configured = _load_known_models(environ)
    if configured:
        return tuple(configured)
    return tuple(_load_generic_model(environ))


def _load_known_models(environ: Mapping[str, str]) -> list[ModelConfig]:
    models: list[ModelConfig] = []
    for definition in MODEL_DEFINITIONS:
        provider_model = _value(environ, f"{definition.model_prefix}_MODEL")
        if not provider_model:
            continue

        api_key = _value(environ, f"{definition.provider_prefix}_API_KEY")
        if not api_key:
            raise ValueError(f"{definition.id} API key is required")
        models.append(
            ModelConfig(
                id=definition.id,
                model_name=_value(
                    environ,
                    f"{definition.model_prefix}_NAME",
                    definition.model_name,
                ),
                provider=definition.provider,
                provider_name=definition.provider_name,
                icon_url=_value(
                    environ,
                    f"{definition.provider_prefix}_ICON_URL",
                    definition.icon_url,
                ),
                api_key=api_key,
                base_url=_value(
                    environ,
                    f"{definition.provider_prefix}_BASE_URL",
                    definition.base_url,
                ),
                provider_model=provider_model,
                capabilities=definition.capabilities,
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
