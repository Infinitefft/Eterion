/**
 * IM 应用层协议。
 *
 * 这个文件定义浏览器与 Go API 通过 WebSocket 交换的数据结构，
 * 不负责建立连接、不负责保存业务状态，也不包含任何 React 逻辑。
 *
 * Wire 字段统一使用 camelCase，后端 JSON tag 必须与这里保持一致。
 */

/** 一个会话 Thread 的唯一标识，同时也是实时事件的路由键。 */
export type ThreadId = string;

/** 一条用户消息或 Assistant 正式回复的唯一标识。 */
export type MessageId = string;

/** 一次 Agent 执行的唯一标识，用于状态跟踪和取消。 */
export type RunId = string;

/** 一段可展示 Thinking 内容的唯一标识。 */
export type ThinkingId = string;

/** 一次 Tool 调用的唯一标识。 */
export type ToolCallId = string;

/** 一次 HITL 交互的唯一标识。 */
export type InteractionId = string;

/** 一次客户端命令的标识，只用于关联对应 ACK。 */
export type RequestId = string;

/** 后端模型目录中的稳定模型标识。 */
export type ModelId = string;

/** 协议中的时间统一使用 Unix 毫秒时间戳。 */
export type UnixTimestamp = number;

/**
 * Thread 内的事件序号。
 *
 * seqId 由服务端生成，并在同一个 Thread 内严格递增；
 * 不同 Thread 之间不要求形成全局顺序。
 */
export type SeqId = number;

/**
 * JSON 能安全表达的通用数据。
 *
 * Tool 的参数和结果使用这个类型，避免把函数、Date、undefined 等
 * 无法通过 JSON 传输的值误放进协议。
 */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** 服务端可以安全返回给前端的统一错误结构。 */
export interface ProtocolError {
  /** 稳定的机器可读错误码，业务逻辑不能匹配 message 文案。 */
  code: string;

  /** 面向用户或开发者的错误说明。 */
  message: string;
}

/**
 * Agent Run 的生命周期。
 *
 * Thinking、Tool、RAG 都是 running 期间发生的活动，
 * 不应该扩展成 calling_tool、retrieving 等 Run 状态。
 */
export type RunStatus =
  | 'pending' 
  | 'running' 
  | 'waiting_user' 
  | 'completed' 
  | 'failed' 
  | 'cancelled';

/** 协议中允许出现的消息角色。 */
export type MessageRole = 'user' | 'assistant';

/** 正式消息支持的文本格式。 */
export type MessageFormat = 'plain_text' | 'markdown';

/** 一条正式消息可能进入的终态。 */
export type MessageCompletionStatus = 'completed' | 'failed' | 'cancelled';

/** HITL 中需要用户回答的一道问题。 */
export interface HITLQuestion {
  /** 问题 ID，用来关联用户提交的答案。 */
  questionId: string;

  /** 展示给用户的问题正文。 */
  prompt: string;

  /** 没有 options 时，前端展示自由文本输入框。 */
  options?: string[];

  /** true 表示用户可以选择多个 options。 */
  multiple?: boolean;

  /** true 表示用户提交前必须回答该问题。 */
  required?: boolean;
}

/** 用户对一道 HITL 问题的回答。 */
export interface HITLAnswer {
  /** 对应 HITLQuestion.questionId。 */
  questionId: string;

  /** 文本题使用 string，多选题使用 string[]。 */
  value: string | string[];
}

/**
 * 创建 Thread 并发送首条消息。
 *
 * threadId 和 messageId 都由客户端提前生成；
 * 断线重发同一业务意图时必须复用这两个 ID。
 */
export interface ThreadStartCommand {
  /** type 是整个协议判别联合的判别字段。 */
  type: 'thread.start';

  /** 用于把当前命令与服务端 ACK 关联起来。 */
  requestId: RequestId;

  /** 客户端生成的永久 Thread ID。 */
  threadId: ThreadId;

  /** 客户端生成的首条用户消息 ID，同时承担消息幂等身份。 */
  messageId: MessageId;

  /** 创建 Thread 和启动 Agent 所需的数据。 */
  payload: {
    /** 用户输入的正文。 */
    content: string;

    /** 省略时由服务端选择默认模型。 */
    modelId?: ModelId;
  };
}

/** 向已经存在的 Thread 发送一条用户消息。 */
export interface MessageSendCommand {
  /** 命令类型。 */
  type: 'message.send';

  /** 用于把当前命令与服务端 ACK 关联起来。 */
  requestId: RequestId;

  /** 目标 Thread。 */
  threadId: ThreadId;

  /**
   * 客户端生成的稳定消息 ID。
   * 它本身承担业务幂等，不再额外发送 idempotencyKey。
   */
  messageId: MessageId;

  /** 本次消息数据。 */
  payload: {
    /** 用户输入的正文。 */
    content: string;

    /** 省略时沿用服务端默认模型。 */
    modelId?: ModelId;
  };
}

/** 取消一次仍未结束的 Agent Run。 */
export interface RunCancelCommand {
  /** 命令类型。 */
  type: 'run.cancel';

  /** 用于把当前命令与服务端 ACK 关联起来。 */
  requestId: RequestId;

  /** Run 所属的 Thread。 */
  threadId: ThreadId;

  /** 要取消的 Run。 */
  runId: RunId;
}

/** 回答一次正在等待用户输入的 HITL 交互。 */
export interface InteractionRespondCommand {
  /** 命令类型。 */
  type: 'interaction.respond';

  /** 用于把当前命令与服务端 ACK 关联起来。 */
  requestId: RequestId;

  /** HITL 所属的 Thread。 */
  threadId: ThreadId;

  /** 当前处于 waiting_user 的 Run。 */
  runId: RunId;

  /** 要回答的 HITL 交互。 */
  interactionId: InteractionId;

  /** 用户提交的数据。 */
  payload: {
    /** 本次提交的全部答案。 */
    answers: HITLAnswer[];
  };
}

/** 客户端允许发送的全部应用层命令。 */
export type ClientCommand =
  ThreadStartCommand | MessageSendCommand | RunCancelCommand | InteractionRespondCommand;

/** 自动从 ClientCommand 联合中提取命令名称，避免重复维护枚举。 */
export type ClientCommandType = ClientCommand['type'];

/**
 * 命令被服务端接受后的 ACK。
 *
 * ACK 只表示命令已经校验并持久化，
 * 不表示 Agent 已经开始或已经执行完成。
 */
export interface AckAcceptedFrame {
  /** ACK 的固定消息类型。 */
  type: 'ack';

  /** true 是成功 ACK 的判别字段。 */
  ok: true;

  /** 对应客户端命令的 requestId。 */
  requestId: RequestId;

  /** 服务端生成 ACK 的 Unix 毫秒时间。 */
  timestamp: UnixTimestamp;

  /** 被接受的命令类型。 */
  commandType: ClientCommandType;

  /** 所有业务命令都属于一个 Thread，因此成功 ACK 必须返回它。 */
  threadId: ThreadId;

  /** thread.start/message.send 对应的用户消息 ID。 */
  inputMessageId?: MessageId;

  /** thread.start/message.send 创建的 Assistant 消息 ID。 */
  outputMessageId?: MessageId;

  /** 命令关联的 Agent Run。 */
  runId: RunId;

  /** interaction.respond 成功时返回对应的交互 ID。 */
  interactionId?: InteractionId;
}

/** 命令被服务端拒绝后的 ACK。 */
export interface AckRejectedFrame {
  /** ACK 的固定消息类型。 */
  type: 'ack';

  /** false 是失败 ACK 的判别字段。 */
  ok: false;

  /** 对应客户端命令的 requestId。 */
  requestId: RequestId;

  /** 服务端生成 ACK 的 Unix 毫秒时间。 */
  timestamp: UnixTimestamp;

  /** 被拒绝的命令类型。 */
  commandType: ClientCommandType;

  /** 服务端能够识别 Thread 时返回；解析失败时可以省略。 */
  threadId?: ThreadId;

  /** 命令被拒绝的稳定原因。 */
  error: ProtocolError;
}

/** ACK 的判别联合，通过 ok 可以安全缩窄成功或失败字段。 */
export type AckFrame = AckAcceptedFrame | AckRejectedFrame;

/**
 * 所有 Thread 业务事件共用的 envelope。
 *
 * TType 是具体事件名称；TPayload 是这个事件独有的数据。
 * 用于定位实体的 ID 放在 envelope 顶层，payload 只放事件内容。
 */
export interface ThreadEventEnvelope<TType extends string, TPayload> {
  /** 具体事件名称。 */
  type: TType;

  /** 事件所属 Thread，也是 IMService 的路由键。 */
  threadId: ThreadId;

  /** 当前事件在该 Thread 内的严格递增序号。 */
  seqId: SeqId;

  /** 服务端生成事件的 Unix 毫秒时间。 */
  timestamp: UnixTimestamp;

  /** 具体事件的数据。 */
  payload: TPayload;
}

/**
 * Thread 自身的元数据快照。
 *
 * 它不包含 Run 状态或消息内容，避免与 run.status、message.completed
 * 重复表达同一件事；聊天详情页、会话列表等订阅者都消费相同的事实事件。
 */
export interface ThreadUpdatedPayload {
  /** Thread 当前标题。 */
  title: string;

  /** Thread 创建时间。 */
  createdAt: UnixTimestamp;

  /** Thread 最近一次业务更新时间。 */
  updatedAt: UnixTimestamp;
}

/**
 * Thread 被创建或标题等元数据发生变化时广播。
 *
 * 标题生成过程不发送增量事件，只在得到最终标题后广播新的元数据快照。
 */
export type ThreadUpdatedEvent = ThreadEventEnvelope<'thread.updated', ThreadUpdatedPayload>;

/** 一次 Run 的权威状态快照。 */
export interface RunStatusPayload {
  /** Run 当前生命周期状态。 */
  status: RunStatus;

  /** 当前 Run 实际使用的模型。 */
  modelId: ModelId;

  /** 触发 Run 的用户消息。 */
  inputMessageId: MessageId;

  /** Run 生成的 Assistant 正式消息。 */
  outputMessageId: MessageId;

  /** Run 创建时间。 */
  createdAt: UnixTimestamp;

  /** Agent 真正开始执行的时间，尚未开始时为 null。 */
  startedAt: UnixTimestamp | null;

  /** Run 进入终态的时间，运行期间为 null。 */
  completedAt: UnixTimestamp | null;

  /** Run 失败时的错误，其他状态为 null。 */
  error: ProtocolError | null;
}

/**
 * Run 生命周期发生变化。
 *
 * 每一次 thread.start 或 message.send 都会创建 Run，并通过这个通用事件广播状态；
 * 协议只报告客观状态，转圈、红点和按钮等展示由各订阅者自行决定。
 * 只有这个事件的 payload.status 可以建立或改变 Run 状态，其他事件不能隐式代替它。
 */
export interface RunStatusEvent extends ThreadEventEnvelope<'run.status', RunStatusPayload> {
  /** 要更新的 Run。 */
  runId: RunId;
}

/** 一段可公开 Thinking 的流式增量。 */
export interface ThinkingDeltaPayload {
  /** 本次追加到 Thinking Block 的文本。 */
  delta: string;
}

/** 收到第一个 delta 时，前端自动创建对应 Thinking Block。 */
export interface ThinkingDeltaEvent extends ThreadEventEnvelope<'thinking.delta',
  ThinkingDeltaPayload
> {
  /** Thinking 所属的 Run。 */
  runId: RunId;

  /** 要追加内容的 Thinking Block。 */
  thinkingId: ThinkingId;
}

/** Thinking 结束时返回的最终权威内容。 */
export interface ThinkingCompletedPayload {
  /** 完整 Thinking 内容，用于校正之前的增量拼接结果。 */
  content: string;
}

/** 一段可公开 Thinking 已经完成。 */
export interface ThinkingCompletedEvent extends ThreadEventEnvelope<
  'thinking.completed',
  ThinkingCompletedPayload
> {
  /** Thinking 所属的 Run。 */
  runId: RunId;

  /** 已完成的 Thinking Block。 */
  thinkingId: ThinkingId;
}

/** Assistant 正式消息开始生成时的数据。 */
export interface MessageStartedPayload {
  /** 当前只允许 Assistant 产生流式正式内容。 */
  role: 'assistant';

  /** 告诉前端使用纯文本还是 Markdown Renderer。 */
  format: MessageFormat;

  /** Assistant Message 在服务端的创建时间。 */
  createdAt: UnixTimestamp;
}

/** Assistant 正式消息开始生成。 */
export interface MessageStartedEvent extends ThreadEventEnvelope<
  'message.started',
  MessageStartedPayload
> {
  /** 正式消息所属的 Run。 */
  runId: RunId;

  /** 要创建或更新的 Assistant Message。 */
  messageId: MessageId;
}

/** Assistant 正式内容的流式增量。 */
export interface MessageDeltaPayload {
  /** 本次追加到正式消息的文本。 */
  delta: string;
}

/** Assistant 正式消息产生新内容。 */
export interface MessageDeltaEvent extends ThreadEventEnvelope<
  'message.delta',
  MessageDeltaPayload
> {
  /** 正式消息所属的 Run。 */
  runId: RunId;

  /** 要追加内容的 Assistant Message。 */
  messageId: MessageId;
}

/** 一条用户或 Assistant 消息进入终态时的完整数据。 */
export interface MessageCompletedPayload {
  /** 消息发送方。 */
  role: MessageRole;

  /** 最终完整内容，用于校正之前的 delta 拼接结果。 */
  content: string;

  /** 正式内容格式。 */
  format: MessageFormat;

  /** 消息最终状态。 */
  status: MessageCompletionStatus;

  /** 消息创建时间。 */
  createdAt: UnixTimestamp;

  /** 消息进入终态的时间。 */
  completedAt: UnixTimestamp;

  /** 消息失败时的错误，成功或取消时为 null。 */
  error: ProtocolError | null;
}

/**
 * 一条消息已经完成。
 *
 * 用户消息也通过这个事件广播给同一用户的其他页面；
 * Assistant 消息必须携带 runId，普通用户消息允许省略。
 */
export interface MessageCompletedEvent extends ThreadEventEnvelope<
  'message.completed',
  MessageCompletedPayload
> {
  /** 消息关联的 Run；没有独立 Run 的用户消息可以省略。 */
  runId?: RunId;

  /** 已经进入终态的 Message。 */
  messageId: MessageId;
}

/** Tool 开始调用时的数据。 */
export interface ToolStartedPayload {
  /** Tool 在 Agent 注册表中的稳定名称。 */
  name: string;

  /** 面向用户的可选展示名称。 */
  displayName: string | null;

  /** Tool 调用参数；没有可公开参数时为 null。 */
  args: JsonValue | null;
}

/** 一次 Tool 调用已经开始。 */
export interface ToolStartedEvent extends ThreadEventEnvelope<'tool.started', ToolStartedPayload> {
  /** Tool 所属的 Run。 */
  runId: RunId;

  /** 本次 Tool 调用的唯一 ID。 */
  toolCallId: ToolCallId;
}

/** Tool 成功完成时的数据。 */
export interface ToolCompletedPayload {
  /** 面向用户展示的简短结果，没有摘要时为 null。 */
  summary: string | null;

  /** Tool 返回的结构化结果，没有公开结果时为 null。 */
  result: JsonValue | null;
}

/** Tool 调用成功完成。RAG 的 knowledge_search 也使用这个事件。 */
export interface ToolCompletedEvent extends ThreadEventEnvelope<
  'tool.completed',
  ToolCompletedPayload
> {
  /** Tool 所属的 Run。 */
  runId: RunId;

  /** 对应 ToolStartedEvent.toolCallId。 */
  toolCallId: ToolCallId;
}

/** Tool 调用失败时的数据。 */
export interface ToolFailedPayload {
  /** Tool 失败的稳定原因。 */
  error: ProtocolError;
}

/** Tool 调用失败。 */
export interface ToolFailedEvent extends ThreadEventEnvelope<'tool.failed', ToolFailedPayload> {
  /** Tool 所属的 Run。 */
  runId: RunId;

  /** 调用失败的 Tool ID。 */
  toolCallId: ToolCallId;
}

/** HITL 请求用户输入时的数据。 */
export interface InteractionRequestedPayload {
  /** 需要用户回答的问题列表。 */
  questions: HITLQuestion[];
}

/**
 * Agent 发出一项等待用户回答的交互。
 *
 * 这个事件只描述 HITL 内容；Run 是否进入 waiting_user 由独立的 run.status 事件确认。
 */
export interface InteractionRequestedEvent extends ThreadEventEnvelope<
  'interaction.requested',
  InteractionRequestedPayload
> {
  /** HITL 所属的 Run。 */
  runId: RunId;

  /** 本次 HITL 交互 ID。 */
  interactionId: InteractionId;
}

/** HITL 得到回答后的数据。 */
export interface InteractionResolvedPayload {
  /** 用户最终提交并被服务端接受的答案。 */
  answers: HITLAnswer[];
}

/**
 * HITL 已经得到回答。
 *
 * 这个事件只确认交互结果；Run 是否恢复 running 仍由独立的 run.status 事件确认。
 */
export interface InteractionResolvedEvent extends ThreadEventEnvelope<
  'interaction.resolved',
  InteractionResolvedPayload
> {
  /** HITL 所属的 Run。 */
  runId: RunId;

  /** 已解决的 HITL 交互。 */
  interactionId: InteractionId;
}

/** 服务端允许广播的全部 Thread 业务事件。 */
export type ServerThreadEvent =
  | ThreadUpdatedEvent
  | RunStatusEvent
  | ThinkingDeltaEvent
  | ThinkingCompletedEvent
  | MessageStartedEvent
  | MessageDeltaEvent
  | MessageCompletedEvent
  | ToolStartedEvent
  | ToolCompletedEvent
  | ToolFailedEvent
  | InteractionRequestedEvent
  | InteractionResolvedEvent;

/** Transport 可能收到的全部应用层消息。 */
export type ServerFrame = AckFrame | ServerThreadEvent;
