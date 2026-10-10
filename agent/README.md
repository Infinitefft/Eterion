# Eterion Agent

Eterion 的 Node.js + TypeScript Agent 模块。当前 HTTP 服务使用 Agent Runtime：
接收 Go 传入的本轮身份，主动查询原始聊天历史并组装上下文，由模型决定直接回答或调用网页工具，
通过 SSE 输出项目自己的 `run.*`、`thinking.*`、`content.*`、`tool.*` 事件。

`web_search`、`web_fetch` 和 LangChain `createAgent()` 组装已有实现，
`evals/smoke-agent.ts` 可单独调用这条 Tool Calling 链路。
`src/runtime/agent-runtime.ts` 已接入 `POST /runs`，支持文本流、Tool 生命周期、取消和失败收尾。
`createDirectRuntime()` 保留为可手动切换的文本直出基线，没有自动回退路由。
会话 Memory 已接入代码链路，真实模型与数据库联调仍待进行；RAG、Skills 仍待实现。

## 目录与职责

```text
src/
├── index.ts                 服务启动与接线
├── server.ts                HTTP 路由、SSE 编码与连接清理
├── config.ts                环境变量、模型目录与配置校验
├── protocol.ts              请求、领域事件和 Runtime 类型契约
├── memory/
│   ├── load-context.ts      查询历史、恢复并组装本轮模型上下文
│   ├── messages.ts          框架消息的序列化与恢复
│   ├── capture.ts           采集本轮最终上下文
│   └── compaction.ts        自动与主动压缩
├── runtime/
│   ├── create-agent.ts      Agent、Prompt、Tools、Middleware 组装
│   ├── models.ts            模型客户端创建、正文提取
│   ├── direct-runtime.ts    普通模型的流式事件适配
│   └── agent-runtime.ts     Agent 文本流、Tool 状态与运行终态适配
├── recording/              独立监控采集，不参与业务记忆存储
│   ├── with-run-recording.ts Run 生命周期及模型、工具回调采集
│   ├── store.ts            监控 SQLite 数据读写
│   └── tool-input.ts       工具输入的监控记录整理
└── tools/
    ├── web-search.ts        查询博查搜索，返回网页标题、URL 与摘要
    ├── web-fetch.ts         读取公开网页的 HTML 或纯文本
    └── presentation.ts      将工具输出整理为前端展示数据
evals/
└── smoke-agent.ts           真实模型与搜索调用的观察脚本
tests/                      无需真实 API Key 的回归测试
```

组装与执行分开：`src/runtime/create-agent.ts` 决定 Agent 使用什么，Runtime 将执行过程转换成领域事件。
Prompt 直接放在组装处，不再为一段字符串单独建模块。
`createDirectRuntime()` 和 `createAgentRuntime()` 使用普通函数返回对象，
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

首次配置时创建本地 `agent/.env` 并填写所需配置；已有 `.env` 时不要覆盖。
模型 Key 和搜索用的 `BOCHA_API_KEY` 都填写在 `.env`，不放入源码、测试或 README。
搜索固定发送 `summary: true`；模型可通过 `count` 动态选择网页数量（1–50，默认 12），可选填 `freshness`（`YYYY-MM-DD` 或 `YYYY-MM-DD..YYYY-MM-DD`），未指定时不发送日期过滤。
`.env` 应保持 Git 忽略状态；提交前可用 `git check-ignore .env` 检查。

已知模型只有配置了对应 `*_MODEL` 才会启用，并需要对应厂商的 API Key；
`DEFAULT_MODEL_ID` 必须指向已启用模型。不启用已知模型时，可以用
`MODEL_NAME`、`MODEL_API_KEY` 和可选的 `MODEL_BASE_URL` 配置通用模型。
配置读取位置固定为 `agent/.env`，不依赖启动命令所在目录。

本地默认聊天模型为 DeepSeek-Flash，API 模型名使用官方的 `deepseek-flash`。新增配置如下，沿用已有的 `DEEPSEEK_API_KEY` 和可选的 `DEEPSEEK_BASE_URL`，Pro 仍可独立启用：

```dotenv
DEEPSEEK_FLASH_MODEL=deepseek-flash
DEFAULT_MODEL_ID=deepseek-flash
DEEPSEEK_FLASH_CONTEXT_WINDOW=258000
DEEPSEEK_FLASH_AUTO_COMPACT_TOKEN_LIMIT=100000
```

这里沿用现有 Pro 的应用上下文预算，不代表厂商最大窗口；正式回答输出上限为 16384 tokens，摘要和标题为 4096。配置修改后依次重启 Agent、Go API，再刷新前端；Go 在启动时缓存模型目录和默认模型。已有对话中手动选中的模型仍需自行切换。

私人基础提示词放在 `agent/prompts/system.local.md`，由 `.env` 中的
`SYSTEM_PROMPT_FILE=prompts/system.local.md` 指定。首次使用时自行创建
`prompts/system.local.md` 并填写提示词；私人文件已被 Git 忽略。
文件配置优先于原来的 `SYSTEM_PROMPT`，指定文件后若缺失、无法读取或为空，启动会明确报错。
未设置文件路径时仍兼容 `SYSTEM_PROMPT` 和代码默认值。读取后继续追加 `create-agent.ts` 中的工具规则。

`pnpm build` 不复制私人提示词。部署时单独上传文件或挂载到服务器，并设置 `SYSTEM_PROMPT_FILE`；
相对路径始终以 `agent/` 为基准，也支持绝对路径。以后使用 Docker 时应在 `.dockerignore` 中排除此文件。
修改提示词后需重启 Agent。此配置避免随仓库公开；提示词仍会发送给模型，启用本地运行记录时也可能被记录。

```powershell
pnpm dev
```

该命令启动带 Tool Calling 的 Agent 服务，默认监听 `http://127.0.0.1:8001`。
启动需要模型配置和 `BOCHA_API_KEY`；启用模型仍需逐一验证真实流式 Tool Calling 兼容性。
编译结果的运行命令是 `pnpm build` 后执行 `pnpm start`。

`pnpm typecheck` 检查完整源码，`pnpm test` 构建后运行离线回归测试。
这些检查不会调用真实模型或搜索服务；`pnpm dev` 本身不进行完整类型检查。

## 可选本地运行记录

记录默认关闭；启用时使用 Node.js 22.19.0 或以上版本。只需在已有 `agent/.env` 中设置
`AGENT_RECORDING_ENABLED=true`，按需设置 `AGENT_RECORDING_DIR=../.run-records`，然后重启 Agent。
目录相对 `agent/` 解析，与启动位置无关；首次有用户身份的运行会创建 `records.sqlite`。
本次实现没有修改本机 `.env` 或主动启动真实模型调用。

Go 从已保存 Run 的用户归属传入可选 `user_id`，需要重启使用新代码的 Go 服务。
脚本调用 `POST /runs` 时可提供明确的测试用户 ID；旧调用未提供身份时聊天照常执行，跳过记录并提示。
Agent 是本机内部服务，这个字段不替代登录认证，不应接受不可信客户端直接声明身份。

`src/recording/with-run-recording.ts` 负责 Run 生命周期及模型、工具回调，`store.ts` 负责独立 SQLite。
记录包含提问、输入历史、各轮实际模型消息（含 System Prompt）、选定的调用参数、模型输出、
接口公开的推理和用量、时间及状态。数据来自 SDK 消息与回调，不是底层 HTTP 抓包；接口未提供的内容不补造。
片段在内存合并，开始与结束时写入；失败、取消和提前结束保留部分回复。
调用参数使用字段白名单，写入前脱敏；记录异常只打印简短提示，不改变对外业务事件。
若进程被强制终止或存储中途失败，可能留下没有终态的不完整记录。

数据库独立于业务数据库和监控页面，平台不启动也能记录；业务不引用平台代码。
已接入模型及逐次工具记录；Skills、RAG、平台查询和删除仍待后续阶段。

工具记录保留模型原始参数、工具入口的实际参数、完整 ToolMessage、错误与起止时间。
每次调用通过模型调用 ID、toolCallId 与框架执行 ID 关联，同名和并行调用各自保存。
参数解析/校验失败、未知工具、额度拦截记为未执行；真实执行失败与 Run 最终失败分开，
取消单列。统计时只有实际执行的成功、失败进入成功率分母；未结束或执行事实缺失不推测为成功。
`tool-input.ts` 用框架内部事件采集校验后的参数，现有两个工具已接入，不产生新的 SSE 事件。
后续新工具仍可通过通用回调记录结果；若需要准确的转换后参数，也应在函数入口调用此观察函数。

离线最小验证：`pnpm check:record-store`、`pnpm check:model-recording`、`pnpm check:tool-recording`。
使用假配置、本地模拟模型和临时数据库，结束后自动清理；不读取 `.env`、不调用真实模型。
Node.js 22.19.0 会显示 SQLite 实验性 API 提示。

## 服务契约

- `GET /healthz`：返回 `{ "status": "ok" }`。
- `GET /models`：返回 `default_model_id` 与公开模型目录，不返回 Key 或服务端连接配置。
- `POST /runs`：校验请求后返回 `text/event-stream`；参数不合法时返回 HTTP 400 和 `INVALID_RUN_INPUT`。

`POST /runs` 请求示例，`model_id` 需替换为已启用模型：

```json
{
  "run_id": "run-1",
  "user_id": "test-user-1",
  "thread_id": "thread-1",
  "model_id": "deepseek-v4-pro",
  "messages": [{ "role": "user", "content": "你好" }]
}
```

以上 `messages` 形式保留给独立脚本和直接调用；非空且最后一条必须来自 user。
平台 Go 请求改为传入 `run_id`、`user_id`、`thread_id`、`model_id`、`input_message_id`、`history_token`，不再推送完整历史。
Node 的 `memory/load-context.ts` 通过 `GO_API_BASE_URL`（默认 `http://127.0.0.1:8080`）分页查询
`GET /internal/agent/runs/:runId/messages`，在 Authorization Bearer 头中携带本轮凭证。
Go 根据活动 Run 校验访问范围，按时间和 ID 返回截至本轮输入的原始消息，每页最多 100 条。
凭证只授权当前 Run，执行结束后失效，不进入模型输入和 SQLite 运行记录。

当前 Node 在首次读取时携带 `context=1`：Go 返回最近成功回答的 `agent_context` 和它之后的历史。
Node 恢复已保存的框架消息，再从新增历史中选择非空、已完成的 user/assistant 消息。
没有已保存上下文的旧会话继续读取所有历史页；后续分页通过 `after` 游标继续，不重复读取快照。
本轮输入已在历史中，不重复追加；缺失本轮输入或查询失败会产生 `AGENT_CONTEXT_LOAD_FAILED`，不静默退化成单轮回答。
整个历史加载阶段最多 30 秒，支持调用方取消。System Prompt 仍由 Agent 组装。
成功的 `run.completed` 内部事件携带 `agentContext`；Go 与消息、Run 完成状态在同一事务中保存，
前端事件不携带此数组。Direct 基线不保存框架上下文。业务数据全部使用 PostgreSQL，不依赖监控数据库。
Go 继续负责业务消息持久化、资源归属、Run 展示状态和 IM 事件，Node 不直连 Go 的业务数据库。
升级时需同时重启 Node Agent 与 Go API；若 Go 端口不同，应同步设置 `GO_API_BASE_URL`。

## HITL：询问用户、暂停与恢复

`ask_user` 使用 LangGraph `interrupt()`，继续沿用 `createAgent()`，没有自定义状态图。
问题 Schema、工具定义和答案校验集中在 `src/tools/ask-user.ts`。

一次业务 Run 可以跨多段 HTTP/SSE：

```text
模型调用 ask_user → interrupt → MemorySaver 保存检查点
  → Node run.paused → Go 保存问题和 waiting_user → WebSocket 表单
用户回答 → interaction.respond → Go 校验、接收回答
  → POST /runs/resume → Command({ resume }) → 工具返回答案
  → 框架创建 ToolMessage → 模型继续 → 原消息完成
```

- LangGraph `configurable.thread_id` 使用业务 `run_id`，不是会话 ID；跨轮历史仍由原有 `agent_context` 管理。
- `POST /runs/resume` 接收 `run_id`、`user_id`、`thread_id`、`interaction_id`、`answers`。恢复不重新加载历史。
- `run.paused` 是当前 SSE 段的结束，不是业务 Run 终态；`run.resumed` 后不再发送 `content.started`，保留正文和工具 ID。
- 检查点中若有多个待回答中断，当前逐个展示和恢复，不建设并行审批界面。
- Go 保留原 Run 的 goroutine，等待回答 channel 或取消信号；暂停期间没有 Node SSE 或模型请求。Node 累计各执行段的超时预算，等待用户不计入。
- 回答先校验归属、问题 ID、选项与必填项；已接收的同答案重试不会再次恢复。ACK 仅表示接收，UI 状态以交互事件和 `run.status` 为准。
- 取消沿用 `run.cancel`，结束消息和工具，禁用问题表单，并通过内部 `POST /runs/discard` 清理检查点。
- 本地 SQLite 运行记录暂停时不结束 Run、不把 interrupt 记为失败，恢复续写同一条记录；其 `running` 表示尚未结束（包含等待用户）。

第一版只保证同一组 Node/Go 进程存活期间的恢复。刷新浏览器可通过已有快照恢复问题；Node 或 Go 重启后不支持断点续跑，提交旧回答会结束失效任务，也可以直接取消。
检查点不是业务数据库持久化，也没有引入队列、分布式恢复或新业务表。

Review 顺序：`tools/ask-user.ts` → `runtime/create-agent.ts` → `runtime/agent-runtime.ts` 中的 `prepareResume`、`stream` → `server.ts`。

### 新对话标题

新会话首条消息先沿用正文前 30 字作为临时标题。Go 在确认 `thread.start` 后并行调用内部 `POST /title`，使用该轮选择的模型根据首条消息生成简短标题，通常 6–16 个汉字，最多 32 字符；不使用 Tools、不写入模型对话上下文、不进入回答流。成功后保存标题并复用 `thread.updated` 更新侧边栏，刷新后也保留。模型超时或失败时保留临时标题，不重试、不影响回答；重复提交不再触发生成，用户已改成其他标题或删除会话时丢弃结果。

标题请求最长 30 秒，首条消息最多取 4000 字符。该能力需要重启 Go 服务加载代码；Agent 若使用编译产物启动，也需要重新构建并重启。当前仅通过类型和编译检查，尚未验证真实模型生成效果。

### 固定会话开始时间

需要本轮准确时间时，模型可调用静默工具 `get_turn_time`。Go 内部历史接口通过 `input_message_created_at` 返回本轮输入消息的数据库创建时间，Agent 只通过运行 context 传给工具，不在每轮消息前添加变化的时间。工具返回 UTC、本地时间（`Asia/Shanghai`）和毫秒时间戳；不触发 interrupt，也不发送前端工具展示事件，但保留 ToolMessage 和内部记录。HITL 恢复沿用原轮次时间。该时间是服务端收到并创建消息的时间，不是浏览器点击发送或工具执行的时刻。独立脚本如需使用该工具，应在 `/runs` 输入中提供 `input_message_created_at`；缺失时工具报错，不伪造时间。

Go 内部历史、压缩和用量接口通过 `session_started_at` 传递会话创建时间（Unix 毫秒），不新增数据库字段。Agent 从原始历史构建上下文时，只给首条用户模型消息添加按 `Asia/Shanghai` 格式化的时间字符串；业务消息正文和前端展示不变。后续直接恢复上下文，不刷新时间或重复注入，HITL 恢复也沿用检查点。

时间同时保存在消息元数据中；自动或手动压缩移除原消息时，由代码将原时间附加到摘要，避免依赖模型复述。普通续聊不会因时间变化改写历史前缀，但上下文压缩仍会改变前缀，不保证模型服务的缓存命中。已有旧上下文快照不补写时间；直接提供 `messages` 的独立脚本仍由调用方管理上下文。

本次仅执行 Agent 类型检查和 Go 编译检查，尚未进行真实模型端到端验证。
Go 对应 `run_manager.go`、`interaction.go`、`repository.go`；前端复用 `AgentRunTrace.tsx` 表单。

本次验证为 Agent/前端类型检查及 Go 编译；未运行自动化测试或真实模型端到端联调。
待联调：正常回答与继续生成、可选题空回答、必填/选项错误、重复提交、暂停时刷新、暂停时取消、进程重启后的旧回答、多次连续提问。

## 会话上下文与压缩

启动新后端前，按仓库已有 goose 流程应用 `services/api/migrations/00007_add_agent_context.sql`。
它增加可空的 `messages.agent_context JSONB`，旧数据无需回填。迁移文件已提供，本次开发未连接数据库执行迁移。

- 每轮成功结束后保存完整消息数组，包括摘要、未压缩历史、工具调用与结果、最终回答。
- 自动压缩在每次主模型调用前执行。窗口预算与压缩阈值分别配置，通用默认值为
  `MODEL_CONTEXT_WINDOW=32768`，未配置压缩阈值时取 `min(20000, 窗口 - 20480)`，默认窗口下为 `12288`。
  模型专属的 `*_CONTEXT_WINDOW`、`*_AUTO_COMPACT_TOKEN_LIMIT` 优先于通用值；
  窗口是应用预算，不是厂商最大窗口，必须不超过实际模型容量。
- DeepSeek V4 Pro 可通过模型专属环境变量配置 `258000` 窗口和 `180000` 总输入压缩阈值。
  总输入包含历史、系统提示词和工具定义；中间件仅统计历史，因此使用“总输入阈值减固定输入”触发，
  不再乘以 80%。其他模型暂用通用预算，确认各自容量后再覆盖。
- 258k 与 180k 间的 78k 是初始增长缓冲。提高主模型输出上限后，不能保证它同时容纳
  最大输出、大网页正文及摘要开销；多份大工具结果或超长用户输入仍可能超过预算。
  当前 token 估算不是 tokenizer 的实测结论。
- 主模型输出上限为 16384 tokens，摘要和标题保持 4096。摘要使用同一模型配置的独立无工具客户端，
  保留约 1500 汉字以内的目标。配置至少预留 20480 tokens 给主输出和基础安全余量；
  主提示词或工具定义过大、导致历史阈值不足 4096 时，启动报错而不是忽略配置。
- 默认保留最近 10 条消息；近期内容过大时缩小目标窗口，工具配对边界由内置实现调整。
  手动压缩短会话时目标保留约一半消息（最多 10 条、至少 2 条），没有可压缩内容或没有缩小则返回无需压缩。
- token 数为偏保守的字符估算，不是模型 tokenizer 的精确计数；System Prompt 不进入摘要。
- 使用内置 `summarizationMiddleware`，通过 `patches/langchain@1.5.10.patch` 修正吞异常行为，
  pnpm 安装时自动应用。升级 LangChain 时需要重新核对该补丁。
- 禁用内置默认的静默摘要前裁剪。只有摘要请求明确超限时，才截掉最旧的一半消息并按工具边界调整，
  保留最近用户请求，再尝试一次摘要。失败、空摘要或无效结果不替换上下文；取消信号传递到摘要调用。
- 主模型在摘要后仍超限时明确失败，不再循环压缩。截断成功会通过完成事件提醒前端；该提示不改变原聊天正文。

用户通过输入框工具栏的“压缩上下文”按钮主动触发：

```text
POST /api/chat/:id/context/compact  { "model_id": "可选模型 ID" }
→ Go 鉴权、锁定空闲会话、读取上下文
→ POST /context/compact（Agent 内部接口）
→ Go 更新最近成功 assistant 的 agent_context
→ { data: { changed: boolean, truncated: boolean } }
```

手动压缩只覆盖截至最近成功助手消息的内容，不把其后的失败轮次写入较早边界。
若没有成功回答则无需压缩。Go 用有界事务持有会话行锁，最多等待 Agent 5 分钟；
压缩期间新消息提交和另一次压缩返回忙碌，失败时事务回滚。页面离开时取消请求。
Agent `/runs` 与 `/context/compact` 都只应放在本机或可信服务网络，浏览器必须通过 Go 鉴权入口访问。

### 验证状态与待联调场景

只执行类型／编译检查，未新增或执行测试脚本，也未调用真实模型。以下场景仍需要用户安排联调：

1. 新会话保存上下文，下一轮和重新进入历史会话时恢复，消息不重复。
2. 多次工具调用期间自动压缩；随后继续执行，最终保存摘要和新增工具消息。
3. 主动压缩成功、无需压缩、会话忙碌、失败与取消；原始聊天正文不变。
4. 摘要超限的一次截断重试、空摘要与普通网络错误不替换旧上下文。
5. 多会话同时运行互不影响；关闭监控记录后以上业务仍可运行。

不调用工具时，成功事件按顺序输出：

```text
run.started → content.started → content.delta（多次）→ content.completed → run.completed
```

事件类型写在 SSE 的 `event` 字段，`data` 固定为 `{ "runId": "...", "payload": {} }`。
工具调用期间还会交错输出 `tool.started` 和对应的 `tool.completed` 或 `tool.failed`。
失败以 `run.failed` 结束；模型调用失败、超时或无有效最终答复会先用
`content.completed` 的 `status: "failed"` 结束已开始的内容块。
心跳使用 SSE 注释，不属于领域事件。

`protocol.ts` 已定义以下契约；定义存在不代表全部接入完成：

| 事件 | 用途 | 当前状态 |
| --- | --- | --- |
| `run.started/completed/failed` | 一次执行的生命周期 | Direct、Agent Runtime 已使用 |
| `content.started/delta/completed` | 正式回复内容 | Direct、Agent Runtime 已使用 |
| `tool.started/completed/failed` | 工具调用与终态 | Agent Runtime、HTTP SSE 已接入，Go/前端待适配 |
| `thinking.delta/completed` | 模型明确公开的思考摘要 | 可选能力，未接入 |

后续 Go 适配层负责补齐 `threadId`、`seqId`、`timestamp`、`messageId`，
并将 `content.*` 映射为前端 `message.*`。模型厂商原始 chunk、框架状态和隐藏推理不能进入前端协议。
Tool 三种状态必须通过同一 `toolCallId` 关联；Tool 失败与整个 Run 失败不能混为一谈。
`presentation.ts` 保留这个展示边界，网页完整正文用于模型上下文，不直接推送前端。

Agent Runtime 同时消费 LangChain 的 `messages` 和 `updates`：前者输出正文增量，
后者提供完整 Tool Call 和 ToolMessage。只在模型节点登记新调用，完成后从活动调用表删除，
避免 Middleware 携带历史消息时重复发送工具事件。框架负责 Agent Loop，Runtime 不手动执行工具。
模型调用上限为 6 次，工具调用上限为 10 次；图步数另设 50，因为 Middleware 也占用图步数。
工具失败允许模型继续回答；整轮超时、执行异常或没有有效最终答复时，收尾未完成工具和正文，再发送 `run.failed`。

### 取消与连接生命周期

`AgentRuntime.stream(input, signal?)` 的第二个参数是进程内取消信号，不属于 HTTP 请求 JSON。
HTTP 响应连接提前关闭时，服务层立即取消当前 Run，不等待下一条模型或 Tool 事件；
正常响应结束不作为取消。每个请求独立持有 Controller，结束时清理心跳和关闭事件监听器。

Runtime 将外部信号与自身超时信号合并，再传给模型和 Tools，使用最先取消的原因区分终态：

- 主动取消：`AGENT_RUN_CANCELLED`，`retryable: false`，不记录故障日志。
- Agent 总超时：`AGENT_RUN_TIMEOUT`，`retryable: true`。
- Direct 超时：保留原有 `MODEL_REQUEST_FAILED` 与“模型调用超时”提示。

主动取消仍沿用 `run.failed` 终态，通过错误码区分，不代表服务故障。
若直接消费 Runtime，仍能收到已发送正文和未完成工具的收尾事件；
若 HTTP 已断开，则不会向失效连接继续发送，Go/前端需维护自己的停止状态。
这不是浏览器断线策略或新的取消接口；后续 Go 需要在决定停止任务时取消上游 HTTP 请求。

## 验证与已知限制

2026-09-11：本轮功能代码已通过类型检查和构建，未读取 `.env` 或使用真实 Key 调用外部服务。
本轮新增的取消链路测试已撤回，原有测试保留。当前优先完成功能，不主动新增或运行测试；
待功能完成、前后端调通后，由用户统一安排验证，不能把编译通过视为整体链路已验收。

离线测试使用脚本化假模型和模拟 HTTP 响应，验证 Runtime 事件与取消信号的行为。
它们不能证明真实模型的工具选择质量或厂商的流式 Tool Calling 兼容性，仍需后续真实调用验证。
当前框架在工具额度耗尽、后续调用全部被阻止时，可能不再请求模型总结；
Runtime 会将没有最终答复的情况标为 `AGENT_INCOMPLETE_RESPONSE`，不会伪装成成功。

观察真实 Tool Calling 可执行：

```powershell
pnpm eval:agent
pnpm eval:agent "只搜索 LangChain 的官方资料，给我几个链接，不读取网页正文"
```

这不是离线测试：会使用默认模型和博查搜索 Key，访问外网并可能产生费用。
它在 `invoke()` 结束后打印 Tool 调用、结果状态和模型回复，不会实时输出 SSE 事件。
没有最终有效回答、工具失败或达到调用上限时，不能只凭进程退出判断任务成功。
模型的 Tool Calling 能力必须按实际参数、连续调用、失败与流式场景验证；
OpenAI-compatible 接口相似并不意味着这些行为一致，当前也没有自动能力探测或回退路由。

`web_fetch` 不执行网页 JavaScript、不自动跟随重定向、不支持 PDF。
现有 DNS/内网检查是基础防护，并未绑定检查后的 IP 到实际连接；
2 MB 检查也不是下载过程中的硬上限。总 Run 取消信号已传给 Tools 的 fetch，
同时保留单次请求超时；DNS 预检本身不支持这个取消信号。
不将当前工具描述成适合直接暴露到公网的完整安全边界。

## 后续开发与参与方式

后续由 Go 适配 Agent 事件并接入前端展示，功能完成后再统一进行前后端联调与真实模型效果验证。
模型根据 Prompt、Tool description 和参数 Schema 决定是否调用工具；
少量工具阶段不额外建立 Intent Router、ContextBuilder 或动态 Registry。

- 评估：按 `AGENTS.md` 的固定场景覆盖直接回复、仅搜索、搜索后阅读、参数错误、网络失败、内网拒绝和网页指令干扰，记录完成质量、延迟与成本。RAG/Memory 实现后再补引用和召回评估。
- Memory：计划区分 Run 短期状态、Thread 历史与摘要、数据库长期事实；再明确每层的读写、更新、淘汰和错误记忆处理，不把数据库逻辑分散进 Prompt。
- RAG：已通过 `knowledge_search` 接入向量召回、重排和来源展示；当前检索规则见下节。
- Skills：有真实任务后再加入 `skills/<name>/SKILL.md` 和可选 references，声明名称、描述与需要的工具，按需加载，不提前创建空模块。
- 文件产物：若后续加入写文件工具，再管理元数据与下载引用，不向调用方暴露任意本地绝对路径。

用户重点参与 Agent 编排、Tools 调用、RAG、Skills、Memory 和评估核心的设计与实现。
环境配置、入口接线、重复类型、普通 mock、基础测试和文档同步可以由编码代理完成。
本轮经用户授权接入 Agent 服务及取消链路，并保留核心逻辑注释；完整协作要求以 [AGENTS.md](AGENTS.md) 为准。

## RAG 候选重排与阈值过滤（2026-10-04）

2026-10-05 切分实验：完整 Embedding 输入预算调整为 256 个代理 token（含标题路径），overlap 继续按正文预算的 12.5%，当前目标最多 32。切分与 Embedding 校验、监控共用预算常量。已有文件需重新入库才会生效；本次没有自动重建索引，后续使用同一批约 10 条问题比较效果。

2026-10-10 当前链路为：当前用户范围向量 Top 20 + PostgreSQL BM25 Top 20 → 按 Chunk ID 去重并用 RRF 取 Top 20 → qwen3-rerank → 分数 ≥ 阈值 → 最多返回 5 个 Chunk。切分和 Embedding 模型不变；已有 Chunk 不自动补建 BM25 索引数据，仍可走向量召回，新上传才同时参与两路检索。

在 `agent/.env` 显式配置以下字段（进程环境优先）：

```dotenv
RERANK_API_KEY=<同业务空间的阿里百炼 Key>
RERANK_URL=https://<WorkspaceId>.cn-beijing.maas.aliyuncs.com/compatible-api/v1/reranks
RERANK_SCORE_THRESHOLD=0.5
```

重排使用原 query 和每个候选的“标题路径 + 正文”，不发送完整历史；模型固定为 `qwen3-rerank`，默认问答检索任务。原生 HTTP 协议将 query/documents/top_n 放在顶层，读取顶层 results，通过 index 对齐候选。同分保留 RRF 候选顺序；最多返回 5 个，允许为空，不补充低分片段。

Key 和完整 URL 不从 Embedding 配置推导；配置在首次检索时校验，缺失不影响普通聊天和文件入库。阈值允许 0～1，默认 0.5 只是实验起点，不能把重排分数当作跨请求的绝对置信度。单次请求含响应读取限时 30 秒，响应 Run 取消，无自动重试；故障按工具失败处理，不回退到未重排候选。无候选不请求重排，正常空结果包含资料不足提醒，不要求模型重复同一查询。

监控在现有工具 metadata 中记录 BM25、RRF、重排与过滤阶段、耗时、阈值、两路候选/去重/达标/最终数量，以及候选 ID、两路原始分数与名次、RRF 分数和是否进入重排；不新增表。只有最终片段进入 ToolMessage 和现有三项评测，融合诊断不进入回答模型，前端来源协议不变。被过滤正文不送入回答模型，重排 Key 纳入脱敏。

### BM25 与 RRF 的实现和取舍

当前 `knowledge_search` 为严格空参数工具，模型只决定是否调用，调用参数为 `{}`。Runtime 从 `input.messages` 最后一条用户消息读取原文，通过每次调用的 `originalQuestion` 上下文传给工具，向量 Embedding、BM25 和 rerank 使用同一份原文，保留空白，不改写或截断；2048 代理 token 的查询预算保持不变，超出时仍报错。缺少身份或非空白原始问题时工具失败，不回退到模型参数。普通聊天不要求存在该字段。

同一 Run 暂停恢复沿用最初的问题，不拼接澄清回答或压缩摘要；新回合使用新问题。提示词禁止为改写关键词或补充子问题重复调用，本版不增加调用拦截、缓存、多轮指代消解或子问题检索。监控保留模型请求参数 `{}`，实际执行参数记录 `{ query, querySource: "original_question" }`；输出仍是 `{ query, results }` 和现有空结果提醒，评分规则及检索参数不变。该实验适用于当前独立问题评测集，人工核验原文传递、并发 Run 隔离、缺少问题失败及暂停恢复行为，再用同组约 10 条问题做 A/B。由用户自行重启 Agent，不自动占用 8001。

- 部署先完成根 README 的扩展镜像和第 11 版迁移，无需新增 API Key。`search_text` 与向量在同一入库事务中写入；扩展负责持久化及删除同步，不维护 Agent 内存索引。
- `pg_search 0.26.1` 使用 Jieba `search_mode=true` 索引标题路径和正文。查询用参数化 `|||` OR 匹配，自动沿用索引分词器，不解析用户搜索语法，不启用模糊匹配、同义词、自定义词典或实体硬过滤。
- 两路都先按业务表限定用户，再按分数和 Chunk ID 取 20 条。BM25 使用共享索引词频统计，不按用户建立独立词频库。BM25 不保证对象绝对一致，需检查实际人名分词及命中。
- RRF 两路等权，`score = Σ 1 / (60 + rank)`，名次从 1 开始，未召回的一路贡献为 0；同分按 Chunk ID，融合后取 20 条。它是排序分数，不能使用 0.5 阈值；阈值只用于 rerank。
- BM25 零命中时向量候选继续融合；两路皆空跳过 rerank。任何检索或重排故障都返回工具错误，不静默降级；沿用 SQL 30 秒超时及取消后不交付结果的语义。
- BM25 独有候选没有 `cosineDistance`，监控允许该字段缺失；最终 ToolMessage 不增加 BM25/RRF 分数或名次，已有重排分数与来源保持不变。
- 本次仅运行必要类型/编译检查，不运行自动测试脚本。后续统一验收上传、删除、替换、重启保留、权限隔离、两路去重和上限、空结果、失败与取消、来源偏移。固定约 10 条独立问题做 A/B，同时核查关键证据是否被 RRF 提前淘汰，不承诺指标增幅。

2026-10-10 本机部署核验：升级前备份已保存至 `storage/db-backups/eterion-before-bm25-20261010.dump`，镜像构建与第 11 版迁移成功；数据库确认 `vector 0.8.6`、`pg_search 0.26.1`，BM25 索引有效且 ready。已有 650 条 Chunk 的 `search_text` 均为空，未补建旧数据。实际分词保留完整“宋知雨”，并识别九月、实习、正式、奖励；带用户权限的 BM25 查询可执行，目前零命中符合旧数据未补建的状态。Agent/监控类型检查及 Agent 构建通过；尚未验收新上传资料的正向召回、端到端对话或评测增幅。

离线验证：`pnpm test`、`pnpm check:rag-search-recording`；监控执行 `pnpm typecheck`、`pnpm check:rag-search`、`pnpm check:rag-evaluation`。2026-10-04 最小真实接口验证使用两段合成文本，确认端点/权限和 0.5 过滤可用；未重跑用户评测集，不承诺指标提升。全量测试中原有 4 项 Agent Runtime 断言失败已在修改前 HEAD 复现，涉及上下文终态和工具上限，与重排无关。
