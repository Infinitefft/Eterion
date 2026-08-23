# Eterion Agent 架构

## 目标

`agent/` 是 Agent 推理和编排的边界。它负责模型选择、意图路由、上下文构建、
Skills、Tools、RAG 和 Memory，最终输出与具体模型框架无关的运行事件。

浏览器 IM 是展示语义的来源，但 Python 不生成 Thread 序号、消息 ID 或时间戳。
这些通信字段由后续 Go 适配层补齐，避免 Agent 编排依赖 WebSocket 实现。

## 执行链

```text
RunInput
   │
   ▼
ContextBuilder
   │
   ▼
IntentRouter ───────────────► DirectModelRuntime
   │                              简单问候、普通生成
   ▼
AgentRuntime (DeepAgents adapter)
   ├── Skills
   ├── Tool Registry
   ├── knowledge_search (RAG)
   └── Memory
   │
   ▼
Normalized Agent Events
```

当前只实现 `DirectModelRuntime`。意图路由和 DeepAgents Runtime 在真正开始编排开发
时实现，目录中不放返回假结果的占位代码。

意图路由未来使用结构化输出，最小结果为 `direct | agent`，可附带候选 Skills。
显式命令和知识库选择优先走确定性规则；其他输入由 Router 判断。不确定时进入
Agent 路径，避免把需要外部信息的问题误判为普通生成。

## 事件契约

所有 Runtime 都只允许输出以下语义事件：

| Agent 事件 | 含义 | 前端 IM 映射 |
| --- | --- | --- |
| `run.started/completed/failed` | 一次执行的生命周期 | `run.status` |
| `thinking.delta/completed` | 模型明确公开的 Thinking | 同名事件 |
| `content.started/delta/completed` | Assistant 正式回复 | `message.*` |
| `tool.started/completed/failed` | Tool 执行状态 | 同名事件 |

序列化后的事件包含 `runId` 和 `payload`。Go 适配层负责添加 `threadId`、`seqId`、
`timestamp`、`messageId` 等 IM envelope 字段。Python 内部属性使用 snake_case，
序列化边界使用与 IM 一致的 camelCase。

`tool.started` 即“调用中”。同一 `toolCallId` 收到 `tool.completed` 或
`tool.failed` 后进入终态。RAG 在 Agent 看来是名为 `knowledge_search` 的 Tool，
所以前端不需要额外增加第四种执行模块。

Thinking 是可选事件。只有 Provider 明确返回可公开的 reasoning 或 summary 时才
展示；不能把普通 Content 猜成 Thinking，也不应要求模型暴露隐藏思维过程。
模型不支持 Thinking 时，前端仍可根据 `run.status=running` 展示通用加载状态。

## 模型兼容策略

OpenAI-compatible 只说明请求接口相似，不保证以下行为一致：

- Thinking 字段和 content block 格式；
- Tool Call 参数的流式拆分方式；
- 并行 Tool Calls 和 Tool Call ID；
- 空 chunk、usage chunk 和结束原因。

因此模型层分为四部分：

- `catalog`：稳定模型 ID 和环境变量映射；
- `capabilities`：用 `verified / unknown / unsupported` 记录能力；
- `factory`：隔离 LangChain/Provider 客户端创建；
- `streaming`：把厂商 chunk 转成规范化事件数据。

新模型默认只有文本流能力可用。Thinking、Tool Calling 和并行调用必须通过该模型
的契约测试后才能标记为 `verified`。Provider 原始字段不能直接传到前端。

## 后续模块边界

- `graph/`：ContextBuilder、结构化 IntentRouter、主 Agent 图和 DeepAgents 组装。
- `tools/`：Tool contract、registry 和少量展示能力的通用 Tools。第一批计划为
  `web_search` 与 `write_file`。
- `rag/`：知识入库、切分、检索、重排和引用；仅通过 `knowledge_search` 暴露给图。
- `skills/`：采用 `skills/<name>/SKILL.md`，通过描述做渐进式加载，并声明允许使用
  的 Tools。
- `memory/`：Run 短期状态、Thread 会话摘要、数据库长期用户事实三层。
- `artifacts/`：管理 `write_file` 等 Tool 产生的文件元数据和下载引用。
- `prompts/`：集中保存 Router、总结和记忆抽取 Prompt，避免散落在业务代码里。
- `evals/`：保存路由判断、Tool 选择、RAG 引用和记忆召回的可重复场景。

DeepAgents 只能出现在适配和图组装层，不能让它的 chunk、node 或 state 类型进入
HTTP/SSE 协议。启用时显式传入模型、Skills 和 Tool allowlist；不默认开放项目
没有使用的 shell、文件系统或 subagent 工具。
