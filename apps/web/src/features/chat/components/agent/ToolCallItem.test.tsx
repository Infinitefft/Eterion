import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { ToolCallBlockState } from '@/service/im/types';

import { ToolCallItem } from './ToolCallItem';

function renderTool(overrides: Partial<ToolCallBlockState>) {
  const block: ToolCallBlockState = {
    kind: 'tool', id: 'tool-1', threadId: 'thread-1', runId: 'run-1',
    name: 'web_search', displayName: '网页搜索', status: 'completed',
    args: null, summary: null, result: null, error: null,
    ...overrides,
  };
  return renderToStaticMarkup(<ToolCallItem block={block} />);
}

describe('ToolCallItem', () => {
  it('shows ordinary tool names and status without dumping arguments or results', () => {
    const html = renderTool({
      name: 'write_file', displayName: '写入文件',
      args: { path: 'private-path' }, result: { content: 'raw-result' },
    });
    expect(html).toContain('写入文件 · 已完成');
    expect(html).not.toContain('private-path');
    expect(html).not.toContain('raw-result');
    expect(html).not.toContain('<a ');
  });

  it('shows unique websites, keeps the full destination and rejects unsafe URLs', () => {
    const html = renderTool({ result: { results: [
      { title: '资料', url: 'https://example.com/docs' },
      { title: '另一页', url: 'https://example.com/other' },
      { title: '不安全', url: 'javascript:alert(1)' },
      { title: '错误地址', url: 'not-a-url' },
      { title: '带凭证', url: 'https://user:password@example.org' },
    ] } });
    expect(html).toContain('已搜索 1 个网站');
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('password');
    expect(html).not.toContain('https://example.com/other');
  });

  it('does not invent websites from a pending search query', () => {
    const html = renderTool({ status: 'running', args: { query: 'example.com' } });
    expect(html).toContain('正在搜索网页');
    expect(html).not.toContain('<a ');
  });

  it('shows a fetch destination while the tool is running', () => {
    const html = renderTool({ name: 'web_fetch', status: 'running', args: { url: 'https://example.com/page' } });
    expect(html).toContain('正在读取网页');
    expect(html).toContain('href="https://example.com/page"');
  });

  it('keeps failure feedback and handles missing historical result data', () => {
    expect(renderTool({ status: 'failed', error: { code: 'TOOL_ERROR', message: '搜索超时' } })).toContain('搜索超时');
    const html = renderTool({ result: { results: [null, 'invalid', { url: 12 }] } });
    expect(html).toContain('网页搜索已完成');
    expect(html).not.toContain('<a ');
  });

  it('shows a source button without navigating away or exposing document content', () => {
    const html = renderToStaticMarkup(<ToolCallItem onOpenSource={() => {}} block={{
      kind: 'tool', id: 'tool-rag', threadId: 'thread-1', runId: 'run-1',
      name: 'knowledge_search', displayName: '检索知识库', status: 'completed',
      args: { query: '缓存' }, summary: '检索到 1 个资料片段', error: null,
      result: { results: [{
        chunkId: '11111111-1111-4111-8111-111111111111',
        fileId: '22222222-2222-4222-8222-222222222222',
        knowledgeBaseId: '33333333-3333-4333-8333-333333333333',
        fileName: '笔记.md', headingPath: ['Redis', '缓存'],
        startOffset: 19, endOffset: 42, content: 'private-source-text',
      }] },
    }} />);
    expect(html).toContain('检索到 1 个资料片段');
    expect(html).toContain('笔记.md');
    expect(html).toContain('Redis / 缓存');
    expect(html).toContain('<button type="button"');
    expect(html).not.toContain('/repository?');
    expect(html).not.toContain('private-source-text');
  });
});
