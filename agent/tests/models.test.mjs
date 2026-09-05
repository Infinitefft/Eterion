import assert from 'node:assert/strict';
import test from 'node:test';

import { extractContentDelta } from '../dist/models.js';

test('正文提取兼容 text 和字符串 content，并保持 text 优先级', () => {
  assert.equal(extractContentDelta({ text: '正文', content: '备用正文' }), '正文');
  assert.equal(extractContentDelta({ text: '', content: '备用正文' }), '备用正文');
  assert.equal(extractContentDelta({ content: '正文' }), '正文');
});

test('仅拼接正文块，不泄漏 reasoning 或 Tool Call', () => {
  assert.equal(extractContentDelta({
    content: [
      { type: 'text', text: '第一段' },
      { type: 'reasoning', text: '不应公开' },
      { type: 'tool_call', text: '不应混入正文' },
      { type: 'output_text', text: '第二段' },
    ],
  }), '第一段第二段');
});

test('无正文的 chunk 和非文本块不会产生内容', () => {
  for (const chunk of [
    null, undefined, 'raw-text', {}, { reasoning_content: '不应公开' },
    { content: [null, 'raw-text', { type: 'text', text: 42 }] },
  ]) {
    assert.equal(extractContentDelta(chunk), '');
  }
});
