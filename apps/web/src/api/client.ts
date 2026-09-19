import axios from 'axios';

import { getApiError, isApiErrorCode } from '@/api/errors';
import { useAuthStore } from '@/store/auth-store';
import type { ApiResponse } from '@/types/api';
import type { AuthSession } from '@/types/auth';

import type { InternalAxiosRequestConfig } from 'axios';

const terminalRefreshCodes = new Set([
  'AUTH_REFRESH_MISSING',
  'AUTH_REFRESH_INVALID',
  'AUTH_REFRESH_EXPIRED',
  'AUTH_REFRESH_REUSED', // 兼容轮换机制留下的历史 RT。
  'AUTH_ACCOUNT_DISABLED',
]);

const terminalAccessCodes = new Set([
  'AUTH_ACCESS_MISSING',
  'AUTH_ACCESS_INVALID',
  'AUTH_SESSION_INVALID',
  'AUTH_ACCOUNT_DISABLED',
]);

type AuthRequestConfig = InternalAxiosRequestConfig & {
  _authRetry?: boolean;
  _sessionVersion?: number;
};

const axiosOptions = {
  baseURL: '/api',
  headers: { Accept: 'application/json' },
  withCredentials: true,
  timeout: 10_000,
};

/** 认证接口不经过 AT 拦截器，避免刷新请求递归触发刷新。 */
export const publicApiClient = axios.create(axiosOptions);
export const apiClient = axios.create(axiosOptions);

let refreshPromise: Promise<void> | null = null;
let refreshVersion: number | null = null;
let initializationPromise: Promise<void> | null = null;

/** 同一会话的并发刷新共用一个请求，身份变化后不再复用旧任务。 */
export function refreshAuthSession(): Promise<void> {
  const { sessionVersion } = useAuthStore.getState();
  if (refreshPromise && refreshVersion === sessionVersion) {
    return refreshPromise;
  }

  const pendingRefresh = publicApiClient
    .post<ApiResponse<AuthSession>>('/auth/refresh')
    .then(({ data }) => {
      const current = useAuthStore.getState();
      if (current.sessionVersion !== sessionVersion) {
        throw new axios.CanceledError('登录状态已变化，忽略旧刷新结果');
      }

      const session = data.data;
      // Cookie 由同源标签共享，但不能把旧账号的请求自动切换到另一个账号。
      if (current.user && current.user.id !== session.user.id) {
        current.clearSession();
        throw new axios.CanceledError('登录账号已变化，请重新登录');
      }

      if (current.user === null) {
        current.setSession(session);
      } else {
        // 普通续期不改变会话代次，也不重新进入启动恢复状态。
        useAuthStore.setState({ accessToken: session.access_token, user: session.user });
      }
    })
    .catch((error: unknown) => {
      const current = useAuthStore.getState();
      if (
        current.sessionVersion === sessionVersion &&
        axios.isAxiosError(error) &&
        (error.response?.status === 401 || error.response?.status === 403) &&
        isApiErrorCode(error, terminalRefreshCodes)
      ) {
        current.clearSession();
      }
      throw error;
    })
    .finally(() => {
      if (refreshPromise === pendingRefresh) {
        refreshPromise = null;
        refreshVersion = null;
      }
    });

  refreshPromise = pendingRefresh;
  refreshVersion = sessionVersion;
  return pendingRefresh;
}

/** 页面刷新后用 Cookie 恢复内存身份；网络失败由账户入口提供重试。 */
export function ensureAuthInitialized(): Promise<void> {
  const current = useAuthStore.getState();
  if (current.bootstrapStatus === 'ready') {
    return Promise.resolve();
  }
  if (initializationPromise) {
    return initializationPromise;
  }

  const sessionVersion = current.sessionVersion;
  current.setBootstrapStatus('pending');
  initializationPromise = refreshAuthSession().catch(() => {
    const state = useAuthStore.getState();
    if (state.sessionVersion === sessionVersion && state.bootstrapStatus !== 'ready') {
      state.setBootstrapStatus('error');
    }
  });
  return initializationPromise;
}

export function retryAuthInitialization(): Promise<void> {
  if (useAuthStore.getState().bootstrapStatus === 'error') {
    initializationPromise = null;
  }
  return ensureAuthInitialized();
}

// 等待恢复、核对身份、添加凭证保持在同一处，避免拆散请求时序。
// eslint-disable-next-line complexity
apiClient.interceptors.request.use(async (config) => {
  const request = config as AuthRequestConfig;
  const initial = useAuthStore.getState();
  // 首次启动允许从匿名恢复身份；已发出的请求及其重放始终属于原会话。
  const sessionVersion =
    request._sessionVersion ??
    (initial.bootstrapStatus === 'ready' ? initial.sessionVersion : undefined);

  await ensureAuthInitialized();
  if (refreshPromise && refreshVersion === useAuthStore.getState().sessionVersion) {
    await refreshPromise;
  }

  const current = useAuthStore.getState();
  if (sessionVersion !== undefined && sessionVersion !== current.sessionVersion) {
    throw new axios.CanceledError('登录状态已变化，取消旧请求');
  }
  if (!current.accessToken || !current.user) {
    throw new axios.AxiosError(
      current.bootstrapStatus === 'error' ? '认证服务暂不可用，请重试' : '请先登录',
      current.bootstrapStatus === 'error' ? 'AUTH_UNAVAILABLE' : 'AUTH_REQUIRED',
      request,
    );
  }

  request._sessionVersion = current.sessionVersion;
  request.headers.set('Authorization', `Bearer ${current.accessToken}`);
  return request;
});

apiClient.interceptors.response.use(
  (response) => {
    const request = response.config as AuthRequestConfig;
    if (request._sessionVersion !== useAuthStore.getState().sessionVersion) {
      throw new axios.CanceledError('登录状态已变化，忽略旧响应');
    }
    return response;
  },
  // 错误分类与一次重放按顺序处理，不再拆成透传 helper。
  // eslint-disable-next-line complexity
  async (error: unknown) => {
    if (!axios.isAxiosError(error) || !error.config) {
      throw error;
    }

    const request = error.config as AuthRequestConfig;
    const current = useAuthStore.getState();
    if (
      request._sessionVersion !== undefined &&
      request._sessionVersion !== current.sessionVersion
    ) {
      throw new axios.CanceledError('登录状态已变化，忽略旧响应');
    }
    const status = error.response?.status;
    if (status !== 401 && status !== 403) {
      throw error;
    }

    const code = getApiError(error)?.code ?? '';
    const usedCurrentToken =
      current.accessToken !== null &&
      request.headers.get('Authorization') === `Bearer ${current.accessToken}`;

    if (terminalAccessCodes.has(code)) {
      if (usedCurrentToken) {
        current.clearSession();
      }
      throw error;
    }
    if (status !== 401 || code !== 'AUTH_ACCESS_EXPIRED') {
      throw error;
    }
    if (request._authRetry) {
      if (usedCurrentToken) {
        current.clearSession();
      }
      throw error;
    }

    request._authRetry = true;
    if (usedCurrentToken) {
      await refreshAuthSession();
    }
    if (request._sessionVersion !== useAuthStore.getState().sessionVersion) {
      throw new axios.CanceledError('登录状态已变化，取消旧请求');
    }
    // 迟到的过期响应直接重用新 AT；请求拦截器会统一替换 Authorization。
    return apiClient(request);
  },
);
