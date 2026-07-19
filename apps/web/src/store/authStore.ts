import { create } from 'zustand';

import type { AuthSession, AuthUser } from '@/api/types';

export type AuthBootstrapStatus = 'pending' | 'ready' | 'error';

type AuthState = {
  accessToken: string | null;
  user: AuthUser | null;
  bootstrapStatus: AuthBootstrapStatus;
  sessionVersion: number;
  setSession: (session: AuthSession) => void;
  clearSession: () => void;
  setBootstrapStatus: (status: AuthBootstrapStatus) => void;
};

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
