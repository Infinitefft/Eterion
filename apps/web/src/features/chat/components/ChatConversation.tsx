import { ArrowDown } from 'lucide-react';
import { useEffect, useRef, useState, type UIEvent } from 'react';

import type { ThreadId } from '@/service/im/types';
import { useIMStore, type IMStore } from '@/store/imStore';

import { ChatMessageList } from './ChatMessageList';

interface ChatConversationProps {
  threadId: ThreadId;
}

const BOTTOM_THRESHOLD_PX = 96;

/** 只判断当前 Thread 中会影响对话高度的数据是否发生变化。 */
function didThreadVisualStateChange(
  current: IMStore,
  previous: IMStore,
  threadId: ThreadId,
): boolean {
  const currentDetail = current.detailsByThread[threadId];
  const previousDetail = previous.detailsByThread[threadId];

  return (
    currentDetail?.messages !== previousDetail?.messages ||
    currentDetail?.runs !== previousDetail?.runs ||
    currentDetail?.blocks !== previousDetail?.blocks
  );
}

/**
 * 对话滚动视口。
 * 用户停留在底部时自动跟随流式内容；主动向上阅读历史后不强制抢回滚动位置。
 */
export function ChatConversation({ threadId }: ChatConversationProps) {
  const viewportRef = useRef<HTMLElement>(null);
  const followsBottomRef = useRef(true);
  const frameRef = useRef<number | null>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);

  function scrollToBottom(behavior: ScrollBehavior) {
    const viewport = viewportRef.current;
    if (!viewport) return;

    followsBottomRef.current = true;
    setShowScrollButton(false);
    viewport.scrollTo({ top: viewport.scrollHeight, behavior });
  }

  useEffect(() => {
    followsBottomRef.current = true;

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

    scheduleFollow();

    /**
     * 这里使用 Store 的原生 subscribe，而不是让组件读取全部详情后重新渲染。
     * Conversation 自己只关心“内容高度变了”，真正的数据渲染交给 MessageList。
     */
    const unsubscribe = useIMStore.subscribe((current, previous) => {
      if (didThreadVisualStateChange(current, previous, threadId)) {
        scheduleFollow();
      }
    });

    return () => {
      unsubscribe();

      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [threadId]);

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
        <ChatMessageList threadId={threadId} />
      </section>

      {showScrollButton ? (
        <button
          className='chat-scroll-bottom'
          type='button'
          aria-label='回到底部'
          onClick={handleScrollButtonClick}
        >
          <ArrowDown size={22} strokeWidth={2.4} aria-hidden='true' />
        </button>
      ) : null}
    </div>
  );
}
