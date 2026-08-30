import { useEffect } from 'react';
import { Navigate, useParams } from 'react-router-dom';

import { routePaths } from '@/app/routePaths';
import { ChatConversation } from '@/features/chat/components/ChatConversation';
import { Composer } from '@/features/chat/components/Composer';
import type { ThreadId } from '@/service/im/types';
import { useIMStore } from '@/store/imStore';

import './ChatDetail.less';

/** Snapshot 成功且用户仍停留在这个 Thread 时，才把会话标记为已读。 */
async function synchronizeVisibleThread(threadId: ThreadId): Promise<void> {
  await useIMStore.getState().synchronizeThread(threadId);

  const store = useIMStore.getState();
  if (store.activeThreadId === threadId) {
    store.markThreadRead(threadId);
  }
}

/**
 * 单个会话的承载页面。
 *
 * 页面只负责管理当前 Thread 的 React 生命周期：
 * - 进入页面时把路由参数登记为 activeThreadId；
 * - 当前 Thread 还没有详情时加载 Snapshot；
 * - 离开页面时清理 activeThreadId。
 *
 * WebSocket、seqId 和 Snapshot 合并逻辑全部留在 IMService 与 Store 中。
 */
export function ChatDetail() {
  const { threadId } = useParams<{ threadId: ThreadId }>();

  /** 页面只订阅自己真正需要的两个字段，消息 delta 不会让整个页面重新渲染。 */
  const snapshotStatus = useIMStore((state) =>
    threadId ? (state.detailsByThread[threadId]?.snapshotStatus ?? 'idle') : 'idle',
  );
  const snapshotError = useIMStore((state) =>
    threadId ? (state.detailsByThread[threadId]?.snapshotError ?? null) : null,
  );

  useEffect(() => {
    if (!threadId) return;

    const store = useIMStore.getState();

    /** Store 根据 activeThreadId 判断后台完成事件是否需要显示红点。 */
    store.setActiveThread(threadId);

    const detail = store.detailsByThread[threadId];

    /** 内存里已有完整详情时可以立刻已读，否则等 Snapshot 成功后再清红点。 */
    if (detail?.snapshotStatus === 'ready') {
      store.markThreadRead(threadId);
    } else {
      void synchronizeVisibleThread(threadId).catch(() => undefined);
    }

    return () => {
      /** 只清理自己，避免快速切换路由时旧页面覆盖新页面的 activeThreadId。 */
      if (useIMStore.getState().activeThreadId === threadId) {
        useIMStore.getState().setActiveThread(null);
      }
    };
  }, [threadId]);

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
              void synchronizeVisibleThread(threadId).catch(() => undefined);
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
