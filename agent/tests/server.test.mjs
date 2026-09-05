import assert from 'node:assert/strict';
import test from 'node:test';

import { loadSettings, toPublicModel } from '../dist/config.js';
import { createApp } from '../dist/server.js';

const settings = loadSettings({ MODEL_NAME: 'test-model', MODEL_API_KEY: 'test-key' });
const input = {
  run_id: 'run-test',
  thread_id: 'thread-test',
  model_id: 'default',
  messages: [{ role: 'user', content: 'hello' }],
};

// Fastify inject() 在进程内模拟 HTTP 请求，不监听端口或访问外部服务。
test('HTTP 路由、请求校验和 SSE 事件格式保持原协议', async (t) => {
  const events = [
    { type: 'run.started', runId: input.run_id, payload: { modelId: 'default' } },
    { type: 'content.delta', runId: input.run_id, payload: { delta: '正文\n第二行' } },
    { type: 'run.completed', runId: input.run_id, payload: {} },
  ];
  let calls = 0;
  const runtime = {
    defaultModelId: 'default',
    models: settings.models.map(toPublicModel),
    async *stream(parsed) {
      calls += 1;
      assert.deepEqual(parsed, input);
      yield* events;
    },
  };
  const app = createApp(settings, runtime);
  t.after(() => app.close());

  const health = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(health.statusCode, 200);
  assert.deepEqual(health.json(), { status: 'ok' });
  const models = await app.inject({ method: 'GET', url: '/models' });
  assert.deepEqual(models.json(), { default_model_id: 'default', models: runtime.models });
  assert.equal(models.body.includes('test-key'), false);

  for (const messages of [[], [{ role: 'assistant', content: 'hello' }]]) {
    const invalid = await app.inject({
      method: 'POST', url: '/runs', payload: { ...input, messages },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().error.code, 'INVALID_RUN_INPUT');
    assert.equal(invalid.json().error.message, 'Agent Run 请求参数不合法');
    assert.ok(invalid.json().error.issues.length > 0);
  }
  assert.equal(calls, 0);

  const response = await app.inject({ method: 'POST', url: '/runs', payload: input });
  assert.equal(calls, 1);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.equal(response.headers['cache-control'], 'no-cache, no-transform');
  assert.equal(response.headers['x-accel-buffering'], 'no');
  assert.equal(response.body, events.map((event) =>
    `event: ${event.type}\ndata: ${JSON.stringify({ runId: event.runId, payload: event.payload })}\n\n`,
  ).join(''));
});

test('SSE 已开始后 Runtime 异常转换为 run.failed', async (t) => {
  t.mock.method(console, 'error', () => {});
  const started = { type: 'run.started', runId: input.run_id, payload: {} };
  const app = createApp(settings, {
    defaultModelId: 'default', models: [],
    async *stream() {
      yield started;
      throw new Error('fake internal error');
    },
  });
  t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/runs', payload: input });

  assert.equal(response.statusCode, 200);
  const frames = response.body.trim().split('\n\n');
  assert.equal(frames.length, 2);
  assert.equal(frames[1].split('\n')[0], 'event: run.failed');
  assert.deepEqual(JSON.parse(frames[1].split('\ndata: ')[1]), {
    runId: input.run_id,
    payload: { error: {
      code: 'AGENT_SERVICE_ERROR', message: 'Agent 服务执行失败', retryable: true,
    } },
  });
  assert.equal(response.body.includes('fake internal error'), false);
});
