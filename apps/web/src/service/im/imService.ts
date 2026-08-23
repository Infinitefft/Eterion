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

/** 创建 Thread 并发送首条用户消息所需的数据。 */
export interface StartThreadInput {
  content: string;
  modelId?: ModelId;
  threadId?: ThreadId;
  messageId?: MessageId;
}

/** 向已有 Thread 发送用户消息所需的数据。 */
export interface SendMessageInput {
  threadId: ThreadId;
  content: string;
  modelId?: ModelId;
  messageId?: MessageId;
}

/** 取消正在执行的 Run 所需的数据。 */
export interface CancelRunInput {
  threadId: ThreadId;
  runId: RunId;
}

/** 回答 HITL 交互所需的数据。 */
export interface RespondToInteractionInput {
  threadId: ThreadId;
  runId: RunId;
  interactionId: InteractionId;
  answers: HITLAnswer[];
}

/**
 * Command 会立刻返回，页面可以马上取得其中的业务 ID；
 * ack Promise 只负责等待服务端接受或拒绝当前 Command。
 */
export interface IMCommandDispatch<TCommand extends ClientCommand> {
  command: Readonly<TCommand>;
  ack: Promise<AckFrame>;
}

/** seqId 不连续时通知状态层重新加载对应 Thread snapshot。 */
export interface ThreadSequenceGap {
  threadId: ThreadId;
  expectedSeqId: SeqId;
  receivedSeqId: SeqId;
}

export type IMThreadEventListener = (event: ServerThreadEvent) => void;
export type IMConnectionListener = (state: Readonly<IMConnectionState>) => void;
export type IMSequenceGapListener = (gap: ThreadSequenceGap) => void;
export type IMServiceUnsubscribe = () => void;

export interface IMServiceDependencies {
  transport: IMTransport;
}

export interface IMServiceOptions {
  commandAckTimeoutMs?: number;
  maxBufferedEventsPerThread?: number;
}

interface PendingAck {
  resolve: (ack: AckFrame) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

/** 每个 Thread 都有自己的顺序基线和临时乱序缓冲区。 */
interface ThreadStream {
  lastSeqId: SeqId | null;
  paused: boolean;
  reportedGapExpectedSeqId: SeqId | null;
  buffer: Map<SeqId, ServerThreadEvent>;
}

const DEFAULT_ACK_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BUFFERED_EVENTS = 500;

function createId(): string {
  return crypto.randomUUID();
}

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
  private readonly transport: IMTransport;

  private readonly commandAckTimeoutMs: number;

  private readonly maxBufferedEventsPerThread: number;

  /** requestId 只用于找到正在等待的 ACK。 */
  private readonly pendingAcks = new Map<RequestId, PendingAck>();

  /** seqId 只在同一个 ThreadStream 内比较。 */
  private readonly threadStreams = new Map<ThreadId, ThreadStream>();

  private readonly allThreadListeners = new Set<IMThreadEventListener>();

  private readonly threadListeners = new Map<ThreadId, Set<IMThreadEventListener>>();

  private readonly connectionListeners = new Set<IMConnectionListener>();

  private readonly sequenceGapListeners = new Set<IMSequenceGapListener>();

  private readonly unsubscribeTransport: IMTransportUnsubscribe;

  private connectionState: Readonly<IMConnectionState>;

  private destroyed = false;

  constructor(dependencies: IMServiceDependencies, options: IMServiceOptions = {}) {
    this.transport = dependencies.transport;
    this.commandAckTimeoutMs = options.commandAckTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
    this.maxBufferedEventsPerThread =
      options.maxBufferedEventsPerThread ?? DEFAULT_MAX_BUFFERED_EVENTS;
    this.connectionState = this.transport.getState();

    /** 全生命周期只订阅一次 Transport，避免重复处理同一个服务端 Frame。 */
    this.unsubscribeTransport = this.transport.subscribe(this.handleTransportEvent);
  }

  connect(): Promise<void> {
    this.assertUsable();
    return this.transport.connect();
  }

  disconnect(): void {
    this.assertUsable();

    /** 主动断开表示当前用户离开，旧 ACK 和 seqId 基线都不再复用。 */
    this.rejectAllPendingAcks(new Error('IM WebSocket 已主动断开'));
    this.threadStreams.clear();
    this.transport.disconnect();
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    this.unsubscribeTransport();
    this.transport.disconnect();
    this.rejectAllPendingAcks(new Error('IMService 已销毁'));

    this.threadStreams.clear();
    this.allThreadListeners.clear();
    this.threadListeners.clear();
    this.connectionListeners.clear();
    this.sequenceGapListeners.clear();
  }

  getConnectionState(): Readonly<IMConnectionState> {
    return this.connectionState;
  }

  subscribeConnection(listener: IMConnectionListener): IMServiceUnsubscribe {
    this.assertUsable();
    this.connectionListeners.add(listener);

    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  startThread(input: StartThreadInput): IMCommandDispatch<ThreadStartCommand> {
    const command: ThreadStartCommand = {
      type: 'thread.start',
      requestId: createId(),
      threadId: input.threadId ?? createId(),
      messageId: input.messageId ?? createId(),
      payload:
        input.modelId === undefined
          ? { content: input.content }
          : { content: input.content, modelId: input.modelId },
    };

    return this.dispatchCommand(command);
  }

  sendMessage(input: SendMessageInput): IMCommandDispatch<MessageSendCommand> {
    const command: MessageSendCommand = {
      type: 'message.send',
      requestId: createId(),
      threadId: input.threadId,
      messageId: input.messageId ?? createId(),
      payload:
        input.modelId === undefined
          ? { content: input.content }
          : { content: input.content, modelId: input.modelId },
    };

    return this.dispatchCommand(command);
  }

  cancelRun(input: CancelRunInput): IMCommandDispatch<RunCancelCommand> {
    const command: RunCancelCommand = {
      type: 'run.cancel',
      requestId: createId(),
      threadId: input.threadId,
      runId: input.runId,
    };

    return this.dispatchCommand(command);
  }

  respondToInteraction(
    input: RespondToInteractionInput,
  ): IMCommandDispatch<InteractionRespondCommand> {
    const command: InteractionRespondCommand = {
      type: 'interaction.respond',
      requestId: createId(),
      threadId: input.threadId,
      runId: input.runId,
      interactionId: input.interactionId,
      payload: { answers: input.answers },
    };

    return this.dispatchCommand(command);
  }

  subscribeAll(listener: IMThreadEventListener): IMServiceUnsubscribe {
    this.assertUsable();
    this.allThreadListeners.add(listener);

    return () => {
      this.allThreadListeners.delete(listener);
    };
  }

  subscribeThread(threadId: ThreadId, listener: IMThreadEventListener): IMServiceUnsubscribe {
    this.assertUsable();

    let listeners = this.threadListeners.get(threadId);

    if (!listeners) {
      listeners = new Set<IMThreadEventListener>();
      this.threadListeners.set(threadId, listeners);
    }

    listeners.add(listener);

    return () => {
      const currentListeners = this.threadListeners.get(threadId);

      if (!currentListeners) {
        return;
      }

      currentListeners.delete(listener);

      if (currentListeners.size === 0) {
        this.threadListeners.delete(threadId);
      }
    };
  }

  subscribeSequenceGap(listener: IMSequenceGapListener): IMServiceUnsubscribe {
    this.assertUsable();
    this.sequenceGapListeners.add(listener);

    return () => {
      this.sequenceGapListeners.delete(listener);
    };
  }

  pauseThread(threadId: ThreadId): void {
    this.assertUsable();
    this.getOrCreateThreadStream(threadId).paused = true;
  }

  resumeThread(threadId: ThreadId, lastSeqId: SeqId): void {
    this.assertUsable();

    const stream = this.getOrCreateThreadStream(threadId);

    if (stream.lastSeqId !== null && lastSeqId < stream.lastSeqId) {
      throw new Error('snapshot.lastSeqId 不能小于当前 Thread 的 lastSeqId');
    }

    /** snapshot 已经包含的事件无需再次发布，剩余事件继续等待连续排空。 */
    stream.lastSeqId = lastSeqId;
    stream.paused = false;
    stream.reportedGapExpectedSeqId = null;

    for (const seqId of stream.buffer.keys()) {
      if (seqId <= lastSeqId) {
        stream.buffer.delete(seqId);
      }
    }

    this.flushThreadBuffer(threadId, stream);
  }

  private dispatchCommand<TCommand extends ClientCommand>(
    command: TCommand,
  ): IMCommandDispatch<TCommand> {
    return {
      command,
      ack: this.sendCommand(command),
    };
  }

  private sendCommand(command: ClientCommand): Promise<AckFrame> {
    this.assertUsable();

    if (this.connectionState.status !== 'connected') {
      return Promise.reject(new Error('IM WebSocket 尚未连接'));
    }

    let serializedCommand: string;

    try {
      serializedCommand = JSON.stringify(command);
    } catch (error) {
      return Promise.reject(toError(error, 'IM Command 序列化失败'));
    }

    if (this.pendingAcks.has(command.requestId)) {
      return Promise.reject(new Error(`重复的 requestId：${command.requestId}`));
    }

    /** 新 Thread 的服务端业务事件从 seqId 1 开始。 */
    if (command.type === 'thread.start') {
      const stream = this.getOrCreateThreadStream(command.threadId);

      if (stream.lastSeqId === null) {
        stream.lastSeqId = 0;
      }
    }

    return new Promise<AckFrame>((resolve, reject) => {
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

      /** 先登记再发送，保证同步测试 ACK 也能找到对应 Promise。 */
      this.pendingAcks.set(command.requestId, pending);

      try {
        this.transport.send(serializedCommand);
      } catch (error) {
        if (this.pendingAcks.get(command.requestId) !== pending) {
          return;
        }

        clearTimeout(timeoutId);
        this.pendingAcks.delete(command.requestId);
        reject(toError(error, 'IM Command 发送失败'));
      }
    });
  }

  private readonly handleTransportEvent = (event: IMTransportEvent): void => {
    if (event.type === 'state.changed') {
      this.connectionState = event.state;

      if (
        event.state.status === 'disconnected' ||
        event.state.status === 'failed' ||
        event.state.status === 'disabled'
      ) {
        this.rejectAllPendingAcks(new Error('IM WebSocket 连接已断开'));
      }

      this.publishConnectionState(event.state);
      return;
    }

    this.handleRawFrame(event.data);
  };

  private handleRawFrame(rawFrame: string): void {
    let frame: ServerFrame;

    try {
      /** 前后端共享协议约定，这里只解析 JSON，不重复校验每个 payload 字段。 */
      frame = JSON.parse(rawFrame) as ServerFrame;
    } catch (error) {
      console.error('无法解析服务端 IM Frame。', error);
      return;
    }

    if (frame.type === 'ack') {
      this.handleAck(frame);
      return;
    }

    this.handleThreadEvent(frame);
  }

  private handleAck(ack: AckFrame): void {
    const pending = this.pendingAcks.get(ack.requestId);

    if (!pending) {
      return;
    }

    clearTimeout(pending.timeoutId);
    this.pendingAcks.delete(ack.requestId);
    pending.resolve(ack);
  }

  private handleThreadEvent(event: ServerThreadEvent): void {
    const stream = this.getOrCreateThreadStream(event.threadId);

    /** 已发布过的重复事件或迟到旧事件不能再次追加 delta。 */
    if (stream.lastSeqId !== null && event.seqId <= stream.lastSeqId) {
      return;
    }

    if (stream.paused) {
      this.bufferThreadEvent(event.threadId, stream, event);
      return;
    }

    /** 未知后台 Thread 以首帧建立实时基线；打开详情时再由 snapshot 校准。 */
    if (stream.lastSeqId === null) {
      this.publishAndAdvance(stream, event);
      return;
    }

    if (event.seqId === stream.lastSeqId + 1) {
      this.publishAndAdvance(stream, event);
      this.flushThreadBuffer(event.threadId, stream);
      return;
    }

    /** 未来事件先进入 Map，状态层收到 gap 后负责加载权威 snapshot。 */
    this.bufferThreadEvent(event.threadId, stream, event);
    this.reportSequenceGap(event.threadId, stream, event.seqId);
  }

  private bufferThreadEvent(
    threadId: ThreadId,
    stream: ThreadStream,
    event: ServerThreadEvent,
  ): void {
    const current = stream;
    current.buffer.set(event.seqId, event);

    if (current.buffer.size <= this.maxBufferedEventsPerThread) {
      return;
    }

    /** 缓冲过大时不再保留旧增量，重新通过 snapshot 建立权威状态。 */
    current.buffer.clear();
    current.buffer.set(event.seqId, event);
    current.reportedGapExpectedSeqId = null;
    this.reportSequenceGap(threadId, current, event.seqId);
  }

  private flushThreadBuffer(threadId: ThreadId, stream: ThreadStream): void {
    const current = stream;

    if (!this.canContinueFlushing(threadId, current) || current.lastSeqId === null) {
      return;
    }

    let nextEvent = current.buffer.get(current.lastSeqId + 1);

    while (nextEvent) {
      current.buffer.delete(nextEvent.seqId);
      this.publishAndAdvance(current, nextEvent);

      /** 订阅者可以在回调中重新 pause 或 disconnect，旧排空循环必须及时停止。 */
      if (!this.canContinueFlushing(threadId, current)) {
        return;
      }

      nextEvent = current.buffer.get(current.lastSeqId + 1);
    }

    if (current.buffer.size === 0) {
      current.reportedGapExpectedSeqId = null;
      return;
    }

    const firstBufferedSeqId = this.findFirstBufferedSeqId(current);

    if (firstBufferedSeqId !== null) {
      this.reportSequenceGap(threadId, current, firstBufferedSeqId);
    }
  }

  private canContinueFlushing(threadId: ThreadId, stream: ThreadStream): boolean {
    return !stream.paused && this.threadStreams.get(threadId) === stream;
  }

  private publishAndAdvance(stream: ThreadStream, event: ServerThreadEvent): void {
    /** 先推进游标，防止订阅者回调重入时重复处理同一 seqId。 */
    const current = stream;
    current.lastSeqId = event.seqId;
    this.publishThreadEvent(event);
  }

  private reportSequenceGap(threadId: ThreadId, stream: ThreadStream, receivedSeqId: SeqId): void {
    const current = stream;
    const expectedSeqId = (current.lastSeqId ?? 0) + 1;

    if (current.reportedGapExpectedSeqId === expectedSeqId) {
      return;
    }

    current.reportedGapExpectedSeqId = expectedSeqId;

    const gap: ThreadSequenceGap = {
      threadId,
      expectedSeqId,
      receivedSeqId,
    };

    for (const listener of [...this.sequenceGapListeners]) {
      this.callListenerSafely(listener, gap, 'IM sequence gap listener failed.');
    }
  }

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

  private findFirstBufferedSeqId(stream: ThreadStream): SeqId | null {
    let firstSeqId: SeqId | null = null;

    for (const seqId of stream.buffer.keys()) {
      if (firstSeqId === null || seqId < firstSeqId) {
        firstSeqId = seqId;
      }
    }

    return firstSeqId;
  }

  private publishThreadEvent(event: ServerThreadEvent): void {
    for (const listener of [...this.allThreadListeners]) {
      this.callListenerSafely(listener, event, 'IM all-thread listener failed.');
    }

    const listeners = this.threadListeners.get(event.threadId);

    if (!listeners) {
      return;
    }

    for (const listener of [...listeners]) {
      this.callListenerSafely(listener, event, 'IM thread listener failed.');
    }
  }

  private publishConnectionState(state: Readonly<IMConnectionState>): void {
    for (const listener of [...this.connectionListeners]) {
      this.callListenerSafely(listener, state, 'IM connection listener failed.');
    }
  }

  private rejectAllPendingAcks(error: Error): void {
    const pendingAcks = [...this.pendingAcks.values()];
    this.pendingAcks.clear();

    for (const pending of pendingAcks) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
  }

  private callListenerSafely<TValue>(
    listener: (value: TValue) => void,
    value: TValue,
    message: string,
  ): void {
    try {
      listener(value);
    } catch (error) {
      console.error(message, error);
    }
  }

  private assertUsable(): void {
    if (this.destroyed) {
      throw new Error('IMService 已销毁');
    }
  }
}

/** 页面和状态层依赖的公开能力就是 IMService 实例本身。 */
export type IMServicePublicApi = IMService;
