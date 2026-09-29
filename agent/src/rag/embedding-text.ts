import { getEncoding } from 'js-tiktoken';
import type { RagChunk } from './types.js';

export const EMBEDDING_TEXT_BUDGET = 512;
export const MAX_OVERLAP_BUDGET = 64;

// 这是切分预算的代理编码器，不代表阿里 text-embedding-v4 的真实 tokenizer。
const budgetEncoder = getEncoding('cl100k_base');

export function countBudgetTokens(text: string): number {
  // 文件中的特殊 token 字面量也按普通文本处理，不将其作为控制标记。
  return budgetEncoder.encode(text, [], []).length;
}

export function buildEmbeddingText(chunk: Pick<RagChunk, 'headingPath' | 'content'>): string {
  const heading = chunk.headingPath.join(' > ');
  return heading ? `${heading}\n\n${chunk.content}` : chunk.content;
}
