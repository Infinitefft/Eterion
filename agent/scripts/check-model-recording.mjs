import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, AIMessageChunk } from '@langchain/core/messages';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import { loadSettings } from '../dist/config.js';
import { runInputSchema } from '../dist/protocol.js';
import { createAgentRuntime } from '../dist/runtime/agent.js';
import { createDirectRuntime } from '../dist/runtime/direct.js';
import { openRecordStore } from '../dist/recording/store.js';

// 显式假配置和本地模型，既不读取 .env，也不调用真实模型或工具。
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('离线验证禁止网络请求'); };
const cacheRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../.cache');
mkdirSync(cacheRoot, { recursive: true });
const directory = mkdtempSync(join(cacheRoot, 'model-recording-'));
const settings = loadSettings({
  MODEL_NAME: 'offline-model', MODEL_API_KEY: 'fake-model-secret',
  QIANFAN_API_KEY: 'fake-search-secret', SYSTEM_PROMPT: '离线验证提示词',
  AGENT_RECORDING_ENABLED: 'true', AGENT_RECORDING_DIR: directory,
  AGENT_RUN_TIMEOUT: '2s',
});
const baseInput = {
  run_id: 'success', user_id: 'user-1', thread_id: 'thread-1', model_id: 'default',
  messages: [
    { role: 'user', content: '上一个问题' },
    { role: 'assistant', content: '上一个回答' },
    { role: 'user', content: '本次问题' },
  ],
};

class OfflineModel extends BaseChatModel {
  constructor(mode = 'success', duringStream) {
    super({});
    this.mode = mode;
    this.duringStream = duringStream;
  }
  _llmType() { return 'offline-recording'; }
  bindTools() { return this; }
  invocationParams() {
    return { model: 'offline-model', temperature: 0, apiKey: 'must-not-save' };
  }
  async _generate() {
    const message = new AIMessage('离线回复');
    return { generations: [{ text: message.text, message }] };
  }
  async *_streamResponseChunks(messages, options, runManager) {
    const text = String(messages.at(-1).content) + '：离线回复';
    const chunk = new ChatGenerationChunk({
      text,
      message: new AIMessageChunk({
        content: text,
        additional_kwargs: { reasoning_content: '接口公开的模拟推理', api_key: 'fake-model-secret' },
        usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      }),
    });
    // 与 Provider SDK 一样触发框架回调；数据库只在开始和结束写入。
    await runManager?.handleLLMNewToken(text, undefined, undefined, undefined, undefined, { chunk });
    yield chunk;
    this.duringStream?.();
    if (this.mode === 'failure') throw new Error('模拟失败 fake-model-secret');
    if (this.mode === 'wait') {
      await new Promise((resolveWait) => {
        if (options.signal.aborted) resolveWait();
        else options.signal.addEventListener('abort', resolveWait, { once: true });
      });
      options.signal.throwIfAborted();
    }
  }
}

async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}
function runtime(factory, config = settings, model = new OfflineModel()) {
  return factory(config, new Map([['default', model]]));
}
function read(runId) {
  const store = openRecordStore(settings.recordingPath);
  try { return store.getRun(runId); } finally { store.close(); }
}

try {
  assert.equal(runInputSchema.parse(baseInput).user_id, 'user-1');
  assert.equal(runInputSchema.parse({ ...baseInput, user_id: undefined }).user_id, undefined);
  assert.equal(runInputSchema.safeParse({ ...baseInput, user_id: ' ' }).success, false);
  for (const [name, factory] of [['agent', createAgentRuntime], ['direct', createDirectRuntime]]) {
    const input = { ...baseInput, run_id: `${name}-success` };
    const events = await collect(runtime(factory).stream(input));
    const withoutRecording = await collect(runtime(factory, { ...settings, recordingEnabled: false }).stream(input));
    assert.deepEqual(events, withoutRecording, '开启记录不能改变业务事件');
    assert.equal(events.at(-1).type, 'run.completed');
    const saved = read(input.run_id);
    assert.equal(saved.user_id, input.user_id);
    assert.equal(saved.question, '本次问题');
    assert.deepEqual(saved.input.messages, input.messages);
    assert.equal(saved.output, events.at(-2).payload.content);
    assert.equal(saved.status, 'completed');
    assert.equal(saved.steps.length, 1);
    const step = saved.steps[0];
    assert.equal(step.kind, 'model');
    assert.equal(step.status, 'completed');
    assert.equal(step.input.messageBatches[0][0].type, 'system');
    assert.ok(JSON.stringify(step.input.messageBatches[0][0].content).includes(settings.systemPrompt));
    assert.ok(JSON.stringify(step.input.messageBatches[0].at(-1).content).includes('本次问题'));
    assert.equal(step.input.parameters.temperature, 0);
    const message = step.output.generations[0][0].message;
    assert.equal(message.additional_kwargs.reasoning_content, '接口公开的模拟推理');
    assert.equal(message.usage_metadata.total_tokens, 15);
    assert.equal(JSON.stringify(saved).includes('fake-model-secret'), false);
    assert.equal(JSON.stringify(saved).includes('must-not-save'), false);
    assert.ok(step.ended_at >= step.started_at);

    const failedId = `${name}-failed`;
    const failed = await collect(runtime(factory, settings, new OfflineModel('failure')).stream({ ...input, run_id: failedId }));
    assert.equal(failed.at(-1).type, 'run.failed');
    const savedFailure = read(failedId);
    assert.equal(savedFailure.status, 'failed');
    assert.equal(savedFailure.output, '本次问题：离线回复');
    assert.equal(savedFailure.steps[0].status, 'failed');
    assert.equal(savedFailure.steps[0].output.partial, true);
    assert.ok(savedFailure.steps[0].output.text.includes('离线回复'));
    assert.equal(JSON.stringify(savedFailure).includes('fake-model-secret'), false);

    const controller = new AbortController();
    const cancelId = `${name}-cancelled`;
    const cancelEvents = [];
    for await (const event of runtime(factory, settings, new OfflineModel('wait')).stream({ ...input, run_id: cancelId }, controller.signal)) {
      cancelEvents.push(event);
      if (event.type === 'content.delta') controller.abort();
    }
    assert.equal(cancelEvents.at(-1).type, 'run.failed');
    assert.equal(read(cancelId).status, 'cancelled');
    assert.equal(read(cancelId).steps[0].status, 'cancelled');

    const breakId = `${name}-break`;
    for await (const event of runtime(factory, settings, new OfflineModel('wait')).stream({ ...input, run_id: breakId })) {
      if (event.type === 'content.delta') break;
    }
    assert.equal(read(breakId).status, 'cancelled');
    assert.ok(read(breakId).output.includes('离线回复'));
    assert.equal(read(breakId).steps[0].status, 'cancelled');

    const timeoutId = `${name}-timeout`;
    const timeoutEvents = await collect(runtime(factory, { ...settings, runTimeoutMs: 100 }, new OfflineModel('wait')).stream({ ...input, run_id: timeoutId }));
    assert.equal(timeoutEvents.at(-1).type, 'run.failed');
    assert.equal(read(timeoutId).status, 'failed');
    assert.equal(read(timeoutId).steps[0].status, 'failed');
  }

  // 同一 Runtime 并发运行也不能交叉用户、上下文或回复。
  const shared = runtime(createAgentRuntime);
  await Promise.all(['A', 'B'].map((user) => collect(shared.stream({
    ...baseInput, run_id: `parallel-${user}`, user_id: user,
    messages: [{ role: 'user', content: `问题-${user}` }],
  }))));
  for (const user of ['A', 'B']) {
    assert.equal(read(`parallel-${user}`).user_id, user);
    assert.equal(read(`parallel-${user}`).output, `问题-${user}：离线回复`);
  }

  const skippedPath = join(directory, 'must-not-exist', 'records.sqlite');
  const skippedSettings = { ...settings, recordingPath: skippedPath };
  await collect(runtime(createAgentRuntime, { ...skippedSettings, recordingEnabled: false }).stream(baseInput));
  await collect(runtime(createAgentRuntime, skippedSettings).stream({ ...baseInput, user_id: undefined }));
  assert.equal(existsSync(dirname(skippedPath)), false);

  const blocker = join(directory, 'not-a-directory');
  writeFileSync(blocker, 'blocked');
  const unavailable = await collect(runtime(createAgentRuntime, { ...settings, recordingPath: join(blocker, 'records.sqlite') }).stream(baseInput));
  assert.equal(unavailable.at(-1).type, 'run.completed');

  // 模拟已开始记录后发生真实 SQLite 写入失败；业务回复仍应完成。
  const brokenPath = join(directory, 'write-failure.sqlite');
  const damageModel = new OfflineModel('success', () => {
    const db = new DatabaseSync(brokenPath);
    try { db.exec('DROP TABLE steps'); } finally { db.close(); }
  });
  const writeFailed = await collect(runtime(createDirectRuntime, { ...settings, recordingPath: brokenPath }, damageModel).stream(baseInput));
  assert.equal(writeFailed.at(-1).type, 'run.completed');
  console.log('模型记录验证通过：Agent/Direct、上下文、公开推理与用量、失败/取消/提前退出/超时、并发归属、开关、缺失用户、初始化和写入失败隔离。');
} finally {
  globalThis.fetch = originalFetch;
  const cleanupPath = resolve(directory);
  if (!cleanupPath.startsWith(cacheRoot + '/') && !cleanupPath.startsWith(cacheRoot + '\\')) {
    throw new Error('拒绝清理验证目录之外的路径');
  }
  rmSync(cleanupPath, { recursive: true, force: true });
}
