import { getApiError } from '@/api/errors';
import { createIMTicket, fetchThreadSnapshot } from '@/api/im';
import { useAuthStore } from '@/store/auth-store';
import { useIMStore } from '@/store/im-store';

import { IMService } from './imService';
import { createFrameEventBuffer } from './frameEventBuffer';
import { WebSocketTransport } from './transport';

import type { ThreadId } from './types';

interface ThreadSynchronization {
  promise: Promise<void>;
  isCurrent(): boolean;
  needsResync: boolean;
}

/** 全局 IM Runtime 中真正需要长期持有的对象。 */
interface IMRuntime {
  service: IMService;
  unbindStore: () => void;
  synchronizations: Map<ThreadId, ThreadSynchronization>;
  flushEvents: () => void;
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

    const frameEvents = createFrameEventBuffer((events) => {
      const store = useIMStore.getState();
      // 删除会话之后到帧提交之前，旧 delta 不能重新创建它。
      store.applyEnvelope(events.filter((event) =>
        (event.type !== 'thinking.delta' && event.type !== 'message.delta') ||
        store.detailsByThread[event.threadId] !== undefined,
      ));
    });
    const unbindAuth = useAuthStore.subscribe((state, previous) => {
      if (state.sessionVersion !== previous.sessionVersion) frameEvents.clear();
    });
    const unbindReset = useIMStore.subscribe((state) => {
      if (state.detailsByThread === useIMStore.getInitialState().detailsByThread) frameEvents.clear();
    });

    const unbindStore = service.subscribe((event) => {
      const store = useIMStore.getState();

      switch (event.kind) {
        case 'envelope': {
          const envelope = event.envelope;
          if (import.meta.env.DEV && envelope.type === 'message.completed') {
            frameEvents.flush();
            const previous = useIMStore.getState().detailsByThread[envelope.threadId]?.messages
              .find((message) => message.id === envelope.messageId);
            if (previous && envelope.payload.content.length > previous.content.length) {
              // 只记字数，不输出正文：区分终态补齐与 HTTP 快照覆盖。
              console.warn('IM completion filled missing text', {
                threadId: envelope.threadId, runId: envelope.runId,
                streamedChars: previous.content.length,
                completedChars: envelope.payload.content.length,
              });
            }
          }
          frameEvents.enqueue(envelope);

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
          frameEvents.flush();
          // 将连接、断线、重连等状态同步给页面使用
          store.setConnectionState(event.state);
          if (runtime?.service === service) {
            invalidateSynchronizations(runtime);
            if (event.state.status === 'connected' && store.connection.status !== 'connected') {
              // 首次连接也可能晚于详情快照；连接建立后补齐这段窗口。
              if (store.activeThreadId) {
                const pending = runtime.synchronizations.get(store.activeThreadId);
                if (pending?.isCurrent()) {
                  pending.needsResync = true;
                } else {
                  void synchronizeThread(store.activeThreadId);
                }
              }
            }
          }
          if (event.state.status === 'disconnected' || event.state.status === 'failed') {
            console.warn('IM connection interrupted', event.state);
          }
          break;
        }
        case 'sequenceGap': {
          frameEvents.flush();
          console.warn('IM sequence gap; synchronizing thread', event.gap);
          const pending = runtime?.synchronizations.get(event.gap.threadId);
          if (pending?.isCurrent()) {
            // resumeThread 同步发布的新缺口不能被当前任务的去重逻辑吞掉。
            pending.needsResync = true;
          } else {
            void synchronizeThread(event.gap.threadId);
          }
          break;
        }
      }
    });

    // 保存实例和它对应的取消订阅函数
    runtime = {
      service,
      unbindStore: () => {
        frameEvents.clear();
        unbindAuth();
        unbindReset();
        unbindStore();
      },
      flushEvents: frameEvents.flush,
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
    needsResync: true,
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
        while (task.needsResync && task.isCurrent()) {
          task.needsResync = false;
          service.pauseThread(threadId);
          const snapshot = await fetchThreadSnapshot(threadId);
          if (!task.isCurrent()) {
            return;
          }

          // 快照包含这些增量：先清空帧缓冲，避免下一帧重复追加到快照正文。
          currentRuntime.flushEvents();
          if (import.meta.env.DEV) {
            const previous = useIMStore.getState().detailsByThread[threadId];
            for (const message of snapshot.messages) {
              const current = previous?.messages.find((item) => item.id === message.id);
              if (current?.status === 'streaming' && message.content.length > current.content.length) {
                console.warn('IM snapshot filled missing text', {
                  threadId, runId: message.runId, streamedChars: current.content.length,
                  snapshotChars: message.content.length, lastSeqId: snapshot.lastSeqId,
                });
              }
            }
          }
          useIMStore.getState().applySnapshot(snapshot);
          service.resumeThread(threadId, snapshot.lastSeqId);
          currentRuntime.flushEvents();
        }
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
