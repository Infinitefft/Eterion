import { Tooltip } from 'radix-ui';
import type { ReactElement } from 'react';

export function ChatTooltip({ label, children, side = 'top' }: {
  label: string;
  children: ReactElement;
  side?: 'top' | 'right';
}) {
  return (
    <Tooltip.Provider delayDuration={350}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className='workspace-action-tooltip' side={side} sideOffset={8} collisionPadding={12}>
            {label}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
