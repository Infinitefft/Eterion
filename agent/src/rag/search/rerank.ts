import { z } from 'zod';
import { buildEmbeddingText } from '../embedding.js';
import type { RerankConfig, SearchHit } from '../types.js';

export const RERANK_MODEL = 'qwen3-rerank';
export const RESULT_LIMIT = 5;

const configSchema = z.object({
  apiKey: z.string().trim().min(1),
  url: z.url().refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  }),
  threshold: z.number().finite().min(0).max(1),
});

export function validateRerankConfig(config: RerankConfig | undefined): RerankConfig {
  const parsed = configSchema.safeParse(config);
  if (!parsed.success) throw new Error('RAG requires valid RERANK_API_KEY, RERANK_URL and RERANK_SCORE_THRESHOLD');
  return parsed.data;
}

const responseSchema = z.object({ results: z.array(z.object({
  index: z.number().int().nonnegative(),
  relevance_score: z.number().finite().min(0).max(1),
})) });

export async function rerankChunks(query: string, candidates: SearchHit[], config: RerankConfig,
  parentSignal?: AbortSignal): Promise<SearchHit[]> {
  parentSignal?.throwIfAborted();
  if (!candidates.length) return [];
  const timeout = AbortSignal.timeout(30_000);
  const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
  let response: Response;
  let body: unknown;
  try {
    response = await fetch(config.url, {
      method: 'POST', redirect: 'error', signal,
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: RERANK_MODEL, query,
        documents: candidates.map(buildEmbeddingText), top_n: candidates.length }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('HTTP failure');
    }
    body = await response.json();
  } catch {
    parentSignal?.throwIfAborted();
    // 不把厂商响应或网络错误中的配置、正文带入日志。
    throw new Error(signal.aborted ? 'Rerank request timed out' : 'Rerank request failed');
  }
  signal.throwIfAborted();
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success || parsed.data.results.length !== candidates.length) throw new Error('Invalid rerank response');
  const seen = new Set<number>();
  const ranked = parsed.data.results.map(({ index, relevance_score }) => {
    const candidate = candidates[index];
    if (!candidate || seen.has(index)) throw new Error('Invalid rerank result index');
    seen.add(index);
    return { index, hit: { ...candidate, rerankScore: relevance_score } };
  });
  // 显式使用召回序号打破同分，不能依赖厂商返回顺序。
  ranked.sort((a, b) => b.hit.rerankScore - a.hit.rerankScore || a.index - b.index);
  return ranked.map(({ hit }) => hit);
}

export function selectRerankedChunks(ranked: SearchHit[], threshold: number): SearchHit[] {
  return ranked.filter((hit) => hit.rerankScore !== undefined && hit.rerankScore >= threshold).slice(0, RESULT_LIMIT);
}
