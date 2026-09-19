import { getApiError } from '@/api/errors';
import { createIMTicket, fetchThreadSnapshot } from '@/api/im';
import { useAuthStore } from '@/store/auth-store';
import { useIMStore } from '@/store/im-store';

import { IMService } from './imService';
import { WebSocketTransport } from './transport';

import type { ThreadId } from './types';

interface ThreadSynchronization {
  promise: Promise<void>;
  isCurrent(): boolean;
}

/** 全局 IM Runtime 中真正需要长期持有的对象。 */
interface IMRuntime {
  service: IMService;
  unbindStore: () => void;
  synchronizations: Map<ThreadId, ThreadSynchronization>;
}

/** 当前页面生命周期内唯一的 IM Runtime。 */
let runtime: IMRuntime | null = null;

function invalidateSynchronizations(currentRuntime: IMRuntime): void {
  const { status } = currentRuntime.service.getConnectionState();
  if (status !== 'disconnected' && status !== 'failed' && status !== 'disabled') {
    return;
  }

  for (const [threadId, task] of currentRuntime.synchronizations) {
    if (task.isCurrent()) {
      useIMStore.getState().setThreadDetailLoadState(threadId, {
        status: 'error',
        message: '连接已中断，请重试加载会话',
      });
    }
  }
  currentRuntime.synchronizations.clear();
}

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
          const envelope = event.envelope;
          store.applyEnvelope(envelope);

          const currentStore = useIMStore.getState();

          // 仅其他会话成功完成的 AI 回复产生未读提醒。
          if (
            envelope.type === 'message.completed' &&
            envelope.payload.role === 'assistant' &&
            envelope.payload.status === 'completed' &&
            envelope.threadId !== currentStore.activeThreadId
          ) {
            currentStore.markThreadUnread(envelope.threadId);
          }
          break;
        }
        
        case 'connection': {
          // 将连接、断线、重连等状态同步给页面使用
          store.setConnectionState(event.state);
          if (runtime?.service === service) {
            invalidateSynchronizations(runtime);
          }
          break;
        }
        case 'sequenceGap': {
          // 缺口的自动恢复在后续模块接入，本步只支持详情加载和手动重试。
          break;
        }
      }
    });

    // 保存实例和它对应的取消订阅函数
    runtime = {
      service,
      unbindStore,
      synchronizations: new Map(),
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
  return runtime.service;
}

/** 获取全局唯一的 IMService；尚未初始化时会自动完成初始化。 */
export function getIMService(): IMService {
  return initializeIMService();
}

/** 协调 HTTP 快照和实时事件；加载错误写入 Store，由详情页提供重试。 */
export function synchronizeThread(threadId: ThreadId): Promise<void> {
  const service = getIMService();
  const currentRuntime = runtime;
  const { user, sessionVersion } = useAuthStore.getState();

  if (!currentRuntime || !user) {
    return Promise.resolve();
  }

  const pending = currentRuntime.synchronizations.get(threadId);
  if (pending?.isCurrent()) {
    return pending.promise;
  }

  const task: ThreadSynchronization = {
    isCurrent: () => (
      runtime === currentRuntime &&
      currentRuntime.synchronizations.get(threadId) === task &&
      useAuthStore.getState().sessionVersion === sessionVersion &&
      // 删除会话和 Store.reset 都会移除加载状态，迟到快照不能把它恢复。
      useIMStore.getState().detailLoadStateByThread[threadId] !== undefined
    ),
    // 先登记任务，再执行请求，使同步订阅和 StrictMode 重复调用也能复用它。
    promise: Promise.resolve().then(async () => {
      try {
        if (!task.isCurrent()) {
          return;
        }

        service.pauseThread(threadId);
        const snapshot = await fetchThreadSnapshot(threadId);
        if (!task.isCurrent()) {
          return;
        }

        useIMStore.getState().applySnapshot(snapshot);
        service.resumeThread(threadId, snapshot.lastSeqId);
      } catch (error) {
        if (task.isCurrent()) {
          useIMStore.getState().setThreadDetailLoadState(threadId, {
            status: 'error',
            message: getApiError(error)?.message ??
              (error instanceof Error ? error.message : '无法加载会话，请稍后重试'),
          });
        }
        // 失败时不猜测序号；保留暂停，下一次成功的快照负责恢复事件分发。
      } finally {
        if (currentRuntime.synchronizations.get(threadId) === task) {
          currentRuntime.synchronizations.delete(threadId);
        }
      }
    }),
  };

  currentRuntime.synchronizations.set(threadId, task);
  useIMStore.getState().setThreadDetailLoadState(threadId, { status: 'loading' });
  return task.promise;
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
  currentRuntime.synchronizations.clear();
  currentRuntime.unbindStore();
  currentRuntime.service.destroy();
}

/** Vite 热更新时释放旧模块持有的订阅和 WebSocket。 */
if (import.meta.hot) {
  import.meta.hot.dispose(destroyIMService);
}
