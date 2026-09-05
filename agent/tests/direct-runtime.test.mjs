import assert from 'node:assert/strict';
import test from 'node:test';

import { loadSettings } from '../dist/config.js';
import { createDirectRuntime } from '../dist/runtime/direct.js';

// 注入假客户端，只验证 Runtime 行为，不读取 .env 或发起模型请求。
const settings = loadSettings({ MODEL_NAME: 'test-model', MODEL_API_KEY: 'test-key' });
const input = {
  run_id: 'run-test',
  thread_id: 'thread-test',
  model_id: 'default',
  messages: [{ role: 'user', content: '你好' }],
};

async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

test('Direct 保持基础 Prompt、正文增量与完成事件的顺序', async () => {
  const model = {
    async *stream(messages, { signal }) {
      assert.deepEqual(messages, [
        { role: 'system', content: settings.systemPrompt },
        ...input.messages,
      ]);
      assert.equal(signal.aborted, false);
      yield { content: '你好' };
      yield { content: [
        { type: 'reasoning', text: '不能发给前端' },
        { type: 'text', text: '！' },
      ] };
    },
  };
  const runtime = createDirectRuntime(settings, new Map([['default', model]]));
  const events = await collect(runtime.stream(input));

  assert.deepEqual(events, [
    { type: 'run.started', runId: input.run_id, payload: { modelId: 'default' } },
    { type: 'content.started', runId: input.run_id, payload: { format: 'markdown' } },
    { type: 'content.delta', runId: input.run_id, payload: { delta: '你好' } },
    { type: 'content.delta', runId: input.run_id, payload: { delta: '！' } },
    { type: 'content.completed', runId: input.run_id, payload: {
      content: '你好！', format: 'markdown', status: 'completed', error: null,
    } },
    { type: 'run.completed', runId: input.run_id, payload: {} },
  ]);
});

test('不可用模型只产生 run.failed，不伪造已开始事件', async () => {
  const runtime = createDirectRuntime(settings, new Map());
  assert.deepEqual(await collect(runtime.stream(input)), [{
    type: 'run.failed',
    runId: input.run_id,
    payload: { error: {
      code: 'MODEL_NOT_AVAILABLE', message: '所选模型不可用', retryable: false,
    } },
  }]);
});

test('空回复保留失败终态，不变成成功完成', async () => {
  const model = { async *stream() { yield { content: '  ' }; } };
  const runtime = createDirectRuntime(settings, new Map([['default', model]]));
  const events = await collect(runtime.stream(input));

  assert.equal(events.at(-2).type, 'content.completed');
  assert.equal(events.at(-2).payload.status, 'failed');
  assert.equal(events.at(-2).payload.content, '  ');
  assert.equal(events.at(-1).type, 'run.failed');
  assert.equal(events.at(-1).payload.error.code, 'AGENT_EMPTY_RESPONSE');
  assert.equal(events.at(-1).payload.error.retryable, false);
});

test('模型中途失败时保留已有正文，并输出安全的错误对象', async (t) => {
  t.mock.method(console, 'error', () => {});
  const model = {
    async *stream() {
      yield { content: '部分正文' };
      throw new Error('fake provider error');
    },
  };
  const runtime = createDirectRuntime(settings, new Map([['default', model]]));
  const events = await collect(runtime.stream(input));
  const error = { code: 'MODEL_REQUEST_FAILED', message: '模型调用失败', retryable: true };

  assert.deepEqual(events.at(-2).payload, {
    content: '部分正文', format: 'markdown', status: 'failed', error,
  });
  assert.deepEqual(events.at(-1), {
    type: 'run.failed', runId: input.run_id, payload: { error },
  });
});

test('超时取消模型请求，保留现有超时错误语义', { timeout: 2000 }, async (t) => {
  t.mock.method(console, 'error', () => {});
  let requestSignal;
  const model = {
    async stream(_messages, { signal }) {
      requestSignal = signal;
      await new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  };
  const runtime = createDirectRuntime(
    { ...settings, runTimeoutMs: 5 },
    new Map([['default', model]]),
  );
  const events = await collect(runtime.stream(input));

  assert.equal(requestSignal.aborted, true);
  assert.deepEqual(events.at(-1).payload.error, {
    code: 'MODEL_REQUEST_FAILED', message: '模型调用超时', retryable: true,
  });
});

test('共享 Runtime 的并发请求不共享正文或取消信号', async () => {
  const signals = [];
  const model = {
    async *stream(messages, { signal }) {
      signals.push(signal);
      const text = messages.at(-1).content;
      yield { content: text };
      await Promise.resolve();
      yield { content: '完成' };
    },
  };
  const runtime = createDirectRuntime(settings, new Map([['default', model]]));
  const results = await Promise.all(['甲', '乙'].map((text) => collect(runtime.stream({
    ...input, run_id: text, messages: [{ role: 'user', content: text }],
  }))));

  assert.notEqual(signals[0], signals[1]);
  for (const [index, text] of ['甲', '乙'].entries()) {
    assert.equal(results[index].at(-2).payload.content, `${text}完成`);
    assert.ok(results[index].every((event) => event.runId === text));
  }
});
