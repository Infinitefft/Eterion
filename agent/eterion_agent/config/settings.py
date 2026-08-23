"""Environment-backed service and execution settings."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
import os
from pathlib import Path
import re

from dotenv import load_dotenv

from eterion_agent.models import ModelConfig, load_model_catalog


DEFAULT_SYSTEM_PROMPT = "你是 Eterion 的 AI 助手。请准确、清晰地回答用户问题。"


@dataclass(frozen=True, slots=True)
class Settings:
    default_model_id: str
    models: tuple[ModelConfig, ...]
    system_prompt: str
    model_timeout_seconds: float
    run_timeout_seconds: float
    heartbeat_seconds: float = 15.0
    host: str = "127.0.0.1"
    port: int = 8001

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> Settings:
        if environ is None:
            agent_root = Path(__file__).resolve().parents[2]
            load_dotenv(agent_root / ".env")
            environ = os.environ

        models = load_model_catalog(environ)
        if not models:
            raise ValueError("at least one Agent model must be configured")

        default_model_id = _value(environ, "DEFAULT_MODEL_ID", models[0].id)
        if default_model_id not in {model.id for model in models}:
            raise ValueError(f'DEFAULT_MODEL_ID "{default_model_id}" is not configured')

        return cls(
            default_model_id=default_model_id,
            models=models,
            system_prompt=_value(environ, "SYSTEM_PROMPT", DEFAULT_SYSTEM_PROMPT),
            model_timeout_seconds=_duration_seconds(
                _value(environ, "MODEL_TIMEOUT", "2m"), "MODEL_TIMEOUT"
            ),
            run_timeout_seconds=_duration_seconds(
                _value(environ, "AGENT_RUN_TIMEOUT", "10m"), "AGENT_RUN_TIMEOUT"
            ),
            heartbeat_seconds=_duration_seconds(
                _value(environ, "AGENT_HEARTBEAT", "15s"), "AGENT_HEARTBEAT"
            ),
            host=_value(environ, "AGENT_HOST", "127.0.0.1"),
            port=_port(_value(environ, "AGENT_PORT", "8001")),
        )


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


def _port(raw: str) -> int:
    try:
        value = int(raw)
    except ValueError as error:
        raise ValueError("AGENT_PORT must be an integer") from error
    if not 1 <= value <= 65535:
        raise ValueError("AGENT_PORT must be between 1 and 65535")
    return value
