"""负责构建 LangGraph Chat 工作流并流式输出模型文本。"""

from collections.abc import AsyncIterator, Sequence

from langchain_core.messages import (
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
)
from langchain_openai import ChatOpenAI
from langgraph.graph import END, START, MessagesState, StateGraph

from eterion_agent.config import AgentConfig


class ChatWorkflow:
  """
  最小的 LangGraph Chat 工作流。

  当前只有一个模型节点：

    START -> generate -> END

  后续增加 Tool、Skill 或 RAG 时，可以继续向这个图添加节点。
  """

  def __init__(self, config: AgentConfig) -> None:
    # self 代表当前创建出来的 ChatWorkflow 实例。
    # 保存到 self 上的字段，可以在这个类的其他方法中继续使用。

    model_options: dict[str, object] = {
      "model": config.model_name,
      "api_key": config.model_api_key,
      "timeout": config.model_timeout_seconds,

      # 流式请求中途自动重试可能产生重复文本，因此第一阶段关闭重试。
      "max_retries": 0,
      "streaming": True,
    }

    # 没有配置 Base URL 时，langchain-openai 使用 OpenAI 官方默认地址。
    if config.model_base_url is not None:
      model_options["base_url"] = config.model_base_url

    self._system_prompt = config.system_prompt

    # **model_options 会把字典展开成关键字参数。
    # 例如 {"model": "demo"} 会作为 model="demo" 传入。
    self._model = ChatOpenAI(**model_options)

    # MessagesState 是 LangGraph 内置的消息状态。
    # 节点返回的新消息会被追加到已有消息列表中。
    builder = StateGraph(MessagesState)

    # generate 是节点名称，self._generate 是节点执行时调用的方法。
    builder.add_node("generate", self._generate)
    builder.add_edge(START, "generate")
    builder.add_edge("generate", END)

    # compile() 将图结构编译成真正可以执行和流式读取的工作流。
    # 当前不配置 Checkpointer，因为 PostgreSQL 才是 Chat 历史的权威来源。
    self._graph = builder.compile()

  async def _generate(
    self,
    state: MessagesState,
  ) -> dict[str, list[BaseMessage]]:
    """
    调用模型的 LangGraph 节点。

    async 表示这是异步函数；await 会等待模型请求完成，
    等待期间不会阻塞整个 Python 事件循环。

    方法名前的下划线表示它主要供类内部使用。
    """

    response = await self._model.ainvoke(
      state["messages"]
    )

    # MessagesState 会把这里返回的新消息追加到原有状态。
    return {
      "messages": [response],
    }

  async def stream(
    self,
    messages: Sequence[tuple[str, str]],
  ) -> AsyncIterator[str]:
    """
    执行工作流，并逐段返回模型生成的文本。

    Sequence[tuple[str, str]] 表示参数是一个有顺序的消息集合，
    每条消息都是 (role, content) 形式的二元组。

    AsyncIterator[str] 表示调用者可以通过 async for
    异步读取这个方法持续产生的字符串。
    """

    graph_messages = self._to_graph_messages(
      messages
    )

    # stream_mode="messages" 用于接收模型生成过程中的文本片段。
    # version="v2" 只是 LangGraph 的内部输出格式，不是项目接口版本。
    async for part in self._graph.astream(
      {"messages": graph_messages},
      stream_mode="messages",
      version="v2",
    ):
      # v2 流中可能包含多种数据，这里只处理模型消息。
      if part["type"] != "messages":
        continue

      message_chunk, metadata = part["data"]

      # 后续图中可能出现多个模型节点。
      # 当前只允许 generate 节点的文本成为最终回答。
      if metadata.get("langgraph_node") != "generate":
        continue

      # text 会将 LangChain 的文本内容统一暴露为字符串。
      text = str(message_chunk.text)

      # yield 不会一次性结束函数，而是把本次增量交给调用者，
      # 下一次 async for 迭代时再继续向下执行。
      if text:
        yield text

  def _to_graph_messages(
    self,
    messages: Sequence[tuple[str, str]],
  ) -> list[BaseMessage]:
    """把普通的 role/content 转换为 LangChain 消息对象。"""

    result: list[BaseMessage] = []

    # 系统提示词始终位于 Chat 历史之前。
    if self._system_prompt:
      result.append(
        SystemMessage(
          content=self._system_prompt,
        )
      )

    for role, content in messages:
      normalized_role = role.strip().lower()

      if normalized_role == "system":
        result.append(
          SystemMessage(content=content)
        )
      elif normalized_role == "user":
        result.append(
          HumanMessage(content=content)
        )
      elif normalized_role == "assistant":
        result.append(
          AIMessage(content=content)
        )
      else:
        # Proto 中的 role 当前是字符串，所以这里仍要防御未知角色。
        raise ValueError(
          f"unsupported message role: {role}"
        )

    return result
