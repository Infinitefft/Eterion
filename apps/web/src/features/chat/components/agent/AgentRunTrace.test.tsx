import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { IMStore } from '@/store/im-store';

import { AgentRunTrace } from './AgentRunTrace';

const { store } = vi.hoisted(() => ({ store: { detailsByThread: {} } as Pick<IMStore, 'detailsByThread'> }));
vi.mock('@/store/im-store', () => ({
  useIMStore: (selector: (state: Pick<IMStore, 'detailsByThread'>) => unknown) => selector(store),
}));

function render(content: string, status: 'running' | 'completed' | 'waiting_user' = 'running') {
  store.detailsByThread['thread-1'] = {
    messages: [],
    runs: [{ id: 'run-1', threadId: 'thread-1', modelId: 'model-1', status,
      inputMessageId: 'input-1', outputMessageId: 'output-1', createdAt: 1,
      startedAt: 1, completedAt: null, error: null }],
    blocks: [
      { kind: 'thinking', id: 'thinking-1', threadId: 'thread-1', runId: 'run-1',
        status: 'completed', content: '思考内容', contentOffset: 0 },
      { kind: 'tool', id: 'tool-1', threadId: 'thread-1', runId: 'run-1',
        name: 'web_search', displayName: null, args: null, result: null, summary: null,
        error: null, status: 'completed', contentOffset: 2 },
      ...(status === 'waiting_user' ? [{ kind: 'hitl' as const, id: 'hitl-1', threadId: 'thread-1', runId: 'run-1',
        status: 'requested' as const, questions: [{questionId: 'color', prompt: '选择颜色', required: true}], answers: null }] : []),
    ],
  };
  return renderToStaticMarkup(<AgentRunTrace threadId='thread-1' runId='run-1' content={content} />);
}

describe('combined run process', () => {
  it('keeps the combined process open before content arrives', () => {
    expect(render('')).toMatch(/class="chat-run-process-heading" aria-expanded="true"/);
  });

  it('collapses one process for all thinking and tools when content arrives, including history', () => {
    for (const status of ['running', 'completed'] as const) {
      const html = render('正式正文', status);
      expect(html.match(/>思考过程</g)).toHaveLength(1);
      expect(html).toMatch(/class="chat-run-process-heading" aria-expanded="false"/);
      expect(html).toContain('网页搜索已完成');
      expect(html).toContain('思考内容');
      expect(html).toContain('<p class="chat-message-text">正式正文</p>');
    }
  });

  it('keeps unanswered HITL outside the collapsed process', () => {
    const html = render('需要你补充信息', 'waiting_user');
    expect(html).toContain('</div></div><ul class="chat-run-steps"><li class="chat-hitl-step"');
    expect(html).toContain('选择颜色');
    expect(html).toContain('提交回答');
  });
});
