import polishIcon from '@/assets/icons/prompt-polish.svg';
import { Check, Info, LoaderCircle, Undo2 } from 'lucide-react';
import { ChatTooltip } from './ChatTooltip';

import './PromptPolishButton.less';

export function PromptPolishButton({ busy, disabled, onClick, revision, notice, onToggle }: {
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
  revision: { applied: boolean } | null;
  notice: string | null;
  onToggle: () => void;
}) {
  return (
    <div className='prompt-polish-actions'>
      {!busy && revision && (
        <ChatTooltip label={revision.applied ? '撤销润色' : '应用润色'}>
          <button className='prompt-polish-button' type='button' disabled={disabled} aria-label={revision.applied ? '撤销润色' : '应用润色'} onClick={onToggle}>
            {revision.applied ? <Undo2 size={20} /> : <Check size={20} />}
          </button>
        </ChatTooltip>
      )}
      {!busy && notice && (
        <ChatTooltip label={notice}>
          <button className='prompt-polish-button' type='button' aria-label={notice}>
            <Info size={16} />
          </button>
        </ChatTooltip>
      )}
      <ChatTooltip label={busy ? '正在润色' : '润色提示词'}>
        <button className='prompt-polish-button' type='button' aria-label={busy ? '正在润色' : '润色提示词'} disabled={disabled || busy} onClick={onClick}>
          {busy ? <LoaderCircle className='prompt-polish-spinner' size={20} /> : <img src={polishIcon} width={22} height={22} alt='' />}
        </button>
      </ChatTooltip>
      <span className='sr-only' role='status'>{busy ? '正在润色' : notice || (revision ? revision.applied ? '已应用润色' : '已恢复原文' : '')}</span>
    </div>
  );
}
