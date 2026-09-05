import assert from 'node:assert/strict';
import test from 'node:test';

import { projectToolResult } from '../dist/tools/presentation.js';

test('web_search 保留标题和 URL 列表', () => {
  const presentation = projectToolResult('web_search', {
    query: 'LangChain Agent',
    results: [
      {
        title: 'LangChain Agents',
        url: 'https://docs.langchain.com/oss/javascript/langchain/agents',
      },
    ],
  });

  assert.equal(presentation.summary, '找到 1 个相关网页');
  assert.deepEqual(presentation.result, {
    query: 'LangChain Agent',
    results: [
      {
        title: 'LangChain Agents',
        url: 'https://docs.langchain.com/oss/javascript/langchain/agents',
      },
    ],
  });
});

test('web_fetch 不向前端结果暴露网页正文', () => {
  const presentation = projectToolResult('web_fetch', {
    content: '这是一段只能交给模型的完整网页正文。',
    title: 'LangChain Agents',
    truncated: false,
    url: 'https://docs.langchain.com/oss/javascript/langchain/agents',
  });

  assert.deepEqual(presentation.result, {
    title: 'LangChain Agents',
    truncated: false,
    url: 'https://docs.langchain.com/oss/javascript/langchain/agents',
  });
  assert.equal(JSON.stringify(presentation).includes('完整网页正文'), false);
});

test('能够读取 LangChain ToolMessage 中的 JSON content', () => {
  const presentation = projectToolResult('web_fetch', {
    content: JSON.stringify({
      content: '网页正文',
      title: 'Example',
      truncated: true,
      url: 'https://example.com/',
    }),
    status: 'success',
    tool_call_id: 'call-example',
  });

  assert.deepEqual(presentation.result, {
    title: 'Example',
    truncated: true,
    url: 'https://example.com/',
  });
});

test('ToolMessage 的 JSON 无效时仅展示完成状态', () => {
  const presentation = projectToolResult('web_fetch', {
    content: '{invalid JSON',
    tool_call_id: 'call-invalid-json',
  });

  assert.deepEqual(presentation, {
    summary: '网页读取已完成',
    result: null,
  });
});

test('web_search 不向前端结果暴露额外字段', () => {
  const presentation = projectToolResult('web_search', {
    query: 'Example',
    providerDetails: { rawResponse: '内部响应内容' },
    results: [
      {
        title: 'Example',
        url: 'https://example.com/',
        content: '仅供模型使用的网页正文',
      },
    ],
  });

  assert.deepEqual(presentation, {
    summary: '找到 1 个相关网页',
    result: {
      query: 'Example',
      results: [{ title: 'Example', url: 'https://example.com/' }],
    },
  });
});
