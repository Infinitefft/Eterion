# Eterion Agent

Eterion 的独立 Node.js + TypeScript Agent 服务。当前提供可运行的 Direct Runtime：
接收完整对话、调用 OpenAI-compatible 模型，并通过 SSE 输出规范化 `run/content`
事件。

项目已经为意图路由、Tools、Skills、RAG、Memory 和后续 Deep Agents 适配建立边界，
但不会为尚未实现的能力返回模拟结果。详细设计见
[ARCHITECTURE.md](ARCHITECTURE.md)。

## 环境

- Node.js 22.12 或更高版本
- pnpm 10.20 或更高版本

## 安装

```powershell
Set-Location agent
pnpm install
Copy-Item .env.example .env
```

在 `.env` 中只保留需要启用的模型并填写真实 API Key。一个模型只有配置了对应
`*_MODEL` 才会进入模型目录，`DEFAULT_MODEL_ID` 必须指向已启用模型。

## 启动

开发模式：

```powershell
Set-Location agent
pnpm dev
```

构建并运行编译结果：

```powershell
Set-Location agent
pnpm build
pnpm start
```

默认监听 `http://127.0.0.1:8001`，内部接口为：

- `GET /healthz`
- `GET /models`
- `POST /runs`，响应类型为 `text/event-stream`

`POST /runs` 当前请求示例：

```json
{
  "run_id": "run-1",
  "thread_id": "thread-1",
  "model_id": "deepseek-v4-pro",
  "messages": [{ "role": "user", "content": "你好" }]
}
```

Direct Runtime 成功时依次输出：

```text
run.started
content.started
content.delta (0..n)
content.completed
run.completed
```

每个 SSE data 都采用 `{ "runId": "...", "payload": {} }`。错误以
`run.failed` 结束；若 Content 已经开始，会先输出失败状态的
`content.completed`，避免调用方留下永久生成中的内容块。

## 当前结构

```text
src/
├── api/          Fastify 与 SSE transport
├── config/       环境和运行配置
├── models/       模型目录、能力、客户端和流归一化
├── runtime/      稳定事件契约与 Direct Runtime
├── tools/        通用 Tools，当前包含 web_search
├── graph/        后续 Intent Router 和 Agent 编排
├── rag/          后续知识检索
├── memory/       后续三层记忆
├── artifacts/    后续文件产物
└── prompts/      后续版本化 Prompt
```

项目级 `skills/` 保存标准 `SKILL.md` 资源，`evals/` 保存后续可重复评测场景。
