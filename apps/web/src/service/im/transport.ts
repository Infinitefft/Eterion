/**
 * IM WebSocket Transport。
 *
 * Transport 只负责 WebSocket 的物理通信：
 * 1. 建立和关闭连接；
 * 2. 意外断线后自动重连；
 * 3. 发送已经序列化的字符串；
 * 4. 原样上报服务端发送的文本帧。
 *
 * Transport 不认识 Command、ACK、ThreadEvent、threadId 和 seqId。
 * 这些应用层概念全部交给 IMService 处理。
 */

/**
 * WebSocket 当前所处的物理连接阶段。
 *
 * disabled：当前没有配置 WebSocket 地址，例如用户未登录。
 * idle：Transport 已创建，但还没有调用 connect()。
 * connecting：正在建立首次连接。
 * connected：WebSocket 已成功连接。
 * reconnecting：意外断线后正在自动重连。
 * disconnected：连接已经断开。
 * failed：自动重连次数耗尽。
 */
export type IMConnectionStatus =
  'disabled' | 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'failed';

/**
 * Transport 自己产生的错误
 *
 * 它与 protocol.ts 中的 ProtocolError 不同
 * ProtocolError 是后端返回的应用层错误
 * IMTransportError 是浏览器连接过程中产生的错误
 */
export interface IMTransportError {
  code: string;
  message: string;
}

/** WebSocket 物理连接的完整状态快照 */
export interface IMConnectionState {
  status: IMConnectionStatus;

  /**
   * 当前连接重连次数
   *
   * WebSocket 成功连接后清零
   */
  reconnectAttempts: number;

  /** 最近一次成功连接的 Unix 毫秒时间 */
  connectedAt: number | null;

  /** 最近一次断开连接的 Unix 毫秒时间 */
  disconnectedAt: number | null;

  /** 最近一次 Transport 错误，当前没有错误时为 null */
  lastError: IMTransportError | null;
}

/**
 * Transport 向 IMService 发布的底层事件
 *
 * 它不是服务端 IM 协议中的 Envelope
 * 只是浏览器内部 Transport 与 IMService 之间的事件
 */
export type IMTransportEvent =
  | {
      /** WebSocket 物理连接状态发生变化 */
      type: 'state.changed';

      /**
       * 变化后的完整状态快照
       *
       * 这里发送完整状态，而不是局部 patch
       * 可以让订阅者不必自己合并状态
       */
      state: Readonly<IMConnectionState>;
    }
  | {
      /** WebSocket 收到一个服务端文本帧 */
      type: 'message.received';

      /**
       * 服务端发送的原始字符串
       *
       * Transport 不执行 JSON.parse()
       * 后续由 IMService 解析成 ServerFrame
       */
      data: string;
    };

/** Transport 事件的监听函数 */
export type IMTransportListener = (event: IMTransportEvent) => void;

/** 调用该函数可以取消对应的 Transport 监听 */
export type IMTransportUnsubscribe = () => void;

/** 自动重连配置 */
export interface IMReconnectOptions {
  /** 是否允许在意外断开后自动重连 */
  enabled?: boolean;

  /** 一轮连接生命周期允许的最大连续重连次数 */
  maxAttempts?: number;

  /** 第一次自动重连前等待的毫秒数 */
  initialDelayMs?: number;

  /** 指数退避可以增长到的最大等待毫秒数 */
  maxDelayMs?: number;
}

/**
 * WebSocket 地址来源
 *
 * 使用函数时，每次连接和重连都会重新调用它
 * 因此可以在函数中申请新的短期鉴权 Ticket
 *
 * 返回 null 表示当前没有启动 IM 连接
 */
export type IMWebSocketUrlSource = string | null | (() => string | null | Promise<string | null>);

/** 创建 WebSocketTransport 所需的配置 */
export interface WebSocketTransportOptions {
  url: IMWebSocketUrlSource;
  reconnect?: IMReconnectOptions;
}

/**
 * IMService 依赖的最小 Transport 能力
 *
 * 接口与具体 WebSocketTransport 实现分开
 */
export interface IMTransport {
  /** 获取当前物理连接状态的只读快照 */
  getState(): Readonly<IMConnectionState>;

  /**
   * 建立 WebSocket 连接
   *
   * Promise 只等待浏览器触发 onopen
   * 不等待任何应用层 ACK 或 ready 事件
   */
  connect(): Promise<void>;

  /** 主动关闭连接，并停止自动重连 */
  disconnect(): void;

  /**
   * 发送已经序列化完成的字符串
   *
   * JSON.stringify(ClientCommand) 由 IMService 完成
   * Transport 只负责把字符串交给 WebSocket
   */
  send(data: string): void;

  /**
   * 订阅连接状态和原始文本帧
   *
   * 返回值用于取消当前订阅
   */
  subscribe(listener: IMTransportListener): IMTransportUnsubscribe;
}

/**
 * 调用方没有提供重连配置时使用的默认值。
 *
 * Required<IMReconnectOptions> 会把所有可选字段转换成必填字段，
 * 后面的实现便不需要反复判断 undefined。
 */
const DEFAULT_RECONNECT_OPTIONS: Required<IMReconnectOptions> = {
  /** 默认允许意外断线后自动重连。 */
  enabled: true,

  /** 连续失败 8 次后停止自动重连。 */
  maxAttempts: 8,

  /** 第一次重连等待 1 秒。 */
  initialDelayMs: 1_000,

  /** 后续退避时间最长不超过 30 秒。 */
  maxDelayMs: 30_000,
};

/**
 * 基于浏览器原生 WebSocket 的 Transport 实现
 *
 */
export class WebSocketTransport implements IMTransport {
  /**
   * 当前仍然有效的浏览器 WebSocket
   *
   * 没有建立连接或连接已经断开时为 null
   */
  private socket: WebSocket | null = null;

  /**
   * 当前正在进行的连接任务
   *
   * 如果多个地方同时调用 connect()
   * 它们应该复用同一个 Promise，而不是创建多个 WebSocket
   */
  private connectPromise: Promise<void> | null = null;

  /**
   * Transport 的全部订阅者
   */
  private readonly listeners = new Set<IMTransportListener>();

  /**
   * 尚未触发的自动重连定时器
   *
   * 没有等待中的重连任务时为 null
   */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * 最近一次断开是否由前端主动断开
   *
   * 主动调用 disconnect() 后不应该继续自动重连
   */
  private manuallyDisconnected = false;

  /**
   * 当前连接生命周期的编号
   *
   * disconnect() 时会递增这个数字
   * 旧的 URL 请求或旧 WebSocket 即使稍后才会返回
   * 也可以通过生命周期编号判断自己是否已经过期
   */
  private lifecycleId = 0;

  /** Transport 当前保存的物理连接状态 */
  private state: IMConnectionState = {
    /** 实例刚创建，还没有调用 connect() */
    status: 'idle',

    /** 当前还没有执行过自动重连 */
    reconnectAttempts: 0,

    /** 当前还没有成功连接过 */
    connectedAt: null,

    /** 当前还没有发生过断开 */
    disconnectedAt: null,

    /** 当前没有 Transport 错误 */
    lastError: null,
  };

  /**
   * 创建 Transport 时传入的原始配置
   *
   * readonly 表示构造完成后不能替换整个 options
   */
  private readonly options: WebSocketTransportOptions;

  /**
   * 合并默认值后的完整重连配置。
   *
   * 这里的所有字段都是必填字段。
   */
  private readonly reconnectOptions: Required<IMReconnectOptions>;

  constructor(options: WebSocketTransportOptions) {
    this.options = options;

    /**
     * 先展开默认值，再展开调用方配置
     */
    this.reconnectOptions = {
      ...DEFAULT_RECONNECT_OPTIONS,
      ...options.reconnect,
    };
  }

  /**
   * 返回当前连接状态的只读快照
   *
   * 不能直接 return this.state
   * 否则调用方仍可能在运行时修改内部对象
   */
  getState(): Readonly<IMConnectionState> {
    return {
      ...this.state,

      /**
       * lastError 是嵌套对象，所以也要单独复制
       *
       * 当前没有错误时继续返回 null
       */
      lastError: this.state.lastError ? { ...this.state.lastError } : null,
    };
  }

  /**
   * 建立或复用 WebSocket 连接
   *
   * Promise 只表示浏览器 WebSocket 是否成功触发 onopen
   * 不代表后端已经处理任何 IM Command
   */
  connect(): Promise<void> {
    /**
     * 当前 Socket 已经打开时直接成功
     */
    if (this.socket?.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }

    /**
     * 已经存在尚未完成的连接任务时
     * 直接返回同一个 Promise
     */
    if (this.connectPromise) {
      return this.connectPromise;
    }

    /**
     * 主动调用 connect() 表示用户希望重新开启连接
     *
     * 即使之前调用过 disconnect()
     * 现在也重新允许连接和自动重连
     */
    this.manuallyDisconnected = false;

    /**
     * 如果当前正在等待一次自动重连
     * 主动 connect() 应该取消等待并立即连接
     */
    this.clearReconnectTimer();

    /**
     * false 表示这是主动建立的首次连接
     * 不是自动重连
     */
    return this.beginConnection(false);
  }

  /**
   * 主动断开当前 WebSocket
   *
   * 主动断开后：
   * - 关闭当前 Socket
   * - 取消等待中的自动重连
   * - 使旧异步回调失败
   * - 不再自动建立新连接
   */
  disconnect(): void {
    /**
     * 先设置主动断开标志
     *
     * 浏览器稍后触发 onclose 时
     * onclose 就知道不应该安排自动重连
     */
    this.manuallyDisconnected = true;

    /**
     * 递增生命周期编号
     *
     * 旧 URL Resolver 和旧 Socket 保存的生命周期编号
     * 将不再等于当前 lifecycleId
     */
    this.lifecycleId += 1;

    /** 取消尚未执行的自动重连定时器 */
    this.clearReconnectTimer();

    /**
     * 临时保存当前 Socket
     *
     * 后面需要调用旧的 Socket 的 close()
     */
    const socket = this.socket;

    /**
     * 先解除当前实例对旧 Socket 的引用
     *
     * 之后旧 Socket 即使产生 message 或 close 回调
     * 也不会再被视为当前有效连接
     */
    this.socket = null;

    /**
     * 已经取消的连接任务不能下一次 connect() 继续复用
     *
     * 旧 Promise 最终仍会由旧 Socket 或生命周期检查结束
     */
    this.connectPromise = null;

    /**
     * CONNECTING 表示仍在建立连接：
     * OPEN 表示连接已经建立
     *
     * 这两种状态都需要主动调用 close()
     */
    if (
      socket &&
      (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)
    ) {
      /**
       * 1000 表示正常关闭
       *
       * client_disconnect 是便于后端日志识别的关闭原因
       */
      socket.close(1000, 'client_disconnect');
    }

    /** disabled 表示当前根本没有配置 WebSocket 地址 */
    if (this.state.status === 'disabled') {
      return;
    }

    /**
     * 立即向订阅者发布 disconnected
     *
     * 不需要等待浏览器异步触发旧 Socket 的 onclose
     */
    this.updateState({
      status: 'disconnected',
      disconnectedAt: Date.now(),
      lastError: null,
    });
  }

  /**
   * 发送已经序列化完成的字符串
   *
   * Transport 不执行 JSON.stringify()
   * 也不会理解字符串中是什么 Command
   */
  send(data: string): void {
    /**
     * Transport 不保存离线消息队列
     *
     * 未连接时是否重试、是否等待
     * 应该由掌握 Command 语义的 IMService 决定
     */
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('IM WebSocket 尚未建立，无法发送数据');
    }

    /** 将字符串原样交给浏览器 WebSocket */
    this.socket.send(data);
  }

  /**
   * 订阅 Transport 事件
   *
   * 订阅者可以收到
   * - state.changed
   * - message.received
   */
  subscribe(listener: IMTransportListener): IMTransportUnsubscribe {
    /**
     * 将监听函数加入 Set
     */
    this.listeners.add(listener);

    /**
     * 返回取消订阅的函数
     *
     * 调用它只删除当前 listener
     * 不会影响其他订阅者
     */
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 创建一次连接任务
   *
   * 这个方法负责：
   * - 记录当前连接生命周期
   * - 调用 openSocket() 建立连接
   * - 保存正在执行的 Promise
   * - 连接失败后安排自动重试
   */
  private beginConnection(isReconnect: boolean): Promise<void> {
    /**
     * 保存本次连接所属的生命周期编号
     *
     * 如果后续调用 disconnect()
     * this.lifecycleId 会递增，本次任务就会自动失效
     */
    const expectedLifecycleId = this.lifecycleId;

    /**
     * 真正开始解析 URL 和创建 WebSocket
     */
    const attempt = this.openSocket(isReconnect, expectedLifecycleId);

    /**
     * 保存当前连接 Promise
     *
     * 其他地方再次调用 connect() 时
     * 会直接复用这个 Promise
     */
    this.connectPromise = attempt;

    /**
     * 分别处理连接成功和连接失败
     *
     * void 表示我们有意忽略 then() 新产生的 Promise
     * 真正的 attempt 仍然会返回给 connect() 调用者
     */
    void attempt.then(
      () => {
        /**
         * 只有当前保存的任务仍然是 attempt
         * 才可以清除 connectPromise
         *
         * 防止旧任务完成后误删一个更新的连接任务
         */
        if (this.connectPromise === attempt) {
          this.connectPromise = null;
        }
      },
      () => {
        /**
         * 如果 connectPromise 已经被替换或清空
         * 说明当前失败来自一个已经过期的连接任务
         */
        if (this.connectPromise !== attempt) {
          return;
        }

        /** 当前连接任务已经结束，不再允许后续 connect 调用 */
        this.connectPromise = null;

        /**
         * 连接失败后尝试安排自动重连
         */
        this.scheduleReconnect();
      },
    );

    /** 将当前连接结果返回给 connect() 调用者 */
    return attempt;
  }

  /**
   * 解析本次连接需要使用的 WebSocket 地址
   *
   * URL 来源可能是：
   * - 固定字符串
   * - null
   * - 同步函数
   * - 异步函数
   */
  private async resolveWebSocketURL(expectedLifecycleId: number): Promise<string | null> {
    let value: string | null;

    try {
      /**
       * URL 来源是函数时，每次连接都重新调用
       *
       * 这样自动重连时能够重新申请短期鉴权 Ticket
       */
      value = typeof this.options.url === 'function' ? await this.options.url() : this.options.url;
    } catch {
      /**
       * 如果 URL 请求失败前已经调用 disconnect()
       * 这只是旧生命周期的迟到结果，不应该更新连接错误
       */
      if (!this.isCurrentLifecycle(expectedLifecycleId)) {
        throw new Error('IM WebSocket 连接已取消');
      }

      /** 创建一个只属于 Transport 的结构化错误 */
      const error: IMTransportError = {
        code: 'IM_URL_RESOLVE_FAILED',
        message: '无法获取 IM WebSocket 连接地址',
      };

      /** URL 获取失败时发布物理连接错误 */
      this.updateState({
        status: 'disconnected',
        disconnectedAt: Date.now(),
        lastError: error,
      });

      /** 将错误继续返回给 connect() 调用者 */
      throw new Error(error.message);
    }

    /** URL 返回期间可能已经发生主动断开 */
    if (!this.isCurrentLifecycle(expectedLifecycleId)) {
      throw new Error('IM WebSocket 连接已取消');
    }

    /** null、空字符串和全空格字符串都表示当前没有启用 IM */
    return value?.trim() || null;
  }

  /**
   * 解析连接地址并创建浏览器 WebSocket
   *
   * Promise 在 onopen 时完成
   * 在连接建立前触发 onclose 时失败
   */
  private async openSocket(isReconnect: boolean, expectedLifecycleId: number): Promise<void> {
    /** 每次连接都重新解析地址，自动重连因此可以获取新 Ticket */
    const url = await this.resolveWebSocketURL(expectedLifecycleId);

    /** null 表示当前环境没有启用 IM，不属于连接错误 */
    if (!url) {
      this.updateState({
        status: 'disabled',
        reconnectAttempts: 0,
        lastError: null,
      });

      return;
    }

    /** 首次连接和自动重连使用不同状态 */
    this.updateState({
      status: isReconnect ? 'reconnecting' : 'connecting',
      reconnectAttempts: isReconnect ? this.state.reconnectAttempts : 0,
      lastError: null,
    });

    /** 等待浏览器 WebSocket 报告连接结果 */
    return new Promise<void>((resolve, reject) => {
      let socket: WebSocket;

      try {
        /** 构造函数接收本次解析出的完整 WebSocket 地址 */
        socket = new WebSocket(url);
      } catch {
        /** URL 非法等情况可能让 WebSocket 构造函数同步抛错 */
        const error: IMTransportError = {
          code: 'IM_SOCKET_CREATE_FAILED',
          message: '创建 IM WebSocket 失败',
        };

        /** 过期生命周期的错误不能污染新连接 */
        if (this.isCurrentLifecycle(expectedLifecycleId)) {
          this.updateState({
            status: 'disconnected',
            disconnectedAt: Date.now(),
            lastError: error,
          });
        }

        reject(new Error(error.message));
        return;
      }

      /** 新创建的 Socket 从此刻起成为当前有效连接 */
      this.socket = socket;

      /** 用于区分“建立前失败”和“连接后的运行期断线” */
      let opened = false;

      socket.onopen = () => {
        /** 旧 Socket 或已取消生命周期不能重新覆盖当前状态 */
        if (!this.isCurrentSocket(socket, expectedLifecycleId)) {
          socket.close(1000, 'stale_connection');
          return;
        }

        /** 后续再触发 close 时应被视为运行期断线 */
        opened = true;

        /** 连接成功后清空连续重连次数和旧错误 */
        this.updateState({
          status: 'connected',
          reconnectAttempts: 0,
          connectedAt: Date.now(),
          disconnectedAt: null,
          lastError: null,
        });

        /** connect() 只等待物理 WebSocket 成功打开 */
        resolve();
      };

      socket.onmessage = (event: MessageEvent<unknown>) => {
        /** 旧 Socket 的迟到消息直接丢弃 */
        if (!this.isCurrentSocket(socket, expectedLifecycleId)) {
          return;
        }

        /** 应用层协议只接收文本 JSON 帧 */
        if (typeof event.data !== 'string') {
          this.updateState({
            lastError: {
              code: 'IM_UNSUPPORTED_MESSAGE',
              message: 'IM WebSocket 收到了不支持的二进制数据',
            },
          });

          return;
        }

        /** Transport 不解析内容，按抵达顺序原样发布 */
        this.emit({
          type: 'message.received',
          data: event.data,
        });
      };

      socket.onerror = () => {
        /** 旧 Socket 的 error 不能污染当前连接 */
        if (!this.isCurrentSocket(socket, expectedLifecycleId)) {
          return;
        }

        /** 浏览器不会通过 error 事件提供可靠的底层错误详情 */
        this.updateState({
          lastError: {
            code: 'IM_SOCKET_ERROR',
            message: 'IM WebSocket 连接发生错误',
          },
        });
      };

      socket.onclose = (event: CloseEvent) => {
        /** Socket 尚未打开便关闭时，connect() 必须得到失败结果 */
        if (!opened) {
          reject(new Error(event.reason || 'IM WebSocket 连接已取消'));
        }

        /** 旧 Socket 的 close 不能改变新 Socket 的状态 */
        if (!this.isCurrentSocket(socket, expectedLifecycleId)) {
          return;
        }

        /** 当前 Socket 已经关闭，解除实例引用 */
        this.socket = null;

        /** 主动断开不记录错误，意外断线记录关闭码和原因 */
        const error: IMTransportError | null = this.manuallyDisconnected
          ? null
          : {
              code: `IM_SOCKET_CLOSED_${event.code}`,
              message: event.reason || 'IM WebSocket 连接已断开',
            };

        /** 发布最新物理连接状态 */
        this.updateState({
          status: 'disconnected',
          disconnectedAt: Date.now(),
          lastError: error,
        });

        /** 连接成功打开后发生意外断线才由 onclose 安排重连 */
        if (opened && !this.manuallyDisconnected) {
          this.scheduleReconnect();
        }
      };
    });
  }

  /** 使用带上限的指数退避安排下一次自动重连 */
  private scheduleReconnect(): void {
    /** 主动断开、关闭重连或已有定时器时不重复安排 */
    if (this.manuallyDisconnected || !this.reconnectOptions.enabled || this.reconnectTimer) {
      return;
    }

    /** reconnectAttempts 表示即将执行的重连序号 */
    const nextAttempt = this.state.reconnectAttempts + 1;

    /** 超过最大次数后停止自动重连 */
    if (nextAttempt > this.reconnectOptions.maxAttempts) {
      this.updateState({
        status: 'failed',
        lastError: {
          code: 'IM_RECONNECT_EXHAUSTED',
          message: 'IM WebSocket 已达到最大重连次数',
        },
      });

      return;
    }

    /** 第 n 次等待 initialDelayMs * 2^(n-1)，并限制最大值 */
    const delayMs = Math.min(
      this.reconnectOptions.initialDelayMs * 2 ** (nextAttempt - 1),
      this.reconnectOptions.maxDelayMs,
    );

    /** 等待期间也向页面暴露 reconnecting 状态 */
    this.updateState({
      status: 'reconnecting',
      reconnectAttempts: nextAttempt,
    });

    /** 到达退避时间后才真正申请新 URL 并创建 Socket */
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;

      /** beginConnection 会统一安排下一次失败后的重连 */
      void this.beginConnection(true).catch(() => undefined);
    }, delayMs);
  }

  /** 取消一个尚未触发的自动重连任务 */
  private clearReconnectTimer(): void {
    /** 没有定时器时无需执行任何操作 */
    if (!this.reconnectTimer) {
      return;
    }

    /** 主动断开或手动连接时清除旧定时器 */
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  /** 判断异步任务是否仍属于当前连接生命周期 */
  private isCurrentLifecycle(expectedLifecycleId: number): boolean {
    return !this.manuallyDisconnected && this.lifecycleId === expectedLifecycleId;
  }

  /** 判断一个 Socket 是否仍是当前生命周期唯一有效的 Socket */
  private isCurrentSocket(socket: WebSocket, expectedLifecycleId: number): boolean {
    return this.socket === socket && this.isCurrentLifecycle(expectedLifecycleId);
  }

  /** 合并状态变化，并发布新的完整状态快照 */
  private updateState(patch: Partial<IMConnectionState>): void {
    /** 创建新对象，避免已发布的旧状态被后续修改 */
    this.state = {
      ...this.state,
      ...patch,
    };

    /** 订阅者始终收到完整状态，无需自行合并 patch */
    this.emit({
      type: 'state.changed',
      state: this.getState(),
    });
  }

  /** 向当前所有订阅者同步发布一个 Transport 事件 */
  private emit(event: IMTransportEvent): void {
    /** 同步遍历能够保持文本帧原本的抵达顺序 */
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        /** 单个订阅者异常不能中断 Socket 和其他订阅者 */
        console.error('IM Transport listener failed.', error);
      }
    }
  }
}
