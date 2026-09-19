import { AxiosError } from 'axios';
import { describe, expect, it, vi } from 'vitest';

import type { AuthSession } from '@/types/auth';

import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios';

function session(accessToken: string, userId = 'alice'): AuthSession {
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: 900,
    user: { id: userId, phone: '13800000000', nickname: userId },
  };
}

function response(
  config: InternalAxiosRequestConfig,
  data: unknown = {},
  status = 200,
): AxiosResponse {
  return { config, data, status, statusText: status === 204 ? 'No Content' : 'OK', headers: {} };
}

function apiError(config: InternalAxiosRequestConfig, code: string, status = 401): AxiosError {
  return new AxiosError(
    code,
    'ERR_BAD_RESPONSE',
    config,
    undefined,
    response(config, { error: { code, message: code, next_action: 'LOGIN_AGAIN' } }, status),
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function loadAuth() {
  vi.resetModules();
  const client = await import('./client');
  const { useAuthStore } = await import('@/store/auth-store');
  const { logout } = await import('./auth');
  return { ...client, useAuthStore, logout };
}

describe('authentication request lifecycle', () => {
  it('waits for bootstrap before sending protected requests without an access token', async () => {
    const { apiClient, publicApiClient, ensureAuthInitialized, useAuthStore } = await loadAuth();
    const refresh = deferred<AxiosResponse>();
    let refreshConfig: InternalAxiosRequestConfig | undefined;
    const protectedAdapter = vi.fn((config: InternalAxiosRequestConfig) =>
      Promise.resolve(response(config, { data: 'protected' })),
    );

    publicApiClient.defaults.adapter = (config) => {
      refreshConfig = config;
      return refresh.promise;
    };
    apiClient.defaults.adapter = protectedAdapter;

    const bootstrap = ensureAuthInitialized();
    const request = apiClient.get('/protected');
    await vi.waitFor(() => expect(refreshConfig).toBeDefined());
    expect(protectedAdapter).not.toHaveBeenCalled();

    refresh.resolve(response(refreshConfig!, { data: session('new-at') }));
    await bootstrap;
    await expect(request).resolves.toMatchObject({ data: { data: 'protected' } });
    expect(protectedAdapter).toHaveBeenCalledOnce();
    expect(protectedAdapter.mock.calls[0][0].headers.get('Authorization')).toBe('Bearer new-at');
    expect(useAuthStore.getState().user?.id).toBe('alice');
  });

  it('finishes bootstrap anonymously when the refresh cookie is missing', async () => {
    const { apiClient, publicApiClient, ensureAuthInitialized, useAuthStore } = await loadAuth();
    publicApiClient.defaults.adapter = (config) =>
      Promise.reject(apiError(config, 'AUTH_REFRESH_MISSING'));
    const protectedAdapter = vi.fn((config: InternalAxiosRequestConfig) =>
      Promise.resolve(response(config)),
    );
    apiClient.defaults.adapter = protectedAdapter;

    const bootstrap = ensureAuthInitialized();
    const request = apiClient.get('/protected');
    await bootstrap;
    await expect(request).rejects.toThrow('请先登录');
    expect(useAuthStore.getState().bootstrapStatus).toBe('ready');
    expect(useAuthStore.getState().user).toBeNull();
    expect(protectedAdapter).not.toHaveBeenCalled();
  });

  it('shows a retryable bootstrap error and recovers after the retry succeeds', async () => {
    const { publicApiClient, ensureAuthInitialized, retryAuthInitialization, useAuthStore } =
      await loadAuth();
    let refreshCalls = 0;
    publicApiClient.defaults.adapter = (config) => {
      refreshCalls += 1;
      if (refreshCalls === 1) {
        return Promise.reject(new AxiosError('network unavailable', 'ERR_NETWORK', config));
      }
      return Promise.resolve(response(config, { data: session('restored-at') }));
    };

    await ensureAuthInitialized();
    expect(useAuthStore.getState().bootstrapStatus).toBe('error');
    expect(useAuthStore.getState().user).toBeNull();

    await retryAuthInitialization();
    expect(refreshCalls).toBe(2);
    expect(useAuthStore.getState().bootstrapStatus).toBe('ready');
    expect(useAuthStore.getState().accessToken).toBe('restored-at');
  });

  it('refreshes once and replays five concurrent expired requests once each', async () => {
    const { apiClient, publicApiClient, useAuthStore } = await loadAuth();
    useAuthStore.getState().setSession(session('old-at'));
    const refresh = deferred<AxiosResponse>();
    let refreshConfig: InternalAxiosRequestConfig | undefined;
    let refreshCalls = 0;
    let expiredCalls = 0;
    let replayCalls = 0;

    publicApiClient.defaults.adapter = (config) => {
      refreshCalls += 1;
      refreshConfig = config;
      return refresh.promise;
    };
    apiClient.defaults.adapter = (config) => {
      if (config.headers.get('Authorization') === 'Bearer old-at') {
        expiredCalls += 1;
        return Promise.reject(apiError(config, 'AUTH_ACCESS_EXPIRED'));
      }
      replayCalls += 1;
      expect(config.headers.get('Authorization')).toBe('Bearer new-at');
      return Promise.resolve(response(config, { data: 'ok' }));
    };

    const requests = Array.from({ length: 5 }, (_, index) =>
      apiClient.get<{ data: string }>(`/protected/${index}`),
    );
    await vi.waitFor(() => expect(expiredCalls).toBe(5));
    expect(refreshCalls).toBe(1);

    refresh.resolve(response(refreshConfig!, { data: session('new-at') }));
    const results = await Promise.all(requests);
    expect(results.map((result) => result.data.data)).toEqual(Array(5).fill('ok'));
    expect(refreshCalls).toBe(1);
    expect(replayCalls).toBe(5);
  });

  it('replays a late expired response with an already refreshed token without refreshing again', async () => {
    const { apiClient, publicApiClient, refreshAuthSession, useAuthStore } = await loadAuth();
    useAuthStore.getState().setSession(session('old-at'));
    const oldRequest = deferred<AxiosResponse>();
    let oldConfig: InternalAxiosRequestConfig | undefined;
    let refreshCalls = 0;

    publicApiClient.defaults.adapter = (config) => {
      refreshCalls += 1;
      return Promise.resolve(response(config, { data: session('new-at') }));
    };
    apiClient.defaults.adapter = (config) => {
      if (config.headers.get('Authorization') === 'Bearer old-at') {
        oldConfig = config;
        return oldRequest.promise;
      }
      return Promise.resolve(response(config, { data: 'ok' }));
    };

    const request = apiClient.get('/protected');
    await vi.waitFor(() => expect(oldConfig).toBeDefined());
    const sessionVersion = useAuthStore.getState().sessionVersion;
    await refreshAuthSession();
    expect(useAuthStore.getState().sessionVersion).toBe(sessionVersion);
    oldRequest.reject(apiError(oldConfig!, 'AUTH_ACCESS_EXPIRED'));

    await expect(request).resolves.toMatchObject({ data: { data: 'ok' } });
    expect(refreshCalls).toBe(1);
  });

  it('stops after one replay when the new access token is also expired', async () => {
    const { apiClient, publicApiClient, useAuthStore } = await loadAuth();
    useAuthStore.getState().setSession(session('old-at'));
    let businessCalls = 0;
    let refreshCalls = 0;
    apiClient.defaults.adapter = (config) => {
      businessCalls += 1;
      return Promise.reject(apiError(config, 'AUTH_ACCESS_EXPIRED'));
    };
    publicApiClient.defaults.adapter = (config) => {
      refreshCalls += 1;
      return Promise.resolve(response(config, { data: session('still-expired-at') }));
    };

    await expect(apiClient.get('/protected')).rejects.toThrow('AUTH_ACCESS_EXPIRED');
    expect(businessCalls).toBe(2);
    expect(refreshCalls).toBe(1);
  });

  it('does not clear a new access token for a terminal error from the old token', async () => {
    const { apiClient, publicApiClient, refreshAuthSession, useAuthStore } = await loadAuth();
    useAuthStore.getState().setSession(session('old-at'));
    const oldRequest = deferred<AxiosResponse>();
    let oldConfig: InternalAxiosRequestConfig | undefined;
    apiClient.defaults.adapter = (config) => {
      oldConfig = config;
      return oldRequest.promise;
    };
    let refreshCalls = 0;
    publicApiClient.defaults.adapter = (config) => {
      refreshCalls += 1;
      return Promise.resolve(response(config, { data: session('new-at') }));
    };

    const pending = apiClient.get('/protected');
    await vi.waitFor(() => expect(oldConfig).toBeDefined());
    await refreshAuthSession();
    oldRequest.reject(apiError(oldConfig!, 'AUTH_SESSION_INVALID'));

    await expect(pending).rejects.toThrow('AUTH_SESSION_INVALID');
    expect(useAuthStore.getState().accessToken).toBe('new-at');
    expect(refreshCalls).toBe(1);
  });

  it('clears a current session on terminal access or refresh errors', async () => {
    const { apiClient, publicApiClient, refreshAuthSession, useAuthStore } = await loadAuth();
    useAuthStore.getState().setSession(session('old-at'));
    apiClient.defaults.adapter = (config) =>
      Promise.reject(apiError(config, 'AUTH_SESSION_INVALID'));
    await expect(apiClient.get('/protected')).rejects.toThrow('AUTH_SESSION_INVALID');
    expect(useAuthStore.getState().user).toBeNull();

    useAuthStore.getState().setSession(session('second-at'));
    publicApiClient.defaults.adapter = (config) =>
      Promise.reject(apiError(config, 'AUTH_REFRESH_MISSING'));
    await expect(refreshAuthSession()).rejects.toThrow('AUTH_REFRESH_MISSING');
    expect(useAuthStore.getState().user).toBeNull();
  });

  it.each(['access', 'refresh'] as const)(
    'clears the session on a 403 disabled-account %s response',
    async (kind) => {
      const { apiClient, publicApiClient, refreshAuthSession, useAuthStore } = await loadAuth();
      useAuthStore.getState().setSession(session('old-at'));
      if (kind === 'access') {
        apiClient.defaults.adapter = (config) =>
          Promise.reject(apiError(config, 'AUTH_ACCOUNT_DISABLED', 403));
        await expect(apiClient.get('/protected')).rejects.toThrow('AUTH_ACCOUNT_DISABLED');
      } else {
        publicApiClient.defaults.adapter = (config) =>
          Promise.reject(apiError(config, 'AUTH_ACCOUNT_DISABLED', 403));
        await expect(refreshAuthSession()).rejects.toThrow('AUTH_ACCOUNT_DISABLED');
      }
      expect(useAuthStore.getState().user).toBeNull();
    },
  );

  it.each(['server', 'timeout'] as const)(
    'keeps the session on a %s refresh failure',
    async (kind) => {
      const { publicApiClient, refreshAuthSession, useAuthStore } = await loadAuth();
      useAuthStore.getState().setSession(session('old-at'));
      publicApiClient.defaults.adapter = (config) => {
        if (kind === 'server') {
          return Promise.reject(apiError(config, 'INTERNAL_ERROR', 500));
        }
        return Promise.reject(new AxiosError('timeout', 'ECONNABORTED', config));
      };

      await expect(refreshAuthSession()).rejects.toThrow();
      expect(useAuthStore.getState().accessToken).toBe('old-at');
      expect(useAuthStore.getState().user?.id).toBe('alice');
    },
  );

  it('does not restore a logged-out session from a late successful refresh', async () => {
    const { publicApiClient, refreshAuthSession, useAuthStore } = await loadAuth();
    useAuthStore.getState().setSession(session('old-at'));
    const refresh = deferred<AxiosResponse>();
    let refreshConfig: InternalAxiosRequestConfig | undefined;
    publicApiClient.defaults.adapter = (config) => {
      refreshConfig = config;
      return refresh.promise;
    };

    const pending = refreshAuthSession();
    await vi.waitFor(() => expect(refreshConfig).toBeDefined());
    useAuthStore.getState().clearSession();
    refresh.resolve(response(refreshConfig!, { data: session('late-at') }));
    await pending.catch(() => undefined);
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().accessToken).toBeNull();
  });

  it('does not clear a new login when an old refresh fails late', async () => {
    const { publicApiClient, refreshAuthSession, useAuthStore } = await loadAuth();
    useAuthStore.getState().setSession(session('old-at'));
    const refresh = deferred<AxiosResponse>();
    let refreshConfig: InternalAxiosRequestConfig | undefined;
    publicApiClient.defaults.adapter = (config) => {
      refreshConfig = config;
      return refresh.promise;
    };

    const pending = refreshAuthSession();
    await vi.waitFor(() => expect(refreshConfig).toBeDefined());
    useAuthStore.getState().setSession(session('bob-at', 'bob'));
    refresh.reject(apiError(refreshConfig!, 'AUTH_REFRESH_INVALID'));
    await pending.catch(() => undefined);
    expect(useAuthStore.getState().accessToken).toBe('bob-at');
    expect(useAuthStore.getState().user?.id).toBe('bob');
  });

  it.each(['success', 'expired'] as const)(
    'ignores a late %s response from a request sent under another login',
    async (kind) => {
      const { apiClient, publicApiClient, useAuthStore } = await loadAuth();
      useAuthStore.getState().setSession(session('old-at'));
      const oldRequest = deferred<AxiosResponse>();
      let oldConfig: InternalAxiosRequestConfig | undefined;
      apiClient.defaults.adapter = (config) => {
        oldConfig = config;
        return oldRequest.promise;
      };
      const refreshAdapter = vi.fn((config: InternalAxiosRequestConfig) =>
        Promise.resolve(response(config, { data: session('unwanted-at') })),
      );
      publicApiClient.defaults.adapter = refreshAdapter;

      const pending = apiClient.get('/protected');
      await vi.waitFor(() => expect(oldConfig).toBeDefined());
      useAuthStore.getState().setSession(session('bob-at', 'bob'));
      if (kind === 'success') {
        oldRequest.resolve(response(oldConfig!, { data: 'alice-data' }));
      } else {
        oldRequest.reject(apiError(oldConfig!, 'AUTH_ACCESS_EXPIRED'));
      }

      await expect(pending).rejects.toThrow();
      expect(useAuthStore.getState().accessToken).toBe('bob-at');
      expect(refreshAdapter).not.toHaveBeenCalled();
    },
  );

  it('logs out through the public client without refreshing and only after a 204', async () => {
    const { apiClient, publicApiClient, logout, useAuthStore } = await loadAuth();
    useAuthStore.getState().setSession(session('old-at'));
    const authenticatedAdapter = vi.fn((config: InternalAxiosRequestConfig) =>
      Promise.resolve(response(config)),
    );
    apiClient.defaults.adapter = authenticatedAdapter;
    const publicAdapter = vi.fn((config: InternalAxiosRequestConfig) => {
      expect(config.url).toBe('/auth/logout');
      expect(config.headers.get('Authorization')).toBeFalsy();
      return Promise.resolve(response(config, undefined, 204));
    });
    publicApiClient.defaults.adapter = publicAdapter;

    await logout();
    expect(useAuthStore.getState().user).toBeNull();
    expect(authenticatedAdapter).not.toHaveBeenCalled();
    expect(publicAdapter).toHaveBeenCalledOnce();
  });

  it('retains the session when logout fails, and ignores a stale successful logout', async () => {
    const { publicApiClient, logout, useAuthStore } = await loadAuth();
    useAuthStore.getState().setSession(session('old-at'));
    publicApiClient.defaults.adapter = (config) =>
      Promise.reject(new AxiosError('network unavailable', 'ERR_NETWORK', config));
    await expect(logout()).rejects.toThrow('network unavailable');
    expect(useAuthStore.getState().accessToken).toBe('old-at');

    const logoutResponse = deferred<AxiosResponse>();
    let logoutConfig: InternalAxiosRequestConfig | undefined;
    publicApiClient.defaults.adapter = (config) => {
      logoutConfig = config;
      return logoutResponse.promise;
    };
    const pending = logout();
    await vi.waitFor(() => expect(logoutConfig).toBeDefined());
    useAuthStore.getState().setSession(session('bob-at', 'bob'));
    logoutResponse.resolve(response(logoutConfig!, undefined, 204));
    await pending.catch(() => undefined);
    expect(useAuthStore.getState().accessToken).toBe('bob-at');
  });
});
