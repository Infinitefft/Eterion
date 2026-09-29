import { z } from 'zod';
import { prepareChunks } from './chunking.js';
import { embedChunks } from './embedding.js';
import { createRagStore } from './store.js';
import type { IngestionResult, PrepareChunksInput, RagConfig } from './types.js';

const configSchema = z.object({
  apiKey: z.string().trim().min(1),
  baseUrl: z.url().refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
      && url.pathname.replace(/\/$/, '') === '/api/v1';
  }),
  model: z.literal('text-embedding-v4'),
  dimensions: z.literal(1024),
  databaseUrl: z.url().refine((value) => URL.canParse(value)
    && ['postgres:', 'postgresql:'].includes(new URL(value).protocol)),
});

export function createRagIngestor(config: RagConfig | undefined) {
  const parsed = configSchema.safeParse(config);
  if (!parsed.success) {
    // 不直接抛出 ZodError，避免配置值（密钥或连接串）进入日志。
    throw new Error('RAG requires DATABASE_URL and valid EMBEDDING_* settings (text-embedding-v4, 1024 dimensions, HTTPS /api/v1)');
  }
  const store = createRagStore(parsed.data.databaseUrl);
  return {
    async ingestFile(input: PrepareChunksInput, parentSignal?: AbortSignal): Promise<IngestionResult> {
      const timeout = AbortSignal.timeout(10 * 60_000);
      const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
      signal.throwIfAborted();
      if (!z.uuid().safeParse(input.fileId).success) throw new Error('RAG fileId must be a UUID');
      await store.assertFileExists(input.fileId);
      signal.throwIfAborted();
      const chunks = await prepareChunks(input, signal);
      // 所有外部请求完成后再开启写入事务，模型失败不会改变已有索引。
      const embedded = await embedChunks(chunks, parsed.data, signal);
      signal.throwIfAborted();
      await store.replaceFileChunks(input.fileId, embedded, signal);
      return { fileId: input.fileId, chunkCount: embedded.length };
    },
    close: store.close,
  };
}
