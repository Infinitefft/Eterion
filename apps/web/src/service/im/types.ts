/**
 * Chat 的唯一标识。
 * 由前端创建新会话时生成，后续作为永久业务 ID 使用。
 */
export type ChatId = string;

/** 一条用户、Assistant 或系统消息的唯一标识。 */
export type MessageId = string;

/**
 * 一次 Agent 执行的唯一标识。
 * 一条用户消息通常会触发一个 Run。
 */
export type RunId = string;

/** Agent 执行过程中某一个步骤的唯一标识。 */
export type StepId = string;

/**
 * 一次客户端指令发送的标识。
 * 用于把客户端请求和服务端 ACK 关联起来。
 */
export type RequestId = string;

/**
 * 一条服务端事件的唯一标识。
 * 前端使用它判断某条事件是否已经处理过。
 */
export type EventId = string;

/**
 * 客户端业务操作的幂等标识。
 * 同一业务意图重试时必须复用，防止创建重复消息或 Run。
 */
export type IdempotencyKey = string;

/**
 * 用户全局事件流的位置。
 * 后续断线重连时，前端可以携带最后一个 Cursor 请求续传。
 */
export type EventCursor = string;

/**
 * 项目中的协议时间统一使用 Unix 毫秒时间戳。
 * 可以直接通过 Date.now() 生成。
 */
export type UnixTimestamp = number;

/**
 * 前端可以稳定识别和展示的结构化错误。
 * 业务逻辑只能依赖 code，不能匹配 message 文本。
 */
export interface IMError {
  /** 稳定的机器可读错误码。 */
  code: string;

  /** 可以向用户展示的错误说明。 */
  message: string;

  /** 表示当前操作是否允许重试。 */
  retryable: boolean;
}

/**
 * 一条可持久化的 Chat 会话。
 * Chat 是 Message 和 Run 的顶层容器。
 */
export interface Chat {
  /** 前端生成的永久 Chat ID。 */
  id: ChatId;

  /** 展示在页面标题和历史会话列表中的名称。 */
  title: string;

  /** Chat 第一次创建的时间。 */
  createdAt: UnixTimestamp;

  /** Chat 中的消息或元数据最近一次发生变化的时间。 */
  updatedAt: UnixTimestamp;
}

/**
 * 文本内容支持的格式。
 *
 * plain_text：只作为普通文本展示。
 * markdown：允许页面使用 Markdown Renderer 展示。
 */
export type TextFormat = 'plain_text' | 'markdown';

/**
 * 用户输入和 Agent 最终回答使用的文本内容结构。
 * 当前只支持 text，后续可以扩展其他 Content 类型。
 */
export interface TextContent {
  /** 可辨识联合使用的内容类型。 */
  type: 'text';

  /** 告诉 UI 应该使用纯文本还是 Markdown 渲染。 */
  format: TextFormat;

  /** 真正需要展示的文本内容。 */
  content: string;
}

/**
 * 消息的生命周期状态。
 *
 * delivery_unknown 是前端状态，表示指令已经发送，
 * 但在超时时间内没有收到服务端 ACK。
 */
export type ChatMessageStatus =
  | 'pending'
  | 'delivery_unknown'
  | 'streaming'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** 对话中的一条用户、Assistant 或系统消息。 */
export interface ChatMessage {
  /** 消息的唯一 ID。 */
  id: MessageId;

  /** 当前消息所属的 Chat。 */
  chatId: ChatId;

  /**
   * 产生或消费当前消息的 Agent Run。
   * 不属于某个 Run 的系统消息可以为 null。
   */
  runId: RunId | null;

  /** 消息发送方，用于决定头像、布局和渲染方式。 */
  role: 'user' | 'assistant' | 'system';

  /** 当前消息所处的生命周期阶段。 */
  status: ChatMessageStatus;

  /** 当前消息的正文。 */
  content: TextContent;

  /** 消息第一次创建的时间。 */
  createdAt: UnixTimestamp;

  /** 消息正文或状态最近一次变化的时间。 */
  updatedAt: UnixTimestamp;

  /**
   * 消息进入终态的时间。
   * streaming 或 pending 状态下为 null。
   */
  completedAt: UnixTimestamp | null;

  /** 消息生成失败时的结构化错误。 */
  error: IMError | null;
}

/**
 * Agent Run 的生命周期。
 *
 * Tool、Skill 和 RAG 的详细过程不直接塞进这里，
 * 它们通过 AgentStep 表达。
 */
export type AgentRunStatus =
  | 'created'
  | 'queued'
  | 'running'
  | 'calling_tool'
  | 'calling_skill'
  | 'retrieving'
  | 'streaming'
  | 'waiting_user'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * 一次完整的 Agent 执行。
 *
 * 一般关系为：
 * 用户消息 -> AgentRun -> Assistant 消息
 */
export interface AgentRun {
  /** 当前 Run 的唯一 ID。 */
  id: RunId;

  /** 当前 Run 所属的 Chat。 */
  chatId: ChatId;

  /** 触发当前 Run 的用户消息。 */
  inputMessageId: MessageId;

  /** 当前 Run 最终生成的 Assistant 消息。 */
  outputMessageId: MessageId;

  /** Run 当前所处的执行阶段。 */
  status: AgentRunStatus;

  /**
   * 当前 Run 包含的 Agent Step ID。
   * 数组顺序就是 UI 默认展示顺序。
   */
  stepIds: StepId[];

  /**
   * 当前 Run 已处理的最大事件序号。
   * 用于处理事件乱序、重复和缺失。
   */
  lastSeq: number;

  /**
   * 是否发现了事件序号缺口。
   * 为 true 时，本地状态不能继续视为权威状态。
   */
  desynced: boolean;

  /** Run 第一次创建的时间。 */
  createdAt: UnixTimestamp;

  /** Agent 真正开始执行的时间。 */
  startedAt: UnixTimestamp | null;

  /** Run 状态或内容最近一次变化的时间。 */
  updatedAt: UnixTimestamp;

  /** Run 进入 completed、failed 或 cancelled 的时间。 */
  completedAt: UnixTimestamp | null;

  /** Run 执行失败时的结构化错误。 */
  error: IMError | null;
}

/**
 * Agent 执行步骤支持的类型。
 *
 * reasoning：可公开的分析状态或摘要。
 * tool：一次底层工具调用。
 * skill：一次 Skill 能力调用。
 * retrieval：一次 RAG 文档检索。
 */
export type AgentStepKind = 'reasoning' | 'tool' | 'skill' | 'retrieval';

/** 单个 Agent Step 的生命周期。 */
export type AgentStepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * 所有 Agent Step 共用的基础字段。
 *
 * TKind 会把每个具体 Step 的 kind 固定为一个字面量，
 * 使 TypeScript 可以根据 step.kind 自动推断具体字段。
 */
export interface AgentStepBase<TKind extends AgentStepKind> {
  /** 当前步骤的唯一 ID。 */
  id: StepId;

  /** 当前步骤所属的 Chat。 */
  chatId: ChatId;

  /** 当前步骤所属的 Agent Run。 */
  runId: RunId;

  /** 当前步骤的具体类型。 */
  kind: TKind;

  /**
   * 面向用户的步骤标题。
   * 例如“分析问题”“调用网页搜索”“检索本地知识库”。
   */
  title: string;

  /** 当前步骤所处的生命周期阶段。 */
  status: AgentStepStatus;

  /**
   * 当前步骤在 Run 中的展示顺序。
   * 不依赖事件实际到达前端的时间排序。
   */
  sequence: number;

  /**
   * 可选的父步骤 ID。
   *
   * 例如 Skill 内部调用了 Tool，
   * ToolStep 可以把对应 SkillStep 设为父步骤。
   */
  parentStepId: StepId | null;

  /** 当前步骤真正开始执行的时间。 */
  startedAt: UnixTimestamp | null;

  /** 当前步骤完成、失败或取消的时间。 */
  completedAt: UnixTimestamp | null;

  /** 当前步骤失败时的结构化错误。 */
  error: IMError | null;
}

/**
 * 可公开展示的分析状态或摘要。
 * 不用于承载模型隐藏的原始思维链。
 */
export interface ReasoningStep extends AgentStepBase<'reasoning'> {
  /**
   * 可以向用户展示的简短分析摘要。
   * 只有“思考中”状态而没有具体摘要时可以为 null。
   */
  summary: string | null;
}

/** Tool 的稳定身份和展示信息。 */
export interface ToolReference {
  /** Tool 在注册表或后端中的稳定 ID。 */
  id: string;

  /** 页面上向用户展示的 Tool 名称。 */
  name: string;
}

/** Agent 的一次 Tool 调用。 */
export interface ToolStep extends AgentStepBase<'tool'> {
  /**
   * 一次具体 Tool 调用的 ID。
   * 同一个 Tool 在一个 Run 中可以被调用多次。
   */
  callId: string;

  /** 本次调用所使用的 Tool。 */
  tool: ToolReference;

  /**
   * Tool 的输入参数。
   * 当前不规定具体结构，后续根据 Tool 协议细化。
   */
  input: unknown;

  /**
   * Tool 的输出结果。
   * 当前不规定具体结构，UI 暂时显示占位内容。
   */
  output: unknown;
}

/** Skill 的稳定身份和展示信息。 */
export interface SkillReference {
  /** Skill 在注册表中的稳定 ID。 */
  id: string;

  /** 页面上向用户展示的 Skill 名称。 */
  name: string;
}

/** Agent 的一次 Skill 调用。 */
export interface SkillStep extends AgentStepBase<'skill'> {
  /**
   * 一次具体 Skill 调用的 ID。
   * 用于关联调用开始、进度、结果和错误事件。
   */
  callId: string;

  /** 本次调用所使用的 Skill。 */
  skill: SkillReference;

  /** Skill 输入，当前暂不约束具体结构。 */
  input: unknown;

  /** Skill 输出，当前暂不约束具体结构。 */
  output: unknown;
}

/** 一次 RAG 文档检索步骤。 */
export interface RetrievalStep extends AgentStepBase<'retrieval'> {
  /** 一次具体检索任务的 ID。 */
  retrievalId: string;

  /**
   * 实际用于知识库检索的查询文本。
   * 检索尚未开始或后端未公开时可以为 null。
   */
  query: string | null;

  /**
   * 检索到的文档或引用结果。
   * 当前使用 unknown[] 占位，后续再定义文档结构。
   */
  documents: unknown[];
}

/**
 * 所有 Agent Step 的可辨识联合。
 *
 * 使用示例：
 *
 * if (step.kind === 'tool') {
 *   step.tool.name;
 * }
 */
export type AgentStep = ReasoningStep | ToolStep | SkillStep | RetrievalStep;

/**
 * 进入历史会话或发生状态校准时加载的权威快照。
 */
export interface ChatSnapshot {
  /** 当前 Chat 的基础信息。 */
  chat: Chat;

  /** 当前 Chat 的全部历史消息。 */
  messages: ChatMessage[];

  /** 当前 Chat 已产生的全部 Agent Run。 */
  runs: AgentRun[];

  /** 所有 Run 对应的 Agent 执行步骤。 */
  steps: AgentStep[];

  /**
   * 生成当前快照时对应的事件流位置。
   * 后续实时事件应该从这个位置之后继续处理。
   */
  cursor: EventCursor | null;
}
