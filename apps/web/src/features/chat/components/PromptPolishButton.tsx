import polishIcon from '@/assets/icons/prompt-polish-v1.png';
import { ChatTooltip } from './ChatTooltip';

import './PromptPolishButton.less';

export function PromptPolishButton() {
  return (
    <ChatTooltip label='润色提示词（暂未接入）'>
          <button className='prompt-polish-button' type='button' aria-label='润色提示词（预览）' aria-disabled='true'>
            <img src={polishIcon} width={24} height={24} alt='' />
          </button>
    </ChatTooltip>
  );
}
