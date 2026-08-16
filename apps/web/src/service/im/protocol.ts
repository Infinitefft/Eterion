import type {
  AgentRunStatus,
  AgentStepKind,
  AgentStepStatus,
  ChatId,
  ChatMessageStatus,
  EventCursor,
  EventId,
  IdempotencyKey,
  IMError,
  MessageId,
  ModelId,
  RequestId,
  RunId,
  StepId,
  TextContent,
  UnixTimestamp,
} from './types';

/** 前端可以通过 WebSocket 发送的指令名称。 */
export type ClientCommandType =
  | 'chat.start'
  | 'chat.submit'
  | 'run.cancel'
  | 'ping';

/** 所有客户端指令共用的网络层结构。 */
export interface ClientCommandEnvelope<
  TType extends ClientCommandType,
  TPayload,
> {
  type: TType;
  request_id: RequestId;
  idempotency_key: IdempotencyKey | null;
  chat_id: ChatId | null;
  run_id: RunId | null;
  timestamp: UnixTimestamp;
  payload: TPayload;
}

/** 创建新 Chat，并立即提交首条用户消息。 */
export interface ChatStartPayload {
  /** 前端生成的用户消息 ID，用于本地乐观展示和服务端去重。 */
  message_id: MessageId;
  /** null 表示使用服务端配置的默认模型。 */
  model_id: ModelId | null;
  title: string | null;
  content: TextContent;
}

export interface ChatStartCommand
  extends ClientCommandEnvelope<'chat.start', ChatStartPayload> {
  idempotency_key: IdempotencyKey;
  chat_id: ChatId;
  run_id: null;
}

/** 向已有 Chat 提交一条用户消息。 */
export interface ChatSubmitPayload {
  /** 前端生成的用户消息 ID。 */
  message_id: MessageId;
  /** null 表示使用服务端配置的默认模型。 */
  model_id: ModelId | null;
  content: TextContent;
}

export interface ChatSubmitCommand
  extends ClientCommandEnvelope<'chat.submit', ChatSubmitPayload> {
  idempotency_key: IdempotencyKey;
  chat_id: ChatId;
  run_id: null;
}

export interface RunCancelPayload {
  reason: 'user_requested';
}

export interface RunCancelCommand
  extends ClientCommandEnvelope<'run.cancel', RunCancelPayload> {
  idempotency_key: IdempotencyKey;
  chat_id: ChatId;
  run_id: RunId;
}

export interface PingPayload {
  client_time: UnixTimestamp;
}

export interface PingCommand
  extends ClientCommandEnvelope<'ping', PingPayload> {
  idempotency_key: null;
  chat_id: null;
  run_id: null;
}

/** 所有客户端指令的可辨识联合。 */
export type ClientCommand =
  | ChatStartCommand
  | ChatSubmitCommand
  | RunCancelCommand
  | PingCommand;

/** 服务端可以通过全局 WebSocket 下发的事件名称。 */
export type ServerEventType =
  | 'connection.ready'
  | 'command.accepted'
  | 'command.rejected'
  | 'run.created'
  | 'run.status'
  | 'step.started'
  | 'step.progress'
  | 'step.completed'
  | 'step.failed'
  | 'message.started'
  | 'message.delta'
  | 'message.completed'
  | 'pong'
  | 'error';

/** 所有服务端事件共用的网络层结构。 */
export interface ServerEventEnvelope<
  TType extends ServerEventType,
  TPayload,
> {
  event_id: EventId;
  type: TType;
  request_id: RequestId | null;
  chat_id: ChatId | null;
  run_id: RunId | null;
  message_id: MessageId | null;
  step_id: StepId | null;

  /** 同一个 Run 内严格递增的事件序号。 */
  seq: number | null;

  /** 用户全局下行事件流位置，用于后续断线续传。 */
  cursor: EventCursor | null;
  timestamp: UnixTimestamp;
  payload: TPayload;
}

/** 服务端下发的 Message 快照。 */
export interface WireChatMessage {
  message_id: MessageId;
  chat_id: ChatId;
  run_id: RunId | null;
  role: 'user' | 'assistant' | 'system';
  status: ChatMessageStatus;
  content: TextContent;
  created_at: UnixTimestamp;
  updated_at: UnixTimestamp;
  completed_at: UnixTimestamp | null;
  error: IMError | null;
}

/** 服务端下发的 Agent Run 快照。 */
export interface WireAgentRun {
  run_id: RunId;
  chat_id: ChatId;
  model_id: ModelId;
  input_message_id: MessageId;
  output_message_id: MessageId;
  status: AgentRunStatus;
  step_ids: StepId[];
  last_seq: number;
  desynced: boolean;
  created_at: UnixTimestamp;
  started_at: UnixTimestamp | null;
  updated_at: UnixTimestamp;
  completed_at: UnixTimestamp | null;
  error: IMError | null;
}

/** 所有服务端 Step 快照共有的字段。 */
export interface WireAgentStepBase<TKind extends AgentStepKind> {
  step_id: StepId;
  chat_id: ChatId;
  run_id: RunId;
  kind: TKind;
  title: string;
  status: AgentStepStatus;
  sequence: number;
  parent_step_id: StepId | null;
  started_at: UnixTimestamp | null;
  completed_at: UnixTimestamp | null;
  error: IMError | null;
}

export interface WireReasoningStep
  extends WireAgentStepBase<'reasoning'> {
  /** 可以公开展示的思考状态或摘要。 */
  summary: string | null;
}

export interface WireToolStep extends WireAgentStepBase<'tool'> {
  call_id: string;
  tool: {
    id: string;
    name: string;
  };
  input: unknown;
  output: unknown;
}

export interface WireSkillStep extends WireAgentStepBase<'skill'> {
  call_id: string;
  skill: {
    id: string;
    name: string;
  };
  input: unknown;
  output: unknown;
}

export interface WireRetrievalStep
  extends WireAgentStepBase<'retrieval'> {
  retrieval_id: string;
  query: string | null;

  /** RAG 文档结构暂未确定，先使用 unknown[] 占位。 */
  documents: unknown[];
}

export type WireAgentStep =
  | WireReasoningStep
  | WireToolStep
  | WireSkillStep
  | WireRetrievalStep;

export interface ConnectionReadyPayload {
  connection_id: string;
  heartbeat_interval_ms: number;
  resume_supported: boolean;
}

export interface CommandAcceptedPayload {
  command_type: ClientCommandType;
}

export interface CommandRejectedPayload {
  command_type: ClientCommandType;
  error: IMError;
}

export interface RunSnapshotPayload {
  run: WireAgentRun;
}

export interface StepSnapshotPayload {
  step: WireAgentStep;
}

export interface MessageSnapshotPayload {
  message: WireChatMessage;
}

export interface MessageDeltaPayload {
  delta: string;
}

export interface PongPayload {
  client_time: UnixTimestamp;
  server_time: UnixTimestamp;
}

export interface ErrorPayload {
  error: IMError;
}

export interface ConnectionReadyEvent
  extends ServerEventEnvelope<'connection.ready', ConnectionReadyPayload> {
  request_id: null;
  chat_id: null;
  run_id: null;
  message_id: null;
  step_id: null;
  seq: null;
}

export interface CommandAcceptedEvent
  extends ServerEventEnvelope<'command.accepted', CommandAcceptedPayload> {
  request_id: RequestId;
  message_id: null;
  step_id: null;
  seq: null;
}

export interface CommandRejectedEvent
  extends ServerEventEnvelope<'command.rejected', CommandRejectedPayload> {
  request_id: RequestId;
  message_id: null;
  step_id: null;
  seq: null;
}

export interface RunSnapshotEvent
  extends ServerEventEnvelope<
    'run.created' | 'run.status',
    RunSnapshotPayload
  > {
  chat_id: ChatId;
  run_id: RunId;
  message_id: null;
  step_id: null;
  seq: number;
}

export interface StepSnapshotEvent
  extends ServerEventEnvelope<
    | 'step.started'
    | 'step.progress'
    | 'step.completed'
    | 'step.failed',
    StepSnapshotPayload
  > {
  request_id: null;
  chat_id: ChatId;
  run_id: RunId;
  message_id: null;
  step_id: StepId;
  seq: number;
}

export interface MessageSnapshotEvent
  extends ServerEventEnvelope<
    'message.started' | 'message.completed',
    MessageSnapshotPayload
  > {
  request_id: null;
  chat_id: ChatId;
  run_id: RunId;
  message_id: MessageId;
  step_id: null;
  seq: number;
}

export interface MessageDeltaEvent
  extends ServerEventEnvelope<'message.delta', MessageDeltaPayload> {
  request_id: null;
  chat_id: ChatId;
  run_id: RunId;
  message_id: MessageId;
  step_id: null;
  seq: number;
}

export interface PongEvent
  extends ServerEventEnvelope<'pong', PongPayload> {
  request_id: RequestId;
  chat_id: null;
  run_id: null;
  message_id: null;
  step_id: null;
  seq: null;
}

export interface ServerErrorEvent
  extends ServerEventEnvelope<'error', ErrorPayload> {}

/** 所有服务端事件的可辨识联合。 */
export type ServerEvent =
  | ConnectionReadyEvent
  | CommandAcceptedEvent
  | CommandRejectedEvent
  | RunSnapshotEvent
  | StepSnapshotEvent
  | MessageSnapshotEvent
  | MessageDeltaEvent
  | PongEvent
  | ServerErrorEvent;
