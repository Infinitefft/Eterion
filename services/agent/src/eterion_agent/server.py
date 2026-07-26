"""负责启动 Python gRPC 服务，并把 LangGraph 输出转换为流式 Run 事件。"""

import asyncio
import hmac
import logging
from collections.abc import AsyncIterator

import grpc

from eterion_agent import agent_pb2, agent_pb2_grpc
from eterion_agent.config import AgentConfig, ConfigError
from eterion_agent.workflow import ChatWorkflow


logger = logging.getLogger("eterion.agent")

# 当前只允许这三种消息角色进入 LangGraph。
_ALLOWED_ROLES = frozenset({
  "system",
  "user",
  "assistant",
})

# 第一阶段只传文本历史，不通过 gRPC 直接传输附件。
_MAX_GRPC_MESSAGE_BYTES = 4 * 1024 * 1024


class AgentService(agent_pb2_grpc.AgentServiceServicer):
  """
  实现 agent.proto 中声明的 AgentService。

  父类 AgentServiceServicer 由 Protobuf 自动生成，
  当前需要实现其中的 StreamRun 方法。
  """

  def __init__(
    self,
    config: AgentConfig,
    workflow: ChatWorkflow,
  ) -> None:
    self._config = config
    self._workflow = workflow

  async def StreamRun(
    self,
    request: agent_pb2.RunRequest,
    context: grpc.aio.ServicerContext,
  ) -> AsyncIterator[agent_pb2.RunEvent]:
    """
    接收 Go 发来的 Run 请求，并持续返回 Agent 事件。

    AsyncIterator[RunEvent] 表示这个方法不会只返回一个结果，
    而是可以通过 yield 持续产生多个 RunEvent。

    正常事件顺序：

      started -> content_delta × N -> completed

    失败事件顺序：

      started -> failed
    """

    # gRPC 接口只监听本机，但仍使用共享密钥验证调用方身份。
    await self._authenticate(context)

    # 在调用模型之前完成内部请求校验。
    await self._validate_request(request, context)

    run_id = request.run_id.strip()
    chat_id = request.chat_id.strip()

    # 将 Protobuf Message 转换为 Workflow 使用的普通元组。
    messages = [
      (message.role, message.content)
      for message in request.messages
    ]

    logger.info(
      "agent run started",
      extra={
        "run_id": run_id,
        "chat_id": chat_id,
        "model": self._config.model_name,
      },
    )

    # 先通知 Go：Python Agent 已正式接管这个 Run。
    yield agent_pb2.RunEvent(
      started=agent_pb2.RunStarted(
        model=self._config.model_name,
      )
    )

    # Python 同时拼接完整文本。
    # completed 事件会携带完整结果，用来校正前面的增量。
    chunks: list[str] = []

    try:
      async for delta in self._workflow.stream(messages):
        chunks.append(delta)

        # 每收到一段模型文本，就立即通过 gRPC 发送给 Go。
        yield agent_pb2.RunEvent(
          content_delta=agent_pb2.ContentDelta(
            delta=delta,
          )
        )

      full_text = "".join(chunks)

      # 模型正常结束但没有生成文本，也要形成明确的失败结果。
      if not full_text.strip():
        yield agent_pb2.RunEvent(
          failed=agent_pb2.RunFailed(
            code="AGENT_EMPTY_RESPONSE",
            message="模型没有返回有效文本",
            retryable=False,
          )
        )
        return

      # completed 中携带完整文本，Go 不必只依赖之前的增量。
      yield agent_pb2.RunEvent(
        completed=agent_pb2.RunCompleted(
          full_text=full_text,
        )
      )

      logger.info(
        "agent run completed",
        extra={
          "run_id": run_id,
          "chat_id": chat_id,
          "output_length": len(full_text),
        },
      )

    except asyncio.CancelledError:
      # Go 主动取消 Run 或关闭服务时，gRPC 会传播取消信号。
      # 必须继续抛出该异常，不能将用户取消伪装成模型失败。
      logger.info(
        "agent run cancelled",
        extra={
          "run_id": run_id,
          "chat_id": chat_id,
        },
      )
      raise

    except Exception:
      # logger.exception 会自动记录当前异常堆栈。
      # 日志中只关联业务 ID，不主动打印用户消息和模型密钥。
      logger.exception(
        "agent run failed",
        extra={
          "run_id": run_id,
          "chat_id": chat_id,
        },
      )

      # 发给 Go 的错误必须经过收敛，
      # 不能直接暴露模型厂商返回的原始异常内容。
      yield agent_pb2.RunEvent(
        failed=agent_pb2.RunFailed(
          code="MODEL_REQUEST_FAILED",
          message="模型调用失败",
          retryable=False,
        )
      )

  async def _authenticate(
    self,
    context: grpc.aio.ServicerContext,
  ) -> None:
    """
    校验 Go 放在 gRPC Metadata 中的共享密钥。

    Go 后续会发送：

      authorization: Bearer <AGENT_SHARED_SECRET>
    """

    authorization = ""

    for item in context.invocation_metadata():
      if item.key.lower() == "authorization":
        authorization = item.value
        break

    expected = f"Bearer {self._config.shared_secret}"

    # compare_digest 用恒定时间比较密钥，降低时序攻击风险。
    if not hmac.compare_digest(authorization, expected):
      await context.abort(
        grpc.StatusCode.UNAUTHENTICATED,
        "invalid agent credentials",
      )

  async def _validate_request(
    self,
    request: agent_pb2.RunRequest,
    context: grpc.aio.ServicerContext,
  ) -> None:
    """验证 Go 发来的内部 Run 请求。"""

    if not request.run_id.strip():
      await context.abort(
        grpc.StatusCode.INVALID_ARGUMENT,
        "run_id is required",
      )

    if not request.chat_id.strip():
      await context.abort(
        grpc.StatusCode.INVALID_ARGUMENT,
        "chat_id is required",
      )

    if not request.messages:
      await context.abort(
        grpc.StatusCode.INVALID_ARGUMENT,
        "messages cannot be empty",
      )

    for message in request.messages:
      role = message.role.strip().lower()

      if role not in _ALLOWED_ROLES:
        await context.abort(
          grpc.StatusCode.INVALID_ARGUMENT,
          "message role is invalid",
        )

    # 每次 Run 都应由一条最新的用户消息触发。
    if request.messages[-1].role.strip().lower() != "user":
      await context.abort(
        grpc.StatusCode.INVALID_ARGUMENT,
        "the last message must be a user message",
      )


async def serve() -> None:
  """创建依赖、注册 AgentService 并启动 gRPC Server。"""

  # 配置、模型和 LangGraph 都只创建一次，由所有 Run 复用。
  config = AgentConfig.from_env()
  workflow = ChatWorkflow(config)

  server = grpc.aio.server(
    options=[
      (
        "grpc.max_receive_message_length",
        _MAX_GRPC_MESSAGE_BYTES,
      ),
      (
        "grpc.max_send_message_length",
        _MAX_GRPC_MESSAGE_BYTES,
      ),
    ]
  )

  # 将业务实现注册到自动生成的 gRPC Server 中。
  agent_pb2_grpc.add_AgentServiceServicer_to_server(
    AgentService(config, workflow),
    server,
  )

  # 当前使用本地非 TLS 连接。
  # add_insecure_port 返回实际绑定的端口；0 表示绑定失败。
  bound_port = server.add_insecure_port(
    config.grpc_address
  )

  if bound_port == 0:
    raise RuntimeError(
      f"could not bind gRPC server to {config.grpc_address}"
    )

  await server.start()

  logger.info(
    "agent gRPC server started",
    extra={
      "address": config.grpc_address,
      "model": config.model_name,
    },
  )

  try:
    # 持续等待，直到进程收到停止信号。
    await server.wait_for_termination()
  finally:
    # graceful stop 最多给正在执行的 RPC 5 秒清理时间。
    await server.stop(grace=5)


def main() -> None:
  """Python Agent 进程入口。"""

  logging.basicConfig(
    level=logging.INFO,
    format=(
      "%(asctime)s "
      "%(levelname)s "
      "%(name)s "
      "%(message)s"
    ),
  )

  try:
    # asyncio.run 负责创建并管理最外层事件循环。
    asyncio.run(serve())
  except ConfigError as error:
    logger.error(
      "invalid configuration: %s",
      error,
    )
    raise SystemExit(1) from error
  except KeyboardInterrupt:
    logger.info("agent server stopped")


if __name__ == "__main__":
  # 直接执行 python -m eterion_agent.server 时进入这里。
  # 被其他模块 import 时不会自动启动服务。
  main()
