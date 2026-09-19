import { useEffect } from 'react';
import { Navigate, useParams } from 'react-router-dom';

import { routePaths } from '@/app/routePaths';
import { ChatConversation } from '@/features/chat/components/ChatConversation';
import { Composer } from '@/features/chat/components/Composer';
import { synchronizeThread } from '@/service/im';
import type { ThreadId } from '@/service/im/types';
import { useAuthStore } from '@/store/auth-store';
import { useIMStore } from '@/store/im-store';

import './ChatDetail.less';

/**
 * 单个会话的承载页面。
 *
 * 页面只负责管理当前 Thread 的 React 生命周期：
 * - 进入页面时把路由参数登记为 activeThreadId；
 * - 当前 Thread 还没有详情时加载 Snapshot；
 * - 离开页面时清理 activeThreadId。
 *
 * 快照请求与事件衔接由 IM 应用入口协调，页面只决定何时加载和标记已读。
 */
export function ChatDetail() {
  const { threadId } = useParams<{ threadId: ThreadId }>();
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const sessionVersion = useAuthStore((state) => state.sessionVersion);
  const isThreadListInitialized = useIMStore((state) =>
    state.threadListLoadState.status === 'ready' || state.threadListLoadState.status === 'error',
  );

  /** 不订阅消息正文，流式 delta 不会让整个详情页重新渲染。 */
  const snapshotStatus = useIMStore((state) =>
    threadId ? (state.detailLoadStateByThread[threadId]?.status ?? 'idle') : 'idle',
  );
  const snapshotError = useIMStore((state) => {
    const loadState = threadId ? state.detailLoadStateByThread[threadId] : undefined;
    return loadState?.status === 'error' ? loadState.message : null;
  });

  useEffect(() => {
    if (!threadId || !userId || !isThreadListInitialized) {
      return;
    }

    const store = useIMStore.getState();

    // 首轮列表结束后再加载，避免列表的迟到响应覆盖快照写入的会话信息。
    store.setActiveThread(threadId);

    if (store.detailLoadStateByThread[threadId]?.status !== 'ready') {
      void synchronizeThread(threadId);
    }

    return () => {
      /** 只清理自己，避免快速切换路由时旧页面覆盖新页面的 activeThreadId。 */
      if (
        useAuthStore.getState().sessionVersion === sessionVersion &&
        useIMStore.getState().activeThreadId === threadId
      ) {
        useIMStore.getState().setActiveThread(null);
      }
    };
  }, [threadId, userId, sessionVersion, isThreadListInitialized]);

  useEffect(() => {
    const store = useIMStore.getState();
    // 内容已提交渲染后才清未读；同时核对最新状态，避免旧 effect 清除新身份的标记。
    if (
      threadId && userId && isThreadListInitialized && snapshotStatus === 'ready' &&
      useAuthStore.getState().sessionVersion === sessionVersion &&
      store.activeThreadId === threadId &&
      store.detailLoadStateByThread[threadId]?.status === 'ready'
    ) {
      store.markThreadRead(threadId);
    }
  }, [threadId, userId, sessionVersion, isThreadListInitialized, snapshotStatus]);

  if (!threadId) {
    return <Navigate to={routePaths.chat} replace />;
  }

  return (
    <section className='chat-detail-page'>
      {snapshotStatus === 'loading' ? (
        <p className='chat-detail-alert' role='status'>
          正在加载会话…
        </p>
      ) : null}

      {snapshotError ? (
        <div className='chat-detail-alert' role='alert'>
          <span>{snapshotError}</span>
          <button
            type='button'
            onClick={() => {
              void synchronizeThread(threadId);
            }}
          >
            重试
          </button>
        </div>
      ) : null}

      <ChatConversation threadId={threadId} />
      <Composer threadId={threadId} />
    </section>
  );
}

export default ChatDetail;
