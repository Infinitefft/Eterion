import Fastify, { type FastifyInstance } from 'fastify';

import type { Settings } from './config.js';
import { runFailed, runInputSchema, type AgentEvent, type AgentRuntime } from './protocol.js';

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

    const response = reply.raw;
    const runId = parsed.data.run_id;
    // SSE 注释只用于保活，不属于前端需要消费的业务事件。
    const heartbeat = setInterval(() => {
      if (!response.destroyed) response.write(': keepalive\n\n');
    }, settings.heartbeatMs);

    try {
      for await (const event of runtime.stream(parsed.data)) {
        if (response.destroyed) break;
        response.write(encodeSse(event));
      }
    } catch (error) {
      // 已发出 SSE 响应头，不能再返回 JSON 错误，需转换为领域事件。
      console.error('Agent SSE stream failed', { runId, error });
      if (!response.destroyed) {
        response.write(
          encodeSse(runFailed(runId, 'AGENT_SERVICE_ERROR', 'Agent 服务执行失败', true)),
        );
      }
    } finally {
      // 正常结束、执行失败和客户端断开都必须清理心跳。
      clearInterval(heartbeat);
      if (!response.destroyed) response.end();
    }
    return reply;
  });

  return app;
}

function encodeSse(event: AgentEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify({
    runId: event.runId,
    payload: event.payload,
  })}\n\n`;
}
