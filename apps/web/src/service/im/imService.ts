import type { ClientCommand, ServerEvent } from './protocol';
import type { IMStoreApi } from './store';
import type { IMTransport, IMTransportEvent, IMTransportUnsubscribe } from './transport';
import type {
  Chat,
  ChatId,
  ChatSnapshot,
  EventId,
  IdempotencyKey,
  IMError,
  MessageId,
  RequestId,
  RunId,
} from './types';

/**
 * 创建 IMService 时需要注入的底层依赖
 *
 * IMService 不在内部直接窜关键 Transport 和 Store
 * 而是由 index.ts 创建完成后传进来
 *
 * - Transport 负责 WebSocket
 * - Store 负责状态
 * - IMService 负责编排业务
 */
export interface IMServiceDependencies {
  /** 全局唯一的 WebSocket Transport */
  transport: IMTransport;

  /** 全局唯一的 Zustand IM Store */
  store: IMStoreApi;

  /** 通过认证 REST 接口加载当前用户的 Chat 列表。 */
  fetchChats?: () => Promise<Chat[]>;

  /** 通过认证 REST 接口加载一个 Chat 的权威快照。 */
  fetchChatSnapshot?: (chatId: ChatId) => Promise<ChatSnapshot>;

  /** 通过认证 REST 接口修改 Chat 标题。 */
  updateChatTitle?: (chatId: ChatId, title: string) => Promise<Chat>;

  /** 通过认证 REST 接口删除 Chat。 */
  deleteChat?: (chatId: ChatId) => Promise<void>;
}

/**
 * IMService 可以由外部调整的行为配置
 */
export interface IMServiceOptions {
  /**
   * Command 发送后，等待服务端 ACK 的最长时间
   *
   * 超市不代表服务端一定没有处理
   * 因此消息会进入 delivery_unknown 状态
   */
  commandAckTimeoutMs?: number;

  /**
   * Command 在尚未交给 WebSocket 前发生明确失败时的最大发送次数。
   * 不包含 ACK 超时；ACK 超时的结果未知，不能自动重复发送。
   */
  commandSendMaxAttempts?: number;

  /** 明确发送失败后的首次重试等待时间，后续按指数退避增加。 */
  commandSendRetryDelayMs?: number;
}

/**
 * 用户在首页创建新会话时输入的数据
 */
export interface PrepareNewChatInput {
  prompt: string;

  title?: string;

  /** 省略时使用服务端 DEFAULT_MODEL_ID。 */
  modelId?: string;
}

/**
 * 向一个已经存在的 Chat 发送消息时需要的数据
 */
export interface SubmitMessageInput {
  chatId: ChatId;
  content: string;

  /** 省略时使用服务端 DEFAULT_MODEL_ID。 */
  modelId?: string;
}

/**
 * 用户主动取消 Agent Run 时需要的数据
 */
export interface CancelRunInput {
  chatId: ChatId;
  runId: RunId;
}

export interface RenameChatInput {
  chatId: ChatId;
  title: string;
}

/**
 * IMService 对页面层提供的公开能力
 *
 * React 页面只应该调用这些业务方法
 * 而不应该调用 transport.send()
 */
export interface IMServicePublicApi {
  /**
   * 初始化 IMService
   *
   * 只注册 Transport 监听器，不建立 WebSocket连接
   * 重复调用不会注册多个监听器
   */
  initialize(): void;

  /**
   * 建立或复用全局 WebSocket 连接
   *
   * 应该在用户身份恢复完成后调用
   */
  connect(): Promise<void>;

  /**
   * 主动断开 WebSocket
   *
   * 断开连接不会情况已经加载的 Chat 数据
   */
  disconnect(): void;

  /**
   * 获取全局 zustand store
   *
   * IMService 通过 getState() 修改数据
   * React 页面通过 useStore 订阅数据
   */
  getStore(): IMStoreApi;

  /** 从后端恢复当前用户的历史会话列表。 */
  loadChats(): Promise<void>;

  /** 从后端恢复一个历史会话的完整快照。 */
  loadChatSnapshot(chatId: ChatId): Promise<void>;

  /** 修改一个历史会话的标题并同步本地 Store。 */
  renameChat(input: RenameChatInput): Promise<void>;

  /** 删除一个历史会话及本地关联数据。 */
  deleteChat(chatId: ChatId): Promise<void>;

  /**
   * 打开一个会话：新会话发送首次 Prompt，历史会话加载快照。
   */
  openChat(chatId: ChatId): Promise<void>;

  /** 注销或切换账号时清空业务数据，并使未完成的历史请求失效。 */
  resetBusinessState(): void;

  /**
   * 创建新会话的本地状态
   *
   * 该方法生成 chatId 并登记首条 prompt
   * 但不会立即发送 WebSocket Command
   *
   * @returns 前端生成的永久 ChatId
   */
  prepareNewChat(input: PrepareNewChatInput): ChatId;

  /**
   * 发送新会话已经登记的首条 Prompt
   *
   * 历史会话没有 InitialPromptIntent
   * 因此调用后会返回 null，不会自动发送消息
   *
   * @returns 本词发送使用的 RequestId
   */
  sendInitialPrompt(chatId: ChatId): Promise<RequestId | null>;

  /**
   * 向已有 Chat 发送一条新的用户信息
   *
   * @returns 本次发送使用的 RequestId
   */
  submitMessage(input: SubmitMessageInput): Promise<RequestId>;

  /**
   * 重试一条明确发送失败且允许重试的用户消息。
   * 重试时复用原 MessageId 和 IdempotencyKey，避免产生重复业务消息。
   */
  retryMessage(messageId: MessageId): Promise<RequestId>;

  /**
   * 主动取消一个仍在执行的 Agent Run
   *
   * @returns 本次发送使用的 RequestId
   */
  cancelRun(input: CancelRunInput): Promise<RequestId>;

  /**
   * 彻底销毁 Service 的监听器和定时器
   *
   * 普通路由切换不能调用
   * 主要用于应用彻底销毁或开发环境热更新
   */
  destroy(): void;
}

/**
 * 一条通过 WebSocket 发出
 * 但仍在等待服务端 ACK 的 Command
 *
 * 它只保存在 IMService 内存中，不需要放入 zustand store
 *
 * 主要用于：
 * 收到 command.accepted 时找到原始 Command
 * 收到 command.rejected 时找到对应消息
 * ACK 超时时把消息标记为 delivery_unknwon
 */
interface PendingCommand {
  /**
   * 已经发送给服务端的完整指令
   *
   * 收到 ACK 后可以通过它检查：
   * 服务端返回的 command_type 是否于原指令一致
   */
  command: ClientCommand;

  /**
   * 当前 Command 对应的本地用户消息
   *
   * chat.start 和 chat.submit 会有 MessageId
   * run.cancel 等非消息指令为 null
   */
  messageId: MessageId | null;

  /**
   * 当前 Command 是否属于新绘画首条 prompt
   *
   * chat.start 保存对应的 ChatId
   * 其他指令为 null
   *
   * 服务端接收 chat.start 后
   * 需要根据这个 ChatId 删除 InitialPromptIntent
   */
  initialPromptChatId: ChatId | null;

  /**
   * 等待服务器 ACK 的超时定时器
   *
   * 收到 accepted/rejected 后要清除
   * 超时后将消息标记为 delivery_unknown
   */
  timeoutId: ReturnType<typeof setTimeout>;
}

/**
 * 已有会话中一条可安全重试的发送意图。
 *
 * 只保存在全局 IMService 内存中；服务端接受 Command 后立即删除。
 */
interface RetryableSubmitMessage {
  chatId: ChatId;
  messageId: MessageId;
  content: string;
  modelId: string | null;
  idempotencyKey: IdempotencyKey;
  createdAt: number;
}

/**
 * IMService 的默认配置
 *
 * Required<IMServiceOptions> 会把可选字段转为必填字段
 * 保证 Service 内部读取配置时不需要反复判断 undefined
 */
const DEFAULT_OPTIONS: Required<IMServiceOptions> = {
  /**
   * command 发送 15 秒后仍未收到 ACK
   * 就进入 delivery_unknown
   */
  commandAckTimeoutMs: 15_000,
  commandSendMaxAttempts: 3,
  commandSendRetryDelayMs: 500,
};

/** 使用异步定时器等待，不阻塞浏览器主线程。 */
function waitForRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

/**
 * IMService 最多记住多少条已经处理过的服务端事件 ID
 *
 * 全局 WebSocket 可能长时间运行
 * 如果无限保存 EventId，会造成内存持续增长
 */
const MAX_REMEMBERED_EVENT_IDS = 2_048;

/**
 * ACK 超时后继续保留 Command 的时间。
 *
 * 这段时间内仍可处理迟到的 accepted/rejected；到期后必须清理，
 * 避免全局 IMService 长时间运行时 pendingCommand 无限增长。
 */
const LATE_ACK_RETENTION_MS = 5 * 60_000;

/**
 * 生成前端业务 ID
 *
 * ChatId、MessageId、RequestID、IdempotencyKey
 * 当前都使用浏览器生成的 UUID
 *
 * 虽然它们底层都是 string
 * 但会通过不同字段和 TypeScript 类型表达不同语义
 */
function createId(): string {
  return crypto.randomUUID();
}

/**
 * 判断一个 unknown 值是否是非 null 对象
 *
 * JSON.parse() 和 catch 中拿到的数据都不可信
 * 不能直接访问 value.type、value.code 等属性
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * 把任意异常转化为前端统一使用的 IMError
 *
 * error 可能是
 * - Error 实例
 * - 字符串
 * - null
 * - 后端返回的未知对象
 */
function normalizeError(error: unknown, fallback: IMError): IMError {
  if (error instanceof Error) {
    return {
      ...fallback,

      /**
       * 保留调用位置规定的 code 和 retryable
       * 只使用真实 Error 和 message
       */
      message: error.message || fallback.message,
    };
  }
  return fallback;
}

/**
 * 判断字符串是不是当前前端认识的 ServerEvent type
 *
 * 返回值中的 `type is ServerEvent['type']`
 * 是 TypeScript 类型谓词
 */
function isSupportedServerEventType(type: string): type is ServerEvent['type'] {
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
 * 把 Transport 收到的原始 JSON 字符串转化为 ServerEvent
 *
 * 只检查最外层核心字段
 * - 必须是对象
 * - type 必须是受支持的事件名称
 * - event_id 必须是字符串
 * - timestamp 必须是数字
 * - 必须存在 payload
 */
function parseServerEvent(raw: string): ServerEvent {
  const parsed: unknown = JSON.parse(raw);

  if (!isRecord(parsed)) {
    throw new Error('服务端 IM 消息不是对象');
  }

  if (typeof parsed.type !== 'string' || !isSupportedServerEventType(parsed.type)) {
    throw new Error('服务端事件 IM 事件类型不受支持');
  }

  if (typeof parsed.event_id !== 'string') {
    throw new Error('服务端 IM 事件缺少 event_id');
  }

  if (typeof parsed.timestamp !== 'number') {
    throw new Error('服务端 IM 事件缺少 timestamp');
  }

  if (!('payload' in parsed)) {
    throw new Error('服务端 IM 事件缺少 payload');
  }

  return parsed as unknown as ServerEvent;
}

/**
 * 全局 IM Service
 *
 * 它位于页面和 Tansport 之间：
 *
 * 页面调用 IMSerivce 的业务方法
 * IMService 调用 Transport 完成 WebSocket 通信
 * IMService 收到服务端事件后更新 zustand Store
 */
export class IMService implements IMServicePublicApi {
  /**
   * initialize() 是否已经执行
   *
   * 用于防止重复注册 Transport 监听器
   */
  private initialized = false;

  /**
   * Transport 监听器的取消函数
   *
   * destroy() 时调用，避免 Service 销毁后继续收到事件
   */
  private unsubscribeTransport: IMTransportUnsubscribe | null = null;

  /**
   * 应用层心跳定时器
   *
   * 收到 connection.ready 后创建
   * 断开连接或销毁 Service 时清除
   */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * 等待服务端 ACK 的客户端 Command
   *
   * Key 是 RequestId
   * Value 是对应的 PendingCommand
   */
  private readonly pendingCommand = new Map<RequestId, PendingCommand>();

  /** 已有会话中，尚未被服务端接受的用户消息发送意图。 */
  private readonly retryableSubmitMessages = new Map<MessageId, RetryableSubmitMessage>();

  /**
   * 已经处理过的服务端 EventId
   *
   * 用于过滤服务端重复下发或断线续传产生的重复事件
   */
  private readonly processedEventIds = new Set<EventId>();

  /**
   * EventId 的进入顺序
   *
   * Set 只能判断是否存在，不能方便地知道哪个最旧
   * 因此额外使用数组记录顺序，超过上限时删除最旧记录
   */
  private readonly processedEventOrder: EventId[] = [];

  /** 登录恢复期间的会话列表请求；React StrictMode 下复用同一请求。 */
  private chatListLoadPromise: Promise<void> | null = null;

  /** 同一个 Chat 的并发快照请求只执行一次。 */
  private readonly chatSnapshotLoadPromises = new Map<ChatId, Promise<void>>();

  /** 注销后递增，使已经发出的旧账号 REST 响应不能再写入 Store。 */
  private historyLoadGeneration = 0;

  /**
   * 合并默认值后的最终配置
   *
   * 类内部读取时所有字段都一定存在
   */
  private readonly options: Required<IMServiceOptions>;

  /**
   * 创建 IMService
   *
   * 构造函数只保存依赖和配置
   * 不注册监听器，也不连接 WebSocket
   *
   * 真正的初始化由 initialize() 完成
   */
  constructor(
    private readonly dependencies: IMServiceDependencies,
    options: IMServiceOptions = {},
  ) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
    };

    if (
      !Number.isFinite(this.options.commandAckTimeoutMs) ||
      this.options.commandAckTimeoutMs <= 0
    ) {
      throw new Error('commandAckTimeoutMs 必须是大于 0 的有限数字');
    }

    if (
      !Number.isInteger(this.options.commandSendMaxAttempts) ||
      this.options.commandSendMaxAttempts <= 0
    ) {
      throw new Error('commandSendMaxAttempts 必须是大于 0 的整数');
    }

    if (
      !Number.isFinite(this.options.commandSendRetryDelayMs) ||
      this.options.commandSendRetryDelayMs < 0
    ) {
      throw new Error('commandSendRetryDelayMs 必须是大于等于 0 的有限数字');
    }
  }

  /**
   * 初始化 IMService
   *
   * 只建立 IMService 和 Transport 之间的监听关系
   * 不会主动连接后端
   *
   * 可以在 React 渲染前调用
   */
  initialize(): void {
    if (this.initialized) {
      return;
    }

    this.initialized = true;

    /**
     * 注册全局唯一的 Transport 监听器
     */
    this.unsubscribeTransport = this.dependencies.transport.subscribe(this.handleTransportEvent);

    /**
     * Transport 可能比 IMService 更早创建
     * 因此初始化时主动同步一次当前状态
     */
    this.dependencies.store.getState().setConnectionState(this.dependencies.transport.getState());
  }

  connect(): Promise<void> {
    this.initialize();

    return this.dependencies.transport.connect();
  }

  disconnect(): void {
    this.clearHeartbeat();
    this.dependencies.transport.disconnect();
  }

  getStore(): IMStoreApi {
    return this.dependencies.store;
  }

  loadChats(): Promise<void> {
    if (this.chatListLoadPromise) {
      return this.chatListLoadPromise;
    }

    const fetchChats = this.dependencies.fetchChats;

    if (!fetchChats) {
      return Promise.reject(new Error('IM Chat 列表加载器未配置'));
    }

    const generation = this.historyLoadGeneration;
    const request = fetchChats().then((chats) => {
      if (generation !== this.historyLoadGeneration) {
        return;
      }

      const store = this.dependencies.store.getState();

      for (const chat of chats) {
        store.upsertChat(chat);
      }
    });

    this.chatListLoadPromise = request;
    void request.then(
      () => {
        if (this.chatListLoadPromise === request) {
          this.chatListLoadPromise = null;
        }
      },
      () => {
        if (this.chatListLoadPromise === request) {
          this.chatListLoadPromise = null;
        }
      },
    );
    return request;
  }

  loadChatSnapshot(chatId: ChatId): Promise<void> {
    const currentRequest = this.chatSnapshotLoadPromises.get(chatId);

    if (currentRequest) {
      return currentRequest;
    }

    const fetchChatSnapshot = this.dependencies.fetchChatSnapshot;

    if (!fetchChatSnapshot) {
      return Promise.reject(new Error('IM Chat 快照加载器未配置'));
    }

    const generation = this.historyLoadGeneration;
    const request = fetchChatSnapshot(chatId).then((snapshot) => {
      if (generation !== this.historyLoadGeneration) {
        return;
      }

      this.dependencies.store.getState().applyChatSnapshot(snapshot);
    });

    this.chatSnapshotLoadPromises.set(chatId, request);
    void request.then(
      () => {
        if (this.chatSnapshotLoadPromises.get(chatId) === request) {
          this.chatSnapshotLoadPromises.delete(chatId);
        }
      },
      () => {
        if (this.chatSnapshotLoadPromises.get(chatId) === request) {
          this.chatSnapshotLoadPromises.delete(chatId);
        }
      },
    );
    return request;
  }

  async renameChat({ chatId, title }: RenameChatInput): Promise<void> {
    const normalizedTitle = title.trim();

    if (!normalizedTitle) {
      throw new Error('会话标题不能为空');
    }

    const updateChatTitle = this.dependencies.updateChatTitle;

    if (!updateChatTitle) {
      throw new Error('IM Chat 标题更新器未配置');
    }

    const chat = await updateChatTitle(chatId, normalizedTitle);
    this.dependencies.store.getState().upsertChat(chat);
  }

  async deleteChat(chatId: ChatId): Promise<void> {
    const deleteChat = this.dependencies.deleteChat;

    if (!deleteChat) {
      throw new Error('IM Chat 删除器未配置');
    }

    await deleteChat(chatId);
    this.invalidateHistoryLoads();
    this.dependencies.store.getState().removeChat(chatId);
  }

  async openChat(chatId: ChatId): Promise<void> {
    const intents = this.dependencies.store.getState().initialPromptIntentsByChatId;

    if (Object.hasOwn(intents, chatId)) {
      await this.sendInitialPrompt(chatId);
      return;
    }

    await this.loadChatSnapshot(chatId);
  }

  resetBusinessState(): void {
    this.invalidateHistoryLoads();
    this.dependencies.store.getState().resetBusinessState();
  }

  private invalidateHistoryLoads(): void {
    this.historyLoadGeneration += 1;
    this.chatListLoadPromise = null;
    this.chatSnapshotLoadPromises.clear();
  }

  /**
   * Transport 的统一事件入口
   *
   * 是用箭头函数是为了固定 this
   * 将函数传给 subscribe() 后
   * 函数内部仍然能访问当前 IMService 实例
   */
  private readonly handleTransportEvent = (event: IMTransportEvent): void => {
    if (event.type === 'state.changed') {
      /**
       * 将 WebSocket 物理连接状态同步到 store
       */
      this.dependencies.store.getState().setConnectionState(event.state);

      if (event.state.status !== 'connected') {
        /**
         * 物理连接断开后，当前 connectionId 和 pong 时间失效
         *
         * cursor 不能清除
         * 因为后续重连还需要使用它请求时间续传
         */
        this.clearHeartbeat();

        this.dependencies.store.getState().updateSessionState({
          connectionId: null,
          lastPongAt: null,
        });
      }

      return;
    }

    /**
     * message.received 携带服务端原始 JSON 字符串
     */
    this.handleRawServerMessage(event.data);
  };

  /**
   * 服务端原始字符串的统一入口
   *
   * 当前已完成 JSON 解析
   */
  private handleRawServerMessage(raw: string): void {
    try {
      const event = parseServerEvent(raw);
      this.handleServerEvent(event);
    } catch (error) {
      this.reportError(
        normalizeError(error, {
          code: 'IM_EVENT_HANDLE_FAILED',
          message: '服务端 IM 事件处理失败',
          retryable: false,
        }),
      );
    }
  }

  /**
   * 服务端事件的开发期入口。
   *
   * 当前先完成事件去重，具体的事件分发会在后续模块逐步补充。
   * 这里不能直接抛错，否则开发期间后端只要下发一条消息，
   * 就会让页面不断进入错误状态。
   */
  private handleServerEvent(event: ServerEvent): void {
    /** 第一层：通过 EventId 过滤完全重复的事件。 */
    if (!this.rememberEvent(event.event_id)) {
      return;
    }

    /**
     * 第二层：保存全局事件流 Cursor。
     * 断线重连后可以从这个位置继续请求事件。
     */
    if (event.cursor !== null) {
      this.dependencies.store.getState().updateSessionState({
        cursor: event.cursor,
      });
    }

    /** 第三层：过滤同一个 Run 中重复或更旧的事件。 */
    if (!this.acceptRunSequence(event.run_id, event.seq)) {
      return;
    }

    /**
     * 当前模块先接入 Command ACK。
     * 其他事件会在后面的模块中逐步添加。
     */
    switch (event.type) {
      case 'connection.ready':
        this.handleConnectionReady(event);
        return;

      case 'command.accepted':
        this.handleCommandAccepted(event);
        return;

      case 'command.rejected':
        this.handleCommandRejected(event);
        return;

      case 'run.created':
      case 'run.status':
        this.handleRunSnapshot(event);
        return;

      case 'step.started':
      case 'step.progress':
      case 'step.completed':
      case 'step.failed':
        this.handleStepSnapshot(event);
        return;

      case 'message.started':
      case 'message.completed':
        this.handleMessageSnapshot(event);
        return;

      case 'message.delta':
        this.handleMessageDelta(event);
        return;

      case 'pong':
        this.handlePong(event);
        return;

      case 'error':
        this.reportError(event.payload.error);
        return;

      default:
        /** 尚未接入的服务端事件暂时安全忽略。 */
        return;
    }
  }

  /**
   * 记录一条服务端 EventId。
   *
   * @returns true 表示第一次收到；false 表示重复事件。
   */
  private rememberEvent(eventId: EventId): boolean {
    if (this.processedEventIds.has(eventId)) {
      return false;
    }

    this.processedEventIds.add(eventId);
    this.processedEventOrder.push(eventId);

    /** 限制去重记录数量，避免全局连接长期运行时无限占用内存。 */
    if (this.processedEventOrder.length > MAX_REMEMBERED_EVENT_IDS) {
      const oldestEventId = this.processedEventOrder.shift();

      if (oldestEventId) {
        this.processedEventIds.delete(oldestEventId);
      }
    }

    return true;
  }

  /**
   * 检查同一个 Agent Run 中的事件顺序。
   *
   * seq 小于等于 lastSeq 表示重复或旧事件；seq 跳号则说明中间
   * 事件可能丢失，需要把 Run 标记为 desynced，供后续快照校准。
   */
  private acceptRunSequence(runId: RunId | null, seq: number | null): boolean {
    /** ACK、connection.ready、pong 等事件不属于某个 Run。 */
    if (runId === null || seq === null) {
      return true;
    }

    const store = this.dependencies.store.getState();
    const run = store.runsById[runId];

    /** run.created 到达前本地没有 Run，由后续事件处理器负责创建。 */
    if (!run) {
      return true;
    }

    if (seq <= run.lastSeq) {
      return false;
    }

    const hasSequenceGap = seq > run.lastSeq + 1;

    store.upsertRun({
      ...run,
      lastSeq: seq,
      desynced: run.desynced || hasSequenceGap,
      updatedAt: Date.now(),
    });

    return true;
  }

  /**
   * 根据 RequestId 取出一条正在等待 ACK 的 Command。
   *
   * 一条 Command 只处理一次最终 ACK，因此取出时同时清除
   * 超时定时器和 pendingCommand 中的记录。
   */
  private takePendingCommand(requestId: RequestId): PendingCommand | null {
    const pending = this.pendingCommand.get(requestId);

    if (!pending) {
      /** 重复 ACK 或刷新前遗留的 ACK 无需再次处理。 */
      return null;
    }

    clearTimeout(pending.timeoutId);
    this.pendingCommand.delete(requestId);

    return pending;
  }

  /** 处理服务端接受 Command 的事件。 */
  private handleCommandAccepted(event: Extract<ServerEvent, { type: 'command.accepted' }>): void {
    const pending = this.takePendingCommand(event.request_id);

    if (!pending) {
      return;
    }

    /** 服务端确认的 Command 类型必须与前端原始 Command 一致。 */
    if (pending.command.type !== event.payload.command_type) {
      this.reportError({
        code: 'IM_ACK_COMMAND_MISMATCH',
        message: '服务端 ACK 与客户端 Command 类型不一致。',
        retryable: false,
      });
      return;
    }

    const store = this.dependencies.store.getState();

    /**
     * chat.start 和 chat.submit 都关联一条本地用户消息。
     * ACK 表示用户消息已被服务端接受，不代表 AI 回答已经完成。
     */
    if (pending.messageId) {
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

      /** Command 已被服务端接受，不再需要保留本地重试意图。 */
      this.retryableSubmitMessages.delete(pending.messageId);
    }

    /**
     * chat.start 被确认后删除首次发送意图，避免页面再次渲染时
     * 重复发送相同 Prompt。
     */
    if (pending.initialPromptChatId) {
      store.removeInitialPromptIntent(pending.initialPromptChatId);
    }
  }

  /** 处理服务端拒绝 Command 的事件。 */
  private handleCommandRejected(event: Extract<ServerEvent, { type: 'command.rejected' }>): void {
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

    /** 旧请求迟到的 rejected 不能覆盖首条 Prompt 的新请求状态。 */
    const isLatestInitialRequest = !intent || intent.lastRequestId === event.request_id;

    if (pending.messageId && isLatestInitialRequest) {
      this.markMessageFailed(pending.messageId, event.payload.error);

      /** 明确不可重试的拒绝不再占用 Service 内存。 */
      if (!event.payload.error.retryable) {
        this.retryableSubmitMessages.delete(pending.messageId);
      }
    }

    /** 保留被拒绝的首次发送意图，方便后续实现手动重试。 */
    if (pending.initialPromptChatId && isLatestInitialRequest) {
      store.updateInitialPromptIntent(pending.initialPromptChatId, {
        status: 'rejected',
        error: event.payload.error,
      });
    }

    /** run.cancel 不关联 Message，拒绝原因记录为全局 IM 错误。 */
    if (!pending.messageId && !pending.initialPromptChatId) {
      this.reportError(event.payload.error);
    }
  }

  /**
   * 把 Service 运行错误同步到连接状态中
   *
   * 当前 Store 还没有单独的全局错误队列
   * 所以暂时保存到 connection.lastError
   */
  private reportError(error: IMError): void {
    const store = this.dependencies.store.getState();

    store.setConnectionState({
      ...store.connection,
      lastError: error,
    });
  }

  /**
   * 清除应用层心跳定时器
   *
   * 可以重复调用，没有心跳时不会产生副作用
   */
  private clearHeartbeat(): void {
    if (!this.heartbeatTimer) {
      return;
    }

    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  /**
   * 将一条本地消息标记为发送失败
   */
  private markMessageFailed(messageId: MessageId, error: IMError): void {
    /**
     * 必须重新调用 getState() 获取最新状态
     * 不一定包含刚刚通过 upsertMessage() 写入的消息
     */
    const store = this.dependencies.store.getState();
    const message = store.messagesById[messageId];

    if (!message) {
      return;
    }

    /**
     * 如果消息已经完成，迟到的失败结果不能覆盖成功状态
     */
    if (message.status === 'completed') {
      return;
    }

    const now = Date.now();

    store.upsertMessage({
      ...message,
      status: 'failed',
      updatedAt: now,
      completedAt: now,
      error,
    });
  }

  /**
   * 处理服务端的连接就绪事件
   *
   * WebSocket onopen 只表示物理连接已经打开
   * connection.ready 表示服务端 IM 协议已经准备完成
   */
  private handleConnectionReady(event: Extract<ServerEvent, { type: 'connection.ready' }>): void {
    this.dependencies.store.getState().updateSessionState({
      /**
       * 服务端为当前这次物理连接分配的ID
       *
       * WebSocket 重连后通常会得到新的 connectionId
       */
      connectionId: event.payload.connection_id,
      lastPongAt: Date.now(),
    });

    /**
     * 心跳间隔由服务端决定
     *
     * 例如服务端要求每 15 秒发送一次 ping
     * 前端就按照 15 秒创建定时器
     */
    this.startHeartbeat(event.payload.heartbeat_interval_ms);
  }

  /**
   * 启动应用层 ping/pong 心跳
   *
   * 心跳属于整个全局 WebSocket 连接
   * 不属于某个 Chat 或某个 Run
   */
  private startHeartbeat(intervalMs: number): void {
    /**
     * 重连后可能再次收到 connection.ready
     *
     * 创建定时器前必须先清除旧定时器
     * 避免同时存在多个 Ping 定时器
     */
    this.clearHeartbeat();

    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      return;
    }

    /**
     * 最小间隔限制为 1s
     * 防止错误的服务端配置导致高频循环发送
     */
    const safeIntervalMs = Math.max(intervalMs, 1000);

    this.heartbeatTimer = setInterval(() => {
      /**
       * 定时器触发需要重新检查连接状态
       *
       * WebSocket 断开以后不能继续发送 Ping
       */
      if (this.dependencies.transport.getState().status !== 'connected') {
        return;
      }

      const now = Date.now();

      /**
       * Ping 也是一条客户端 Command
       * 但它不属于 Chat、Run，也不需要幂等键
       */
      const command: ClientCommand = {
        type: 'ping',
        request_id: createId(),
        idempotency_key: null,
        chat_id: null,
        run_id: null,
        timestamp: now,
        payload: {
          client_time: now,
        },
      };

      try {
        /**
         * Ping 不进入 pendingCommand ACK 队列
         *
         * 普通业务 Command 等待
         * command.accepted / command.rejected
         *
         * Ping 单独等待 pong
         */
        this.dependencies.transport.send(JSON.stringify(command));
      } catch (error) {
        this.reportError(
          normalizeError(error, {
            code: 'IM_HEARTBEAT_SEND_FAILED',
            message: 'IM 心跳发送失败。',
            retryable: true,
          }),
        );
      }
    }, safeIntervalMs);
  }

  /**
   * 处理服务端返回的 Pong
   *
   * lastPongAt 可以用于：
   * - 显示连接后活跃状态
   * - 判断连接是否可能假死
   * - 后续实现心跳超时重连
   */
  private handlePong(_event: Extract<ServerEvent, { type: 'pong' }>): void {
    this.dependencies.store.getState().updateSessionState({
      lastPongAt: Date.now(),
    });
  }

  /**
   * 彻底销毁 IMService 当前运行状态
   *
   * 普通路由切换不能调用
   */
  destroy(): void {
    this.clearHeartbeat();
    this.invalidateHistoryLoads();

    /**
     * 清除所有等待 ACK 的超时定时器
     */
    for (const pending of this.pendingCommand.values()) {
      clearTimeout(pending.timeoutId);
    }

    this.pendingCommand.clear();
    this.retryableSubmitMessages.clear();
    this.processedEventIds.clear();
    this.processedEventOrder.length = 0;

    /**
     * 主动断开 WebSocket
     */
    this.dependencies.transport.disconnect();

    /**
     * 取消 Transport 监听
     */
    this.unsubscribeTransport?.();
    this.unsubscribeTransport = null;

    /**
     * 允许后续重新 initialize()
     */
    this.initialized = false;
  }

  /**
   * 准备一个新会话
   *
   * 这个阶段只负责：
   * - 由前端生成 ChatId
   * - 提前创建一条本地 Chat
   * - 保存“进入聊天页后自动发送 prompt”的意图
   *
   * 这里不会真正发送 WebSocket 命令
   * 页面拿到 ChatId 后，可以立刻跳转到 /chat/:chatId
   */
  prepareNewChat(input: PrepareNewChatInput): ChatId {
    const prompt = input.prompt.trim();

    if (!prompt) {
      throw new Error('新会话 Prompt 不能为空');
    }

    /**
     * 这些 ID 在真正发送消息以前就确定下来
     *
     * chatId：标识这次会话，用于路由跳转和后续所有事件归属
     *
     * messageId：
     *   标识用户即将发送第一条消息
     *   即使发送失败后重试，也应该继续使用这个 messageId
     *
     * idempotencyKey：
     *   用于保证同一次首次 Prompt 重试时，不会被服务端重复执行
     */
    const chatId: ChatId = createId();
    const messageId: MessageId = createId();
    const idempotencyKey: IdempotencyKey = createId();

    const now = Date.now();
    const title = input.title?.trim() || null;

    /**
     * 如果调用方没有提供标题，先截取 Prompt 的前 30 个字符
     * 作为前端展示用的临时标题
     *
     * 后续服务端生成正式标题后，可以通过 upsertChat 覆盖
     */
    const optimisticTitle = title ?? prompt.slice(0, 30);

    const store = this.dependencies.store.getState();

    /**
     * 先把 Chat 写入 store
     *
     * 因此页面跳转到 /chat/:chatId 后
     * 即使服务端还没有收到请求，页面也能立即找到该对话
     */
    store.upsertChat({
      id: chatId,
      title: optimisticTitle,
      createdAt: now,
      updatedAt: now,
    });

    /**
     * 保存首次 Prompt 的发送意图
     *
     * Chat 页面加载后会调用 sendInitialPrompt(chatid)
     * 该方法会查询这里保存的数据，决定是否需要自动发送
     *
     * 历史会话没有 InitialPromptIntent
     * 所以进入历史会话页面时不会重复发送消息
     */
    store.registerInitialPromptIntent({
      chatId,
      messageId,
      prompt,
      modelId: input.modelId?.trim() || null,
      title,
      idempotencyKey,
      status: 'pending',
      createdAt: now,
      lastRequestId: null,
      error: null,
    });

    return chatId;
  }

  /**
   * 统一发送一条客户端 command
   *
   * 所有需要服务端 ACK 的业务指令都会经过这里，例如：
   * - chat.start
   * - chat.submit
   * - run.cancel
   *
   * context 用来记录这条 command 和本地业务数据之间的关系
   */
  private async dispatchCommand(
    command: ClientCommand,
    context: Pick<PendingCommand, 'messageId' | 'initialPromptChatId'>,
  ): Promise<void> {
    /**
     * 发送前确保 WebSocket 已经建立
     *
     * connect() 内部具有连接复用能力
     * 已连接时直接返回，连接时复用同一个 promise
     */
    await this.connect();

    /**
     * Transport 在未配置 URL 时可能进入 disabled
     * 此时 connect() 虽然正常结束，但并没有可用的 WebSocket
     */
    if (this.dependencies.transport.getState().status !== 'connected') {
      throw new Error('IM WebSocket 当前不可用');
    }

    /**
     * Protocol 中定义的是 TypeScript 对象
     * WebSocket 实际发送的必须是字符串，因此需要序列化
     *
     * send() 成功只代表数据已经交给浏览器
     * 不代表服务器已经接收或处理
     */
    this.dependencies.transport.send(JSON.stringify(command));

    /**
     * 开始等待服务端的业务 ACK
     *
     * 服务端后续需要返回：
     * - command.accepted
     * - command.rejected
     */
    const timeoutId = setTimeout(() => {
      this.handleCommandTimeout(command.request_id);
    }, this.options.commandAckTimeoutMs);

    /**
     * 使用 RequestId 保存 Command 的等待状态
     *
     * 后续收到 ACK 时，可以通过 event.request_id
     * 找到这里保存的 Command 和本地业务上下文
     */
    this.pendingCommand.set(command.request_id, {
      command,
      messageId: context.messageId,
      initialPromptChatId: context.initialPromptChatId,
      timeoutId,
    });
  }

  /**
   * 对“明确没有交给 WebSocket”的失败执行有限自动重试。
   *
   * dispatchCommand 一旦成功调用 transport.send() 就会正常返回，之后是否
   * 被服务端接受由 ACK 决定。因此这里不会重试 ACK 超时或服务端拒绝，避免
   * 把结果未知的 Command 当成未发送 Command。
   */
  private async dispatchCommandWithRetry(
    command: ClientCommand,
    context: Pick<PendingCommand, 'messageId' | 'initialPromptChatId'>,
  ): Promise<void> {
    let lastError: unknown = new Error('IM Command 发送失败');

    for (let attempt = 1; attempt <= this.options.commandSendMaxAttempts; attempt += 1) {
      try {
        await this.dispatchCommand(command, context);
        return;
      } catch (error) {
        lastError = error;

        if (attempt >= this.options.commandSendMaxAttempts) {
          break;
        }

        const delayMs = this.options.commandSendRetryDelayMs * 2 ** (attempt - 1);
        await waitForRetry(delayMs);
      }
    }

    throw lastError;
  }

  /**
   * Command 在规定时间内没有收到服务端 ACK
   *
   * 超时不等于服务端一定没有执行
   * 可能是服务端已经处理，但 ACK 在网络中丢失了
   *
   * 因此这里使用 delivery_unknown
   * 而不是直接将消息标记为 false
   */
  private handleCommandTimeout(requestId: RequestId): void {
    const pending = this.pendingCommand.get(requestId);

    /**
     * 找不到说明这条 Command 已经收到 ACK
     * 并且已经从 pendingCommand 中删除
     */
    if (!pending) {
      return;
    }

    const store = this.dependencies.store.getState();

    /**
     * 如果这是新会话的首条 Prompt
     * 找到它对应的 InitialPromptIntent
     */
    const intent = pending.initialPromptChatId
      ? store.initialPromptIntentsByChatId[pending.initialPromptChatId]
      : null;

    /**
     * 首条 Prompt 后续可能继续重试
     *
     * 旧请求的超时回调不能覆盖新请求的方法
     * 所以要确认当前 requestId 仍是最近一次发送
     */
    const isLatestInitialRequest = !intent || intent.lastRequestId === requestId;

    /**
     * 如果 command 对应一条本地用户消息
     * 将它标记为“投递结果未知”
     */
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

    /**
     * 同步更新首次 Prompt 意图
     *
     * 保留这个 Intent，后续才能支持用户重试，
     * 并继续复用原来的 MessageId 和 IdempotencyKey
     */
    if (pending.initialPromptChatId && isLatestInitialRequest) {
      store.updateInitialPromptIntent(pending.initialPromptChatId, {
        status: 'delivery_unknown',
        error: {
          code: 'IM_COMMAND_ACK_TIMEOUT',
          message: '等待服务端确认超时，本次操作是否完成暂时未知',
          retryable: true,
        },
      });
    }

    /**
     * 超时后短暂保留关联关系以接收迟到 ACK，但不能永久保留。
     * takePendingCommand() 收到迟到 ACK 时会清除这个回收定时器。
     */
    pending.timeoutId = setTimeout(() => {
      if (this.pendingCommand.get(requestId) === pending) {
        this.pendingCommand.delete(requestId);
      }
    }, LATE_ACK_RETENTION_MS);
  }

  /**
   * 处理服务端下发的完整 Message 快照
   *
   * message.started:
   * 创建一条准备开始流式输出的 Assistant 消息
   *
   * message.completed:
   * 使用服务端最终快照完成这条消息
   */
  private handleMessageSnapshot(
    event: Extract<
      ServerEvent,
      {
        type: 'message.started' | 'message.completed';
      }
    >,
  ): void {
    const message = event.payload.message;

    /**
     * 网络协议使用 snake_case
     * Store 内部领域对象使用 camelCase
     *
     * 这里就是协议数据与前端数据之间的转换边界
     */
    this.dependencies.store.getState().upsertMessage({
      id: message.message_id,
      chatId: message.chat_id,
      runId: message.run_id,
      role: message.role,
      status: message.status,

      /**
       * 创建新的 content 对象
       * 避免 Store 和网络事件共享同一个对象引用
       */
      content: {
        ...message.content,
      },

      createdAt: message.created_at,
      updatedAt: message.updated_at,
      completedAt: message.completed_at,
      error: message.error,
    });
  }

  /**
   * 处理 Assitant 消息的流式文本增量
   *
   */
  private handleMessageDelta(event: Extract<ServerEvent, { type: 'message.delta' }>): void {
    this.dependencies.store.getState().appendMessageDelta({
      /**
       * 找到需要追加文本的 Assistant Message
       */
      messageId: event.message_id,
      delta: event.payload.delta,
      updatedAt: event.timestamp,
    });
  }

  /**
   * 处理服务端下发的 Agent Run 快照
   *
   * run.created:
   * 服务端创建了一次新的 Agent 执行
   *
   * run.status:
   * Agent 执行状态发生变化
   */
  private handleRunSnapshot(
    event: Extract<
      ServerEvent,
      {
        type: 'run.created' | 'run.status';
      }
    >,
  ): void {
    const store = this.dependencies.store.getState();
    const wireRun = event.payload.run;

    /**
     * acceptRunSequence() 可能已经提前更新过当前 Run 的
     * lastSeq 和 desynced，因此需要读取最新状态
     */
    const currentRun = store.runsById[wireRun.run_id];

    /**
     * 将服务端的 snake_case 网络对象
     * 转化成 Store 使用的 camelCase 领域对象
     */
    store.upsertRun({
      id: wireRun.run_id,
      chatId: wireRun.chat_id,
      modelId: wireRun.model_id,

      /**
       * 触发本次 Run 的用户消息
       */
      inputMessageId: wireRun.input_message_id,

      outputMessageId: wireRun.output_message_id,

      status: wireRun.status,

      /** 复制数组，避免 Store 与网络事件共享可变引用。 */
      stepIds: [...wireRun.step_ids],

      /** Run 的事件进度只能向前推进，不能被旧快照覆盖。 */
      lastSeq: Math.max(wireRun.last_seq, event.seq, currentRun?.lastSeq ?? 0),

      /** 本地一旦发现序号缺口，普通状态事件不能直接清除它。 */
      desynced: wireRun.desynced || currentRun?.desynced === true,

      createdAt: wireRun.created_at,
      startedAt: wireRun.started_at,
      updatedAt: wireRun.updated_at,
      completedAt: wireRun.completed_at,
      error: wireRun.error,
    });
  }

  /**
   * 处理服务端下发的 Agent Step 快照。
   *
   * started、progress、completed、failed 都携带当前 Step 的完整状态。
   */
  private handleStepSnapshot(
    event: Extract<
      ServerEvent,
      {
        type: 'step.started' | 'step.progress' | 'step.completed' | 'step.failed';
      }
    >,
  ): void {
    const wireStep = event.payload.step;
    const store = this.dependencies.store.getState();

    /** 所有 Step 共有的字段，具体 kind 在下面的分支中补充。 */
    const base = {
      id: wireStep.step_id,
      chatId: wireStep.chat_id,
      runId: wireStep.run_id,
      title: wireStep.title,
      status: wireStep.status,
      sequence: wireStep.sequence,
      parentStepId: wireStep.parent_step_id,
      startedAt: wireStep.started_at,
      completedAt: wireStep.completed_at,
      error: wireStep.error,
    };

    /** kind 是可辨识字段，TypeScript 会据此推断每类 Step 的专属字段。 */
    switch (wireStep.kind) {
      case 'reasoning':
        store.upsertStep({
          ...base,
          kind: 'reasoning',
          /** 只保存允许公开展示的摘要，不承载模型隐藏思维链。 */
          summary: wireStep.summary,
        });
        return;

      case 'tool':
        store.upsertStep({
          ...base,
          kind: 'tool',
          callId: wireStep.call_id,
          tool: { ...wireStep.tool },
          /** 输入输出暂用 unknown，当前 UI 可以只展示工具名称。 */
          input: wireStep.input,
          output: wireStep.output,
        });
        return;

      case 'skill':
        store.upsertStep({
          ...base,
          kind: 'skill',
          callId: wireStep.call_id,
          skill: { ...wireStep.skill },
          input: wireStep.input,
          output: wireStep.output,
        });
        return;

      case 'retrieval':
        store.upsertStep({
          ...base,
          kind: 'retrieval',
          retrievalId: wireStep.retrieval_id,
          query: wireStep.query,
          /** RAG 文档结构暂未确定，复制 unknown[] 作为占位数据。 */
          documents: [...wireStep.documents],
        });
        return;
    }
  }

  /**
   * 发送新会话已经登陆的首条 Prompt
   *
   * prepareNewChat() 只创建本地 Chat 和发送意图
   * 真正的 WebSocket 发送由这个方法完成
   *
   * 历史会话没有 InitialPromptIntent，因此不会自动发送
   */
  async sendInitialPrompt(chatId: ChatId): Promise<RequestId | null> {
    const store = this.dependencies.store.getState();
    const intent = store.initialPromptIntentsByChatId[chatId];

    /**
     * 没有发送意图，说明是历史会话
     * 或者没有首条 Prompt 已经成功发送并删除了 Intent
     */
    if (!intent) {
      return null;
    }

    /**
     * rejected 表示服务端明确拒绝了这条 Command
     * 暂时不进行自动重试，避免进入循环发送
     */
    if (intent.status === 'rejected') {
      return null;
    }

    /**
     * 如果已经处于 sending，就复用当前 RequestId
     * 不能就再次创建一条 chat.start Command
     */
    if (intent.status === 'sending') {
      return intent.lastRequestId;
    }

    const requestId: RequestId = createId();
    const now = Date.now();
    const existingMessage = store.messagesById[intent.messageId];

    /**
     * 在真正发送之前，先把用户消息写入 Store
     * 乐观更新
     */
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
      /** 重试首条 Prompt 时保留这条消息最初的创建时间。 */
      createdAt: existingMessage?.createdAt ?? now,
      updatedAt: now,
      completedAt: null,
      error: null,
    });

    /**
     * 发送前先把 Intent 改为 sending
     *
     * 这一步需要发生在 await 以前
     * 防止页面重复调用时再发送相同 Prompt
     */
    store.updateInitialPromptIntent(chatId, {
      status: 'sending',
      lastRequestId: requestId,
      error: null,
    });

    /**
     * 构造“创建新会话并提交第一条消息”的 Command
     *
     * ClientCommand 是联合类型
     */
    const command: ClientCommand = {
      type: 'chat.start',

      /**
       * 标识当前这一次发送操作
       * 服务端 ACK 会携带相同的 request_id
       */
      request_id: requestId,

      /**
       * 首次发送和重试必须复用相同的幂等键
       */
      idempotency_key: intent.idempotencyKey,

      chat_id: chatId,

      /**
       * chat.start 发生时还没有 Agent Run
       */
      run_id: null,

      timestamp: now,

      payload: {
        /**
         * 服务端必须采用前端提前生成的 MessageId
         * 才能和 Store 中的乐观消息对应起来
         */
        message_id: intent.messageId,

        model_id: intent.modelId,

        title: intent.title,

        content: {
          type: 'text',
          format: 'plain_text',
          content: intent.prompt,
        },
      },
    };

    try {
      /**
       * dispatchCommand() 负责：
       * - 确保 WebSocket 已连接
       * - 序列化并发送 Command
       * - 根据 RequestId 等待 ACK
       */
      await this.dispatchCommandWithRetry(command, {
        messageId: intent.messageId,
        initialPromptChatId: chatId,
      });
    } catch (error) {
      const imError = normalizeError(error, {
        code: 'IM_INITIAL_PROMPT_SEND_FAILED',
        message: '新会话首条消息发送失败',
        retryable: true,
      });

      /**
       * 发送阶段直接失败时恢复为 pending
       * 允许页面后续重新调用 sendInitialPrompt()
       */
      this.dependencies.store.getState().updateInitialPromptIntent(chatId, {
        status: 'pending',
        lastRequestId: null,
        error: imError,
      });

      this.markMessageFailed(intent.messageId, imError);

      throw error;
    }

    return requestId;
  }

  /**
   * 向一个已经存在的 Chat 发送用户信息
   */
  async submitMessage(input: SubmitMessageInput): Promise<RequestId> {
    const content = input.content.trim();

    if (!content) {
      throw new Error('消息内容不能为空');
    }

    const store = this.dependencies.store.getState();
    const chat = store.chatsById[input.chatId];

    /**
     * submitMessage 只能向已有会话发送消息
     */
    if (!chat) {
      throw new Error('需要发送消息的 chat 不存在');
    }

    /**
     * 每条消息都需要新的：
     *
     * messageId: 标识这条聊太消息
     * requestId: 标识本次发送操作
     * idempotencyKey: 防止本次操作后被后端重复执行
     */
    const messageId: MessageId = createId();
    const requestId: RequestId = createId();
    const idempotencyKey: IdempotencyKey = createId();
    const now = Date.now();

    /**
     * 在真正发送前保存可重试意图。
     * 自动重试或用户手动重试都会复用同一个 MessageId 和 IdempotencyKey。
     */
    this.retryableSubmitMessages.set(messageId, {
      chatId: input.chatId,
      messageId,
      content,
      modelId: input.modelId?.trim() || null,
      idempotencyKey,
      createdAt: now,
    });

    /**
     * 先把用户消息写入 Store，进行乐观更新
     */
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

    /**
     * 同步更新 Chat 的最后活动时间
     *
     * 后续会话列表可以根据 updatedAt 排序
     */
    store.upsertChat({
      ...chat,
      updatedAt: now,
    });

    /**
     * 构造向已有会话发送消息的 Command
     */
    const command: ClientCommand = {
      type: 'chat.submit',
      request_id: requestId,
      idempotency_key: idempotencyKey,
      chat_id: input.chatId,
      run_id: null,
      timestamp: now,
      payload: {
        message_id: messageId,
        model_id: input.modelId?.trim() || null,
        content: {
          type: 'text',
          format: 'plain_text',
          content,
        },
      },
    };

    try {
      await this.dispatchCommandWithRetry(command, {
        /**
         * 保存 MessageId
         *
         * 后续 ACK 超时或服务端拒绝时
         * 可以找到并修改这条乐观消息
         */
        messageId,
        initialPromptChatId: null,
      });
    } catch (error) {
      /**
       * 这里表示 Command 还没有成功交给 WebSocket
       * 例如连接建立失败或 Transport 不可用
       */
      this.markMessageFailed(
        messageId,
        normalizeError(error, {
          code: 'IM_MESSAGE_SEND_FAILED',
          message: '消息发送失败',
          retryable: true,
        }),
      );

      throw error;
    }

    return requestId;
  }

  /**
   * 重试一条明确失败的用户消息。
   *
   * 首条 Prompt 使用 Store 中的 InitialPromptIntent；普通消息使用
   * IMService 内存中的 retryableSubmitMessages。两者都保持原业务幂等身份。
   */
  async retryMessage(messageId: MessageId): Promise<RequestId> {
    const store = this.dependencies.store.getState();
    const message = store.messagesById[messageId];

    if (!message || message.role !== 'user') {
      throw new Error('需要重试的用户消息不存在');
    }

    if (message.status !== 'failed' || message.error?.retryable !== true) {
      throw new Error('当前消息不允许重试');
    }

    const initialIntent = store.initialPromptIntentsByChatId[message.chatId];

    if (initialIntent?.messageId === messageId) {
      /** 被服务端明确拒绝但允许重试时，先恢复为可发送状态。 */
      if (initialIntent.status === 'rejected') {
        store.updateInitialPromptIntent(message.chatId, {
          status: 'pending',
          lastRequestId: null,
          error: null,
        });
      }

      const requestId = await this.sendInitialPrompt(message.chatId);

      if (!requestId) {
        throw new Error('首条消息当前无法重试');
      }

      return requestId;
    }

    const intent = this.retryableSubmitMessages.get(messageId);

    if (!intent || intent.chatId !== message.chatId) {
      throw new Error('消息重试信息已经失效，请重新发送内容');
    }

    const requestId: RequestId = createId();
    const now = Date.now();

    store.upsertMessage({
      ...message,
      status: 'pending',
      updatedAt: now,
      completedAt: null,
      error: null,
    });

    const command: ClientCommand = {
      type: 'chat.submit',
      request_id: requestId,
      idempotency_key: intent.idempotencyKey,
      chat_id: intent.chatId,
      run_id: null,
      timestamp: now,
      payload: {
        message_id: intent.messageId,
        model_id: intent.modelId,
        content: {
          type: 'text',
          format: 'plain_text',
          content: intent.content,
        },
      },
    };

    try {
      await this.dispatchCommandWithRetry(command, {
        messageId: intent.messageId,
        initialPromptChatId: null,
      });
    } catch (error) {
      this.markMessageFailed(
        intent.messageId,
        normalizeError(error, {
          code: 'IM_MESSAGE_RETRY_FAILED',
          message: '消息重新发送失败',
          retryable: true,
        }),
      );

      throw error;
    }

    return requestId;
  }

  /**
   * 请求服务端取消一个正在执行的 Agent Run
   *
   * 这里发送的是取消请求
   * Run 最终是否取消成功仍以服务端事件为准
   */
  async cancelRun(input: CancelRunInput): Promise<RequestId> {
    const store = this.dependencies.store.getState();
    const run = store.runsById[input.runId];

    /**
     * run.cancel 必须指向一个已经存在的 Run
     *
     * 如果 Store 中不存在，通常说明：
     * - Run 事件还没有达到
     * - 页面传错了 RunId
     * - Run 数据还没有加载
     */
    if (!run) {
      throw new Error('需要取消的 Agent Run 不存在');
    }

    /**
     * 防止页面将其他 Chat 的 RunId 错误地传进来
     */
    if (run.chatId !== input.chatId) {
      throw new Error('Agent Run 不属于当前 Chat');
    }

    /**
     * 已经进入终态的 Run 不需要再次取消
     */
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      throw new Error('Agent Run 已经结束，无法再次取消');
    }

    const requestId: RequestId = createId();
    const idempotencyKey: IdempotencyKey = createId();
    const now = Date.now();

    /**
     * 构造取消 Run 的 Command
     *
     * runId 标识需要取消哪个 Agent 任务
     * requestId 标识这是哪一次取消操作
     */
    const command: ClientCommand = {
      type: 'run.cancel',
      request_id: requestId,
      idempotency_key: idempotencyKey,
      chat_id: input.chatId,
      run_id: input.runId,
      timestamp: now,
      payload: {
        reason: 'user_requested',
      },
    };

    /**
     * 取消操作不直接对应某条用户消息
     * 也不属于首次 Prompt 意图
     * 所以两个本地关联字段都是 null
     */
    await this.dispatchCommandWithRetry(command, {
      messageId: null,
      initialPromptChatId: null,
    });

    return requestId;
  }
}
