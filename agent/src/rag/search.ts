import { z } from 'zod';
import { validateRagConfig } from './config.js';
import { embedQuery } from './embedding.js';
import { createRagStore, SEARCH_LIMIT } from './store.js';
import type { RagConfig, SearchHit, SearchInput } from './types.js';
import type { RagStageEvent } from '../recording/tool-input.js';

export function createRagSearcher(config: RagConfig | undefined) {
  const settings = validateRagConfig(config);
  const store = createRagStore(settings.databaseUrl);
  return {
    async search({ userId, query }: SearchInput, signal?: AbortSignal,
      observe?: (event: RagStageEvent) => Promise<void>): Promise<SearchHit[]> {
      signal?.throwIfAborted();
      if (!z.uuid().safeParse(userId).success) throw new Error('RAG userId must be a UUID');
      async function stage<T>(name: RagStageEvent['name'], details: Pick<RagStageEvent, 'model' | 'dimensions' | 'limit'>,
        action: () => Promise<T>, count?: (value: T) => number): Promise<T> {
        const startedAt = Date.now();
        await observe?.({ name, status: 'running', startedAt, ...details });
        try {
          const value = await action();
          await observe?.({ name, status: 'completed', startedAt, endedAt: Date.now(), ...details,
            ...(count ? { resultCount: count(value) } : {}) });
          return value;
        } catch (error) {
          await observe?.({ name, status: signal?.aborted ? 'cancelled' : 'failed', startedAt,
            endedAt: Date.now(), ...details,
            error: { name: error instanceof Error ? error.name : 'UnknownError',
              message: error instanceof Error ? error.message : 'RAG stage failed' } });
          throw error;
        }
      }
      // 监控采集：仅记录模型、维度、数量和时间，不保存向量或连接参数；记录失败不影响业务执行。
      const embedding = await stage('query_embedding', { model: settings.model, dimensions: settings.dimensions },
        () => embedQuery(query, settings, signal));
      signal?.throwIfAborted();
      return stage('vector_search', { limit: SEARCH_LIMIT }, () => store.searchChunks(userId, embedding, signal),
        (results) => results.length);
    },
    close: store.close,
  };
}
