import { z } from 'zod';
import { validateRagConfig } from './config.js';
import { prepareChunks } from './chunking.js';
import { embedChunks } from './embedding.js';
import { createRagStore } from './store.js';
import type { IngestionResult, PrepareChunksInput, RagConfig } from './types.js';

export function createRagIngestor(config: RagConfig | undefined) {
  const settings = validateRagConfig(config);
  const store = createRagStore(settings.databaseUrl);
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
      const embedded = await embedChunks(chunks, settings, signal);
      signal.throwIfAborted();
      await store.replaceFileChunks(input.fileId, embedded, signal);
      return { fileId: input.fileId, chunkCount: embedded.length };
    },
    close: store.close,
  };
}
