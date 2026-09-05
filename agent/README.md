# Eterion Agent

Eterion 的 Node.js + TypeScript Agent 模块。当前 HTTP 服务使用 Direct Runtime：
接收调用方传入的对话历史，调用模型，通过 SSE 输出项目自己的 `run.*`、`content.*` 事件。

`web_search`、`web_fetch` 和 LangChain `createAgent()` 组装已有实现，
`evals/smoke-agent.ts` 可单独调用这条 Tool Calling 链路。
`src/runtime/agent.ts` 是尚未完成的流式适配草稿，**没有接入 HTTP 服务**。
Memory、RAG、Skills 及完整前端 Tool 状态链路仍待实现，不能将一次脚本调用视为这些能力已完成。

## 目录与职责

```text
src/
├── index.ts                 服务启动与接线
├── server.ts                HTTP 路由、SSE 编码与连接清理
├── config.ts                环境变量、模型目录与配置校验
├── models.ts                模型客户端创建、正文提取
├── agent.ts                 Agent、Prompt、Tools、Middleware 组装
├── protocol.ts              请求、领域事件和 Runtime 类型契约
├── runtime/
│   ├── direct.ts            普通模型的流式事件适配
│   └── agent.ts             Agent 流式事件适配（未完成草稿）
└── tools/
    ├── web-search.ts        查询千帆搜索，返回相关网页标题与 URL
    ├── web-fetch.ts         读取公开网页的 HTML 或纯文本
    └── presentation.ts      将工具输出整理为前端展示数据
evals/
└── smoke-agent.ts           真实模型与搜索调用的观察脚本
tests/                      无需真实 API Key 的回归测试
```

组装与执行分开：`src/agent.ts` 决定 Agent 使用什么，Runtime 将执行过程转换成领域事件。
Prompt 直接放在组装处，不再为一段字符串单独建模块。
`createDirectRuntime()` 和草稿中的 `createAgentRuntime()` 使用普通函数返回对象，
配置与客户端由闭包持有；每轮运行的可变状态放在 `stream()` 内，不能在会话之间共享。
`AgentRuntime` interface 只约束 HTTP 需要的形状，不要求 class、继承或空的生命周期方法。

现有异步生成器逐个交付事件，SSE 使用 `for await` 消费；无需额外回调队列。
必要的输入校验、超时、工具循环限制、URL 安全检查和公开字段过滤仍保留。
只调用一次的简单逻辑就地表达，有复用或独立边界职责的函数继续保留。

## 配置与运行

需要 Node.js 22.12+、pnpm 10.20+。以下命令均在 `D:\Eterion\agent` 中执行：

```powershell
pnpm install
```

首次配置时根据 `.env.example` 创建 `agent/.env`；已有 `.env` 时不要覆盖。
模型 Key 和搜索用的 `QIANFAN_API_KEY` 都填写在 `.env`，不放入源码、测试或 README。
`.env` 应保持 Git 忽略状态；提交前可用 `git check-ignore .env` 检查。

已知模型只有配置了对应 `*_MODEL` 才会启用，并需要对应厂商的 API Key；
`DEFAULT_MODEL_ID` 必须指向已启用模型。不启用已知模型时，可以用
`MODEL_NAME`、`MODEL_API_KEY` 和可选的 `MODEL_BASE_URL` 配置通用模型。
配置读取位置固定为 `agent/.env`，不依赖启动命令所在目录。

```powershell
pnpm dev
```

该命令启动 Direct 服务，默认监听 `http://127.0.0.1:8001`，**不是启动 Tool Calling Runtime**。
编译结果的运行命令是 `pnpm build` 后执行 `pnpm start`。

当前草稿保留了原有语法错误和未完成逻辑，会阻断 `pnpm typecheck`、`pnpm build`，
也会阻断先构建再执行测试的 `pnpm test`。`pnpm dev` 不导入此草稿，但它不是完整类型检查。
后续继续开发编排时再修复草稿，不通过排除文件或空实现掩盖这个状态。

## 服务契约

- `GET /healthz`：返回 `{ "status": "ok" }`。
- `GET /models`：返回 `default_model_id` 与公开模型目录，不返回 Key 或服务端连接配置。
- `POST /runs`：校验请求后返回 `text/event-stream`；参数不合法时返回 HTTP 400 和 `INVALID_RUN_INPUT`。

`POST /runs` 请求示例，`model_id` 需替换为已启用模型：

```json
{
  "run_id": "run-1",
  "thread_id": "thread-1",
  "model_id": "deepseek-v4-pro",
  "messages": [{ "role": "user", "content": "你好" }]
}
```

`messages` 非空且最后一条必须来自 user；只接受 user/assistant 历史，
System Prompt 由 Agent 自己构建。目前 Thread 历史由调用方传入，Agent 不自动加载或持久化记忆。

Direct 成功时按顺序输出：

```text
run.started → content.started → content.delta（多次）→ content.completed → run.completed
```

事件类型写在 SSE 的 `event` 字段，`data` 固定为 `{ "runId": "...", "payload": {} }`。
失败以 `run.failed` 结束；Direct 的模型调用失败、超时或空回复会先用
`content.completed` 的 `status: "failed"` 结束已开始的内容块。
心跳使用 SSE 注释，不属于领域事件。

`protocol.ts` 已定义以下契约；定义存在不代表全部接入完成：

| 事件 | 用途 | 当前状态 |
| --- | --- | --- |
| `run.started/completed/failed` | 一次执行的生命周期 | Direct 已使用 |
| `content.started/delta/completed` | 正式回复内容 | Direct 已使用 |
| `tool.started/completed/failed` | 工具调用与终态 | Agent Runtime 待完成 |
| `thinking.delta/completed` | 模型明确公开的思考摘要 | 可选能力，未接入 |

后续 Go 适配层负责补齐 `threadId`、`seqId`、`timestamp`、`messageId`，
并将 `content.*` 映射为前端 `message.*`。模型厂商原始 chunk、框架状态和隐藏推理不能进入前端协议。
Tool 三种状态必须通过同一 `toolCallId` 关联；Tool 失败与整个 Run 失败不能混为一谈。
`presentation.ts` 保留这个展示边界，网页完整正文用于模型上下文，不直接推送前端。

## 验证与已知限制

`pnpm typecheck` 检查源码，`pnpm test` 构建后运行本地回归测试；当前草稿造成的阻断见上文。

本轮架构整理验证（2026-09-05）：已完成模块按现有严格选项定向编译通过，
评估脚本单独静态检查通过，22 项本地回归测试通过，未使用真实 Key 或访问外部服务。
定向检查未包含未完成草稿，也没有修改 `tsconfig.json` 排除它；这些结果不代表全量构建或完整 Agent 编排已通过验证。

观察真实 Tool Calling 可执行：

```powershell
pnpm eval:agent
pnpm eval:agent "只搜索 LangChain 的官方资料，给我几个链接，不读取网页正文"
```

这不是离线测试：会使用默认模型和千帆搜索 Key，访问外网并可能产生费用。
它在 `invoke()` 结束后打印 Tool 调用、结果状态和模型回复，不会实时输出 SSE 事件。
没有最终有效回答、工具失败或达到调用上限时，不能只凭进程退出判断任务成功。
模型的 Tool Calling 能力必须按实际参数、连续调用、失败与流式场景验证；
OpenAI-compatible 接口相似并不意味着这些行为一致，当前也没有自动能力探测或回退路由。

`web_fetch` 不执行网页 JavaScript、不自动跟随重定向、不支持 PDF。
现有 DNS/内网检查是基础防护，并未绑定检查后的 IP 到实际连接；
2 MB 检查也不是下载过程中的硬上限。总 Run 取消向 Tools 的传递仍待编排实现，
不将当前工具描述成适合直接暴露到公网的完整安全边界。

## 后续开发与参与方式

先由用户继续实现 Runtime 事件映射、Tool 生命周期和失败收敛，再接入 HTTP、Go 和前端。
模型根据 Prompt、Tool description 和参数 Schema 决定是否调用工具；
少量工具阶段不额外建立 Intent Router、ContextBuilder 或动态 Registry。

- 评估：按 `AGENTS.md` 的固定场景覆盖直接回复、仅搜索、搜索后阅读、参数错误、网络失败、内网拒绝和网页指令干扰，记录完成质量、延迟与成本。RAG/Memory 实现后再补引用和召回评估。
- Memory：计划区分 Run 短期状态、Thread 历史与摘要、数据库长期事实；再明确每层的读写、更新、淘汰和错误记忆处理，不把数据库逻辑分散进 Prompt。
- RAG：计划通过 `knowledge_search` Tool 暴露；检索、重排和引用等步骤按明确问题逐步实现。
- Skills：有真实任务后再加入 `skills/<name>/SKILL.md` 和可选 references，声明名称、描述与需要的工具，按需加载，不提前创建空模块。
- 文件产物：若后续加入写文件工具，再管理元数据与下载引用，不向调用方暴露任意本地绝对路径。

用户重点参与 Agent 编排、Tools 调用、RAG、Skills、Memory 和评估核心的设计与实现。
环境配置、入口接线、重复类型、普通 mock、基础测试和文档同步可以由编码代理完成。
本轮只整理已有实现和架构，不代写尚未完成的核心逻辑；完整协作要求以 [AGENTS.md](AGENTS.md) 为准。
