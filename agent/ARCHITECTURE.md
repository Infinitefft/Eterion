# Eterion Agent 架构

## 目标

`agent/` 是基于 Node.js + TypeScript 的 Agent 推理和编排边界。它负责模型选择、
意图路由、上下文构建、Skills、Tools、RAG 和 Memory，最终输出与模型厂商和 Agent
框架无关的领域事件。

浏览器 IM 是展示语义的来源，但 Agent 不生成 Thread 序号、Message ID 或业务时间戳。
这些通信字段由 Go 适配层补齐，避免编排依赖 WebSocket 实现。

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
AgentRuntime
   ├── Skills
   ├── Tools
   ├── knowledge_search (RAG)
   └── Memory
   │
   ▼
Normalized Agent Events
```

当前只实现 `DirectModelRuntime`。下一阶段优先用 LangChain `createAgent()` 接入
`web_search`，需要显式状态图后再引入 LangGraph，需要 Skills、文件系统和 Subagent
时再评估 Deep Agents，避免为了框架而框架。

## 事件契约

| Agent 事件 | 含义 | 前端 IM 映射 |
| --- | --- | --- |
| `run.started/completed/failed` | 一次执行的生命周期 | `run.status` |
| `thinking.delta/completed` | 模型明确公开的 Thinking | 同名事件 |
| `content.started/delta/completed` | Assistant 正式回复 | `message.*` |
| `tool.started/completed/failed` | Tool 执行状态 | 同名事件 |

SSE data 包含 `runId` 和 `payload`。Go 负责添加 `threadId`、`seqId`、`timestamp`、
`messageId`。`tool.started` 即调用中；同一 `toolCallId` 收到 completed 或 failed 后
进入终态。RAG 使用 `knowledge_search` Tool，因此前端无需增加第四类活动模块。

Thinking 是可选事件。只有 Provider 明确返回可公开 reasoning/summary 时才展示；
模型没有 Thinking 时，前端根据 `run.status=running` 展示通用加载状态。

## 模型兼容策略

OpenAI-compatible 只表示请求接口相似，不保证 Thinking、content block、Tool Call 参数
拆分和并行调用一致。因此模型层继续分为：

- `catalog`：稳定模型 ID 和环境变量映射；
- `capabilities`：`verified / unknown / unsupported` 能力状态；
- `factory`：隔离 LangChain 和 Provider 客户端创建；
- `streaming`：把厂商 chunk 归一化为领域事件数据。

新模型默认只启用文本流。Thinking 和 Tool Calling 必须实际验证后才能标记为
`verified`，Provider 原始字段不能进入前端协议。

## 后续模块边界

- `graph/`：ContextBuilder、结构化 Intent Router 和 Agent 组装。
- `tools/`：少量有代表性的通用 Tool，当前有 `web_search`，下一项为 `write_file`。
- `rag/`：知识入库、检索、重排和引用，通过 `knowledge_search` 暴露。
- `skills/`：标准 `skills/<name>/SKILL.md`，按需渐进式加载。
- `memory/`：Run 短期状态、Thread 会话摘要和数据库长期事实。
- `artifacts/`：管理 Tool 生成的文件元数据和下载引用。
- `prompts/`：集中保存 Router、总结、记忆抽取等 Prompt。
- `evals/`：保存路由、Tool、RAG 和 Memory 的可重复场景。

LangChain、LangGraph 或 Deep Agents 只能出现在图组装和 Runtime 适配层，它们的
chunk、node 和 state 类型不能成为 HTTP/SSE 或前端协议。
