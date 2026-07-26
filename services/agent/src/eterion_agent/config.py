"""负责读取和校验 Python Agent 运行所需的环境变量。"""

import os
from dataclasses import dataclass


class ConfigError(ValueError):
  """Agent 服务配置缺失或格式错误。"""


# @dataclass 会根据下面声明的字段自动生成 __init__、__repr__ 等方法。
# frozen=True 表示实例创建后不能修改字段，避免运行期间配置被意外改变。
# slots=True 限制实例只能拥有已声明的字段，同时减少一点内存开销。
@dataclass(frozen=True, slots=True)
class AgentConfig:
  """gRPC Server 与 LangGraph Workflow 共用的运行配置。"""

  grpc_address: str
  shared_secret: str
  model_api_key: str

  # str | None 表示该字段既可以是字符串，也可以是 None。
  model_base_url: str | None

  model_name: str
  system_prompt: str
  model_timeout_seconds: float

  # @classmethod 表示这个方法属于类，而不是某个已经创建的实例。
  # cls 是 class 的惯用缩写，这里代表 AgentConfig 类本身。
  # 使用 cls(...) 而不是直接写 AgentConfig(...)，可以让子类复用这个方法。
  @classmethod
  def from_env(cls) -> "AgentConfig":
    """从环境变量读取、校验并创建一个 AgentConfig 实例。"""

    grpc_address = _env("AGENT_GRPC_ADDR", "127.0.0.1:50051")
    shared_secret = _required_env("AGENT_SHARED_SECRET")
    model_api_key = _required_env("MODEL_API_KEY")
    model_name = _required_env("MODEL_NAME")

    # Base URL 留空时，langchain-openai 会使用 OpenAI 官方默认地址。
    model_base_url = _optional_env("MODEL_BASE_URL")
    system_prompt = _env(
      "SYSTEM_PROMPT",
      "你是 Eterion 的 AI 助手。请准确、清晰地回答用户问题。",
    )
    model_timeout_seconds = _positive_float_env(
      "MODEL_TIMEOUT_SECONDS",
      120.0,
    )

    # 共享密钥用于保护 Go 到 Python 的内部 gRPC 接口。
    if len(shared_secret) < 32:
      raise ConfigError(
        "AGENT_SHARED_SECRET must contain at least 32 characters"
      )

    # cls(...) 等价于在这里创建 AgentConfig(...) 实例。
    return cls(
      grpc_address=grpc_address,
      shared_secret=shared_secret,
      model_api_key=model_api_key,
      model_base_url=model_base_url,
      model_name=model_name,
      system_prompt=system_prompt,
      model_timeout_seconds=model_timeout_seconds,
    )


def _required_env(name: str) -> str:
  """读取必填环境变量，并去掉首尾空白。"""

  value = os.getenv(name, "").strip()
  if not value:
    raise ConfigError(f"{name} is required")
  return value


def _optional_env(name: str) -> str | None:
  """读取可选环境变量；没有有效内容时返回 None。"""

  value = os.getenv(name, "").strip()
  return value or None


def _env(name: str, default: str) -> str:
  """读取带默认值的字符串环境变量。"""

  value = os.getenv(name, "").strip()
  return value or default


def _positive_float_env(name: str, default: float) -> float:
  """读取必须大于零的浮点数环境变量。"""

  raw_value = os.getenv(name, "").strip()
  if not raw_value:
    return default

  try:
    value = float(raw_value)
  except ValueError as error:
    # raise ... from error 会保留原始异常，方便排查具体的转换错误。
    raise ConfigError(f"{name} must be a number") from error

  if value <= 0:
    raise ConfigError(f"{name} must be greater than zero")

  return value
