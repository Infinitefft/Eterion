import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { StreamingMarkdown } from './StreamingMarkdown';

describe('custom Markdown rendering', () => {
  it('renders supported block and inline nodes', () => {
    const html = renderToStaticMarkup(<StreamingMarkdown content={'# 标题\n\n**粗体** `code` [链接](https://example.com)\n\n3. 三\n4. 四\n\n> 引用'} />);
    expect(html).toContain('<h1>标题</h1>');
    expect(html).toContain('<strong>粗体</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<a href="https://example.com">链接</a>');
    expect(html).toContain('<ol start="3"><li>三</li><li>四</li></ol>');
    expect(html).toContain('<blockquote><p>引用</p></blockquote>');
  });

  it('highlights incomplete streaming code and safely renders unknown languages', () => {
    const html = renderToStaticMarkup(<StreamingMarkdown content={'```ts\nconst text = "hello'} streaming />);
    expect(html).toContain('hljs-keyword');
    expect(html).toContain('hello');
    const plain = renderToStaticMarkup(<StreamingMarkdown content={'```unknown\n<script>unsafe</script>\n```'} />);
    expect(plain).toContain('&lt;script&gt;unsafe&lt;/script&gt;');
    expect(plain).not.toContain('hljs-');
  });

  it('never turns raw HTML or unsafe link protocols into executable markup', () => {
    const html = renderToStaticMarkup(<StreamingMarkdown content={'<script>alert(1)</script>\n\n[unsafe](javascript:alert(1))'} />);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('unsafe');
  });
});
