import { ArrowUp, LoaderCircle, Paperclip, Square } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';

import { getIMService } from '@/service/im';
import type { MessageId, ModelId, ProtocolError, RunId, ThreadId } from '@/service/im/types';
import { useAuthStore } from '@/store/auth-store';
import { useIMStore } from '@/store/im-store';

import { selectActiveRunId, selectIsChatBusy } from '../model/chatSelectors';
import { resizeComposerTextarea, submitComposerOnEnter } from '../utils/composerInput';
import ModelList from './ModelList/ModelList';

interface ComposerProps {
  threadId: ThreadId;
}

interface ComposerView {
  sessionVersion: number;
  cancelRequestedRunId: RunId | null;
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
  const sessionVersion = useAuthStore((state) => state.sessionVersion);
  const [scope, setScope] = useState({ threadId, sessionVersion });
  const viewRef = useRef<ComposerView | null>(null);

  // 草稿和模型沿用，只有与旧会话请求有关的临时状态需要重置。
  if (scope.threadId !== threadId || scope.sessionVersion !== sessionVersion) {
    setScope({ threadId, sessionVersion });
    setIsSubmitting(false);
    setCancelRequestedRunId(null);
    setSubmitError(null);
  }

  useLayoutEffect(() => {
    viewRef.current = { sessionVersion: scope.sessionVersion, cancelRequestedRunId: null };
    return () => { viewRef.current = null; };
  }, [scope]);

  const snapshotStatus = useIMStore(
    (state) => state.detailLoadStateByThread[threadId]?.status ?? 'idle',
  );
  const activeRunId = useIMStore((state) => selectActiveRunId(state, threadId));
  const isThreadBusy = useIMStore((state) => selectIsChatBusy(state, threadId));
  const isConnected = useIMStore((state) => state.connection.status === 'connected');
  const isThreadReady = snapshotStatus === 'ready';

  const normalizedPrompt = prompt.trim();
  const isCancelling = activeRunId !== null && cancelRequestedRunId === activeRunId;
  const canSubmit =
    user !== null && isThreadReady && isConnected && normalizedPrompt.length > 0 &&
    !isThreadBusy && !isSubmitting;

  function isCurrentView(view: ComposerView | null): view is ComposerView {
    return view !== null && viewRef.current === view &&
      useAuthStore.getState().sessionVersion === view.sessionVersion;
  }

  function handlePromptChange(event: ChangeEvent<HTMLTextAreaElement>) {
    setPrompt(event.target.value);
    setSubmitError(null);
  }

  // 保持发送前校验、乐观更新和 ACK 处理在同一条流程，便于核对状态顺序。
  // eslint-disable-next-line complexity
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const view = viewRef.current;
    const store = useIMStore.getState();
    if (
      !canSubmit || !isCurrentView(view) ||
      store.connection.status !== 'connected' ||
      store.detailLoadStateByThread[threadId]?.status !== 'ready' ||
      selectIsChatBusy(store, threadId)
    ) return;

    setIsSubmitting(true);
    setSubmitError(null);
    let messageId: MessageId | null = null;

    function handleFailure(error: ProtocolError) {
      if (useAuthStore.getState().sessionVersion !== sessionVersion) return;

      if (messageId !== null) {
        const currentStore = useIMStore.getState();
        const message = currentStore.detailsByThread[threadId]?.messages.find(
          (item) => item.id === messageId,
        );
        // 已确认或已删除的消息，不受迟到的 ACK 错误影响。
        if (message?.status !== 'sending') return;
        currentStore.failSendingMessage(threadId, messageId, error);
      }

      if (!isCurrentView(view)) return;
      setPrompt((current) => (current.length === 0 ? normalizedPrompt : current));
      setSubmitError(error.message);
      window.requestAnimationFrame(() => {
        if (isCurrentView(view) && textareaRef.current) {
          resizeComposerTextarea(textareaRef.current, {
            minHeight: TEXTAREA_MIN_HEIGHT,
            maxHeight: TEXTAREA_MAX_HEIGHT,
          });
        }
      });
    }

    try {
      /** ACK 只确认服务端接收；消息和 Run 最终仍由 Envelope 写入 Store。 */
      const dispatch = getIMService().sendMessage({
        threadId,
        content: normalizedPrompt,
        modelId: selectedModelId ?? undefined,
      });
      messageId = dispatch.command.messageId;
      useIMStore.getState().addSendingMessage(threadId, messageId, normalizedPrompt);

      setPrompt('');
      if (textareaRef.current) {
        textareaRef.current.style.height = `${TEXTAREA_MIN_HEIGHT}px`;
        textareaRef.current.style.overflowY = 'hidden';
      }

      const ack = await dispatch.ack;

      if (!ack.ok) {
        handleFailure(ack.error);
      }
    } catch (error) {
      handleFailure({
        code: 'CLIENT_SEND_FAILED',
        message: error instanceof Error ? error.message : '消息发送失败，请稍后重试',
      });
    } finally {
      if (isCurrentView(view)) {
        setIsSubmitting(false);
        textareaRef.current?.focus();
      }
    }
  }

  async function handleCancelRun() {
    const view = viewRef.current;
    const store = useIMStore.getState();
    const runId = selectActiveRunId(store, threadId);
    if (
      !isCurrentView(view) || !runId || view.cancelRequestedRunId === runId ||
      store.connection.status !== 'connected'
    ) return;

    // 同步锁住本次 Run，避免 React 提交下一次渲染前连续点击重复取消。
    view.cancelRequestedRunId = runId;
    setCancelRequestedRunId(runId);
    setSubmitError(null);

    try {
      const dispatch = getIMService().cancelRun({ threadId, runId });
      const ack = await dispatch.ack;

      if (!ack.ok) {
        throw new Error(ack.error.message);
      }
    } catch (error) {
      if (!isCurrentView(view) || selectActiveRunId(useIMStore.getState(), threadId) !== runId) {
        return;
      }
      view.cancelRequestedRunId = null;
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
              disabled={isCancelling || !isConnected}
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
