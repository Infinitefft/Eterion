import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';

import { ensureAuthInitialized } from '@/api/client';
import { getApiError } from '@/api/errors';
import { fetchThreads } from '@/api/im';
import { getIMService } from '@/service/im';
import { useAuthStore } from '@/store/auth-store';
import { useIMStore } from '@/store/im-store';

import type { PropsWithChildren } from 'react';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
});

// 在模块初始化阶段只启动一次登录恢复，避免 React StrictMode 重复轮换 Refresh Token。
void ensureAuthInitialized();

function useVisualViewportHeight() {
  useEffect(() => {
    const visualViewport = window.visualViewport;

    function updateViewportHeight() {
      const viewportHeight = visualViewport?.height ?? window.innerHeight;
      document.documentElement.style.setProperty('--app-viewport-height', `${viewportHeight}px`);
    }

    updateViewportHeight();
    window.addEventListener('resize', updateViewportHeight);
    visualViewport?.addEventListener('resize', updateViewportHeight);

    return () => {
      window.removeEventListener('resize', updateViewportHeight);
      visualViewport?.removeEventListener('resize', updateViewportHeight);
      document.documentElement.style.removeProperty('--app-viewport-height');
    };
  }, []);
}

/** 注册应用级 Provider；后续全局 Provider 也统一从这里组合。 */
export function AppProviders({ children }: PropsWithChildren) {
  const userId = useAuthStore((state) => state.user?.id ?? null);
  // 同一账号重新登录也要重新初始化；普通 Token 续期不改变 sessionVersion。
  const sessionVersion = useAuthStore((state) => state.sessionVersion);

  useVisualViewportHeight();

  useEffect(() => {
    // 登录恢复完成、拿到用户身份后，才加载这个用户的会话。
    if (!userId) return;

    const service = getIMService();
    const store = useIMStore.getState();
    let cancelled = false;

    store.setThreadListLoadState({ status: 'loading' });

    async function loadThreadsAndConnect() {
      try {
        const threads = await fetchThreads();

        // 请求期间可能退出或切换账号；即使 effect 尚未清理，旧结果也不能写回。
        if (cancelled || useAuthStore.getState().sessionVersion !== sessionVersion) return;

        // setThreads 同时负责排序和将加载状态设为 ready，列表订阅会自动收到更新。
        store.setThreads(threads);
      } catch (error) {
        if (cancelled || useAuthStore.getState().sessionVersion !== sessionVersion) return;

        store.setThreadListLoadState({
          status: 'error',
          message: getApiError(error)?.message ?? '无法加载会话列表，请稍后重试',
        });
      }

      // 先完成 HTTP 加载，再接收实时事件，避免首屏列表覆盖刚收到的 WS 更新。
      // 列表失败也允许连接；连接错误和自动重连由已有 Transport 链路处理。
      void service.connect();
    }

    void loadThreadsAndConnect();

    return () => {
      // 退出、切换身份或卸载时，让本次请求失效，并清理这个用户的 IM 数据。
      cancelled = true;
      // 先重置 Store，再让断开事件写回真实连接状态；全局 Service 实例仍可复用。
      store.reset();
      service.disconnect();
    };
  }, [userId, sessionVersion]);

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
