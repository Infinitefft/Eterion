# Eterion

Eterion 是一个以 Web 对话体验为核心的 AI Agent 工作台，目标是将多轮会话、流式内容呈现、工具执行和知识处理整合为连续的交互体验。

当前项目包含会话与认证、WebSocket 实时通信、流式 Markdown 渲染、模型切换、网页搜索与读取、历史上下文压缩。Skills、RAG、分层记忆和长聊天虚拟列表属于后续目标。

## 项目组成与技术栈

| 模块 | 目录 | 技术栈与职责 |
| --- | --- | --- |
| Web | `apps/web/` | React、TypeScript、Vite、Zustand、TanStack Query、Tailwind CSS / Less；对话页面、认证状态和实时消息展示 |
| Go API | `services/api/` | Go、Gin、GORM、PostgreSQL、WebSocket；认证、会话持久化和 Agent 通信 |
| Agent | `agent/` | Node.js、TypeScript、Fastify、LangChain、Cheerio；模型编排、工具调用和上下文管理 |

浏览器连接 Go API，Go API 访问 PostgreSQL 并与 Agent 通信。Agent 调用模型服务和博查搜索，将执行结果通过 Go API 返回前端。

## 环境要求

| 工具或服务 | 要求 |
| --- | --- |
| Node.js | Web 与 Agent 声明最低 22.12.0，统一开发环境建议使用 22.19.0+ |
| pnpm | 项目指定 10.20.0 |
| Go | `go.mod` 声明 1.26.0，工具链为 1.26.5 |
| Docker / PostgreSQL | Docker Compose；`pgvector/pgvector:0.8.6-pg18-trixie`，业务与 RAG 共用 PostgreSQL 18 |
| goose | 本地使用 3.27.2，数据库迁移 CLI 需加入 PATH |

## 各模块依赖版本

下表来自各模块的 `package.json` 和 Go 直接依赖清单。`^`、`~` 是声明的版本范围，Node 依赖的实际解析版本由对应 `pnpm-lock.yaml` 锁定；Go 完整依赖见 `go.mod`，校验信息见 `go.sum`。

### Web

| 依赖 | 声明版本 | 分类 |
| --- | --- | --- |
| `@hookform/resolvers` | `^5.4.0` | 运行依赖 |
| `@radix-ui/react-dropdown-menu` | `^2.1.20` | 运行依赖 |
| `@tanstack/react-query` | `^5.101.2` | 运行依赖 |
| `axios` | `^1.18.1` | 运行依赖 |
| `class-variance-authority` | `^0.7.1` | 运行依赖 |
| `clsx` | `^2.1.1` | 运行依赖 |
| `immer` | `^11.1.18` | 运行依赖 |
| `lucide-react` | `^1.25.0` | 运行依赖 |
| `radix-ui` | `^1.6.2` | 运行依赖 |
| `react` | `^19.2.7` | 运行依赖 |
| `react-dom` | `^19.2.7` | 运行依赖 |
| `react-hook-form` | `^7.82.0` | 运行依赖 |
| `react-router-dom` | `^7.18.1` | 运行依赖 |
| `shadcn` | `^4.13.1` | 运行依赖 |
| `tailwind-merge` | `^3.6.0` | 运行依赖 |
| `three` | `^0.185.1` | 运行依赖 |
| `tw-animate-css` | `^1.4.0` | 运行依赖 |
| `zod` | `^4.4.3` | 运行依赖 |
| `zustand` | `^5.0.14` | 运行依赖 |
| `@babel/plugin-transform-runtime` | `^7.29.7` | 开发依赖 |
| `@eslint/js` | `^10.0.1` | 开发依赖 |
| `@tailwindcss/vite` | `^4.3.3` | 开发依赖 |
| `@types/node` | `^26.1.1` | 开发依赖 |
| `@types/react` | `^19.2.17` | 开发依赖 |
| `@types/react-dom` | `^19.2.3` | 开发依赖 |
| `@types/three` | `^0.185.4` | 开发依赖 |
| `@vitejs/plugin-react` | `^6.0.3` | 开发依赖 |
| `eslint` | `^10.7.0` | 开发依赖 |
| `eslint-config-prettier` | `^10.1.8` | 开发依赖 |
| `eslint-plugin-import-x` | `^4.17.1` | 开发依赖 |
| `eslint-plugin-react-hooks` | `^7.1.1` | 开发依赖 |
| `eslint-plugin-react-refresh` | `^0.5.3` | 开发依赖 |
| `globals` | `^17.7.0` | 开发依赖 |
| `less` | `^4.7.0` | 开发依赖 |
| `prettier` | `^3.9.5` | 开发依赖 |
| `tailwindcss` | `^4.3.3` | 开发依赖 |
| `typescript` | `^6.0.3` | 开发依赖 |
| `typescript-eslint` | `^8.64.0` | 开发依赖 |
| `vite` | `^8.1.5` | 开发依赖 |
| `vitest` | `^5.0.1` | 开发依赖 |

### Go API

| 依赖 | 版本 |
| --- | --- |
| `github.com/gin-contrib/cors` | `v1.7.7` |
| `github.com/gin-gonic/gin` | `v1.12.0` |
| `github.com/go-playground/validator/v10` | `v10.30.3` |
| `github.com/golang-jwt/jwt/v5` | `v5.3.1` |
| `github.com/google/uuid` | `v1.6.0` |
| `github.com/gorilla/websocket` | `v1.5.3` |
| `github.com/jackc/pgx/v5` | `v5.6.0` |
| `github.com/joho/godotenv` | `v1.5.1` |
| `github.com/swaggo/files` | `v1.0.1` |
| `github.com/swaggo/gin-swagger` | `v1.6.1` |
| `golang.org/x/crypto` | `v0.54.0` |
| `golang.org/x/text` | `v0.40.0` |
| `gorm.io/driver/postgres` | `v1.6.0` |
| `gorm.io/gorm` | `v1.31.2` |

### Agent

| 依赖 | 声明版本 | 分类 |
| --- | --- | --- |
| `@langchain/core` | `1.2.9` | 运行依赖 |
| `@langchain/openai` | `1.5.10` | 运行依赖 |
| `cheerio` | `1.2.0` | 运行依赖 |
| `dotenv` | `17.4.2` | 运行依赖 |
| `fastify` | `5.12.1` | 运行依赖 |
| `langchain` | `1.5.10` | 运行依赖 |
| `zod` | `4.4.3` | 运行依赖 |
| `@types/node` | `26.1.1` | 开发依赖 |
| `tsx` | `4.23.12` | 开发依赖 |
| `typescript` | `6.0.3` | 开发依赖 |

LangChain 使用本地补丁 `agent/patches/langchain@1.5.10.patch`，由 pnpm 的 `patchedDependencies` 在安装时应用。

## 安装依赖

以下命令在仓库根目录执行，各模块独立管理依赖，没有根目录统一安装命令：

```powershell
pnpm --dir apps/web install --frozen-lockfile
pnpm --dir agent install --frozen-lockfile
go -C services/api mod download
go install github.com/pressly/goose/v3/cmd/goose@v3.27.2
```

Web 和 Agent 的 `.npmrc` 将 pnpm 缓存指向仓库根目录 `.pnpm-store/`。

## 本地配置

Web、Go API 和 Agent 分别使用各自目录下的本地配置文件：

- Web：`apps/web/.env`
- Go API：`services/api/.env`
- Agent：`agent/.env`
- Docker 数据库：根目录 `.env.docker`
- Agent 私人提示词：`agent/prompts/system.local.md`

启动前准备好数据库连接、模型服务和搜索服务所需配置。这些本地文件不提交 Git，部署时单独提供。

## 启动项目

先启动 PostgreSQL 并完成迁移，再依次启动 Agent、Go API 和 Web。以下各服务应在独立终端运行。

### 1. Docker 数据库与迁移

在根目录创建 `.env.docker`（不提交 Git），填写 `POSTGRES_DB`、`POSTGRES_USER`、`POSTGRES_PASSWORD`。值使用单引号包裹，避免密码中的 `$` 被 Compose 插值；数据库名使用 `eterion`。然后在根目录执行：

```powershell
docker compose --env-file .env.docker up -d --wait
```

数据库监听 `127.0.0.1:5433`，保持原本机数据库的 `Asia/Shanghai` 时区。将 `services/api/.env` 的 `DATABASE_URL` 设置为该地址，用户名、密码和数据库名与 `.env.docker` 一致；URL 中的特殊字符需编码。已有进程环境中的 `DATABASE_URL` 会优先于 `.env`，修改后需重启 Go API。

首次启动会创建数据库，数据保存在 `eterion_postgres_data` 卷中，挂载到容器 `/var/lib/postgresql`。环境变量仅在空数据卷初始化时生效。日常停止使用 `docker compose --env-file .env.docker stop`；不要使用 `down -v`，它会删除数据库卷。

在 `services/api/` 下执行 Goose，将连接参数替换为本地配置，避免把真实凭据提交到仓库：

```powershell
Set-Location services/api
goose -dir migrations postgres "<数据库连接字符串>" up
```

API 启动不会自动执行迁移。第 10 版迁移启用 `vector` 扩展并创建 `rag_chunks`；回滚该版只删除 Chunk 表，保留扩展。Agent 的数据库客户端将在接入 RAG 时添加。

从旧数据库迁移时先暂停项目写入，使用 `pg_dump -Fc -f <备份文件>` 备份，再以 `pg_restore --no-owner --no-acl --exit-on-error --single-transaction -d <目标数据库> <备份文件>` 恢复到空库；连接凭据通过本地环境变量提供。不要把二进制备份经过 PowerShell 文本管道。核对业务表和 Goose 历史后，再切换连接并执行新迁移。备份放在 Git 忽略的 `storage/db-backups/`，保留旧库。RAG 表结构及本机迁移结果见 [RAG 入库设计](agent/src/rag/INGESTION.md)。

### 2. Agent

在仓库根目录执行：

```powershell
pnpm --dir agent dev
```

服务监听地址由本地配置决定。

### 3. Go API

在仓库根目录进入 Go 模块后启动：

```powershell
Set-Location services/api
go run ./cmd/server
```

启动时需要数据库和 Agent 可访问。

### 4. Web

在仓库根目录执行：

```powershell
pnpm --dir apps/web dev
```

浏览器打开终端输出的开发地址。

## 构建与运行

在仓库根目录执行：

```powershell
pnpm --dir apps/web build
pnpm --dir agent build
```

Web 静态文件输出到 `apps/web/dist/`，由静态服务器托管；部署时配置后端转发和 WebSocket 连接，Vite 开发代理不会随构建部署。Agent 输出到 `agent/dist/`，通过 `pnpm --dir agent start` 运行，仍需提供环境变量和私人提示词文件。

Go 服务在模块目录执行 `go build -o bin/ ./cmd/server`，运行生成的 `server`（Windows 为 `server.exe`），并以 `services/api/` 为工作目录，或通过进程环境提供配置。
