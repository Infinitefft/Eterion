import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { restoreContext, serializeContext } from './memory/messages.js';
import { isContextLimitError } from './memory/compaction.js';

import type { Settings } from './config.js';
import { runFailed, runRequestSchema, type AgentEvent, type AgentRuntime, type RunInput } from './protocol.js';
import { buildRunInput } from './memory/load-context.js';
import { registerRagRoutes } from './rag/http.js';

const contextRequestSchema = z.object({
  model_id: z.string().min(1),
  agent_context: z.unknown().optional(),
  history: z.array(z.object({
    id: z.string().uuid(), role: z.enum(['user', 'assistant', 'system']),
    status: z.string(), content: z.string(),
  })),
});

// 查询与手动压缩必须恢复同一份消息，避免余量统计漏掉工具结果或摘要。
function restoreRequestContext(input: z.infer<typeof contextRequestSchema>) {
  const messages = input.agent_context == null ? [] : restoreContext(input.agent_context);
  for (const message of input.history) {
    if (message.status !== 'completed' || !message.content || message.role === 'system') continue;
    messages.push(message.role === 'user'
      ? new HumanMessage({ id: message.id, content: message.content })
      : new AIMessage({ id: message.id, content: message.content }));
  }
  return messages;
}

/** 创建 HTTP 服务，负责请求校验、领域事件传输和连接生命周期。 */
export function createApp(settings: Settings, runtime: AgentRuntime): FastifyInstance {
  const app = Fastify({ logger: true });
  // 监控采集：复用现有开关与记录目录；记录失败不影响业务执行。
  registerRagRoutes(app, settings.rag, settings);
  app.addHook('onClose', async () => { await runtime.close?.(); });

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/models', async () => ({
    default_model_id: runtime.defaultModelId,
    models: runtime.models,
  }));

  // 与 /runs 一样，仅供 Go 在可信服务网络内调用；浏览器通过 Go 鉴权入口访问。
  app.post('/context/usage', { bodyLimit: 4 << 20 }, async (request, reply) => {
    const parsed = contextRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'INVALID_CONTEXT', message: '上下文参数不合法' } });
    if (!runtime.contextUsage) return reply.code(409).send({ error: { code: 'CONTEXT_USAGE_UNAVAILABLE', message: '当前模式不支持上下文统计' } });
    if (!runtime.models.some((model) => model.id === parsed.data.model_id)) {
      return reply.code(400).send({ error: { code: 'MODEL_NOT_AVAILABLE', message: '所选模型不可用' } });
    }
    try {
      return runtime.contextUsage(parsed.data.model_id, restoreRequestContext(parsed.data));
    } catch {
      return reply.code(502).send({ error: { code: 'CONTEXT_USAGE_FAILED', message: '无法读取上下文用量' } });
    }
  });

  app.post('/context/compact', { bodyLimit: 4 << 20 }, async (request, reply) => {
    const parsed = contextRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'INVALID_CONTEXT', message: '上下文参数不合法' } });
    if (!runtime.compact) return reply.code(409).send({ error: { code: 'COMPACTION_UNAVAILABLE', message: '当前模式不支持压缩' } });
    if (!runtime.models.some((model) => model.id === parsed.data.model_id)) {
      return reply.code(400).send({ error: { code: 'MODEL_NOT_AVAILABLE', message: '所选模型不可用' } });
    }
    const controller = new AbortController();
    const onClose = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.once('close', onClose);
    try {
      const messages = restoreRequestContext(parsed.data);
      const result = await runtime.compact(parsed.data.model_id, messages,
        AbortSignal.any([controller.signal, AbortSignal.timeout(settings.runTimeoutMs)]));
      return { agent_context: serializeContext(result.messages), changed: result.changed, truncated: result.truncated };
    } catch (error) {
      return reply.code(isContextLimitError(error) ? 413 : 502).send({ error: {
        code: isContextLimitError(error) ? 'AGENT_CONTEXT_LIMIT' : 'COMPACTION_FAILED',
        message: '上下文压缩失败，原有上下文未修改',
      } });
    } finally {
      reply.raw.off('close', onClose);
    }
  });

  app.post('/runs', async (request, reply) => {
    const parsed = runRequestSchema.safeParse(request.body);
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
      // 先由 Agent 获取并选择历史，再进入运行时；访问凭证不会进入模型或运行记录。
      let input: RunInput;
      try {
        input = await buildRunInput(parsed.data, settings.apiBaseUrl, controller.signal);
      } catch {
        if (!response.destroyed) {
          response.write(encodeSse(runFailed(runId, 'AGENT_CONTEXT_LOAD_FAILED', '读取会话历史失败', true)));
        }
        return reply;
      }
      for await (const event of runtime.stream(input, controller.signal)) {
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

  /** 编码内部 SSE；完成事件中的上下文由 Go 保存，不转发给前端。 */
function encodeSse(event: AgentEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify({
    runId: event.runId,
    payload: event.payload,
  })}\n\n`;
}
