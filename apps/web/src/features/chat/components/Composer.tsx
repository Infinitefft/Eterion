import { ArrowUp, LoaderCircle, Paperclip, Square } from 'lucide-react';
import { useRef, useState, type ChangeEvent, type FormEvent } from 'react';

import { getIMService } from '@/service/im';
import type { ModelId, RunId, ThreadId } from '@/service/im/types';
import { useAuthStore } from '@/store/authStore';
import { useIMStore } from '@/store/imStore';

import { resizeComposerTextarea, submitComposerOnEnter } from '../utils/composerInput';
import ModelList from './ModelList/ModelList';

interface ComposerProps {
  threadId: ThreadId;
}

const TEXTAREA_MIN_HEIGHT = 44;
const TEXTAREA_MAX_HEIGHT = 160;

/**
 * 已有会话的消息输入组件。
 * 发送行为直接进入 IMService；页面不接触 WebSocket，也不自行创建协议 Command。
 */
// 输入、发送和取消三种 UI 状态集中在一个小组件中更容易理解。
// eslint-disable-next-line complexity
export function Composer({ threadId }: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [prompt, setPrompt] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState<ModelId | null>(null);
  const [cancelRequestedRunId, setCancelRequestedRunId] = useState<RunId | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const user = useAuthStore((state) => state.user);
  const snapshotStatus = useIMStore(
    (state) => state.detailsByThread[threadId]?.snapshotStatus ?? 'idle',
  );
  const activeRunId = useIMStore((state) => {
    const runs = state.detailsByThread[threadId]?.runs ?? [];

    for (let index = runs.length - 1; index >= 0; index -= 1) {
      const run = runs[index];

      if (run.status === 'pending' || run.status === 'running' || run.status === 'waiting_user') {
        return run.id;
      }
    }

    return null;
  });
  const isThreadReady = snapshotStatus === 'ready';
  const isThreadBusy = activeRunId !== null;

  const normalizedPrompt = prompt.trim();
  const isCancelling = activeRunId !== null && cancelRequestedRunId === activeRunId;
  const canSubmit =
    user !== null && isThreadReady && normalizedPrompt.length > 0 && !isThreadBusy && !isSubmitting;

  function handlePromptChange(event: ChangeEvent<HTMLTextAreaElement>) {
    setPrompt(event.target.value);
    setSubmitError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!canSubmit) return;

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      /** ACK 只确认服务端接收；消息和 Run 最终仍由 Envelope 写入 Store。 */
      const dispatch = getIMService().sendMessage({
        threadId,
        content: normalizedPrompt,
        modelId: selectedModelId ?? undefined,
      });

      setPrompt('');
      if (textareaRef.current) {
        textareaRef.current.style.height = `${TEXTAREA_MIN_HEIGHT}px`;
        textareaRef.current.style.overflowY = 'hidden';
      }

      const ack = await dispatch.ack;

      if (!ack.ok) {
        throw new Error(ack.error.message);
      }
    } catch (error) {
      /** 服务端没有接收时恢复原文；用户已经输入新内容则不覆盖。 */
      setPrompt((current) => (current.length === 0 ? normalizedPrompt : current));
      window.requestAnimationFrame(() => {
        if (textareaRef.current) {
          resizeComposerTextarea(textareaRef.current, {
            minHeight: TEXTAREA_MIN_HEIGHT,
            maxHeight: TEXTAREA_MAX_HEIGHT,
          });
        }
      });
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
      const dispatch = getIMService().cancelRun({ threadId, runId: activeRunId });
      const ack = await dispatch.ack;

      if (!ack.ok) {
        throw new Error(ack.error.message);
      }
    } catch (error) {
      setCancelRequestedRunId(null);
      setSubmitError(error instanceof Error ? error.message : '停止生成失败，请稍后重试');
    }
  }

  const placeholder = user
    ? isThreadReady
      ? '继续输入消息'
      : '会话同步完成后即可发送'
    : '登录后继续对话';

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
        rows={1}
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
          <ModelList
            value={selectedModelId}
            onChange={setSelectedModelId}
            disabled={!isThreadReady || isThreadBusy || isSubmitting}
            side='top'
          />

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
              aria-label={
                !isThreadReady ? '等待会话同步完成' : isThreadBusy ? '等待当前回答完成' : '发送消息'
              }
              disabled={!canSubmit}
            >
              {isSubmitting || isThreadBusy ? (
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
