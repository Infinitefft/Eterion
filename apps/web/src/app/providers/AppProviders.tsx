import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ensureAuthInitialized } from '@/api/client';

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
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
