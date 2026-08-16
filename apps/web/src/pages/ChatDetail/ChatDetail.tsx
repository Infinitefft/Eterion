import { useEffect, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';

import { routePaths } from '@/app/routePaths';
import { ChatConversation } from '@/features/chat/components/ChatConversation';
import { Composer } from '@/features/chat/components/Composer';
import { getIMService } from '@/service/im';

import './ChatDetail.less';

/**
 * 单个会话的承载页面。
 *
 * 新会话和历史会话共用这个页面：
 * - 新会话：Store 中存在 initialPromptIntent，进入页面后自动发送一次。
 * - 历史会话：不存在 initialPromptIntent，因此从后端加载权威快照。
 */
export function ChatDetail() {
  const { chatId } = useParams<{ chatId: string }>();
  const [openFailure, setOpenFailure] = useState<{
    chatId: string;
    message: string;
  } | null>(null);

  useEffect(() => {
    if (!chatId) return;

    let active = true;

    /** IMService 会区分本地新会话和需要从数据库恢复的历史会话。 */
    void getIMService()
      .openChat(chatId)
      .catch((error: unknown) => {
        if (!active) return;

        setOpenFailure({
          chatId,
          message: error instanceof Error ? error.message : '无法加载会话历史',
        });
      });

    return () => {
      active = false;
    };
  }, [chatId]);

  if (!chatId) {
    return <Navigate to={routePaths.chat} replace />;
  }

  const openError = openFailure?.chatId === chatId ? openFailure.message : null;

  return (
    <section className='chat-detail-page'>
      {openError ? (
        <p className='chat-detail-alert' role='alert'>
          {openError}
        </p>
      ) : null}

      <ChatConversation chatId={chatId} />
      <Composer chatId={chatId} />
    </section>
  );
}

export default ChatDetail;
