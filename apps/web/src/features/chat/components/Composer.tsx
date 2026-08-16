import { ArrowUp, ChevronDown, LoaderCircle, Paperclip, Square } from 'lucide-react';
import { useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useStore } from 'zustand';

import { getIMService, imStore } from '@/service/im';
import type { ChatId, RunId } from '@/service/im/types';
import { useAuthStore } from '@/store/authStore';

import { selectActiveRunId, selectIsChatBusy } from '../model/chatSelectors';
import { resizeComposerTextarea, submitComposerOnEnter } from '../utils/composerInput';

interface ComposerProps {
  chatId: ChatId;
}

const TEXTAREA_MIN_HEIGHT = 52;
const TEXTAREA_MAX_HEIGHT = 160;

/**
 * 已有会话的消息输入组件。
 * 发送行为直接进入 IMService；页面不接触 WebSocket，也不自行创建协议 Command。
 */
export function Composer({ chatId }: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [prompt, setPrompt] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [cancelRequestedRunId, setCancelRequestedRunId] = useState<RunId | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const user = useAuthStore((state) => state.user);
  const activeRunId = useStore(imStore, (state) => selectActiveRunId(state, chatId));
  const isChatBusy = useStore(imStore, (state) => selectIsChatBusy(state, chatId));

  const normalizedPrompt = prompt.trim();
  const isCancelling = activeRunId !== null && cancelRequestedRunId === activeRunId;
  const canSubmit = user !== null && normalizedPrompt.length > 0 && !isChatBusy && !isSubmitting;

  function handlePromptChange(event: ChangeEvent<HTMLTextAreaElement>) {
    setPrompt(event.target.value);
    setSubmitError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!canSubmit) return;

    const content = normalizedPrompt;
    setIsSubmitting(true);
    setSubmitError(null);

    /** submitMessage 会在第一次 await 前乐观写入用户消息，因此页面立即可见。 */
    const submission = getIMService().submitMessage({ chatId, content });

    setPrompt('');
    if (textareaRef.current) {
      textareaRef.current.style.height = `${TEXTAREA_MIN_HEIGHT}px`;
      textareaRef.current.style.overflowY = 'hidden';
    }

    try {
      await submission;
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : '消息发送失败，请稍后重试');
    } finally {
      setIsSubmitting(false);
      textareaRef.current?.focus();
    }
  }

  async function handleCancelRun() {
    if (!activeRunId || isCancelling) return;

    setCancelRequestedRunId(activeRunId);
    setSubmitError(null);

    try {
      await getIMService().cancelRun({ chatId, runId: activeRunId });
    } catch (error) {
      setCancelRequestedRunId(null);
      setSubmitError(error instanceof Error ? error.message : '停止生成失败，请稍后重试');
    }
  }

  const placeholder = user ? '继续输入消息' : '登录后继续对话';

  return (
    <form
      className='chat-detail-composer'
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
    >
      <label className='sr-only' htmlFor='chat-detail-prompt'>
        输入消息
      </label>

      <textarea
        ref={textareaRef}
        id='chat-detail-prompt'
        name='prompt'
        rows={2}
        value={prompt}
        placeholder={placeholder}
        disabled={user === null}
        aria-describedby={submitError ? 'chat-detail-submit-error' : undefined}
        onChange={handlePromptChange}
        onKeyDown={(event) => submitComposerOnEnter(event, canSubmit)}
        onInput={(event) =>
          resizeComposerTextarea(event.currentTarget, {
            minHeight: TEXTAREA_MIN_HEIGHT,
            maxHeight: TEXTAREA_MAX_HEIGHT,
          })
        }
      />

      <div className='chat-detail-composer-toolbar'>
        <button
          className='chat-detail-tool-button'
          type='button'
          disabled
          title='附件功能稍后接入'
          aria-label='添加附件（暂不可用）'
        >
          <Paperclip size={18} />
        </button>

        <div className='chat-detail-composer-actions'>
          <button
            className='chat-detail-model-button'
            type='button'
            disabled
            title='模型选择稍后接入'
          >
            Eterion Agent
            <ChevronDown size={14} />
          </button>

          {activeRunId ? (
            <button
              className='chat-detail-send-button is-stop'
              type='button'
              aria-label='停止生成'
              disabled={isCancelling}
              onClick={() => {
                void handleCancelRun();
              }}
            >
              {isCancelling ? (
                <LoaderCircle className='chat-run-spinner' size={17} />
              ) : (
                <Square size={13} fill='currentColor' />
              )}
            </button>
          ) : (
            <button
              className='chat-detail-send-button'
              type='submit'
              aria-label={isChatBusy ? '等待当前回答完成' : '发送消息'}
              disabled={!canSubmit}
            >
              {isSubmitting || isChatBusy ? (
                <LoaderCircle className='chat-run-spinner' size={17} />
              ) : (
                <ArrowUp size={19} strokeWidth={2.3} />
              )}
            </button>
          )}
        </div>
      </div>

      {submitError ? (
        <p id='chat-detail-submit-error' className='chat-detail-submit-error' role='alert'>
          {submitError}
        </p>
      ) : null}
    </form>
  );
}
