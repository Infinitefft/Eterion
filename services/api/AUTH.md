# 认证接入说明

当前认证使用内存中的 Bearer Access Token（AT，默认 15 分钟）和 `eterion_rt` HttpOnly Cookie（RT，默认 30 天绝对有效期）。注册、登录返回 AT 和用户信息并设置 RT Cookie；`POST /api/auth/refresh` 使用 Cookie 返回相同结构的新 AT，不轮换 RT、不延长 RT 有效期，也不写 Cookie。到期后需要重新登录。

前端在应用启动时恢复认证。页面和业务模块读取 `useAuthStore` 的 `bootstrapStatus` 与 `user`，在恢复完成且有用户后加载受保护数据；受保护 HTTP 请求统一使用 `apiClient`。登录或注册成功后调用 `useAuthStore.getState().setSession(session)`；主动退出调用 `logout()`，由它发送 RT Cookie 请求并清理本标签页状态。业务不直接调用刷新接口，认证模块也不负责聊天数据加载或 WebSocket 重连。

同一标签页内的并发过期请求共享一次刷新；成功后原请求最多重放一次。会话代次阻止迟到请求覆盖新会话，认证请求设置 10 秒超时。刷新凭证确实失效时清理本地身份；网络或服务暂时失败时保留可恢复状态，页面可提供重试入口。

`POST /api/auth/logout` 使用 RT Cookie，不要求 AT；成功或 Cookie 已缺失、无效、过期时均清除 Cookie 并返回 `204`。刷新与退出请求若携带 `Origin`，必须匹配服务端允许的来源。Cookie 为 `SameSite=Lax`、`Path=/api/auth`；HTTPS 环境启用 `Secure`，本地 HTTP 开发可关闭。

当前不做 RT 轮换、复用检测或跨标签页实时身份同步。现存未使用且未过期的旧 RT 可继续刷新，无需数据迁移；历史已标记为使用过的 RT 返回 `AUTH_REFRESH_REUSED`，但不连带撤销有效会话。退出会使该会话的旧 AT 在后续受保护 HTTP 请求中失效，但不保证立即断开其他标签页已经建立的 WebSocket；这些标签页在后续认证请求时自行更新状态。
