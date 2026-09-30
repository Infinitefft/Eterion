import { getEncoding } from 'js-tiktoken';
import { z } from 'zod';
import type { EmbeddedChunk, RagChunk, RagConfig } from './types.js';
// 监控采集：批次观察器不接收密钥或向量；记录失败不影响业务执行。
import type { IngestionRecording } from '../recording/ingestion.js';

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

const BATCH_SIZE = 10;
const REQUEST_TIMEOUT_MS = 30_000;
const QUERY_TOKEN_BUDGET = 2048;
const responseSchema = z.object({
  output: z.object({
    embeddings: z.array(z.object({
      text_index: z.number().int().nonnegative(),
      embedding: z.array(z.number().finite()).length(1024)
        .refine((vector) => vector.some((value) => value !== 0)),
    })),
  }),
});

// 只提取诊断标识，不输出厂商 message 或完整响应，避免带出文件内容。
const diagnosticsSchema = z.object({ code: z.string().optional(), request_id: z.string().optional() });
function diagnostics(body: unknown): string {
  const parsed = diagnosticsSchema.safeParse(body);
  if (!parsed.success) return '';
  return Object.entries(parsed.data)
    .filter(([, value]) => value && /^[\w.-]{1,128}$/.test(value))
    .map(([key, value]) => ` ${key}=${value}`).join('');
}

export async function embedChunks(
  chunks: RagChunk[],
  config: Pick<RagConfig, 'apiKey' | 'baseUrl' | 'model' | 'dimensions'>,
  parentSignal?: AbortSignal,
  recording?: IngestionRecording,
): Promise<EmbeddedChunk[]> {
  parentSignal?.throwIfAborted();
  const texts = chunks.map((chunk) => {
    const text = buildEmbeddingText(chunk);
    if (!chunk.content.trim() || countBudgetTokens(text) > EMBEDDING_TEXT_BUDGET) {
      throw new Error('Embedding input must have nonempty content within the proxy token budget');
    }
    return text;
  });
  // 监控采集：透传可选批次观察器；记录失败不影响业务执行。
  const vectors = await embedTexts(texts, 'document', config, parentSignal, recording);
  return chunks.map((chunk, index) => {
    const embedding = vectors[index];
    if (!embedding) throw new Error('Missing embedding vector');
    return { ...chunk, embedding };
  });
}

export async function embedQuery(
  query: string,
  config: Pick<RagConfig, 'apiKey' | 'baseUrl' | 'model' | 'dimensions'>,
  signal?: AbortSignal,
): Promise<number[]> {
  signal?.throwIfAborted();
  const text = query.trim();
  if (!text || countBudgetTokens(text) > QUERY_TOKEN_BUDGET) {
    throw new Error('RAG query must be nonempty and within the 2048 proxy token budget');
  }
  const [embedding] = await embedTexts([text], 'query', config, signal);
  if (!embedding) throw new Error('Missing query embedding');
  return embedding;
}

// 文档和查询共享协议校验，只区分厂商要求的文本用途。
async function embedTexts(
  texts: string[],
  textType: 'document' | 'query',
  config: Pick<RagConfig, 'apiKey' | 'baseUrl' | 'model' | 'dimensions'>,
  parentSignal?: AbortSignal,
  recording?: IngestionRecording,
): Promise<number[][]> {
  const result: number[][] = [];
  for (let start = 0; start < texts.length; start += BATCH_SIZE) {
    parentSignal?.throwIfAborted();
    const batch = texts.slice(start, start + BATCH_SIZE);
    // 监控采集：记录实际批次范围，不保存向量；记录失败不影响业务执行。
    recording?.batchStarted(start, batch.length);
    let response: Response;
    let body: unknown;
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
    try {
      response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/services/embeddings/text-embedding/text-embedding`, {
        method: 'POST',
        redirect: 'error',
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.model,
          input: { texts: batch },
          parameters: { dimension: config.dimensions, text_type: textType, output_type: 'dense' },
        }),
        signal,
      });
      // 非 JSON 错误页同样不应被打印；后续仍保留 HTTP 状态码。
      const raw = await response.text();
      try { body = JSON.parse(raw); } catch { body = undefined; }
    } catch {
      parentSignal?.throwIfAborted();
      throw new Error(signal.aborted ? 'Embedding request timed out' : 'Embedding request failed');
    }
    parentSignal?.throwIfAborted();
    if (!response.ok) {
      throw new Error(`Embedding HTTP ${response.status}${diagnostics(body)}`);
    }
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success || parsed.data.output.embeddings.length !== batch.length) {
      throw new Error(`Invalid embedding response HTTP ${response.status}${diagnostics(body)}`);
    }
    const vectors = new Map<number, number[]>();
    for (const entry of parsed.data.output.embeddings) {
      if (entry.text_index >= batch.length || vectors.has(entry.text_index)) {
        throw new Error(`Invalid embedding text_index${diagnostics(body)}`);
      }
      vectors.set(entry.text_index, entry.embedding);
    }
    // 厂商响应不必按输入顺序排列，使用批次内索引恢复一一对应关系。
    for (let index = 0; index < batch.length; index++) {
      const embedding = vectors.get(index);
      if (!embedding) throw new Error('Missing embedding vector');
      result.push(embedding);
    }
    // 监控采集：只在整批响应通过校验后确认完成；记录失败不影响业务执行。
    recording?.batchCompleted(start, batch.length);
  }
  return result;
}
