import { IMService } from './imService';
import { createIMStore } from './store';
import { WebSocketTransport } from './transport';

/**
 * 读取当前 IM WebSocket 地址。
 *
 * 没有配置 VITE_IM_WS_URL 时返回 null，Transport 会进入 disabled。
 * 后续接入鉴权 Ticket 时，只需要替换该 URL 解析函数。
 */
function resolveIMWebSocketUrl(): string | null {
  const configuredUrl = import.meta.env.VITE_IM_WS_URL?.trim();
  return configuredUrl || null;
}

function createIMRuntime() {
  /**
   * URL 使用函数而不是固定字符串，后续接入短期 Ticket 时
   * 每次重连都能重新获取最新地址。
   */
  const transport = new WebSocketTransport({
    url: resolveIMWebSocketUrl,
    reconnect: {
      enabled: true,
      maxAttempts: 8,
      initialDelayMs: 1_000,
      maxDelayMs: 30_000,
    },
  });

  const store = createIMStore(transport.getState());

  /** Service 只依赖抽象 Transport 和 Store，不直接依赖 React。 */
  const service = new IMService({ transport, store });

  return {
    service,
    store,
  };
}

/**
 * ES Module 在同一个页面中只执行一次，
 * 因而整个应用只会创建这一套 IM Runtime。
 */
const runtime = createIMRuntime();

/** 全局唯一的 IM Service。 */
export const imService = runtime.service;

/** React 页面订阅的全局 Zustand Store。 */
export const imStore = runtime.store;

/**
 * 获取全局 IM Service。
 *
 * 无论调用多少次，返回的都是同一个实例。
 */
export function getIMService(): IMService {
  return imService;
}

/** 在 React 渲染前建立唯一的 Transport 监听关系。 */
export function initializeIMService(): void {
  imService.initialize();
}

/**
 * Vite 热更新销毁旧模块时释放监听器和连接，
 * 防止开发环境残留多个 WebSocket。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    imService.destroy();
  });
}

export type {
  CancelRunInput,
  IMServiceOptions,
  IMServicePublicApi,
  PrepareNewChatInput,
  SubmitMessageInput,
} from './imService';
export type { IMStore, IMStoreApi, IMStoreState } from './store';
