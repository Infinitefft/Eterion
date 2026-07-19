/** 认证成功后前端允许使用的当前用户信息。 */
export type AuthUser = {
  /** 用户的全局唯一标识。 */
  id: string;
  /** 用户登录手机号。 */
  phone: string;
  /** 工作区和账户菜单中展示的昵称。 */
  nickname: string;
};

/**
 * 登录、注册或刷新成功后的认证结果。
 * Refresh Token 不属于该类型，它始终由后端写入 HttpOnly Cookie。
 */
export type AuthSession = {
  /** 调用受保护接口时放入 Authorization 请求头的短期令牌。 */
  access_token: string;
  /** 当前后端只支持 Bearer 认证。 */
  token_type: 'Bearer';
  /** Access Token 剩余有效时间，单位为秒。 */
  expires_in: number;
  user: AuthUser;
};

/** 登录接口请求体约束。 */
export type LoginRequest = {
  phone: string;
  password: string;
};

/** 注册接口请求体约束，在登录字段基础上增加昵称。 */
export type RegisterRequest = LoginRequest & {
  nickname: string;
};
