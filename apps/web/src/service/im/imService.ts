import type {
  ChatStartCommand,
  ChatSubmitCommand,
  ClientCommand,
  CommandAcceptedEvent,
  CommandRejectedEvent,
  MessageDeltaEvent,
  MessageSnapshotEvent,
  PingCommand,
  PongEvent,
  RunCancelCommand,
  RunSnapshotEvent,
  ServerEvent,
  StepSnapshotEvent,
  WireAgentRun,
  WireAgentStep,
  WireChatMessage,
} from './protocol';
import type { IMStoreApi } from './store';
import type {
  IMTransport,
  IMTransportEvent,
  IMTransportUnsubscribe,
} from './transport';
import type {
  AgentRun,
  AgentStep,
  ChatId,
  ChatMessage,
  EventId,
  IdempotencyKey,
  IMError,
  MessageId,
  RequestId,
  RunId,
} from './types';

/** 创建 IM Service 时需要注入的底层依赖。 */
export interface IMServiceDependencies {
  /** 全局唯一的 WebSocket Transport。 */
  transport: IMTransport;

  /** 全局唯一的 Zustand IM Store。 */
  store: IMStoreApi;
}

/** IM Service 的行为配置。 */
export interface IMServiceOptions {
  /** 等待服务端 command.accepted/rejected 的时间。 */
  commandAckTimeoutMs?: number;
}

/** 用户在首页创建新会话时输入的数据。 */
export interface PrepareNewChatInput {
  prompt: string;
  title?: string;
}

/** 向已有 Chat 发送消息时需要的数据。 */
export interface SubmitMessageInput {
  chatId: ChatId;
  content: string;
}

/** 取消 Agent Run 时需要的数据。 */
export interface CancelRunInput {
  chatId: ChatId;
  runId: RunId;
}

/** IM Service 对页面层提供的公开能力。 */
export interface IMServicePublicApi {
  /** 注册 Transport 监听器；重复调用不会重复注册。 */
  initialize(): void;

  /** 建立或复用全局 WebSocket 连接。 */
  connect(): Promise<void>;

  /** 主动断开连接，但保留已经加载的会话数据。 */
  disconnect(): void;

  /** 获取供 Service 修改、供 React 订阅的 Zustand Store。 */
  getStore(): IMStoreApi;

  /** 生成 ChatId，并登记跳转后需要发送的首条 Prompt。 */
  prepareNewChat(input: PrepareNewChatInput): ChatId;

  /** 发送某个新 Chat 已登记的首条 Prompt。 */
  sendInitialPrompt(chatId: ChatId): Promise<RequestId | null>;

  /** 向已经存在的 Chat 发送一条新的用户消息。 */
  submitMessage(input: SubmitMessageInput): Promise<RequestId>;

  /** 主动取消一个仍在执行的 Agent Run。 */
  cancelRun(input: CancelRunInput): Promise<RequestId>;

  /** 释放监听器、定时器和内存状态；路由切换不能调用。 */
  destroy(): void;
}

/**
 * 一条已经发出、正在等待服务端确认的 Command。
 *
 * Command 本身用于核对 ACK 类型；messageId 用于修改乐观消息；
 * initialPromptChatId 用于确认或拒绝新会话首条 Prompt。
 */
interface PendingCommand {
  /** 已经通过 WebSocket 发出的原始指令。 */
  command: ClientCommand;

  /** 当前指令对应的本地用户消息；非消息指令为 null。 */
  messageId: MessageId | null;

  /** chat.start 对应的 Chat；其他指令为 null。 */
  initialPromptChatId: ChatId | null;

  /** 用来把长时间未收到 ACK 的消息标记为 delivery_unknown。 */
  timeoutId: ReturnType<typeof setTimeout>;
}

const DEFAULT_OPTIONS: Required<IMServiceOptions> = {
  commandAckTimeoutMs: 15_000,
};

const MAX_REMEMBERED_EVENT_IDS = 2_048;

function createId(): string {
  /**
   * Chat、Message、Request 和幂等键都由前端生成 UUID。
   * 不同语义仍通过 TypeScript 类型和字段位置进行区分。
   */
  return crypto.randomUUID();
}

function normalizeError(
  error: unknown,
  fallbackCode: string,
  fallbackMessage: string,
): IMError {
  return {
    code: fallbackCode,
    message: error instanceof Error ? error.message : fallbackMessage,
    retryable: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSupportedServerEventType(type: string): boolean {
  switch (type) {
    case 'connection.ready':
    case 'command.accepted':
    case 'command.rejected':
    case 'run.created':
    case 'run.status':
    case 'step.started':
    case 'step.progress':
    case 'step.completed':
    case 'step.failed':
    case 'message.started':
    case 'message.delta':
    case 'message.completed':
    case 'pong':
    case 'error':
      return true;
    default:
      return false;
  }
}

/**
 * 当前只进行 JSON 和事件名称检查。
 * 具体 payload 依赖 protocol.ts 中的静态 Interface 约束。
 */
function parseServerEvent(raw: string): ServerEvent {
  const parsed: unknown = JSON.parse(raw);

  if (
    !isRecord(parsed) ||
    typeof parsed.type !== 'string' ||
    !isSupportedServerEventType(parsed.type)
  ) {
    throw new Error('服务端 IM 事件结构不正确。');
  }

  return parsed as unknown as ServerEvent;
}

function toChatMessage(message: WireChatMessage): ChatMessage {
  /** 网络协议使用 snake_case，Store 领域对象使用 camelCase。 */
  return {
    id: message.message_id,
    chatId: message.chat_id,
    runId: message.run_id,
    role: message.role,
    status: message.status,
    content: { ...message.content },
    createdAt: message.created_at,
    updatedAt: message.updated_at,
    completedAt: message.completed_at,
    error: message.error,
  };
}

function toAgentRun(run: WireAgentRun): AgentRun {
  /** 复制 step_ids，避免 Store 与网络对象共享可变数组引用。 */
  return {
    id: run.run_id,
    chatId: run.chat_id,
    inputMessageId: run.input_message_id,
    outputMessageId: run.output_message_id,
    status: run.status,
    stepIds: [...run.step_ids],
    lastSeq: run.last_seq,
    desynced: run.desynced,
    createdAt: run.created_at,
    startedAt: run.started_at,
    updatedAt: run.updated_at,
    completedAt: run.completed_at,
    error: run.error,
  };
}

function toAgentStep(step: WireAgentStep): AgentStep {
  /**
   * kind 是可辨识字段。根据它把网络 Step 转换成
   * Reasoning、Tool、Skill 或 Retrieval 领域对象。
   */
  const base = {
    id: step.step_id,
    chatId: step.chat_id,
    runId: step.run_id,
    title: step.title,
    status: step.status,
    sequence: step.sequence,
    parentStepId: step.parent_step_id,
    startedAt: step.started_at,
    completedAt: step.completed_at,
    error: step.error,
  };

  switch (step.kind) {
    case 'reasoning':
      return {
        ...base,
        kind: 'reasoning',
        summary: step.summary,
      };

    case 'tool':
      return {
        ...base,
        kind: 'tool',
        callId: step.call_id,
        tool: { ...step.tool },
        input: step.input,
        output: step.output,
      };

    case 'skill':
      return {
        ...base,
        kind: 'skill',
        callId: step.call_id,
        skill: { ...step.skill },
        input: step.input,
        output: step.output,
      };

    case 'retrieval':
      return {
        ...base,
        kind: 'retrieval',
        retrievalId: step.retrieval_id,
        query: step.query,
        documents: [...step.documents],
      };
  }
}

/** 全局 IM Service。 */
export class IMService implements IMServicePublicApi {
  /** initialize() 是否已经注册过唯一的 Transport 监听器。 */
  private initialized = false;

  /** destroy() 时使用它移除 Transport 监听器。 */
  private unsubscribeTransport: IMTransportUnsubscribe | null = null;

  /** connection.ready 到达后创建的应用层心跳定时器。 */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  /** 正在等待服务端 ACK 的客户端指令。 */
  private readonly pendingCommands = new Map<RequestId, PendingCommand>();

  /** 用于过滤断线续传或服务端重复下发的事件。 */
  private readonly processedEventIds = new Set<EventId>();
  private readonly processedEventOrder: EventId[] = [];

  private readonly options: Required<IMServiceOptions>;

  constructor(
    private readonly dependencies: IMServiceDependencies,
    options: IMServiceOptions = {},
  ) {
    /** 调用者只需要传入想覆盖的配置，其余使用稳定默认值。 */
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
    };
  }

  /** 注册唯一的 Transport 监听器，但不主动连接。 */
  initialize(): void {
    if (this.initialized) {
      return;
    }

    this.initialized = true;
    this.unsubscribeTransport = this.dependencies.transport.subscribe(
      this.handleTransportEvent,
    );

    this.dependencies.store
      .getState()
      .setConnectionState(this.dependencies.transport.getState());
  }

  /** 建立或复用全局 WebSocket 连接。 */
  connect(): Promise<void> {
    this.initialize();
    return this.dependencies.transport.connect();
  }

  /** 主动断开连接，但保留当前 Chat 数据。 */
  disconnect(): void {
    this.clearHeartbeat();
    this.dependencies.transport.disconnect();
  }

  getStore(): IMStoreApi {
    return this.dependencies.store;
  }

  /**
   * 创建前端 ChatId，并登记一次性 InitialPromptIntent。
   * 该方法不会立即发送 WebSocket 指令。
   */
  prepareNewChat(input: PrepareNewChatInput): ChatId {
    const prompt = input.prompt.trim();

    if (!prompt) {
      throw new Error('新会话 Prompt 不能为空。');
    }

    const chatId: ChatId = createId();
    const messageId: MessageId = createId();
    const idempotencyKey: IdempotencyKey = createId();
    const now = Date.now();
    const title = input.title?.trim() || null;
    const optimisticTitle = title ?? prompt.slice(0, 30);
    const store = this.dependencies.store.getState();

    /**
     * 先把 Chat 放入 Store，再返回 ChatId。
     * 因此首页无需等待后端，就可以立即跳转到 /chat/:chatId。
     */
    store.upsertChat({
      id: chatId,
      title: optimisticTitle,
      createdAt: now,
      updatedAt: now,
    });

    store.registerInitialPromptIntent({
      chatId,
      messageId,
      prompt,
      title,
      idempotencyKey,
      status: 'pending',
      createdAt: now,
      lastRequestId: null,
      error: null,
    });

    return chatId;
  }

  /** 发送新 Chat 已经登记的首条 Prompt。 */
  async sendInitialPrompt(chatId: ChatId): Promise<RequestId | null> {
    const store = this.dependencies.store.getState();
    const intent = store.initialPromptIntentsByChatId[chatId];

    if (!intent || intent.status === 'rejected') {
      /**
       * 历史会话没有 InitialPromptIntent，因此进入相同页面时
       * 会自然走到这里，不需要额外的 shouldSendPrompt 布尔值。
       */
      return null;
    }

    /** 页面重复调用时复用正在等待 ACK 的 RequestId。 */
    if (intent.status === 'sending' && intent.lastRequestId) {
      return intent.lastRequestId;
    }

    const requestId: RequestId = createId();
    const now = Date.now();

    store.upsertMessage({
      id: intent.messageId,
      chatId,
      runId: null,
      role: 'user',
      status: 'pending',
      content: {
        type: 'text',
        format: 'plain_text',
        content: intent.prompt,
      },
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      error: null,
    });

    store.updateInitialPromptIntent(chatId, {
      status: 'sending',
      lastRequestId: requestId,
      error: null,
    });

    const command: ChatStartCommand = {
      type: 'chat.start',
      request_id: requestId,
      idempotency_key: intent.idempotencyKey,
      chat_id: chatId,
      run_id: null,
      timestamp: now,
      payload: {
        /** 重试时继续使用 Intent 中同一个 MessageId 和幂等键。 */
        message_id: intent.messageId,
        title: intent.title,
        content: {
          type: 'text',
          format: 'plain_text',
          content: intent.prompt,
        },
      },
    };

    try {
      await this.dispatchCommand(command, {
        messageId: intent.messageId,
        initialPromptChatId: chatId,
      });
    } catch (error) {
      const normalized = normalizeError(
        error,
        'IM_INITIAL_PROMPT_SEND_FAILED',
        '新会话首条消息发送失败。',
      );

      store.updateInitialPromptIntent(chatId, {
        status: 'pending',
        error: normalized,
      });
      this.markMessageFailed(intent.messageId, normalized);

      throw error;
    }

    return requestId;
  }

  /** 向已有 Chat 发送用户文本。 */
  async submitMessage(input: SubmitMessageInput): Promise<RequestId> {
    const content = input.content.trim();
    const store = this.dependencies.store.getState();

    if (!content) {
      throw new Error('消息内容不能为空。');
    }

    if (!store.chatsById[input.chatId]) {
      throw new Error('目标 Chat 尚未加载。');
    }

    const requestId: RequestId = createId();
    const messageId: MessageId = createId();
    const idempotencyKey: IdempotencyKey = createId();
    const now = Date.now();

    store.upsertMessage({
      id: messageId,
      chatId: input.chatId,
      runId: null,
      role: 'user',
      status: 'pending',
      content: {
        type: 'text',
        format: 'plain_text',
        content,
      },
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      error: null,
    });

    store.upsertChat({
      ...store.chatsById[input.chatId],
      updatedAt: now,
    });

    const command: ChatSubmitCommand = {
      type: 'chat.submit',
      request_id: requestId,
      idempotency_key: idempotencyKey,
      chat_id: input.chatId,
      run_id: null,
      timestamp: now,
      payload: {
        message_id: messageId,
        content: {
          type: 'text',
          format: 'plain_text',
          content,
        },
      },
    };

    try {
      await this.dispatchCommand(command, {
        messageId,
        initialPromptChatId: null,
      });
    } catch (error) {
      this.markMessageFailed(
        messageId,
        normalizeError(
          error,
          'IM_MESSAGE_SEND_FAILED',
          '消息发送失败。',
        ),
      );
      throw error;
    }

    return requestId;
  }

  /** 主动取消一个 Agent Run。 */
  async cancelRun(input: CancelRunInput): Promise<RequestId> {
    const store = this.dependencies.store.getState();

    if (!store.runsById[input.runId]) {
      throw new Error('需要取消的 Agent Run 不存在。');
    }

    const requestId: RequestId = createId();
    const command: RunCancelCommand = {
      type: 'run.cancel',
      request_id: requestId,
      idempotency_key: createId(),
      chat_id: input.chatId,
      run_id: input.runId,
      timestamp: Date.now(),
      payload: {
        reason: 'user_requested',
      },
    };

    await this.dispatchCommand(command, {
      messageId: null,
      initialPromptChatId: null,
    });

    return requestId;
  }

  /** 释放监听器、定时器和内存中的 ACK 记录。 */
  destroy(): void {
    this.clearHeartbeat();

    for (const pending of this.pendingCommands.values()) {
      clearTimeout(pending.timeoutId);
    }

    this.pendingCommands.clear();
    this.processedEventIds.clear();
    this.processedEventOrder.length = 0;

    this.dependencies.transport.disconnect();
    this.unsubscribeTransport?.();
    this.unsubscribeTransport = null;
    this.initialized = false;
  }

  /** 连接成功后发送一条 Command，并开始等待 ACK。 */
  private async dispatchCommand(
    command: ClientCommand,
    context: Pick<PendingCommand, 'messageId' | 'initialPromptChatId'>,
  ): Promise<void> {
    await this.connect();

    if (this.dependencies.transport.getState().status !== 'connected') {
      throw new Error('IM WebSocket 当前不可用。');
    }

    this.dependencies.transport.send(JSON.stringify(command));

    /**
     * WebSocket.send() 成功只表示数据交给了浏览器，
     * 不代表服务端已经处理，因此还必须等待业务层 ACK。
     */
    const timeoutId = setTimeout(() => {
      this.handleCommandTimeout(command.request_id);
    }, this.options.commandAckTimeoutMs);

    this.pendingCommands.set(command.request_id, {
      command,
      messageId: context.messageId,
      initialPromptChatId: context.initialPromptChatId,
      timeoutId,
    });
  }

  private readonly handleTransportEvent = (
    event: IMTransportEvent,
  ): void => {
    if (event.type === 'state.changed') {
      this.dependencies.store.getState().setConnectionState(event.state);

      if (event.state.status !== 'connected') {
        this.clearHeartbeat();
        this.dependencies.store.getState().updateSessionState({
          connectionId: null,
          lastPongAt: null,
        });
      }

      return;
    }

    this.handleRawServerMessage(event.data);
  };

  /** 将原始 JSON 字符串转换为静态 ServerEvent 并分发。 */
  private handleRawServerMessage(raw: string): void {
    try {
      this.handleServerEvent(parseServerEvent(raw));
    } catch (error) {
      this.reportError(
        normalizeError(
          error,
          'IM_EVENT_PARSE_FAILED',
          '服务端 IM 事件解析失败。',
        ),
      );
    }
  }

  private handleServerEvent(event: ServerEvent): void {
    /** 断线续传可能重复下发旧事件，先通过 event_id 去重。 */
    if (!this.rememberEvent(event.event_id)) {
      return;
    }

    if (event.cursor !== null) {
      /** 保存最新全局位置，为后续携带 cursor 续传做准备。 */
      this.dependencies.store.getState().updateSessionState({
        cursor: event.cursor,
      });
    }

    if (!this.acceptRunSequence(event.run_id, event.seq)) {
      /** 同一个 Run 中 seq 不大于 lastSeq 的事件已经处理过。 */
      return;
    }

    switch (event.type) {
      case 'connection.ready':
        this.dependencies.store.getState().updateSessionState({
          connectionId: event.payload.connection_id,
          lastPongAt: Date.now(),
        });
        this.startHeartbeat(event.payload.heartbeat_interval_ms);
        break;

      case 'command.accepted':
        this.handleCommandAccepted(event);
        break;

      case 'command.rejected':
        this.handleCommandRejected(event);
        break;

      case 'run.created':
      case 'run.status':
        this.handleRunSnapshot(event);
        break;

      case 'step.started':
      case 'step.progress':
      case 'step.completed':
      case 'step.failed':
        this.handleStepSnapshot(event);
        break;

      case 'message.started':
      case 'message.completed':
        this.handleMessageSnapshot(event);
        break;

      case 'message.delta':
        this.handleMessageDelta(event);
        break;

      case 'pong':
        this.handlePong(event);
        break;

      case 'error':
        this.reportError(event.payload.error);
        break;
    }
  }

  private handleCommandAccepted(event: CommandAcceptedEvent): void {
    const pending = this.takePendingCommand(event.request_id);

    if (!pending) {
      return;
    }

    if (pending.command.type !== event.payload.command_type) {
      this.reportError({
        code: 'IM_ACK_COMMAND_MISMATCH',
        message: '服务端 ACK 与客户端 Command 类型不一致。',
        retryable: false,
      });
      return;
    }

    if (pending.messageId) {
      const store = this.dependencies.store.getState();
      const message = store.messagesById[pending.messageId];

      if (message && message.status !== 'completed') {
        store.upsertMessage({
          ...message,
          status: 'completed',
          updatedAt: event.timestamp,
          completedAt: event.timestamp,
          error: null,
        });
      }
    }

    if (pending.initialPromptChatId) {
      /**
       * chat.start 已被服务端确认后删除 Intent，
       * 页面再次渲染时不会重复发送首条 Prompt。
       */
      this.dependencies.store
        .getState()
        .removeInitialPromptIntent(pending.initialPromptChatId);
    }
  }

  private handleCommandRejected(event: CommandRejectedEvent): void {
    const pending = this.takePendingCommand(event.request_id);

    if (!pending) {
      return;
    }

    if (pending.command.type !== event.payload.command_type) {
      this.reportError({
        code: 'IM_REJECTION_COMMAND_MISMATCH',
        message: '服务端拒绝事件与客户端 Command 类型不一致。',
        retryable: false,
      });
      return;
    }

    const store = this.dependencies.store.getState();
    const intent = pending.initialPromptChatId
      ? store.initialPromptIntentsByChatId[pending.initialPromptChatId]
      : null;
    const isLatestInitialRequest =
      !intent || intent.lastRequestId === event.request_id;

    if (pending.messageId && isLatestInitialRequest) {
      this.markMessageFailed(pending.messageId, event.payload.error);
    }

    if (pending.initialPromptChatId && isLatestInitialRequest) {
      store.updateInitialPromptIntent(pending.initialPromptChatId, {
        status: 'rejected',
        error: event.payload.error,
      });
    }
  }

  private handleCommandTimeout(requestId: RequestId): void {
    const pending = this.pendingCommands.get(requestId);

    if (!pending) {
      return;
    }

    /**
     * 超时后暂时保留 pendingCommands 记录。
     * 如果迟到的 accepted/rejected 之后到达，仍然能够正确关联。
     */

    const store = this.dependencies.store.getState();
    const intent = pending.initialPromptChatId
      ? store.initialPromptIntentsByChatId[pending.initialPromptChatId]
      : null;
    const isLatestInitialRequest =
      !intent || intent.lastRequestId === requestId;

    if (pending.messageId && isLatestInitialRequest) {
      const message = store.messagesById[pending.messageId];

      if (message && message.status !== 'completed') {
        store.upsertMessage({
          ...message,
          status: 'delivery_unknown',
          updatedAt: Date.now(),
        });
      }
    }

    if (pending.initialPromptChatId && isLatestInitialRequest) {
      store.updateInitialPromptIntent(pending.initialPromptChatId, {
        status: 'delivery_unknown',
        error: {
          code: 'IM_COMMAND_ACK_TIMEOUT',
          message: '等待服务端确认超时，本次操作是否完成暂时未知。',
          retryable: true,
        },
      });
    }
  }

  private handleRunSnapshot(event: RunSnapshotEvent): void {
    const store = this.dependencies.store.getState();
    const current = store.runsById[event.run_id];
    const run = toAgentRun(event.payload.run);

    store.upsertRun({
      ...run,
      lastSeq: Math.max(run.lastSeq, event.seq),
      desynced: run.desynced || current?.desynced === true,
    });
  }

  private handleStepSnapshot(event: StepSnapshotEvent): void {
    this.dependencies.store
      .getState()
      .upsertStep(toAgentStep(event.payload.step));
  }

  private handleMessageSnapshot(event: MessageSnapshotEvent): void {
    this.dependencies.store
      .getState()
      .upsertMessage(toChatMessage(event.payload.message));
  }

  private handleMessageDelta(event: MessageDeltaEvent): void {
    this.dependencies.store.getState().appendMessageDelta({
      messageId: event.message_id,
      delta: event.payload.delta,
      updatedAt: event.timestamp,
    });
  }

  private handlePong(_event: PongEvent): void {
    this.dependencies.store.getState().updateSessionState({
      lastPongAt: Date.now(),
    });
  }

  /** 返回 false 表示当前事件是已经处理过的旧事件。 */
  private acceptRunSequence(runId: RunId | null, seq: number | null): boolean {
    if (runId === null || seq === null) {
      return true;
    }

    const store = this.dependencies.store.getState();
    const run = store.runsById[runId];

    if (!run) {
      return true;
    }

    if (seq <= run.lastSeq) {
      /** 重复事件或比当前状态更旧的事件不能再次修改 Store。 */
      return false;
    }

    store.upsertRun({
      ...run,
      lastSeq: seq,
      /** seq 出现跳号表示中间事件可能丢失，需要后续加载快照校准。 */
      desynced: run.desynced || seq > run.lastSeq + 1,
      updatedAt: Date.now(),
    });

    return true;
  }

  private rememberEvent(eventId: EventId): boolean {
    if (this.processedEventIds.has(eventId)) {
      return false;
    }

    this.processedEventIds.add(eventId);
    this.processedEventOrder.push(eventId);

    if (this.processedEventOrder.length > MAX_REMEMBERED_EVENT_IDS) {
      /**
       * 全局连接会长期存在，因此事件去重集合必须设置上限，
       * 避免随着会话使用时间无限增长。
       */
      const oldestEventId = this.processedEventOrder.shift();

      if (oldestEventId) {
        this.processedEventIds.delete(oldestEventId);
      }
    }

    return true;
  }

  private takePendingCommand(requestId: RequestId): PendingCommand | null {
    const pending = this.pendingCommands.get(requestId);

    if (!pending) {
      return null;
    }

    clearTimeout(pending.timeoutId);
    this.pendingCommands.delete(requestId);
    return pending;
  }

  private markMessageFailed(messageId: MessageId, error: IMError): void {
    const store = this.dependencies.store.getState();
    const message = store.messagesById[messageId];

    if (!message || message.status === 'completed') {
      return;
    }

    store.upsertMessage({
      ...message,
      status: 'failed',
      updatedAt: Date.now(),
      completedAt: Date.now(),
      error,
    });
  }

  private startHeartbeat(intervalMs: number): void {
    this.clearHeartbeat();

    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      return;
    }

    this.heartbeatTimer = setInterval(() => {
      if (this.dependencies.transport.getState().status !== 'connected') {
        return;
      }

      const command: PingCommand = {
        type: 'ping',
        request_id: createId(),
        idempotency_key: null,
        chat_id: null,
        run_id: null,
        timestamp: Date.now(),
        payload: {
          client_time: Date.now(),
        },
      };

      try {
        /** 心跳直接发送，不进入业务 Command ACK 队列，由 pong 单独确认。 */
        this.dependencies.transport.send(JSON.stringify(command));
      } catch (error) {
        this.reportError(
          normalizeError(
            error,
            'IM_HEARTBEAT_SEND_FAILED',
            'IM 心跳发送失败。',
          ),
        );
      }
    }, Math.max(intervalMs, 1_000));
  }

  private clearHeartbeat(): void {
    if (!this.heartbeatTimer) {
      return;
    }

    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private reportError(error: IMError): void {
    const store = this.dependencies.store.getState();

    store.setConnectionState({
      ...store.connection,
      lastError: error,
    });
  }
}
