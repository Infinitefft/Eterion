import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import Fastify from 'fastify';
import { openRecordStore } from '../dist/recording/store.js';
import { beginIngestionRecording } from '../dist/recording/ingestion.js';
import { createRagIngestor } from '../dist/rag/ingestion.js';
import { registerRagRoutes } from '../dist/rag/http.js';

// 仅用本地替身执行实际编排；不加载 .env、不建立 PG 连接、不发出网络请求。
const cache = resolve('.cache');
mkdirSync(cache, { recursive: true });
const root = mkdtempSync(join(cache, 'ingestion-recording-'));
const recordingPath = join(root, 'records.sqlite');
const rag = { apiKey: 'fixture-embedding-secret', databaseUrl: 'postgresql://fixture:password@localhost/unused',
  baseUrl: 'https://fixture.invalid/api/v1', model: 'text-embedding-v4', dimensions: 1024 };
const settings = { recordingEnabled: true, recordingPath, rag, bochaApiKey: 'fixture-search-secret', models: [] };
const identity = { userId: randomUUID(), knowledgeBaseId: randomUUID(), fileName: '样例.md' };
const input = { fileId: randomUUID(), format: 'md', text: '\uFEFF# 标题\r\n\r\n正文内容。\r\n\r\n## 次级\r\n\r\n第二段。' };
const original = { query: Pool.prototype.query, connect: Pool.prototype.connect, end: Pool.prototype.end, fetch: globalThis.fetch };
let mode = '', batchCalls = 0, commits = 0, sentTexts = [], cancelledController;
let db, app;
const client = {
  async query(sql) {
    if (sql === 'COMMIT') {
      if (mode === 'commit-failed') throw Object.assign(new Error('fixture'), { code: '08006' });
      commits++;
    }
    return { rowCount: 1, rows: [{ id: input.fileId }] };
  },
  release() {},
};
Pool.prototype.query = async function () {
  if (mode === 'missing-file') return { rowCount: 0, rows: [] };
  return { rowCount: 1, rows: [{ id: input.fileId }] };
};
Pool.prototype.connect = async function () { return client; };
Pool.prototype.end = async function () {};
globalThis.fetch = async (_url, options) => {
  batchCalls++;
  const body = JSON.parse(options.body);
  sentTexts.push(...body.input.texts);
  if (mode === 'cancel') {
    cancelledController.abort();
    throw new DOMException('fixture cancellation', 'AbortError');
  }
  if (mode === 'embedding-failed' && batchCalls === 2) {
    return new Response(JSON.stringify({ code: 'FixtureFailure', request_id: 'fixture-request' }), { status: 503 });
  }
  return new Response(JSON.stringify({ output: { embeddings: body.input.texts.map((_text, text_index) => ({
    text_index, embedding: Array(1024).fill(0.25),
  })).reverse() } }), { status: 200 });
};
function readTask(id) { return db.prepare('SELECT * FROM ingestions WHERE ingestion_id=?').get(id); }
function stages(id) { return db.prepare('SELECT * FROM ingestion_stages WHERE ingestion_id=? ORDER BY sequence').all(id); }
async function ingest(value = input, owner = identity) {
  batchCalls = 0; sentTexts = [];
  const before = db.prepare('SELECT ingestion_id FROM ingestions').all().map((row) => row.ingestion_id);
  const record = await beginIngestionRecording(settings, value, owner);
  const ingestor = createRagIngestor(rag);
  let failure;
  try {
    const result = await ingestor.ingestFile(value, cancelledController?.signal, record);
    record?.complete();
    assert.equal(result.fileId, value.fileId);
  } catch (error) { failure = error; }
  finally { record?.close(); await ingestor.close(); }
  const task = db.prepare('SELECT * FROM ingestions').all().find((row) => !before.includes(row.ingestion_id));
  assert.ok(task);
  return { task, failure };
}
try {
  // 构造含旧聊天的 v1 库，验证增量升级没有改写旧行。
  let store = openRecordStore(recordingPath);
  store.startRun({ runId: 'legacy', userId: identity.userId, modelId: 'fixture', question: '旧问题', input: [], startedAt: 1 });
  store.finishRun({ runId: 'legacy', status: 'completed', output: '旧回答', endedAt: 2 });
  store.close();
  db = new DatabaseSync(recordingPath);
  db.exec('DROP TABLE ingestion_chunks; DROP TABLE ingestion_stages; DROP TABLE ingestions; PRAGMA user_version=1');
  const legacy = db.prepare('SELECT * FROM runs').all();
  db.close(); db = undefined;
  store = openRecordStore(recordingPath); store.close();
  db = new DatabaseSync(recordingPath);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
  assert.deepEqual(db.prepare('SELECT * FROM runs').all(), legacy);

  const success = await ingest();
  assert.equal(success.failure, undefined);
  assert.equal(success.task.status, 'completed');
  assert.equal(success.task.source_text, input.text);
  assert.equal(success.task.user_id, identity.userId);
  assert.ok(commits > 0);
  assert.deepEqual(stages(success.task.ingestion_id).filter((row) => row.parent_stage === null).map((row) => [row.stage_id, row.status]),
    [['file_check', 'completed'], ['chunking', 'completed'], ['embedding', 'completed'], ['storage', 'completed']]);
  const chunks = db.prepare('SELECT * FROM ingestion_chunks WHERE ingestion_id=? ORDER BY sequence').all(success.task.ingestion_id);
  assert.deepEqual(chunks.map((row) => row.embedding_text), sentTexts);
  for (const chunk of chunks) {
    assert.equal(input.text.slice(chunk.start_offset, chunk.end_offset), chunk.content);
    assert.ok(chunk.budget_tokens <= 512);
    assert.equal(JSON.parse(chunk.metadata).budgetTokenizer, 'cl100k_base');
    assert.equal(Object.hasOwn(chunk, 'embedding'), false);
  }

  const repeated = await ingest();
  assert.notEqual(repeated.task.ingestion_id, success.task.ingestion_id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ingestions WHERE file_id=?').get(input.fileId).n, 2);
  const other = await ingest({ ...input, fileId: randomUUID() }, { ...identity, userId: randomUUID() });
  assert.notEqual(other.task.user_id, success.task.user_id);

  mode = 'embedding-failed';
  const text = Array.from({ length: 500 }, (_, index) => `第 ${index} 段包含独立编号与详细知识，解释切分预算及失败后保留已完成记录。`).join('\n\n');
  const partial = await ingest({ ...input, format: 'txt', text });
  assert.equal(partial.task.status, 'failed');
  assert.ok(partial.task.chunk_count > 10);
  assert.equal(batchCalls, 2);
  assert.ok(partial.failure.message.includes('Embedding HTTP 503'));
  assert.equal(stages(partial.task.ingestion_id).find((row) => row.stage_id === 'embedding_batch:0').status, 'completed');
  assert.equal(stages(partial.task.ingestion_id).find((row) => row.stage_id === 'embedding_batch:10').status, 'failed');
  assert.equal(stages(partial.task.ingestion_id).some((row) => row.stage_id === 'storage'), false);

  mode = '';
  const failedChunking = await ingest({ ...input, text: `# 正常\n\n保留已完成片段。\n\n# ${'超长标题'.repeat(700)}\n\n后续正文。` });
  assert.equal(failedChunking.task.status, 'failed');
  assert.equal(failedChunking.task.chunk_count, 1);
  assert.equal(stages(failedChunking.task.ingestion_id).find((row) => row.stage_id === 'chunking').status, 'failed');
  assert.equal(batchCalls, 0);

  mode = 'commit-failed';
  const failedCommit = await ingest();
  assert.equal(failedCommit.task.status, 'failed');
  assert.equal(stages(failedCommit.task.ingestion_id).find((row) => row.stage_id === 'storage').status, 'failed');
  assert.match(failedCommit.failure.message, /08006/);
  mode = 'missing-file';
  assert.equal((await ingest()).task.status, 'failed');
  mode = 'cancel'; cancelledController = new AbortController();
  assert.equal((await ingest()).task.status, 'cancelled');
  cancelledController = undefined; mode = '';

  const empty = await ingest({ ...input, text: '# 只有标题' });
  assert.equal(empty.task.status, 'completed'); assert.equal(empty.task.chunk_count, 0); assert.equal(batchCalls, 0);
  const abandoned = await beginIngestionRecording(settings, input, identity);
  abandoned.startStage('file_check'); abandoned.close();
  const unfinished = db.prepare("SELECT * FROM ingestions WHERE status='running'").all();
  assert.equal(unfinished.length, 1); assert.equal(unfinished[0].ended_at, null);

  const redacted = await beginIngestionRecording(settings, { ...input, text: `${rag.apiKey} ${rag.databaseUrl} Bearer fixture-token` }, identity);
  redacted.fail(new Error(`fixture ${rag.apiKey} ${rag.databaseUrl}`)); redacted.close();
  const saved = JSON.stringify(db.prepare('SELECT * FROM ingestions').all());
  assert.equal(saved.includes(rag.apiKey), false); assert.equal(saved.includes(rag.databaseUrl), false);

  // 监控中途落盘失败不影响真实编排成功，记录保留为不完整，不能伪造终态。
  db.exec("CREATE TRIGGER reject_chunks BEFORE INSERT ON ingestion_chunks BEGIN SELECT RAISE(ABORT, 'fixture unavailable'); END");
  const unavailable = await ingest();
  assert.equal(unavailable.failure, undefined); assert.equal(readTask(unavailable.task.ingestion_id).status, 'running');
  db.exec('DROP TRIGGER reject_chunks');
  const disabledPath = join(root, 'disabled', 'records.sqlite');
  assert.equal(await beginIngestionRecording({ ...settings, recordingEnabled: false, recordingPath: disabledPath }, input, identity), undefined);
  assert.equal(existsSync(disabledPath), false);
  assert.equal(await beginIngestionRecording(settings, input, undefined), undefined);
  assert.equal(await beginIngestionRecording(settings, input, { ...identity, userId: 'invalid' }), undefined);
  assert.equal(await beginIngestionRecording({ ...settings, recordingPath: root }, input, identity), undefined);

  app = Fastify(); registerRagRoutes(app, rag, settings);
  const count = db.prepare('SELECT COUNT(*) AS n FROM ingestions').get().n;
  assert.equal((await app.inject({ method: 'POST', url: '/rag/ingest', payload: input })).statusCode, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ingestions').get().n, count);
  assert.equal((await app.inject({ method: 'POST', url: '/rag/ingest', payload: { ...input, monitoring: { userId: 'invalid' } } })).statusCode, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ingestions').get().n, count);
  const response = await app.inject({ method: 'POST', url: '/rag/ingest', payload: { ...input, monitoring: identity } });
  assert.equal(response.statusCode, 200); assert.deepEqual(Object.keys(response.json()).sort(), ['chunkCount', 'fileId']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ingestions').get().n, count + 1);
  await app.close(); app = Fastify(); registerRagRoutes(app, undefined, settings);
  assert.equal((await app.inject({ method: 'POST', url: '/rag/ingest', payload: { ...input, monitoring: identity } })).statusCode, 503);
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM ingestions WHERE status='failed'").get().n >= 4);
  assert.deepEqual(db.prepare('SELECT * FROM runs').all(), legacy);
  console.log('PASS: v1 migration, identity, snapshots, repeated ingestion, batch/commit failures, cancellation, empty input, fail-open recording, HTTP compatibility; no network or business database used');
} finally {
  await app?.close(); db?.close();
  Pool.prototype.query = original.query; Pool.prototype.connect = original.connect; Pool.prototype.end = original.end; globalThis.fetch = original.fetch;
  if (!resolve(root).startsWith(cache + sep)) throw new Error('Refusing cleanup outside fixture cache');
  rmSync(root, { recursive: true, force: true });
}
