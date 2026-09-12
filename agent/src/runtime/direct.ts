import type { ChatOpenAI } from '@langchain/openai';

import { toPublicModel, type Settings } from '../config.js';
import { buildModelClients, extractContentDelta } from '../models.js';
import {
  runFailed,
  type AgentError,
  type AgentEvent,
  type AgentRuntime,
  type RunInput,
} from '../protocol.js';

/** 当前基线：不做 Tool Calling，直接把模型正式回复流归一化成 AgentEvent。 */
export function createDirectRuntime(
  settings: Settings,
  clients: Map<string, ChatOpenAI> = buildModelClients(settings),
): AgentRuntime {
  // 闭包让返回的 stream() 继续访问配置和客户端，无需 class、this 或全局单例。
  return {
    defaultModelId: settings.defaultModelId,
    models: settings.models.map(toPublicModel),

    /** 流式输出模型正文，并响应调用方取消或本轮超时。 */
    async *stream(
      input: RunInput,
      externalSignal?: AbortSignal,
    ): AsyncGenerator<AgentEvent> {
      const model = clients.get(input.model_id);
      if (!model) {
        yield runFailed(input.run_id, 'MODEL_NOT_AVAILABLE', '所选模型不可用', false);
        return;
      }

      yield {
        type: 'run.started',
        runId: input.run_id,
        payload: { modelId: input.model_id },
      };
      yield {
        type: 'content.started',
        runId: input.run_id,
        payload: { format: 'markdown' },
      };

      // 每轮请求独立保存正文和取消信号，不能放到共享的工厂作用域中。
      const textParts: string[] = [];
      const abortController = new AbortController();

      // Direct 基线也接收外部取消，不能在切回基线后失去停止能力。
      const signal = externalSignal
        ? AbortSignal.any([externalSignal, abortController.signal])
        : abortController.signal;
      const timeout = setTimeout(() => abortController.abort(), settings.runTimeoutMs);

      try {
        // 已取消时不再发起模型请求。
        signal.throwIfAborted();

        const messages = [
          { role: 'system', content: settings.systemPrompt },
          ...input.messages,
        ];
        const chunks = await model.stream(messages, { signal });

        for await (const chunk of chunks) {
          // 外部取消后，不再转发已经缓冲的正文片段。
          signal.throwIfAborted();

          const delta = extractContentDelta(chunk);
          if (!delta) continue;

          textParts.push(delta);
          yield {
            type: 'content.delta',
            runId: input.run_id,
            payload: { delta },
          };
        }
        // 某些流取消后直接结束，仍需要阻止下面发送成功终态。
        signal.throwIfAborted();
      } catch (error) {
        // 组合信号的 reason 来自最先取消的一方，不按异常名称猜测。
        const cancelled =
          signal.aborted && signal.reason !== abortController.signal.reason;
        const agentError: AgentError = cancelled
          ? {
              code: 'AGENT_RUN_CANCELLED',
              message: 'Agent 执行已取消',
              retryable: false,
            }
          : {
              // 保留 Direct 原有的模型失败与超时错误契约。
              code: 'MODEL_REQUEST_FAILED',
              message: abortController.signal.aborted ? '模型调用超时' : '模型调用失败',
              retryable: true,
            };

        // 主动取消不记为故障；不输出可能包含密钥或取消原因的原始异常。
        if (!cancelled) {
          console.error('model request failed', {
            runId: input.run_id,
            errorName: error instanceof Error ? error.name : 'UnknownError',
          });
        }
        yield failedContent(input.run_id, textParts.join(''), agentError);
        yield runFailed(
          input.run_id,
          agentError.code,
          agentError.message,
          agentError.retryable,
        );
        return;
      } finally {
        clearTimeout(timeout);
        // 消费者提前结束迭代时，也通知仍在等待的模型请求停止。
        abortController.abort();
      }

      const content = textParts.join('');
      if (!content.trim()) {
        const error: AgentError = {
          code: 'AGENT_EMPTY_RESPONSE',
          message: '模型没有返回有效文本',
          retryable: false,
        };
        yield failedContent(input.run_id, content, error);
        yield runFailed(input.run_id, error.code, error.message, error.retryable);
        return;
      }

      yield {
        type: 'content.completed',
        runId: input.run_id,
        payload: {
          content,
          format: 'markdown',
          status: 'completed',
          error: null,
        },
      };
      yield { type: 'run.completed', runId: input.run_id, payload: {} };
    },
  };
}

/** 结束已开始的正文块；失败或取消时仍保留用户已经看到的内容。 */
function failedContent(runId: string, content: string, error: AgentError): AgentEvent {
  return {
    type: 'content.completed',
    runId,
    payload: {
      content,
      format: 'markdown',
      status: 'failed',
      error: { ...error },
    },
  };
}
