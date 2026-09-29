import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { RagConfig } from './types.js';
import { createRagIngestor } from './ingestion.js';

const inputSchema = z.object({ fileId: z.uuid(), format: z.enum(['md', 'txt']), text: z.string() });

export function registerRagRoutes(app: FastifyInstance, config: RagConfig | undefined): void {
  let ingestor: ReturnType<typeof createRagIngestor> | undefined;
  app.addHook('onClose', async () => { await ingestor?.close(); });

  // 与 /runs 一样只供可信的 Go 服务调用，浏览器必须走 Go 的鉴权上传入口。
  app.post('/rag/ingest', { bodyLimit: 128 * 1024 * 1024 }, async (request, reply) => {
    const parsed = inputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'INVALID_RAG_INPUT', message: '入库参数不合法' } });
    }
    if (Buffer.byteLength(parsed.data.text, 'utf8') > 20 * 1024 * 1024) {
      return reply.code(413).send({ error: { code: 'RAG_TEXT_TOO_LARGE', message: '文件不能超过 20 MiB' } });
    }
    try {
      ingestor ??= createRagIngestor(config);
    } catch {
      return reply.code(503).send({ error: { code: 'RAG_UNAVAILABLE', message: '索引服务尚未配置' } });
    }
    const controller = new AbortController();
    const onClose = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.once('close', onClose);
    try {
      return await ingestor.ingestFile(parsed.data, controller.signal);
    } catch {
      return reply.code(502).send({ error: { code: 'RAG_INGEST_FAILED', message: '文件索引未完成' } });
    } finally {
      reply.raw.off('close', onClose);
    }
  });
}
