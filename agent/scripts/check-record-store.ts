import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { openRecordStore } from '../src/recording/store.js';

// 只使用脚本创建的临时数据库，不读取 .env，不调用模型或实际运行数据库。
const cacheRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../.cache');
mkdirSync(cacheRoot, { recursive: true });
const temporaryDirectory = mkdtempSync(join(cacheRoot, 'record-store-'));
const filePath = join(temporaryDirectory, 'records.sqlite');
const secret = 'fixture-secret-not-a-real-key';
let store: ReturnType<typeof openRecordStore> | undefined;
let reader: DatabaseSync | undefined;

try {
  store = openRecordStore(filePath, [secret]);
  store.startRun({
    runId: 'run-a', userId: 'user-a', threadId: 'thread-a', modelId: 'fixture-model',
    question: '检索并解释 SQLite', startedAt: 1_000,
    input: { messages: [{ role: 'user', content: '检索并解释 SQLite' }], api_key: secret },
  });
  store.startStep({
    runId: 'run-a', stepId: 'model-1', kind: 'model', name: 'fixture-model',
    input: { messages: ['实际上下文'] }, startedAt: 1_001,
  });
  store.finishStep({
    runId: 'run-a', stepId: 'model-1', status: 'completed', endedAt: 1_002,
    output: { tool_calls: [{ id: 'call-1', name: 'web_search', args: { query: 'SQLite' } }] },
    metadata: { usage: { input_tokens: 12, output_tokens: 8 } },
  });
  store.startStep({
    runId: 'run-a', stepId: 'tool-1', kind: 'tool', name: 'web_search',
    input: { query: 'SQLite', options: { refresh_token: secret } },
    metadata: { toolCallId: 'call-1' }, startedAt: 1_003,
  });
  store.updateStepMetadata('run-a', 'tool-1', {
    toolCallId: 'call-1', executionStarted: true, executionArgs: { query: 'SQLite', token: secret },
  });
  store.finishStep({
    runId: 'run-a', stepId: 'tool-1', status: 'failed', endedAt: 1_004,
    error: { message: `Request failed: ${secret}; Bearer test-bearer-token` },
  });
  store.startStep({
    runId: 'run-a', stepId: 'model-2', kind: 'model', name: 'fixture-model',
    input: ['用户问题', '工具失败结果'], startedAt: 1_005,
  });
  store.finishStep({
    runId: 'run-a', stepId: 'model-2', status: 'completed', output: '搜索暂时不可用。', endedAt: 1_006,
  });
  store.finishRun({ runId: 'run-a', status: 'completed', output: '搜索暂时不可用。', endedAt: 1_007 });

  store.startRun({
    runId: 'run-b', userId: 'user-b', modelId: 'fixture-model', question: '另一个用户的问题',
    input: [], startedAt: 2_000,
  });
  // 不同 Run 可以使用同样的步骤 ID，但记录和结果不能串到一起。
  store.startStep({ runId: 'run-b', stepId: 'tool-1', kind: 'tool', name: 'fixture-tool', input: {}, startedAt: 2_001 });
  store.finishStep({ runId: 'run-b', stepId: 'tool-1', status: 'completed', output: null, endedAt: 2_002 });
  store.startStep({ runId: 'run-b', stepId: 'unfinished', kind: 'model', name: 'fixture-model', input: [], startedAt: 2_003 });
  store.finishRun({ runId: 'run-b', status: 'cancelled', output: '已返回的部分内容', endedAt: 2_004 });

  assert.throws(() => store!.startRun({
    runId: 'unowned', userId: '', modelId: 'fixture-model', question: '', input: [], startedAt: 3_000,
  }));
  assert.throws(() => store!.startStep({
    runId: 'missing', stepId: 'orphan', kind: 'tool', name: 'fixture-tool', input: {}, startedAt: 3_001,
  }));
  assert.throws(() => store!.finishRun({ runId: 'run-a', status: 'failed', endedAt: 3_002 }));
  assert.throws(() => store!.updateStepMetadata('run-a', 'tool-1', {}));
  assert.throws(() => store!.updateStepMetadata('run-b', 'unfinished', {}));
  store.close();
  store = undefined;

  store = openRecordStore(filePath);
  const runA = store.getRun('run-a');
  const runB = store.getRun('run-b');
  assert.ok(runA && runB);
  assert.equal(runA.user_id, 'user-a');
  assert.equal(runA.thread_id, 'thread-a');
  assert.equal(runA.question, '检索并解释 SQLite');
  assert.equal(runA.output, '搜索暂时不可用。');
  assert.equal(runA.status, 'completed');
  assert.deepEqual(runA.steps.map((step) => [step.sequence, step.kind, step.status]), [
    [1, 'model', 'completed'], [2, 'tool', 'failed'], [3, 'model', 'completed'],
  ]);
  assert.deepEqual(runA.steps[0]?.input, { messages: ['实际上下文'] });
  assert.deepEqual(runA.steps[0]?.metadata, { usage: { input_tokens: 12, output_tokens: 8 } });
  assert.deepEqual(runA.steps[1]?.metadata, {
    toolCallId: 'call-1', executionStarted: true, executionArgs: { query: 'SQLite', token: '[REDACTED]' },
  });
  assert.deepEqual(runA.steps[1]?.input, { query: 'SQLite', options: { refresh_token: '[REDACTED]' } });
  assert.equal(runA.steps[1]?.output, undefined);
  assert.ok(JSON.stringify(runA).includes('[REDACTED]'));
  assert.ok(!JSON.stringify(runA).includes(secret));
  assert.ok(!JSON.stringify(runA).includes('test-bearer-token'));
  assert.equal(runB.user_id, 'user-b');
  assert.equal(runB.status, 'cancelled');
  assert.equal(runB.output, '已返回的部分内容');
  assert.equal(runB.steps[0]?.output, null);
  assert.equal(runB.steps[1]?.status, 'running');
  assert.equal(runB.steps[1]?.ended_at, null);
  assert.equal(store.getRun('missing'), undefined);
  store.close();
  store = undefined;

  // 另开只读连接证明平台可以独立使用 SQLite 读取，不必导入采集模块。
  reader = new DatabaseSync(filePath, { readOnly: true });
  const users = reader.prepare('SELECT DISTINCT user_id FROM runs ORDER BY user_id').all();
  assert.deepEqual(users.map((row) => row['user_id']), ['user-a', 'user-b']);
  assert.equal(reader.prepare('SELECT COUNT(*) AS count FROM steps').get()?.['count'], 5);
  console.log('PASS: persistence, user association, step order, failure/cancellation, redaction, independent read');
} finally {
  reader?.close();
  store?.close();
  // 删除前验证绝对路径仍位于本脚本专用缓存目录，只清理本次创建的数据库。
  const cleanupPath = resolve(temporaryDirectory);
  if (!cleanupPath.startsWith(cacheRoot + sep) || !cleanupPath.startsWith(join(cacheRoot, 'record-store-'))) {
    throw new Error('Unexpected verification directory');
  }
  rmSync(cleanupPath, { recursive: true, force: true });
}
