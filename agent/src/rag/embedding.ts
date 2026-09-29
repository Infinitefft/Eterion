import { z } from 'zod';
import { buildEmbeddingText, countBudgetTokens, EMBEDDING_TEXT_BUDGET } from './embedding-text.js';
import type { EmbeddedChunk, RagChunk, RagConfig } from './types.js';

const BATCH_SIZE = 10;
const REQUEST_TIMEOUT_MS = 30_000;
const responseSchema = z.object({
  output: z.object({
    embeddings: z.array(z.object({
      text_index: z.number().int().nonnegative(),
      embedding: z.array(z.number().finite()).length(1024),
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
): Promise<EmbeddedChunk[]> {
  const texts = chunks.map((chunk) => {
    const text = buildEmbeddingText(chunk);
    if (!chunk.content.trim() || countBudgetTokens(text) > EMBEDDING_TEXT_BUDGET) {
      throw new Error('Embedding input must have nonempty content within the proxy token budget');
    }
    return text;
  });
  const result: EmbeddedChunk[] = [];
  for (let start = 0; start < chunks.length; start += BATCH_SIZE) {
    const batch = chunks.slice(start, start + BATCH_SIZE);
    let response: Response;
    let body: unknown;
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    try {
      response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/services/embeddings/text-embedding/text-embedding`, {
        method: 'POST',
        redirect: 'error',
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.model,
          input: { texts: texts.slice(start, start + BATCH_SIZE) },
          parameters: { dimension: config.dimensions, text_type: 'document', output_type: 'dense' },
        }),
        signal,
      });
      // 非 JSON 错误页同样不应被打印；后续仍保留 HTTP 状态码。
      const raw = await response.text();
      try { body = JSON.parse(raw); } catch { body = undefined; }
    } catch {
      throw new Error(signal.aborted ? 'Embedding request timed out' : 'Embedding request failed');
    }
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
    for (const [index, chunk] of batch.entries()) {
      const embedding = vectors.get(index);
      if (!embedding) throw new Error('Missing embedding vector');
      result.push({ ...chunk, embedding });
    }
  }
  return result;
}
