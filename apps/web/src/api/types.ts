export type ApiResponse<T> = {
  data: T;
  request_id?: string;
};

export type ApiErrorBody = {
  code: string;
  message: string;
  next_action: string;
  fields?: Record<string, string>;
};

export type ApiErrorResponse = {
  error: ApiErrorBody;
  request_id?: string;
};

export type AuthUser = {
  id: string;
  phone: string;
  nickname: string;
};

export type AuthSession = {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  user: AuthUser;
};

export type LoginRequest = {
  phone: string;
  password: string;
};

export type RegisterRequest = LoginRequest & {
  nickname: string;
};
