import { ArrowDown } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type UIEvent } from 'react';

import type { ThreadId } from '@/service/im/types';
import { useIMStore } from '@/store/im-store';

import { ChatMessageList } from './ChatMessageList';

import type { KnowledgeSource } from './agent/KnowledgeSources';

interface ChatConversationProps {
  threadId: ThreadId;
  onOpenSource: (source: KnowledgeSource) => void;
}

const BOTTOM_THRESHOLD_PX = 96;

/**
 * 对话滚动视口。
 * 用户停留在底部时自动跟随流式内容；主动向上阅读历史后不强制抢回滚动位置。
 */
export function ChatConversation({ threadId, onOpenSource }: ChatConversationProps) {
  const viewportRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followsBottomRef = useRef(true);
  const frameRef = useRef<number | null>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const isThreadReady = useIMStore(
    (state) => state.detailLoadStateByThread[threadId]?.status === 'ready',
  );

  function scrollToBottom(behavior: ScrollBehavior) {
    const viewport = viewportRef.current;
    if (!viewport) return;

    followsBottomRef.current = true;
    setShowScrollButton(false);
    viewport.scrollTo({ top: viewport.scrollHeight, behavior });
  }

  useLayoutEffect(() => {
    // 缓存会话切换和异步快照加载都在 DOM 提交后定位，避免用旧内容高度滚动。
    scrollToBottom('instant');

    const scheduleFollow = () => {
      if (frameRef.current !== null) return;

      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;

        if (followsBottomRef.current) {
          scrollToBottom('auto');
        } else {
          setShowScrollButton(true);
        }
      });
    };

    // 观察实际布局，也覆盖工具展开、图片加载和输入框改变视口高度的情况。
    const observer = new ResizeObserver(scheduleFollow);
    if (contentRef.current) observer.observe(contentRef.current);
    if (viewportRef.current) observer.observe(viewportRef.current);

    return () => {
      observer.disconnect();

      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [threadId, isThreadReady]);

  function handleScroll(event: UIEvent<HTMLElement>) {
    const viewport = event.currentTarget;
    const distanceToBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    const isNearBottom = distanceToBottom <= BOTTOM_THRESHOLD_PX;

    followsBottomRef.current = isNearBottom;
    setShowScrollButton(!isNearBottom);
  }

  function handleScrollButtonClick() {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    scrollToBottom(reduceMotion ? 'auto' : 'smooth');
  }

  return (
    <div className='chat-conversation'>
      <section
        ref={viewportRef}
        className='chat-detail-scroll'
        aria-label='对话内容'
        onScroll={handleScroll}
      >
        <div ref={contentRef}>
          <ChatMessageList threadId={threadId} onOpenSource={onOpenSource} />
        </div>
      </section>

      {showScrollButton ? (
        <button
          className='chat-scroll-bottom'
          type='button'
          aria-label='回到底部'
          onClick={handleScrollButtonClick}
        >
          <ArrowDown size={22} strokeWidth={1.7} aria-hidden='true' />
        </button>
      ) : null}
    </div>
  );
}
