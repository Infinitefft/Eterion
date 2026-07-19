import { create } from 'zustand';

import type { AuthSession, AuthUser } from '@/types/auth';

/** 应用启动时恢复登录状态的执行阶段。 */
export type AuthBootstrapStatus = 'pending' | 'ready' | 'error';

/**
 * 认证模块的全局内存状态。
 * Access Token 不做持久化，页面重新加载后通过 Refresh Token Cookie 恢复。
 */
type AuthState = {
  /** 当前短期 Access Token，未登录时为 null。 */
  accessToken: string | null;
  /** 当前登录用户，未登录时为 null。 */
  user: AuthUser | null;
  /** 启动恢复状态，用于控制账户入口的加载、正常和重试界面。 */
  bootstrapStatus: AuthBootstrapStatus;
  /**
   * 会话变化版本号，用于让局部 UI 感知登录或退出事件，避免旧弹窗再次打开。
   */
  sessionVersion: number;
  /** 原子写入 Access Token 和用户信息。 */
  setSession: (session: AuthSession) => void;
  /** 原子清空本地认证会话。 */
  clearSession: () => void;
  /** 更新应用启动恢复状态。 */
  setBootstrapStatus: (status: AuthBootstrapStatus) => void;
};

/** 认证 Store；拦截器通过 getState() 读取，React 组件通过 selector 订阅。 */
export const useAuthStore = create<AuthState>()((set) => ({
  accessToken: null,
  user: null,
  bootstrapStatus: 'pending',
  sessionVersion: 0,
  setSession: (session) =>
    set((state) => ({
      accessToken: session.access_token,
      user: session.user,
      bootstrapStatus: 'ready',
      sessionVersion: state.sessionVersion + 1,
    })),
  clearSession: () =>
    set((state) => ({
      accessToken: null,
      user: null,
      bootstrapStatus: 'ready',
      sessionVersion: state.sessionVersion + 1,
    })),
  setBootstrapStatus: (bootstrapStatus) => set({ bootstrapStatus }),
}));
