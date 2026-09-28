import { useMutation } from '@tanstack/react-query';
import { EllipsisVertical, Trash2 } from 'lucide-react';
import { AlertDialog, DropdownMenu } from 'radix-ui';
import { useRef, useState } from 'react';

import { getApiError } from '@/api/errors';
import { deleteKnowledgeBase } from '@/api/knowledge';

import './FileActions.less';
import './LibraryActions.less';

export function LibraryActions({
  baseId,
  baseName,
  onDeleted,
}: {
  baseId: string;
  baseName: string;
  onDeleted: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const mutation = useMutation({
    mutationFn: () => deleteKnowledgeBase(baseId),
    retry: false,
    onSuccess: () => {
      setOpen(false);
      onDeleted(baseId);
    },
  });
  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            ref={triggerRef}
            className='knowledge-library-more'
            type='button'
            aria-label={`操作 ${baseName}`}
          >
            <EllipsisVertical size={17} aria-hidden='true' />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className='knowledge-library-menu'
            align='end'
            sideOffset={4}
            onCloseAutoFocus={(event) => {
              if (open) event.preventDefault();
            }}
          >
            <DropdownMenu.Item
              onSelect={() => {
                mutation.reset();
                setOpen(true);
              }}
            >
              <Trash2 size={14} aria-hidden='true' />
              删除
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <AlertDialog.Root
        open={open}
        onOpenChange={(nextOpen) => {
          if (!mutation.isPending) setOpen(nextOpen);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className='knowledge-delete-overlay' />
          <AlertDialog.Content
            className='knowledge-delete-dialog'
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              triggerRef.current?.focus();
            }}
            onEscapeKeyDown={(event) => {
              if (mutation.isPending) event.preventDefault();
            }}
          >
            <AlertDialog.Title>确认删除知识库？</AlertDialog.Title>
            <AlertDialog.Description>
              将删除知识库「{baseName}」及其中全部文件，此操作无法撤销。
            </AlertDialog.Description>
            {mutation.isError && (
              <p className='knowledge-delete-error' role='alert'>
                {getApiError(mutation.error)?.message ?? '删除失败，请稍后重试。'}{' '}
                部分文件可能已删除，请刷新后重试。
              </p>
            )}
            <footer>
              <AlertDialog.Cancel asChild>
                <button type='button' disabled={mutation.isPending}>
                  取消
                </button>
              </AlertDialog.Cancel>
              <button
                className='knowledge-delete-confirm'
                type='button'
                disabled={mutation.isPending}
                onClick={() => {
                  if (!mutation.isPending) mutation.mutate();
                }}
              >
                {mutation.isPending ? '正在删除…' : '确认删除'}
              </button>
            </footer>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </>
  );
}
