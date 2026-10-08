import { Fragment, memo } from 'react';
import Markdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';

import { getAssistantPlaceholders } from '@/features/chat/model/chatSelectors';
import type { AgentBlockState, MessageState, RunId, RunState, ThreadId } from '@/service/im/types';
import { useIMStore } from '@/store/im-store';

import { AgentRunTrace } from './agent/AgentRunTrace';
import type { KnowledgeSource } from './agent/KnowledgeSources';
import { ThinkingIndicator } from './agent/ThinkingIndicator';

// A/B 测试时通过此开关控制代码高亮。
const CODE_HIGHLIGHT_ENABLED = true;
const EMPTY_MESSAGES: MessageState[] = [];
const EMPTY_RUNS: RunState[] = [];
const EMPTY_BLOCKS: AgentBlockState[] = [];

interface ChatMessageListProps {
  threadId: ThreadId;
  onOpenSource: (source: KnowledgeSource) => void;
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
const UserMessage = memo(function UserMessage({ message }: MessageProps) {
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
});

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
const AssistantMessage = memo(function AssistantMessage({ message, onOpenSource }: MessageProps & {
  onOpenSource: (source: KnowledgeSource) => void;
}) {
  const statusText = getAssistantStatus(message);
  const isStreaming = message.status === 'streaming';
  const hasProcess = useIMStore((state) => Boolean(
    message.runId && state.detailsByThread[message.threadId]?.blocks.some(
      (block) => block.runId === message.runId,
    ),
  ));
  const isWaitingForContent = isStreaming && !message.content && !hasProcess;
  const isError = message.status === 'failed';

  return (
    <article
      className='chat-message-row chat-message-row-assistant'
      data-status={message.status}
      aria-busy={isStreaming}
    >
      <div className='chat-assistant-content'>
        {message.contextTruncated ? (
          <p className='chat-message-status' role='status'>
            为继续处理任务，已舍弃部分较早上下文；原始聊天记录仍保留。
          </p>
        ) : null}
        {message.runId ? (
          <AgentRunTrace
            threadId={message.threadId}
            runId={message.runId}
            hideThinkingIndicator={isStreaming}
            content={message.content}
            onOpenSource={onOpenSource}
          />
        ) : null}

        {isWaitingForContent ? (
          <p className='chat-assistant-thinking'>
            <ThinkingIndicator />
          </p>
        ) : null}

        {!message.runId && message.content ? (
          <div className='chat-message-text'><Markdown remarkPlugins={[remarkGfm]} rehypePlugins={CODE_HIGHLIGHT_ENABLED ? [rehypeHighlight] : []}>{message.content}</Markdown></div>
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
});

/** 正式 AI 消息出现前的过程区域，也保留没有正文的历史运行结果。 */
const PendingAssistantMessage = memo(function PendingAssistantMessage({ threadId, runId, onOpenSource }: {
  threadId: ThreadId;
  runId: RunId | null;
  onOpenSource: (source: KnowledgeSource) => void;
}) {
  return (
    <article className='chat-message-row chat-message-row-assistant' aria-live='polite'>
      <div className='chat-assistant-content'>
        {runId === null ? (
          <p className='chat-assistant-thinking'>
            <ThinkingIndicator />
          </p>
        ) : (
          <AgentRunTrace threadId={threadId} runId={runId} onOpenSource={onOpenSource} />
        )}
      </div>
    </article>
  );
});

/** 当前 Thread 的消息列表；Thinking、Tool 和 HITL 由各消息关联的 Run 展示。 */
export function ChatMessageList({ threadId, onOpenSource }: ChatMessageListProps) {
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
              <PendingAssistantMessage threadId={threadId} runId={runId} onOpenSource={onOpenSource} />
            ) : null}
          </Fragment>
        ) : (
          <AssistantMessage key={message.id} message={message} onOpenSource={onOpenSource} />
        );
      })}
    </div>
  );
}
