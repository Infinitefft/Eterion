import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

import type { ServerThreadEvent }  from '@/service/im/protocol';
import type {
  MessageState,
  ThreadId,
  ThreadRecord,
} from '@/service/im/types';

export interface IMStore {
  threads: ThreadRecord[];

  detialsByThread: Partial<Record<ThreadId, { messages: MessageState[] }>>;

  applyEnvelope(event: ServerThreadEvent): void;
}

export const useIMStore = create<IMStore>()(
  immer((set) => ({
    threads: [],
    detialsByThread: {},

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

            state.threads.sort((a, b) => a.updatedAt - b.updatedAt);

            break;
          }
          
          case 'message.started': {
            // ??= 表示只有该会话还没还有详情时，才创建消息列表
            const detail = (state.detialsByThread[event.threadId]) ??= {
              messages: [],
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
            
            const index = detail.messages.findIndex(
              (item) => item.id === event.messageId,
            );

            if (index === -1) {
              return;
            } else {
              detail.messages[index] = message;
            }

            break;
          }
          case 'message.delta': {
            const message = state.detialsByThread[event.threadId]?.messages.find(
              (item) => item.id === event.messageId
            )

            if (!message) {
              return;
            }

            message.content += event.payload.delta;

            break;
          }

          case 'message.completed': {
            const detail = (state.detialsByThread[event.threadId] ??= {
              messages: [],
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
        }
      })
    }
  }))
)