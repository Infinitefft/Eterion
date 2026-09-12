import Fastify, { type FastifyInstance } from 'fastify';

import type { Settings } from './config.js';
import { runFailed, runInputSchema, type AgentEvent, type AgentRuntime } from './protocol.js';

/** 创建 HTTP 服务，负责请求校验、领域事件传输和连接生命周期。 */
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
    // 每个 HTTP 请求有自己的 Controller，取消不能影响同一 Runtime 的其他请求。
    const controller = new AbortController();
    // SSE 注释只用于保活，不属于前端需要消费的业务事件。
    const heartbeat = setInterval(() => {
      if (!response.destroyed) response.write(': keepalive\n\n');
    }, settings.heartbeatMs);

    /** 响应连接提前关闭时立即停止本轮执行，不等待 Runtime 产生下一条事件。 */
    function onClose(): void {
      clearInterval(heartbeat);
      // 正常调用 end() 也会关闭响应，不应当作用户取消。
      if (!response.writableEnded) controller.abort();
    }

    // 监听响应的关闭，而不是请求体读完时也可能触发的 request.close。
    response.once('close', onClose);

    try {
      // signal 是进程内控制参数，不混入经过 Schema 校验的请求 JSON。
      for await (const event of runtime.stream(parsed.data, controller.signal)) {
        if (response.destroyed) break;
        response.write(encodeSse(event));
      }
    } catch (error) {
      // 已发出 SSE 响应头，不能再返回 JSON 错误，需转换为领域事件。
      // 断连取消是正常控制行为，不输出故障日志或原始异常。
      if (!controller.signal.aborted) {
        console.error('Agent SSE stream failed', {
          runId,
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
      }
      if (!response.destroyed) {
        response.write(
          encodeSse(runFailed(runId, 'AGENT_SERVICE_ERROR', 'Agent 服务执行失败', true)),
        );
      }
    } finally {
      // 正常结束、执行失败和客户端断开都必须清理心跳。
      clearInterval(heartbeat);
      // 当前请求结束后移除监听器，正常 end() 不再触发取消处理。
      response.off('close', onClose);
      if (!response.destroyed) response.end();
    }
    return reply;
  });

  return app;
}

/** 将项目事件编码为一帧 SSE，不暴露框架内部消息结构。 */
function encodeSse(event: AgentEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify({
    runId: event.runId,
    payload: event.payload,
  })}\n\n`;
}
