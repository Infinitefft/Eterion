import { apiClient, publicApiClient } from '@/api/client';
import { useAuthStore } from '@/store/auth-store';
import type { ApiResponse } from '@/types/api';
import type { AuthSession, AuthUser, LoginRequest, RegisterRequest } from '@/types/auth';

/** 注册新用户；成功后后端会同时创建会话，因此返回值可直接用于登录。 */
export async function register(payload: RegisterRequest) {
  const response = await publicApiClient.post<ApiResponse<AuthSession>>('/auth/register', payload);
  return response.data.data;
}

/** 使用手机号和密码登录，并返回需要写入认证 Store 的会话信息。 */
export async function login(payload: LoginRequest) {
  const response = await publicApiClient.post<ApiResponse<AuthSession>>('/auth/login', payload);
  return response.data.data;
}

/** 使用当前 Access Token 获取后端确认过的用户信息。 */
export async function getCurrentUser() {
  const response = await apiClient.get<ApiResponse<AuthUser>>('/auth/me');
  return response.data.data;
}

/** 撤销当前后端会话，并由后端清除 Refresh Token Cookie。 */
export async function logout() {
  const { sessionVersion } = useAuthStore.getState();
  await publicApiClient.post('/auth/logout');
  const current = useAuthStore.getState();
  if (current.sessionVersion === sessionVersion) {
    current.clearSession();
  }
}
