import axios, { AxiosHeaders } from 'axios';

import { getApiError, isApiErrorCode } from '@/api/errors';
import { useAuthStore } from '@/store/authStore';
import type { ApiErrorResponse, ApiResponse } from '@/types/api';
import type { AuthSession } from '@/types/auth';

import type { InternalAxiosRequestConfig } from 'axios';

const AUTH_CHANNEL_NAME = 'eterion-auth';
const REFRESH_LOCK_NAME = 'eterion-auth-refresh';

// Refresh Token 已经无法继续换取会话时，前端必须清空本地认证状态。
const terminalRefreshCodes = new Set([
  'AUTH_REFRESH_MISSING',
  'AUTH_REFRESH_INVALID', // 无效
  'AUTH_REFRESH_EXPIRED', // 已到期
  'AUTH_REFRESH_REUSED',
  'AUTH_ACCOUNT_DISABLED', // 禁用
]);

// 这些 Access Token 错误表示会话不可恢复，不应该继续尝试 refresh。
const terminalAccessCodes = new Set([
  'AUTH_ACCESS_MISSING',
  'AUTH_ACCESS_INVALID',
  'AUTH_SESSION_INVALID',
  'AUTH_ACCOUNT_DISABLED',
]);

/** 为 Axios 原请求增加内部重试标记，防止 401 重放形成死循环。 */
type RetryableRequestConfig = InternalAxiosRequestConfig & {
  _authRetry?: boolean;
};

/** 同源标签页之间同步登录结果和退出事件的消息约束。 */
type AuthChannelMessage =
  | { sourceId: string; type: 'session'; session: AuthSession }
  | { sourceId: string; type: 'logout' };

const axiosOptions = {
  baseURL: '/api',
  headers: { Accept: 'application/json' },
  withCredentials: true,
};

/** 不带认证拦截器的客户端，专门用于登录、注册和刷新等公共认证接口。 */
export const publicApiClient = axios.create(axiosOptions);
/** 受保护业务接口使用的客户端，会自动添加 AT 并处理过期刷新。 */
export const apiClient = axios.create(axiosOptions);

const sourceId = createSourceId();
const authChannel = createAuthChannel();

// 合并同一标签页内同时出现的多个刷新请求，避免重复消费轮换型 Refresh Token。
let refreshPromise: Promise<AuthSession> | null = null;
// 缓存应用级初始化任务，保证整个页面生命周期只执行一次登录恢复。
let initializationPromise: Promise<void> | null = null;

// 接收其他标签页的认证事件；消息只更新本地 Store，不再次广播。
authChannel?.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (!isAuthChannelMessage(event.data) || event.data.sourceId === sourceId) {
    return;
  }

  if (event.data.type === 'session') {
    useAuthStore.getState().setSession(event.data.session);
    return;
  }

  useAuthStore.getState().clearSession();
});

/** 写入当前标签页的认证状态，并按需同步到其他同源标签页。 */
export function commitAuthSession(session: AuthSession, broadcast = true) {
  useAuthStore.getState().setSession(session);
  if (broadcast) {
    postAuthMessage({ sourceId, type: 'session', session });
  }
}

/** 清空当前标签页的认证状态，并按需通知其他同源标签页退出。 */
export function clearAuthSession(broadcast = true) {
  useAuthStore.getState().clearSession();
  if (broadcast) {
    postAuthMessage({ sourceId, type: 'logout' });
  }
}

/** 直接调用后端 refresh 接口；该请求不能经过 401 响应拦截器。 */
export async function requestSessionRefresh() {
  const response = await publicApiClient.post<ApiResponse<AuthSession>>('/auth/refresh');
  return response.data.data;
}

/**
 * 获取一个可用的新会话。
 * 同标签页复用 refreshPromise，多标签页再通过 Web Lock 串行化 RT 轮换。
 */
export function refreshAuthSession(
  failedAccessToken: string | null = useAuthStore.getState().accessToken,
) {
  if (refreshPromise) {
    return refreshPromise;
  }

  const pendingRefresh = runWithRefreshLock(async (): Promise<AuthSession> => {
    const current = useAuthStore.getState();

    // 等锁期间其他标签页可能已经广播了新 AT，此时无需再次调用 refresh。
    if (
      current.accessToken !== null &&
      current.user !== null &&
      current.accessToken !== failedAccessToken
    ) {
      return {
        access_token: current.accessToken,
        token_type: 'Bearer',
        expires_in: 0,
        user: current.user,
      };
    }

    try {
      const session = await requestSessionRefresh();
      commitAuthSession(session);
      return session;
    } catch (error) {
      // 只有确定不可恢复的认证错误才退出；断网和 5xx 会保留现有会话。
      if (isApiErrorCode(error, terminalRefreshCodes)) {
        clearAuthSession();
      }
      throw error;
    }
  }).finally(() => {
    if (refreshPromise === pendingRefresh) {
      refreshPromise = null;
    }
  });

  refreshPromise = pendingRefresh;
  return pendingRefresh;
}

/** 页面首次加载时通过 HttpOnly RT Cookie 恢复内存中的登录状态。 */
export function ensureAuthInitialized() {
  if (initializationPromise) {
    return initializationPromise;
  }

  useAuthStore.getState().setBootstrapStatus('pending');
  initializationPromise = refreshAuthSession()
    .then(() => {
      useAuthStore.getState().setBootstrapStatus('ready');
    })
    .catch(() => {
      const state = useAuthStore.getState();
      if (state.bootstrapStatus !== 'ready') {
        state.setBootstrapStatus('error');
      }
    });

  return initializationPromise;
}

/** 启动恢复因网络或服务错误失败后，由账户入口手动重新执行。 */
export function retryAuthInitialization() {
  if (useAuthStore.getState().bootstrapStatus !== 'error') {
    return initializationPromise ?? Promise.resolve();
  }

  initializationPromise = null;
  return ensureAuthInitialized();
}

// 每次请求前即时读取 Store，确保重放请求使用刚刷新的 AT。
apiClient.interceptors.request.use((config) => {
  const accessToken = useAuthStore.getState().accessToken;
  if (accessToken !== null) {
    config.headers.set('Authorization', `Bearer ${accessToken}`);
  }
  return config;
});

// 全局处理受保护请求错误；只有明确的 AT 过期错误才进入无感刷新。
apiClient.interceptors.response.use((response) => response, handleAuthenticatedResponseError);

/** 处理受保护请求错误，并在 AT 过期时刷新后重放原请求一次。 */
async function handleAuthenticatedResponseError(error: unknown) {
  const failure = getAuthenticatedFailure(error);
  if (failure === null) {
    throw toError(error);
  }

  if (terminalAccessCodes.has(failure.code)) {
    clearAuthSession();
    throw failure.error;
  }

  if (!failure.canRefresh || failure.request._authRetry === true) {
    throw failure.error;
  }

  failure.request._authRetry = true;
  const failedAccessToken = getBearerToken(failure.request) ?? useAuthStore.getState().accessToken;

  try {
    const session = await refreshAuthSession(failedAccessToken);
    // 原请求对象可能仍带着旧 AT，重放前必须显式替换 Authorization。
    failure.request.headers = AxiosHeaders.from(failure.request.headers);
    failure.request.headers.set('Authorization', `Bearer ${session.access_token}`);
    return await apiClient(failure.request);
  } catch (refreshError) {
    throw toError(refreshError);
  }
}

/** 将未知异常整理成拦截器需要的认证失败上下文。 */
function getAuthenticatedFailure(error: unknown) {
  if (!axios.isAxiosError<ApiErrorResponse>(error) || !error.response || !error.config) {
    return null;
  }

  const apiError = getApiError(error);
  return {
    error,
    code: apiError?.code ?? '',
    canRefresh: error.response.status === 401 && apiError?.code === 'AUTH_ACCESS_EXPIRED',
    request: error.config as RetryableRequestConfig,
  };
}

/** 为当前标签页创建唯一来源 ID，避免处理自己广播的消息。 */
function createSourceId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** 浏览器支持 BroadcastChannel 时创建跨标签认证消息通道。 */
function createAuthChannel() {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') {
    return null;
  }
  return new BroadcastChannel(AUTH_CHANNEL_NAME);
}

/** 向其他同源标签页发送认证状态变化。 */
function postAuthMessage(message: AuthChannelMessage) {
  authChannel?.postMessage(message);
}

/** 运行时校验跨标签消息，拒绝不符合协议的任意数据。 */
function isAuthChannelMessage(value: unknown): value is AuthChannelMessage {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const message = value as Record<string, unknown>;
  if (typeof message.sourceId !== 'string') {
    return false;
  }
  if (message.type === 'logout') {
    return true;
  }
  return message.type === 'session' && isAuthSession(message.session);
}

/** 运行时校验广播过来的会话结构，防止错误数据进入 Store。 */
function isAuthSession(value: unknown): value is AuthSession {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const session = value as Record<string, unknown>;
  if (
    typeof session.access_token !== 'string' ||
    session.token_type !== 'Bearer' ||
    typeof session.expires_in !== 'number' ||
    typeof session.user !== 'object' ||
    session.user === null
  ) {
    return false;
  }

  const user = session.user as Record<string, unknown>;
  return (
    typeof user.id === 'string' &&
    typeof user.phone === 'string' &&
    typeof user.nickname === 'string'
  );
}

/** 从原 Axios 请求中提取实际发送的 Bearer Token。 */
function getBearerToken(config: InternalAxiosRequestConfig) {
  const authorization = AxiosHeaders.from(config.headers).get('Authorization');
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
    return null;
  }
  return authorization.slice('Bearer '.length);
}

/** 使用 Web Locks 串行化多标签刷新；不支持时退化为当前标签页执行。 */
function runWithRefreshLock<T>(task: () => Promise<T>) {
  if (typeof navigator === 'undefined' || !('locks' in navigator)) {
    return task();
  }
  return navigator.locks.request(REFRESH_LOCK_NAME, task);
}

/** 保证响应拦截器始终抛出标准 Error 实例。 */
function toError(error: unknown) {
  return error instanceof Error ? error : new Error('请求失败', { cause: error });
}
