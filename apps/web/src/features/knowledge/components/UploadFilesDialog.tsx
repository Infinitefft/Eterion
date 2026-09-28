import { FileText, Plus, Upload, X } from 'lucide-react';
import { Dialog, Toast } from 'radix-ui';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { getApiError } from '@/api/errors';
import { uploadKnowledgeFile } from '@/api/knowledge';
import type { KnowledgeFile } from '@/api/knowledge';

import './UploadFilesDialog.less';

export function UploadFilesDialog({
  libraryName,
  libraryId,
  onUploaded,
}: {
  libraryName: string;
  libraryId: string;
  onUploaded: (file: KnowledgeFile) => void;
}) {
  const [open, setOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [toast, setToast] = useState('');
  const [toastOpen, setToastOpen] = useState(false);
  const requestRef = useRef<AbortController | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  useEffect(() => () => requestRef.current?.abort(), []);

  function notify(message: string) {
    setToast(message);
    setToastOpen(true);
  }

  async function handleUpload() {
    if (requestRef.current || files.length === 0) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setUploading(true);
    try {
      for (const file of files) {
        const saved = await uploadKnowledgeFile(libraryId, file, controller.signal);
        if (controller.signal.aborted) return;
        onUploaded(saved);
        setFiles((current) => current.filter((item) => item !== file));
      }
      setOpen(false);
      notify('文件上传成功');
    } catch (error) {
      if (controller.signal.aborted) return;
      const apiError = getApiError(error);
      notify(
        apiError?.fields?.file ??
          apiError?.message ??
          '上传请求失败，请刷新文件列表确认结果后再重试',
      );
    } finally {
      requestRef.current = null;
      if (!controller.signal.aborted) setUploading(false);
    }
  }

  function addFiles(incoming: File[]) {
    if (requestRef.current) return;
    if (
      incoming.some(
        (file) =>
          !/\.(txt|md)$/i.test(file.name) || file.size === 0 || file.size > 20 * 1024 * 1024,
      )
    ) {
      notify('请选择非空的 UTF-8 编码的 TXT 或 MD 文件，单个文件不超过 20 MiB');
      return;
    }
    setFiles((current) => {
      const next = [...current];
      for (const file of incoming) {
        if (
          !next.some(
            (item) =>
              item.name === file.name &&
              item.size === file.size &&
              item.lastModified === file.lastModified,
          )
        ) {
          next.push(file);
        }
      }
      return next;
    });
  }

  return (
    <Toast.Provider duration={5000}>
      <Dialog.Root
        open={open}
        onOpenChange={(nextOpen) => {
          if (requestRef.current) return;
          setOpen(nextOpen);
          setFiles([]);
          setDragging(false);
          dragDepth.current = 0;
        }}
      >
        <Dialog.Trigger asChild>
          <button className='repository-button repository-button-primary' type='button'>
            <Upload size={15} aria-hidden='true' />
            添加文件
          </button>
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className='knowledge-upload-overlay' />
          <Dialog.Content className='knowledge-upload-dialog'>
            <header className='knowledge-upload-header'>
              <div>
                <Dialog.Title>添加文件</Dialog.Title>
                <Dialog.Description>将资料添加到「{libraryName}」</Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button
                  className='knowledge-upload-icon-button'
                  type='button'
                  aria-label='关闭上传弹窗'
                  disabled={uploading}
                >
                  <X size={19} aria-hidden='true' />
                </button>
              </Dialog.Close>
            </header>
            <input
              ref={inputRef}
              type='file'
              multiple
              accept='.txt,.md'
              disabled={uploading}
              hidden
              onChange={(event) => {
                addFiles(Array.from(event.currentTarget.files ?? []));
                const input = event.currentTarget;
                input.value = '';
              }}
            />
            <button
              className={`knowledge-upload-dropzone${dragging ? ' is-dragging' : ''}`}
              disabled={uploading}
              type='button'
              onClick={() => inputRef.current?.click()}
              onDragEnter={(event) => {
                event.preventDefault();
                dragDepth.current += 1;
                setDragging(true);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                const transfer = event.dataTransfer;
                transfer.dropEffect = 'copy';
              }}
              onDragLeave={(event) => {
                event.preventDefault();
                dragDepth.current = Math.max(0, dragDepth.current - 1);
                if (dragDepth.current === 0) setDragging(false);
              }}
              onDrop={(event) => {
                event.preventDefault();
                dragDepth.current = 0;
                setDragging(false);
                addFiles(Array.from(event.dataTransfer.files));
              }}
            >
              <span className='knowledge-upload-mark'>
                <Upload size={25} strokeWidth={1.4} aria-hidden='true' />
              </span>
              <strong>{dragging ? '松开鼠标，添加文件' : '点击选择文件，或拖拽到这里'}</strong>
              <span>支持一次选择多个文件</span>
              <span className='knowledge-upload-choose'>
                <Plus size={14} aria-hidden='true' />
                选择文件
              </span>
            </button>
            {files.length > 0 && (
              <section className='knowledge-upload-selection' aria-label='已选择的文件'>
                <div className='knowledge-upload-selection-heading'>
                  <span role='status'>已选择 {files.length} 个文件</span>
                  <button type='button' disabled={uploading} onClick={() => setFiles([])}>
                    清空
                  </button>
                </div>
                <ul>
                  {files.map((file, index) => (
                    <li key={`${file.name}-${file.size}-${file.lastModified}`}>
                      <FileText size={21} strokeWidth={1.4} aria-hidden='true' />
                      <div className='knowledge-upload-file-info'>
                        <span title={file.name}>{file.name}</span>
                        <small>
                          {file.size < 1024 * 1024
                            ? `${Math.max(1, Math.ceil(file.size / 1024))} KB`
                            : `${(file.size / 1024 / 1024).toFixed(1)} MB`}
                        </small>
                      </div>
                      <button
                        className='knowledge-upload-icon-button'
                        type='button'
                        aria-label={`移除 ${file.name}`}
                        disabled={uploading}
                        onClick={() =>
                          setFiles((current) =>
                            current.filter((_, itemIndex) => itemIndex !== index),
                          )
                        }
                      >
                        <X size={15} aria-hidden='true' />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <footer className='knowledge-upload-footer'>
              <Dialog.Close asChild>
                <button className='knowledge-upload-cancel' type='button' disabled={uploading}>
                  取消
                </button>
              </Dialog.Close>
              <button
                className='knowledge-upload-submit'
                type='button'
                disabled={uploading || files.length === 0}
                onClick={() => {
                  void handleUpload();
                }}
              >
                {uploading ? '正在上传…' : '开始上传'}
              </button>
            </footer>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Toast.Root className='knowledge-upload-toast' open={toastOpen} onOpenChange={setToastOpen}>
        <Toast.Description>{toast}</Toast.Description>
        <Toast.Close aria-label='关闭提示'>
          <X size={16} />
        </Toast.Close>
      </Toast.Root>
      {createPortal(<Toast.Viewport className='knowledge-upload-toast-viewport' />, document.body)}
    </Toast.Provider>
  );
}
