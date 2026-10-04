import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rerankChunks, selectRerankedChunks, validateRerankConfig } from '../dist/rag/search/rerank.js';
import { loadSettings } from '../dist/config.js';
import { validateRagConfig } from '../dist/rag/config.js';

const config = { apiKey: 'secret', url: 'https://fixture.invalid/reranks', threshold: 0.5 };
const candidates = Array.from({ length: 8 }, (_, index) => ({
  chunkId: `chunk-${index}`, fileId: 'file', knowledgeBaseId: 'base', fileName: 'file.md',
  sectionId: 'section', chunkIndex: index, headingPath: ['父标题', '子标题'],
  content: `正文${index}`, startOffset: index * 10, endOffset: index * 10 + 3, cosineDistance: index / 10,
}));

test('重排完整映射、同分保持召回顺序、阈值包含等号及最终上限', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, config.url);
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.equal(body.top_n, 8);
    assert.equal(body.model, 'qwen3-rerank');
    assert.equal(body.documents[0], '父标题 > 子标题\n\n正文0');
    assert.equal(body.query, '问题');
    return Response.json({ results: [7, 6, 5, 4, 3, 2, 1, 0].map((index) => ({ index, relevance_score: index === 7 ? 0.1 : 0.5 })) });
  });
  const ranked = await rerankChunks('问题', candidates, config);
  assert.deepEqual(ranked.map((hit) => hit.chunkId), candidates.map((hit) => hit.chunkId));
  assert.deepEqual(selectRerankedChunks(ranked, 0.5), ranked.slice(0, 5));
  assert.deepEqual(selectRerankedChunks(ranked, 0.6), []);
  assert.equal(ranked[2].startOffset, candidates[2].startOffset);
  assert.equal(ranked[2].cosineDistance, candidates[2].cosineDistance);
  assert.equal(selectRerankedChunks(ranked.slice(5), 0.5).length, 2);
});

test('零候选不请求服务', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected fetch'); });
  assert.deepEqual(await rerankChunks('问题', [], config), []);
  assert.equal(fetch.mock.callCount(), 0);
});

test('重排分数优先于向量顺序，部分候选通过阈值', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ results: [
    { index: 0, relevance_score: 0.1 }, { index: 1, relevance_score: 0.6 }, { index: 2, relevance_score: 0.9 },
  ] }));
  const ranked = await rerankChunks('问题', candidates.slice(0, 3), config);
  assert.deepEqual(ranked.map((hit) => hit.chunkId), ['chunk-2', 'chunk-1', 'chunk-0']);
  assert.deepEqual(selectRerankedChunks(ranked, 0.5).map((hit) => hit.chunkId), ['chunk-2', 'chunk-1']);
});

test('拒绝缺失、重复、越界索引与非法分数，不返回原候选', async (t) => {
  for (const results of [[], [{ index: 0, relevance_score: 0.9 }, { index: 0, relevance_score: 0.8 }],
    [{ index: 0, relevance_score: 0.9 }, { index: 2, relevance_score: 0.8 }],
    [{ index: 0, relevance_score: 1.1 }, { index: 1, relevance_score: 0.8 }],
    [{ index: 0, relevance_score: -0.1 }, { index: 1, relevance_score: 0.8 }],
    [{ index: 0, relevance_score: null }, { index: 1, relevance_score: 0.8 }]]) {
    const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ results }));
    await assert.rejects(rerankChunks('问题', candidates.slice(0, 2), config), /Invalid rerank/);
    fetch.mock.restore();
  }
});

test('HTTP、非法 JSON 和网络故障隐藏响应内容', async (t) => {
  for (const respond of [() => new Response('secret private text', { status: 500 }),
    () => new Response('not json'), () => { throw new Error('secret'); }]) {
    const fetch = t.mock.method(globalThis, 'fetch', async () => respond());
    await assert.rejects(rerankChunks('问题', candidates, config), /^Error: Rerank request failed$/);
    fetch.mock.restore();
  }
});

test('30 秒期限及外部取消传到 fetch，超时和取消均不回退', async (t) => {
  const timeout = new AbortController();
  t.mock.method(AbortSignal, 'timeout', (ms) => { assert.equal(ms, 30_000); return timeout.signal; });
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const pending = rerankChunks('问题', candidates, config);
  timeout.abort();
  await assert.rejects(pending, /timed out/);
  const external = new AbortController();
  external.abort(new Error('user cancelled'));
  await assert.rejects(rerankChunks('问题', candidates, config, external.signal), /user cancelled/);
});

test('执行中的外部取消会中断请求', async (t) => {
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    controller.abort(new Error('cancel in flight'));
  }));
  await assert.rejects(rerankChunks('问题', candidates, config, controller.signal), /cancel in flight/);
});

test('配置延迟校验；重排配置不进入入库校验', () => {
  const settings = loadSettings({ MODEL_NAME: 'offline', MODEL_API_KEY: 'fixture', RERANK_SCORE_THRESHOLD: 'bad' });
  assert.throws(() => validateRerankConfig(settings.rag.rerank), /RAG requires/);
  assert.equal(loadSettings({ MODEL_NAME: 'offline', MODEL_API_KEY: 'fixture' }).rag.rerank.threshold, 0.5);
  for (const url of ['bad', 'http://example.com', 'https://user:secret@example.com', 'https://example.com/?key=x', 'https://example.com/#x']) {
    assert.throws(() => validateRerankConfig({ ...config, url }), /RAG requires/);
  }
  for (const threshold of [-1, 1.1, NaN]) assert.throws(() => validateRerankConfig({ ...config, threshold }));
  assert.doesNotThrow(() => validateRagConfig({ apiKey: 'fixture', baseUrl: 'https://fixture.invalid/api/v1',
    model: 'text-embedding-v4', dimensions: 1024, databaseUrl: 'postgresql://fixture/unused', rerank: { ...config, threshold: NaN } }));
});
