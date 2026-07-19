import axios, { AxiosHeaders } from 'axios';

import { getApiError, isApiErrorCode } from '@/api/errors';
import type { ApiErrorResponse, ApiResponse, AuthSession } from '@/api/types';
import { useAuthStore } from '@/store/authStore';

import type { InternalAxiosRequestConfig } from 'axios';

const AUTH_CHANNEL_NAME = 'eterion-auth';
const REFRESH_LOCK_NAME = 'eterion-auth-refresh';

const terminalRefreshCodes = new Set([
  'AUTH_REFRESH_MISSING',
  'AUTH_REFRESH_INVALID',
  'AUTH_REFRESH_EXPIRED',
  'AUTH_REFRESH_REUSED',
  'AUTH_ACCOUNT_DISABLED',
]);

const terminalAccessCodes = new Set([
  'AUTH_ACCESS_MISSING',
  'AUTH_ACCESS_INVALID',
  'AUTH_SESSION_INVALID',
  'AUTH_ACCOUNT_DISABLED',
]);

type RetryableRequestConfig = InternalAxiosRequestConfig & {
  _authRetry?: boolean;
};

type AuthChannelMessage =
  | { sourceId: string; type: 'session'; session: AuthSession }
  | { sourceId: string; type: 'logout' };

const axiosOptions = {
  baseURL: '/api',
  headers: { Accept: 'application/json' },
  withCredentials: true,
};

export const publicApiClient = axios.create(axiosOptions);
export const apiClient = axios.create(axiosOptions);

const sourceId = createSourceId();
const authChannel = createAuthChannel();

let refreshPromise: Promise<AuthSession> | null = null;
let initializationPromise: Promise<void> | null = null;

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

export function commitAuthSession(session: AuthSession, broadcast = true) {
  useAuthStore.getState().setSession(session);
  if (broadcast) {
    postAuthMessage({ sourceId, type: 'session', session });
  }
}

export function clearAuthSession(broadcast = true) {
  useAuthStore.getState().clearSession();
  if (broadcast) {
    postAuthMessage({ sourceId, type: 'logout' });
  }
}

export async function requestSessionRefresh() {
  const response = await publicApiClient.post<ApiResponse<AuthSession>>('/auth/refresh');
  return response.data.data;
}

export function refreshAuthSession(
  failedAccessToken: string | null = useAuthStore.getState().accessToken,
) {
  if (refreshPromise) {
    return refreshPromise;
  }

  const pendingRefresh = runWithRefreshLock(async (): Promise<AuthSession> => {
    const current = useAuthStore.getState();

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

export function retryAuthInitialization() {
  if (useAuthStore.getState().bootstrapStatus !== 'error') {
    return initializationPromise ?? Promise.resolve();
  }

  initializationPromise = null;
  return ensureAuthInitialized();
}

apiClient.interceptors.request.use((config) => {
  const accessToken = useAuthStore.getState().accessToken;
  if (accessToken !== null) {
    config.headers.set('Authorization', `Bearer ${accessToken}`);
  }
  return config;
});

apiClient.interceptors.response.use((response) => response, handleAuthenticatedResponseError);

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
    failure.request.headers = AxiosHeaders.from(failure.request.headers);
    failure.request.headers.set('Authorization', `Bearer ${session.access_token}`);
    return await apiClient(failure.request);
  } catch (refreshError) {
    throw toError(refreshError);
  }
}

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

function createSourceId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createAuthChannel() {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') {
    return null;
  }
  return new BroadcastChannel(AUTH_CHANNEL_NAME);
}

function postAuthMessage(message: AuthChannelMessage) {
  authChannel?.postMessage(message);
}

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

function getBearerToken(config: InternalAxiosRequestConfig) {
  const authorization = AxiosHeaders.from(config.headers).get('Authorization');
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
    return null;
  }
  return authorization.slice('Bearer '.length);
}

function runWithRefreshLock<T>(task: () => Promise<T>) {
  if (typeof navigator === 'undefined' || !('locks' in navigator)) {
    return task();
  }
  return navigator.locks.request(REFRESH_LOCK_NAME, task);
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error('请求失败', { cause: error });
}
