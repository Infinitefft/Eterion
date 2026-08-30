import type {
  HITLAnswer,
  HITLQuestion,
  InteractionId,
  JsonValue,
  MessageCompletionStatus,
  MessageFormat,
  MessageId,
  MessageRole,
  ModelId,
  ProtocolError,
  RunId,
  RunStatus,
  SeqId,
  ThinkingId,
  ThreadId,
  ToolCallId,
  UnixTimestamp,
} from './protocol';

/**
 * 向页面重新导出常用协议基础类型。
 *
 * 页面只需要依赖应用状态类型，不必为了一个 ID 或状态再直接依赖 protocol.ts。
 */
export type {
  HITLAnswer,
  HITLQuestion,
  InteractionId,
  JsonValue,
  MessageCompletionStatus,
  MessageFormat,
  MessageId,
  MessageRole,
  ModelId,
  ProtocolError,
  RunId,
  RunStatus,
  SeqId,
  ThinkingId,
  ThreadId,
  ToolCallId,
  UnixTimestamp,
} from './protocol';

/** 服务端持久化的 Thread 基础信息。 */
export interface ThreadRecord {
  /** Thread 的稳定 ID，也是实时事件的路由键。 */
  id: ThreadId;

  /** 会话列表和聊天详情页展示的标题。 */
  title: string;

  /** Thread 创建时间。 */
  createdAt: UnixTimestamp;

  /** Thread 最近一次发生业务变化的时间。 */
  updatedAt: UnixTimestamp;
}

/**
 * 前端 Store 中真正保存的 Thread 状态。
 *
 * generating、waiting_user 等状态不在这里重复保存，
 * 后续直接从这个 Thread 最新 Run 的 status 派生。
 */
export interface ThreadState extends ThreadRecord {
  /** 当前 Thread 是否存在用户尚未查看的新结果。 */
  hasUnread: boolean;
}

/**
 * 前端消息状态。
 *
 * sending 是客户端发出 Command 后、收到服务端事实事件前的乐观状态；
 * streaming 表示 Assistant 正在产生正式内容；其余状态来自协议终态。
 */
export type MessageStateStatus = 'sending' | 'streaming' | MessageCompletionStatus;

/** 用户消息或 Assistant 正式回复在前端组装后的完整状态。 */
export interface MessageState {
  /** Message 的稳定 ID。 */
  id: MessageId;

  /** Message 所属的 Thread。 */
  threadId: ThreadId;

  /**
   * Message 关联的 Run。
   * 没有建立 Run 关系的用户消息可以为 null。
   */
  runId: RunId | null;

  /** 消息发送方。 */
  role: MessageRole;

  /** 正文使用纯文本还是 Markdown 渲染。 */
  format: MessageFormat;

  /** 已经组装完成的当前正文，不保存单独的 delta。 */
  content: string;

  /** 当前消息状态。 */
  status: MessageStateStatus;

  /** 消息创建时间。 */
  createdAt: UnixTimestamp;

  /** 消息进入终态的时间；发送中或流式生成中为 null。 */
  completedAt: UnixTimestamp | null;

  /** 消息失败时的错误；正常状态为 null。 */
  error: ProtocolError | null;
}

/** 一次 Agent 执行在前端保存的权威状态。 */
export interface RunState {
  /** Run 的稳定 ID。 */
  id: RunId;

  /** Run 所属的 Thread。 */
  threadId: ThreadId;

  /** 当前 Run 实际使用的模型。 */
  modelId: ModelId;

  /** 触发当前 Run 的用户消息。 */
  inputMessageId: MessageId;

  /** 当前 Run 生成的 Assistant 正式消息。 */
  outputMessageId: MessageId;

  /** Run 当前生命周期状态。 */
  status: RunStatus;

  /** Run 创建时间。 */
  createdAt: UnixTimestamp;

  /** Agent 真正开始执行的时间；尚未开始时为 null。 */
  startedAt: UnixTimestamp | null;

  /** Run 进入终态的时间；执行期间为 null。 */
  completedAt: UnixTimestamp | null;

  /** Run 失败时的错误；其他状态为 null。 */
  error: ProtocolError | null;
}

/** Thinking Block 在前端可能处于的状态。 */
export type ThinkingBlockStatus = 'streaming' | 'completed';

/** 模型公开 Thinking 内容在前端合并后的状态。 */
export interface ThinkingBlockState {
  /** Agent Block 的判别字段。 */
  kind: 'thinking';

  /** Thinking Block 的稳定 ID。 */
  id: ThinkingId;

  /** Thinking 所属的 Thread。 */
  threadId: ThreadId;

  /** Thinking 所属的 Run。 */
  runId: RunId;

  /** Thinking 当前是否仍在流式生成。 */
  status: ThinkingBlockStatus;

  /** 已经把全部 delta 追加完成的当前内容。 */
  content: string;
}

/** Tool 调用在前端可能处于的状态。 */
export type ToolCallStatus = 'running' | 'completed' | 'failed';

/** 一次 Tool 调用在前端合并后的状态。 */
export interface ToolCallBlockState {
  /** Agent Block 的判别字段。 */
  kind: 'tool';

  /** Tool Call 的稳定 ID。 */
  id: ToolCallId;

  /** Tool Call 所属的 Thread。 */
  threadId: ThreadId;

  /** Tool Call 所属的 Run。 */
  runId: RunId;

  /** Tool 当前执行状态。 */
  status: ToolCallStatus;

  /** Tool 在 Agent 注册表中的稳定名称。 */
  name: string;

  /** 面向用户的展示名称；没有时为 null。 */
  displayName: string | null;

  /** Tool 调用参数；没有公开参数时为 null。 */
  args: JsonValue | null;

  /** Tool 成功后的简短结果；执行中或没有摘要时为 null。 */
  summary: string | null;

  /** Tool 成功后的结构化结果；执行中或没有公开结果时为 null。 */
  result: JsonValue | null;

  /** Tool 失败时的错误；其他状态为 null。 */
  error: ProtocolError | null;
}

/** HITL 在前端可能处于的状态。 */
export type HITLInteractionStatus = 'requested' | 'resolved';

/** 一次 Human-in-the-loop 交互在前端合并后的状态。 */
export interface HITLInteractionState {
  /** Agent Block 的判别字段。 */
  kind: 'hitl';

  /** HITL Interaction 的稳定 ID。 */
  id: InteractionId;

  /** HITL 所属的 Thread。 */
  threadId: ThreadId;

  /** HITL 所属的 Run。 */
  runId: RunId;

  /** 当前正在等待回答，还是已经得到回答。 */
  status: HITLInteractionStatus;

  /** 服务端要求用户回答的问题。 */
  questions: HITLQuestion[];

  /** 用户最终提交的答案；尚未解决时为 null。 */
  answers: HITLAnswer[] | null;
}

/**
 * 一次 Run 中可以展示的全部 Agent Block。
 *
 * Skill 不单独展示，RAG 作为普通 Tool，因此不需要 AgentStep、SkillBlock
 * 或 RetrievalBlock 等额外抽象。
 */
export type AgentBlockState = ThinkingBlockState | ToolCallBlockState | HITLInteractionState;

/**
 * 服务端返回的单个 Thread 权威快照。
 *
 * Snapshot 用于首次打开历史 Thread，以及 seqId 出现缺口后的恢复。
 * 数组按实际展示顺序返回，状态层可以直接据此重建本地实体和索引。
 */
export interface ThreadSnapshot {
  /** Thread 的服务端元数据，不包含纯前端 hasUnread。 */
  thread: ThreadRecord;

  /** Thread 内的全部正式消息，按创建顺序排列。 */
  messages: MessageState[];

  /** Thread 内的全部 Run，按创建顺序排列。 */
  runs: RunState[];

  /** Thread 内的 Thinking、Tool 和 HITL，按实际出现顺序排列。 */
  blocks: AgentBlockState[];

  /** Snapshot 已经包含的最大 Thread 事件序号。 */
  lastSeqId: SeqId;
}
