import type {
  ClientCommand,
  ServerEvent,
} from './protocol';
import type { IMStoreApi } from './store';
import type {
  IMTransport,
  IMTransportEvent,
  IMTransportUnsubscribe,
} from './transport';
import type {
  ChatId,
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
}

/**
 * 用户在首页创建新会话时输入的数据
 */
export interface PrepareNewChatInput {
  prompt: string;

  title?: string;
}

/**
 * 向一个已经存在的 Chat 发送消息时需要的数据
 */
export interface SubmitMessageInput {
  chatId: ChatId;
  content: string;
}

/**
 * 用户主动取消 Agent Run 时需要的数据
 */
export interface CancelRunInput {
  chatId: ChatId;
  runId: RunId;
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
}

/**
 * IMService 最多记住多少条已经处理过的服务端事件 ID
 * 
 * 全局 WebSocket 可能长时间运行
 * 如果无限保存 EventId，会造成内存持续增长
 */
const MAX_REMEMBERED_EVENT_IDS = 2_048;

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
    }
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
    case 'step.failed':
    case 'message.started':
    case 'message.delta':
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

  if (
    typeof parsed.type !== 'string' ||
    !isSupportedServerEventType(parsed.type)
  ) {
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
    }

    if (
      !Number.isFinite(this.options.commandAckTimeoutMs) ||
      this.options.commandAckTimeoutMs <= 0
    ) {
      throw new Error('commandAckTimeoutMs 必须是大于 0 的有限数字');
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
    this.unsubscribeTransport = this.dependencies.transport.subscribe(
      this.handleTransportEvent,
    )

    /**
     * Transport 可能比 IMService 更早创建
     * 因此初始化时主动同步一次当前状态
     */
    this.dependencies.store
      .getState()
      .setConnectionState(
        this.dependencies.transport.getState(),
      );
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

  /**
   * Transport 的统一事件入口
   * 
   * 是用箭头函数是为了固定 this
   * 将函数传给 subscribe() 后
   * 函数内部仍然能访问当前 IMService 实例
   */
  private readonly handleTransportEvent = (
    event: IMTransportEvent,
  ): void => {
    if (event.type === 'state.changed') {
      /**
       * 将 WebSocket 物理连接状态同步到 store
       */
      this.dependencies.store
        .getState()
        .setConnectionState(event.state);

      if (event.state.status !== 'connected') {
        /**
         * 物理连接断开后，当前 connectionId 和 pong 时间失效
         * 
         * cursor 不能清除
         * 因为后续重连还需要使用它请求时间续传
         */
        this.clearHeartbeat();

        this.dependencies.store
          .getState()
          .updateSessionState({
            connectionId: null,
            lastPongAt: null,
          })
      }

      return;
    }

    /**
     * message.received 携带服务端原始 JSON 字符串
     */
    this.handleRawServerMessage(event.data);
  }

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
        })
      )
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
    if (this.processedEventIds.has(event.event_id)) {
      return;
    }

    this.processedEventIds.add(event.event_id);
    this.processedEventOrder.push(event.event_id);

    if (this.processedEventOrder.length > MAX_REMEMBERED_EVENT_IDS) {
      const oldestEventId = this.processedEventOrder.shift();

      if (oldestEventId) {
        this.processedEventIds.delete(oldestEventId);
      }
    }

    // TODO: 后续在这里按照 event.type 分发并更新 Store。
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
    })
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
   * 彻底销毁 IMService 当前运行状态
   * 
   * 普通路由切换不能调用
   */
  destroy(): void {
    this.clearHeartbeat();

    /**
     * 清除所有等待 ACK 的超时定时器
     */
    for (const pending of this.pendingCommand.values()) {
      clearTimeout(pending.timeoutId);
    }

    this.pendingCommand.clear();
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
    const isLatestInitialRequest =
      !intent || intent.lastRequestId === requestId;
    
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
      store.updateInitialPromptIntent(
        pending.initialPromptChatId,
        {
          status: 'delivery_unknown',
          error: {
            code: 'IM_COMMAND_ACK_TIMEOUT',
            message: '等待服务端确认超时，本次操作是否完成暂时未知',
            retyrable: true,
          },
        },
      );
    }
  }

  /**
   * 开发期占位：历史会话或尚未接入发送模块时，不执行自动发送。
   * 后续实现首条 Prompt 模块时替换这里。
   */
  async sendInitialPrompt(_chatId: ChatId): Promise<RequestId | null> {
    return null;
  }

  /**
   * 开发期占位：保留稳定的页面调用接口。
   * 后续实现 Command 发送模块时替换这里。
   */
  async submitMessage(_input: SubmitMessageInput): Promise<RequestId> {
    throw new Error('IM 消息发送模块尚未实现');
  }

  /**
   * 开发期占位：保留稳定的页面调用接口。
   * 后续实现 Run 控制模块时替换这里。
   */
  async cancelRun(_input: CancelRunInput): Promise<RequestId> {
    throw new Error('IM Run 取消模块尚未实现');
  }
}
