import type { ChatOpenAI } from '@langchain/openai';

import type { Settings } from '../config/settings.js';
import { buildModelClients } from '../models/factory.js';
import { extractContentDelta } from '../models/streaming.js';
import { toPublicModel } from '../models/catalog.js';
import type { AgentRuntime, PublicModel, RunInput } from './contracts.js';
import { runFailed, type AgentError, type AgentEvent, type JsonValue } from './events.js';

/** 当前基线：不做 Tool Calling，直接把模型正式回复流归一化成 AgentEvent。 */
export class DirectModelRuntime implements AgentRuntime {
  readonly defaultModelId: string;
  readonly models: PublicModel[];

  private readonly settings: Settings;
  private readonly clients: Map<string, ChatOpenAI>;

  constructor(
    settings: Settings,
    clients: Map<string, ChatOpenAI> = buildModelClients(settings),
  ) {
    this.settings = settings;
    this.clients = clients;
    this.defaultModelId = settings.defaultModelId;
    this.models = settings.models.map(toPublicModel);
  }

  async *stream(input: RunInput): AsyncGenerator<AgentEvent> {
    const model = this.clients.get(input.model_id);
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

    const textParts: string[] = [];
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), this.settings.runTimeoutMs);

    try {
      const messages = [
        { role: 'system', content: this.settings.systemPrompt },
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
      const timedOut = abortController.signal.aborted;
      const agentError: AgentError = timedOut
        ? {
            code: 'MODEL_REQUEST_FAILED',
            message: '模型调用超时',
            retryable: true,
          }
        : {
            code: 'MODEL_REQUEST_FAILED',
            message: '模型调用失败',
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
  }

  async close(): Promise<void> {
    // ChatOpenAI 当前没有需要显式关闭的共享资源，保留接口供未来 Runtime 使用。
  }
}

function failedContent(runId: string, content: string, error: AgentError): AgentEvent {
  return {
    type: 'content.completed',
    runId,
    payload: {
      content,
      format: 'markdown',
      status: 'failed',
      error: error as unknown as JsonValue,
    },
  };
}
