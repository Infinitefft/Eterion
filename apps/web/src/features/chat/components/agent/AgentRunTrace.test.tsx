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
        name: 'get_turn_time', displayName: '获取时间', args: null, result: null, summary: null,
        error: null, status: 'completed', contentOffset: 0 },
      ...(status === 'waiting_user' ? [{ kind: 'hitl' as const, id: 'hitl-1', threadId: 'thread-1', runId: 'run-1',
        status: 'requested' as const, contentOffset, questions: [{questionId: 'color', prompt: '选择颜色', required: true}], answers: null }] : []),
    ],
  };
  return renderToStaticMarkup(<AgentRunTrace threadId='thread-1' runId='run-1' content={content} />);
}

describe('combined run process', () => {
  it('preserves unsupported table syntax as text in the lightweight renderer', () => {
    const html = render('汇总结论\n\n| 检查项 | 结果 |\n|---|---|\n| 英文查询 | ✅ 正常 |', 'completed');
    expect(html).not.toContain('<table>');
    expect(html).toContain('| 检查项 | 结果 |');
    expect(html).toContain('|---|---|');
    expect(html).toContain('| 英文查询 | ✅ 正常 |');
  });

  it('renders custom headings, bold text and highlighted code in streaming and history', () => {
    for (const status of ['running', 'completed'] as const) {
      const html = render('# 标题\n\n**加粗**\n\n```ts\nconst value = 1;\n```', status);
      expect(html).toContain('<h1>标题</h1>');
      expect(html).toContain('<strong>加粗</strong>');
      expect(html).toContain('hljs-keyword');
      expect(html).not.toContain('```');
    }
  });

  it('shows web tools inside their process group at the saved UTF-16 position', () => {
    render('你好🙂搜索后的正文', 'completed');
    const detail = store.detailsByThread['thread-1']!;
    const tool = detail.blocks.find((block) => block.kind === 'tool')!;
    tool.contentOffset = 4;
    for (const name of ['web_search', 'web_fetch']) {
      tool.name = name;
      tool.result = name === 'web_search'
        ? { results: [{ url: 'https://example.com/result', title: '搜索结果' }] }
        : { url: 'https://example.com/result', title: '网页' };
      for (const status of ['running', 'completed', 'failed'] as const) {
        tool.status = status;
        const html = renderToStaticMarkup(<AgentRunTrace threadId='thread-1' runId='run-1' content='你好🙂搜索后的正文' />);
        expect(html).toContain('chat-run-process-heading" aria-expanded="false"');
        expect(html).toContain('<div class="chat-message-text"><p>你好🙂</p></div><div class="chat-run-trace"');
        expect(html).toMatch(/hidden=""><ul class="chat-run-steps"><li class="chat-tool-call"/);
        expect(html).toContain('href="https://example.com/result"');
        expect(html).toContain('</ul></div></div></div><div class="chat-message-text"><p>搜索后的正文</p></div>');
      }
    }
  });

  it('keeps consecutive searches and resumed thinking in order at the same offset', () => {
    render('', 'running');
    const detail = store.detailsByThread['thread-1']!;
    const tool = detail.blocks.find((block) => block.kind === 'tool')!;
    tool.name = 'web_search';
    tool.contentOffset = 0;
    detail.blocks.push({ ...tool, id: 'fetch-2', name: 'web_fetch' });
    detail.blocks.push({ kind: 'thinking', id: 'thinking-2', threadId: 'thread-1', runId: 'run-1',
      status: 'completed', content: '搜索后继续思考', contentOffset: 0 });
    const html = renderToStaticMarkup(<AgentRunTrace threadId='thread-1' runId='run-1' content='最终正文' />);
    expect(html.match(/chat-run-process-heading" aria-expanded="false"/g)).toHaveLength(1);
    expect(html.indexOf('网页搜索已完成')).toBeLessThan(html.indexOf('已读取网页'));
    expect(html.indexOf('已读取网页')).toBeLessThan(html.indexOf('搜索后继续思考'));
    expect(html.indexOf('搜索后继续思考')).toBeLessThan(html.indexOf('最终正文'));
  });

  it('shows one choice question with its recommendation first and one custom input', () => {
    render('', 'waiting_user', 0);
    const detail = store.detailsByThread['thread-1']!;
    const interaction = detail.blocks.find((block) => block.kind === 'hitl')!;
    interaction.questions = [{ questionId: 'color', prompt: '选择颜色', required: true,
      options: ['红色', '蓝色'], recommendedOption: '蓝色' }];
    const html = renderToStaticMarkup(<AgentRunTrace threadId='thread-1' runId='run-1' />);
    expect(html.indexOf('蓝色')).toBeLessThan(html.indexOf('红色'));
    expect(html).toContain('推荐');
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html.match(/<textarea/g)).toHaveLength(1);
    expect(html).not.toContain('checked=""');
    expect(html).not.toContain('<select');
  });

  it('keeps the combined process open before content arrives', () => {
    expect(render('')).toMatch(/class="chat-run-process-heading" aria-expanded="true"/);
  });

  it('collapses thinking and ordinary tools when content arrives, including history', () => {
    for (const status of ['running', 'completed'] as const) {
      const html = render('正式正文', status);
      expect(html.match(/>思考过程</g)).toHaveLength(1);
      expect(html).toMatch(/class="chat-run-process-heading" aria-expanded="false"/);
      expect(html).toContain('获取时间 · 已完成');
      expect(html).toContain('思考内容');
      expect(html).toContain('<div class="chat-message-text"><p>正式正文</p></div>');
    }
  });

  it('keeps unanswered HITL inside an expanded process after the preceding text', () => {
    const html = render('需要你补充信息', 'waiting_user');
    expect(html).toContain('<div class="chat-message-text"><p>需要你补充信息</p></div><div class="chat-run-trace"');
    expect(html).toMatch(/aria-expanded="true"[\s\S]*<ul class="chat-run-steps"><li class="chat-hitl-step"/);
    expect(html).toContain('选择颜色');
    expect(html).toContain('提交回答');
  });

  it('keeps HITL at its UTF-16 position before resumed text, including resolved history', () => {
    const content = '你好🙂回答后的内容';
    const html = render(content, 'waiting_user', 4);
    expect(html).toContain('<div class="chat-message-text"><p>你好🙂</p></div><div class="chat-run-trace"');
    expect(html).toContain('</ul></div></div></div><div class="chat-message-text"><p>回答后的内容</p></div>');
    const detail = store.detailsByThread['thread-1']!;
    const interaction = detail.blocks.find((block) => block.kind === 'hitl')!;
    interaction.status = 'resolved';
    interaction.answers = [{ questionId: 'color', value: '蓝色' }];
    detail.runs[0].status = 'completed';
    const history = renderToStaticMarkup(<AgentRunTrace threadId='thread-1' runId='run-1' content={content} />);
    expect(history).not.toContain('已回答');
    expect(history).not.toContain('选择颜色');
    expect(history.indexOf('你好🙂')).toBeLessThan(history.indexOf('回答后的内容'));
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
    expect(streaming).not.toContain('已回答');
    expect(streaming).not.toContain('选择颜色');
    expect(streaming.indexOf('你好🙂')).toBeLessThan(streaming.indexOf('继续思考'));
    const withAnswer = renderCurrent('你好🙂后续正文');
    expect(withAnswer.match(/chat-run-process-heading" aria-expanded="false"/g)).toHaveLength(2);
    expect(withAnswer.indexOf('继续思考')).toBeLessThan(withAnswer.indexOf('后续正文'));
    detail.runs[0].status = 'completed';
    const history = renderCurrent('你好🙂后续正文');
    expect(history.match(/>思考过程</g)).toHaveLength(2);
    expect(history).not.toContain('chat-run-process-icon is-active');
  });

  it('merges consecutive HITL and thinking when no text separates them', () => {
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
    expect(html.indexOf('最后一段思考')).toBeLessThan(html.indexOf('>结束</p></div>'));
  });

  it('keeps one process across HITL resume without body text, including whitespace-only output', () => {
    for (const content of ['', ' \n']) {
      render(content, 'waiting_user', 0);
      const detail = store.detailsByThread['thread-1']!;
      detail.runs[0].status = 'running';
      const interaction = detail.blocks.find((block) => block.kind === 'hitl')!;
      interaction.status = 'resolved';
      detail.blocks.push({ kind: 'thinking', id: 'resumed', threadId: 'thread-1', runId: 'run-1',
        status: 'streaming', content: '恢复后的思考', contentOffset: content.length });
      const html = renderToStaticMarkup(<AgentRunTrace threadId='thread-1' runId='run-1' content={content} />);
      expect(html.match(/>思考过程</g)).toHaveLength(1);
      expect(html).toContain('chat-run-process-heading" aria-expanded="true"');
      expect(html.indexOf('获取时间')).toBeLessThan(html.indexOf('恢复后的思考'));
    }
  });
});
