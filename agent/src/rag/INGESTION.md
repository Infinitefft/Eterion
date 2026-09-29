# RAG 入库与切分设计

本文保存已确认的 TXT / Markdown 切分、数据契约和 Embedding 准备规则，供实现与 Review 使用。除明确记录的落地结果外，其余仍是设计要求，不代表已实现或已验证。模块整体约束见 [AGENTS.md](AGENTS.md)。

## 范围与待定事项

当前目标是跑通上传后立即索引、Agent 检索、前端文件来源展示与原文高亮的整体成功路径。Markdown 按标题切 Section 后在各 Section 内递归切分并添加 overlap，TXT 使用全文递归切分。本版暂不保护代码块、列表、表格等结构，先建立基础效果基线，后续再优化；不实现 Parent-Child Retrieval，也不建设重试或恢复机制。

数据库已确定采用 Docker 中的 PostgreSQL + pgvector，业务表与 RAG 表放在同一个数据库。Embedding 已选定阿里百炼 `text-embedding-v4` API，第一版采用 1024 维。切分阶段采用 `cl100k_base` 代理计数，完整输入预算为 512，最大目标 overlap 为 64；该计数不是模型真实 token 数，也不是其严格上界。第二阶段已实现内部 Embedding 和事务写库代码；上传触发尚未接线，完整入库链路仍待联调。

代码职责对应 `parseMarkdownSections()`、`chunkMarkdownSection()`、TXT 递归切分和 `buildEmbeddingText()`；第二阶段已实现 `embedChunks()` 与事务入库，见下文交付记录。上传触发和 OSS 读取仍未接线。

## 数据库存储与迁移决策

- 将现有本机 PostgreSQL 中的项目业务数据库迁入 `pgvector/pgvector` 容器，统一存放业务表和 RAG 表。pgvector 是数据库扩展，Chunk 的 `embedding` 列使用 `vector(1024)`；向量由 Agent 调用 `text-embedding-v4` 生成。
- Go 继续维护用户、知识库、文件、聊天及权限；Agent 直接访问 RAG 表，负责切分、Embedding、索引写入与检索。两者共用数据库不改变业务职责，表结构变更沿用项目现有迁移机制。
- 第一版新增 `rag_chunks` 保存片段正文、向量和来源 metadata，通过 `file_id` 关联 `knowledge_files.id`。文件名、OSS `object_key` 和知识库归属以业务表为准，不在每个 Chunk 中重复维护。
- 保留独立的 `heading_path` 与 `section_id`，同一 Section 的 Chunk 共用 section_id；当前不单独建立 Section 表或实现父块展开。正文与标题路径分开存，组合后做 Embedding，查询后可再组合交给模型。
- 检索范围由可信用户身份和知识库权限约束，在数据库查询中完成过滤；来源信息可关联业务表获取。文件记录删除时，Chunk 可通过外键级联清理；索引状态的具体存储位置另行确定。
- 第一版采用精确向量检索，暂不建立 HNSW / IVFFlat 近似向量索引。前端溯源沿用文件 ID、标题路径与可靠的原文位置，通过 Go 鉴权接口读取原文件。

实际迁移按以下顺序进行，不能把方案记录视为已经执行：

1. 核对本机 PostgreSQL 主版本，选择对应且明确版本的 pgvector 镜像，配置持久化数据卷。容器先使用与本机数据库不同的端口，保留旧库。
2. 暂停项目写入，通过 `pg_dump` 导出业务数据库并恢复到容器；保留文件 ID、object_key 和现有迁移记录，OSS 原文件不需要重新上传。
3. 在目标数据库启用 `vector` 扩展，更新 Go 的数据库连接，并在 Agent 接入 RAG 时配置同一数据库。
4. 验证数据恢复、登录、聊天、知识库及文件访问，再通过项目迁移机制增加 RAG 表。确认迁移成功后再决定旧库的停用与清理，不自动删除旧数据。

## 目标数据流

### 数据库实现

根目录 `compose.yaml` 使用 `pgvector/pgvector:0.8.6-pg18-trixie`，监听 `127.0.0.1:5433`，业务表和 RAG 表共用 `eterion` 数据库。命名卷 `eterion_postgres_data` 挂载到 `/var/lib/postgresql`。凭据来自 Git 忽略的 `.env.docker`，日常启动方式见根 README。

表结构由 Go 的 `00010_create_rag_chunks.sql` 管理，Agent 后续直接读写该表，不另建一套迁移机制。

| 字段 | 数据库类型 | 语义 |
| --- | --- | --- |
| `id` | UUID 主键 | Agent 生成的 Chunk ID |
| `file_id` | UUID，非空外键 | 关联业务文件；删除文件时级联删除 Chunk |
| `section_id` | UUID，非空 | 逻辑 Section ID，暂不关联独立 Section 表 |
| `content` | TEXT，非空 | 正文，与标题路径分开保存 |
| `heading_path` | TEXT[]，非空，默认空数组 | 标题层级；TXT 为空数组 |
| `chunk_index` | INTEGER，非空 | Section 内从 0 开始的顺序 |
| `start_offset` / `end_offset` | INTEGER，可空 | UTF-16 原文范围 `[start, end)` |
| `embedding` | VECTOR(1024)，非空 | `text-embedding-v4` 对标题路径与正文组合文本生成的向量 |
| `created_at` | TIMESTAMPTZ，非空，默认当前时间 | 入库时间 |

`(file_id, section_id, chunk_index)` 唯一，索引前缀同时支持按文件读取和清理。偏移量必须同时为空，或满足 `0 <= start_offset < end_offset`。无法可靠定位时两个字段都不填；不以假位置满足约束。暂无近似向量索引，使用精确检索。

不重复保存文件名、object_key、用户和知识库归属；通过 `file_id` 关联业务表。不持久化尚未确定计数口径的 `token_count`，不增加索引状态或任务表。回滚第 10 版只删除 `rag_chunks`，保留共享的 `vector` 扩展。

### 本机迁移结果（2026-09-29）

- 已从本机 PostgreSQL 18.1 的 `eterion` 迁入 Docker PostgreSQL 18.6，安装 pgvector 0.8.6，Go 连接已改为 `127.0.0.1:5433/eterion`，Goose 当前版本为 10。容器显式保持旧库的 `Asia/Shanghai` 时区。
- 原有 10 张表恢复后，逐表行数和完整行内容摘要一致，摘要比较统一使用 UTC 表示时间。数据包含 2 个用户、12 个聊天、182 条消息、91 条 Run、68 条 Agent Block、2 个知识库和 5 个文件；认证会话、刷新 Token 及原 Goose 历史也完整保留。
- 事务内调用真实 Go HTTP handlers，验证了 2 个用户的登录与身份读取、12 个聊天快照、2 个知识库及文件列表、5 个 OSS 文件内容读取。登录验证使用事务内临时密码，密码与测试会话均已回滚；验证后业务数据摘要未变。这不是浏览器端到端验证，也没有调用模型。
- 事务内验证了 1024 维向量写入、余弦距离排序、错误维度拒绝、文件外键、Section 内序号唯一性、非负序号、成对偏移量及级联删除，测试数据全部回滚。`rag_chunks` 当前为空，尚未接入真实 Embedding。
- 容器重启后健康检查通过，所有表的数据摘要及迁移状态保持一致；Go API 已恢复，数据库健康检查通过。
- 本机备份位于 `storage/db-backups/20260929-171952/`，包含 `eterion.dump`、原 `api.env.before` 和核对摘要，均不提交 Git。旧 PostgreSQL 服务和数据库保留，其他 Docker 容器未修改。

如需回退连接，先停止 Go API 并确认 Docker 库在切换后是否产生新业务写入；有新写入时先迁回这些数据，不能直接切回旧快照。恢复原连接后重启 API。备份及旧库暂不清理。

### 对话检索范围

- 已确定默认全量检索当前登录用户全部知识库中已完成索引的资料。知识库分类仅用于资料组织和来源展示，不要求用户手动选库，也不先让模型分类或选择知识库。
- 全量指候选范围覆盖用户所有可检索资料，不表示返回所有 Chunk；对候选片段统一按向量相似度排序并取 Top K，具体 K 值和返回文本预算实现时确定。
- Go 将可信用户身份传给 Agent；模型只提供 query，不通过工具参数填写 userId 或扩大访问范围。Agent 查询通过 `rag_chunks.file_id → knowledge_files.knowledge_base_id → knowledge_bases.user_id` 关联限定归属，并过滤未完成索引的文件。必须先限定候选范围再取 Top K，不能全平台检索后再过滤权限。
- 一次查询跨用户自己的知识库统一检索，不逐库分配名额或逐库检索再拼接。返回命中片段的文件和知识库来源，供回答引用及前端溯源。
- 没有可检索资料时返回明确的空结果，不将范围扩大到其他用户。是否调用检索仍由模型决定，不在每次用户发消息时强制检索。

### 文件入库

- Go 完成 OSS 上传并成功保存业务文件记录后，立即触发 Agent 的入库流程，不需要用户再次点击建立索引。Agent 接手读取正文、切分、Embedding 与向量入库。
- 第一版按成功路径串联，不增加自动或手动重试、失败补偿、重启恢复、历史文件补建入口或消息队列。基础错误仍需传递，不吞错或把失败记为成功；上传保存完成不等于索引已经完成。
- “立即触发”确定的是执行时机，上传 HTTP 响应是否等待索引完成、Go 与 Agent 如何传递文件信息等接线细节在实现时明确，不由此引入复杂任务系统。

```text
OSS 上传成功 + knowledge_files 保存成功
  → Go 立即触发 Agent 入库
  → 读取原始 Markdown
  → 使用 Markdown 解析器识别真实标题
  → MarkdownSection[]（直接所属正文 + 完整标题路径）
  → 每个 Section 内递归文本切分 + overlap（不跨 Section）
  → RagChunk[]（继承标题路径与来源）
  → buildEmbeddingText：标题路径 + 正文
  → 批量 Embedding
  → 按 Chunk 对应写入原文、metadata 和 vector
```

上传成功与索引完成是不同状态。现有 Go 文件管理、OSS 和权限逻辑属于既有基础，切分模块不要重复实现上传链路。

### 前端来源展示与高亮

- 前端按工具名 `knowledge_search` 识别 RAG 调用，在工具卡片展示命中文件。工具展示结果携带 `fileId`、`knowledgeBaseId`、`fileName`，以及每个命中片段的 `chunkId`、`startOffset`、`endOffset`；同一文件命中多个片段时保留各自范围。
- 模型接收检索正文与标题语境；前端来源数据沿用现有 `tool.completed → Go 保存工具结果 → WebSocket → 工具卡片` 链路，不让模型自行生成文件 ID 或偏移量。
- 点击来源后，前端通过 Go 的鉴权 GET 接口取得 OSS 原文件正文，再根据原文 offset 定位和高亮。优先复用 `/api/knowledge-bases/:baseID/files/:fileID/content`，不让浏览器直接访问数据库或凭 object_key 绕过业务鉴权。
- 高亮属于本次整体目标，偏移量必须与 GET 返回文本使用同一坐标口径。采用 UTF-16 左闭右开范围，处理现有预览去 BOM 与换行转换带来的差异；不能用原始 Markdown offset 直接索引渲染后的 DOM 文本，渲染态高亮需映射到原文位置。
- 实现时核对现有 1 MiB 预览限制与 20 MiB 上传上限。超出预览能力需明确提示，不假定所有已上传文件都能通过现有接口获取全文。无法可靠映射的位置不伪造，也不能将只展示文件名视为已经完成高亮。

## Markdown Section 规则

- 使用 `unified@11.0.5` + `remark-parse@11.0.0` 解析 CommonMark AST，只遍历根节点的标题（含 Setext 标题）；列表、引用内部的嵌套标题不作为 Section 边界。代码块里的 `#` 不得被识别为文档标题。本版不引入 `remark-gfm`。
- 按 H1–H6 维护标题栈：遇到新标题，移除栈中同级及更深标题，再压入新标题。允许跳级，不虚构缺失的父标题。
- **Section 只保存当前标题直接所属的正文。遇到下一个标题（包括更低级标题）时结束当前正文段，再更新标题路径。** 父标题的作用域可以覆盖子标题，但父 Section 不重复包含子 Section 的正文。
- `headingPath` 保存从父标题到当前标题的完整标题文本路径，不包含 Markdown 的标题标记。
- 标题本身不生成独立 Chunk，也不重复放入 Section 正文；它作为 metadata 和 Embedding 语义上下文保留。
- 空 Section、只有空白或连续标题不生成正文片段，但必须正常更新标题栈，保留后续正文的父级路径。
- 第一个标题之前的正文，以及完全没有标题的文件，使用空 `headingPath`。空文件或仅包含标题的文件返回空结果。

例如 `# Redis` 下有介绍，随后是 `## 缓存` 的介绍和两个三级标题，正文归属应为：

| 正文 | headingPath |
| --- | --- |
| Redis 是一个内存数据库。 | `["Redis"]` |
| 缓存经常用于提升查询性能。 | `["Redis", "缓存"]` |
| 缓存击穿是…… | `["Redis", "缓存", "缓存击穿"]` |
| 缓存穿透是…… | `["Redis", "缓存", "缓存穿透"]` |

以上直接归属示例是 Section 边界的依据，避免将“下一个同级或更高级标题之前”理解成父子正文重复入库。

## Section 内的 Chunking

- 第一版使用 `@langchain/textsplitters@1.0.1` 的 `RecursiveCharacterTextSplitter`，与 TXT 复用切分规则。取消优先使用 `@msbayindir/rag-chunker` 的要求，不引入 Markdown-aware Chunker。
- 标题解析需要的库按实际依赖与 AST 能力选择。库能完成的工作直接交给库，自写逻辑主要限于标题栈、metadata 映射和流程编排。
- 逐个 Section 切分，不跨 Section 合并或 overlap，避免混淆标题归属。
- 每个 Section 在切分前，按 `headingPath.join(' > ')` 及其后的 `\n\n` 计算标题前缀代理 token 开销（无标题时为 0）。正文预算动态设为 `512 - 标题前缀开销`，不能先让正文达到预算再追加标题；这不构成对 Embedding 模型真实 token 上限的保证。
- 正文预算包含 overlap；不同 Section 的标题长度不同，必须分别计算预算。标题前缀已耗尽预算时明确报错，不生成空正文或静默截断标题。
- 分隔符依次为 `\r\n\r\n`、`\n\n`、`\r\n`、`\n`、`。`、`！`、`？`、`.`、`!`、`?`、空格、空字符串兜底。句末标点是简单边界，不做语言学分句。设置 `keepSeparator: true`，接受库对 Chunk 首尾空白的裁剪，不清洗内部空白或统一换行；字符兜底改为按 Unicode 码点拆分，避免切断代理对。
- 同一 Section 内目标 overlap 为 `min(64, floor(正文预算 × 0.125))`，计入 Chunk 总大小，不在已满的 Chunk 上额外追加。库保留完整片段，实际重叠量可以少于目标甚至为零，不保证语义完整。
- Overlap 缓解边界上下文丢失，不保证完整语义。第一版允许在代码块、列表、表格、引用及数学块内部切分，不补围栏或表头，不实现按代码语法、list item 或 table row 分组的特殊规则。
- 结构完整性保护及超大结构块的专门处理属于后续优化，不作为第一版验收条件；当前仍须保证不静默丢内容，并检查包含标题与 overlap 的完整 Embedding 输入预算。
- 不返回含义模糊的 `tokenCount` 字段；通过 `countBudgetTokens()` 明确取得 `cl100k_base` 预算计数。

## TXT 递归切分

- TXT 直接对全文进行递归文本切分，不解析标题 Section 或 Markdown block；即使文本包含 `#` 等字符，也不据此生成标题层级。
- 优先使用成熟递归切分器，实现前核对实际版本的 token 长度计算、分隔符保留、片段合并和 overlap 行为，不自行重写已有库能完成的算法。
- TXT 的 `chunkSize` 为 512 个代理 token，目标 overlap 为 64；与 Markdown 使用一致的代理计数口径，不将其视作模型真实 token 上限。
- 分隔边界优先级为：空行（段落）→ 换行 → 句子边界 → 空格 → 字符边界兜底。兼顾中英文句末标点，具体分隔符按所选库的真实行为配置。
- 能放入预算的段落尽量完整保留；仅对超长部分使用下一层更细边界递归切分。短片段可以合并成接近 chunkSize 的 Chunk，避免每句话单独入库。
- `chunkOverlap` 表示相邻 Chunk 的目标重叠 token 数，用于保留切分边界附近的上下文；要求 `0 <= chunkOverlap < chunkSize`，重叠内容计入 chunkSize，不额外突破预算。
- 优先按完整文本片段保留 overlap，实际重叠量可以少于设定值或为零，不强求精确重复固定 token 数。
- 保留正文文字、标点和内部空白，接受 Chunk 首尾空白被裁剪；仅空白片段跳过。超长且无法按较大边界拆开的文本才使用码点边界兜底，不切断代理对，并对最终文本检查代理预算。
- TXT Chunk 的 `headingPath` 为 `[]`，Embedding 输入直接使用 `content`。保留文件 ID、全文内的 Chunk 顺序和可靠的原文位置；沿用下文的位置映射规则。若复用数据契约需要 Section 关联，可将全文视为一个无标题来源单元，不引入标题解析流程。

## 数据契约与原文位置

以下是业务数据形状，具体实现可结合现有类型调整，但保留字段语义：

```typescript
interface MarkdownSection {
  id: string;
  content: string;
  headingPath: string[];
  startOffset: number;
  endOffset: number;
}

interface RagChunk {
  id: string;
  fileId: string;
  sectionId: string;
  content: string;
  headingPath: string[];
  chunkIndex: number;
  startOffset?: number;
  endOffset?: number;
}
```

- `content` 保存正文 Markdown，`headingPath` 独立保存；`chunkIndex` 表示当前 Section 内顺序，统一从 0 开始。
- Section 与 Chunk ID 使用 `crypto.randomUUID()`，每次准备生成新 ID，不作为重复入库的幂等机制；本阶段不写库。
- 解析库或 chunker 能可靠提供原文位置时，保留相对于原始 Markdown 的位置。统一使用 JavaScript 字符串 UTF-16 offset 和左闭右开区间，并在代码中说明。
- Section 正文使用原文切片，保留边界空白；BOM 仅在解析时跳过并补回坐标差，不改变输入原文坐标。Chunk 在所属 Section 内匹配，只有出现位置唯一时才提供成对 offset，换算后原文切片等于 `content`。
- 重复文本或无法精确匹配时同时省略两个 offset，不用第一个命中猜测来源。前端高亮及 GET 文本坐标对齐尚未实现，当前不承诺所有 Chunk 都能高亮。

## Embedding 与存储准备

### 模型接入决策

- 使用阿里百炼托管的 `text-embedding-v4`，不部署开源 Embedding 模型。文档和查询统一请求 1024 维 dense 向量，不混用不同模型或维度生成的向量。
- 使用北京 DashScope 原生同步接口，通过 Node `fetch` 调用，不复用聊天客户端或增加模型 SDK。Base URL 为已配置的 HTTPS `/api/v1` 地址；追加 `/services/embeddings/text-embedding/text-embedding`。请求采用 `input.texts`，以及 `parameters.dimension: 1024`、`text_type: 'document'`、`output_type: 'dense'`。
- 第一版使用 `js-tiktoken@1.0.21` 的 `cl100k_base` 作为代理计数器，文件中的特殊 token 字面量按普通文本编码。尚未确认与 `text-embedding-v4` 完全一致的本地 tokenizer，不能宣称本地预算保证模型硬上限；后续调用时由服务端做最终限制，超限如实报错，不静默截断。
- 官方参考：[通用文本向量同步接口](https://help.aliyun.com/zh/model-studio/text-embedding-synchronous-api/)。每批最多 10 条，每条模型真实上限为 8192 tokens。配置曾通过单条探针验证并返回 1024 维向量；该探针不代表完整入库链路已联调。

### 输入与持久化

标题不单独做 Embedding，每个正文 Chunk 构建一次输入：

```typescript
function buildEmbeddingText(chunk: RagChunk): string {
  const heading = chunk.headingPath.join(' > ');
  return heading ? `${heading}\n\n${chunk.content}` : chunk.content;
}
```

例如输入为：

```text
Redis > 缓存 > 缓存击穿

热点 Key 失效后，大量请求同时访问数据库……
```

- `buildEmbeddingText()` 不修改原 Chunk。无标题时直接使用正文，空正文不送入 Embedding。
- 对实际 `buildEmbeddingText()` 结果重新计算代理 token，确保不超过 512；不能仅依赖分别计算标题与正文后的 token 数相加。若超限，将正文预算减少 `max(最大超出量, ceil(当前正文预算 × 0.1))` 后重新切分所属 Section（TXT 为全文），并重新检查。预算严格递减，耗尽时明确失败，不截断标题或丢弃正文。此校验仅保证代理预算，不保证阿里模型的真实 token 上限。
- 实际接入 `embedChunks()` 时批量处理，保持返回向量与 Chunk 一一对应，并遵守所选模型的单条输入及批次限制。
- 最终持久化分别保存 `content`、含 `fileId / sectionId / headingPath / chunkIndex / 可选位置` 的 metadata，以及 `vector`。
- 不只存拼接后的 Embedding 文本。独立保留正文和标题路径，以支持引用、原文定位、重新生成向量和后续 Prompt 调整。

## 实现交付说明

### 第一阶段实现与本地验证（2026-09-29）

- `types.ts` 定义输入、Section 和 Chunk；`markdown.ts` 负责标题解析；`chunking.ts` 提供 `prepareChunks({ fileId, format, text })` 与 `chunkMarkdownSection(fileId, section)`；`embedding-text.ts` 提供完整文本构建、代理计数和预算常量。当前入口接收原文字符串，不读取 OSS，不调用模型或写入数据库。
- 依赖固定为 `unified@11.0.5`、`remark-parse@11.0.0`、`@langchain/textsplitters@1.0.1`、`js-tiktoken@1.0.21`；AST 类型使用开发依赖 `@types/mdast@4.0.4`。沿用 pnpm 和项目已有的 LangChain Core，没有升级现有依赖。
- `pnpm typecheck`、`pnpm build` 已通过。没有启动服务、占用端口或运行自动测试套件；通过编译产物的直接调用查看了本地样例。
- 空正文与仅标题文档返回空数组；标题跳级、Setext 标题、代码内伪标题和引用/列表内标题的样例归属符合预期。含 BOM 与 CRLF 的 MD 样例输出 `内存数据库。`（路径 `Redis`，范围 `[12,18)`）和 `提升性能。`（路径 `Redis > 缓存`，范围 `[31,36)`）。
- 120 行带编号中文 TXT 样例生成 7 个 Chunk，前 6 个完整输入各为 480 个代理 token，末块为 288；相邻原文范围重叠 48–50 个 UTF-16 单元，所有提供的位置均能准确回切原文。该字符重叠量不等于 token overlap 配置。
- 重复文字样例生成 9 个 Chunk，因来源位置不唯一而均省略 offset；600 个 emoji 的样例生成 3 个 Chunk，字符串均无孤立代理项，最大预算为 512。长标题 MD 样例生成的完整输入最大为 475，后续 Section 的序号重新从 0 开始；标题耗尽预算时明确报错。特殊 token 字面量按普通文本处理。

最小调用示例（`fileId` 在正式接线时传入业务文件 UUID）：

```typescript
import { prepareChunks } from './chunking.js';
import { buildEmbeddingText, countBudgetTokens } from './embedding-text.js';

const chunks = await prepareChunks({
  fileId,
  format: 'md',
  text: '# Redis\n\n## 缓存\n\n提升性能。',
});

for (const chunk of chunks) {
  const embeddingText = buildEmbeddingText(chunk);
  // Redis > 缓存\n\n提升性能。
  const budgetTokens = countBudgetTokens(embeddingText);
}
```

代码块、列表等结构可能被切开，首尾空白会被裁剪；没有可靠 offset 的 Chunk 暂不能精确高亮。本地代理预算不等于模型真实 token 数。第一阶段仅验证本地文本处理；第二阶段实现情况如下。

### 第二阶段：Embedding 与事务入库（2026-09-29）

已增加内部调用链，尚未接入 HTTP、OSS、上传触发、检索工具和前端：

```text
ingestFile({ fileId, format, text })
  → 校验 UUID、查询 knowledge_files 确认存在
  → prepareChunks()
  → buildEmbeddingText() + 512 代理预算校验
  → embedChunks()，每批最多 10 条、顺序执行
  → 全部成功后开启事务
  → 锁定文件记录 → 删除旧 Chunk → 每批最多 100 行参数化插入
  → COMMIT → { fileId, chunkCount }
```

- `embedding.ts` 负责模型请求、响应校验和索引对齐。单次请求（含响应读取）超时 30 秒，不重试；响应需覆盖批次完整且不重复的 `text_index`，每个向量必须包含 1024 个有限数值。正文和标题路径独立保存，只有模型输入使用组合文本。
- `store.ts` 使用 `pg@8.23.0`（开发类型 `@types/pg@8.23.1`），连接池最多 5 个连接，获取连接超时 5 秒、空闲超时 30 秒。同一事务始终使用同一 client，失败回滚，回滚失败则丢弃连接。SQL 错误只保留 SQLSTATE，不输出可能包含正文的 detail。
- `ingestion.ts` 提供 `createRagIngestor(settings.rag)`，返回 `ingestFile()` 和 `close()`。配置由统一的 `loadSettings()` 读取，创建组件时校验模型、维度、接口和连接串；未创建组件时不影响普通聊天，也不创建数据库连接。
- Agent 本地 `.env` 增加 `DATABASE_URL`，指向与 Go 相同的 Docker 数据库。运行时不读取 Go 配置；凭据不进入 Git 或文档。现有 Goose 表结构无需修改。
- 重复调用采用按文件整体替换。事务内锁定 `knowledge_files` 行，再次确认文件未被删除，并串行化该文件的替换；任意批次失败均回滚。并发调用以最后提交的完整版本为准，本版没有文档版本仲裁。
- 空文档或只有标题的文档不请求模型，事务清除该文件旧 Chunk 后返回 `chunkCount: 0`。不新增状态表，因此零 Chunk 不能单独用于区分“空文档已处理”和“尚未处理”。
- 此入口属于内部能力，调用方需提供可信文件 ID 和原文；用户归属鉴权在后续 Go 接线阶段完成，不将它直接暴露成公共接口。

调用方式（示例不会被服务启动入口自动执行）：

```typescript
import { loadSettings } from '../config.js';
import { createRagIngestor } from './ingestion.js';

const ingestor = createRagIngestor(loadSettings().rag);
try {
  const result = await ingestor.ingestFile({ fileId, format: 'md', text });
  // result: { fileId, chunkCount }
} finally {
  await ingestor.close();
}
```

服务接线时应复用组件，在服务关闭时调用 `close()`，不要为每个文件创建连接池。数据库事务仅包围替换写入，所有模型请求均在事务前完成。没有增加重试、补偿、历史文件补建或重新索引界面。

本轮 `pnpm typecheck` 和 `pnpm build` 已通过；未启动业务服务、运行联调脚本、调用真实模型或写入业务数据库。完整 Embedding 到数据库的链路仍待联调；后续验收应覆盖 MD/TXT、超过 10 个 Chunk 的批次对齐、重复入库、模型失败不写库、写库失败回滚、空正文、文件不存在、异常响应和维度、来源偏移量回切原文。

### 后续 Review 与验收清单

完成相关代码时说明实际数据流、使用的库及版本、Section 边界、递归切分与 overlap 行为、Embedding 文本示例，以及修改的文件。明确代码块和列表等结构可能被切开的已知限制，不声称已实现结构保护。

核对空文档、无标题、连续标题、标题跳级、代码内伪标题及长 Section 的行为；Markdown 和 TXT 均需核对中英文分隔、超长无分隔文本、片段合并及 overlap 的预算，Markdown 额外确认没有跨 Section overlap。遵循上级关于测试执行的约定，如实区分类型检查、人工检查与真实模型或数据库联调；未实现或未验证的能力必须明确标注。

