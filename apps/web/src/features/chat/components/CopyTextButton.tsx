import { Check } from 'lucide-react';
import { Tooltip } from 'radix-ui';
import { useEffect, useState } from 'react';

import copyMessageIcon from '@/assets/icons/copy-message.png';

export function CopyTextButton({ text, label }: { text: string; label: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    if (status === 'idle') return;
    const timeout = window.setTimeout(() => setStatus('idle'), 2000);
    return () => window.clearTimeout(timeout);
  }, [status]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setStatus('copied');
    } catch {
      setStatus('failed');
    }
  }

  const feedback = status === 'copied' ? '已复制' : status === 'failed' ? '复制失败，请重试' : '';

  return <>
    <span className='chat-copy-feedback' role='status'>
      {status === 'failed' ? feedback : ''}
    </span>
    <Tooltip.Provider delayDuration={350}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button className='chat-user-copy' type='button' aria-label={feedback || label} onClick={() => void copy()}>
            {status === 'copied' ? <Check size={16} aria-hidden='true' /> : (
              <img src={copyMessageIcon} width={22} height={22} alt='' aria-hidden='true' />
            )}
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className='workspace-action-tooltip' side='bottom' sideOffset={6} collisionPadding={12}>
            {feedback || label}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  </>;
}
