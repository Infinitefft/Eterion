import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useStore } from 'zustand';

import { getApiError } from '@/api/errors';
import { createChatDetailPath, routePaths } from '@/app/routePaths';
import deleteIconUrl from '@/assets/icons/chat-delete.png';
import renameIconUrl from '@/assets/icons/chat-rename.png';
import { getIMService, imStore } from '@/service/im';
import type { ChatId } from '@/service/im/types';

interface ChatHistoryListProps {
  onNavigate: () => void;
}

interface ChatHistoryItemProps {
  chatId: ChatId;
  onNavigate: () => void;
}

/** 单个会话独立订阅标题，标题变化不会重渲染整份历史列表。 */
function ChatHistoryItem({ chatId, onNavigate }: ChatHistoryItemProps) {
  const chat = useStore(imStore, (state) =>
    Object.hasOwn(state.chatsById, chatId) ? state.chatsById[chatId] : null,
  );
  const location = useLocation();
  const navigate = useNavigate();
  const saveInFlightRef = useRef(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isRenameDialogOpen, setIsRenameDialogOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  if (!chat) return null;

  const displayTitle = chat.title || '新对话';
  const chatPath = createChatDetailPath(chat.id);

  function openRenameDialog() {
    setIsMenuOpen(false);
    setDraftTitle(displayTitle);
    setActionError(null);
    setIsRenameDialogOpen(true);
  }

  function closeRenameDialog() {
    if (saveInFlightRef.current) return;

    setIsRenameDialogOpen(false);
    setDraftTitle('');
    setActionError(null);
  }

  async function commitTitle() {
    if (saveInFlightRef.current) return;

    const normalizedTitle = draftTitle.trim();
    if (!normalizedTitle) {
      setActionError('会话标题不能为空');
      return;
    }
    if (normalizedTitle === displayTitle) {
      setIsRenameDialogOpen(false);
      return;
    }

    saveInFlightRef.current = true;
    setIsSaving(true);
    setActionError(null);
    try {
      await getIMService().renameChat({ chatId, title: normalizedTitle });
      setIsRenameDialogOpen(false);
      setDraftTitle('');
    } catch (error) {
      setActionError(getChatActionError(error, '修改标题失败，请稍后重试'));
    } finally {
      saveInFlightRef.current = false;
      setIsSaving(false);
    }
  }

  function handleRenameKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeRenameDialog();
    }
  }

  async function handleDelete() {
    setIsDeleting(true);
    setDeleteError(null);
    try {
      await getIMService().deleteChat(chatId);
      if (location.pathname === chatPath) {
        void navigate(routePaths.chat, { replace: true });
      }
    } catch (error) {
      setDeleteError(getChatActionError(error, '删除会话失败，请稍后重试'));
      setIsDeleting(false);
    }
  }

  function openDeleteDialog() {
    setIsMenuOpen(false);
    setDeleteError(null);
    setIsDeleteDialogOpen(true);
  }

  function closeDeleteDialog() {
    if (isDeleting) return;

    setIsDeleteDialogOpen(false);
    setDeleteError(null);
  }

  return (
    <div className='conversation-item' data-deleting={isDeleting || undefined}>
      <NavLink
        className={({ isActive }) => `conversation-link ${isActive ? 'is-active' : ''}`}
        to={chatPath}
        title={displayTitle}
        onClick={onNavigate}
      >
        <span>{displayTitle}</span>
      </NavLink>

      <DropdownMenu.Root open={isMenuOpen} onOpenChange={setIsMenuOpen}>
        <DropdownMenu.Trigger asChild>
          <button
            className='conversation-menu-trigger'
            type='button'
            aria-label={`打开“${displayTitle}”会话操作`}
            disabled={isDeleting}
          >
            <span className='conversation-ellipsis' aria-hidden='true'>
              <i />
              <i />
              <i />
            </span>
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className='conversation-menu-content'
            side='bottom'
            align='start'
            sideOffset={5}
            alignOffset={0}
          >
            <DropdownMenu.Item className='conversation-menu-item' onSelect={openRenameDialog}>
              <img
                className='conversation-menu-icon'
                src={renameIconUrl}
                alt=''
                aria-hidden='true'
              />
              <span>重命名</span>
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className='conversation-menu-item is-delete'
              onSelect={openDeleteDialog}
            >
              <img
                className='conversation-menu-icon'
                src={deleteIconUrl}
                alt=''
                aria-hidden='true'
              />
              <span>删除</span>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      {isRenameDialogOpen ? (
        <RenameChatDialog
          title={draftTitle}
          error={actionError}
          isSaving={isSaving}
          onTitleChange={(title) => {
            setDraftTitle(title);
            setActionError(null);
          }}
          onInputKeyDown={handleRenameKeyDown}
          onCancel={closeRenameDialog}
          onConfirm={() => {
            void commitTitle();
          }}
        />
      ) : null}

      {isDeleteDialogOpen ? (
        <DeleteChatDialog
          title={displayTitle}
          error={deleteError}
          isDeleting={isDeleting}
          onCancel={closeDeleteDialog}
          onConfirm={() => {
            void handleDelete();
          }}
        />
      ) : null}
    </div>
  );
}

interface RenameChatDialogProps {
  title: string;
  error: string | null;
  isSaving: boolean;
  onTitleChange: (title: string) => void;
  onInputKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

function RenameChatDialog({
  title,
  error,
  isSaving,
  onTitleChange,
  onInputKeyDown,
  onCancel,
  onConfirm,
}: RenameChatDialogProps) {
  return createPortal(
    <div
      className='conversation-dialog-overlay'
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onCancel();
        }
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          onCancel();
        }
      }}
    >
      <section
        className='conversation-dialog conversation-rename-dialog'
        role='dialog'
        aria-modal='true'
        aria-labelledby='conversation-rename-title'
      >
        <h2 id='conversation-rename-title'>编辑对话名称</h2>
        <label className='sr-only' htmlFor='conversation-rename-input'>
          会话名称
        </label>
        <input
          id='conversation-rename-input'
          value={title}
          maxLength={120}
          autoFocus
          readOnly={isSaving}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => onTitleChange(event.target.value)}
          onKeyDown={onInputKeyDown}
        />
        {error ? (
          <p className='conversation-dialog-error' role='alert'>
            {error}
          </p>
        ) : null}
        <div className='conversation-dialog-actions'>
          <button type='button' disabled={isSaving} onClick={onCancel}>
            取消
          </button>
          <button
            className='conversation-rename-confirm'
            type='button'
            disabled={isSaving}
            onClick={onConfirm}
          >
            {isSaving ? '正在保存' : '确定'}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}

interface DeleteChatDialogProps {
  title: string;
  error: string | null;
  isDeleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

function DeleteChatDialog({
  title,
  error,
  isDeleting,
  onCancel,
  onConfirm,
}: DeleteChatDialogProps) {
  return createPortal(
    <div
      className='conversation-dialog-overlay'
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onCancel();
        }
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          onCancel();
        }
      }}
    >
      <section
        className='conversation-dialog conversation-delete-dialog'
        role='alertdialog'
        aria-modal='true'
        aria-labelledby='conversation-delete-title'
        aria-describedby='conversation-delete-description'
      >
        <h2 id='conversation-delete-title'>删除这个会话？</h2>
        <p id='conversation-delete-description'>“{title}”中的消息将一并删除，此操作无法恢复。</p>
        {error ? (
          <p className='conversation-dialog-error' role='alert'>
            {error}
          </p>
        ) : null}
        <div className='conversation-dialog-actions'>
          <button type='button' autoFocus disabled={isDeleting} onClick={onCancel}>
            取消
          </button>
          <button
            className='conversation-delete-confirm'
            type='button'
            disabled={isDeleting}
            onClick={onConfirm}
          >
            {isDeleting ? '正在删除' : '确定删除'}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}

function getChatActionError(error: unknown, fallback: string) {
  return getApiError(error)?.message ?? (error instanceof Error ? error.message : fallback);
}

/**
 * 侧边栏会话列表。
 * prepareNewChat() 写入全局 IM Store 后，这里会立即出现对应会话。
 */
export function ChatHistoryList({ onNavigate }: ChatHistoryListProps) {
  const chatIds = useStore(imStore, (state) => state.chatIds);
  const recentChatIds = useMemo(() => [...chatIds].reverse(), [chatIds]);

  return (
    <section className='recent-section' aria-labelledby='recent-chat-heading'>
      <div className='section-heading-row'>
        <h2 id='recent-chat-heading'>最近会话</h2>
      </div>

      {recentChatIds.length > 0 ? (
        <nav className='conversation-nav' aria-label='最近会话'>
          {recentChatIds.map((chatId) => (
            <ChatHistoryItem key={chatId} chatId={chatId} onNavigate={onNavigate} />
          ))}
        </nav>
      ) : (
        <p className='conversation-empty'>发送第一条消息后，会话会显示在这里。</p>
      )}
    </section>
  );
}
