import { z } from 'zod';
import { validateRagConfig } from './config.js';
import { CHUNKING_RULES, prepareChunks } from './chunking.js';
import { embedChunks } from './embedding.js';
import { createRagStore } from './store.js';
import type { IngestionResult, PrepareChunksInput, RagConfig } from './types.js';
// 监控采集：可选观察器由记录模块隔离异常；记录失败不影响业务执行。
import type { IngestionRecording } from '../recording/ingestion.js';

export function createRagIngestor(config: RagConfig | undefined) {
  const settings = validateRagConfig(config);
  const store = createRagStore(settings.databaseUrl);
  return {
    async ingestFile(input: PrepareChunksInput, parentSignal?: AbortSignal, recording?: IngestionRecording): Promise<IngestionResult> {
      const timeout = AbortSignal.timeout(10 * 60_000);
      const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
      // 监控采集：阶段调用仅观察现有业务顺序；记录失败不影响业务执行。
      try {
        recording?.startStage('file_check');
        signal.throwIfAborted();
        if (!z.uuid().safeParse(input.fileId).success) throw new Error('RAG fileId must be a UUID');
        await store.assertFileExists(input.fileId);
        signal.throwIfAborted();
        recording?.finishStage('file_check');
        recording?.startStage('chunking', { ...CHUNKING_RULES, format: input.format });
        const chunks = await prepareChunks(input, signal, recording);
        recording?.finishStage('chunking', { chunkCount: chunks.length });
        recording?.startStage('embedding', { model: settings.model, dimensions: settings.dimensions, chunkCount: chunks.length });
        // 所有外部请求完成后再开启写入事务，模型失败不会改变已有索引。
        const embedded = await embedChunks(chunks, settings, signal, recording);
        signal.throwIfAborted();
        recording?.finishStage('embedding', { chunkCount: embedded.length });
        recording?.startStage('storage', { operation: 'replace_file_chunks', chunkCount: embedded.length });
        await store.replaceFileChunks(input.fileId, embedded, signal);
        recording?.finishStage('storage', { committed: true, chunkCount: embedded.length });
        return { fileId: input.fileId, chunkCount: embedded.length };
      } catch (error) {
        // 监控采集：保存原业务错误并原样抛出；记录失败不影响业务执行。
        recording?.fail(error, signal.aborted);
        throw error;
      }
    },
    close: store.close,
  };
}
