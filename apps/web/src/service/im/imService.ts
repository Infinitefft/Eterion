import type {
  AckFrame,
  ClientCommand,
  HITLAnswer,
  InteractionId,
  InteractionRespondCommand,
  MessageId,
  MessageSendCommand,
  ModelId,
  RequestId,
  RunCancelCommand,
  RunId,
  SeqId,
  ServerFrame,
  ServerThreadEvent,
  ThreadId,
  ThreadStartCommand,
} from './protocol';
import type {
  IMConnectionState,
  IMTransport,
  IMTransportEvent,
  IMTransportUnsubscribe,
} from './transport';

/**
 * 全局 IM 应用层服务。
 *
 * 上行：页面构造 Command -> Transport 发送 -> requestId 匹配 ACK。
 * 下行：Transport 接收 Frame -> threadId 路由 -> seqId 排序 -> 状态层消费。
 *
 * 这里不组装 React 页面状态；Message、Run、Thinking、Tool、HITL 和未读状态
 * 由后续状态层根据这里发布的有序 Envelope 统一维护。
 */

/** 创建 Thread 并发送首条用户消息所需的数据。 */
export interface StartThreadInput {
  /** 用户发送的首条消息正文。 */
  content: string;
  /** 不传时由服务端选择默认模型。 */
  modelId?: ModelId;
  /** 明确重发同一业务意图时，可以复用原 ThreadId。 */
  threadId?: ThreadId;
  /** 明确重发同一条消息时，可以复用原 MessageId。 */
  messageId?: MessageId;
}

/** 向已经存在的 Thread 发送消息所需的数据。 */
export interface SendMessageInput {
  /** 目标 Thread。 */
  threadId: ThreadId;
  /** 用户输入的消息正文。 */
  content: string;
  /** 不传时由服务端选择默认模型。 */
  modelId?: ModelId;
  /** 重发同一业务消息时可以复用原 MessageId。 */
  messageId?: MessageId;
}

/** 取消一次 Agent Run 所需的数据。 */
export interface CancelRunInput {
  /** Run 所属的 Thread。 */
  threadId: ThreadId;
  /** 要取消的 Agent Run。 */
  runId: RunId;
}

/**
 * 回答一次 HITL 需要的数据
 */
export interface RespondToInteractionInput {
  /** HITL 所属的 Thread。 */
  threadId: ThreadId;
  /** 当前等待用户输入的 Run。 */
  runId: RunId;
  /** 需要回答的具体 HITL。 */
  interactionId: InteractionId;
  /** 用户对本次 HITL 全部问题的回答。 */
  answers: HITLAnswer[];
}

/**
 * 业务方法同步返回完整 Command，同时异步等待 ACK。
 * 状态层可以先使用 Command 中的稳定业务 ID 做乐观更新。
 */
export interface IMCommandDispatch<TCommand extends ClientCommand> {
  /** 已经生成完整业务 ID 的 Command。 */
  command: Readonly<TCommand>;
  /** 本次发送的异步 ACK 结果。 */
  ack: Promise<AckFrame>;
}

/**
 * 某个 Thread 出现 seqId 缺口时的数据
 */
export interface ThreadSequenceGap {
  /** 出现序号缺口的 Thread。 */
  threadId: ThreadId;
  /** 当前期望接收到的 seqId */
  expectedSeqId: SeqId;
  /** 实际提前到达并触发本次 gap 的 seqId。 */
  receivedSeqId: SeqId;
}

/**
 * IMService 向状态层发布的统一事件。
 *
 * 状态层只需要调用一次 subscribe()，
 * 然后通过 kind 判断当前收到的是什么数据。
 *
 * kind 是 IMService 内部判别字段，
 * 不等同于服务端 Envelope 的 type。
 */
export type IMServiceEvent =
  | {
      /** 已经通过 seqId 检查，可以安全应用的业务 Envelope。 */
      kind: 'envelope';
      envelope: ServerThreadEvent;
    }
  | {
      /** Transport 的连接状态发生变化。 */
      kind: 'connection';
      state: Readonly<IMConnectionState>;
    }
  | {
      /** 某个 Thread 需要通过 Snapshot 恢复。 */
      kind: 'sequenceGap';
      gap: ThreadSequenceGap;
    };

/** 状态层通常只注册一个统一监听器，再按照 event.kind 分流。 */
export type IMServiceListener = (event: IMServiceEvent) => void;

/** 取消一次 IMService 订阅的函数。 */
export type IMServiceUnsubscribe = () => void;

export interface IMServiceDependencies {
  /** IMService 只依赖底层通信，不直接依赖 React 或 Zustand。 */
  transport: IMTransport;
}

export interface IMServiceOptions {
  /** Command 发出后等待 ACK 的最长时间。 */
  commandAckTimeoutMs?: number;
  /** 单个 Thread 最多缓存多少个暂时不能发布的 Envelope。 */
  maxBufferedEventsPerThread?: number;
}

/** 一条已经登记、但还没有收到服务端 ACK 的请求。 */
interface PendingAck {
  /** 收到 ACK 时完成调用方拿到的 Promise。 */
  resolve: (ack: AckFrame) => void;
  /** 发送失败、断线或超时时让 Promise 失败。 */
  reject: (error: Error) => void;
  /** ACK 完成后必须清理的超时定时器。 */
  timeoutId: ReturnType<typeof setTimeout>;
}

/**
 * 单个 Thread 的实时事件顺序状态。
 *
 * 每个 Thread 都拥有独立的 ThreadStream，
 * 不同 Thread 之间不会比较 seqId。
 */
interface ThreadStream {
  /**
   * 已经安全发布给状态层的最大 seqId。
   *
   * null 表示当前还没有建立本地顺序基线。
   */
  lastSeqId: SeqId | null;

  /**
   * 当前 Thread 是否处于 Snapshot 同步阶段。
   *
   * paused 为 true 时，新到达的 Envelope 只能进入 buffer，
   * 不能直接发布给状态层。
   */
  paused: boolean;

  /**
   * 当前已经通知过状态层的缺失 seqId。
   *
   * 例如当前缺少 11，之后连续收到 12、13、14，
   * 只需要通知状态层一次，不需要重复加载三次 Snapshot。
   */
  reportedGapExpectedSeqId: SeqId | null;
  /** 以 seqId 为 Key，O(1) 查找下一条连续 Envelope。 */
  buffer: Map<SeqId, ServerThreadEvent>;
}

/**
 * 默认等待 ACK 的最长时间。
 *
 * 正常 ACK 应该很快返回，
 * 15 秒主要用于异常情况下释放 Promise 和内存。
 */
const DEFAULT_ACK_TIMEOUT_MS = 15_000;

/**
 * 单个 Thread 默认最多缓存的 Envelope 数量。
 *
 * 防止长期断线或一直无法恢复的 gap 无限占用内存。
 */
const DEFAULT_MAX_BUFFERED_EVENTS = 500;

/** 生成客户端使用的 UUID 业务 ID。 */
function createId(): string {
  /** 浏览器原生 API 会返回一个随机 UUID。 */
  return crypto.randomUUID();
}

/**
 * 把 catch 捕获到的 unknown 转换成标准 Error。
 *
 * JavaScript 允许 throw 字符串、数字或其他任意值，
 * 但业务层统一处理 Error 会更简单。
 */
function toError(error: unknown, fallbackMessage: string): Error {
  /**
   * 已经是 Error 时保留原始信息；
   * 否则使用调用位置提供的默认错误文案。
   */
  return error instanceof Error ? error : new Error(fallbackMessage);
}

/**
 * Command/ACK、Thread 顺序和统一事件发布的应用层协调器。
 */
export class IMService {
  /** 只负责 WebSocket 物理通信的全局 Transport。 */
  private readonly transport: IMTransport;

  /**
   * 每一条 Command 等待 ACK 的最长时间。
   */
  private readonly commandAckTimeoutMs: number;

  /**
   * 每个 Thread 最多允许缓存多少条暂时不能发布的 Envelope。
   */
  private readonly maxBufferedEventsPerThread: number;

  /**
   * 当前仍在等待 ACK 的 Command。
   *
   * Key 是 Command.requestId，
   * 收到 ACK 后也通过 ACK.requestId 找回对应 Promise。
   */
  private readonly pendingAcks = new Map<RequestId, PendingAck>();

  /** 每个 Thread 独立维护 lastSeqId 和乱序 buffer。 */
  private readonly threadStreams = new Map<ThreadId, ThreadStream>();

  /** IMService 唯一的状态层事件发布通道。 */
  private readonly listeners = new Set<IMServiceListener>();

  /** destroy() 时用于解除构造函数建立的 Transport 订阅。 */
  private readonly unsubscribeTransport: IMTransportUnsubscribe;

  /**
   * Transport 最近一次发布的完整连接状态。
   *
   * sendCommand() 会同步读取它，
   * 判断当前是否允许发送 Command。
   */
  private connectionState: Readonly<IMConnectionState>;

  /**
   * 当前 IMService 是否已经被永久销毁。
   *
   * disconnect 后仍然可以重新 connect，
   * destroy 后则不能再使用。
   */
  private destroyed = false;

  /**
   * 创建全局 IMService。
   *
   * 构造函数只保存依赖、合并配置并订阅 Transport，
   * 不会主动建立 WebSocket 连接。
   */
  constructor(dependencies: IMServiceDependencies, options: IMServiceOptions = {}) {
    this.transport = dependencies.transport;
    this.commandAckTimeoutMs = options.commandAckTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
    this.maxBufferedEventsPerThread =
      options.maxBufferedEventsPerThread ?? DEFAULT_MAX_BUFFERED_EVENTS;
    this.connectionState = this.transport.getState();
    this.unsubscribeTransport = this.transport.subscribe(this.handleTransportEvent);
  }

  /**
   * 建立或复用全局的 websocket 连接
   *
   * Promise 只代表底层 websocket 是否成功打开
   * 不代表任何 command 已经被服务端处理
   */
  connect(): Promise<void> {
    /** 已销毁的 Service 不能重新建立连接。 */
    this.assertUsable();
    return this.transport.connect();
  }

  /**
   * 主动断开当前 WebSocket。
   *
   * disconnect 是可恢复操作：
   * 后续仍然可以再次调用 connect()。
   */
  disconnect(): void {
    this.assertUsable();

    /**
     * 旧连接不可能再返回可靠 ACK，
     * 立即结束所有仍在等待的 ack Promise。
     */
    this.rejectAllPendingAcks(new Error('IM WebSocket 已经主动断开'));

    /**
     * 主动断开后不再复用旧 seqId 基线。
     *
     * 下次连接需要通过实时首帧或 Snapshot
     * 重新建立每个 Thread 的顺序状态。
     */
    this.threadStreams.clear();

    /** 真正关闭 WebSocket，并停止 Transport 自动重连 */
    this.transport.disconnect();
  }

  /**
   * 永久销毁 IMService。
   *
   * 主要用于：
   * - 应用真正卸载；
   * - 用户退出登录并销毁旧 Runtime；
   * - Vite 热更新释放旧实例。
   *
   * 普通 React 路由切换不能调用它。
   */
  destroy(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;

    this.unsubscribeTransport();

    this.transport.disconnect();

    this.rejectAllPendingAcks(new Error('IMService 已销毁'));

    this.threadStreams.clear();

    this.listeners.clear();
  }

  /** 获取 Transport 最近一次发布的完整连接状态。 */
  getConnectionState(): Readonly<IMConnectionState> {
    return this.connectionState;
  }

  /**
   * 订阅 IMService 的全部应用层事件。
   *
   * 状态层通常只调用一次，然后根据 event.kind 处理：
   * - envelope；
   * - connection；
   * - sequenceGap。
   */
  subscribe(listener: IMServiceListener): IMServiceUnsubscribe {
    this.assertUsable();

    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 创建 Thread 并发送首条用户消息。
   * ThreadId 和 MessageId 会在发送前确定，便于状态层立即乐观更新。
   */
  startThread(input: StartThreadInput): IMCommandDispatch<ThreadStartCommand> {
    const command: ThreadStartCommand = {
      type: 'thread.start',
      requestId: createId(),
      threadId: input.threadId ?? createId(),
      messageId: input.messageId ?? createId(),
      payload:
        input.modelId === undefined
          ? {
              content: input.content,
            }
          : {
              content: input.content,
              modelId: input.modelId,
            },
    };
    return this.dispatchCommand(command);
  }

  /**
   * 向已有 Thread 发送一条用户消息。
   * MessageId 是稳定业务身份，requestId 只关联本次 ACK。
   */
  sendMessage(input: SendMessageInput): IMCommandDispatch<MessageSendCommand> {
    const command: MessageSendCommand = {
      type: 'message.send',
      requestId: createId(),
      threadId: input.threadId,
      messageId: input.messageId ?? createId(),
      payload:
        input.modelId === undefined
          ? {
              content: input.content,
            }
          : {
              content: input.content,
              modelId: input.modelId,
            },
    };
    return this.dispatchCommand(command);
  }

  /**
   * 请求取消一次 Agent Run。
   * ACK 只表示取消命令被接受，最终状态仍由 run.status Envelope 确认。
   */
  cancelRun(input: CancelRunInput): IMCommandDispatch<RunCancelCommand> {
    const command: RunCancelCommand = {
      type: 'run.cancel',
      requestId: createId(),
      threadId: input.threadId,
      runId: input.runId,
    };
    return this.dispatchCommand(command);
  }

  /** 回答一次正在等待用户输入的 HITL。 */
  respondToInteraction(
    input: RespondToInteractionInput,
  ): IMCommandDispatch<InteractionRespondCommand> {
    const command: InteractionRespondCommand = {
      type: 'interaction.respond',
      requestId: createId(),
      threadId: input.threadId,
      runId: input.runId,
      interactionId: input.interactionId,
      payload: {
        answers: input.answers,
      },
    };
    return this.dispatchCommand(command);
  }

  /**
   * 同步返回完整 Command，并立即开始异步发送和等待 ACK。
   * 这里不 await，调用方才能先取得业务 ID 做乐观更新。
   */
  private dispatchCommand<TCommand extends ClientCommand>(
    command: TCommand,
  ): IMCommandDispatch<TCommand> {
    return {
      command,
      ack: this.sendCommand(command),
    };
  }

  /**
   * 序列化并发送 Command，同时用 requestId 管理 ACK Promise 和超时。
   */
  private sendCommand(command: ClientCommand): Promise<AckFrame> {
    this.assertUsable();

    if (this.connectionState.status !== 'connected') {
      return Promise.reject(new Error('IM WebSocket 尚未连接'));
    }
    // 序列化命令
    let serializedCommand: string;

    try {
      serializedCommand = JSON.stringify(command);
    } catch (error) {
      return Promise.reject(toError(error, 'IM Command 序列化失败'));
    }

    /**
     * UUID 正常情况下不会重复。
     *
     * 这个检查主要防止一个仍在等待的 Promise
     * 被相同 requestId 的新 Command 覆盖。
     */
    if (this.pendingAcks.has(command.requestId)) {
      return Promise.reject(new Error(`重复的 requestId: ${command.requestId}`));
    }

    /**
     * 新 Thread 的服务端业务事件从 seqId = 1 开始
     *
     * 因此前端在发送 thread.start 时
     * 提前把 lastSeqId 设置为 0
     * 表示下一条唯一合法事件是 1
     */
    if (command.type === 'thread.start') {
      const stream = this.getOrCreateThreadStream(command.threadId);

      /**
       * 如果调用方复用了已有的 ThreadStream
       * 不能覆盖已经存在的顺序基线
       */
      if (stream.lastSeqId === null) {
        stream.lastSeqId = 0;
      }
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const pending = this.pendingAcks.get(command.requestId);

        if (!pending) {
          return;
        }

        this.pendingAcks.delete(command.requestId);

        pending.reject(new Error('等待服务端 ACK 超时'));
      }, this.commandAckTimeoutMs);

      const pending: PendingAck = {
        resolve,
        reject,
        timeoutId,
      };

      this.pendingAcks.set(command.requestId, pending);

      try {
        this.transport.send(serializedCommand);
      } catch (error) {
        /**
         * 测试 Transport 可能在 send() 内同步触发 ACK，
         * 然后再出现异常。
         *
         * 如果当前 PendingAck 已经被处理，
         * 就不能把已经完成的 Promise 再改成失败。
         */
        if (this.pendingAcks.get(command.requestId) !== pending) {
          return;
        }
        clearTimeout(timeoutId);
        this.pendingAcks.delete(command.requestId);
        reject(toError(error, 'IM Command 发送失败'));
      }
    });
  }

  /**
   * 处理服务端返回的一条 ACK。
   *
   * ACK 不参与 seqId 排序，
   * 只通过 requestId 找到对应的 PendingAck。
   */
  private handleAck(ack: AckFrame): void {
    const pending = this.pendingAcks.get(ack.requestId);

    if (!pending) {
      return;
    }
    /** ACK 已经到达，取消对应的超时定时器。 */
    clearTimeout(pending.timeoutId);

    /**
     * 先从 Map 删除，再完成 Promise。
     *
     * 防止调用方的后续逻辑重入时，
     * 仍然看到一个已经完成的 PendingAck。
     */
    this.pendingAcks.delete(ack.requestId);
    pending.resolve(ack);
  }

  /**
   * 批量结束所有仍在等待的 ACK。
   *
   * 通常在以下情况调用：
   * - WebSocket 断开；
   * - 用户主动 disconnect；
   * - IMService destroy。
   */
  private rejectAllPendingAcks(error: Error): void {
    const pendingAcks = [...this.pendingAcks.values()];
    this.pendingAcks.clear();
    for (const pendingAck of pendingAcks) {
      clearTimeout(pendingAck.timeoutId);
      pendingAck.reject(error);
    }
  }

  /**
   * 接收 Transport 事件并分流服务端 Frame。
   *
   * Transport 只会上报：
   * - WebSocket 连接状态变化；
   * - 服务端发送的原始文本消息。
   *
   * IMService 在这里把底层事件转换成应用层处理流程。
   */

  /**
   * 处理 Transport 发布的底层事件。
   *
   * 使用箭头函数而不是普通 class 方法，
   * 是为了在传给 transport.subscribe() 后仍然保留正确的 this。
   */
  private readonly handleTransportEvent = (event: IMTransportEvent): void => {
    if (event.type === 'state.changed') {
      /**
       * 保存 Transport 最新状态。
       *
       * getConnectionState() 和 sendCommand()
       * 后续都会读取这个状态。
       */
      this.connectionState = event.state;

      if (
        event.state.status === 'disconnected' ||
        event.state.status === 'failed' ||
        event.state.status === 'disabled'
      ) {
        /**
         * 立即结束所有仍然等待 ACK 的 Promise。
         *
         * reconnecting 不需要再次处理，
         * 因为进入 reconnecting 前通常已经发布过 disconnected。
         */
        this.rejectAllPendingAcks(new Error('IM WebSocket 连接已经断开'));
      }

      this.publish({
        kind: 'connection',
        state: event.state,
      });

      return;
    }
    /**
     * IMTransportEvent 只有两个分支。
     *
     * 排除 state.changed 后，
     * 当前事件一定是 message.received。
     */
    this.handleRawFrame(event.data);
  };

  /**
   * 解析服务端发送的一条完整 WebSocket 文本消息。
   *
   * 服务端可能发送：
   * - ACK；
   * - Thread 业务 Envelope。
   */
  private handleRawFrame(rawFrame: string): void {
    /**
     * ServerFrame 是 ACK 和 ServerThreadEvent 的判别联合。
     */
    let frame: ServerFrame;

    try {
      /**
       * 前后端共同维护 protocol.ts，
       * 因此这里只解析 JSON，
       * 不在运行时重复校验每个 payload 字段。
       */
      frame = JSON.parse(rawFrame) as ServerFrame;
    } catch (error) {
      /**
       * 单条非法 JSON 不应该中断整个 WebSocket 消息循环。
       *
       * 记录错误后忽略当前消息，
       * 后续合法消息仍然可以继续处理。
       */
      console.error('无法解析服务端 IM Frame', error);

      return;
    }

    /**
     * ACK 只通过 requestId 关联 Command，
     * 不属于 Thread 业务事件，也不参与 seqId 排序。
     */
    if (frame.type === 'ack') {
      this.handleAck(frame);
      return;
    }

    /**
     * 排除 ACK 后，
     * 当前 Frame 一定是拥有 threadId 和 seqId 的业务 Envelope。
     */
    this.handleThreadEvent(frame);
  }

  /**
   * 处理一条 Thread 业务 Envelope。
   *
   * 这是 seqId 状态机的入口。
   *
   * 每一条服务端业务 Envelope 都必须先经过这里，
   * 确认顺序安全后，才能发布给状态层。
   */
  private handleThreadEvent(event: ServerThreadEvent): void {
    /**
     * 每个 threadId 使用独立的 ThreadStream。
     *
     * 不同 Thread 的 seqId 不会相互比较。
     */
    const stream = this.getOrCreateThreadStream(event.threadId);

    /**
     * 第一种情况：重复事件或迟到旧事件。
     *
     * 例如当前已经发布到 seqId=10，
     * 又收到 seqId=9 或 seqId=10。
     *
     * 如果再次发布，message.delta 等事件
     * 就可能被状态层重复追加。
     */
    if (stream.lastSeqId !== null && event.seqId <= stream.lastSeqId) {
      /** 直接丢弃 */
      return;
    }

    /**
     * 第二种情况：当前 Thread 正在加载 Snapshot。
     *
     * 即使当前 Envelope 的 seqId 正好符合预期，
     * 也不能在 Snapshot 应用完成前发布。
     *
     * 否则 Snapshot 稍后覆盖 Zustand 时，
     * 可能造成实时状态重复或丢失。
     */
    if (stream.paused) {
      /** 暂停期间的所有 Evenlope 都先进入 Map */
      this.bufferThreadEvent(event.threadId, stream, event);

      return;
    }

    /**
     * 第三种情况：当前还没有这个 Thread 的本地顺序基线。
     *
     * 例如会话列表第一次观察到一个后台 Thread，
     * 第一条收到的事件可能已经是 seqId=50。
     *
     * 我们接受这条事件作为“从现在开始”的实时基线，
     * 不要求补齐之前的 1～49。
     *
     * 用户真正打开聊天详情页时，
     * 再通过 Snapshot 恢复完整历史状态。
     */
    if (stream.lastSeqId === null) {
      /**
       * 发布当前首帧，
       * 并把 lastSeqId 更新为 event.seqId。
       */
      this.publishAndAdvance(stream, event);

      return;
    }
    /**
     * 当前唯一期望的下一条事件。
     *
     * 例如 lastSeqId=10，
     * 那么 expectedSeqId 就是 11。
     */
    const expectedSeqId = stream.lastSeqId + 1;

    /**
     * 第四种情况：当前 Envelope 正好符合预期。
     *
     * 这说明从 lastSeqId 到当前事件之间没有 gap，
     * 可以立即发布给状态层。
     */
    if (event.seqId === expectedSeqId) {
      /**
       * 先发布当前 Envelope，
       * 并把 lastSeqId 推进到 event.seqId。
       */
      this.publishAndAdvance(stream, event);

      /**
       * 当前事件可能刚好填补了之前的缺口。
       *
       * 发布后立即检查 Map 中是否已经存在
       * 后续的 expectedSeqId。
       */
      this.flushThreadBuffer(event.threadId, stream);

      return;
    }

    /**
     * 第五种情况：当前 Envelope 的 seqId 大于 expectedSeqId。
     *
     * 例如：
     * lastSeqId=10
     * expectedSeqId=11
     * 实际收到 event.seqId=12
     *
     * 说明 11 还没有到达，12 不能提前发布。
     */

    /** 先把未来事件保存进对应 Thread 的 Map。 */
    this.bufferThreadEvent(event.threadId, stream, event);

    /**
     * 通知状态层当前 Thread 出现 seqId 缺口。
     *
     * 状态层收到 sequenceGap 后，
     * 会暂停 Thread 并加载权威 Snapshot。
     */
    this.reportSequenceGap(event.threadId, stream, event.seqId);
  }

  /**
   * 把暂时不能发布的 Envelope 放入 Map，
   * 并在顺序恢复后连续排空 Map。
   */

  /**
   * 把一条暂时不能发布的 Envelope
   * 保存到对应 Thread 的乱序缓冲区。
   *
   * 进入这里的常见原因：
   * - 当前事件大于 expectedSeqId；
   * - 当前 Thread 正在加载 Snapshot。
   */
  private bufferThreadEvent(
    threadId: ThreadId,
    stream: ThreadStream,
    event: ServerThreadEvent,
  ): void {
    /**
     * ThreadStream 是 IMService 内部维护的可变状态，
     * 后续直接修改调用方传入的同一个对象。
     */

    /**
     * 使用 seqId 作为 Map Key。
     *
     * 如果相同 seqId 再次到达，
     * 新值会覆盖旧值，不会重复增加内存。
     */
    stream.buffer.set(event.seqId, event);

    /**
     * 缓存数量还没有超过上限时，
     * 继续等待缺失事件或 Snapshot。
     */
    if (stream.buffer.size <= this.maxBufferedEventsPerThread) {
      return;
    }

    /**
     * 超过上限说明当前 Thread
     * 已经长时间无法恢复连续状态。
     *
     * 继续保留大量旧 delta 的价值很低，
     * 应该重新通过 Snapshot 获取完整权威状态。
     */

    /** 删除之前积累的全部乱序 Envelope。 */
    stream.buffer.clear();

    /** 保留触发溢出的当前事件，Snapshot 后仍可继续衔接实时流。 */
    stream.buffer.set(event.seqId, event);

    /**
     * 清除旧 gap 的去重记录。
     *
     * 这样状态层可以收到一次新的 sequenceGap，
     * 重新发起 Snapshot。
     */
    stream.reportedGapExpectedSeqId = null;

    /** 再次通知状态层当前 Thread 仍然存在缺口。 */
    this.reportSequenceGap(threadId, stream, event.seqId);
  }

  /**
   * 从 lastSeqId + 1 开始，
   * 连续发布 Map 中已经到达的 Envelope。
   *
   * 这个方法不会对整个 Map 排序，
   * 每次只查找唯一允许发布的下一条事件。
   */
  private flushThreadBuffer(threadId: ThreadId, stream: ThreadStream): void {
    /**
     * 参数 stream 已经持有进入函数时的 ThreadStream 引用。
     *
     * 后续可以用引用相等判断：
     * 当前 Stream 是否已经因为 disconnect 等操作失效。
     */

    /**
     * 以下情况不能继续排空：
     *
     * 1. 状态层又暂停了当前 Thread；
     * 2. threadStreams 中已经不是原来的 Stream；
     * 3. lastSeqId 仍然是 null，没有明确的下一条期望值。
     */
    if (!this.canContinueFlushing(threadId, stream) || stream.lastSeqId === null) {
      return;
    }

    /**
     * 查找唯一可以安全发布的下一条事件。
     *
     * 例如 lastSeqId=10，
     * 就只查找 buffer.get(11)。
     */
    let nextEvent = stream.buffer.get(stream.lastSeqId + 1);

    while (nextEvent) {
      /**
       * 发布前先从 Map 删除。
       *
       * 如果订阅者回调发生重入，
       * 就不会再次找到并发布同一个 Envelope。
       */
      stream.buffer.delete(nextEvent.seqId);

      /**
       * 发布当前 Envelope，
       * 并把 lastSeqId 推进到它的 seqId。
       */
      this.publishAndAdvance(stream, nextEvent);

      /**
       * 订阅者可能在 publish() 回调中：
       * - 调用 pauseThread()；
       * - 调用 disconnect()；
       * - 销毁或替换当前 Stream。
       *
       * 因此每发布一条后，
       * 都必须重新检查排空流程是否仍然有效。
       */

      if (!this.canContinueFlushing(threadId, stream)) {
        return;
      }

      nextEvent = stream.buffer.get(stream.lastSeqId + 1);
    }

    /**
     * 找不到下一条事件后，
     * 还要判断 Map 是否已经完全排空。
     */
    if (stream.buffer.size === 0) {
      /**
       * Map 为空说明目前已知事件已经全部连续发布
       *
       * 清除 gap 去重记录
       * 以后出现新缺口时可以重新通知状态层
       */
      stream.reportedGapExpectedSeqId = null;
      return;
    }

    /**
     * Map 仍然存在事件，
     * 但没有 lastSeqId + 1，
     * 说明排空后又遇到了新的缺口。
     *
     * 例如：
     * lastSeqId=13
     * buffer={15, 16}
     * 当前缺少 14。
     */
    /**
     * 查找 Map 中最小的 seqId。
     *
     * Map 保留的是插入顺序，不是数字大小顺序，
     * 因此不能直接取第一个 Key。
     */
    let firstBufferedSeqId: SeqId | null = null;

    for (const seqId of stream.buffer.keys()) {
      if (firstBufferedSeqId === null || seqId < firstBufferedSeqId) {
        firstBufferedSeqId = seqId;
      }
    }

    if (firstBufferedSeqId !== null) {
      this.reportSequenceGap(threadId, stream, firstBufferedSeqId);
    }
  }

  /**
   * 判断当前排空循环是否仍然可以继续
   */
  private canContinueFlushing(threadId: ThreadId, stream: ThreadStream): boolean {
    /**
     * paused=false：
     * 当前 Thread 没有重新进入 Snapshot 同步。
     *
     * 引用相等：
     * threadStreams 中保存的仍然是进入循环时的原 Stream。
     *
     * disconnect() 会清空 threadStreams，
     * 因此旧循环会立刻失效。
     */
    return !stream.paused && this.threadStreams.get(threadId) === stream;
  }

  /**
   * 在加载 Snapshot 期间暂停和恢复一个 Thread。
   *
   * 正确调用顺序是：
   *
   * 1. pauseThread(threadId)
   * 2. 请求服务端 Snapshot
   * 3. 把 Snapshot 应用到 Zustand
   * 4. resumeThread(threadId, snapshot.lastSeqId)
   *
   * 暂停不会关闭 WebSocket，
   * 只会让当前 Thread 后续到达的 Envelope 进入 buffer。
   */

  /**
   * 暂停发布指定 Thread 的实时 Envelope。
   *
   * 通常在以下情况调用：
   * - 第一次打开 Thread 并加载 Snapshot；
   * - 发现 sequenceGap；
   * - WebSocket 重连后重新同步活跃 Thread。
   */
  pauseThread(threadId: ThreadId): void {
    this.assertUsable();

    const stream = this.getOrCreateThreadStream(threadId);

    stream.paused = true;
  }

  /**
   * Snapshot 已经应用完成后，
   * 恢复指定 Thread 的实时 Envelope 发布。
   *
   * lastSeqId 必须是这个 Snapshot 已经完整包含到的事件位置。
   */
  resumeThread(threadId: ThreadId, lastSeqId: SeqId): void {
    this.assertUsable();

    /**
     * 正常情况下会取得 pauseThread() 使用的原 Stream。
     *
     * 如果 disconnect() 已经清空过 threadStreams，
     * 这里会创建新 Stream。
     *
     * 因此状态层还需要忽略断线前发起、
     * 却在断线后才返回的旧 Snapshot。
     */
    const stream = this.getOrCreateThreadStream(threadId);

    if (stream.lastSeqId !== null && lastSeqId < stream.lastSeqId) {
      throw new Error('snapshot.lastSeqId 不能小于当前 Thread 的 lastSeqId');
    }

    stream.lastSeqId = lastSeqId;

    stream.paused = false;

    stream.reportedGapExpectedSeqId = null;

    /**
     * 删除已经被 Snapshot 包含的缓存事件。
     *
     * 如果 Snapshot.lastSeqId=20，
     * 那么 buffer 中 seqId<=20 的 Envelope
     * 都不能再次应用，否则会重复追加 delta。
     */
    for (const seqId of stream.buffer.keys()) {
      if (seqId <= lastSeqId) {
        stream.buffer.delete(seqId);
      }
    }

    this.flushThreadBuffer(threadId, stream);
  }

  /**
   * 发布一条已经确认顺序安全的 Envelope，并推进 lastSeqId。
   * 必须先推进游标再同步 publish，避免 Listener 重入时看到旧基线。
   */
  private publishAndAdvance(stream: ThreadStream, event: ServerThreadEvent): void {
    // ThreadStream 本来就是 IMService 内部维护的可变状态，直接更新其属性以推进游标。
    stream.lastSeqId = event.seqId;

    this.publish({
      kind: 'envelope',
      envelope: event,
    });
  }

  /**
   * 报告当前 Thread 缺少的 expectedSeqId。
   * 相同 expectedSeqId 只报告一次，避免连续未来事件重复触发 Snapshot。
   */
  private reportSequenceGap(threadId: ThreadId, stream: ThreadStream, receivedSeqId: SeqId): void {
    // gap 标记属于这条 thread 流的内部状态，后续补齐或重置基线时会被清空。
    const expectedSeqId = (stream.lastSeqId ?? 0) + 1;

    if (stream.reportedGapExpectedSeqId === expectedSeqId) {
      return;
    }

    stream.reportedGapExpectedSeqId = expectedSeqId;

    this.publish({
      kind: 'sequenceGap',
      gap: {
        threadId,
        expectedSeqId,
        receivedSeqId,
      },
    });
  }

  /** 获取 Thread 的顺序状态；第一次观察到该 Thread 时按需创建。 */
  private getOrCreateThreadStream(threadId: ThreadId): ThreadStream {
    const existing = this.threadStreams.get(threadId);

    if (existing) {
      return existing;
    }

    const created: ThreadStream = {
      lastSeqId: null,
      paused: false,
      reportedGapExpectedSeqId: null,
      buffer: new Map<SeqId, ServerThreadEvent>(),
    };

    this.threadStreams.set(threadId, created);
    return created;
  }

  /**
   * 通过唯一事件通道同步通知状态层。
   * 复制 Set 后遍历，允许 Listener 在回调中安全取消订阅。
   */
  private publish(event: IMServiceEvent): void {
    const listeners = [...this.listeners];

    for (const listener of listeners) {
      /**
       * 隔离单个 Listener 异常，避免它关闭 WebSocket 或阻断其他订阅者。
       */
      try {
        listener(event);
      } catch (error) {
        console.error('IM service listener failed.', error);
      }
    }
  }

  /**
   * 确认当前 IMService 仍然可以使用。
   *
   * disconnect 是临时操作，之后仍可以重新 connect；
   * destroy 是永久操作，之后不能再调用业务能力。
   */
  private assertUsable(): void {
    if (this.destroyed) {
      throw new Error('IMService 已销毁');
    }
  }
}

export type IMServicePublicApi = IMService;
