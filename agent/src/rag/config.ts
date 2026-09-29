import { z } from 'zod';
import type { RagConfig } from './types.js';

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

export function validateRagConfig(config: RagConfig | undefined): RagConfig {
  const parsed = configSchema.safeParse(config);
  if (!parsed.success) {
    // 不输出配置值或 ZodError，避免凭据进入日志。
    throw new Error('RAG requires DATABASE_URL and valid EMBEDDING_* settings (text-embedding-v4, 1024 dimensions, HTTPS /api/v1)');
  }
  return parsed.data;
}
