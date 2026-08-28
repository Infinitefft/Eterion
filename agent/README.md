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




web_search
根据关键词搜索网页，拿到相关 URL。你已经有了。它主要负责“发现信息源”，适合评估 Agent 该不该搜索、搜索词写得好不好。

web_fetch
根据 URL 读取网页正文。这个很值得做，因为只有 search 没有 fetch，Agent 只能找到网页，不能真正阅读网页内容。它能让你的 Agent 做完整的 Web Research。

find_in_page
在已经读取的长网页里查找某个关键词、段落或主题。比如 Agent 打开一篇很长的文章后，不需要重新把整篇内容反复塞给模型，可以直接找 “evaluation”“pricing”“release date” 等内容。实现难度不高，也很像真正的浏览 Agent。

calculator
执行精确数学计算，比如百分比、增长率、平均值、价格计算。它本身很简单，但非常适合做 Agent Eval，因为参数和结果都很好自动判断。

get_datetime
获取当前日期和时间。用来处理“今天”“昨天”“最近 7 天”“明天”这类问题。实现非常简单，但能避免 Agent 自己猜时间。

notes_write / notes_read
给 Agent 一个当前任务的临时工作区。比如它要调查三个 AI framework，可以调查一个就保存一个，最后再读取 notes 做综合分析。这个很适合你的网页版，因为前端还可以直接展示 Agent 收集了哪些信息。

file_read
读取用户上传的 TXT、Markdown、CSV 之类文件。比如用户上传一份数据，让 Agent 先读取文件，再联网搜索相关资料进行比较。这个特别适合网页版 AI Agent。

pdf_read
专门读取 PDF。如果你以后想支持论文、报告、课程资料，这个比较有价值。不过如果你觉得麻烦，可以第二阶段再做。

file_write
让 Agent 生成一个 Markdown、JSON 或 CSV 文件。比如完成调研以后生成 report.md。这可以让你的 Agent 不只是输出聊天消息，而是能产出一个真正的文件结果。

knowledge_search
搜索你自己的知识库，也就是简单 RAG。用户上传一些文档以后，Agent 可以先搜内部知识，再决定要不要联网。这一项技术含量比较高一点，但也没有高到不可控，适合作为第二阶段亮点。

bookmark_save
让 Agent 保存它认为重要的网页。比如研究过程中找到一个官方文档，可以保存到你的网页收藏区。实现非常简单，但产品体验不错。

bookmark_list
读取之前保存过的网页。以后用户问“之前你帮我找到的 Agent Eval 文章有哪些”，Agent 可以直接调这个 Tool。

接下来是 Skills。

Web Research Skill
这是最值得做的 Skill。它让 Agent知道怎么执行“研究一个问题”：拆搜索词、搜索、打开网页、继续找资料、整理信息、最后总结。这个应该成为你项目的核心能力。

Compare & Analyze Skill
专门处理“比较 A、B、C”这种任务。Agent 会分别调查几个对象，然后按统一维度比较。这个特别适合展示多步骤 Tool Calling。

Fact Check Skill
用户给一个说法，例如“某公司最近发布了某功能”，Agent 会搜索多个来源进行验证，然后告诉用户这个说法是否可靠。这个 Skill 很适合做 grounding 和 source eval。

Webpage Q&A Skill
用户直接给一个 URL，让 Agent 阅读这个网页，然后围绕网页回答问题。这个功能不复杂，但非常实用。

Document Analysis Skill
用户上传文件以后，让 Agent 总结、提取重点、回答问题。以后可以和 file_read、knowledge_search 结合。

Research Report Skill
比普通 Web Research 多一步：不是简单回答，而是把多源调研结果整理成结构化报告。可以配合 file_write 生成 Markdown 报告。

Research → Task Skill
先调研，再行动。比如“帮我研究三个值得学习的 Agent 技术，然后给我创建学习任务”。它会用 web_search → web_fetch → notes → create_task，非常适合体现 Agent workflow。

Learning Planner Skill
根据用户想学的内容，联网找资料，然后制定学习计划，再创建任务。这个也很适合你自己的项目主题。

Briefing Skill
比如“给我生成今天的 AI Agent 简报”。它会获取当前时间、搜索最近内容、阅读几个来源，然后生成简报。

如果只让我帮你挑一套难度适中、项目效果又比较好的，我会选：

web_search、web_fetch、find_in_page、calculator、get_datetime、notes、create_task、file_read。

Skills 就做：

Web Research、Compare & Analyze、Research → Task。

这一套已经足够让你的项目看起来是一个真正有 workflow、有 Tool Calling、有状态、有 Action、还能做 Eval 的 Agent。