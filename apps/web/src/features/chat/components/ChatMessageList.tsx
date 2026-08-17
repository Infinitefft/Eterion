import { LoaderCircle, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { useStore } from 'zustand';

import {
  PENDING_ASSISTANT_WAITING_FOR_RUN,
  selectPendingAssistantKey,
} from '@/features/chat/model/chatSelectors';
import { getIMService, imStore } from '@/service/im';
import type { ChatId, ChatMessage, MessageId } from '@/service/im/types';

import { AgentRunTrace } from './agent/AgentRunTrace';
import { ThinkingIndicator } from './agent/ThinkingIndicator';

/**
 * 稳定的空数组，避免 selector 每次返回新的 []，导致无意义的重新渲染。
 */
const EMPTY_MESSAGE_IDS: MessageId[] = [];

interface ChatMessageListProps {
  chatId: ChatId;
}

interface ChatMessageItemProps {
  messageId: MessageId;
}

interface MessageProps {
  message: ChatMessage;
}

function getUserMessageStatus(message: ChatMessage): string | null {
  switch (message.status) {
    case 'pending':
      return '发送中';
    case 'delivery_unknown':
      return '发送状态未知，连接恢复后将继续确认';
    case 'failed':
      return message.error?.message || '发送失败';
    default:
      return null;
  }
}

/** 用户消息：展示文本、发送状态，以及明确失败后的手动重试入口。 */
function UserMessage({ message }: MessageProps) {
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const statusText = getUserMessageStatus(message);
  const isError = message.status === 'failed';
  const canRetry = isError && message.error?.retryable === true;

  async function handleRetry() {
    if (!canRetry || isRetrying) return;

    setIsRetrying(true);
    setRetryError(null);

    try {
      await getIMService().retryMessage(message.id);
    } catch (error) {
      setRetryError(error instanceof Error ? error.message : '重新发送失败，请稍后再试');
    } finally {
      setIsRetrying(false);
    }
  }

  return (
    <article className='chat-message-row chat-message-row-user' data-status={message.status}>
      <div className='chat-user-message'>
        <p className='chat-message-text'>{message.content.content}</p>

        {statusText || retryError ? (
          <div className='chat-user-message-feedback'>
            <span
              className={isError ? 'chat-message-status is-error' : 'chat-message-status'}
              role={isError ? 'alert' : undefined}
            >
              {retryError || statusText}
            </span>

            {canRetry ? (
              <button
                className='chat-message-retry'
                type='button'
                disabled={isRetrying}
                onClick={() => {
                  void handleRetry();
                }}
              >
                {isRetrying ? (
                  <LoaderCircle className='chat-run-spinner' size={13} />
                ) : (
                  <RotateCcw size={13} />
                )}
                {isRetrying ? '正在重试' : '重新发送'}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function getAssistantStatus(message: ChatMessage): string | null {
  switch (message.status) {
    case 'pending':
    case 'streaming':
      return null;
    case 'failed':
      return message.error?.message || '回答生成失败';
    case 'cancelled':
      return '已停止生成';
    default:
      return null;
  }
}

/**
 * AI 消息。
 * 当前直接展示纯文本；未来的 Markdown 稳定块/活动块渲染器可以替换文本节点，
 * 不需要改变消息列表和 Store 的订阅结构。
 */
function AssistantMessage({ message }: MessageProps) {
  const content = message.content.content;
  const statusText = getAssistantStatus(message);
  const isStreaming = message.status === 'pending' || message.status === 'streaming';
  const isWaitingForContent = isStreaming && !content;
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
        {message.runId && !(isStreaming && content) ? (
          <AgentRunTrace runId={message.runId} hideThinkingIndicator={isWaitingForContent} />
        ) : null}

        {isWaitingForContent ? (
          <p className='chat-assistant-thinking'>
            <ThinkingIndicator />
          </p>
        ) : null}

        {content ? <p className='chat-message-text'>{content}</p> : null}

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

/** 系统消息不使用问答气泡布局，只负责展示会话级提示。 */
function SystemMessage({ message }: MessageProps) {
  return (
    <div className='chat-message-row chat-message-row-system' role='status'>
      {message.content.content}
    </div>
  );
}

/**
 * 用户消息和 Run 已出现、但 Assistant 消息尚未出现时的过渡反馈。
 */
function PendingAssistantMessage({ chatId }: { chatId: ChatId }) {
  const pendingKey = useStore(imStore, (state) => selectPendingAssistantKey(state, chatId));

  if (!pendingKey) return null;

  return (
    <article className='chat-message-row chat-message-row-assistant' aria-live='polite'>
      <div className='chat-assistant-avatar' aria-hidden='true'>
        <img src='/eterion-icon-transparent.png' alt='' />
      </div>
      <div className='chat-assistant-content'>
        {pendingKey === PENDING_ASSISTANT_WAITING_FOR_RUN ? (
          <p className='chat-assistant-thinking'>
            <ThinkingIndicator />
          </p>
        ) : (
          <AgentRunTrace runId={pendingKey} />
        )}
      </div>
    </article>
  );
}

/**
 * 单条消息的订阅边界。
 * 流式文本变化时只有当前消息重新渲染，不会让整份消息列表一起重新渲染。
 */
function ChatMessageItem({ messageId }: ChatMessageItemProps) {
  const message = useStore(imStore, (state) => state.messagesById[messageId]);

  if (!message) return null;

  switch (message.role) {
    case 'user':
      return <UserMessage message={message} />;
    case 'assistant':
      return <AssistantMessage message={message} />;
    case 'system':
      return <SystemMessage message={message} />;
    default:
      return null;
  }
}

/**
 * 当前会话的消息列表。
 * 列表只订阅消息 ID 顺序，每条消息再根据自己的 ID 订阅具体内容。
 */
export function ChatMessageList({ chatId }: ChatMessageListProps) {
  const messageIds = useStore(
    imStore,
    (state) => state.messageIdsByChatId[chatId] ?? EMPTY_MESSAGE_IDS,
  );

  if (messageIds.length === 0) {
    return (
      <div className='chat-message-empty'>
        <span>等待第一条消息</span>
        <p>新对话的首条消息会在这里自动出现。</p>
      </div>
    );
  }

  return (
    <div className='chat-message-list' role='log' aria-label='会话消息'>
      {messageIds.map((messageId) => (
        <ChatMessageItem key={messageId} messageId={messageId} />
      ))}
      <PendingAssistantMessage chatId={chatId} />
    </div>
  );
}
