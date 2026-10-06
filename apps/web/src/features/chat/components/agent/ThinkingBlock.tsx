import { Ban, Check, ChevronDown, CircleAlert, LoaderCircle } from 'lucide-react';
import { useId, useState } from 'react';

import type { ThinkingBlockState } from '@/service/im/types';

/** 展示状态随阶段切换一次；同一阶段的增量不覆盖用户的展开选择。 */
export function ThinkingBlock({ block }: { block: ThinkingBlockState }) {
  const streaming = block.status === 'streaming';
  const [view, setView] = useState({ streaming, expanded: streaming });
  const contentId = useId();
  if (view.streaming !== streaming) {
    setView({ streaming, expanded: streaming });
  }
  const label = streaming ? '正在思考' : block.status === 'cancelled' ? '思考已停止'
    : block.status === 'failed' ? '思考中断' : '思考完成';

  return (
    <li className='chat-thinking-block' data-status={block.status}>
      <button type='button' className='chat-thinking-heading'
        aria-expanded={view.expanded} aria-controls={contentId}
        onClick={() => setView({ streaming, expanded: !view.expanded })}>
        {streaming ? <LoaderCircle size={14} className='chat-run-spinner' aria-hidden='true' />
          : block.status === 'cancelled' ? <Ban size={14} aria-hidden='true' />
            : block.status === 'failed' ? <CircleAlert size={14} aria-hidden='true' />
              : <Check size={14} aria-hidden='true' />}
        <span>{label}</span>
        <ChevronDown size={14} className={view.expanded ? 'chat-tool-chevron is-expanded' : 'chat-tool-chevron'} aria-hidden='true' />
      </button>
      <div id={contentId} hidden={!view.expanded} className='chat-thinking-content'>
        {block.content}
      </div>
    </li>
  );
}
