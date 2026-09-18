import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage } from '@langchain/core/messages';
import { loadSettings } from '../dist/config.js';
import { createAgentRuntime } from '../dist/runtime/agent.js';
import { openRecordStore } from '../dist/recording/store.js';

// 固定模型帧驱动真实框架和现有工具，只替换 HTTP；不读取 .env 或调用外部服务。
class OfflineModel extends BaseChatModel {
  constructor(frames) { super({}); this.frames = [...frames]; }
  _llmType() { return 'offline-tool-recording'; }
  bindTools() { return this; }
  async _generate() {
    const frame = this.frames.shift();
    assert.ok(frame, '不应有额外模型请求');
    const message = new AIMessage(frame);
    return { generations: [{ text: message.text, message }] };
  }
}
const cacheRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../.cache');
mkdirSync(cacheRoot, { recursive: true });
const directory = mkdtempSync(join(cacheRoot, 'tool-recording-'));
const settings = loadSettings({
  MODEL_NAME: 'offline-model', MODEL_API_KEY: 'offline-secret-key',
  QIANFAN_API_KEY: 'offline-search-key', AGENT_RECORDING_ENABLED: 'true',
  AGENT_RECORDING_DIR: directory, AGENT_RUN_TIMEOUT: '2s',
});
const originalFetch = globalThis.fetch;
const searchURL = 'https://qianfan.baidubce.com/v2/ai_search/web_search';
const pageURL = 'https://93.184.216.34/';
let requests = [];
let respond;
globalThis.fetch = async (url, options) => {
  assert.ok([searchURL, pageURL].includes(String(url)), '禁止意外外部请求');
  requests.push({ url: String(url), body: options.body ? JSON.parse(options.body) : undefined });
  return respond(String(url), options);
};
const searchResult = () => Response.json({ references: [{ title: '资料', url: pageURL }] });
const finalFrame = { content: '最终答复' };
const toolCall = (id, name, args) => ({ id, name, args, type: 'tool_call' });
const toolFrame = (...calls) => ({ content: '', tool_calls: calls });
function read(id) {
  const store = openRecordStore(settings.recordingPath);
  try { return store.getRun(id); } finally { store.close(); }
}
async function run(id, frames, options = {}) {
  const runtime = createAgentRuntime({ ...settings, ...options.settings }, new Map([['default', new OfflineModel(frames)]]));
  const events = [];
  for await (const event of runtime.stream({
    run_id: id, user_id: options.user ?? 'test-user', thread_id: 'test-thread',
    model_id: 'default', messages: [{ role: 'user', content: '工具验证' }],
  }, options.signal)) {
    events.push(event);
    if (options.stopAtTool && event.type === 'tool.started') break;
  }
  return events;
}
function tools(id) { return read(id).steps.filter((step) => step.kind === 'tool'); }

try {
  respond = async (url) => url === searchURL ? searchResult()
    : new Response('<article>完整网页正文 offline-secret-key</article>', { headers: { 'content-type': 'text/html' } });
  const frames = [
    toolFrame(toolCall('s1', 'web_search', { query: '  资料  ' })),
    toolFrame(toolCall('f1', 'web_fetch', { url: pageURL })), finalFrame,
  ];
  const events = await run('success', frames);
  assert.equal(events.at(-1).type, 'run.completed');
  const withoutRecording = await run('success', frames, { settings: { recordingEnabled: false } });
  assert.deepEqual(events, withoutRecording, '记录不能改变现有业务事件');
  const saved = tools('success');
  assert.deepEqual(saved.map((step) => step.name), ['web_search', 'web_fetch']);
  assert.deepEqual(saved.map((step) => step.status), ['completed', 'completed']);
  assert.deepEqual(saved[0].input.requestedArgs, { query: '  资料  ' });
  assert.deepEqual(saved[0].metadata.executionArgs, { query: '资料', count: 5 });
  assert.equal(requests[0].body.resource_type_filter[0].top_k, saved[0].metadata.executionArgs.count);
  assert.ok(saved[1].metadata.executionArgs.maxCharacters > 0);
  assert.ok(saved.every((step) => step.metadata.executionStarted && step.metadata.executionStartedAt >= step.started_at));
  assert.ok(saved.every((step) => step.ended_at >= step.metadata.executionStartedAt));
  assert.ok(saved[1].output.content.includes('完整网页正文'));
  assert.equal(JSON.stringify(saved).includes('offline-secret-key'), false);
  assert.equal(JSON.stringify(events.filter((e) => e.type === 'tool.completed')).includes('完整网页正文'), false);
  const modelSteps = read('success').steps.filter((step) => step.kind === 'model');
  assert.equal(modelSteps.length, 3);
  assert.ok(JSON.stringify(modelSteps[2].input).includes('完整网页正文'), '模型下一轮应收到实际工具内容');
  assert.equal(saved[0].metadata.modelStepId, modelSteps[0].step_id);

  // 同名并行调用按 ID 分开；混合成功、执行失败、未执行不混算成功率。
  requests = [];
  respond = async (_url, options) => JSON.parse(options.body).messages[0].content === '失败'
    ? new Response('offline-secret-key', { status: 503 }) : searchResult();
  await run('mixed', [toolFrame(
    toolCall('same-1', 'web_search', { query: '成功' }),
    toolCall('same-2', 'web_search', { query: '失败' }),
    toolCall('same-3', 'web_search', { query: '' }),
  ), finalFrame]);
  assert.equal(read('mixed').status, 'completed', '工具失败后模型可以恢复');
  const mixed = tools('mixed');
  assert.deepEqual(mixed.map((step) => step.status), ['completed', 'failed', 'skipped']);
  assert.equal(mixed[1].metadata.executionStarted, true);
  assert.ok(mixed[1].error.message.includes('503'));
  assert.equal(mixed[2].metadata.executionStarted, false);
  assert.equal(mixed[2].metadata.executionArgs, undefined);
  assert.ok(mixed[2].output.content.length > 0);
  assert.equal(requests.length, 2);
  const successes = mixed.filter((step) => step.status === 'completed').length;
  const failures = mixed.filter((step) => step.status === 'failed').length;
  assert.equal(successes / (successes + failures), 0.5);

  requests = [];
  respond = async () => searchResult();
  await run('limit', [toolFrame(...Array.from({ length: 5 }, (_, i) =>
    toolCall(`limit-${i}`, 'web_search', { query: `查询${i}` }))), finalFrame]);
  const limited = tools('limit');
  assert.equal(limited.length, 5);
  assert.equal(limited.filter((step) => step.status === 'completed').length, 4);
  assert.equal(limited.filter((step) => step.status === 'skipped' && !step.metadata.executionStarted).length, 1);
  assert.equal(requests.length, 4);

  requests = [];
  await run('unknown', [toolFrame(toolCall('unknown-1', 'unknown_tool', {})), finalFrame]);
  assert.equal(tools('unknown')[0].status, 'skipped');
  assert.equal(requests.length, 0);

  await run('invalid-json', [{ content: '', invalid_tool_calls: [{
    id: 'invalid-json-1', name: 'web_search', args: '{', error: 'invalid JSON', type: 'invalid_tool_call',
  }] }]);
  assert.equal(tools('invalid-json')[0].status, 'skipped');
  assert.equal(tools('invalid-json')[0].input.requestedArgs, '{');
  assert.equal(tools('invalid-json')[0].error.code, 'TOOL_INVALID_CALL');
  assert.equal(requests.length, 0);

  // HTTP 挂起期间取消/超时，工具标为中止，不能计入执行失败分母。
  for (const mode of ['cancel', 'timeout', 'break']) {
    const controller = new AbortController();
    respond = async (_url, options) => {
      if (mode === 'cancel') queueMicrotask(() => controller.abort());
      return new Promise((_resolve, reject) => {
        if (options.signal.aborted) reject(options.signal.reason);
        else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    };
    await run(mode, [toolFrame(toolCall(`${mode}-1`, 'web_search', { query: '等待' })), finalFrame], {
      signal: controller.signal, stopAtTool: mode === 'break',
      settings: { runTimeoutMs: 150 },
    });
    const step = tools(mode)[0];
    assert.equal(read(mode).status, mode === 'timeout' ? 'failed' : 'cancelled');
    assert.equal(step.status, step.metadata.executionStarted ? 'cancelled' : 'skipped');
  }

  respond = async () => searchResult();
  await Promise.all(['A', 'B'].map((user) => run(`user-${user}`, [
    toolFrame(toolCall('identical-id', 'web_search', { query: user })), finalFrame,
  ], { user })));
  for (const user of ['A', 'B']) {
    assert.equal(read(`user-${user}`).user_id, user);
    assert.equal(tools(`user-${user}`)[0].metadata.executionArgs.query, user);
  }

  const brokenPath = join(directory, 'broken.sqlite');
  respond = async () => {
    const db = new DatabaseSync(brokenPath);
    try { db.exec('DROP TABLE steps'); } finally { db.close(); }
    return searchResult();
  };
  const broken = await run('broken', [toolFrame(toolCall('broken-1', 'web_search', { query: '资料' })), finalFrame], {
    settings: { recordingPath: brokenPath },
  });
  assert.equal(broken.at(-1).type, 'run.completed');
  console.log('工具记录验证通过：原始/执行参数、完整结果、多轮/同名并行、失败恢复、校验/额度/未知工具未执行、取消/超时/提前退出、跨用户隔离、脱敏及记录故障隔离。');
} finally {
  globalThis.fetch = originalFetch;
  if (!resolve(directory).startsWith(cacheRoot + sep)) throw new Error('拒绝清理缓存目录之外的路径');
  rmSync(directory, { recursive: true, force: true });
}
