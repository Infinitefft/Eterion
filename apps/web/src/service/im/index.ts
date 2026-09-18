import { createIMTicket } from '@/api/im';
import { useIMStore } from '@/store/im-store';
import { IMService } from './imService';
import { WebSocketTransport } from './transport';

/** 全局 IM Runtime 中真正需要长期持有的对象。 */
interface IMRuntime {
  service: IMService;
  unbindStore: () => void;
}

/** 当前页面生命周期内唯一的 IM Runtime。 */
let runtime: IMRuntime | null = null;

/**
 * 为一次 WebSocket 连接生成完整地址。
 *
 * Transport 每次连接和自动重连都会重新调用这个函数，
 * 因此每次都会申请新的单次 Ticket，不会复用旧凭证。
 */
async function resolveIMWebSocketUrl(): Promise<string | null> {
  const configuredUrl = import.meta.env.VITE_IM_WS_URL?.trim();

  if (!configuredUrl) {
    return null;
  }

  const { ticket } = await createIMTicket();
  const url = new URL(configuredUrl, window.location.href);

  /** 允许环境变量使用 http/https，最终统一转换为 WebSocket 协议。 */
  if (url.protocol === 'http:') {
    url.protocol = 'ws:';
  } else if (url.protocol === 'https:') {
    url.protocol = 'wss:';
  }

  url.searchParams.set('ticket', ticket);
  return url.toString();
}

/**
 * 在 React 渲染前初始化全局 IM Runtime。
 *
 * 该函数可以重复调用，但只会创建一次实例。
 * 初始化只完成对象组装和 Store 订阅，不会主动建立 WebSocket 连接。
 */
export function initializeIMService(): IMService {
  if (!runtime) {
    const transport = new WebSocketTransport({
      url: resolveIMWebSocketUrl,
    });

    const service = new IMService({ transport });

    const unbindStore = service.subscribe((event) => {
      const store = useIMStore.getState();

      switch (event.kind) {
        case 'envelope': {
          store.applyEnvelope(event.envelope);
          break;
        }
        
        case 'connection': {
          // 将连接、断线、重连等状态同步给页面使用
          store.setConnectionState(event.state);
          break;
        }
      }
    });

    // 保存实例和它对应的取消订阅函数
    runtime = {
      service,
      unbindStore,
    };

    /**
     * subscribe 只监听后续变化，不会主动发送当前状态
     * 因此初始化时需要手动同步一次
     */
    useIMStore.getState().setConnectionState(
      service.getConnectionState(),
    );
  }
  
  // 后续调用直接获取实例，不会重复创建或订阅
  return runtime?.service;
}

/** 获取全局唯一的 IMService；尚未初始化时会自动完成初始化。 */
export function getIMService(): IMService {
  return initializeIMService();
}

/**
 * 永久销毁当前 IM Runtime。
 *
 * 普通退出登录只需要 disconnect()；这里主要用于 HMR、测试或应用真正卸载。
 */
export function destroyIMService(): void {
  const currentRuntime = runtime;

  if (!currentRuntime) {
    return;
  }

  runtime = null;
  currentRuntime.unbindStore();
  currentRuntime.service.destroy();
}

/** Vite 热更新时释放旧模块持有的订阅和 WebSocket。 */
if (import.meta.hot) {
  import.meta.hot.dispose(destroyIMService);
}
