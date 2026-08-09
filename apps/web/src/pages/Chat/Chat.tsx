import { ArrowUp, Bot, Check, ChevronDown, Paperclip } from 'lucide-react';
import { lazy, Suspense, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';

import './Chat.less';

const WakeField = lazy(() => import('./WakeField'));

const welcomeMessages = [
  '今天，想推进什么？',
  '从一个想法开始吧。',
  '有什么想一起完成的？',
  '有个模糊的想法也没关系。',
  '让想法在这里慢慢成形。',
  '下一步，想从哪里开始？',
  '接下来想聊点什么？',
] as const;

const conversationTitles: Record<string, string> = {
  'agent-runtime': 'Agent 运行时架构',
  'ui-layout': '工作台界面布局',
  'rag-design': '知识库检索设计',
  'realtime-events': '实时事件协议梳理',
};

const composerTextareaMinHeight = 58;
const composerTextareaMaxHeight = 154;

function resizeComposerTextarea(event: FormEvent<HTMLTextAreaElement>) {
  const textarea = event.currentTarget;
  textarea.style.height = 'auto';

  const nextHeight = Math.min(
    Math.max(textarea.scrollHeight, composerTextareaMinHeight),
    composerTextareaMaxHeight,
  );

  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = textarea.scrollHeight > composerTextareaMaxHeight ? 'auto' : 'hidden';
}

export function Chat() {
  const { conversationId } = useParams();
  const title = conversationId ? (conversationTitles[conversationId] ?? '会话详情') : '新会话';

  return (
    <section className={`chat-page ${conversationId ? 'chat-page-thread' : 'chat-page-new'}`}>
      {conversationId ? (
        <>
          <ConversationDetail title={title} />
          <Composer />
        </>
      ) : (
        <NewConversation />
      )}
    </section>
  );
}

function NewConversation() {
  const [welcomeMessage] = useState(
    () => welcomeMessages[Math.floor(Math.random() * welcomeMessages.length)],
  );

  return (
    <div className='new-conversation'>
      <div className='chat-interaction-shell'>
        <Suspense fallback={<div className='wake-field-loading' aria-hidden='true' />}>
          <WakeField />
        </Suspense>
        <h1 className='chat-welcome'>{welcomeMessage}</h1>
        <Composer />
      </div>
    </div>
  );
}

function ConversationDetail({ title }: { title: string }) {
  return (
    <div className='conversation-thread'>
      <div className='thread-heading'>
        <p>会话详情</p>
        <h1>{title}</h1>
      </div>
      <article className='message message-user'>
        <div className='message-avatar'>你</div>
        <div>
          <p className='message-author'>你</p>
          <p>帮我整理这一部分的设计目标，并给出下一步可以直接执行的方案。</p>
        </div>
      </article>
      <article className='message message-agent'>
        <div className='message-avatar'>
          <Bot size={17} />
        </div>
        <div>
          <p className='message-author'>Eterion</p>
          <p>
            已经梳理完成。当前重点是先稳定页面结构，再逐步接入数据与 Agent
            状态，让每一步都有清晰反馈。
          </p>
          <ul>
            <li>
              <Check size={15} /> 完成基础布局与导航层级
            </li>
            <li>
              <Check size={15} /> 保留会话、知识库和任务状态的扩展位置
            </li>
            <li>下一步可以接入真实会话列表与消息流。</li>
          </ul>
        </div>
      </article>
    </div>
  );
}

function Composer() {
  return (
    <div className='composer-dock'>
      <form className='composer' onSubmit={(event) => event.preventDefault()}>
        <label className='sr-only' htmlFor='chat-prompt'>
          输入消息
        </label>
        <textarea
          id='chat-prompt'
          name='prompt'
          rows={2}
          placeholder='给 Eterion 发送消息'
          onInput={resizeComposerTextarea}
        />
        <div className='composer-toolbar'>
          <div className='composer-tools'>
            <button type='button' aria-label='添加附件'>
              <Paperclip size={18} />
            </button>
          </div>
          <div className='composer-actions'>
            <button className='model-button' type='button'>
              Eterion Agent
              <ChevronDown size={14} />
            </button>
            <button className='send-button' type='submit' aria-label='发送消息'>
              <ArrowUp size={19} strokeWidth={2.3} />
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
