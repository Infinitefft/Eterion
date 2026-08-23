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
 * 这个模块只有两条主流程：
 *
 * 上行：页面调用业务方法 -> 组装 Command -> Transport 发送 -> requestId 匹配 ACK。
 * 下行：Transport 收到 Frame -> threadId 路由 -> seqId 排序 -> 广播给订阅者。
 *
 * 它不会组装聊天页面状态。Message、Run、Thinking、Tool 和 HITL 的具体状态
 * 会在后续状态层中，根据这里发布的有序事件进行更新。
 */

/** 创建 Thread 并发送首条用户消息所需的数据。 */
export interface StartThreadInput {
  /** 用户发送的第一条消息正文。 */
  content: string;

  /** 不传时由后端选择默认模型。 */
  modelId?: ModelId;

  /** 调用方需要重发同一个业务意图时，可以复用原 ThreadId。 */
  threadId?: ThreadId;

  /** 调用方需要重发同一条消息时，可以复用原 MessageId。 */
  messageId?: MessageId;
}

/** 向已有 Thread 发送用户消息所需的数据。 */
export interface SendMessageInput {
  /** 这条消息属于哪个 Thread。 */
  threadId: ThreadId;

  /** 用户输入的正文。 */
  content: string;

  /** 不传时由后端选择默认模型。 */
  modelId?: ModelId;

  /** 重发同一条业务消息时复用它，因此不再额外设计 idempotencyKey。 */
  messageId?: MessageId;
}

/** 取消正在执行的 Run 所需的数据。 */
export interface CancelRunInput {
  /** Run 所属的 Thread，也是服务端路由取消请求的依据。 */
  threadId: ThreadId;

  /** 要取消的 Agent 执行。 */
  runId: RunId;
}

/** 回答 HITL 交互所需的数据。 */
export interface RespondToInteractionInput {
  /** HITL 所属的 Thread。 */
  threadId: ThreadId;

  /** 当前等待用户输入的 Run。 */
  runId: RunId;

  /** 这次回答针对哪一个 HITL 请求。 */
  interactionId: InteractionId;

  /** 用户对本次 HITL 全部问题的回答。 */
  answers: HITLAnswer[];
}

/**
 * Command 会立刻返回，页面可以马上取得其中的业务 ID；
 * ack Promise 表示本次发送结果：收到 ACK 时 resolve，
 * 未连接、发送失败、超时、断线或销毁时 reject。
 */
export interface IMCommandDispatch<TCommand extends ClientCommand> {
  /** 已经生成 ID 的完整 Command，状态层可以立即用它做乐观更新。 */
  command: Readonly<TCommand>;

  /** 服务端是否接受 Command 的异步结果，不代表 Agent 已经执行完成。 */
  ack: Promise<AckFrame>;
}

/** seqId 不连续时通知状态层重新加载对应 Thread snapshot。 */
export interface ThreadSequenceGap {
  /** 哪个 Thread 出现了序号缺口。 */
  threadId: ThreadId;

  /** 按当前游标，下一条本应收到的 seqId。 */
  expectedSeqId: SeqId;

  /** 实际提前到达并触发本次 gap 的 seqId。 */
  receivedSeqId: SeqId;
}

/**
 * IMService 对状态层发布的统一事件。
 *
 * kind 使用内部名称而不是服务端 Envelope.type，避免把连接状态和 gap
 * 误认为 Thread 业务事件。状态层只需订阅一次，再通过 kind 进行分流。
 */
export type IMServiceEvent =
  | {
      /** 已经通过 seqId 检查、可以安全应用的服务端业务事件。 */
      kind: 'envelope';
      envelope: ServerThreadEvent;
    }
  | {
      /** Transport 最新的完整连接状态。 */
      kind: 'connection';
      state: Readonly<IMConnectionState>;
    }
  | {
      /** 某个 Thread 出现 seqId 缺口，需要状态层加载 snapshot。 */
      kind: 'sequenceGap';
      gap: ThreadSequenceGap;
    };

/** 全局状态层通常只注册一个这样的监听器。 */
export type IMServiceListener = (event: IMServiceEvent) => void;

/** 取消一次订阅的函数。 */
export type IMServiceUnsubscribe = () => void;

export interface IMServiceDependencies {
  /** IMService 只依赖底层通信，不直接依赖 React 或 Zustand。 */
  transport: IMTransport;
}

export interface IMServiceOptions {
  /** Command 发出后等待 ACK 的最长时间。 */
  commandAckTimeoutMs?: number;

  /** 单个 Thread 最多暂存多少条尚不能发布的事件。 */
  maxBufferedEventsPerThread?: number;
}

/** 一条已经登记、即将发送或已经发送，但还没有收到 ACK 的请求。 */
interface PendingAck {
  /** 收到 ACK 时完成调用方拿到的 Promise。 */
  resolve: (ack: AckFrame) => void;

  /** 发送失败、断线或超时时让 Promise 失败。 */
  reject: (error: Error) => void;

  /** ACK 完成后必须清理，避免定时器和闭包长期驻留。 */
  timeoutId: ReturnType<typeof setTimeout>;
}

/** 每个 Thread 都有自己的顺序基线和临时乱序缓冲区。 */
interface ThreadStream {
  /** 已经发布给订阅者的最大 seqId；null 表示还没有建立本地基线。 */
  lastSeqId: SeqId | null;

  /** true 时说明状态层正在同步 snapshot，新事件只能进入 buffer。 */
  paused: boolean;

  /** 记住已经报告过的缺口，避免同一个 gap 反复触发 snapshot。 */
  reportedGapExpectedSeqId: SeqId | null;

  /** Key 是 seqId，因此可以 O(1) 判断下一条连续事件是否已经到达。 */
  buffer: Map<SeqId, ServerThreadEvent>;
}

/** 正常情况下 ACK 应该很快返回，15 秒只用于兜底释放 Promise。 */
const DEFAULT_ACK_TIMEOUT_MS = 15_000;

/** 防止断线或长期 gap 让某个 Thread 的内存无限增长。 */
const DEFAULT_MAX_BUFFERED_EVENTS = 500;

/** 所有客户端生成的业务 ID 和 requestId 都使用 UUID。 */
function createId(): string {
  return crypto.randomUUID();
}

/** catch 得到的不一定是 Error，把它收敛成调用方容易处理的 Error。 */
function toError(error: unknown, fallbackMessage: string): Error {
  return error instanceof Error ? error : new Error(fallbackMessage);
}

/**
 * 全局 IM 应用层服务。
 *
 * Transport 负责 WebSocket；IMService 只负责 Command/ACK、Thread 路由和 seqId 顺序。
 * Message、Run、Thinking、Tool、HITL 与未读状态由后续状态层组装。
 */
export class IMService {
  /** 只负责建立 WebSocket、重连以及发送/接收原始字符串。 */
  private readonly transport: IMTransport;

  /** 每一条 PendingAck 使用相同的超时时间。 */
  private readonly commandAckTimeoutMs: number;

  /** 每个 Thread 的 buffer 都独立受这个上限约束。 */
  private readonly maxBufferedEventsPerThread: number;

  /** requestId 只用于找到正在等待的 ACK。 */
  private readonly pendingAcks = new Map<RequestId, PendingAck>();

  /** seqId 只在同一个 ThreadStream 内比较。 */
  private readonly threadStreams = new Map<ThreadId, ThreadStream>();

  /**
   * IMService 唯一的发布通道。
   * 状态层在这里订阅一次，页面再通过 Zustand selector 按 threadId 取数据。
   */
  private readonly listeners = new Set<IMServiceListener>();

  /** destroy() 时用它解除构造函数建立的唯一 Transport 订阅。 */
  private readonly unsubscribeTransport: IMTransportUnsubscribe;

  /** 缓存 Transport 最新状态，让发送 Command 时可以同步判断能否发送。 */
  private connectionState: Readonly<IMConnectionState>;

  /** 防止销毁后的实例被继续连接、发送或订阅。 */
  private destroyed = false;

  constructor(dependencies: IMServiceDependencies, options: IMServiceOptions = {}) {
    /** 保存全局唯一的底层连接实例。 */
    this.transport = dependencies.transport;

    /** 调用方没有配置时使用 15 秒 ACK 超时。 */
    this.commandAckTimeoutMs = options.commandAckTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;

    /** 调用方没有配置时，每个 Thread 最多缓存 500 条事件。 */
    this.maxBufferedEventsPerThread =
      options.maxBufferedEventsPerThread ?? DEFAULT_MAX_BUFFERED_EVENTS;

    /** 构造时读取一次当前状态，之后由 state.changed 持续覆盖。 */
    this.connectionState = this.transport.getState();

    /** 全生命周期只订阅一次 Transport，避免重复处理同一个服务端 Frame。 */
    this.unsubscribeTransport = this.transport.subscribe(this.handleTransportEvent);
  }

  connect(): Promise<void> {
    /** 已销毁的 Service 不能重新启动连接。 */
    this.assertUsable();

    /** Transport 自己处理并发 connect() 复用和断线重连。 */
    return this.transport.connect();
  }

  disconnect(): void {
    this.assertUsable();

    /** 主动断开表示当前用户离开，旧 ACK 和 seqId 基线都不再复用。 */
    this.rejectAllPendingAcks(new Error('IM WebSocket 已主动断开'));

    /** 下次连接后必须重新通过实时首帧或 snapshot 建立顺序基线。 */
    this.threadStreams.clear();

    /** 真正关闭浏览器 WebSocket，并停止 Transport 的自动重连。 */
    this.transport.disconnect();
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }

    /** 先置为 true，避免清理期间出现重入调用。 */
    this.destroyed = true;

    /** 不再接收 Transport 的状态变化和原始服务端 Frame。 */
    this.unsubscribeTransport();

    /** 销毁是永久生命周期结束，因此同时关闭底层连接。 */
    this.transport.disconnect();

    /** 让所有仍在 await ACK 的页面立即结束等待。 */
    this.rejectAllPendingAcks(new Error('IMService 已销毁'));

    /** 释放顺序状态和统一订阅者引用。 */
    this.threadStreams.clear();
    this.listeners.clear();
  }

  getConnectionState(): Readonly<IMConnectionState> {
    /** 返回最近一次 Transport 发布的完整状态快照。 */
    return this.connectionState;
  }

  subscribe(listener: IMServiceListener): IMServiceUnsubscribe {
    this.assertUsable();

    /**
     * 这里只登记一次统一监听器；页面、会话列表和详情页不再分别进入 IMService。
     * Set 天然避免同一个函数引用被重复登记。
     */
    this.listeners.add(listener);

    /** 删除这个函数引用；不同调用方应各自传入自己的 listener。 */
    return () => {
      this.listeners.delete(listener);
    };
  }

  startThread(input: StartThreadInput): IMCommandDispatch<ThreadStartCommand> {
    /**
     * Thread 和首条 Message 的 ID 在发送前就确定：
     * 状态层可以立即创建乐观数据，后端也使用这两个 ID 识别同一业务对象。
     */
    const command: ThreadStartCommand = {
      /** 服务端通过 type 选择 thread.start 处理器。 */
      type: 'thread.start',

      /** 每一次网络请求都有新的 requestId，它只关联这一次 ACK。 */
      requestId: createId(),

      /** 首次发送时生成；明确重发同一 Thread 时复用调用方传入的值。 */
      threadId: input.threadId ?? createId(),

      /** MessageId 同时承担这条用户消息的稳定业务身份。 */
      messageId: input.messageId ?? createId(),

      /** undefined 字段不放进 wire payload，让“未指定模型”的语义清楚。 */
      payload:
        input.modelId === undefined
          ? { content: input.content }
          : { content: input.content, modelId: input.modelId },
    };

    /** 同步返回完整 Command，同时开始异步等待 ACK。 */
    return this.dispatchCommand(command);
  }

  sendMessage(input: SendMessageInput): IMCommandDispatch<MessageSendCommand> {
    const command: MessageSendCommand = {
      /** 这是向已有 Thread 追加用户消息，而不是创建 Thread。 */
      type: 'message.send',

      /** requestId 只标识本次发送动作，不等同于 messageId。 */
      requestId: createId(),

      /** 已有会话必须由调用方明确提供目标 Thread。 */
      threadId: input.threadId,

      /** 正常发送生成新 ID；业务重发时可以复用原 ID。 */
      messageId: input.messageId ?? createId(),

      /** 仅在明确选择模型时携带 modelId。 */
      payload:
        input.modelId === undefined
          ? { content: input.content }
          : { content: input.content, modelId: input.modelId },
    };

    /** 发送流程与其他 Command 共用 dispatchCommand。 */
    return this.dispatchCommand(command);
  }

  cancelRun(input: CancelRunInput): IMCommandDispatch<RunCancelCommand> {
    const command: RunCancelCommand = {
      /** 取消只是请求，最终 Run 状态仍以后续 run.status 事件为准。 */
      type: 'run.cancel',

      /** 用于匹配这次取消请求的 ACK。 */
      requestId: createId(),

      /** 服务端用 threadId 将取消操作放到正确的会话中。 */
      threadId: input.threadId,

      /** 精确指出要停止的 Agent Run。 */
      runId: input.runId,
    };

    return this.dispatchCommand(command);
  }

  respondToInteraction(
    input: RespondToInteractionInput,
  ): IMCommandDispatch<InteractionRespondCommand> {
    const command: InteractionRespondCommand = {
      /** 服务端通过该类型进入 HITL 回答处理器。 */
      type: 'interaction.respond',

      /** ACK 仍然只使用独立的 requestId 关联。 */
      requestId: createId(),

      /** 三个定位 ID 分别确定会话、执行和具体交互。 */
      threadId: input.threadId,
      runId: input.runId,
      interactionId: input.interactionId,

      /** 真正的回答数据放在 payload，定位 ID 保持在 envelope 顶层。 */
      payload: { answers: input.answers },
    };

    return this.dispatchCommand(command);
  }

  pauseThread(threadId: ThreadId): void {
    this.assertUsable();

    /**
     * snapshot 请求发出前先暂停：暂停不关闭 WebSocket，
     * 只是让这个 Thread 后续到达的实时事件暂时写入 buffer。
     */
    this.getOrCreateThreadStream(threadId).paused = true;
  }

  resumeThread(threadId: ThreadId, lastSeqId: SeqId): void {
    this.assertUsable();

    /**
     * 正常恢复会取得 pause 时的原 Stream；如果它已被 disconnect 清除则会新建。
     * 因此状态层还要忽略断线前发起、却在断线后才返回的旧 snapshot。
     */
    const stream = this.getOrCreateThreadStream(threadId);

    /**
     * 较旧的 snapshot 不能覆盖较新的实时基线。
     * 例如当前已经处理到 200，迟到的 snapshot.lastSeqId=100 必须拒绝。
     */
    if (stream.lastSeqId !== null && lastSeqId < stream.lastSeqId) {
      throw new Error('snapshot.lastSeqId 不能小于当前 Thread 的 lastSeqId');
    }

    /** snapshot 是当前权威状态，所以从它的 lastSeqId 重新确定实时游标。 */
    stream.lastSeqId = lastSeqId;

    /** 状态层已经应用 snapshot，允许继续发布该 Thread 的实时事件。 */
    stream.paused = false;

    /** 新基线可能已经填上旧缺口，因此允许后面报告新的 expectedSeqId。 */
    stream.reportedGapExpectedSeqId = null;

    /** 遍历暂停期间积累的全部 seqId。 */
    for (const seqId of stream.buffer.keys()) {
      /** snapshot 已覆盖的事件再次应用会重复追加 delta，必须删除。 */
      if (seqId <= lastSeqId) {
        stream.buffer.delete(seqId);
      }
    }

    /** 从 lastSeqId + 1 开始，把剩余连续事件按顺序广播出去。 */
    this.flushThreadBuffer(threadId, stream);
  }

  private dispatchCommand<TCommand extends ClientCommand>(
    command: TCommand,
  ): IMCommandDispatch<TCommand> {
    /**
     * 不在这里 await ACK：
     * 调用方需要先拿到 command.threadId/messageId 做乐观更新，
     * 再根据 ack Promise 展示服务端接受或拒绝结果。
     */
    return {
      /** 原样返回刚刚生成的完整业务命令。 */
      command,

      /** sendCommand 会立刻尝试发送，并返回表示本次发送结果的 Promise。 */
      ack: this.sendCommand(command),
    };
  }

  private sendCommand(command: ClientCommand): Promise<AckFrame> {
    /** 销毁后的全局实例不允许继续创建 ACK 定时器。 */
    this.assertUsable();

    /** 本方案不设计离线队列：未连接时由页面明确决定是否稍后再发。 */
    if (this.connectionState.status !== 'connected') {
      return Promise.reject(new Error('IM WebSocket 尚未连接'));
    }

    /** 序列化放在建立 PendingAck 之前，失败时不需要额外清理 Map。 */
    let serializedCommand: string;

    try {
      /** Transport 只认识字符串，不认识 ClientCommand。 */
      serializedCommand = JSON.stringify(command);
    } catch (error) {
      /** JSON.stringify 失败表示当前 Command 根本没有交给 WebSocket。 */
      return Promise.reject(toError(error, 'IM Command 序列化失败'));
    }

    /** 理论上 UUID 不会重复，这个判断防止覆盖另一个仍在等待的 Promise。 */
    if (this.pendingAcks.has(command.requestId)) {
      return Promise.reject(new Error(`重复的 requestId：${command.requestId}`));
    }

    /** 新 Thread 的服务端业务事件从 seqId 1 开始。 */
    if (command.type === 'thread.start') {
      /** 发送前就创建 Stream，才能判断服务端第一条事件是否真的是 seqId 1。 */
      const stream = this.getOrCreateThreadStream(command.threadId);

      if (stream.lastSeqId === null) {
        /** 0 表示当前尚未发布业务事件，下一条期望值是 1。 */
        stream.lastSeqId = 0;
      }
    }

    /**
     * Promise 等待与 command.requestId 相同的 ACK；
     * 发送失败、超时或断线等明确失败路径也会结束它。
     */
    return new Promise<AckFrame>((resolve, reject) => {
      /** 即使服务端永远不返回 ACK，也要在固定时间后释放 PendingAck。 */
      const timeoutId = setTimeout(() => {
        /** 定时器触发时重新查 Map，因为 ACK 可能已经先一步完成。 */
        const pending = this.pendingAcks.get(command.requestId);

        if (!pending) {
          /** 找不到说明 ACK、断线或发送失败路径已经完成清理。 */
          return;
        }

        /** 先从 Map 删除，迟到 ACK 到达时便会被安全忽略。 */
        this.pendingAcks.delete(command.requestId);

        /** 拒绝调用方正在等待的 ack Promise。 */
        pending.reject(new Error('等待服务端 ACK 超时'));
      }, this.commandAckTimeoutMs);

      /** 保存 Promise 控制函数和对应定时器，等待 handleAck 使用。 */
      const pending: PendingAck = {
        resolve,
        reject,
        timeoutId,
      };

      /** 先登记再发送，保证同步测试 ACK 也能找到对应 Promise。 */
      this.pendingAcks.set(command.requestId, pending);

      try {
        /** 到这里才真正把已经序列化的 Command 交给 WebSocket。 */
        this.transport.send(serializedCommand);
      } catch (error) {
        /**
         * 测试 Transport 可能在 send() 内同步模拟 ACK；
         * 如果 pending 已被处理，就不能再把已经成功的 Promise 改成失败。
         */
        if (this.pendingAcks.get(command.requestId) !== pending) {
          return;
        }

        /** 明确发送失败，不再需要等待 ACK 超时。 */
        clearTimeout(timeoutId);

        /** 删除本次 requestId，避免内存残留。 */
        this.pendingAcks.delete(command.requestId);

        /** 告诉调用方 Command 没有成功交给当前连接。 */
        reject(toError(error, 'IM Command 发送失败'));
      }
    });
  }

  private readonly handleTransportEvent = (event: IMTransportEvent): void => {
    /** Transport 只会上报连接状态变化和原始文本帧两类事件。 */
    if (event.type === 'state.changed') {
      /** 缓存完整状态，让 getConnectionState() 和 sendCommand() 同步读取。 */
      this.connectionState = event.state;

      /**
       * 这些状态表示旧 Socket 已经不能再返回 ACK。
       * connecting/reconnecting 不在这里重复拒绝，因为断开时已经清理过一次。
       */
      if (
        event.state.status === 'disconnected' ||
        event.state.status === 'failed' ||
        event.state.status === 'disabled'
      ) {
        this.rejectAllPendingAcks(new Error('IM WebSocket 连接已断开'));
      }

      /** 通过统一通道发布，并用 kind=connection 与业务 Envelope 区分。 */
      this.publish({
        kind: 'connection',
        state: event.state,
      });
      return;
    }

    /** 非 state.changed 的唯一情况就是 message.received。 */
    this.handleRawFrame(event.data);
  };

  private handleRawFrame(rawFrame: string): void {
    /** ServerFrame 是 ACK 与全部 ThreadEvent 的判别联合。 */
    let frame: ServerFrame;

    try {
      /** 前后端共享协议约定，这里只解析 JSON，不重复校验每个 payload 字段。 */
      frame = JSON.parse(rawFrame) as ServerFrame;
    } catch (error) {
      /** 单条非法 JSON 不应该让全局 WebSocket 监听器停止工作。 */
      console.error('无法解析服务端 IM Frame。', error);
      return;
    }

    /** ACK 不属于 Thread 事件，也不参与 seqId 排序。 */
    if (frame.type === 'ack') {
      this.handleAck(frame);
      return;
    }

    /** 其余 Frame 都拥有 threadId 和 seqId，进入统一的 Thread 顺序处理。 */
    this.handleThreadEvent(frame);
  }

  private handleAck(ack: AckFrame): void {
    /** requestId 是 Command 与 ACK 之间唯一需要使用的关联键。 */
    const pending = this.pendingAcks.get(ack.requestId);

    if (!pending) {
      /** ACK 可能已经超时或来自旧连接，找不到等待者时直接忽略。 */
      return;
    }

    /** ACK 已经到达，取消对应超时任务。 */
    clearTimeout(pending.timeoutId);

    /** 先删除再 resolve，防止调用方回调重入时仍看到旧 PendingAck。 */
    this.pendingAcks.delete(ack.requestId);

    /** ok=true 和 ok=false 都属于一个有效 ACK，由调用方根据 ok 判断结果。 */
    pending.resolve(ack);
  }

  private handleThreadEvent(event: ServerThreadEvent): void {
    /** 每个 threadId 都使用独立 Stream，所以不同会话的 seqId 不会相互影响。 */
    const stream = this.getOrCreateThreadStream(event.threadId);

    /**
     * 例如已经发布到 10，又收到 9 或 10：
     * 它们是迟到或重复事件，再次发布会让 content delta 被追加两遍。
     */
    if (stream.lastSeqId !== null && event.seqId <= stream.lastSeqId) {
      return;
    }

    /**
     * 状态层正在加载 snapshot 时，即使事件恰好连续也不能发布；
     * 否则 snapshot 稍后覆盖状态，会造成实时更新丢失或重复。
     */
    if (stream.paused) {
      this.bufferThreadEvent(event.threadId, stream, event);
      return;
    }

    /**
     * null 只表示当前没有本地顺序基线。
     * 在没有 pause 的情况下，我们接受首帧作为“从现在开始”的实时基线，
     * 不补发它之前的历史事件；打开聊天详情时再由 snapshot 恢复历史状态。
     */
    if (stream.lastSeqId === null) {
      this.publishAndAdvance(stream, event);
      return;
    }

    /**
     * 例如 lastSeqId=10，收到 11：顺序连续，可以立即广播；
     * 广播后再检查 buffer 中是否已经提前存有 12、13 等事件。
     */
    if (event.seqId === stream.lastSeqId + 1) {
      this.publishAndAdvance(stream, event);
      this.flushThreadBuffer(event.threadId, stream);
      return;
    }

    /**
     * 剩下的情况只能是未来事件：例如 lastSeqId=10，却先收到 12。
     * 12 不能先发布，否则所有订阅者都会在缺少 11 的状态上继续计算。
     */
    this.bufferThreadEvent(event.threadId, stream, event);

    /** 通知状态层“期望 11、实际收到 12”，由状态层请求权威 snapshot。 */
    this.reportSequenceGap(event.threadId, stream, event.seqId);
  }

  private bufferThreadEvent(
    threadId: ThreadId,
    stream: ThreadStream,
    event: ServerThreadEvent,
  ): void {
    /** 使用局部别名强调后续始终修改调用方传入的同一个 Stream 对象。 */
    const current = stream;

    /**
     * seqId 作为 Map Key：
     * - 相同事件再次到达会覆盖旧值，不会增加内存；
     * - flush 时可以直接查找 lastSeqId + 1，不需要遍历数组。
     */
    current.buffer.set(event.seqId, event);

    /** 还没有达到单 Thread 上限时，只需继续等待缺失事件或 snapshot。 */
    if (current.buffer.size <= this.maxBufferedEventsPerThread) {
      return;
    }

    /**
     * 超过上限说明客户端长期没有恢复连续状态。
     * 此时保留数百条旧 delta 的价值很低，权威 snapshot 才是恢复依据。
     */
    current.buffer.clear();

    /** 保留触发溢出的最新事件，snapshot 之后仍有机会继续实时衔接。 */
    current.buffer.set(event.seqId, event);

    /** 清除旧 gap 去重记录，确保状态层能收到一次新的恢复信号。 */
    current.reportedGapExpectedSeqId = null;

    /** 再次报告当前缺口，促使状态层重新加载 snapshot。 */
    this.reportSequenceGap(threadId, current, event.seqId);
  }

  private flushThreadBuffer(threadId: ThreadId, stream: ThreadStream): void {
    /** 排空过程必须始终操作进入函数时的这个 Stream。 */
    const current = stream;

    /**
     * 两种情况不能排空：
     * - 状态层又 pause 了这个 Thread，或 disconnect 已替换/清空 Stream；
     * - 还没有 lastSeqId，不知道应该从哪个序号开始。
     */
    if (!this.canContinueFlushing(threadId, current) || current.lastSeqId === null) {
      return;
    }

    /** Map 允许直接 O(1) 查询唯一可以安全发布的下一条事件。 */
    let nextEvent = current.buffer.get(current.lastSeqId + 1);

    /** 只要“下一条”存在，就持续按照 11、12、13 的顺序排空。 */
    while (nextEvent) {
      /** 发布前先从 buffer 删除，避免回调重入时再次找到同一事件。 */
      current.buffer.delete(nextEvent.seqId);

      /** 推进 lastSeqId，并通过唯一事件通道交给状态层。 */
      this.publishAndAdvance(current, nextEvent);

      /** 订阅者可以在回调中重新 pause 或 disconnect，旧排空循环必须及时停止。 */
      if (!this.canContinueFlushing(threadId, current)) {
        return;
      }

      /** lastSeqId 已在 publishAndAdvance 中推进，继续寻找新的下一条。 */
      nextEvent = current.buffer.get(current.lastSeqId + 1);
    }

    /** buffer 已经全部连续发布完成，当前不再存在已知缺口。 */
    if (current.buffer.size === 0) {
      /** 以后出现新的 expectedSeqId 时允许重新发送 gap 通知。 */
      current.reportedGapExpectedSeqId = null;
      return;
    }

    /**
     * buffer 还有事件但找不到 lastSeqId + 1，说明排空后出现了下一个缺口。
     * 例如原来缺 11，恢复并发布到 13 后，buffer 中只剩 15，此时又缺 14。
     */
    const firstBufferedSeqId = this.findFirstBufferedSeqId(current);

    if (firstBufferedSeqId !== null) {
      /** 用 buffer 中最早的未来事件描述这次新的 gap。 */
      this.reportSequenceGap(threadId, current, firstBufferedSeqId);
    }
  }

  private canContinueFlushing(threadId: ThreadId, stream: ThreadStream): boolean {
    /**
     * paused 检查 snapshot 是否重新开始；引用相等检查 Map 中是否仍是原 Stream。
     * disconnect() 会 clear threadStreams，因此旧排空循环会立即失效。
     */
    return !stream.paused && this.threadStreams.get(threadId) === stream;
  }

  private publishAndAdvance(stream: ThreadStream, event: ServerThreadEvent): void {
    /** 使用同一个对象引用保存游标，不创建额外的顺序状态副本。 */
    const current = stream;

    /**
     * 必须先推进游标再调用订阅者：
     * 如果订阅者回调中发生重入，新事件会看到正确的最新 lastSeqId。
     */
    current.lastSeqId = event.seqId;

    /** 只有顺序游标确认接收后，Envelope 才能离开 IMService。 */
    this.publish({
      kind: 'envelope',
      envelope: event,
    });
  }

  private reportSequenceGap(threadId: ThreadId, stream: ThreadStream, receivedSeqId: SeqId): void {
    /** 保持与其他顺序函数相同的 Stream 引用。 */
    const current = stream;

    /** 例如已经发布到 10，下一条唯一合法的事件就是 11。 */
    const expectedSeqId = (current.lastSeqId ?? 0) + 1;

    /**
     * 同一个缺口期间可能连续收到 12、13、14；
     * expectedSeqId 都是 11，没有必要重复触发三次 snapshot。
     */
    if (current.reportedGapExpectedSeqId === expectedSeqId) {
      return;
    }

    /** 先登记再通知，避免 gap 监听器同步重入后重复报告。 */
    current.reportedGapExpectedSeqId = expectedSeqId;

    /** 生成一个不包含业务 payload 的轻量恢复通知。 */
    const gap: ThreadSequenceGap = {
      threadId,
      expectedSeqId,
      receivedSeqId,
    };

    /** gap 也走统一通道，状态层根据 kind=sequenceGap 启动 snapshot 恢复。 */
    this.publish({
      kind: 'sequenceGap',
      gap,
    });
  }

  private getOrCreateThreadStream(threadId: ThreadId): ThreadStream {
    /** 大部分事件都会命中已有 Stream，先走最常见的读取路径。 */
    const existing = this.threadStreams.get(threadId);

    if (existing) {
      return existing;
    }

    /**
     * Stream 按需创建：
     * 全局 IM 可以收到很多 Thread，但没有事件的 Thread 不占用顺序缓冲空间。
     */
    const created: ThreadStream = {
      /** 未知 Thread 的第一条实时事件会建立这个基线。 */
      lastSeqId: null,

      /** 正常情况下创建后即可接收事件，snapshot 才会主动 pause。 */
      paused: false,

      /** 新 Stream 还没有报告过任何 gap。 */
      reportedGapExpectedSeqId: null,

      /** 每个 Thread 拥有独立 Map，不会与其他 Thread 的 seqId 冲突。 */
      buffer: new Map<SeqId, ServerThreadEvent>(),
    };

    /** 注册后，后续相同 threadId 始终取得这个对象。 */
    this.threadStreams.set(threadId, created);
    return created;
  }

  private findFirstBufferedSeqId(stream: ThreadStream): SeqId | null {
    /** null 同时表示“目前还没有遍历到元素”和“buffer 为空”。 */
    let firstSeqId: SeqId | null = null;

    /** Map 保留插入顺序而不是数值顺序，因此需要寻找最小 Key。 */
    for (const seqId of stream.buffer.keys()) {
      /** 第一个 Key 直接采用，之后只在找到更小值时替换。 */
      if (firstSeqId === null || seqId < firstSeqId) {
        firstSeqId = seqId;
      }
    }

    /** 调用方只用它描述 gap，不用它执行完整排序。 */
    return firstSeqId;
  }

  private publish(event: IMServiceEvent): void {
    /**
     * 复制 Set 后同步遍历：
     * - 同步发布保证状态层按 seqId 的先后顺序应用 Envelope；
     * - 复制保证监听器在回调中 unsubscribe 不会破坏本轮遍历。
     */
    for (const listener of [...this.listeners]) {
      /** 一个状态订阅者异常不能关闭 WebSocket 或阻止其他订阅者。 */
      this.callListenerSafely(listener, event, 'IM service listener failed.');
    }
  }

  private rejectAllPendingAcks(error: Error): void {
    /**
     * 先复制 Value：后面会一次性 clear Map，
     * 避免每次 reject 都再次按 requestId 查询和删除。
     */
    const pendingAcks = [...this.pendingAcks.values()];

    /** 先清空 Map，防止 Promise 的 catch 回调重入后仍看到旧请求。 */
    this.pendingAcks.clear();

    /** 每一条 PendingAck 都同时拥有一个仍可能触发的 timeout。 */
    for (const pending of pendingAcks) {
      /** 断线或销毁已经确定失败，超时任务不再有意义。 */
      clearTimeout(pending.timeoutId);

      /** 让所有调用方结束 await，而不是永久停留在等待状态。 */
      pending.reject(error);
    }
  }

  private callListenerSafely<TValue>(
    listener: (value: TValue) => void,
    value: TValue,
    message: string,
  ): void {
    try {
      /** 发布保持同步，因此同一批事件的调用顺序是确定的。 */
      listener(value);
    } catch (error) {
      /** 一个页面订阅者的异常不能阻止其他订阅者，也不能关闭 WebSocket。 */
      console.error(message, error);
    }
  }

  private assertUsable(): void {
    /** destroy 是永久操作；disconnect 后仍可重新 connect，二者语义不同。 */
    if (this.destroyed) {
      throw new Error('IMService 已销毁');
    }
  }
}

/** 页面和状态层依赖的公开能力就是 IMService 实例本身。 */
export type IMServicePublicApi = IMService;
