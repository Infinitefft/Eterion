import { ArrowDown } from 'lucide-react';
import { useEffect, useRef, useState, type UIEvent } from 'react';

import { imStore } from '@/service/im';
import type { IMStore } from '@/service/im/store';
import type { ChatId } from '@/service/im/types';

import { ChatMessageList } from './ChatMessageList';

interface ChatConversationProps {
  chatId: ChatId;
}

const BOTTOM_THRESHOLD_PX = 96;

/** 只判断当前 Chat 的最新消息、Run 和 Step 是否发生了可见变化。 */
function didChatVisualStateChange(
  current: IMStore,
  previous: IMStore,
  chatId: ChatId,
): boolean {
  const currentMessageIds = current.messageIdsByChatId[chatId] ?? [];
  const previousMessageIds = previous.messageIdsByChatId[chatId] ?? [];

  if (currentMessageIds !== previousMessageIds) return true;

  const latestMessageId = currentMessageIds[currentMessageIds.length - 1];
  if (
    latestMessageId &&
    current.messagesById[latestMessageId] !== previous.messagesById[latestMessageId]
  ) {
    return true;
  }

  const currentRunIds = current.runIdsByChatId[chatId] ?? [];
  const previousRunIds = previous.runIdsByChatId[chatId] ?? [];

  if (currentRunIds !== previousRunIds) return true;

  const latestRunId = currentRunIds[currentRunIds.length - 1];
  if (!latestRunId) return false;

  const currentRun = current.runsById[latestRunId];
  const previousRun = previous.runsById[latestRunId];

  if (currentRun !== previousRun) return true;
  if (!currentRun || current.stepsById === previous.stepsById) return false;

  return currentRun.stepIds.some(
    (stepId) => current.stepsById[stepId] !== previous.stepsById[stepId],
  );
}

/**
 * 对话滚动视口。
 * 用户停留在底部时自动跟随流式内容；主动向上阅读历史后不强制抢回滚动位置。
 */
export function ChatConversation({ chatId }: ChatConversationProps) {
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
    setShowScrollButton(false);

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

    const unsubscribe = imStore.subscribe((current, previous) => {
      if (didChatVisualStateChange(current, previous, chatId)) {
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
  }, [chatId]);

  function handleScroll(event: UIEvent<HTMLElement>) {
    const viewport = event.currentTarget;
    const distanceToBottom =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    const isNearBottom = distanceToBottom <= BOTTOM_THRESHOLD_PX;

    followsBottomRef.current = isNearBottom;
    setShowScrollButton(!isNearBottom);
  }

  function handleScrollButtonClick() {
    const reduceMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    scrollToBottom(reduceMotion ? 'auto' : 'smooth');
  }

  return (
    <div className="chat-conversation">
      <section
        ref={viewportRef}
        className="chat-detail-scroll"
        aria-label="对话内容"
        onScroll={handleScroll}
      >
        <ChatMessageList chatId={chatId} />
      </section>

      {showScrollButton ? (
        <button
          className="chat-scroll-bottom"
          type="button"
          onClick={handleScrollButtonClick}
        >
          <ArrowDown size={15} aria-hidden="true" />
          回到底部
        </button>
      ) : null}
    </div>
  );
}
