import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

import type { ServerThreadEvent }  from '@/service/im/protocol';
import type { IMConnectionState } from '@/service/im/transport';
import type {
  MessageState,
  RunState,
  AgentBlockState,
  ThinkingBlockState,
  ToolCallBlockState,
  HITLInteractionState,
  ThreadSnapshot,
  MessageId,
  ProtocolError,
  ThreadId,
  ThreadRecord,
} from '@/service/im/types';

type IMLoadState = 
  | { status: 'idle' | 'loading' | 'ready' }
  | { status: 'error'; message: string };

export interface IMStore {
  threads: ThreadRecord[];

  // 当前正在查看的会话由详情页登记，离开会话后恢复为 null。
  activeThreadId: ThreadId | null;

  // 未读是前端状态，独立保存可避免 HTTP 列表、标题或快照更新覆盖它。
  // 只记录未读会话；没有对应的键就表示没有未读提醒。
  unreadByThread: Partial<Record<ThreadId, true>>;

  setActiveThread(threadId: ThreadId | null): void;
  markThreadUnread(threadId: ThreadId): void;
  markThreadRead(threadId: ThreadId): void;

  // 保存页面的所有内容 
  detailsByThread: Partial<Record<ThreadId, { 
    messages: MessageState[],
    runs: RunState[],
    blocks: AgentBlockState[],
  }>>;

  // 根据 IM 分发的消息类型进行判断，然后保存到 detailsByThread 中
  applyEnvelope(event: ServerThreadEvent): void;

  // 刚进入网站首页时调用后端接口获取历史会话列表
  setThreads(threads: ThreadRecord[]): void;

  // 第一次进入到一个详情页面中调用后端接口后将当前页面的所有数据保存到 detailsByThread 中，或者是断续重连后
  applySnapshot(snapshot: ThreadSnapshot): void;

  // 整个会话列表共用一个加载状态
  threadListLoadState: IMLoadState;

  // 每个会话的详情独立加载,因此按 threadId 分开保存
  detailLoadStateByThread: Partial<Record<ThreadId, IMLoadState>>;

  setThreadListLoadState(loadState: IMLoadState): void;

  setThreadDetailLoadState(threadId: ThreadId, loadState: IMLoadState): void;

  connection: IMConnectionState;

  setConnectionState(connection: Readonly<IMConnectionState>): void;

  reset(): void;

  addSendingMessage(
    threadId: ThreadId,
    messageId: MessageId,
    content: string,
  ): void;

  failSendingMessage(
    threadId: ThreadId,
    messageId: MessageId,
    error: ProtocolError,
  ): void;
}

export const useIMStore = create<IMStore>()(
  immer((set) => ({
    threads: [],
    activeThreadId: null,
    unreadByThread: {},
    detailsByThread: {},
    threadListLoadState: { status: 'idle' },
    detailLoadStateByThread: {},
    connection: {
      status: 'idle',
      reconnectAttempts: 0,
      connectedAt: null,
      disconnectedAt: null,
      lastError: null,
    },

    setActiveThread: (threadId) => {
      set((state) => {
        // 登记路由不代表内容已展示；清除未读由页面在消息就绪后单独触发。
        state.activeThreadId = threadId;
      });
    },

    markThreadUnread: (threadId) => {
      set((state) => {
        // 是否需要提醒由 IM 事件入口判断，这里只通过 Immer 更新状态。
        state.unreadByThread[threadId] = true;
      });
    },

    markThreadRead: (threadId) => {
      set((state) => {
        // 删除标记即可清除这一个会话的未读，不影响其他会话。
        delete state.unreadByThread[threadId];
      });
    },

    applyEnvelope: (event) => {
      set((state) => {
        switch (event.type) {
          case 'thread.updated': {
            const thread: ThreadRecord = {
              id: event.threadId,
              ...event.payload,
            }

            const index = state.threads.findIndex((item) => item.id === event.threadId);
            
            if (index === -1) {
              state.threads.push(thread);
            } else {
              state.threads[index] = thread;
            }

            state.threads.sort((a, b) => b.updatedAt - a.updatedAt);

            break;
          }
          
          case 'message.started': {
            // ??= 表示只有该会话还没还有详情时，才创建消息列表
            const detail = (state.detailsByThread[event.threadId]) ??= {
              messages: [],
              runs: [],
              blocks: [],
            }

            const message: MessageState = {
              id: event.messageId,
              threadId: event.threadId,
              runId: event.runId,
              ...event.payload,
              
              content: '',
              status: 'streaming',
              completedAt: null,
              error: null,
            }

            detail.messages.push(message);

            break;
          }

          case 'message.delta': {
            const message = state.detailsByThread[event.threadId]?.messages.find(
              (item) => item.id === event.messageId
            )

            if (!message) {
              return;
            }

            message.content += event.payload.delta;

            break;
          }

          case 'message.completed': {
            const detail = (state.detailsByThread[event.threadId] ??= {
              messages: [],
              runs: [],
              blocks: [],
            })

            const index = detail.messages.findIndex(
              (item) => item.id === event.messageId
            )

            // index 为 -1 时，current 就是 undefined，表示本地还没有这条消息
            const current = detail.messages[index];

            const message: MessageState = {
              id: event.messageId,
              threadId: event.threadId,
              runId: event.runId ?? current?.runId ?? null,
              ...event.payload,
            }

            if (index === -1) {
              detail.messages.push(message);
            } else {
              detail.messages[index] = message;
            }

            break;
          }

          case 'run.status' : {
            const detail = (state.detailsByThread[event.threadId] ??= {
              messages: [],
              runs: [],
              blocks: [],
            });

            const run: RunState = {
              id: event.runId,
              threadId: event.threadId,
              ...event.payload,
            }

            const index = detail.runs.findIndex(
              (item) => item.id === event.runId,
            );

            if (index === -1) {
              detail.runs.push(run);
            } else {
              detail.runs[index] = run;
            }
            
            break;
          }

          case 'thinking.delta': {
            const detail = (state.detailsByThread[event.threadId] ??= {
              messages: [],
              runs: [],
              blocks: [],
            })
            
            const block = detail.blocks.find(
              (item): item is ThinkingBlockState => 
                item.kind === 'thinking' && item.id === event.thinkingId
            )

            if (block) {
              block.content += event.payload.delta;
            } else {
              detail.blocks.push({
                kind: 'thinking',
                id: event.thinkingId,
                threadId: event.threadId,
                runId: event.runId,
                status: 'streaming',
                content: event.payload.delta,
              })
            }

            break;
          }

          case 'thinking.completed': {
            const detail = (state.detailsByThread[event.threadId] ??= {
              messages: [],
              runs: [],
              blocks: [],
            });

            const block = detail.blocks.find(
              (item): item is ThinkingBlockState => 
                item.kind === 'thinking' && item.id === event.thinkingId
            )

            if (block) {
              block.content = event.payload.content;
              block.status = 'completed';
            } else {
              detail.blocks.push({
                kind: 'thinking',
                id: event.thinkingId,
                threadId: event.threadId,
                runId: event.runId,
                status: 'completed',
                content: event.payload.content, 
              })
            }

            break;
          }

          case 'tool.started': {
            const detail = (state.detailsByThread[event.threadId] ??= {
              messages: [],
              runs: [],
              blocks: [],
            });

            const tool: ToolCallBlockState = {
              kind: 'tool',
              id: event.toolCallId,
              threadId: event.threadId,
              runId: event.runId,
              ...event.payload,
              status: 'running',
              summary: null,
              result: null,
              error: null,
            }

            const index = detail.blocks.findIndex(
              (item) => item.kind === 'tool' && item.id === event.toolCallId,
            );

            if (index === -1) {
              detail.blocks.push(tool);
            } else {
              detail.blocks[index] = tool;
            }

            break;
          }

          case 'tool.completed': {
            const tool = state.detailsByThread[event.threadId]?.blocks.find(
              (item): item is ToolCallBlockState => 
                item.kind === 'tool' && item.id === event.toolCallId
            );

            if (!tool) {
              break;
            }

            tool.status = 'completed';
            tool.summary = event.payload.summary;
            tool.result = event.payload.result;

            break;
          }

          case 'tool.failed': {
            const tool = state.detailsByThread[event.threadId]?.blocks.find(
              (item): item is ToolCallBlockState => 
                item.kind === 'tool' && item.id === event.toolCallId
            );

            if (!tool) {
              break;
            }

            tool.status = 'failed';
            tool.error = event.payload.error;

            break;
          }

          case 'interaction.requested': {
            const detail = (state.detailsByThread[event.threadId] ??= {
              messages: [],
              runs: [],
              blocks: [],
            })

            const interaction: HITLInteractionState = {
              kind: 'hitl',
              id: event.interactionId,
              threadId: event.threadId,
              runId: event.runId,
              status: 'requested',
              questions: event.payload.questions,
              answers: null,
            };

            const index = detail.blocks.findIndex(
              (item) => item.kind === 'hitl' && item.id === event.interactionId
            );

            if (index === -1) {
              detail.blocks.push(interaction);
            } else {
              detail.blocks[index] = interaction;
            }

            break;
          }
          
          case 'interaction.resolved': {
            const interaction = state.detailsByThread[event.threadId]?.blocks.find(
              (item): item is HITLInteractionState =>
                item.kind === 'hitl' && item.id === event.interactionId,
            );

            if (!interaction) {
              break;
            }

            interaction.status = 'resolved';
            interaction.answers = event.payload.answers;
          }
        }
      })
    },

    setThreads: (threads) => {
      set((state) => {
        state.threads = [...threads].sort((a, b) => (
          b.updatedAt - a.updatedAt
        ));

        state.threadListLoadState = { status: 'ready' };
      })
    },

    applySnapshot: (snapshot) => {
      set((state) => {
        const { thread, messages, runs, blocks } = snapshot;

        const loadMessages = 
          state.detailsByThread[thread.id]?.messages.filter(
            (message) => (
              message.role === 'user' &&
              (message.status === 'sending' || message.status === 'failed') &&
              !messages.some((item) => item.id === message.id)
            )
          ) ?? [];

        state.detailsByThread[thread.id] = {
          messages: [...messages, ...loadMessages].sort((a, b) => (
            a.createdAt - b.createdAt
          )),
          runs,
          blocks,
        };

        state.detailLoadStateByThread[thread.id] = { status: 'ready' };

        const index = state.threads.findIndex(
          (item) => item.id === thread.id
        )

        if (index == -1) {
          state.threads.push(thread);
        } else {
          state.threads[index] = thread;
        }

        state.threads.sort((a, b) => b.updatedAt - a.updatedAt);
      })
    },

    setThreadListLoadState: (loadState) => {
      set((state) => {
        state.threadListLoadState = loadState;
      })
    },

    setThreadDetailLoadState: (threadId, loadState) => {
      set((state) => {
        state.detailLoadStateByThread[threadId] = loadState;
      })
    },

    setConnectionState: (connection) => {
      set((state) => {
        state.connection = connection;
      })
    },

    reset: () => {
      // 这里的 getInitialState() 是 Zustand 已有的方法。
      // 通过 Immer 更新数据时，初始状态不会被修改，因此可以用它恢复默认值，也避免手动重复写一遍所有初始字段。
      set(useIMStore.getInitialState());
    },

    addSendingMessage: (threadId, messageId, content) => {
      set((state) => {
        const detail = (state.detailsByThread[threadId] ??= {
          messages: [],
          runs: [],
          blocks: [],
        });

        detail.messages.push({
          id: messageId,
          threadId,
          runId: null,
          role: 'user',
          format: 'plain_text',
          content,
          status: 'sending',
          createdAt: Date.now(),
          completedAt: null,
          error: null,
        });
      })
    },

    failSendingMessage: (threadId, messageId, error) => {
      set((state) => {
        const message = state.detailsByThread[threadId]?.messages.find(
          (item) => item.id === messageId
        );

        // 完成事件可能已经达到，迟到的发送错误不能覆盖已确认的消息
        if (!message || message.status !== 'sending') {
          return;
        }

        message.status = 'failed'
        message.error = error;
        message.completedAt = Date.now();
      })
    },
  }))
)
