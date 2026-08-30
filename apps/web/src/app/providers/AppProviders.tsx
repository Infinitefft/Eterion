import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';

import { ensureAuthInitialized } from '@/api/client';
import { getIMService } from '@/service/im';
import { useAuthStore } from '@/store/authStore';
import { useIMStore } from '@/store/imStore';

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

  useVisualViewportHeight();

  useEffect(() => {
    const service = getIMService();

    if (userId) {
      let cancelled = false;

      /** 先拿到历史列表，再接收实时事件，避免首屏 HTTP 响应覆盖刚收到的 WS 状态。 */
      void useIMStore
        .getState()
        .loadThreads()
        .catch(() => undefined)
        .then(() => {
          if (!cancelled) {
            void service.connect();
          }
        });

      return () => {
        cancelled = true;
      };
    }

    /** 退出登录后主动断开带身份的连接，但保留全局 Service 实例。 */
    service.disconnect();
    useIMStore.getState().resetBusinessState();
  }, [userId]);

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
