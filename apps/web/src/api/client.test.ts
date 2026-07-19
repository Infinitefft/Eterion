import { AxiosError, AxiosHeaders } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiClient, ensureAuthInitialized, publicApiClient } from '@/api/client';
import type { ApiErrorResponse, ApiResponse, AuthSession } from '@/api/types';
import { useAuthStore } from '@/store/authStore';

import type { AxiosAdapter, AxiosResponse, InternalAxiosRequestConfig } from 'axios';

const oldSession: AuthSession = {
  access_token: 'old-access-token',
  token_type: 'Bearer',
  expires_in: 1,
  user: {
    id: '4d0fc02f-31dc-4fc9-a0af-7f8e3ea48ec1',
    phone: '13800138000',
    nickname: 'Eterion 用户',
  },
};

const newSession: AuthSession = {
  ...oldSession,
  access_token: 'new-access-token',
  expires_in: 900,
};

const originalApiAdapter = apiClient.defaults.adapter;
const originalPublicAdapter = publicApiClient.defaults.adapter;

describe('authenticated Axios client', () => {
  beforeEach(() => {
    useAuthStore.setState({
      accessToken: null,
      user: null,
      bootstrapStatus: 'pending',
      sessionVersion: 0,
    });
  });

  afterEach(() => {
    apiClient.defaults.adapter = originalApiAdapter;
    publicApiClient.defaults.adapter = originalPublicAdapter;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('adds the current access token to protected requests', async () => {
    useAuthStore.getState().setSession(oldSession);
    const adapter = vi.fn<AxiosAdapter>((config) =>
      Promise.resolve(successResponse(config, { ok: true })),
    );
    apiClient.defaults.adapter = adapter;

    await apiClient.get('/auth/me');

    const request = adapter.mock.calls[0][0];
    expect(AxiosHeaders.from(request.headers).get('Authorization')).toBe('Bearer old-access-token');
  });

  it('uses one refresh for concurrent expired requests and replays all of them', async () => {
    useAuthStore.getState().setSession(oldSession);
    const protectedAdapter = vi.fn<AxiosAdapter>((config) => {
      const authorization = AxiosHeaders.from(config.headers).get('Authorization');
      if (authorization === 'Bearer old-access-token') {
        return Promise.reject(apiFailure(config, 401, 'AUTH_ACCESS_EXPIRED'));
      }
      return Promise.resolve(successResponse(config, { ok: true }));
    });
    const refreshAdapter = vi.fn<AxiosAdapter>((config) =>
      Promise.resolve(successResponse<ApiResponse<AuthSession>>(config, { data: newSession })),
    );
    apiClient.defaults.adapter = protectedAdapter;
    publicApiClient.defaults.adapter = refreshAdapter;

    const responses = await Promise.all([
      apiClient.get('/one'),
      apiClient.get('/two'),
      apiClient.get('/three'),
    ]);

    expect(responses).toHaveLength(3);
    expect(refreshAdapter).toHaveBeenCalledTimes(1);
    expect(protectedAdapter).toHaveBeenCalledTimes(6);
    expect(useAuthStore.getState().accessToken).toBe('new-access-token');
  });

  it('does not refresh public login errors', async () => {
    const adapter = vi.fn<AxiosAdapter>((config) =>
      Promise.reject(apiFailure(config, 401, 'AUTH_INVALID_CREDENTIALS')),
    );
    publicApiClient.defaults.adapter = adapter;

    await expect(publicApiClient.post('/auth/login')).rejects.toMatchObject({
      response: { status: 401 },
    });
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it('clears the session when refresh credentials are invalid', async () => {
    useAuthStore.getState().setSession(oldSession);
    apiClient.defaults.adapter = (config) =>
      Promise.reject(apiFailure(config, 401, 'AUTH_ACCESS_EXPIRED'));
    publicApiClient.defaults.adapter = (config) =>
      Promise.reject(apiFailure(config, 401, 'AUTH_REFRESH_INVALID'));

    await expect(apiClient.get('/auth/me')).rejects.toMatchObject({
      response: { data: { error: { code: 'AUTH_REFRESH_INVALID' } } },
    });
    expect(useAuthStore.getState()).toMatchObject({ accessToken: null, user: null });
  });

  it('keeps the session when refresh fails with a server error', async () => {
    useAuthStore.getState().setSession(oldSession);
    apiClient.defaults.adapter = (config) =>
      Promise.reject(apiFailure(config, 401, 'AUTH_ACCESS_EXPIRED'));
    publicApiClient.defaults.adapter = (config) =>
      Promise.reject(apiFailure(config, 500, 'INTERNAL_ERROR'));

    await expect(apiClient.get('/auth/me')).rejects.toMatchObject({
      response: { status: 500 },
    });
    expect(useAuthStore.getState().accessToken).toBe('old-access-token');
  });

  it('replays an expired request at most once', async () => {
    useAuthStore.getState().setSession(oldSession);
    const protectedAdapter = vi.fn<AxiosAdapter>((config) =>
      Promise.reject(apiFailure(config, 401, 'AUTH_ACCESS_EXPIRED')),
    );
    const refreshAdapter = vi.fn<AxiosAdapter>((config) =>
      Promise.resolve(successResponse<ApiResponse<AuthSession>>(config, { data: newSession })),
    );
    apiClient.defaults.adapter = protectedAdapter;
    publicApiClient.defaults.adapter = refreshAdapter;

    await expect(apiClient.get('/always-expired')).rejects.toMatchObject({
      response: { data: { error: { code: 'AUTH_ACCESS_EXPIRED' } } },
    });
    expect(refreshAdapter).toHaveBeenCalledTimes(1);
    expect(protectedAdapter).toHaveBeenCalledTimes(2);
  });

  it('clears the session for an invalid backend session without refreshing', async () => {
    useAuthStore.getState().setSession(oldSession);
    const protectedAdapter = vi.fn<AxiosAdapter>((config) =>
      Promise.reject(apiFailure(config, 401, 'AUTH_SESSION_INVALID')),
    );
    const refreshAdapter = vi.fn<AxiosAdapter>();
    apiClient.defaults.adapter = protectedAdapter;
    publicApiClient.defaults.adapter = refreshAdapter;

    await expect(apiClient.get('/auth/me')).rejects.toMatchObject({
      response: { data: { error: { code: 'AUTH_SESSION_INVALID' } } },
    });
    expect(refreshAdapter).not.toHaveBeenCalled();
    expect(useAuthStore.getState()).toMatchObject({ accessToken: null, user: null });
  });

  it('uses the browser lock and initializes only once', async () => {
    const requestLock = vi.fn(
      async (_name: string, task: () => Promise<AuthSession>) => await task(),
    );
    vi.stubGlobal('navigator', { locks: { request: requestLock } });
    const refreshAdapter = vi.fn<AxiosAdapter>((config) =>
      Promise.resolve(successResponse<ApiResponse<AuthSession>>(config, { data: newSession })),
    );
    publicApiClient.defaults.adapter = refreshAdapter;

    await Promise.all([ensureAuthInitialized(), ensureAuthInitialized()]);

    expect(refreshAdapter).toHaveBeenCalledTimes(1);
    expect(requestLock).toHaveBeenCalledTimes(1);
  });
});

function successResponse<T>(config: InternalAxiosRequestConfig, data: T): AxiosResponse<T> {
  return {
    data,
    status: 200,
    statusText: 'OK',
    headers: {},
    config,
  };
}

function apiFailure(config: InternalAxiosRequestConfig, status: number, code: string) {
  const response = successResponse<ApiErrorResponse>(config, {
    error: {
      code,
      message: code,
      next_action: 'TEST',
    },
  });
  response.status = status;
  response.statusText = 'Error';
  return new AxiosError(code, AxiosError.ERR_BAD_REQUEST, config, undefined, response);
}
