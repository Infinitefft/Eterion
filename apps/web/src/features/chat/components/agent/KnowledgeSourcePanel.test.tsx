import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';

import { useAuthStore } from '@/store/auth-store';

import { KnowledgeSourcePanel } from './KnowledgeSourcePanel';

it('shows full original text and highlights the exact UTF-16 range', () => {
  const text = '\uFEFF# 缓存\r\nemoji😀 cache\r\n后续内容';
  const startOffset = text.indexOf('cache');
  const client = new QueryClient();
  client.setQueryData(
    ['knowledge-file-content', useAuthStore.getState().sessionVersion, 'base', 'file', true],
    { format: 'md', content: text },
  );
  const html = renderToStaticMarkup(<QueryClientProvider client={client}>
    <KnowledgeSourcePanel source={{
      chunkId: 'chunk', knowledgeBaseId: 'base', fileId: 'file',
      fileName: '完整文件名.md', headingPath: ['缓存'],
      startOffset, endOffset: startOffset + 'cache'.length,
    }} onClose={() => {}} />
  </QueryClientProvider>);
  expect(html).toContain('完整文件名.md');
  expect(html).toContain('<h1>缓存</h1>');
  expect(html).toContain('<mark>cache</mark>');
  expect(html).toContain('emoji😀');
  expect(html).toContain('后续内容');
  expect(html).not.toContain('文件大小');
  expect(html).not.toContain('Markdown');
});

it('renders lists and fenced code while highlighting a code hit', () => {
  const text = '# 示例\n\n- 第一项\n- 第二项\n\n```ts\nconst hit = 1;\n```';
  const client = new QueryClient();
  client.setQueryData(
    ['knowledge-file-content', useAuthStore.getState().sessionVersion, 'base', 'file', true],
    { format: 'md', content: text },
  );
  const html = renderToStaticMarkup(<QueryClientProvider client={client}>
    <KnowledgeSourcePanel source={{
      chunkId: 'code', knowledgeBaseId: 'base', fileId: 'file',
      fileName: 'example.md', headingPath: ['示例'],
      startOffset: text.indexOf('hit'), endOffset: text.indexOf('hit') + 3,
    }} onClose={() => {}} />
  </QueryClientProvider>);
  expect(html).toContain('<li>第一项</li>');
  expect(html).toContain('<li>第二项</li>');
  expect(html).toContain('<code class="language-ts"><mark>const hit = 1;');
});
