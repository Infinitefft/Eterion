import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { IMStore } from '@/store/im-store';

import { AgentRunTrace } from './AgentRunTrace';

const { store } = vi.hoisted(() => ({ store: { detailsByThread: {} } as Pick<IMStore, 'detailsByThread'> }));
vi.mock('@/store/im-store', () => ({
  useIMStore: (selector: (state: Pick<IMStore, 'detailsByThread'>) => unknown) => selector(store),
}));

function render(content: string, status: 'running' | 'completed' | 'waiting_user' = 'running', contentOffset?: number) {
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
        status: 'requested' as const, contentOffset, questions: [{questionId: 'color', prompt: '选择颜色', required: true}], answers: null }] : []),
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
    expect(html).toContain('</div></div></div><p class="chat-message-text">需要你补充信息</p><ul class="chat-run-steps"><li class="chat-hitl-step"');
    expect(html).toContain('选择颜色');
    expect(html).toContain('提交回答');
  });

  it('keeps HITL at its UTF-16 position before resumed text, including resolved history', () => {
    const content = '你好🙂回答后的内容';
    const html = render(content, 'waiting_user', 4);
    expect(html).toContain('<p class="chat-message-text">你好🙂</p><ul');
    expect(html).toContain('</ul><p class="chat-message-text">回答后的内容</p>');
    const detail = store.detailsByThread['thread-1']!;
    const interaction = detail.blocks.find((block) => block.kind === 'hitl')!;
    interaction.status = 'resolved';
    interaction.answers = [{ questionId: 'color', value: '蓝色' }];
    detail.runs[0].status = 'completed';
    const history = renderToStaticMarkup(<AgentRunTrace threadId='thread-1' runId='run-1' content={content} />);
    expect(history.indexOf('你好🙂')).toBeLessThan(history.indexOf('已回答'));
    expect(history.indexOf('已回答')).toBeLessThan(history.indexOf('回答后的内容'));
  });

  it('places HITL before text when it was requested at offset zero', () => {
    const html = render('后续正文', 'waiting_user', 0);
    expect(html.indexOf('提交回答')).toBeLessThan(html.indexOf('后续正文'));
  });

  it('starts an independent process after HITL even at the same offset', () => {
    render('你好🙂', 'waiting_user', 4);
    const detail = store.detailsByThread['thread-1']!;
    detail.runs[0].status = 'running';
    const interaction = detail.blocks.find((block) => block.kind === 'hitl')!;
    interaction.status = 'resolved';
    interaction.answers = [{ questionId: 'color', value: '蓝色' }];
    detail.blocks.push({ kind: 'thinking', id: 'thinking-2', threadId: 'thread-1', runId: 'run-1',
      status: 'streaming', content: '继续思考', contentOffset: 4 });
    const renderCurrent = (content: string) => renderToStaticMarkup(
      <AgentRunTrace threadId='thread-1' runId='run-1' content={content} />,
    );
    const streaming = renderCurrent('你好🙂');
    expect(streaming.match(/chat-run-process-heading" aria-expanded="(true|false)"/g)).toEqual([
      'chat-run-process-heading" aria-expanded="false"',
      'chat-run-process-heading" aria-expanded="true"',
    ]);
    expect(streaming.match(/chat-run-process-icon is-active/g)).toHaveLength(1);
    expect(streaming.indexOf('你好🙂')).toBeLessThan(streaming.indexOf('已回答'));
    expect(streaming.indexOf('已回答')).toBeLessThan(streaming.indexOf('继续思考'));
    const withAnswer = renderCurrent('你好🙂后续正文');
    expect(withAnswer.match(/chat-run-process-heading" aria-expanded="false"/g)).toHaveLength(2);
    expect(withAnswer.indexOf('继续思考')).toBeLessThan(withAnswer.indexOf('后续正文'));
    detail.runs[0].status = 'completed';
    const history = renderCurrent('你好🙂后续正文');
    expect(history.match(/>思考过程</g)).toHaveLength(2);
    expect(history).not.toContain('chat-run-process-icon is-active');
  });

  it('keeps consecutive HITL boundaries separate without adding empty process groups', () => {
    render('正文', 'waiting_user', 2);
    const detail = store.detailsByThread['thread-1']!;
    detail.blocks.push({ kind: 'hitl', id: 'hitl-2', threadId: 'thread-1', runId: 'run-1',
      status: 'requested', contentOffset: 2, questions: [{ questionId: 'size', prompt: '选择大小' }], answers: null });
    detail.blocks.push({ kind: 'thinking', id: 'thinking-3', threadId: 'thread-1', runId: 'run-1',
      status: 'completed', content: '最后一段思考', contentOffset: 2 });
    const html = renderToStaticMarkup(<AgentRunTrace threadId='thread-1' runId='run-1' content='正文结束' />);
    expect(html.match(/>思考过程</g)).toHaveLength(2);
    expect(html.indexOf('选择颜色')).toBeLessThan(html.indexOf('选择大小'));
    expect(html.indexOf('选择大小')).toBeLessThan(html.indexOf('最后一段思考'));
    expect(html.indexOf('最后一段思考')).toBeLessThan(html.indexOf('>结束</p>'));
  });
});
