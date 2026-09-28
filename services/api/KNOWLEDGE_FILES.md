# 知识库文件上传

## 当前链路

前端使用现有 apiClient 携带登录凭证，发送一个 multipart/form-data POST 到后端。后端校验登录和知识库归属、文件类型及大小，将文件上传 OSS，成功后写入 knowledge_files，再返回文件记录。前端更新文件列表；多选时逐个请求，成功的文件从待上传列表移除，失败用 toast 提示并保留未完成文件。

前端不请求 OSS，不使用上传签名或确认入库接口，不需要为此配置 OSS 浏览器 CORS。之前的 /uploads 和 /uploads/complete 已移除。

## 接口

- POST /api/knowledge-bases/{baseID}/files：携带现有 Authorization: Bearer 登录令牌；multipart 仅一个 file 字段；成功返回 201，data 为文件记录。
- GET /api/knowledge-bases/{baseID}/files：相同鉴权；返回已入库文件数组，无文件时返回 []。
- GET /api/knowledge-bases 返回的知识库额外含 file_count，用于真实显示文件数量。

单文件非空且不超过 20 MiB，支持 UTF-8 编码的 TXT、MD。前端只需提交 FormData，不手动设置 Content-Type，浏览器自动补 boundary。

## 数据映射

knowledge_files 保存 id、knowledge_base_id、original_name、object_key、mime_type、size_bytes 和创建/更新时间。OSS 对象键为 knowledge/{user_id}/{base_id}/{file_id}.扩展名。

Bucket 来自后端配置。Bucket + object_key 唯一定位实际对象；本地数据库不存文件字节或临时签名链接。现有表结构不变，无需迁移。

文件先读入受限内存（单文件最多 20 MiB），不使用会自动落盘的 FormFile/ParseMultipartForm。上传路由单独延长读取与响应期限，其余请求保持原超时。后端使用官方 OSS SDK PutObject 和环境变量密钥，浏览器不会收到密钥。

## 配置与手动验证

1. services/api/.env 中填写 OSS_BUCKET、OSS_REGION、OSS_ENDPOINT、OSS_ACCESS_KEY_ID、OSS_ACCESS_KEY_SECRET。使用专用 RAM 用户，PutObject 权限限定在该 Bucket 的 knowledge/*。Bucket 私有读写；此次后端上传不依赖浏览器跨域配置。
2. 由你重启自己的后端加载新路由和环境变量。自动测试不占 8080，也不使用真实 OSS 凭证。
3. 登录后进入自己的知识库，点击添加文件，选择一个小 TXT 或 MD，再点击开始上传。
4. 成功后弹窗关闭，列表出现真实文件；刷新页面后仍能查询到。
5. 在 OSS 控制台核对对象，在数据库按返回的文件 ID 查询 knowledge_files，确认 object_key 与 OSS 对象一致。
6. 验证空文件、超大文件和不支持的格式会报错，切换账号不能访问别人的知识库。

## 当前边界

支持 TXT 纯文本和 MD 渲染预览。不包含下载、解析、切分、Embedding、分片或断点续传。上传检查 UTF-8 编码，MIME 按扩展名设置。

OSS 和数据库不支持跨系统原子提交。若 OSS 成功但数据库失败，可能保留未关联对象；数据库连接中断时提交结果也可能不确定，因此不会盲目删除 OSS 对象。可按 object_key 核对处理。

上传请求超时或响应丢失时，前端提示先刷新列表确认结果。当前不支持请求级幂等，重新上传会生成新的文件 ID。多文件批次不是事务，前面成功的文件会保留。

## 文件预览

GET /api/knowledge-bases/{baseID}/files/{fileID}/content 使用已有登录鉴权，后端按文件记录中的 object_key 读取 OSS，返回 data: {content, format}，format 为 txt 或 md。需要 RAM 用户有该目录的 oss:GetObject 权限。

仅点击文件才加载文本，关闭或切换文件会取消旧请求。TXT 保留原始换行，MD 使用 react-markdown + remark-gfm 渲染，聊天的流式 Markdown 组件不变。不渲染原始 HTML，不自动加载 Markdown 图片。上传最多 20 MiB，在线预览最多 1 MiB，超出会明确提示；仅支持 UTF-8（允许 BOM）。之前上传的其他格式仍保留记录，但不提供预览。

## 文件删除

DELETE /api/knowledge-bases/{baseID} 删除当前用户的知识库：先逐个删除库内 OSS 文件及文件记录，最后删除知识库记录，成功返回 204。中途失败停止，保留知识库供重试；已删除的文件不会恢复。数据库外键约束会阻止删除仍有文件的知识库（例如同时上传了新文件）。前端有独立的三点菜单和二次确认，明确告知会删除全部文件。

DELETE /api/knowledge-bases/{baseID}/files/{fileID} 使用已有登录鉴权，校验知识库归属后，从数据库取得 object_key，先删除 OSS 对象，再删除文件记录。成功返回 204；重复删除已不存在的记录也返回 204。RAM 用户需要该 Bucket 的 knowledge/* 范围内的 oss:DeleteObject 权限。

OSS 删除失败时保留数据库记录并提示错误；如果 OSS 已删除而数据库操作失败，记录可能暂时存在，但内容已不可用，再次确认删除可以重试完成。这两个存储之间没有原子事务。

前端悬停文件显示垃圾桶图标，点击后出现居中确认弹窗。请求期间禁止重复提交；失败保留弹窗并展示原因，成功更新文件列表、知识库文件数，并关闭被删除文件的预览。

当前使用普通 DeleteObject：未开启版本控制的 Bucket 会删除对象；开启或暂停过版本控制的 Bucket 可能保留历史版本，本接口不清理历史版本。参见 [OSS DeleteObject 文档](https://www.alibabacloud.com/help/en/oss/developer-reference/deleteobject)。
