/**
 * 后端成功响应的统一外层结构。
 * `T` 用于约束当前接口真正返回的业务数据类型。
 */
export type ApiResponse<T> = {
  /** 接口的业务数据。 */
  data: T;
  /** 后端生成的请求追踪 ID，部分成功响应可能不返回。 */
  request_id?: string;
};

/** 后端业务错误的主体，用于统一展示错误并决定前端下一步行为。 */
export type ApiErrorBody = {
  /** 稳定的机器可读错误码，前端逻辑应优先判断该字段。 */
  code: string;
  /** 可以直接展示给用户的错误说明。 */
  message: string;
  /** 后端建议的后续动作，例如重新登录或修正输入。 */
  next_action: string;
  /** 表单字段级错误，键名与请求字段保持一致。 */
  fields?: Record<string, string>;
};

/** 后端失败响应的统一外层结构。 */
export type ApiErrorResponse = {
  error: ApiErrorBody;
  /** 用于前后端联合排查问题的请求追踪 ID。 */
  request_id?: string;
};
