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

浏览器通过 REST API 和 WebSocket 访问 Go API。PostgreSQL 保存需要持久化的业务数据，Python Agent 服务将在开始开发 AI 功能时接入。

```text
React Web
    │ REST API / WebSocket IM
    ▼
Go Gin API
    ├─ PostgreSQL
    └─ Python Agent（规划中，尚未启用）
```

普通资源操作使用 REST API。实时消息、Agent 状态和交互请求使用统一的 WebSocket 事件信封，并以服务端状态为最终依据。

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
| 日志 | Go 标准库 `log/slog` |
| 数据库迁移 | goose 3.27.2 |

### 尚未安装的能力

以下依赖会在对应功能进入开发阶段后安装：

- Python Agent、FastAPI、LangGraph、LangChain、向量数据库和模型软件开发工具包（SDK）
- Quill、Markdown 渲染、代码高亮、PDF 和 DOCX 预览依赖
- Redis、gRPC、消息队列、服务注册和独立 API Gateway

## 项目结构

仓库按前后端分离方式组织。业务模块目录目前为空，Git 会在目录中出现文件后开始跟踪它们。

```text
Eterion/
├─ apps/
│  └─ web/                  React + TypeScript + Vite 前端
│     ├─ public/            静态资源
│     ├─ src/               应用、页面、组件、功能和数据访问
│     ├─ tests/             前端测试
│     ├─ package.json       前端依赖清单
│     └─ pnpm-lock.yaml     前端依赖锁文件
└─ services/
   └─ api/                  Go RESTful API
      ├─ cmd/server/        HTTP 服务入口
      ├─ internal/          配置、路由、中间件、模块和共享能力
      ├─ migrations/        goose 数据库迁移
      ├─ tests/             后端测试
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

克隆仓库后，在仓库根目录执行以下命令。进入前端目录安装依赖，再返回根目录下载 Go 模块。

```powershell
Set-Location apps/web
pnpm install
Set-Location ../..
go -C services/api mod download
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

默认开发地址为 `http://localhost:5173`。Go API 的启动方式将在服务入口实现后补充。

## 工程约束

这些约束保证前端、Go API 和后续 Agent 服务保持清晰的职责边界：

- 浏览器只访问 Go API，不直接访问数据库或 Python Agent
- 公共 REST API 使用 `/api/v1` 前缀，资源路径使用复数名词
- WebSocket 事件包含版本、事件 ID、会话 ID、运行 ID、序号和时间戳
- TanStack Query 保存服务端数据，Zustand 保存客户端全局状态，React Hook Form 保存表单状态
- Go 模块按照 Handler、Service、Repository 和 PostgreSQL 的方向处理请求
- Agent 界面展示可公开的结构化状态与摘要，不展示模型隐藏的原始思维链
- Token、模型密钥和敏感配置通过环境变量注入，不写入日志或版本库
- 高风险 Skill 需要隔离环境、权限控制、资源限制和用户确认
