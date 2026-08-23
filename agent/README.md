# Eterion Agent

Eterion 的独立 Python Agent 服务。当前提供可运行的 Direct Runtime：接收完整对话，
调用已配置的 OpenAI-compatible 模型，并通过 SSE 输出规范化的 `run/content` 事件。

项目已经为意图路由、DeepAgents、Tools、Skills、RAG 和 Memory 建立模块边界，但这些
能力尚未实现，不会返回模拟结果。详细设计见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 安装

```powershell
Set-Location agent
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"
Copy-Item .env.example .env
```

后续开始实现 DeepAgents 编排时安装可选依赖：

```powershell
.\.venv\Scripts\python.exe -m pip install -e ".[dev,orchestration]"
```

在 `.env` 中只保留需要启用的模型，并填写真实 API Key。一个模型只有设置了对应
`*_MODEL` 才会进入模型目录，`DEFAULT_MODEL_ID` 必须指向已启用模型。

## 启动

```powershell
.\.venv\Scripts\python.exe -m eterion_agent
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
  "messages": [
    {"role": "user", "content": "你好"}
  ]
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

每个 SSE data 都采用以下形状：

```json
{
  "runId": "run-1",
  "payload": {}
}
```

错误以 `run.failed` 结束。若正式内容已经开始，Runtime 会先发送失败状态的
`content.completed`，避免调用方留下永久生成中的 Content Block。

## 目录

```text
eterion_agent/
├── api/          HTTP 与 SSE transport
├── config/       环境配置
├── models/       模型目录、能力、客户端和流归一化
├── runtime/      稳定事件契约与 Direct Runtime
├── graph/        后续意图路由和 DeepAgents 编排
├── tools/        后续 Tool registry 与通用 Tools
├── rag/          后续知识检索实现
├── memory/       后续三层记忆
├── artifacts/    后续文件产物
└── prompts/      后续版本化 Prompt
```

项目级 `skills/` 保存标准 `SKILL.md` 资源，`evals/` 保存可重复评测场景。
