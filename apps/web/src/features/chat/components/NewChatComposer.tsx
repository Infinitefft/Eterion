import { ArrowUp, Paperclip } from 'lucide-react';
import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import { useNavigate } from 'react-router-dom';

import { createChatDetailPath } from '@/app/routePaths';
import { getIMService } from '@/service/im';
import type { MessageId, ModelId, ProtocolError, ThreadId } from '@/service/im/types';
import { useAuthStore } from '@/store/auth-store';
import { useIMStore } from '@/store/im-store';

import { resizeComposerTextarea, submitComposerOnEnter } from '../utils/composerInput';
import ModelList from './ModelList/ModelList';

const TEXTAREA_MIN_HEIGHT = 44;
const TEXTAREA_MAX_HEIGHT = 154;

export interface NewChatComposerHandle {
  applyPromptStarter(prompt: string): void;
}

interface NewChatComposerView {
  sessionVersion: number;
  isSubmitting: boolean;
}

/**
 * 新会话输入组件。
 * 通过 IMService 创建会话并发送首条消息，确认成功后进入详情页。
 */
export const NewChatComposer = forwardRef<NewChatComposerHandle>(
  function NewChatComposerImpl(_props, ref) {
    const navigate = useNavigate();
    const user = useAuthStore((state) => state.user);
    const sessionVersion = useAuthStore((state) => state.sessionVersion);
    const isConnected = useIMStore((state) => state.connection.status === 'connected');
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const viewRef = useRef<NewChatComposerView | null>(null);
    const [selectedModelId, setSelectedModelId] = useState<ModelId | null>(null);
    const [prompt, setPrompt] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState<string | null>(null);
    const [viewSessionVersion, setViewSessionVersion] = useState(sessionVersion);

    if (viewSessionVersion !== sessionVersion) {
      setViewSessionVersion(sessionVersion);
      setIsSubmitting(false);
      setSubmitError(null);
    }

    useLayoutEffect(() => {
      viewRef.current = { sessionVersion, isSubmitting: false };
      return () => { viewRef.current = null; };
    }, [sessionVersion]);

    const normalizedPrompt = prompt.trim();
    // 未登录时仍可点击发送，沿用原有的登录提示。
    const canSubmit = normalizedPrompt.length > 0 && !isSubmitting && (user === null || isConnected);

    function isCurrentView(view: NewChatComposerView | null): view is NewChatComposerView {
      return view !== null && viewRef.current === view &&
        useAuthStore.getState().sessionVersion === view.sessionVersion;
    }

    function handlePromptChange(event: ChangeEvent<HTMLTextAreaElement>) {
      setPrompt(event.target.value);
      setSubmitError(null);
    }

    function applyPromptStarter(nextPrompt: string) {
      const view = viewRef.current;
      if (!isCurrentView(view) || view.isSubmitting) return;

      setPrompt(nextPrompt);
      setSubmitError(null);

      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea || !isCurrentView(view)) return;

        resizeComposerTextarea(textarea, {
          minHeight: TEXTAREA_MIN_HEIGHT,
          maxHeight: TEXTAREA_MAX_HEIGHT,
        });
        textarea.focus();
        textarea.setSelectionRange(nextPrompt.length, nextPrompt.length);
      });
    }

    useImperativeHandle(ref, () => ({ applyPromptStarter }));

    // 创建、乐观消息与 ACK 处理保持连续，方便核对跳转时机。
    // eslint-disable-next-line complexity
    async function handleSubmit(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();

      const view = viewRef.current;
      if (!normalizedPrompt || !isCurrentView(view) || view.isSubmitting) return;

      if (!useAuthStore.getState().user) {
        setSubmitError('请先登录，再发起新的 AI 对话');
        return;
      }

      if (useIMStore.getState().connection.status !== 'connected') return;

      // 首条消息分属新 Thread，不能用已有会话的 busy 状态拦截重复创建。
      view.isSubmitting = true;
      setIsSubmitting(true);
      setSubmitError(null);
      let sentMessage: { threadId: ThreadId; messageId: MessageId } | null = null;

      function finishCreation(threadId: ThreadId) {
        if (!isCurrentView(view) || !useIMStore.getState().detailsByThread[threadId]) return;
        setPrompt('');
        void navigate(createChatDetailPath(threadId));
      }

      function handleFailure(error: ProtocolError) {
        if (useAuthStore.getState().sessionVersion !== sessionVersion) return;

        if (sentMessage) {
          const { threadId, messageId } = sentMessage;
          const store = useIMStore.getState();
          const message = store.detailsByThread[threadId]?.messages.find((item) => item.id === messageId);
          if (!message) return;
          // 事实事件可能先于 ACK 到达；已确认的首条消息意味着创建成功。
          if (message.status === 'completed') {
            finishCreation(threadId);
            return;
          }
          store.failSendingMessage(threadId, messageId, error);
        }

        if (isCurrentView(view)) setSubmitError(error.message);
      }

      try {
        const dispatch = getIMService().startThread({
          content: normalizedPrompt,
          modelId: selectedModelId ?? undefined,
        });
        const { threadId, messageId } = dispatch.command;
        sentMessage = { threadId, messageId };
        useIMStore.getState().addSendingMessage(threadId, messageId, normalizedPrompt);

        /** ACK 确认服务端已经接受创建请求，页面数据随后由 Envelope 更新。 */
        const ack = await dispatch.ack;

        if (ack.ok) {
          finishCreation(threadId);
        } else {
          handleFailure(ack.error);
        }
      } catch (error) {
        handleFailure({
          code: 'CLIENT_SEND_FAILED',
          message: error instanceof Error ? error.message : '创建新会话失败',
        });
      } finally {
        view.isSubmitting = false;
        if (isCurrentView(view)) setIsSubmitting(false);
      }
    }

    return (
      <div className='composer-dock'>
        <form
          className='composer'
          onSubmit={(event) => {
            void handleSubmit(event);
          }}
        >
          <label className='sr-only' htmlFor='chat-prompt'>
            输入消息
          </label>

          <textarea
            ref={textareaRef}
            id='chat-prompt'
            name='prompt'
            rows={1}
            placeholder='给 Eterion 发送消息'
            value={prompt}
            disabled={isSubmitting}
            onChange={handlePromptChange}
            onKeyDown={(event) => submitComposerOnEnter(event, canSubmit)}
            onInput={(event) =>
              resizeComposerTextarea(event.currentTarget, {
                minHeight: TEXTAREA_MIN_HEIGHT,
                maxHeight: TEXTAREA_MAX_HEIGHT,
              })
            }
            aria-describedby={submitError ? 'new-chat-submit-error' : undefined}
          />

          <div className='composer-toolbar'>
            <div className='composer-tools'>
              <button type='button' aria-label='添加附件'>
                <Paperclip size={18} />
              </button>
            </div>

            <div className='composer-actions'>
              <ModelList value={selectedModelId} onChange={setSelectedModelId} disabled={isSubmitting} />

              <button
                className='send-button'
                type='submit'
                aria-label='发送消息'
                disabled={!canSubmit}
              >
                <ArrowUp size={19} strokeWidth={2.3} />
              </button>
            </div>
          </div>

          {submitError ? (
            <p id='new-chat-submit-error' role='alert'>
              {submitError}
            </p>
          ) : null}
        </form>
      </div>
    );
  },
);
