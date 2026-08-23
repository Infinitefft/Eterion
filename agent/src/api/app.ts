import Fastify, { type FastifyInstance } from 'fastify';

import type { Settings } from '../config/settings.js';
import { runInputSchema, type AgentRuntime } from '../runtime/contracts.js';
import { writeSseStream } from './sse.js';

export function createApp(settings: Settings, runtime: AgentRuntime): FastifyInstance {
  const app = Fastify({ logger: true });

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/models', async () => ({
    default_model_id: runtime.defaultModelId,
    models: runtime.models,
  }));

  app.post('/runs', async (request, reply) => {
    const parsed = runInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_RUN_INPUT',
          message: 'Agent Run 请求参数不合法',
          issues: parsed.error.issues,
        },
      });
    }

    // hijack 表示后续响应由我们直接写入 Node 原生 response，适合 SSE 长连接。
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    await writeSseStream(
      reply.raw,
      runtime.stream(parsed.data),
      parsed.data.run_id,
      settings.heartbeatMs,
    );
    return reply;
  });

  app.addHook('onClose', async () => {
    await runtime.close();
  });

  return app;
}
