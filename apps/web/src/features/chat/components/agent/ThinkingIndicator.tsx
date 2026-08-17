import type { CSSProperties } from 'react';

const THINKING_DOTS = [0, 1, 2] as const;

/** Agent 正在组织答案时使用的轻量波光文字。 */
export function ThinkingIndicator() {
  return (
    <span className='chat-thinking-dots' role='status' aria-label='正在思考'>
      {THINKING_DOTS.map((index) => (
        <span
          key={index}
          className='chat-thinking-dot'
          style={{ '--thinking-index': index } as CSSProperties}
          aria-hidden='true'
        />
      ))}
    </span>
  );
}
