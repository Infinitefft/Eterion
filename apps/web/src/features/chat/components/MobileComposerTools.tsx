import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, Gauge, LoaderCircle, Minimize2, MoreHorizontal, Undo2 } from 'lucide-react';
import type { ComponentProps } from 'react';
import polishIcon from '@/assets/icons/prompt-polish.svg';
import type { PromptPolishButton } from './PromptPolishButton';
import './MobileComposerTools.less';

export function MobileComposerTools({ polish, context, compression }: {
  polish: ComponentProps<typeof PromptPolishButton>;
  context?: { disabled: boolean; onClick: () => void };
  compression?: { disabled: boolean; busy: boolean; onClick: () => void };
}) {
  return (
    <div className='mobile-composer-tools'>
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <button className='mobile-composer-tool' type='button' aria-label='更多工具'>
            {polish.busy || compression?.busy ? <LoaderCircle className='prompt-polish-spinner' size={20} /> : <MoreHorizontal size={22} />}
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className='mobile-composer-menu' side='top' align='start' sideOffset={10} collisionPadding={12}>
            <DropdownMenu.Item disabled={polish.disabled || polish.busy} onSelect={polish.onClick}>
              <img src={polishIcon} width={22} height={22} alt='' />
              {polish.busy ? '正在润色' : '润色提示词'}
            </DropdownMenu.Item>
            {!polish.busy && polish.revision && (
              <DropdownMenu.Item disabled={polish.disabled} onSelect={polish.onToggle}>
                {polish.revision.applied ? <Undo2 size={20} /> : <Check size={20} />}
                {polish.revision.applied ? '撤销润色' : '应用润色'}
              </DropdownMenu.Item>
            )}
            {context && <DropdownMenu.Item disabled={context.disabled} onSelect={context.onClick}><Gauge size={20} />查看上下文</DropdownMenu.Item>}
            {compression && <DropdownMenu.Item disabled={compression.disabled} onSelect={compression.onClick}><Minimize2 size={20} />{compression.busy ? '正在压缩' : '压缩上下文'}</DropdownMenu.Item>}
            {polish.notice && <p className='mobile-composer-notice' role='status'>{polish.notice}</p>}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
