import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';

import { getApiError } from '@/api/errors';
import { createChatDetailPath, routePaths } from '@/app/routePaths';
import deleteIconUrl from '@/assets/icons/chat-delete.png';
import renameIconUrl from '@/assets/icons/chat-rename.png';
import type { ThreadId } from '@/service/im/types';
import { useIMStore } from '@/store/imStore';

interface ChatHistoryListProps {
  onNavigate: () => void;
}

interface ThreadHistoryItemProps {
  threadId: ThreadId;
  onNavigate: () => void;
}

interface ThreadLinkLabelProps {
  title: string;
  isGenerating: boolean;
  isWaitingForAnswer: boolean;
  hasUnread: boolean;
}

function getThreadLinkTitle({
  title,
  isGenerating,
  isWaitingForAnswer,
  hasUnread,
}: ThreadLinkLabelProps): string {
  if (isGenerating) {
    return `${title} · 正在生成`;
  }

  if (isWaitingForAnswer) {
    return `${title} · 待回答`;
  }

  if (hasUnread) {
    return `${title} · 有新消息`;
  }

  return title;
}

function ThreadLinkLabel({
  title,
  isGenerating,
  isWaitingForAnswer,
  hasUnread,
}: ThreadLinkLabelProps) {
  const prefix = isGenerating ? (
    <span aria-label='正在生成'>生成中 · </span>
  ) : isWaitingForAnswer ? (
    <span aria-label='待回答'>待回答 · </span>
  ) : hasUnread ? (
    <span style={{ color: '#e5484d' }} aria-label='有新消息'>
      ●{' '}
    </span>
  ) : null;

  return (
    <span>
      {prefix}
      {title}
    </span>
  );
}

/** 单个 Thread 独立订阅自己的元数据和最新 Run，流式正文不会重渲染整份侧栏。 */
function ThreadHistoryItem({ threadId, onNavigate }: ThreadHistoryItemProps) {
  const thread = useIMStore(
    (state) => state.threads.find((current) => current.id === threadId) ?? null,
  );
  const latestRunStatus = useIMStore((state) => {
    const runs = state.detailsByThread[threadId]?.runs;
    return runs?.[runs.length - 1]?.status ?? null;
  });
  const isGenerating = latestRunStatus === 'pending' || latestRunStatus === 'running';
  const isWaitingForAnswer = latestRunStatus === 'waiting_user';
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

  if (!thread) return null;

  const displayTitle = thread.title || '新对话';
  const threadPath = createChatDetailPath(thread.id);

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
      await useIMStore.getState().renameThread(threadId, normalizedTitle);
      setIsRenameDialogOpen(false);
      setDraftTitle('');
    } catch (error) {
      setActionError(getThreadActionError(error, '修改标题失败，请稍后重试'));
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
      await useIMStore.getState().removeThread(threadId);
      if (location.pathname === threadPath) {
        void navigate(routePaths.chat, { replace: true });
      }
    } catch (error) {
      setDeleteError(getThreadActionError(error, '删除会话失败，请稍后重试'));
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
    <div
      className='conversation-item'
      data-deleting={isDeleting || undefined}
      data-generating={isGenerating || undefined}
      data-waiting-user={isWaitingForAnswer || undefined}
      data-unread={thread.hasUnread || undefined}
    >
      <NavLink
        className={({ isActive }) => `conversation-link ${isActive ? 'is-active' : ''}`}
        to={threadPath}
        title={getThreadLinkTitle({
          title: displayTitle,
          isGenerating,
          isWaitingForAnswer,
          hasUnread: thread.hasUnread,
        })}
        onClick={onNavigate}
      >
        <ThreadLinkLabel
          title={displayTitle}
          isGenerating={isGenerating}
          isWaitingForAnswer={isWaitingForAnswer}
          hasUnread={thread.hasUnread}
        />
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
        <RenameThreadDialog
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
        <DeleteThreadDialog
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

interface RenameThreadDialogProps {
  title: string;
  error: string | null;
  isSaving: boolean;
  onTitleChange: (title: string) => void;
  onInputKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

function RenameThreadDialog({
  title,
  error,
  isSaving,
  onTitleChange,
  onInputKeyDown,
  onCancel,
  onConfirm,
}: RenameThreadDialogProps) {
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

interface DeleteThreadDialogProps {
  title: string;
  error: string | null;
  isDeleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

function DeleteThreadDialog({
  title,
  error,
  isDeleting,
  onCancel,
  onConfirm,
}: DeleteThreadDialogProps) {
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

function getThreadActionError(error: unknown, fallback: string) {
  return getApiError(error)?.message ?? (error instanceof Error ? error.message : fallback);
}

/** 侧边栏直接消费 Store 已按 updatedAt 排好序的 Thread 列表。 */
export function ChatHistoryList({ onNavigate }: ChatHistoryListProps) {
  const threads = useIMStore((state) => state.threads);
  const listStatus = useIMStore((state) => state.threadListStatus);
  const listError = useIMStore((state) => state.threadListError);

  return (
    <section className='recent-section' aria-labelledby='recent-chat-heading'>
      <div className='section-heading-row'>
        <h2 id='recent-chat-heading'>最近会话</h2>
      </div>

      {threads.length > 0 ? (
        <nav className='conversation-nav' aria-label='最近会话'>
          {threads.map((thread) => (
            <ThreadHistoryItem key={thread.id} threadId={thread.id} onNavigate={onNavigate} />
          ))}
        </nav>
      ) : listStatus === 'loading' ? (
        <p className='conversation-empty'>正在加载会话…</p>
      ) : listStatus === 'error' ? (
        <p className='conversation-empty' role='alert'>
          {listError || '无法加载会话列表'}
        </p>
      ) : (
        <p className='conversation-empty'>发送第一条消息后，会话会显示在这里。</p>
      )}
    </section>
  );
}
