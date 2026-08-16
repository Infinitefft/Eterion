import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';

import { ensureAuthInitialized } from '@/api/client';
import { getIMService } from '@/service/im';
import { useAuthStore } from '@/store/authStore';

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

/** 注册应用级 Provider；后续全局 Provider 也统一从这里组合。 */
export function AppProviders({ children }: PropsWithChildren) {
  const userId = useAuthStore((state) => state.user?.id ?? null);

  useEffect(() => {
    const service = getIMService();

    if (userId) {
      /** WebSocket 连接和历史列表互不依赖，并行启动避免登录后的请求瀑布。 */
      void Promise.allSettled([service.connect(), service.loadChats()]);
      return;
    }

    /** 退出登录后主动断开带身份的连接，但保留全局 Service 实例。 */
    service.disconnect();
    service.resetBusinessState();
  }, [userId]);

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
