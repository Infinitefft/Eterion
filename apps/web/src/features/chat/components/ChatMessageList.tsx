import { Fragment } from 'react';

import { getAssistantPlaceholders } from '@/features/chat/model/chatSelectors';
import type { AgentBlockState, MessageState, RunId, RunState, ThreadId } from '@/service/im/types';
import { useIMStore } from '@/store/im-store';

import { AgentRunTrace } from './agent/AgentRunTrace';
import { ThinkingIndicator } from './agent/ThinkingIndicator';

const EMPTY_MESSAGES: MessageState[] = [];
const EMPTY_RUNS: RunState[] = [];
const EMPTY_BLOCKS: AgentBlockState[] = [];

interface ChatMessageListProps {
  threadId: ThreadId;
}

interface MessageProps {
  message: MessageState;
}

function getUserMessageStatus(message: MessageState): string | null {
  switch (message.status) {
    case 'sending':
      return '发送中';
    case 'streaming':
    case 'completed':
      return null;
    case 'failed':
      return message.error?.message || '发送失败';
    case 'cancelled':
      return '发送已取消';
  }
}

/** 用户消息正文和发送终态。重试能力留给后续 Command 层。 */
function UserMessage({ message }: MessageProps) {
  const statusText = getUserMessageStatus(message);
  const isError = message.status === 'failed';

  return (
    <article className='chat-message-row chat-message-row-user' data-status={message.status}>
      <div className='chat-user-message'>
        <p className='chat-message-text'>{message.content}</p>

        {statusText ? (
          <span
            className={isError ? 'chat-message-status is-error' : 'chat-message-status'}
            role={isError ? 'alert' : undefined}
          >
            {statusText}
          </span>
        ) : null}
      </div>
    </article>
  );
}

function getAssistantStatus(message: MessageState): string | null {
  switch (message.status) {
    case 'sending':
    case 'streaming':
    case 'completed':
      return null;
    case 'failed':
      return message.error?.message || '回答生成失败';
    case 'cancelled':
      return '已停止生成';
  }
}

/** Assistant 正文及其关联 Run 的公开过程。 */
function AssistantMessage({ message }: MessageProps) {
  const statusText = getAssistantStatus(message);
  const isStreaming = message.status === 'streaming';
  const isWaitingForContent = isStreaming && !message.content;
  const isError = message.status === 'failed';

  return (
    <article
      className='chat-message-row chat-message-row-assistant'
      data-status={message.status}
      aria-busy={isStreaming}
    >
      <div className='chat-assistant-avatar' aria-hidden='true'>
        <img src='/eterion-icon-transparent.png' alt='' />
      </div>

      <div className='chat-assistant-content'>
        {message.runId ? (
          <AgentRunTrace
            threadId={message.threadId}
            runId={message.runId}
            hideThinkingIndicator={isStreaming}
            content={message.content}
          />
        ) : null}

        {isWaitingForContent ? (
          <p className='chat-assistant-thinking'>
            <ThinkingIndicator />
          </p>
        ) : null}

        {!message.runId && message.content ? (
          <p className='chat-message-text'>{message.content}</p>
        ) : null}

        {statusText ? (
          <span
            className={isError ? 'chat-message-status is-error' : 'chat-message-status'}
            role={isError ? 'alert' : undefined}
          >
            {statusText}
          </span>
        ) : null}
      </div>
    </article>
  );
}

/** 正式 AI 消息出现前的过程区域，也保留没有正文的历史运行结果。 */
function PendingAssistantMessage({ threadId, runId }: { threadId: ThreadId; runId: RunId | null }) {
  return (
    <article className='chat-message-row chat-message-row-assistant' aria-live='polite'>
      <div className='chat-assistant-avatar' aria-hidden='true'>
        <img src='/eterion-icon-transparent.png' alt='' />
      </div>
      <div className='chat-assistant-content'>
        {runId === null ? (
          <p className='chat-assistant-thinking'>
            <ThinkingIndicator />
          </p>
        ) : (
          <AgentRunTrace threadId={threadId} runId={runId} />
        )}
      </div>
    </article>
  );
}

/** 当前 Thread 的消息列表；Thinking、Tool 和 HITL 由各消息关联的 Run 展示。 */
export function ChatMessageList({ threadId }: ChatMessageListProps) {
  const messages = useIMStore(
    (state) => state.detailsByThread[threadId]?.messages ?? EMPTY_MESSAGES,
  );
  const runs = useIMStore((state) => state.detailsByThread[threadId]?.runs ?? EMPTY_RUNS);
  const blocks = useIMStore((state) => state.detailsByThread[threadId]?.blocks ?? EMPTY_BLOCKS);

  if (messages.length === 0) {
    return (
      <div className='chat-message-empty'>
        <span>等待第一条消息</span>
        <p>新对话的首条消息会在这里自动出现。</p>
      </div>
    );
  }

  const placeholders = getAssistantPlaceholders(messages, runs, blocks);

  return (
    <div className='chat-message-list' role='log' aria-label='会话消息'>
      {messages.map((message) => {
        const runId = placeholders.get(message.id);
        return message.role === 'user' ? (
          <Fragment key={message.id}>
            <UserMessage message={message} />
            {runId !== undefined ? (
              <PendingAssistantMessage threadId={threadId} runId={runId} />
            ) : null}
          </Fragment>
        ) : (
          <AssistantMessage key={message.id} message={message} />
        );
      })}
    </div>
  );
}
