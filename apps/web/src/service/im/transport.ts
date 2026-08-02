import type { IMError, UnixTimestamp } from './types';

/**
 * WebSocket 当前所处的连接阶段
 */
export type IMConnectionStatus =
  | 'disabled'
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'failed';

/**
 * WebSocket 物理连接状态。
 *
 * connectionId、lastPongAt 属于上层 IM 协议状态，
 * 不属于底层 WebSocket Transport。
 */
export interface IMConnectionState {
  status: IMConnectionStatus;
  /** 当前连续重连次数，连接成功后重置为 0 */
  reconnectAttempts: number;
  /** 最近一次成功建立连接的时间 */
  connectedAt: UnixTimestamp | null;
  /** 最近一次断开连接的时间 */
  disconnectedAt: UnixTimestamp | null;
  lastError: IMError | null;
}

export type IMTransportEvent =
  | {
      type: 'state.changed';
      state: Readonly<IMConnectionState>;
    }
  | {
      type: 'message.received';

      /** WebSocket 收到的原始 JSON 字符串 */
      data: string;
    };


/** Transport 事件监听函数 */
export type IMTransportListener = (event: IMTransportEvent) => void;

/** 取消监听函数 */
export type IMTransportUnsubscribe = () => void;

export interface IMReconnectOptions {
  enabled?: boolean;

  /** 最大重连次数 */
  maxAttempts?: number;

  /** 第一次重连前的等待时间 */
  initialDelayMs?: number;

  /** 单次重连最大的等待时间 */
  maxDelayMs?: number;
}

export interface WebSocketTransportOptions {
  url: string | (() => string | null);
  reconnect?: IMReconnectOptions;
}

export interface IMTransport {
  getState(): Readonly<IMConnectionState>;

  /** 创建连接 */
  connect(): Promise<void>;

  /** 主动断开连接 */
  disconnect(): void;

  /** 发送已经序列化完成的协议字符串 */
  send(data: string): void;

  /** 
   * 监听 Transport 事件
   * 
   * @returns 取消监听函数
   */
  subscribe(listener: IMTransportListener): IMTransportUnsubscribe;
}

const DEFAULT_RECONNECT_OPTIONS: Required<IMReconnectOptions> = {
  enabled: true,
  maxAttempts: 8,
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
};

export class WebSocketTransport implements IMTransport {
  private socket: WebSocket | null = null;

  /**
   * 保存正在进行的连接任务。
   *
   * connect() 被重复调用时会复用它，
   * 避免同时创建多个 WebSocket。
   */
  private connectPromise: Promise<void> | null = null;

  /** 所有订阅 Transport 事件的监听器 */
  private readonly listeners = new Set<IMTransportListener>();

  /** 自动重连定时器 */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** 
   * 是否由前端主动断开
   * 主动断开时不应该继续自动重连
   */
  private manuallyDisconnected = false;

  /** 当前连接状态 */
  private state: IMConnectionState = {
    status: 'idle',
    reconnectAttempts: 0,
    connectedAt: null,
    disconnectedAt: null,
    lastError: null,
  }

  private readonly reconnectOptions: Required<IMReconnectOptions>;

  constructor(private readonly options: WebSocketTransportOptions) {
    this.reconnectOptions = {
      ...DEFAULT_RECONNECT_OPTIONS,
      ...options.reconnect,
    }
  }

  getState(): Readonly<IMConnectionState> {
    return { ...this.state }
  }

  connect(): Promise<void> {
    /**
     * 已经连接时无需重复连接
     */
    if (this.socket?.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }

    /**
     * 已经处于连接过程中时，直接复用同一个 Promise
     */
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.manuallyDisconnected = false;
    this.clearReconnectTimer();

    return this.beginConnection(false);
  }

  disconnect(): void {
    this.manuallyDisconnected = true;
    this.clearReconnectTimer();

    const socket = this.socket;
  
    if (socket 
      && (socket.readyState === WebSocket.CONNECTING || 
        socket.readyState === WebSocket.OPEN)
    ) {
      socket.close(1000, 'client_disconnect');
      return;
    }
    this.socket = null;

    if (this.state.status !== 'disabled') {
      this.updateState({
        status: 'disconnected',
        disconnectedAt: Date.now(),
      });
    }
  }

  send(data: string): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('IM WebSocket is not connected.');
    }

    this.socket.send(data);
  }

  subscribe(listener: IMTransportListener): IMTransportUnsubscribe {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    }
  }

  /**
   * 开始第一次连接，并保存连接 Promise
   */
  private beginConnection(isReconnect: boolean): Promise<void> {
    const attempt = this.openSocket(isReconnect);

    this.connectPromise = attempt;

    void attempt.then(
      () => {
        if (this.connectPromise === attempt) {
          this.connectPromise = null;
        }
      },
      () => {
        if (this.connectPromise === attempt) {
          this.connectPromise = null;
        }

        this.scheduleReconnect();
      }
    );

    return attempt;
  }

  /** 
   * 创建真正的浏览器 WebSocket
   */
  private openSocket(isReconnect: boolean): Promise<void> {
    let url: string | null;

    try {
      url = typeof this.options.url === 'function'
      ? this.options.url()
      : this.options.url;
    } catch {
      const error: IMError = {
        code: 'IM_URL_RESOLVE_FAILED',
        message: '无法获取 IM WebSocket 连接地址',
        retryable: true,
      }

      this.updateState({
        status: 'failed',
        lastError: error,
      })

      return Promise.reject(new Error(error.message));
    }
    
    /**
     * URL 为 null 或空字符串，表示当前没有启用 IM 连接
     * 例如用户还没有登录，或者后端 IM 暂未开启
     */
    if (!url) {
      this.updateState({
        status: 'disabled',
        lastError: null,
      })

      return Promise.resolve();
    }

    this.updateState({
      status: isReconnect ? 'reconnecting' :  'connecting',
      reconnectAttempts: isReconnect
        ? this.state.reconnectAttempts
        : 0,
      lastError: null,
    })

    return new Promise<void>((resolve, reject) => {
      let socket: WebSocket;

      try {
        socket = new WebSocket(url);
      } catch {
        const error: IMError = {
          code: 'IM_SOCKET_CREATE_FAILED',
          message: '创建 IM WebSocket 失败',
          retryable: true,
        }
        
        this.updateState({
          status: 'disconnected',
          disconnectedAt: Date.now(),
          lastError: error,
        })

        reject(new Error(error.message));
        return;
      }

      this.socket = socket;

      /**
       * 用来判断当前连接是否曾经成功打开
       * 如果连接还没打开就关闭，需要拒绝 connect()
       * 如果已经打开后再关闭，则属于运行期间断线
       */
      let opened = false;

      socket.onopen = () => {
        if (this.socket !== socket) {
          return;
        }
        
        if (this.manuallyDisconnected) {
          socket.close(1000, 'client_disconnect');
          return;
        }

        opened = true;

        this.updateState({
          status: 'connected',
          reconnectAttempts: 0,
          connectedAt: Date.now(),
          lastError: null,
        })

        resolve();
      }

      socket.onmessage = (event: MessageEvent<unknown>) => {
        if (this.socket !== socket) {
          return;
        }

        if (typeof event.data !== 'string') {
          this.updateState({
            lastError: {
              code: 'IM_UNSUPPORTED_MESSAGE',
              message: 'IM WebSocket 收到了不支持的二进制数据',
              retryable: false,
            }
          })

          return;
        }

        this.emit({
          type: 'message.received',
          data: event.data,
        })
      }

      socket.onerror = () => {
        if (this.socket !== socket) {
          return;
        }

        /**
         * 浏览器不会通过 WebSocket error 事件暴露详细原因
         * 最终断开信息会继续由 close 事件处理
         */
        this.updateState({
          lastError: {
            code: 'IM_SOCKET_ERROR',
            message: 'IM WebSocket 连接发生错误',
            retryable: true,
          }
        });
      };
      
      socket.onclose = (event: CloseEvent) => {
        if (this.socket !== socket) {
          return;
        }

        this.socket = null;

        const error: IMError | null = this.manuallyDisconnected
        ? null
        : {
            code: `IM_SOCKET_CLOSED_${event.code}`,
            message: event.reason || 'IM WebSocket 连接已断开。',
            retryable: true,
          };
        
        this.updateState({
          status: 'disconnected',
          disconnectedAt: Date.now(),
          lastError: error,
        });

        /**
         * 连接建立前就断开，需要让 connect() 得知失败
         */
        if (!opened) {
          reject(new Error(error?.message || 'IM WebSocket 连接已取消'));
          return;
        }

        /**
         * 已经成功连接后发生意外断开，启动自动重连
         */
        if (!this.manuallyDisconnected) {
          this.scheduleReconnect();
        }
      }
    })
  }

  /**
   * 使用指数退避算法重连
   */
  private scheduleReconnect(): void {
    if (
      this.manuallyDisconnected || 
      !this.reconnectOptions.enabled ||
      this.reconnectTimer
    ) {
      return;
    }

    const nextAttempt = this.state.reconnectAttempts + 1;
    if (nextAttempt > this.reconnectOptions.maxAttempts) {
      this.updateState({
        status: 'failed',
        lastError: {
          code: 'IM_RECONNECT_EXHAUSTED',
          message: 'IM WebSocket 已达到最大重连次数',
          retryable: true,
        }
      })
      
      return;
    }
    
    const delay = Math.min(
      this.reconnectOptions.initialDelayMs * 2 ** (nextAttempt - 1),
      this.reconnectOptions.maxDelayMs,
    );

    this.updateState({
      status: 'reconnecting',
      reconnectAttempts: nextAttempt,
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;

      void this.beginConnection(true).catch(() => undefined);
    }, delay);
  }

  /**
   * 取消尚未执行的自动重连
   */
  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) {
      return;
    }

    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  /**
   * 更新连接状态，并向所有监听者发送完整状态快照
   */
  private updateState(patch: Partial<IMConnectionState>): void {
    this.state = {
      ...this.state,
      ...patch,
    }

    this.emit({
      type: 'state.changed',
      state: this.getState(),
    })
  }

  /**
   * 向所有订阅者发布 Transport 事件
   */
  private emit(event: IMTransportEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        /**
         * 单个订阅者异常不能中断 Transport 自己的连接和重连流程。
         */
        console.error('IM Transport listener failed.', error);
      }
    }
  }
}
