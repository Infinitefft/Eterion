import { useMutation } from '@tanstack/react-query';
import { FolderPlus, Plus, X } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { useId, useRef, useState } from 'react';

import { getApiError } from '@/api/errors';
import { createKnowledgeBase } from '@/api/knowledge';
import type { KnowledgeBase } from '@/api/knowledge';
import { useAuthStore } from '@/store/auth-store';

import './CreateKnowledgeBaseDialog.less';

import type { Ref } from 'react';

export function CreateKnowledgeBaseDialog({
  onCreated,
}: {
  onCreated: (base: KnowledgeBase) => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const titleRef = useRef<HTMLInputElement>(null);
  const user = useAuthStore((state) => state.user);
  const mutation = useMutation({
    mutationFn: createKnowledgeBase,
    retry: false,
    onSuccess: (base) => {
      onCreated(base);
      setOpen(false);
      setTitle('');
      setDescription('');
    },
  });
  const apiError = getApiError(mutation.error);
  const canSubmit =
    Boolean(user) &&
    !mutation.isPending &&
    Boolean(title.trim()) &&
    Array.from(title).length <= 10 &&
    Array.from(description).length <= 25;
  const errorMessage =
    apiError?.fields?.title ??
    apiError?.fields?.description ??
    apiError?.message ??
    '创建失败，请检查网络后重试';

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (mutation.isPending) {
          return;
        }
        setOpen(nextOpen);
        mutation.reset();
        if (!nextOpen) {
          setTitle('');
          setDescription('');
        }
      }}
    >
      <Dialog.Trigger asChild>
        <button className='repository-button repository-button-primary' type='button'>
          <Plus size={16} aria-hidden='true' />
          新建知识库
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className='knowledge-create-overlay' />
        <Dialog.Content
          className='knowledge-create-dialog'
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            titleRef.current?.focus();
          }}
        >
          <header className='knowledge-create-header'>
            <span className='knowledge-create-icon' aria-hidden='true'>
              <FolderPlus size={23} strokeWidth={1.4} />
            </span>
            <Dialog.Close asChild>
              <button
                className='knowledge-create-close'
                type='button'
                aria-label='关闭新建知识库弹窗'
                disabled={mutation.isPending}
              >
                <X size={18} aria-hidden='true' />
              </button>
            </Dialog.Close>
          </header>
          <Dialog.Title className='knowledge-create-title'>新建知识库</Dialog.Title>
          <Dialog.Description className='knowledge-create-description'>
            为一组资料取个名字，之后可以随时添加文件。
          </Dialog.Description>
          <form
            className='knowledge-create-form'
            aria-busy={mutation.isPending}
            onSubmit={(event) => {
              event.preventDefault();
              if (!canSubmit) {
                return;
              }
              mutation.mutate({ title, description });
            }}
          >
            <LimitedTextField
              label='标题'
              limit={10}
              value={title}
              onValueChange={setTitle}
              inputRef={titleRef}
              placeholder='例如：前端工程'
              required
              disabled={mutation.isPending}
            />
            <LimitedTextField
              label='描述'
              limit={25}
              value={description}
              onValueChange={setDescription}
              placeholder='用一句话介绍这个知识库'
              disabled={mutation.isPending}
            />
            {!user && (
              <p className='knowledge-create-error' role='status'>
                请先通过左侧账户入口登录，再创建知识库。
              </p>
            )}
            {mutation.isError && (
              <p className='knowledge-create-error' role='alert'>
                {errorMessage}
              </p>
            )}
            <footer className='knowledge-create-actions'>
              <Dialog.Close asChild>
                <button
                  className='knowledge-create-cancel'
                  type='button'
                  disabled={mutation.isPending}
                >
                  取消
                </button>
              </Dialog.Close>
              <button className='knowledge-create-submit' type='submit' disabled={!canSubmit}>
                {mutation.isPending ? '正在创建…' : '创建知识库'}
              </button>
            </footer>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function LimitedTextField({
  label,
  limit,
  value,
  onValueChange,
  inputRef,
  placeholder,
  required = false,
  disabled = false,
}: {
  label: string;
  limit: number;
  value: string;
  onValueChange: (value: string) => void;
  inputRef?: Ref<HTMLInputElement>;
  placeholder: string;
  required?: boolean;
  disabled?: boolean;
}) {
  const hintId = useId();
  const [exceeded, setExceeded] = useState(false);
  const composing = useRef(false);
  const blockedComposition = useRef(false);
  const lastCommitted = useRef(value);

  function commitValue(nextValue: string) {
    const characters = Array.from(nextValue);
    const tooLong = characters.length > limit;
    // 输入法结束后可能再次发出相同值的 change，保留刚产生的提示。
    if (tooLong || nextValue !== lastCommitted.current) {
      setExceeded(tooLong);
    }
    lastCommitted.current = tooLong ? characters.slice(0, limit).join('') : nextValue;
    onValueChange(lastCommitted.current);
  }

  return (
    <label className='knowledge-create-field'>
      <span className='knowledge-create-label'>
        {label}
        {!required && <span>选填</span>}
      </span>
      <span className={`knowledge-create-input-wrap${exceeded ? ' has-limit-hint' : ''}`}>
        <input
          ref={inputRef}
          type='text'
          value={value}
          required={required}
          disabled={disabled}
          autoComplete='off'
          placeholder={placeholder}
          aria-describedby={exceeded ? hintId : undefined}
          onKeyDown={(event) => {
            const input = event.currentTarget;
            if (
              !composing.current &&
              !event.ctrlKey &&
              !event.metaKey &&
              !event.altKey &&
              input.selectionStart === input.selectionEnd &&
              Array.from(input.value).length >= limit &&
              // Windows 输入法开始组合时通常报告 Process / 229。
              (event.key.length === 1 || event.key === 'Process' || event.keyCode === 229)
            ) {
              event.preventDefault();
              setExceeded(true);
            }
          }}
          onBeforeInput={(event) => {
            if (composing.current || event.nativeEvent.isComposing || !event.data) {
              return;
            }
            const input = event.currentTarget;
            const start = input.selectionStart ?? input.value.length;
            const end = input.selectionEnd ?? start;
            const nextValue = input.value.slice(0, start) + event.data + input.value.slice(end);
            const currentLength = Array.from(input.value).length;
            if ((start === end && currentLength >= limit) || Array.from(nextValue).length > limit) {
              event.preventDefault();
              setExceeded(true);
            }
          }}
          onChange={(event) => {
            if (blockedComposition.current) {
              // 部分输入法的组合事件不可取消，恢复 DOM，不能只依赖相同值的 setState。
              const input = event.currentTarget;
              input.value = lastCommitted.current;
              setExceeded(true);
            } else if (composing.current) {
              onValueChange(event.target.value);
            } else {
              commitValue(event.target.value);
            }
          }}
          onCompositionStart={(event) => {
            composing.current = true;
            const input = event.currentTarget;
            blockedComposition.current =
              input.selectionStart === input.selectionEnd &&
              Array.from(lastCommitted.current).length >= limit;
            if (blockedComposition.current) {
              setExceeded(true);
            }
          }}
          onCompositionEnd={(event) => {
            composing.current = false;
            if (blockedComposition.current) {
              const input = event.currentTarget;
              input.value = lastCommitted.current;
              blockedComposition.current = false;
            } else {
              commitValue(event.currentTarget.value);
            }
          }}
          onPaste={(event) => {
            event.preventDefault();
            const input = event.currentTarget;
            const start = input.selectionStart ?? value.length;
            const end = input.selectionEnd ?? start;
            const pasted = event.clipboardData.getData('text').replace(/[\r\n]/g, '');
            commitValue(value.slice(0, start) + pasted + value.slice(end));
          }}
        />
        {exceeded && (
          <span className='knowledge-create-limit-hint' id={hintId} role='status'>
            最多 {limit} 字
          </span>
        )}
      </span>
    </label>
  );
}
