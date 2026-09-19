# IM 后端适配验证记录

验证日期：2026-09-19。

## 本次改动

- 本地开发数据库由 goose 版本 5 升级到 6，确认 `agent_blocks`、`chats.last_seq`、新的 Run 状态约束与活跃 Run 唯一索引已存在。沿用已有迁移文件，未重建数据库。
- Snapshot 的会话归属、消息、Run、过程块查询使用同一个只读 `REPEATABLE READ` 事务，保证正文与 `lastSeqId` 对应同一数据库视图。
- Run 失败或取消时，在同一事务中结束尚在运行的工具，并分配连续序号。提交后按工具、消息、Run 的顺序广播终态；已完成或已失败的工具不变。
- 工具取消沿用 `tool.failed`，错误为 `RUN_CANCELLED / 工具调用已取消`。消息与 Run 仍为 `cancelled`，错误仍为 `null`。
- 联调发现序号分配时 GORM 的 `Update` 会隐式改写会话时间，导致 `thread.updated` 与详情不一致。改用 `UpdateColumn` 仅推进 `last_seq`；会话时间由消息提交或修改标题显式更新，刷新后的列表排序与实时事件保持一致。

## 确定性回归

新增 Go 集成测试使用真实 PostgreSQL；每次创建独立随机 schema，应用仓库现有迁移，并在结束时清理该 schema。`ETERION_TEST_DATABASE_URL` 未设置时明确跳过这些集成测试。

已通过：

- Snapshot 读取会话后暂停，另一连接提交 delta，再继续读取其余实体。第一次快照保持旧正文和旧序号，第二次快照包含新正文和新序号；通过同步屏障控制并发，不依赖固定延时。
- 真实 Ticket、HTTP、WebSocket、Go SSE 适配器与数据库组成的两轮聊天链路：检查 ACK 关联、输入/输出消息、Run、连续 Thread 序号和完整快照。
- 可控 SSE Agent 注入部分正文后失败、正文中取消、工具中取消和工具执行期间上游失败；检查部分正文保留、错误、终态落库、广播及上游请求取消。
- 完成、失败、取消后的重复取消仅返回 ACK，快照和序号保持不变；已完成及已失败的工具不会被覆盖。
- 快照 Thread 元数据与最近一次 `thread.updated` 一致；新增断言在修复前实际失败（更新时间相差 32ms），修复后通过。

执行命令（数据库地址由本地环境提供，勿提交凭证）：

```powershell
go test ./internal/modules/chat ./internal/agent/remote ./internal/config ./internal/modules/auth -count=1
go build -o ../../.cache/im-validation/eterion-api-final.exe ./cmd/server
```

运行目录为 `services/api`。本次执行时已设置 `ETERION_TEST_DATABASE_URL`，集成测试实际运行并通过；Go 服务也已重新编译、启动。

## 真实 Node Agent 与浏览器联调

使用专用本地联调账号、真实 React 页面和现有 Node Agent，模型为 `DeepSeek-V4-Pro`。通过第二条同用户 WebSocket 记录事件；工具调用很短，因此在收到目标 `tool.started` 后由采集器立即发送正常的 `run.cancel` 命令，未延迟、替换或修改 Node 工具。

| 场景 | 实际结果 |
| --- | --- |
| 新建会话 | 页面进入新会话，收到正文增量并正常完成 |
| 同会话续发 | 第二轮正确回答第一轮要求记住的“银杏314”，完成后刷新，两轮消息逐字一致 |
| 正文流式停止 | 在页面点击停止生成，保留部分正文，消息与 Run 为 cancelled；刷新前后内容一致 |
| web_search 执行中取消 | 顺序收到 tool.failed、message.completed、run.status；页面显示工具调用已取消，刷新前后内容一致 |
| web_fetch 执行中取消 | 前面三个真实搜索工具保持 completed，仅正在读取网页的工具变为 failed/RUN_CANCELLED；刷新前后内容一致 |

首批两个会话分别收到连续序号 `1–670`、`1–101`，合计 771 个唯一事件、5 个 Run、10 条消息、5 个工具块。跨观察连接的 120 次重复观察内容一致，没有同连接重复序号或缺失/重复终态。7 份快照的正文、消息/Run/工具状态与数据库核对通过。

这批数据暴露的会话时间差异保留在原始审计记录中；修复后另建会话，通过同一生产 WebSocket 发送新建和续发命令，采集请求与 ACK，并在真实页面验证两轮上下文及刷新后逐字一致。新会话的序号连续覆盖 `1–18`。首次 UI 发送的 ACK 仅回到 UI 连接，因此其字段验证以这次补充采集和确定性集成测试为依据。

补测审计通过：两条 ACK 各出现一次，`requestId / commandType / threadId / inputMessageId / outputMessageId / runId` 与命令、事实事件、快照、数据库对应一致，ACK 不占序号。两份快照按各自游标重放后，Thread 元数据（含更新时间）、消息和 Run 全部一致；最新快照与数据库一致。最终数据库版本为 6，无遗留测试 schema，无活跃 Run。

本机脱敏事件和快照保存在 `.cache/im-validation/`，最终补测报告位于其 `final/capture-audit.json`，该目录不提交。联调会话保留，方便人工检查；采集进程已停止，修复后的 Go API 与前端继续运行。

## 验证边界

- 模型正常调用、正文停止及两种真实工具取消已经联调；上游失败通过可控 SSE 测试服务验证，不声称诱发了真实模型服务故障。
- 已检查完成后的重复取消，并审查 Run 行锁与终态检查；未进行完成/取消同时抢锁的压力测试。
- 本轮不涉及 HITL、自动断线补齐、进程重启恢复或 Agent 编排修改。这里的刷新验证发生在 Run 已进入终态之后。
