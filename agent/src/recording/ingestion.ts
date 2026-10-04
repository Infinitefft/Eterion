import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Settings } from '../config.js';
import type { JsonValue } from '../protocol.js';
import type { MarkdownSection, PrepareChunksInput, RagChunk } from '../rag/types.js';
import { buildEmbeddingText, countBudgetTokens } from '../rag/embedding.js';
import type { openRecordStore } from './store.js';

const metadataSchema = z.object({ userId: z.uuid(), knowledgeBaseId: z.uuid(), fileName: z.string().min(1) });

export type IngestionRecording = NonNullable<Awaited<ReturnType<typeof beginIngestionRecording>>>;

// 独立调试记录：只接收白名单数据，所有监控异常在这里隔离，不改变入库返回值。
export async function beginIngestionRecording(
  settings: Pick<Settings, 'recordingEnabled' | 'recordingPath' | 'rag' | 'models' | 'bochaApiKey'> | undefined,
  input: PrepareChunksInput,
  metadata: unknown,
) {
  if (!settings?.recordingEnabled) return undefined;
  const identity = metadataSchema.safeParse(metadata);
  if (!identity.success) {
    console.warn('ingestion recording skipped', { reason: 'missing_or_invalid_metadata' });
    return undefined;
  }
  const ingestionId = randomUUID();
  const startedAt = Date.now();
  let store: ReturnType<typeof openRecordStore> | undefined;
  let unavailable = false;
  let ended = false;
  const activeStages = new Set<string>();

  function warn(error: unknown): void {
    console.warn('ingestion recording unavailable', { ingestionId, errorName: error instanceof Error ? error.name : 'UnknownError' });
  }
  function close(): void {
    try { store?.close(); } catch (error) { warn(error); }
    store = undefined;
  }
  try {
    const { openRecordStore } = await import('./store.js');
    store = openRecordStore(settings.recordingPath, [
      settings.bochaApiKey, ...settings.models.map((model) => model.apiKey),
      settings.rag?.apiKey ?? '', settings.rag?.databaseUrl ?? '', settings.rag?.rerank?.apiKey ?? '',
    ]);
    store.startIngestion({ ingestionId, ...identity.data, fileId: input.fileId,
      format: input.format, sourceText: input.text, startedAt });
  } catch (error) {
    warn(error);
    close();
    return undefined;
  }

  function record(action: (target: ReturnType<typeof openRecordStore>) => void): void {
    if (!store || unavailable || ended) return;
    try { action(store); } catch (error) {
      unavailable = true;
      warn(error);
    }
  }
  function startStage(stageId: string, details: JsonValue = {}, parentStage?: string): void {
    record((target) => {
      target.startIngestionStage(ingestionId, stageId, details, Date.now(), parentStage);
      activeStages.add(stageId);
    });
  }
  function finishStage(stageId: string, output: JsonValue = {}): void {
    record((target) => {
      target.finishIngestionStage(ingestionId, stageId, 'completed', Date.now(), output);
      activeStages.delete(stageId);
    });
  }

  return {
    startStage,
    finishStage,
    section(section: MarkdownSection, chunks: RagChunk[], bodyBudget: number, overlap: number): void {
      record((target) => target.appendIngestionChunks(ingestionId, chunks.map((chunk) => {
        const embeddingText = buildEmbeddingText(chunk);
        return {
          chunkId: chunk.id, sectionId: chunk.sectionId, chunkIndex: chunk.chunkIndex,
          content: chunk.content, headingPath: [...chunk.headingPath],
          ...(chunk.startOffset !== undefined && chunk.endOffset !== undefined
            ? { startOffset: chunk.startOffset, endOffset: chunk.endOffset } : {}),
          embeddingText, budgetTokens: countBudgetTokens(embeddingText),
          metadata: { sectionStartOffset: section.startOffset, sectionEndOffset: section.endOffset,
            bodyBudget, targetOverlap: overlap, offsetUnit: 'UTF-16', budgetTokenizer: 'cl100k_base' },
        };
      })));
    },
    batchStarted(start: number, count: number): void {
      startStage(`embedding_batch:${start}`, { startIndex: start, count }, 'embedding');
    },
    batchCompleted(start: number, count: number): void {
      finishStage(`embedding_batch:${start}`, { count });
    },
    complete(): void {
      record((target) => target.finishIngestion(ingestionId, 'completed', Date.now()));
      ended = true;
    },
    fail(error: unknown, cancelled = false): void {
      record((target) => {
        const status = cancelled ? 'cancelled' : 'failed';
        const snapshot = error instanceof Error
          ? { name: error.name, message: error.message } : { name: 'UnknownError', message: '入库发生非标准异常' };
        const endedAt = Date.now();
        for (const stageId of activeStages) target.finishIngestionStage(ingestionId, stageId, status, endedAt, undefined, snapshot);
        target.finishIngestion(ingestionId, status, endedAt, snapshot);
      });
      ended = true;
    },
    close,
  };
}
