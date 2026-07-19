import { apiClient, publicApiClient, refreshAuthSession } from '@/api/client';
import type {
  ApiResponse,
  AuthSession,
  AuthUser,
  LoginRequest,
  RegisterRequest,
} from '@/api/types';

export async function register(payload: RegisterRequest) {
  const response = await publicApiClient.post<ApiResponse<AuthSession>>('/auth/register', payload);
  return response.data.data;
}

export async function login(payload: LoginRequest) {
  const response = await publicApiClient.post<ApiResponse<AuthSession>>('/auth/login', payload);
  return response.data.data;
}

export function refreshSession() {
  return refreshAuthSession();
}

export async function getCurrentUser() {
  const response = await apiClient.get<ApiResponse<AuthUser>>('/auth/me');
  return response.data.data;
}

export async function logout() {
  await apiClient.post('/auth/logout');
}
