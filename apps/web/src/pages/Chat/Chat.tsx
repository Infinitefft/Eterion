import {
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  Paperclip,
} from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

import './Chat.less';

const conversationTitles: Record<string, string> = {
  'agent-runtime': 'Agent 运行时架构',
  'ui-layout': '工作台界面布局',
  'rag-design': '知识库检索设计',
  'realtime-events': '实时事件协议梳理',
};

const chatTypewriterPhrases = [
  '今天想从哪里开始？',
  '把一个想法变成清晰的下一步',
  '一起梳理代码与技术方案',
  '从资料中找到真正重要的线索',
  '复杂的任务，也可以从一句话开始',
] as const;

const composerTextareaMinHeight = 58;
const composerTextareaMaxHeight = 154;

type ChatTypewriterState = {
  phraseIndex: number;
  visibleLength: number;
  phase: 'typing' | 'deleting';
};

function resizeComposerTextarea(event: FormEvent<HTMLTextAreaElement>) {
  const textarea = event.currentTarget;
  textarea.style.height = 'auto';

  const nextHeight = Math.min(
    Math.max(textarea.scrollHeight, composerTextareaMinHeight),
    composerTextareaMaxHeight,
  );

  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY =
    textarea.scrollHeight > composerTextareaMaxHeight ? 'auto' : 'hidden';
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
  return (
    <div className='new-conversation'>
      <h1 className='sr-only'>开始新会话</h1>
      <ChatTypewriter />
      <Composer />
    </div>
  );
}

function ChatTypewriter() {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [typewriter, setTypewriter] = useState<ChatTypewriterState>({
    phraseIndex: 0,
    visibleLength: 0,
    phase: 'typing',
  });
  const phraseCharacters = Array.from(chatTypewriterPhrases[typewriter.phraseIndex]);
  const hasFinishedTyping = typewriter.visibleLength >= phraseCharacters.length;
  const hasFinishedDeleting = typewriter.visibleLength === 0;
  const visibleText = prefersReducedMotion
    ? chatTypewriterPhrases[0]
    : phraseCharacters.slice(0, typewriter.visibleLength).join('');

  useEffect(() => {
    if (prefersReducedMotion) {
      return undefined;
    }

    const delay =
      typewriter.phase === 'typing'
        ? hasFinishedTyping
          ? 1650
          : 92
        : hasFinishedDeleting
          ? 420
          : 52;

    const timer = window.setTimeout(() => {
      setTypewriter((current) => {
        if (current.phase === 'typing') {
          if (current.visibleLength >= phraseCharacters.length) {
            return { ...current, phase: 'deleting' };
          }

          return { ...current, visibleLength: current.visibleLength + 1 };
        }

        if (current.visibleLength > 0) {
          return { ...current, visibleLength: current.visibleLength - 1 };
        }

        return {
          phraseIndex: (current.phraseIndex + 1) % chatTypewriterPhrases.length,
          visibleLength: 0,
          phase: 'typing',
        };
      });
    }, delay);

    return () => window.clearTimeout(timer);
  }, [
    hasFinishedDeleting,
    hasFinishedTyping,
    phraseCharacters.length,
    prefersReducedMotion,
    typewriter.phase,
    typewriter.visibleLength,
  ]);

  return (
    <div className='chat-typewriter' aria-hidden='true'>
      <span className='chat-typewriter-text'>{visibleText}</span>
      <span className='chat-typewriter-cursor' />
    </div>
  );
}

function usePrefersReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(() =>
    window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updatePreference = () => setPrefersReducedMotion(mediaQuery.matches);

    mediaQuery.addEventListener('change', updatePreference);
    return () => mediaQuery.removeEventListener('change', updatePreference);
  }, []);

  return prefersReducedMotion;
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
