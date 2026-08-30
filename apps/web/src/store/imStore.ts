import { create } from 'zustand';

import { deleteThread, fetchThreads, fetchThreadSnapshot, updateThreadTitle } from '@/api/im';
import type { IMService, IMServiceEvent, IMServiceUnsubscribe } from '@/service/im/imService';
import type { ServerThreadEvent } from '@/service/im/protocol';
import type { IMConnectionState } from '@/service/im/transport';
import type {
  AgentBlockState,
  HITLInteractionState,
  MessageState,
  RunState,
  ThinkingBlockState,
  ThreadId,
  ThreadRecord,
  ThreadSnapshot,
  ThreadState,
  ToolCallBlockState,
} from '@/service/im/types';

/** HTTP 列表和 Snapshot 的基础加载状态。 */
export type IMLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

/** 一个 Thread 在前端已经组装好的详情数据。 */
export interface ThreadDetailState {
  snapshotStatus: IMLoadStatus;
  snapshotError: string | null;
  messages: MessageState[];
  runs: RunState[];
  blocks: AgentBlockState[];
}

/** 全局 IM Store 保存的数据。 */
export interface IMStoreState {
  connection: Readonly<IMConnectionState>;
  threadListStatus: IMLoadStatus;
  threadListError: string | null;
  threads: ThreadState[];
  detailsByThread: Partial<Record<ThreadId, ThreadDetailState>>;
  activeThreadId: ThreadId | null;
}

/** 页面可以调用的基础操作。 */
export interface IMStoreActions {
  setActiveThread(threadId: ThreadId | null): void;
  markThreadRead(threadId: ThreadId): void;
  loadThreads(): Promise<void>;
  synchronizeThread(threadId: ThreadId): Promise<void>;
  renameThread(threadId: ThreadId, title: string): Promise<void>;
  removeThread(threadId: ThreadId): Promise<void>;
  resetBusinessState(): void;
}

export type IMStore = IMStoreState & IMStoreActions;

const INITIAL_CONNECTION_STATE: IMConnectionState = {
  status: 'idle',
  reconnectAttempts: 0,
  connectedAt: null,
  disconnectedAt: null,
  lastError: null,
};

/** 整个前端只绑定一个 IMService。 */
let boundService: IMService | null = null;

/** 解除 IMService 订阅时使用。 */
let unsubscribeService: IMServiceUnsubscribe | null = null;

/** 同一个 Thread 同时只拉取一次 Snapshot。 */
const snapshotTasks = new Map<ThreadId, Promise<void>>();

function createEmptyDetail(): ThreadDetailState {
  return {
    snapshotStatus: 'idle',
    snapshotError: null,
    messages: [],
    runs: [],
    blocks: [],
  };
}

function createInitialState(
  connection: Readonly<IMConnectionState> = INITIAL_CONNECTION_STATE,
): IMStoreState {
  return {
    connection: { ...connection },
    threadListStatus: 'idle',
    threadListError: null,
    threads: [],
    detailsByThread: {},
    activeThreadId: null,
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'IM 请求失败';
}

/** 第一次出现时追加，后续按 ID 原位更新。 */
function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((current) => current.id === item.id);

  if (index === -1) {
    return [...items, item];
  }

  const nextItems = [...items];
  nextItems[index] = item;
  return nextItems;
}

/** Thread 更新后按 updatedAt 重新排列侧边栏。 */
function upsertThread(threads: ThreadState[], record: ThreadRecord): ThreadState[] {
  const current = threads.find((thread) => thread.id === record.id);
  const nextThread: ThreadState = {
    ...record,
    hasUnread: current?.hasUnread ?? false,
  };

  return [nextThread, ...threads.filter((thread) => thread.id !== record.id)].sort(
    (left, right) => right.updatedAt - left.updatedAt,
  );
}

function setThreadUnread(
  threads: ThreadState[],
  threadId: ThreadId,
  hasUnread: boolean,
): ThreadState[] {
  return threads.map((thread) => (thread.id === threadId ? { ...thread, hasUnread } : thread));
}

/** Block 的 ID 只需要在相同 kind 内保持唯一。 */
function upsertBlock(blocks: AgentBlockState[], block: AgentBlockState): AgentBlockState[] {
  const index = blocks.findIndex(
    (current) => current.kind === block.kind && current.id === block.id,
  );

  if (index === -1) {
    return [...blocks, block];
  }

  const nextBlocks = [...blocks];
  nextBlocks[index] = block;
  return nextBlocks;
}

/** 更新一个 Thread 的详情，不影响其他 Thread。 */
function updateDetail(
  threadId: ThreadId,
  updater: (detail: ThreadDetailState) => ThreadDetailState,
): void {
  /** 函数只会在模块初始化完成后调用，此时 Store 已经创建。 */
  // eslint-disable-next-line @typescript-eslint/no-use-before-define
  useIMStore.setState((state) => {
    const detail = state.detailsByThread[threadId] ?? createEmptyDetail();

    return {
      detailsByThread: {
        ...state.detailsByThread,
        [threadId]: updater(detail),
      },
    };
  });
}

function findToolBlock(
  detail: ThreadDetailState,
  toolCallId: string,
): ToolCallBlockState | undefined {
  return detail.blocks.find(
    (block): block is ToolCallBlockState => block.kind === 'tool' && block.id === toolCallId,
  );
}

function findHITLBlock(
  detail: ThreadDetailState,
  interactionId: string,
): HITLInteractionState | undefined {
  return detail.blocks.find(
    (block): block is HITLInteractionState => block.kind === 'hitl' && block.id === interactionId,
  );
}

/* 以下函数只会在 useIMStore 初始化完成后执行。 */
/* eslint-disable @typescript-eslint/no-use-before-define */

/**
 * IMService 已经完成 seqId 排序，因此 Store 只负责把事件合并成页面状态。
 */
// 所有协议事件集中在一个 switch 中，方便直接对照 protocol.ts。
// eslint-disable-next-line complexity
function applyEnvelope(event: ServerThreadEvent): void {
  const threadId = event.threadId;

  switch (event.type) {
    case 'thread.updated': {
      useIMStore.setState((state) => ({
        threads: upsertThread(state.threads, {
          id: threadId,
          title: event.payload.title,
          createdAt: event.payload.createdAt,
          updatedAt: event.payload.updatedAt,
        }),
      }));
      return;
    }

    case 'run.status': {
      const run: RunState = {
        id: event.runId,
        threadId,
        modelId: event.payload.modelId,
        inputMessageId: event.payload.inputMessageId,
        outputMessageId: event.payload.outputMessageId,
        status: event.payload.status,
        createdAt: event.payload.createdAt,
        startedAt: event.payload.startedAt,
        completedAt: event.payload.completedAt,
        error: event.payload.error,
      };

      updateDetail(threadId, (detail) => ({
        ...detail,
        runs: upsertById(detail.runs, run),
      }));
      return;
    }

    case 'message.started': {
      const message: MessageState = {
        id: event.messageId,
        threadId,
        runId: event.runId,
        role: event.payload.role,
        format: event.payload.format,
        content: '',
        status: 'streaming',
        createdAt: event.payload.createdAt,
        completedAt: null,
        error: null,
      };

      updateDetail(threadId, (detail) => ({
        ...detail,
        messages: upsertById(detail.messages, message),
      }));
      return;
    }

    case 'message.delta': {
      updateDetail(threadId, (detail) => {
        const current = detail.messages.find((message) => message.id === event.messageId);

        if (!current) {
          return detail;
        }

        return {
          ...detail,
          messages: upsertById(detail.messages, {
            ...current,
            content: current.content + event.payload.delta,
          }),
        };
      });
      return;
    }

    case 'message.completed': {
      updateDetail(threadId, (detail) => {
        const current = detail.messages.find((message) => message.id === event.messageId);
        const message: MessageState = {
          id: event.messageId,
          threadId,
          runId: event.runId ?? current?.runId ?? null,
          role: event.payload.role,
          format: event.payload.format,
          content: event.payload.content,
          status: event.payload.status,
          createdAt: event.payload.createdAt,
          completedAt: event.payload.completedAt,
          error: event.payload.error,
        };

        return {
          ...detail,
          messages: upsertById(detail.messages, message),
        };
      });

      /** 只有后台 Thread 的 Assistant 终态消息需要红点。 */
      if (event.payload.role === 'assistant' && useIMStore.getState().activeThreadId !== threadId) {
        useIMStore.setState((state) => ({
          threads: setThreadUnread(state.threads, threadId, true),
        }));
      }
      return;
    }

    case 'thinking.delta': {
      updateDetail(threadId, (detail) => {
        const current = detail.blocks.find(
          (block): block is ThinkingBlockState =>
            block.kind === 'thinking' && block.id === event.thinkingId,
        );
        const block: ThinkingBlockState = {
          kind: 'thinking',
          id: event.thinkingId,
          threadId,
          runId: event.runId,
          status: 'streaming',
          content: (current?.content ?? '') + event.payload.delta,
        };

        return {
          ...detail,
          blocks: upsertBlock(detail.blocks, block),
        };
      });
      return;
    }

    case 'thinking.completed': {
      const block: ThinkingBlockState = {
        kind: 'thinking',
        id: event.thinkingId,
        threadId,
        runId: event.runId,
        status: 'completed',
        content: event.payload.content,
      };

      updateDetail(threadId, (detail) => ({
        ...detail,
        blocks: upsertBlock(detail.blocks, block),
      }));
      return;
    }

    case 'tool.started': {
      const block: ToolCallBlockState = {
        kind: 'tool',
        id: event.toolCallId,
        threadId,
        runId: event.runId,
        status: 'running',
        name: event.payload.name,
        displayName: event.payload.displayName,
        args: event.payload.args,
        summary: null,
        result: null,
        error: null,
      };

      updateDetail(threadId, (detail) => ({
        ...detail,
        blocks: upsertBlock(detail.blocks, block),
      }));
      return;
    }

    case 'tool.completed': {
      updateDetail(threadId, (detail) => {
        const current = findToolBlock(detail, event.toolCallId);

        if (!current) {
          return detail;
        }

        return {
          ...detail,
          blocks: upsertBlock(detail.blocks, {
            ...current,
            status: 'completed',
            summary: event.payload.summary,
            result: event.payload.result,
            error: null,
          }),
        };
      });
      return;
    }

    case 'tool.failed': {
      updateDetail(threadId, (detail) => {
        const current = findToolBlock(detail, event.toolCallId);

        if (!current) {
          return detail;
        }

        return {
          ...detail,
          blocks: upsertBlock(detail.blocks, {
            ...current,
            status: 'failed',
            summary: null,
            result: null,
            error: event.payload.error,
          }),
        };
      });
      return;
    }

    case 'interaction.requested': {
      const block: HITLInteractionState = {
        kind: 'hitl',
        id: event.interactionId,
        threadId,
        runId: event.runId,
        status: 'requested',
        questions: event.payload.questions,
        answers: null,
      };

      updateDetail(threadId, (detail) => ({
        ...detail,
        blocks: upsertBlock(detail.blocks, block),
      }));

      if (useIMStore.getState().activeThreadId !== threadId) {
        useIMStore.setState((state) => ({
          threads: setThreadUnread(state.threads, threadId, true),
        }));
      }
      return;
    }

    case 'interaction.resolved': {
      updateDetail(threadId, (detail) => {
        const current = findHITLBlock(detail, event.interactionId);

        if (!current) {
          return detail;
        }

        return {
          ...detail,
          blocks: upsertBlock(detail.blocks, {
            ...current,
            status: 'resolved',
            answers: event.payload.answers,
          }),
        };
      });
    }
  }
}

/** Snapshot 会整体替换一个 Thread 的服务端状态。 */
function applySnapshot(snapshot: ThreadSnapshot): void {
  useIMStore.setState((state) => {
    const current = state.threads.find((thread) => thread.id === snapshot.thread.id);
    const thread: ThreadState = {
      ...snapshot.thread,
      /** 是否已读由页面在 Snapshot 成功后明确提交；加载失败时不能提前清掉红点。 */
      hasUnread: current?.hasUnread ?? false,
    };

    return {
      threads: [thread, ...state.threads.filter((item) => item.id !== thread.id)].sort(
        (left, right) => right.updatedAt - left.updatedAt,
      ),
      detailsByThread: {
        ...state.detailsByThread,
        [snapshot.thread.id]: {
          snapshotStatus: 'ready',
          snapshotError: null,
          messages: snapshot.messages,
          runs: snapshot.runs,
          blocks: snapshot.blocks,
        },
      },
    };
  });
}

function setSnapshotState(threadId: ThreadId, status: IMLoadStatus, error: string | null): void {
  updateDetail(threadId, (detail) => ({
    ...detail,
    snapshotStatus: status,
    snapshotError: error,
  }));
}

/** 最基础的缺口恢复流程：暂停事件、加载 Snapshot、恢复事件。 */
async function runThreadSynchronization(threadId: ThreadId): Promise<void> {
  const service = boundService;

  if (!service) {
    throw new Error('IM Store 尚未绑定 IMService');
  }

  try {
    service.pauseThread(threadId);
    setSnapshotState(threadId, 'loading', null);

    const snapshot = await fetchThreadSnapshot(threadId);
    applySnapshot(snapshot);

    /** resume 可能同步产生新的 gap，所以先释放当前任务。 */
    snapshotTasks.delete(threadId);
    service.resumeThread(threadId, snapshot.lastSeqId);
  } catch (error) {
    setSnapshotState(threadId, 'error', getErrorMessage(error));
    throw error;
  }
}

function synchronizeThread(threadId: ThreadId): Promise<void> {
  const currentTask = snapshotTasks.get(threadId);

  if (currentTask) {
    return currentTask;
  }

  const task = runThreadSynchronization(threadId);
  snapshotTasks.set(threadId, task);

  /** 只清理自己，避免误删 resume 期间创建的新任务。 */
  void task.then(
    () => {
      if (snapshotTasks.get(threadId) === task) {
        snapshotTasks.delete(threadId);
      }
    },
    () => {
      if (snapshotTasks.get(threadId) === task) {
        snapshotTasks.delete(threadId);
      }
    },
  );

  return task;
}

/** IMService 对 Store 只有一个统一事件入口。 */
function applyServiceEvent(event: IMServiceEvent): void {
  if (event.kind === 'connection') {
    const previous = useIMStore.getState().connection;
    const activeThreadId = useIMStore.getState().activeThreadId;

    useIMStore.setState({ connection: { ...event.state } });

    /** 新连接建立后，重新同步当前正在看的 Thread。 */
    if (
      event.state.status === 'connected' &&
      event.state.connectedAt !== previous.connectedAt &&
      activeThreadId
    ) {
      void synchronizeThread(activeThreadId).catch(() => undefined);
    }
    return;
  }

  if (event.kind === 'sequenceGap') {
    void synchronizeThread(event.gap.threadId).catch(() => undefined);
    return;
  }

  applyEnvelope(event.envelope);
}

/* eslint-enable @typescript-eslint/no-use-before-define */

/** 全局 Zustand IM Store。 */
export const useIMStore = create<IMStore>()((set) => ({
  ...createInitialState(),

  setActiveThread: (threadId) => {
    /** 这里只登记当前页面；真正看到完整数据后再由 markThreadRead 清除红点。 */
    set({ activeThreadId: threadId });
  },

  markThreadRead: (threadId) => {
    set((state) => ({
      threads: setThreadUnread(state.threads, threadId, false),
    }));
  },

  loadThreads: async () => {
    set({ threadListStatus: 'loading', threadListError: null });

    try {
      const records = await fetchThreads();

      set((state) => ({
        threadListStatus: 'ready',
        threadListError: null,
        threads: records.map((record) => ({
          ...record,
          hasUnread: state.threads.find((thread) => thread.id === record.id)?.hasUnread ?? false,
        })),
      }));
    } catch (error) {
      set({
        threadListStatus: 'error',
        threadListError: getErrorMessage(error),
      });
      throw error;
    }
  },

  synchronizeThread,

  renameThread: async (threadId, title) => {
    const thread = await updateThreadTitle(threadId, title);

    set((state) => ({
      threads: upsertThread(state.threads, thread),
    }));
  },

  removeThread: async (threadId) => {
    await deleteThread(threadId);
    snapshotTasks.delete(threadId);

    set((state) => {
      const detailsByThread = { ...state.detailsByThread };
      delete detailsByThread[threadId];

      return {
        threads: state.threads.filter((thread) => thread.id !== threadId),
        detailsByThread,
        activeThreadId: state.activeThreadId === threadId ? null : state.activeThreadId,
      };
    });
  },

  resetBusinessState: () => {
    snapshotTasks.clear();
    set((state) => createInitialState(state.connection));
  },
}));

/**
 * 在应用 Runtime 中调用一次，把全局 IMService 接到 Store。
 */
export function bindIMStore(service: IMService): () => void {
  if (boundService === service && unsubscribeService) {
    return () => undefined;
  }

  unsubscribeService?.();
  boundService = service;
  unsubscribeService = service.subscribe(applyServiceEvent);
  useIMStore.setState({ connection: { ...service.getConnectionState() } });

  return () => {
    if (boundService === service) {
      unbindIMStore();
    }
  };
}

/** Runtime 销毁或 HMR 时解除绑定。 */
export function unbindIMStore(): void {
  unsubscribeService?.();
  unsubscribeService = null;
  boundService = null;
  snapshotTasks.clear();
}
