import type { KeyboardEvent } from 'react';

interface ResizeComposerTextareaOptions {
  minHeight: number;
  maxHeight: number;
}

/** 在限定高度内根据文本内容调整输入框，超出后改为内部滚动。 */
export function resizeComposerTextarea(
  textarea: HTMLTextAreaElement,
  options: ResizeComposerTextareaOptions,
): void {
  textarea.style.height = 'auto';

  const nextHeight = Math.min(
    Math.max(textarea.scrollHeight, options.minHeight),
    options.maxHeight,
  );

  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY =
    textarea.scrollHeight > options.maxHeight ? 'auto' : 'hidden';
}

/**
 * 聊天输入框统一键盘语义：Enter 提交，Shift + Enter 换行。
 * 中文输入法还在组合文字时不能触发表单提交。
 */
export function submitComposerOnEnter(
  event: KeyboardEvent<HTMLTextAreaElement>,
  canSubmit: boolean,
): void {
  if (
    event.key !== 'Enter' ||
    event.shiftKey ||
    event.nativeEvent.isComposing
  ) {
    return;
  }

  event.preventDefault();

  if (canSubmit) {
    event.currentTarget.form?.requestSubmit();
  }
}
