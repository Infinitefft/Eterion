import type { SearchHit } from '../types.js';

export const RRF_CONSTANT = 60;
export const FUSION_LIMIT = 20;

export type FusedHit = SearchHit & { rrfScore: number };

// BM25 与向量距离量纲不同；RRF 只累加两路名次的贡献，不直接相加原始分数。
// 完整去重列表用于监控，调用方截取 Top 20 交给重排，缺失的一路贡献为 0。
export function fuseCandidates(vectorHits: SearchHit[], keywordHits: SearchHit[]): FusedHit[] {
  const candidates = new Map<string, FusedHit>();
  for (const [index, hit] of vectorHits.entries()) {
    candidates.set(hit.chunkId, { ...hit, vectorRank: index + 1,
      rrfScore: 1 / (RRF_CONSTANT + index + 1) });
  }
  for (const [index, hit] of keywordHits.entries()) {
    const existing = candidates.get(hit.chunkId);
    candidates.set(hit.chunkId, { ...hit, ...existing,
      ...(hit.bm25Score !== undefined ? { bm25Score: hit.bm25Score } : {}),
      bm25Rank: index + 1,
      rrfScore: (existing?.rrfScore ?? 0) + 1 / (RRF_CONSTANT + index + 1) });
  }
  return [...candidates.values()].sort((a, b) => b.rrfScore - a.rrfScore
    || (a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0));
}
