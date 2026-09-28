import { useMutation } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { AlertDialog } from 'radix-ui';
import { useState } from 'react';

import { getApiError } from '@/api/errors';
import { deleteKnowledgeFile } from '@/api/knowledge';

import './FileActions.less';

export function FileActions({
  baseId,
  fileId,
  fileName,
  onDeleted,
}: {
  baseId: string;
  fileId: string;
  fileName: string;
  onDeleted: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const mutation = useMutation({
    mutationFn: () => deleteKnowledgeFile(baseId, fileId),
    retry: false,
    onSuccess: () => {
      setOpen(false);
      onDeleted(fileId);
    },
  });
  return (
    <>
      <AlertDialog.Root
        open={open}
        onOpenChange={(nextOpen) => {
          if (!mutation.isPending) setOpen(nextOpen);
        }}
      >
        <AlertDialog.Trigger asChild>
          <button
            className='knowledge-file-delete'
            type='button'
            aria-label={`删除 ${fileName}`}
            title='删除文件'
            onClick={() => mutation.reset()}
          >
            <Trash2 size={16} aria-hidden='true' />
          </button>
        </AlertDialog.Trigger>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className='knowledge-delete-overlay' />
          <AlertDialog.Content
            className='knowledge-delete-dialog'
            onEscapeKeyDown={(event) => {
              if (mutation.isPending) event.preventDefault();
            }}
          >
            <AlertDialog.Title>确认删除文件？</AlertDialog.Title>
            <AlertDialog.Description>
              将删除「{fileName}」及其存储文件，此操作无法在应用中撤销。
            </AlertDialog.Description>
            {mutation.isError && (
              <p className='knowledge-delete-error' role='alert'>
                {getApiError(mutation.error)?.message ?? '删除失败，请稍后重试。'}
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
