import { createStore, type StoreApi } from 'zustand/vanilla';

import type { IMConnectionState } from './transport';
import type {
  AgentRun,
  AgentStep,
  Chat,
  ChatId,
  ChatMessage,
  ChatSnapshot,
  EventCursor,
  IdempotencyKey,
  IMError,
  MessageId,
  RequestId,
  RunId,
  StepId,
  UnixTimestamp,
} from './types';

/** 新会话首条 Prompt 的本地发送状态。 */
export type InitialPromptStatus =
  | 'pending'
  | 'sending'
  | 'delivery_unknown'
  | 'rejected';

/**
 * 新会话跳转前登记的一次性发送意图。
 *
 * 它代替页面内的 shouldSendPrompt 布尔值，
 * 避免页面重复渲染或路由切换时重复发送首条消息。
 */
export interface InitialPromptIntent {
  /** 前端提前生成的永久 Chat ID。 */
  chatId: ChatId;

  /** 前端提前生成的首条用户消息 ID，重试时保持不变。 */
  messageId: MessageId;

  /** 用户在首页输入的原始 Prompt。 */
  prompt: string;

  /** 新 Chat 的初始标题；暂时没有标题时为 null。 */
  title: string | null;

  /** 首次发送和后续重试必须复用的幂等键。 */
  idempotencyKey: IdempotencyKey;

  /** 当前首发意图所处的本地阶段。 */
  status: InitialPromptStatus;

  /** 当前意图第一次登记的时间。 */
  createdAt: UnixTimestamp;

  /** 最近一次发送使用的 Request ID。 */
  lastRequestId: RequestId | null;

  /** 发送失败或被服务端拒绝时的错误。 */
  error: IMError | null;
}

/**
 * 应用层 IM 会话状态。
 *
 * 它和 Transport 的物理 WebSocket 状态不同：
 * connectionId、lastPongAt 和 cursor 都来自 IM 协议事件。
 */
export interface IMProtocolSessionState {
  /** 服务端为当前物理连接分配的 ID。 */
  connectionId: string | null;

  /** 最近一次收到应用层 pong 的时间。 */
  lastPongAt: UnixTimestamp | null;

  /** 当前已经处理到的全局事件流位置。 */
  cursor: EventCursor | null;
}

/**
 * 全局 IM Store 保存的完整状态。
 *
 * 实体数据使用 xxxById 规范化保存，
 * 归属关系和展示顺序使用单独的 ID 数组表达。
 */
export interface IMStoreState {
  /** WebSocket 物理连接状态。 */
  connection: IMConnectionState;

  /** connection.ready、pong、cursor 等应用层连接信息。 */
  session: IMProtocolSessionState;

  /** 当前已经加载的 Chat ID。 */
  chatIds: ChatId[];

  /** ChatId -> Chat。 */
  chatsById: Record<ChatId, Chat>;

  /** ChatId -> 当前 Chat 中的 MessageId 数组。 */
  messageIdsByChatId: Record<ChatId, MessageId[]>;

  /** MessageId -> ChatMessage。 */
  messagesById: Record<MessageId, ChatMessage>;

  /** ChatId -> 当前 Chat 中的 RunId 数组。 */
  runIdsByChatId: Record<ChatId, RunId[]>;

  /** RunId -> AgentRun。 */
  runsById: Record<RunId, AgentRun>;

  /** StepId -> AgentStep。 */
  stepsById: Record<StepId, AgentStep>;

  /** ChatId -> 新会话首条 Prompt 的发送意图。 */
  initialPromptIntentsByChatId: Record<ChatId, InitialPromptIntent>;
}

/** 向流式 Assistant 消息追加文本时需要的数据。 */
export interface AppendMessageDeltaInput {
  messageId: MessageId;
  delta: string;
  updatedAt: UnixTimestamp;
}

/** InitialPromptIntent 创建后允许修改的字段。 */
export interface InitialPromptIntentUpdate {
  status?: InitialPromptStatus;
  lastRequestId?: RequestId | null;
  error?: IMError | null;
}

/** IM Store 对外提供的状态修改方法。 */
export interface IMStoreActions {
  /**
   * 同步 WebSocket Transport 的物理连接状态。
   *
   * Transport 发生连接、断开或重连时调用，
   * 页面可以通过 Store 统一读取当前连接状态。
   */
  setConnectionState(connection: Readonly<IMConnectionState>): void;

  /**
   * 局部更新应用层 IM 会话信息。
   *
   * 例如 connection.ready 更新 connectionId，
   * pong 更新 lastPongAt，普通事件更新 cursor。
   */
  updateSessionState(patch: Partial<IMProtocolSessionState>): void;

  /**
   * 新增或更新一个 Chat。
   *
   * upsert 表示：不存在时插入，已经存在时更新。
   * 已存在的 Chat 不会被重复添加到 chatIds。
   */
  upsertChat(chat: Chat): void;

  /**
   * 使用服务端权威快照替换一个 Chat 的本地数据。
   *
   * 主要用于打开历史会话、断线后的状态恢复，
   * 或事件序号出现缺失时重新校准本地状态。
   */
  applyChatSnapshot(snapshot: ChatSnapshot): void;

  /**
   * 新增或更新一条完整 Message。
   *
   * 可以处理用户消息、Assistant 消息开始，
   * 以及服务端返回的最终消息快照。
   */
  upsertMessage(message: ChatMessage): void;

  /**
   * 向已有 Assistant 消息末尾追加一段流式文本。
   *
   * 只更新目标 Message，不重新创建其他 Chat、Run 或 Step。
   */
  appendMessageDelta(input: AppendMessageDeltaInput): void;

  /**
   * 新增或更新一次 Agent Run。
   *
   * Run 用来记录一次 Agent 执行的状态、输入消息、
   * 输出消息以及其包含的 Step 顺序。
   */
  upsertRun(run: AgentRun): void;

  /**
   * 新增或更新一个 Agent Step。
   *
   * Step 可以表示公开思考摘要、Tool 调用、
   * Skill 调用或 RAG 检索过程。
   */
  upsertStep(step: AgentStep): void;

  /**
   * 登记新 Chat 的首条 Prompt 发送意图。
   *
   * 如果相同 ChatId 已经登记，则不会覆盖原来的幂等键，
   * 从而避免重复创建 Chat 和首条消息。
   */
  registerInitialPromptIntent(intent: InitialPromptIntent): void;

  /**
   * 更新首条 Prompt 意图的发送状态。
   *
   * 例如从 pending 更新为 sending，
   * 或记录 ACK 超时、服务端拒绝和最近一次 Request ID。
   */
  updateInitialPromptIntent(
    chatId: ChatId,
    patch: InitialPromptIntentUpdate,
  ): void;

  /**
   * 删除已经完成处理的首条 Prompt 意图。
   *
   * 一般在 chat.start 被服务端确认接受后调用，
   * 表示该 Prompt 不需要再次自动发送。
   */
  removeInitialPromptIntent(chatId: ChatId): void;

  /**
   * 清空 Chat、Message、Run、Step 和首条 Prompt 意图。
   *
   * 主要在退出登录或切换账号时调用；
   * Store 实例及当前 Transport 连接状态仍然保留。
   */
  resetBusinessState(): void;
}

/** Store 中的数据和操作方法。 */
export type IMStore = IMStoreState & IMStoreActions;

/** Zustand Vanilla Store 的实例类型。 */
export type IMStoreApi = StoreApi<IMStore>;

/** 创建一份干净的 IM Store 数据状态。 */
export function createInitialIMStoreState(
  connection: Readonly<IMConnectionState>,
): IMStoreState {
  return {
    connection: { ...connection },
    session: {
      connectionId: null,
      lastPongAt: null,
      cursor: null,
    },
    chatIds: [],
    chatsById: {},
    messageIdsByChatId: {},
    messagesById: {},
    runIdsByChatId: {},
    runsById: {},
    stepsById: {},
    initialPromptIntentsByChatId: {},
  };
}

/**
 * 创建全局 IM Store。
 *
 * 使用 zustand/vanilla，而不是直接使用 React Hook，
 * 使 imService 可以在 React 组件之外处理 WebSocket 事件。
 */
export function createIMStore(
  initialConnection: Readonly<IMConnectionState>,
): IMStoreApi {
  return createStore<IMStore>()((set) => ({
    ...createInitialIMStoreState(initialConnection),

    setConnectionState: (connection) => {
      set({
        connection: { ...connection },
      });
    },

    updateSessionState: (patch) => {
      set((state) => ({
        session: {
          ...state.session,
          ...patch,
        },
      }));
    },

    upsertChat: (chat) => {
      set((state) => {
        const exists = state.chatsById[chat.id] !== undefined;

        return {
          chatIds: exists ? state.chatIds : [...state.chatIds, chat.id],
          chatsById: {
            ...state.chatsById,
            [chat.id]: chat,
          },
        };
      });
    },

    applyChatSnapshot: (snapshot) => {
      set((state) => {
        const chatId = snapshot.chat.id;
        const chatExists = state.chatsById[chatId] !== undefined;

        /** 先移除当前 Chat 的旧消息，再写入权威快照。 */
        const messagesById = { ...state.messagesById };
        const previousMessageIds = state.messageIdsByChatId[chatId] ?? [];

        for (const messageId of previousMessageIds) {
          delete messagesById[messageId];
        }

        for (const message of snapshot.messages) {
          messagesById[message.id] = message;
        }

        /** 通过旧 Run 找到并移除当前 Chat 的旧 Step。 */
        const stepsById = { ...state.stepsById };
        const previousRunIds = state.runIdsByChatId[chatId] ?? [];

        for (const runId of previousRunIds) {
          const previousRun = state.runsById[runId];

          if (!previousRun) {
            continue;
          }

          for (const stepId of previousRun.stepIds) {
            delete stepsById[stepId];
          }
        }

        for (const step of snapshot.steps) {
          stepsById[step.id] = step;
        }

        /** 先移除当前 Chat 的旧 Run，再写入权威快照。 */
        const runsById = { ...state.runsById };

        for (const runId of previousRunIds) {
          delete runsById[runId];
        }

        for (const run of snapshot.runs) {
          runsById[run.id] = run;
        }

        return {
          session: {
            ...state.session,
            cursor: snapshot.cursor ?? state.session.cursor,
          },
          chatIds: chatExists
            ? state.chatIds
            : [...state.chatIds, chatId],
          chatsById: {
            ...state.chatsById,
            [chatId]: snapshot.chat,
          },
          messageIdsByChatId: {
            ...state.messageIdsByChatId,
            [chatId]: snapshot.messages.map((message) => message.id),
          },
          messagesById,
          runIdsByChatId: {
            ...state.runIdsByChatId,
            [chatId]: snapshot.runs.map((run) => run.id),
          },
          runsById,
          stepsById,
        };
      });
    },

    upsertMessage: (message) => {
      set((state) => {
        const exists = state.messagesById[message.id] !== undefined;
        const currentIds = state.messageIdsByChatId[message.chatId] ?? [];

        return {
          messageIdsByChatId: exists
            ? state.messageIdsByChatId
            : {
                ...state.messageIdsByChatId,
                [message.chatId]: [...currentIds, message.id],
              },
          messagesById: {
            ...state.messagesById,
            [message.id]: message,
          },
        };
      });
    },

    appendMessageDelta: ({ messageId, delta, updatedAt }) => {
      set((state) => {
        const message = state.messagesById[messageId];

        if (!message || delta.length === 0) {
          return state;
        }

        return {
          messagesById: {
            ...state.messagesById,
            [messageId]: {
              ...message,
              status: 'streaming',
              content: {
                ...message.content,
                content: message.content.content + delta,
              },
              updatedAt,
            },
          },
        };
      });
    },

    upsertRun: (run) => {
      set((state) => {
        const exists = state.runsById[run.id] !== undefined;
        const currentIds = state.runIdsByChatId[run.chatId] ?? [];

        return {
          runIdsByChatId: exists
            ? state.runIdsByChatId
            : {
                ...state.runIdsByChatId,
                [run.chatId]: [...currentIds, run.id],
              },
          runsById: {
            ...state.runsById,
            [run.id]: run,
          },
        };
      });
    },

    upsertStep: (step) => {
      set((state) => {
        const stepsById = {
          ...state.stepsById,
          [step.id]: step,
        };
        const run = state.runsById[step.runId];

        /** Run 可能尚未到达，Step 仍然可以先独立保存。 */
        if (!run || run.stepIds.includes(step.id)) {
          return { stepsById };
        }

        const stepIds = [...run.stepIds, step.id].sort((leftId, rightId) => {
          const leftSequence = stepsById[leftId]?.sequence ?? Number.MAX_SAFE_INTEGER;
          const rightSequence = stepsById[rightId]?.sequence ?? Number.MAX_SAFE_INTEGER;

          return leftSequence - rightSequence;
        });

        return {
          stepsById,
          runsById: {
            ...state.runsById,
            [run.id]: {
              ...run,
              stepIds,
            },
          },
        };
      });
    },

    registerInitialPromptIntent: (intent) => {
      set((state) => {
        /** 已登记的意图不能被新幂等键意外覆盖。 */
        if (state.initialPromptIntentsByChatId[intent.chatId]) {
          return state;
        }

        return {
          initialPromptIntentsByChatId: {
            ...state.initialPromptIntentsByChatId,
            [intent.chatId]: intent,
          },
        };
      });
    },

    updateInitialPromptIntent: (chatId, patch) => {
      set((state) => {
        const intent = state.initialPromptIntentsByChatId[chatId];

        if (!intent) {
          return state;
        }

        return {
          initialPromptIntentsByChatId: {
            ...state.initialPromptIntentsByChatId,
            [chatId]: {
              ...intent,
              ...patch,
            },
          },
        };
      });
    },

    removeInitialPromptIntent: (chatId) => {
      set((state) => {
        if (!state.initialPromptIntentsByChatId[chatId]) {
          return state;
        }

        const initialPromptIntentsByChatId = {
          ...state.initialPromptIntentsByChatId,
        };

        delete initialPromptIntentsByChatId[chatId];

        return { initialPromptIntentsByChatId };
      });
    },

    resetBusinessState: () => {
      set((state) => createInitialIMStoreState(state.connection));
    },
  }));
}
