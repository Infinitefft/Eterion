import { ArrowUp, Paperclip } from 'lucide-react';
import {
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import { useNavigate } from 'react-router-dom';

import { createChatDetailPath } from '@/app/routePaths';
import { getIMService } from '@/service/im';
import type { ModelId } from '@/service/im/types';
import { useAuthStore } from '@/store/authStore';

import { resizeComposerTextarea, submitComposerOnEnter } from '../utils/composerInput';
import ModelList from './ModelList/ModelList';

const TEXTAREA_MIN_HEIGHT = 44;
const TEXTAREA_MAX_HEIGHT = 154;

export interface NewChatComposerHandle {
  applyPromptStarter(prompt: string): void;
}

/**
 * 新会话输入组件。
 * 提交时先由前端创建 Chat 和首条 Prompt 意图，再导航到详情页自动发送。
 */
export const NewChatComposer = forwardRef<NewChatComposerHandle>(
  function NewChatComposerImpl(_props, ref) {
    const navigate = useNavigate();
    const user = useAuthStore((state) => state.user);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [selectedModelId, setSelectedModelId] = useState<ModelId | null>(null);
    const [prompt, setPrompt] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState<string | null>(null);
    const normalizedPrompt = prompt.trim();

    function handlePromptChange(event: ChangeEvent<HTMLTextAreaElement>) {
      setPrompt(event.target.value);
      setSubmitError(null);
    }

    function applyPromptStarter(nextPrompt: string) {
      setPrompt(nextPrompt);
      setSubmitError(null);

      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;

        resizeComposerTextarea(textarea, {
          minHeight: TEXTAREA_MIN_HEIGHT,
          maxHeight: TEXTAREA_MAX_HEIGHT,
        });
        textarea.focus();
        textarea.setSelectionRange(nextPrompt.length, nextPrompt.length);
      });
    }

    useImperativeHandle(ref, () => ({ applyPromptStarter }));

    async function handleSubmit(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();

      if (!normalizedPrompt || isSubmitting) return;

      if (!user) {
        setSubmitError('请先登录，再发起新的 AI 对话');
        return;
      }

      setIsSubmitting(true);
      setSubmitError(null);

      try {
        const dispatch = getIMService().startThread({
          content: normalizedPrompt,
          modelId: selectedModelId ?? undefined,
        });

        /** ACK 确认服务端已经接受创建请求，页面数据随后由 Envelope 更新。 */
        const ack = await dispatch.ack;

        if (!ack.ok) {
          throw new Error(ack.error.message);
        }

        setPrompt('');
        void navigate(createChatDetailPath(dispatch.command.threadId));
      } catch (error) {
        setSubmitError(error instanceof Error ? error.message : '创建新会话失败');
      } finally {
        setIsSubmitting(false);
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
            onKeyDown={(event) => submitComposerOnEnter(event, normalizedPrompt.length > 0)}
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
              <ModelList value={selectedModelId} onChange={setSelectedModelId} />

              <button
                className='send-button'
                type='submit'
                aria-label='发送消息'
                disabled={normalizedPrompt.length === 0 || isSubmitting}
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
