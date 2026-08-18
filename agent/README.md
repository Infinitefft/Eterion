# Eterion Agent

独立的 Python Agent 服务。当前只负责接收完整对话、调用 OpenAI 兼容模型，并通过 SSE 把模型回答的 content 增量返回给 Go；暂不注册 tools。

## 启动

```powershell
Set-Location agent
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env
.\.venv\Scripts\python.exe -m eterion_agent
```

在 `.env` 中保留需要启用的模型配置，并填写对应 API Key。`DEFAULT_MODEL_ID` 必须指向一个已启用的模型。

## 内部接口

- `GET /healthz`：进程健康检查。
- `GET /models`：返回默认模型和可用模型目录。
- `POST /runs`：接收消息历史，返回 `text/event-stream`。

`/runs` 只输出 `started`、`content_delta`、`completed` 或 `error` 事件。浏览器不直接访问本服务，由 Go 负责业务接口和 WebSocket。
