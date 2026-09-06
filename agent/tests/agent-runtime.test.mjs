import assert from 'node:assert/strict';
import test from 'node:test';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, AIMessageChunk } from '@langchain/core/messages';
import { ChatGenerationChunk } from '@langchain/core/outputs';

import { loadSettings } from '../dist/config.js';
import { createAgentRuntime } from '../dist/runtime/agent.js';

// 显式传入测试配置，不读取 .env；真实 createAgent() 循环只连接下面的假模型。
const settings = loadSettings({
  MODEL_NAME: 'test-model',
  MODEL_API_KEY: 'test-key',
  QIANFAN_API_KEY: 'test-search-key',
  AGENT_RUN_TIMEOUT: '2s',
});
const input = {
  run_id: 'run-agent-test',
  thread_id: 'thread-test',
  model_id: 'default',
  messages: [{ role: 'user', content: '帮我查找相关网页' }],
};

/** 按预设顺序回答，但把 Tool 执行、消息回填和循环交给真实框架。 */
class OfflineModel extends BaseChatModel {
  calls = 0;

  /** 每一帧代表一次模型请求的回复。 */
  constructor(frames) {
    super({});
    this.frames = frames;
  }

  /** 给框架一个本地模型标识，不访问任何 Provider。 */
  _llmType() {
    return 'offline-agent-test';
  }

  /** 假模型已预设工具调用，不需要向远端传送 Tool Schema。 */
  bindTools() {
    return this;
  }

  /** 非流式假回复用于验证循环与 Tool 生命周期。 */
  async _generate(messages, options) {
    this.lastMessages = messages;
    this.signal = options.signal;
    const frame = this.frames[this.calls++];
    assert.ok(frame, 'Agent 不应发起额外的模型请求');
    if (frame instanceof Error) throw frame;
    const message = new AIMessage(frame);
    return { generations: [{ text: message.text, message }] };
  }
}

/** 模拟真正分片的模型输出，覆盖中途失败时保留已发送正文。 */
class StreamingOfflineModel extends OfflineModel {
  /** 每次请求对应一组 chunk，仍使用框架原生的流式回调。 */
  async *_streamResponseChunks(_messages, options, runManager) {
    this.signal = options.signal;
    const frame = this.frames[this.calls++];
    assert.ok(frame, 'Agent 不应发起额外的模型请求');
    for (const fields of frame) {
      if (fields instanceof Error) throw fields;
      const message = new AIMessageChunk(fields);
      const chunk = new ChatGenerationChunk({ message, text: message.text });
      yield chunk;
      await runManager?.handleLLMNewToken(
        message.text, undefined, undefined, undefined, undefined, { chunk },
      );
    }
  }
}

/** 收集对外事件，断言项目契约而不是框架内部节点形状。 */
async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

/** 每个测试都禁止意外联网，只有需要搜索的用例才替换为假响应。 */
test.beforeEach((t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('离线测试禁止真实网络请求');
  });
});

test('Agent 直接回答时按顺序输出正文事件，不产生工具事件', async () => {
  const model = new OfflineModel([{ content: '你好！' }]);
  const runtime = createAgentRuntime(settings, new Map([['default', model]]));
  const events = await collect(runtime.stream(input));

  assert.deepEqual(events, [
    { type: 'run.started', runId: input.run_id, payload: { modelId: 'default' } },
    { type: 'content.started', runId: input.run_id, payload: { format: 'markdown' } },
    { type: 'content.delta', runId: input.run_id, payload: { delta: '你好！' } },
    { type: 'content.completed', runId: input.run_id, payload: {
      content: '你好！', format: 'markdown', status: 'completed', error: null,
    } },
    { type: 'run.completed', runId: input.run_id, payload: {} },
  ]);
  assert.equal(model.calls, 1);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test('搜索调用开始和完成共用 ID，Middleware 重放历史不重复产生事件', async (t) => {
  const reference = { title: 'LangChain', url: 'https://docs.langchain.com/' };
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    references: [{ ...reference, providerDetails: '内部响应' }],
  }));
  const args = { query: 'LangChain', count: 1 };
  const model = new OfflineModel([
    { content: '先查一下。', tool_calls: [{ id: 'search-1', name: 'web_search', args }] },
    { content: '找到官方资料。' },
  ]);
  const runtime = createAgentRuntime(settings, new Map([['default', model]]));
  const events = await collect(runtime.stream(input));

  assert.deepEqual(events.filter((event) => event.type.startsWith('tool.')), [
    { type: 'tool.started', runId: input.run_id, payload: {
      toolCallId: 'search-1', name: 'web_search', displayName: '搜索网页', args,
    } },
    { type: 'tool.completed', runId: input.run_id, payload: {
      toolCallId: 'search-1', name: 'web_search', summary: '找到 1 个相关网页',
      result: { query: 'LangChain', results: [reference] },
    } },
  ]);
  assert.equal(events.at(-2).payload.content, '先查一下。找到官方资料。');
  assert.equal(events.at(-1).type, 'run.completed');
  assert.equal(JSON.stringify(events).includes('内部响应'), false);
  assert.equal(model.calls, 2);
  assert.equal(globalThis.fetch.mock.callCount(), 1);
});

test('搜索后读取网页，模型能看到正文但 Tool 展示结果不泄漏完整正文', async (t) => {
  // 数字 IP 的 lookup 不查询外部 DNS；HTTP 仍全部被 fetch mock 拦截。
  const url = 'https://93.184.216.34/';
  const pageContent = '只交给模型的网页正文';
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (target) => {
    requests.push(String(target));
    if (String(target) === url) {
      return new Response(`<title>示例网页</title><article>${pageContent}</article>`, {
        headers: { 'content-type': 'text/html' },
      });
    }
    assert.equal(String(target), 'https://qianfan.baidubce.com/v2/ai_search/web_search');
    return Response.json({ references: [{ title: '示例网页', url }] });
  });
  const model = new OfflineModel([
    { content: '', tool_calls: [{
      id: 'search-page', name: 'web_search', args: { query: '示例资料' },
    }] },
    { content: '', tool_calls: [{
      id: 'fetch-page', name: 'web_fetch', args: { url },
    }] },
    { content: '已经搜索并阅读网页。' },
  ]);
  const runtime = createAgentRuntime(settings, new Map([['default', model]]));
  const events = await collect(runtime.stream(input));

  assert.deepEqual(events.filter((event) => event.type.startsWith('tool.')).map(
    (event) => [event.type, event.payload.toolCallId],
  ), [
    ['tool.started', 'search-page'], ['tool.completed', 'search-page'],
    ['tool.started', 'fetch-page'], ['tool.completed', 'fetch-page'],
  ]);
  const fetched = events.find((event) => (
    event.type === 'tool.completed' && event.payload.name === 'web_fetch'
  ));
  assert.deepEqual(fetched.payload.result, { url, title: '示例网页', truncated: false });
  assert.ok(model.lastMessages.some((message) => (
    message.tool_call_id === 'fetch-page' && message.content.includes(pageContent)
  )));
  assert.equal(JSON.stringify(events).includes(pageContent), false);
  assert.equal(requests.length, 2);
  assert.equal(events.at(-1).type, 'run.completed');
});

test('工具执行失败可以由模型解释并恢复，不直接使整个 Run 失败', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('包含敏感信息的 Provider 异常');
  });
  const model = new OfflineModel([
    { content: '', tool_calls: [{
      id: 'search-error', name: 'web_search', args: { query: 'LangChain' },
    }] },
    { content: '搜索暂时不可用，无法确认最新结果。' },
  ]);
  const runtime = createAgentRuntime(settings, new Map([['default', model]]));
  const events = await collect(runtime.stream(input));
  const failedTools = events.filter((event) => event.type === 'tool.failed');

  assert.equal(failedTools.length, 1);
  assert.deepEqual(failedTools[0].payload, {
    toolCallId: 'search-error', name: 'web_search',
    error: { code: 'TOOL_EXECUTION_FAILED', message: '工具执行失败', retryable: false },
  });
  assert.equal(events.at(-1).type, 'run.completed');
  assert.equal(model.calls, 2);
  assert.equal(JSON.stringify(events).includes('敏感信息'), false);
});

test('工具参数校验失败也产生关联终态，模型可以继续回答', async () => {
  const model = new OfflineModel([
    { content: '', tool_calls: [{
      id: 'invalid-args', name: 'web_search', args: { query: '' },
    }] },
    { content: '搜索词不能为空，请补充要查询的主题。' },
  ]);
  const runtime = createAgentRuntime(settings, new Map([['default', model]]));
  const events = await collect(runtime.stream(input));

  assert.deepEqual(events.filter((event) => event.type.startsWith('tool.')).map(
    (event) => [event.type, event.payload.toolCallId],
  ), [['tool.started', 'invalid-args'], ['tool.failed', 'invalid-args']]);
  assert.equal(events.at(-1).type, 'run.completed');
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test('调用工具前的说明不算最终回答，最后空回复必须失败', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ references: [] }));
  const model = new OfflineModel([
    { content: '先查一下。', tool_calls: [{
      id: 'before-empty', name: 'web_search', args: { query: 'LangChain' },
    }] },
    { content: '' },
  ]);
  const runtime = createAgentRuntime(settings, new Map([['default', model]]));
  const events = await collect(runtime.stream(input));

  assert.equal(events.at(-2).payload.content, '先查一下。');
  assert.equal(events.at(-2).payload.status, 'failed');
  assert.equal(events.at(-1).type, 'run.failed');
  assert.equal(events.at(-1).payload.error.code, 'AGENT_INCOMPLETE_RESPONSE');
});

test('模型流式输出中途异常保留已有正文，不向前端暴露原始错误', async (t) => {
  t.mock.method(console, 'error', () => {});
  const model = new StreamingOfflineModel([[
    { content: '部分' }, { content: '正文' }, new Error('模型内部敏感错误'),
  ]]);
  const runtime = createAgentRuntime(settings, new Map([['default', model]]));
  const events = await collect(runtime.stream(input));

  assert.deepEqual(events.filter((event) => event.type === 'content.delta').map(
    (event) => event.payload.delta,
  ), ['部分', '正文']);
  assert.equal(events.at(-2).payload.content, '部分正文');
  assert.equal(events.at(-2).payload.status, 'failed');
  assert.equal(events.at(-1).payload.error.code, 'AGENT_EXECUTION_FAILED');
  assert.equal(JSON.stringify(events).includes('敏感错误'), false);
});

test('Run 超时中止正在执行的搜索，并关闭未完成工具和正文', { timeout: 3000 }, async (t) => {
  t.mock.method(console, 'error', () => {});
  let requestSignal;
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
    requestSignal = signal;
    await new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  const model = new OfflineModel([{ content: '', tool_calls: [{
    id: 'pending-search', name: 'web_search', args: { query: 'LangChain' },
  }] }]);
  const runtime = createAgentRuntime(
    { ...settings, runTimeoutMs: 400 }, new Map([['default', model]]),
  );
  const events = await collect(runtime.stream(input));

  assert.equal(requestSignal.aborted, true);
  assert.equal(model.calls, 1);
  assert.deepEqual(events.filter((event) => event.type.startsWith('tool.')).map(
    (event) => [event.type, event.payload.toolCallId],
  ), [['tool.started', 'pending-search'], ['tool.failed', 'pending-search']]);
  assert.equal(events.at(-2).payload.status, 'failed');
  assert.equal(events.at(-1).payload.error.code, 'AGENT_RUN_TIMEOUT');
});

test('四次连续工具调用后的第五次模型回答不会提前触发图执行上限', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ references: [] }));
  const frames = Array.from({ length: 4 }, (_, index) => ({
    content: '',
    tool_calls: [{
      id: `search-${index}`, name: 'web_search', args: { query: `资料 ${index}` },
    }],
  }));
  const model = new OfflineModel([...frames, { content: '已完成四次搜索。' }]);
  const runtime = createAgentRuntime(settings, new Map([['default', model]]));
  const events = await collect(runtime.stream(input));

  assert.equal(model.calls, 5);
  assert.equal(globalThis.fetch.mock.callCount(), 4);
  assert.equal(events.filter((event) => event.type === 'tool.started').length, 4);
  assert.equal(events.filter((event) => event.type === 'tool.completed').length, 4);
  assert.equal(events.at(-1).type, 'run.completed');
});

test('Agent 不可用模型只输出失败事件，不继续启动工作流', async () => {
  const runtime = createAgentRuntime(settings, new Map());
  const events = await collect(runtime.stream(input));

  assert.deepEqual(events, [{
    type: 'run.failed', runId: input.run_id, payload: { error: {
      code: 'MODEL_NOT_AVAILABLE', message: '所选模型不可用', retryable: false,
    } },
  }]);
});

test('五个并行工具中超限的一项仍有唯一失败终态，模型可以继续回答', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ references: [] }));
  const calls = Array.from({ length: 5 }, (_, index) => ({
    id: `parallel-${index}`, name: 'web_search', args: { query: `资料 ${index}` },
  }));
  const model = new OfflineModel([
    { content: '', tool_calls: calls },
    { content: '已完成允许范围内的搜索。' },
  ]);
  const runtime = createAgentRuntime(settings, new Map([['default', model]]));
  const events = await collect(runtime.stream(input));
  const started = events.filter((event) => event.type === 'tool.started');
  const completed = events.filter((event) => event.type === 'tool.completed');
  const failed = events.filter((event) => event.type === 'tool.failed');

  assert.equal(globalThis.fetch.mock.callCount(), 4);
  assert.equal(started.length, 5);
  assert.equal(completed.length, 4);
  assert.equal(failed.length, 1);
  for (const call of calls) {
    assert.equal(started.filter((event) => event.payload.toolCallId === call.id).length, 1);
    assert.equal([...completed, ...failed].filter(
      (event) => event.payload.toolCallId === call.id,
    ).length, 1);
  }
  assert.equal(model.calls, 2);
  assert.equal(events.at(-1).type, 'run.completed');
});

test('第五次连续工具被全部阻止时，没有最终回答就应结束为失败', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ references: [] }));
  const frames = Array.from({ length: 5 }, (_, index) => ({
    content: index === 0 ? '先查一下。' : '',
    tool_calls: [{
      id: `limited-${index}`, name: 'web_search', args: { query: `资料 ${index}` },
    }],
  }));
  const model = new OfflineModel(frames);
  const runtime = createAgentRuntime(settings, new Map([['default', model]]));
  const events = await collect(runtime.stream(input));

  assert.equal(globalThis.fetch.mock.callCount(), 4);
  assert.equal(model.calls, 5);
  assert.equal(events.filter((event) => event.type === 'tool.started').length, 5);
  assert.equal(events.filter((event) => event.type === 'tool.completed').length, 4);
  const failed = events.filter((event) => event.type === 'tool.failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].payload.toolCallId, 'limited-4');
  assert.equal(events.at(-2).payload.content, '先查一下。');
  assert.equal(events.at(-2).payload.status, 'failed');
  assert.equal(events.at(-1).type, 'run.failed');
  assert.equal(events.at(-1).payload.error.code, 'AGENT_INCOMPLETE_RESPONSE');
});
