import {
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  CircleUserRound,
  Code2,
  Paperclip,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react';
import { useParams } from 'react-router-dom';

const conversationTitles: Record<string, string> = {
  'agent-runtime': 'Agent 运行时架构',
  'ui-layout': '工作台界面布局',
  'rag-design': '知识库检索设计',
  'realtime-events': '实时事件协议梳理',
};

const starterActions = [
  { icon: Sparkles, label: '规划一个新任务' },
  { icon: Code2, label: '分析或编写代码' },
  { icon: SlidersHorizontal, label: '梳理技术方案' },
];

export function Chat() {
  const { conversationId } = useParams();
  const title = conversationId
    ? (conversationTitles[conversationId] ?? '会话详情')
    : '新会话';

  return (
    <section className={`chat-page ${conversationId ? 'chat-page-thread' : 'chat-page-new'}`}>
      <header className='chat-header'>
        <button className='chat-title-button' type='button'>
          <span>{title}</span>
          <ChevronDown size={15} />
        </button>
        <div className='chat-header-actions'>
          <span className='connection-state'>
            <span aria-hidden='true' />
            Agent 就绪
          </span>
          <button className='profile-button' type='button' aria-label='打开个人设置'>
            <CircleUserRound size={21} />
          </button>
        </div>
      </header>

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
      <div className='welcome-state'>
        <div className='welcome-emblem' aria-hidden='true'>
          <Sparkles size={23} />
        </div>
        <p className='welcome-kicker'>Eterion Workspace</p>
        <h1>今天想推进什么？</h1>
        <p className='welcome-description'>
          从一个问题、一个想法，或一段需要继续完成的代码开始。
        </p>
      </div>

      <Composer />

      <div className='starter-actions'>
        {starterActions.map(({ icon: Icon, label }) => (
          <button key={label} type='button'>
            <Icon size={16} />
            <span>{label}</span>
          </button>
        ))}
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
        <textarea id='chat-prompt' name='prompt' rows={1} placeholder='给 Eterion 发送消息' />
        <div className='composer-toolbar'>
          <div className='composer-tools'>
            <button type='button' aria-label='添加附件'>
              <Paperclip size={18} />
            </button>
            <button className='model-button' type='button'>
              Eterion Agent
              <ChevronDown size={14} />
            </button>
          </div>
          <button className='send-button' type='submit' aria-label='发送消息'>
            <ArrowUp size={19} strokeWidth={2.3} />
          </button>
        </div>
      </form>
      <p className='composer-note'>Eterion 可能会犯错，请核对重要信息。</p>
    </div>
  );
}
