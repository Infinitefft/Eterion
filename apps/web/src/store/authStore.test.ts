import { beforeEach, describe, expect, it } from 'vitest';

import type { AuthSession } from '@/api/types';
import { useAuthStore } from '@/store/authStore';

const session: AuthSession = {
  access_token: 'access-token',
  token_type: 'Bearer',
  expires_in: 900,
  user: {
    id: '4d0fc02f-31dc-4fc9-a0af-7f8e3ea48ec1',
    phone: '13800138000',
    nickname: 'Eterion 用户',
  },
};

describe('authStore', () => {
  beforeEach(() => {
    useAuthStore.setState({
      accessToken: null,
      user: null,
      bootstrapStatus: 'pending',
      sessionVersion: 0,
    });
  });

  it('stores an authenticated session in memory', () => {
    useAuthStore.getState().setSession(session);

    expect(useAuthStore.getState()).toMatchObject({
      accessToken: 'access-token',
      user: session.user,
      bootstrapStatus: 'ready',
      sessionVersion: 1,
    });
  });

  it('clears the session and advances the session version', () => {
    useAuthStore.getState().setSession(session);
    useAuthStore.getState().clearSession();

    expect(useAuthStore.getState()).toMatchObject({
      accessToken: null,
      user: null,
      bootstrapStatus: 'ready',
      sessionVersion: 2,
    });
  });
});
