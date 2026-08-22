import { lazy, Suspense, useRef, useState } from 'react';

import {
  NewChatComposer,
  type NewChatComposerHandle,
} from '@/features/chat/components/NewChatComposer';

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

const promptStarters = [
  {
    title: '搜索网页',
    prompt: '请你搜索网页，查找并整理以下内容：\n\n',
  },
  {
    title: '撰写文章',
    prompt: '请你写一篇文章，内容如下：\n\n',
  },
  {
    title: '制作文档',
    prompt: '请你制作一份文档，内容如下：\n\n',
  },
  {
    title: '生成图片',
    prompt: '请你生成一张图片，画面描述如下：\n\n',
  },
] as const;

/** `/chat` 只负责呈现新会话入口，创建逻辑由 NewChatComposer 承担。 */
export function Chat() {
  return (
    <section className='chat-page chat-page-new'>
      <NewConversation />
    </section>
  );
}

function NewConversation() {
  const composerRef = useRef<NewChatComposerHandle>(null);
  const [welcomeMessage] = useState(
    () => welcomeMessages[Math.floor(Math.random() * welcomeMessages.length)],
  );

  return (
    <div className='new-conversation'>
      <div className='new-conversation-content'>
        <div className='chat-interaction-shell'>
          <Suspense fallback={<div className='wake-field-loading' aria-hidden='true' />}>
            <WakeField />
          </Suspense>

          <h1 className='chat-welcome'>{welcomeMessage}</h1>
          <NewChatComposer ref={composerRef} />
        </div>

        <div className='prompt-starters' role='group' aria-label='快捷提示词'>
          {promptStarters.map((starter) => (
            <button
              key={starter.title}
              className='prompt-starter'
              type='button'
              onClick={() => composerRef.current?.applyPromptStarter(starter.prompt)}
            >
              {starter.title}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
