import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthSession } from '@/api/types';

const session: AuthSession = {
  access_token: 'broadcast-access-token',
  token_type: 'Bearer',
  expires_in: 900,
  user: {
    id: '4d0fc02f-31dc-4fc9-a0af-7f8e3ea48ec1',
    phone: '13800138000',
    nickname: '跨标签用户',
  },
};

class FakeBroadcastChannel {
  static latest: FakeBroadcastChannel | null = null;

  private listener: ((event: MessageEvent<unknown>) => void) | null = null;

  constructor(_name: string) {
    FakeBroadcastChannel.latest = this;
  }

  addEventListener(_type: string, listener: (event: MessageEvent<unknown>) => void) {
    this.listener = listener;
  }

  postMessage(_message: unknown) {}

  emit(data: unknown) {
    this.listener?.({ data } as MessageEvent<unknown>);
  }
}

describe('cross-tab auth channel', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    FakeBroadcastChannel.latest = null;
  });

  it('applies session and logout messages from another tab', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);

    const { useAuthStore } = await import('@/store/authStore');
    await import('@/api/client');
    const channel = FakeBroadcastChannel.latest;

    channel?.emit({ sourceId: 'another-tab', type: 'session', session });
    expect(useAuthStore.getState()).toMatchObject({
      accessToken: 'broadcast-access-token',
      user: session.user,
    });

    channel?.emit({ sourceId: 'another-tab', type: 'logout' });
    expect(useAuthStore.getState()).toMatchObject({ accessToken: null, user: null });
  });
});
