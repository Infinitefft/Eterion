import { ArrowUp, ChevronDown, Paperclip } from 'lucide-react';
import { useState, type ChangeEvent, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { createChatDetailPath } from '@/app/routePaths';
import { getIMService } from '@/service/im';
import { useAuthStore } from '@/store/authStore';

import {
  resizeComposerTextarea,
  submitComposerOnEnter,
} from '../utils/composerInput';

const TEXTAREA_MIN_HEIGHT = 58;
const TEXTAREA_MAX_HEIGHT = 154;

/**
 * 新会话输入组件。
 * 提交时先由前端创建 Chat 和首条 Prompt 意图，再导航到详情页自动发送。
 */
export function NewChatComposer() {
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);
  const [prompt, setPrompt] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const normalizedPrompt = prompt.trim();

  function handlePromptChange(event: ChangeEvent<HTMLTextAreaElement>) {
    setPrompt(event.target.value);
    setSubmitError(null);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!normalizedPrompt) return;

    if (!user) {
      setSubmitError('请先登录，再发起新的 AI 对话');
      return;
    }

    try {
      /** prepareNewChat 会同步写入 Zustand，侧边栏会在导航前得到新会话。 */
      const chatId = getIMService().prepareNewChat({
        prompt: normalizedPrompt,
      });

      void navigate(createChatDetailPath(chatId));
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : '创建新会话失败',
      );
    }
  }

  return (
    <div className='composer-dock'>
      <form className='composer' onSubmit={handleSubmit}>
        <label className='sr-only' htmlFor='chat-prompt'>
          输入消息
        </label>

        <textarea
          id='chat-prompt'
          name='prompt'
          rows={2}
          placeholder='给 Eterion 发送消息'
          value={prompt}
          onChange={handlePromptChange}
          onKeyDown={(event) =>
            submitComposerOnEnter(event, normalizedPrompt.length > 0)
          }
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
            <button className='model-button' type='button'>
              Eterion Agent
              <ChevronDown size={14} />
            </button>

            <button
              className='send-button'
              type='submit'
              aria-label='发送消息'
              disabled={normalizedPrompt.length === 0}
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
}
