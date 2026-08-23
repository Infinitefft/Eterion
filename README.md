# Eterion

> **Eterion** 是一个以 **Web 体验** 为核心的 **AI Agent 工作台**。  
> 产品通过 **多轮会话** 承载任务，并围绕实时通信、Agent 执行状态、`Skills`、文件、知识库和 **Human in the Loop** 构建交互能力。

## 产品定位

Eterion 优先建设前端交互体验和 Agent 任务处理能力。Go API 负责认证、通信、业务规则和数据访问，并作为浏览器访问后端能力的唯一入口。

产品计划覆盖以下核心体验：

- **多轮会话**：创建、切换和管理会话，持久化消息与运行状态
- **实时通信**：通过 WebSocket 自定义即时通信（IM）协议传输消息增量和 Agent 事件
- **Agent 可视化**：展示规划摘要、Skill 调用、执行结果、失败步骤和最终回答
- **结构化输入**：支持模型选择、`/` 命令、`@` 引用和结构化内容节点
- **文件与知识库**：支持插件化文件预览、知识库处理和检索增强生成（RAG）问答
- **Human in the Loop**：在信息不足或操作需要确认时暂停运行，并在用户响应后继续执行
- **状态恢复**：处理心跳、重连、事件去重、请求幂等和短时断线续传

## 路线

### 第一期：Agent Chat 技术底座

- 双 Token 登录与前端无感刷新
- 多轮会话和消息持久化
- WebSocket IM 协议、心跳、重连、去重和短时续传
- Agent Run 状态机与基础状态展示
- Skills 注册、查询和调用底座
- 一个用于验证调用链的最小 Skill

### 第二期：完整交互与 AI 能力

- 单点登录（SSO）和平台模型选择器
- 富文本输入、`/` 命令和 `@` 引用
- 插件化文件上传与预览
- 完整 Agent 工作过程可视化
- RAG 知识库和大文件上传
- Human in the Loop 交互
- Skills 管理与更多实际能力

## 当前架构

浏览器通过 REST API 和 WebSocket 访问统一的 Go 服务，PostgreSQL 保存业务数据。独立 Node.js + TypeScript Agent 负责模型目录、运行时和后续 Agent 编排，通过内部 HTTP/SSE 输出与模型厂商无关的运行事件。

```text
React Web
    │ REST API / WebSocket IM
    ▼
Go Gin API
    ├─ PostgreSQL
    └─ HTTP POST / SSE
           ▼
       Node.js Fastify Agent
           ├─ Runtime Event Contract
           ├─ Direct Model Runtime（当前）
           ├─ Agent Graph / Tools / Skills / RAG / Memory（后续）
           └─ Model Catalog / Stream Adapter
```

普通资源操作使用 REST API，前端实时消息和 Agent 状态使用统一的 WebSocket 事件信封。Node Agent 不生成 `seqId`、时间戳或前端 Message ID，只输出 `run / thinking / content / tool` 四组语义事件；Go 后续负责补齐 IM envelope，并将 `content.*` 映射为前端 `message.*`。因此 LangChain、Deep Agents 和不同模型厂商的原始 chunk 都不会进入前端协议。

当前 Agent 实现了可运行的 Direct Runtime 和真实 Brave `web_search` Tool；该 Tool 尚未注册进聊天编排。意图路由、Skills、RAG、Memory 和 Deep Agents 适配层目前只有明确边界，没有模拟实现。由于 Agent 事件契约刚完成重构，现有 Go SSE 适配器需要在后续开发中同步到新事件名。

## 已安装的技术栈

依赖清单反映当前仓库的实际安装状态，不包含产品路线中的后续可选能力。

### Web 前端

| 用途 | 依赖 |
| --- | --- |
| 框架与构建 | React 19.2.7、TypeScript 6.0.3、Vite 8.1.5 |
| 路由与请求 | React Router 7.18.1、Axios 1.18.1 |
| 服务端数据 | TanStack Query 5.101.2 |
| 客户端状态 | Zustand 5.0.14 |
| 表单与校验 | React Hook Form 7.82.0、Zod 4.4.3、Hook Form Resolvers 5.4.0 |
| UI 与样式 | Tailwind CSS 4.3.3、shadcn 4.13.1、Radix UI 1.6.2、Lucide React 1.25.0 |
| 类名与变体 | class-variance-authority、clsx、tailwind-merge、tw-animate-css |
| 代码检查 | ESLint 10.7.0、typescript-eslint 8.64.0、React Hooks 与 Fast Refresh 插件 |

### Go API

| 用途 | 依赖 |
| --- | --- |
| 语言与工具链 | Go 1.26.0、Go toolchain 1.26.5 |
| HTTP API | Gin 1.12.0、gin-contrib/cors 1.7.7 |
| 数据访问 | GORM 1.31.2、PostgreSQL driver 1.6.0 |
| 请求校验 | go-playground/validator 10.30.3 |
| 认证与安全 | golang-jwt/jwt 5.3.1、x/crypto 0.54.0 |
| 标识与配置 | google/uuid 1.6.0、godotenv 1.5.1 |
| Agent 通信 | Go 标准库 HTTP 客户端、SSE 事件解析 |
| 日志 | Go 标准库 `log/slog` |
| 数据库迁移 | goose 3.27.2 |

### Node Agent

| 用途 | 依赖 |
| --- | --- |
| 语言与工具链 | Node.js 22.12+、TypeScript 6.0.3、pnpm 10.20.0 |
| HTTP/SSE 服务 | Fastify 5.12.1 |
| 模型调用与适配 | LangChain Core、LangChain OpenAI、Zod |
| Tool | Node 原生 fetch、LangChain Tool |
| 配置 | dotenv |

### 尚未安装的能力

以下依赖会在对应功能进入开发阶段后安装：

- 向量数据库、模型厂商专用软件开发工具包（SDK）和 Agent 可观测性后端
- Quill、Markdown 渲染、代码高亮、PDF 和 DOCX 预览依赖
- Redis、gRPC、消息队列、服务注册和独立 API Gateway

## 项目结构

仓库按前后端分离方式组织。业务模块目录目前为空，Git 会在目录中出现文件后开始跟踪它们。

```text
Eterion/
├─ agent/                    Node.js + TypeScript Agent 服务
│  ├─ src/
│  │  ├─ api/               Fastify 与 SSE transport
│  │  ├─ config/            环境与运行配置
│  │  ├─ models/            模型目录、能力和流归一化
│  │  ├─ runtime/           事件契约与 Direct Runtime
│  │  └─ graph、tools、rag、memory 等后续模块
│  ├─ skills/               后续标准 SKILL.md 资源
│  ├─ evals/                后续 Agent 评测场景
│  ├─ package.json          pnpm 依赖与脚本
│  ├─ pnpm-lock.yaml       锁定 Agent 依赖
│  └─ tsconfig.json        TypeScript 编译配置
├─ apps/
│  └─ web/                  React + TypeScript + Vite 前端
│     ├─ public/            静态资源
│     ├─ src/               应用、页面、组件、功能和数据访问
│     ├─ tests/             前端测试
│     ├─ package.json       前端依赖清单
│     └─ pnpm-lock.yaml     前端依赖锁文件
└─ services/
   └─ api/                  Go RESTful API 与 WebSocket 网关
      ├─ cmd/server/        HTTP 服务入口
      ├─ internal/          配置、路由、中间件、模块和共享能力
      │  └─ agent/          应用 Agent 契约与 Node SSE 适配器
      ├─ migrations/        goose 数据库迁移
      ├─ go.mod             Go 模块与直接依赖
      └─ go.sum             Go 依赖校验信息
```

## 开发环境

安装依赖前，请准备以下环境：

- Node.js 22.12 或更高版本
- pnpm 10.20 或更高版本
- Go 1.26，推荐使用工具链 1.26.5
- PostgreSQL 16 或更高版本
- Git
- Docker Desktop，可选用于运行 PostgreSQL

## 恢复项目依赖

克隆仓库后，在仓库根目录执行以下命令，分别恢复前端、Go API 和 Node Agent 依赖。

```powershell
Set-Location apps/web
pnpm install
Set-Location ../..
go -C services/api mod download
Set-Location agent
pnpm install
Set-Location ..
```

如需安装与项目版本一致的数据库迁移工具，请执行：

```powershell
go install github.com/pressly/goose/v3/cmd/goose@v3.27.2
```

## 启动前端

进入前端目录后使用 pnpm 启动 Vite 开发服务器：

```powershell
Set-Location apps/web
pnpm dev
```

默认开发地址为 `http://localhost:5173`。

## 初始化并启动 Node Agent

Node Agent 的模型密钥保存在 `agent/.env`，该文件不会提交到 Git。复制示例配置，至少启用并填写一个模型；`DEFAULT_MODEL_ID` 必须指向已启用的模型。

首次运行时，在仓库根目录执行：

```powershell
Copy-Item .\agent\.env.example .\agent\.env
pnpm --dir .\agent dev
```

默认地址为 `http://127.0.0.1:8001`。它是内部服务，不应直接暴露给浏览器或公网。内部接口包括：

- `GET /healthz`
- `GET /models`
- `POST /runs`（响应为 `text/event-stream`）

`POST /runs` 当前接收 `run_id`、`thread_id`、`model_id` 和 `messages`，成功时依次输出 `run.started`、`content.started`、若干 `content.delta`、`content.completed` 和 `run.completed`。详细协议和后续 Agent 模块设计见 [`agent/ARCHITECTURE.md`](agent/ARCHITECTURE.md)。

## 初始化并启动 Go API

Go 后端的本地配置保存在 `services/api/.env`，该文件不会提交到 Git。首次运行时复制示例文件，填写数据库密码和随机 JWT 密钥：

```powershell
Set-Location services/api
Copy-Item .env.example .env
```

数据库迁移使用 goose 显式执行，API 启动时不会自动修改表结构：

```powershell
$apiDatabaseUrl = ((Get-Content .env | Select-String '^DATABASE_URL=').Line -replace '^DATABASE_URL=', '')
goose -dir migrations postgres $apiDatabaseUrl up
go run ./cmd/server
```

Go API 默认通过 `http://127.0.0.1:8001` 访问 Node Agent，并在启动时读取模型目录；如果 Agent 服务不可访问或没有有效模型，Go 会直接报告启动错误。Go API 默认监听 `http://localhost:8080`，当前接口包括：

- `GET /healthz`
- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/refresh`
- `GET /api/auth/me`（需要 Bearer Access Token）
- `POST /api/auth/logout`（需要 Bearer Access Token）
- `GET /api/chat/models`（返回已启用模型及默认模型，需要 Bearer Access Token）

## 查看 Swagger 接口文档

开发或测试环境启动 API 后，访问 `http://localhost:8080/docs` 即可查看和调试全部接口。原始 OpenAPI 3.0 契约位于 `services/api/docs/openapi.yaml`，运行时也可以通过 `http://localhost:8080/openapi.yaml` 查看。

Swagger UI 和 OpenAPI 路由在 `APP_ENV=production` 时不会注册，生产环境访问会返回 404。新增或修改后端接口时，需要同步更新 `services/api/docs/openapi.yaml`。
