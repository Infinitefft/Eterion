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

    async *stream(input: RunInput): AsyncGenerator<AgentEvent> {
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
      const timeout = setTimeout(() => abortController.abort(), settings.runTimeoutMs);

      try {
        const messages = [
          { role: 'system', content: settings.systemPrompt },
          ...input.messages,
        ];
        const chunks = await model.stream(messages, { signal: abortController.signal });

        for await (const chunk of chunks) {
          const delta = extractContentDelta(chunk);
          if (!delta) continue;

          textParts.push(delta);
          yield {
            type: 'content.delta',
            runId: input.run_id,
            payload: { delta },
          };
        }
      } catch (error) {
        const agentError: AgentError = {
          code: 'MODEL_REQUEST_FAILED',
          message: abortController.signal.aborted ? '模型调用超时' : '模型调用失败',
          retryable: true,
        };

        console.error('model request failed', { runId: input.run_id, error });
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
