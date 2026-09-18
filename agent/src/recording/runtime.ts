import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { AIMessage, AIMessageChunk, BaseMessage, ToolMessage } from '@langchain/core/messages';
import { z } from 'zod';

import type { Settings } from '../config.js';
import type { AgentEvent, AgentRuntime, JsonValue, RunInput } from '../protocol.js';
import type { openRecordStore } from './store.js';

export interface RecordingCallbacks extends BaseCallbackHandler {
  recordToolMessage?: (message: ToolMessage) => void;
}

// 框架回调只在内部 Runtime 之间传递，不进入 HTTP、SSE 或前端协议。
type RecordableRuntime = Pick<AgentRuntime, 'models' | 'defaultModelId'> & {
  stream(input: RunInput, signal?: AbortSignal, callbacks?: RecordingCallbacks): AsyncGenerator<AgentEvent>;
};

const parameterNames = [
  'model', 'temperature', 'max_tokens', 'max_completion_tokens', 'top_p',
  'presence_penalty', 'frequency_penalty', 'stop', 'tools', 'tool_choice',
  'parallel_tool_calls', 'response_format', 'reasoning_effort', 'reasoning',
  'thinking', 'stream', 'stream_options', 'n', 'seed',
] as const;

/**
 * 统一管理每次 Run 的记录生命周期，同时原样转发业务事件。
 * 每次调用独立持有连接、回调和部分输出；关闭记录时直接返回原 Runtime。
 */
export function withRunRecording(settings: Settings, runtime: RecordableRuntime): AgentRuntime {
  if (!settings.recordingEnabled) return runtime;

  return {
    defaultModelId: runtime.defaultModelId,
    models: runtime.models,
    async *stream(input, signal) {
      if (!input.user_id?.trim()) {
        console.warn('run recording skipped', { runId: input.run_id, reason: 'missing_user_id' });
        yield* runtime.stream(input, signal);
        return;
      }

      let store: ReturnType<typeof openRecordStore> | undefined;
      try {
        // 延迟加载让关闭记录时不依赖 SQLite，也不会产生目录或数据库副作用。
        const { openRecordStore: openStore } = await import('./store.js');
        store = openStore(settings.recordingPath, [
          settings.qianfanApiKey, ...settings.models.map((model) => model.apiKey),
        ]);
        store.startRun({
          runId: input.run_id, userId: input.user_id, threadId: input.thread_id,
          modelId: input.model_id, question: input.messages.at(-1)?.content ?? '',
          input: { messages: input.messages }, startedAt: Date.now(),
        });
      } catch (error) {
        // 不打印原始异常或数据库路径，它们可能夹带敏感配置。
        console.warn('run recording unavailable', { runId: input.run_id, errorName: errorName(error) });
        try {
          store?.close();
        } catch (closeError) {
          console.warn('run recording close failed', { runId: input.run_id, errorName: errorName(closeError) });
        }
        yield* runtime.stream(input, signal);
        return;
      }

      const recordStore = store;
      let recordingFailed = false;
      let closed = false;
      function record(action: () => void): void {
        if (closed || recordingFailed) return;
        try {
          action();
        } catch (error) {
          recordingFailed = true;
          console.warn('run recording interrupted', { runId: input.run_id, errorName: errorName(error) });
        }
      }

      const activeModels = new Map<string, { text: string; chunk?: AIMessageChunk }>();
      const toolRequests = new Map<string, {
        stepId: string;
        ended: boolean;
        metadata: { toolCallId: string; modelStepId: string; executionStarted: boolean;
          executionStartedAt?: number; executionArgs?: JsonValue; frameworkRunId?: string };
      }>();
      const toolExecutions = new Map<string, string>();

      function finishPendingTools(cancelled: boolean, reason: JsonValue): void {
        for (const request of toolRequests.values()) {
          if (request.ended) continue;
          // 正常 Run 终态不能证明未收到回调的工具成功或失败；保留不完整记录。
          if (request.metadata.executionStarted && !cancelled) continue;
          recordStore.finishStep({
            runId: input.run_id, stepId: request.stepId,
            status: request.metadata.executionStarted ? 'cancelled' : 'skipped',
            error: reason, metadata: toJson(request.metadata), endedAt: Date.now(),
          });
          request.ended = true;
        }
      }
      let consumerStopped = false;
      const callbacks: RecordingCallbacks = BaseCallbackHandler.fromMethods({
        handleChatModelStart(_model, batches, stepId, parentId, extra) {
          record(() => {
            const invocation = extra?.['invocation_params'];
            const parameters: Record<string, unknown> = {};
            if (typeof invocation === 'object' && invocation !== null) {
              for (const name of parameterNames) {
                if (name in invocation) parameters[name] = Reflect.get(invocation, name);
              }
            }
            recordStore.startStep({
              runId: input.run_id, stepId, kind: 'model', name: input.model_id,
              input: toJson({
                messageBatches: batches.map((messages) => messages.map(messageSnapshot)),
                parameters,
              }),
              metadata: toJson({ frameworkParentId: parentId }), startedAt: Date.now(),
            });
            activeModels.set(stepId, { text: '' });
          });
        },
        handleLLMNewToken(token, _indices, stepId, _parentId, _tags, fields) {
          // 片段只在内存累积，供失败或取消时保存部分结果，不逐 Token 写数据库。
          record(() => {
            const active = activeModels.get(stepId);
            if (!active) return;
            active.text += token;
            const message = fields?.chunk && 'message' in fields.chunk ? fields.chunk.message : undefined;
            if (AIMessageChunk.isInstance(message)) {
              active.chunk = active.chunk ? active.chunk.concat(message) : message;
            }
          });
        },
        handleLLMEnd(result, stepId) {
          record(() => {
            if (!activeModels.has(stepId)) return;
            recordStore.finishStep({
              runId: input.run_id, stepId, status: 'completed', endedAt: Date.now(),
              output: toJson({
                generations: result.generations.map((batch) => batch.map((generation) => ({
                  text: generation.text,
                  ...('message' in generation && BaseMessage.isInstance(generation.message)
                    ? { message: messageSnapshot(generation.message) } : {}),
                  generationInfo: generation.generationInfo,
                }))),
                llmOutput: result.llmOutput,
              }),
            });
            activeModels.delete(stepId);
            // 模型提出请求不代表工具已执行；先保存原始参数，等待真实 Tool 回调。
            let requestIndex = 0;
            for (const batch of result.generations) {
              for (const generation of batch) {
                if (!('message' in generation) || !AIMessage.isInstance(generation.message)) continue;
                for (const call of generation.message.tool_calls ?? []) {
                  const toolStepId = `tool:${stepId}:${requestIndex++}`;
                  const metadata = { toolCallId: call.id, modelStepId: stepId, executionStarted: false };
                  recordStore.startStep({
                    runId: input.run_id, stepId: toolStepId, kind: 'tool', name: call.name,
                    input: toJson({ requestedArgs: call.args }), metadata: toJson(metadata), startedAt: Date.now(),
                  });
                  if (call.id) {
                    toolRequests.set(call.id, { stepId: toolStepId, ended: false, metadata: { ...metadata, toolCallId: call.id } });
                  } else {
                    recordStore.finishStep({
                      runId: input.run_id, stepId: toolStepId, status: 'skipped', endedAt: Date.now(),
                      error: { code: 'TOOL_MISSING_CALL_ID', message: '模型调用缺少关联 ID，无法执行' },
                    });
                  }
                }
                for (const call of generation.message.invalid_tool_calls ?? []) {
                  const toolStepId = `tool:${stepId}:${requestIndex++}`;
                  recordStore.startStep({
                    runId: input.run_id, stepId: toolStepId, kind: 'tool', name: call.name ?? 'unknown',
                    input: toJson({ requestedArgs: call.args }), startedAt: Date.now(),
                    metadata: toJson({ toolCallId: call.id, modelStepId: stepId, executionStarted: false }),
                  });
                  recordStore.finishStep({
                    runId: input.run_id, stepId: toolStepId, status: 'skipped', endedAt: Date.now(),
                    error: toJson({ code: 'TOOL_INVALID_CALL', message: call.error ?? '模型工具调用参数无法解析' }),
                  });
                }
              }
            }
          });
        },
        handleLLMError(error: unknown, stepId) {
          record(() => {
            const active = activeModels.get(stepId);
            if (!active) return;
            recordStore.finishStep({
              runId: input.run_id, stepId,
              status: signal?.aborted || consumerStopped ? 'cancelled' : 'failed', endedAt: Date.now(),
              output: partialOutput(active), error: errorSnapshot(error),
            });
            activeModels.delete(stepId);
          });
        },
        handleToolStart(_tool, _args, frameworkRunId, _parentId, _tags, _metadata, _name, toolCallId) {
          record(() => {
            if (!toolCallId) return;
            const request = toolRequests.get(toolCallId);
            if (!request || request.ended) return;
            request.metadata.executionStarted = true;
            request.metadata.executionStartedAt = Date.now();
            request.metadata.frameworkRunId = frameworkRunId;
            toolExecutions.set(frameworkRunId, toolCallId);
            recordStore.updateStepMetadata(input.run_id, request.stepId, toJson(request.metadata));
          });
        },
        handleCustomEvent(name, args: unknown, frameworkRunId) {
          if (name !== 'eterion.tool.input') return;
          record(() => {
            const request = toolRequests.get(toolExecutions.get(frameworkRunId) ?? '');
            if (!request || request.ended) return;
            request.metadata.executionArgs = toJson(args);
            recordStore.updateStepMetadata(input.run_id, request.stepId, toJson(request.metadata));
          });
        },
        handleToolEnd(output: unknown, frameworkRunId) {
          record(() => {
            const request = toolRequests.get(toolExecutions.get(frameworkRunId) ?? '');
            if (!request || request.ended) return;
            recordStore.finishStep({
              runId: input.run_id, stepId: request.stepId,
              status: ToolMessage.isInstance(output) && output.status === 'error' ? 'failed' : 'completed',
              output: ToolMessage.isInstance(output) ? messageSnapshot(output) : toJson(output),
              metadata: toJson(request.metadata), endedAt: Date.now(),
            });
            request.ended = true;
          });
        },
        handleToolError(error: unknown, frameworkRunId) {
          record(() => {
            const request = toolRequests.get(toolExecutions.get(frameworkRunId) ?? '');
            if (!request || request.ended) return;
            // 框架在 Run 中止时发出 AbortError；工具自己的网络/超时异常仍算执行失败。
            const cancelled = signal?.aborted || consumerStopped || errorName(error) === 'AbortError';
            recordStore.finishStep({
              runId: input.run_id, stepId: request.stepId, status: cancelled ? 'cancelled' : 'failed',
              error: errorSnapshot(error), metadata: toJson(request.metadata), endedAt: Date.now(),
            });
            request.ended = true;
          });
        },
      });
      callbacks.recordToolMessage = (message) => record(() => {
        const request = toolRequests.get(message.tool_call_id);
        if (!request || request.ended || request.metadata.executionStarted) return;
        // 校验失败、未知工具、额度拦截不会触发 ToolStart；保留框架原始反馈说明原因。
        recordStore.finishStep({
          runId: input.run_id, stepId: request.stepId, status: 'skipped',
          output: messageSnapshot(message),
          error: { code: 'TOOL_NOT_EXECUTED', message: '工具未进入执行，详见框架反馈' },
          metadata: toJson(request.metadata), endedAt: Date.now(),
        });
        request.ended = true;
      });
      // 确保回调完成后再关闭本次连接；不让全局后台回调设置造成遗漏。
      callbacks.awaitHandlers = true;
      callbacks.name = 'eterion-local-recording';

      let content: string | undefined;
      let terminal = false;
      let exhausted = false;
      let escapedError: JsonValue | undefined;
      try {
        for await (const event of runtime.stream(input, signal, callbacks)) {
          if (event.type === 'content.delta' && typeof event.payload['delta'] === 'string') {
            content = (content ?? '') + event.payload['delta'];
          } else if (event.type === 'content.completed' && typeof event.payload['content'] === 'string') {
            content = event.payload['content'];
          }
          if (event.type === 'run.completed' || event.type === 'run.failed') {
            terminal = true;
            const error = event.payload['error'];
            const cancelled = error !== null && typeof error === 'object' && !Array.isArray(error)
              && error['code'] === 'AGENT_RUN_CANCELLED';
            record(() => {
              const interrupted = cancelled || (error !== null && typeof error === 'object' && !Array.isArray(error)
                && error['code'] === 'AGENT_RUN_TIMEOUT');
              finishPendingTools(interrupted, error ?? { code: 'TOOL_NOT_EXECUTED', message: '运行结束前未执行工具' });
              recordStore.finishRun({
                runId: input.run_id,
                status: event.type === 'run.completed' ? 'completed' : cancelled ? 'cancelled' : 'failed',
                ...(content !== undefined ? { output: content } : {}),
                ...(error !== undefined ? { error } : {}), endedAt: Date.now(),
              });
            });
          }
          // 外层消费者 return/throw 时，先标记主动停止，再让 for-await 关闭内层模型流。
          // 否则 Direct 在关闭时抛出的 AbortError 会被误记为模型执行失败。
          let resumed = false;
          try {
            yield event;
            resumed = true;
          } finally {
            if (!resumed && !terminal) consumerStopped = true;
          }
        }
        exhausted = true;
      } catch (error) {
        escapedError = errorSnapshot(error);
        throw error;
      } finally {
        if (!terminal) {
          // 消费者提前结束迭代（例如 HTTP 断开）也必须留下可复盘的收尾记录。
          const cancelled = signal?.aborted || (!exhausted && escapedError === undefined);
          const status = cancelled ? 'cancelled' : 'failed';
          const error = escapedError ?? {
            code: cancelled ? 'AGENT_RUN_CANCELLED' : 'AGENT_STREAM_INCOMPLETE',
            message: cancelled ? '运行消费已停止' : '事件流未提供运行终态',
          };
          record(() => {
            finishPendingTools(cancelled, error);
            for (const [stepId, active] of activeModels) {
              recordStore.finishStep({
                runId: input.run_id, stepId, status, output: partialOutput(active),
                error, endedAt: Date.now(),
              });
            }
            recordStore.finishRun({
              runId: input.run_id, status, ...(content !== undefined ? { output: content } : {}),
              error, endedAt: Date.now(),
            });
          });
        }
        // 即使记录曾失败，也要释放连接；关闭错误同样不能覆盖业务结果。
        closed = true;
        try {
          recordStore.close();
        } catch (error) {
          console.warn('run recording close failed', { runId: input.run_id, errorName: errorName(error) });
        }
      }
    },
  };
}

function messageSnapshot(message: BaseMessage): JsonValue {
  // 只抽取消息字段，不序列化模型实例、SDK 配置或认证请求头。
  return toJson({
    type: message.type, content: message.content, name: message.name,
    additional_kwargs: message.additional_kwargs, response_metadata: message.response_metadata,
    ...(AIMessage.isInstance(message) ? {
      tool_calls: message.tool_calls, invalid_tool_calls: message.invalid_tool_calls,
      usage_metadata: message.usage_metadata,
    } : {}),
    ...(ToolMessage.isInstance(message) ? {
      tool_call_id: message.tool_call_id, status: message.status, artifact: message.artifact,
    } : {}),
  });
}

function partialOutput(active: { text: string; chunk?: AIMessageChunk }): JsonValue {
  return toJson({ partial: true, text: active.text, ...(active.chunk ? { message: messageSnapshot(active.chunk) } : {}) });
}

function toJson(value: unknown): JsonValue {
  // 快照中省略 undefined，保留明确的 null；不使用断言把任意 SDK 对象冒充 JSON。
  return z.json().parse(JSON.parse(JSON.stringify(value)));
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

function errorSnapshot(error: unknown): JsonValue {
  return { name: errorName(error), message: error instanceof Error ? error.message : 'Unknown error' };
}
