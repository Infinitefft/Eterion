import { z } from 'zod';
import { validateRagConfig } from './config.js';
import { embedQuery } from './embedding.js';
import { createRagStore } from './store.js';
import type { RagConfig, SearchHit, SearchInput } from './types.js';

export function createRagSearcher(config: RagConfig | undefined) {
  const settings = validateRagConfig(config);
  const store = createRagStore(settings.databaseUrl);
  return {
    async search({ userId, query }: SearchInput, signal?: AbortSignal): Promise<SearchHit[]> {
      signal?.throwIfAborted();
      if (!z.uuid().safeParse(userId).success) throw new Error('RAG userId must be a UUID');
      const embedding = await embedQuery(query, settings, signal);
      signal?.throwIfAborted();
      return store.searchChunks(userId, embedding, signal);
    },
    close: store.close,
  };
}
