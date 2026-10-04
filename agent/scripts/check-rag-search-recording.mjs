import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage } from '@langchain/core/messages';
import { loadSettings } from '../dist/config.js';
import { createAgentRuntime } from '../dist/runtime/agent-runtime.js';
import { openRecordStore } from '../dist/recording/store.js';

class OfflineModel extends BaseChatModel {
  constructor(frames) { super({}); this.frames = [...frames]; }
  _llmType() { return 'offline-rag'; }
  bindTools() { return this; }
  async _generate(messages) {
    if (failure === 'filtered' || failure === 'rerank') {
      assert.ok(!JSON.stringify(messages).includes('完整资料正文'), '被过滤或重排失败的正文不能进入模型');
    }
    const frame = this.frames.shift();
    assert.ok(frame, '不应调用真实模型');
    const message = new AIMessage(frame);
    return { generations: [{ text: message.text, message }] };
  }
}
const cache = resolve('.cache'); mkdirSync(cache, { recursive: true });
const directory = mkdtempSync(join(cache, 'rag-search-recording-'));
const original = { fetch: globalThis.fetch, query: Pool.prototype.query, end: Pool.prototype.end };
const userId = randomUUID(), fileId = randomUUID(), baseId = randomUUID(), chunkId = randomUUID(), sectionId = randomUUID();
const settings = loadSettings({ MODEL_NAME: 'offline', MODEL_API_KEY: 'fixture-model-secret', BOCHA_API_KEY: 'fixture-bocha-secret',
  EMBEDDING_API_KEY: 'fixture-embedding-secret', EMBEDDING_BASE_URL: 'https://fixture.invalid/api/v1',
  RERANK_API_KEY: 'fixture-rerank-secret', RERANK_URL: 'https://fixture.invalid/reranks',
  DATABASE_URL: 'postgresql://fixture:password@localhost/unused', AGENT_RECORDING_ENABLED: 'true',
  AGENT_RECORDING_DIR: directory, AGENT_RUN_TIMEOUT: '2s' });
let failure = '';
globalThis.fetch = async (url, options) => {
  assert.match(String(url), /^https:\/\/fixture\.invalid\//);
  const body = JSON.parse(options.body);
  if (body.model === 'qwen3-rerank') {
    assert.notEqual(failure, 'empty', '零候选不能调用重排');
    if (failure === 'rerank') throw new Error('offline rerank failure');
    return Response.json({ results: [{ index: 0, relevance_score: failure === 'filtered' ? 0.1 : 0.9 }] });
  }
  if (failure === 'embedding' && body.input.texts[0] === '失败') throw new Error('offline embedding failure');
  return Response.json({ output: { embeddings: [{ text_index: 0, embedding: Array(1024).fill(0.25) }] } });
};
Pool.prototype.query = async function (sql) {
  if (!String(sql).includes('FROM rag_chunks')) throw new Error('unexpected database query');
  assert.match(String(sql), /LIMIT 20/);
  if (failure === 'vector') throw Object.assign(new Error('offline vector failure'), { code: '08006' });
  if (failure === 'empty') return { rows: [] };
  return { rows: [{ chunkId, fileId, knowledgeBaseId: baseId, fileName: '样例.md', sectionId,
    chunkIndex: 0, content: '完整资料正文', headingPath: ['标题'], startOffset: 3,
    endOffset: 9, cosineDistance: 0.12 }] };
};
Pool.prototype.end = async function () {};
const call = (id, query) => ({ id, name: 'knowledge_search', args: { query }, type: 'tool_call' });
async function run(id, calls) {
  const frames = [{ content: '', tool_calls: calls }, { content: '最终回答' }];
  const runtime = createAgentRuntime(settings, new Map([['default', new OfflineModel(frames)]]));
  const events = [];
  try {
    for await (const event of runtime.stream({ run_id: id, user_id: userId, thread_id: 'offline',
      model_id: 'default', messages: [{ role: 'user', content: '检索资料' }] })) events.push(event);
  } finally { await runtime.close?.(); }
  const store = openRecordStore(settings.recordingPath);
  try { return { events, steps: store.getRun(id).steps.filter((step) => step.kind === 'tool') }; }
  finally { store.close(); }
}
try {
  const success = await run('two-calls', [call('first', '问题一'), call('second', '问题二')]);
  assert.equal(success.events.at(-1).type, 'run.completed');
  assert.equal(success.steps.length, 2);
  for (const step of success.steps) {
    assert.equal(step.status, 'completed');
    assert.deepEqual(step.metadata.ragStages.map((stage) => stage.name), ['query_embedding', 'vector_search', 'rerank', 'filter']);
    assert.ok(step.metadata.ragStages.every((stage) => stage.status === 'completed' && stage.endedAt >= stage.startedAt));
    assert.equal(step.metadata.ragStages[0].model, 'text-embedding-v4');
    assert.equal(step.metadata.ragStages[1].resultCount, 1);
    assert.equal(JSON.parse(step.output.content).results[0].chunkId, chunkId);
    assert.equal(step.metadata.ragStages[3].candidates[0].selected, true);
  }
  assert.notEqual(success.steps[0].metadata.toolCallId, success.steps[1].metadata.toolCallId);
  failure = 'rerank';
  const failedRerank = await run('failed-rerank', [call('failed-r', '问题')]);
  assert.equal(failedRerank.steps[0].status, 'failed');
  assert.equal(failedRerank.steps[0].metadata.ragStages[2].status, 'failed');
  assert.ok(!JSON.stringify(failedRerank.steps[0].output ?? null).includes('完整资料正文'));
  failure = 'filtered';
  const filtered = await run('filtered', [call('filtered-r', '问题')]);
  assert.equal(filtered.steps[0].status, 'completed');
  const empty = JSON.parse(filtered.steps[0].output.content);
  assert.deepEqual(empty.results, []);
  assert.match(empty.message, /不是工具故障/);
  assert.equal(filtered.steps[0].metadata.ragStages[3].candidates[0].selected, false);
  failure = 'empty';
  const noCandidates = await run('empty', [call('empty-r', '问题')]);
  assert.equal(noCandidates.steps[0].status, 'completed');
  assert.deepEqual(JSON.parse(noCandidates.steps[0].output.content).results, []);
  assert.deepEqual(noCandidates.steps[0].metadata.ragStages.map((stage) => stage.name), ['query_embedding', 'vector_search', 'filter']);
  failure = 'embedding';
  const failedEmbedding = await run('failed-embedding', [call('failed-a', '失败')]);
  assert.equal(failedEmbedding.steps[0].metadata.ragStages[0].status, 'failed');
  assert.equal(failedEmbedding.steps[0].metadata.ragStages.length, 1);
  failure = 'vector';
  const failedVector = await run('failed-vector', [call('failed-b', '问题')]);
  assert.equal(failedVector.steps[0].metadata.ragStages[0].status, 'completed');
  assert.equal(failedVector.steps[0].metadata.ragStages[1].status, 'failed');
  assert.equal(JSON.stringify([...success.steps, ...failedEmbedding.steps, ...failedVector.steps]).includes('fixture-embedding-secret'), false);
  assert.equal(JSON.stringify([...success.steps, ...failedRerank.steps, ...filtered.steps]).includes('fixture-rerank-secret'), false);
  console.log('PASS: 并行检索按调用隔离、阶段耗时/结果/失败、密钥排除；未访问模型、网络或业务数据库');
} finally {
  globalThis.fetch = original.fetch; Pool.prototype.query = original.query; Pool.prototype.end = original.end;
  if (!resolve(directory).startsWith(cache + sep)) throw new Error('unexpected cleanup path');
  rmSync(directory, { recursive: true, force: true });
}
