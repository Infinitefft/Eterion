import { describe, expect, it } from 'vitest';

import { updateMarkdownRenderState } from './renderState';
import { StreamingMarkdownParser } from './streamingParser';

describe('streaming Markdown', () => {
  const content = '# 标题\r\n\r\n**加粗** 和 `代码` [链接](https://example.com) 😀\r\n\r\n- 一\r\n- 二\r\n\r\n> 引用\r\n\r\n~~~ts\r\nconst x = 1;\r\n~~~\r\n结尾';

  it('produces the same final AST across every two-chunk boundary and individual code units', () => {
    const full = new StreamingMarkdownParser();
    full.push(content);
    const expected = full.finish();
    for (let split = 0; split <= content.length; split++) {
      const parser = new StreamingMarkdownParser();
      parser.push(content.slice(0, split));
      parser.push(content.slice(split));
      expect(parser.finish()).toEqual(expected);
    }
    const parser = new StreamingMarkdownParser();
    for (let index = 0; index < content.length; index++) parser.push(content[index]);
    expect(parser.finish()).toEqual(expected);
  });

  it('shares stable blocks without mutating an earlier render or duplicating retried deltas', () => {
    const previous = updateMarkdownRenderState(null, '# 标题\n\n正文', true);
    const snapshot = previous.parser.getSnapshot();
    const next = updateMarkdownRenderState(previous, '# 标题\n\n正文追加', true);
    expect(next.parser.getSnapshot().stableBlocks).toBe(snapshot.stableBlocks);
    expect(previous.parser.getSnapshot()).toBe(snapshot);
    const retry = updateMarkdownRenderState(previous, '# 标题\n\n正文追加', true);
    expect(retry.parser.getSnapshot()).toEqual(next.parser.getSnapshot());
    const completed = updateMarkdownRenderState(next, next.content, false);
    expect(completed.parser.getSnapshot().activeBlock).toBeNull();
    expect(completed.parser.getSnapshot().stableBlocks[0]).toBe(snapshot.stableBlocks[0]);
    expect(completed.parser.getSnapshot().stableBlocks[1]).toMatchObject({
      type: 'paragraph', children: [{ type: 'text', value: '正文追加' }],
    });
    expect(updateMarkdownRenderState(completed, completed.content, false)).toBe(completed);
  });

  it('rebuilds for snapshot replacement, truncation and continuation after completion', () => {
    let state = updateMarkdownRenderState(null, '旧内容\n\n末尾', true);
    for (const [content, streaming] of [
      ['新内容\n\n末尾', true], ['新内容', true], ['新内容', false], ['新内容继续', true],
    ] as const) {
      state = updateMarkdownRenderState(state, content, streaming);
      const fresh = updateMarkdownRenderState(null, content, streaming);
      expect(state.parser.getSnapshot()).toEqual(fresh.parser.getSnapshot());
    }
  });

  it('keeps a code block identity when an incomplete fence is finalized', () => {
    const parser = new StreamingMarkdownParser();
    parser.push('```js\nconst value = "partial');
    const active = parser.getSnapshot().activeBlock;
    expect(active).toMatchObject({ type: 'code', value: 'const value = "partial' });
    const final = parser.finish();
    expect(final.stableBlocks[0]?.id).toBe(active?.id);
    expect(parser.finish()).toBe(final);
    expect(() => parser.push('more')).toThrow();
  });
});
