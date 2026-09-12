import { AIMessage, AIMessageChunk, ToolMessage } from '@langchain/core/messages';
import type { ChatOpenAI } from '@langchain/openai';

import { createWebAgent, type WebAgent } from '../agent.js';
import { toPublicModel, type Settings } from '../config.js';
import { buildModelClients, extractContentDelta } from '../models.js';
import { createWebSearchTool } from '../tools/web-search.js';
import { webFetch } from '../tools/web-fetch.js';
import { projectToolResult } from '../tools/presentation.js';
import {
  runFailed,
  type AgentError,
  type AgentEvent,
  type AgentRuntime,
  type RunInput,
} from '../protocol.js';

// 当前锁定版本的模型节点名；框架细节只留在 Runtime，不进入前端协议。
const MODEL_NODE = 'model_request';

const STREAM_MODES: Array<'messages' | 'updates'> = [
  'messages',
  'updates',
];

const TOOL_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  web_search: '搜索网页',
  web_fetch: '读取网页',
};

/** 初始化可复用的 Agent，返回符合 HTTP 层契约的 Runtime 对象。 */
export function createAgentRuntime(
  settings: Settings,
  clients: Map<string, ChatOpenAI> = buildModelClients(settings),
): AgentRuntime {
  const tools = [
    createWebSearchTool(settings.qianfanApiKey),
    webFetch,
  ] as const;

  const agents = new Map<string, WebAgent>();

  // 按模型组装一次；每次 stream() 的消息和运行状态仍彼此独立。
  for (const [modelId, model] of clients) {
    agents.set(modelId, createWebAgent({
      model,
      prompt: settings.systemPrompt,
      tools,
    }));
  }

  return {
    defaultModelId: settings.defaultModelId,
    models: settings.models.map(toPublicModel),

    /** 执行一次请求，转换领域事件，并响应调用方取消或运行超时。 */
    async *stream(
      input: RunInput,
      externalSignal?: AbortSignal,
    ): AsyncGenerator<AgentEvent> {
      const runId = input.run_id;
      const agent = agents.get(input.model_id);

      if (!agent) {
        yield runFailed(
          runId,
          'MODEL_NOT_AVAILABLE',
          '所选模型不可用',
          false,
        );
        // 模型不存在时直接结束，不能继续启动 Agent。
        return;
      }

      yield {
        type: 'run.started',
        runId,
        payload: {
          modelId: input.model_id,
        },
      };

      yield {
        type: 'content.started',
        runId,
        payload: {
          format: 'markdown',
        },
      };

      // 累积已经发出的正文，供 content.completed 返回完整内容。
      let content = '';
      // 有中途说明不等于最后已经生成有效答复。
      let hasFinalAnswer = false;

      // 保存本次运行的失败原因，统一在最后输出终态。
      let failure: AgentError | undefined;

      // toolCallId -> 工具名；只保存尚未结束的调用。
      const activeTools = new Map<string, string>();

      // 将一次 Run 的取消信号交给框架，再由 Tool 传给实际的 fetch。
      const controller = new AbortController();

      // any() 合并调用方取消与内部取消，保留最先触发取消的 reason。
      const signal = externalSignal
        ? AbortSignal.any([externalSignal, controller.signal])
        : controller.signal;

      // 总超时限制整轮执行时间，不是每次模型或 Tool 调用重新计时。
      const timeout = setTimeout(() => {
        controller.abort();
      }, settings.runTimeoutMs);

      try {
        // 已经取消的请求不再启动模型；异常统一交给 catch 收尾。
        signal.throwIfAborted();

        // stream() 真正启动 Agent Loop；不用手动执行 Tool 或回填 ToolMessage。
        const events = await agent.stream(
          {
            messages: input.messages,
          },
          {
            // messages 接收文本片段，updates 接收完整步骤结果。
            streamMode: STREAM_MODES,
            // 外部取消或 Run 超时时，框架停止后续模型与工具调用。
            signal,
            // 图步数还包括 Middleware，不能直接等于模型调用次数；业务上限由 Middleware 控制。
            recursionLimit: 50,
          },
        );

        for await (const [mode, data] of events) {
          // 消费者可能在上一次 yield 后取消，不再发送框架已缓冲的内容。
          signal.throwIfAborted();

          if (mode === 'messages') {
            // messages 模式提供消息片段和产生它的节点信息。
            const [message, metadata] = data;

            // 排除 Middleware 产生的内部提示，只显示模型节点的正文。
            if (metadata.langgraph_node !== MODEL_NODE) {
              continue;
            }

            // isInstance() 是 LangChain 的消息类型判断，不把 ToolMessage 当成正文。
            if (
              !AIMessage.isInstance(message) &&
              !AIMessageChunk.isInstance(message)
            ) {
              continue;
            }

            // 复用正文过滤，不发送 reasoning 或工具结果内容。
            const delta = extractContentDelta(message);
            if (!delta) {
              continue;
            }

            content += delta;

            yield {
              type: 'content.delta',
              runId,
              payload: {
                delta,
              },
            };

            continue;
          }

          // updates 按节点提供状态变化，Middleware 的更新可能带出旧消息。
          for (const [node, update] of Object.entries(data)) {
            for (const message of update.messages ?? []) {
              // 只从模型节点登记新调用，避免 Middleware 重放旧消息时重复发 tool.started。
              if (node === MODEL_NODE && AIMessage.isInstance(message)) {
                const calls = message.tool_calls ?? [];

                hasFinalAnswer =
                  // 仍要求调用工具，就还不是最终答复。
                  calls.length === 0 &&
                  // 参数解析失败也不能算完成。
                  (message.invalid_tool_calls?.length ?? 0) === 0 &&
                  // 空回复不能被当成成功。
                  extractContentDelta(message).trim().length > 0;

                for (const call of calls) {
                  // 使用模型提供的真实 ID，才能和后面的 ToolMessage 对应。
                  if (!call.id) {
                    throw new Error('Tool call is missing its id');
                  }

                  activeTools.set(call.id, call.name);

                  yield {
                    type: 'tool.started',
                    runId,
                    payload: {
                      toolCallId: call.id,
                      name: call.name,
                      displayName: TOOL_DISPLAY_NAMES[call.name] ?? call.name,
                      // 完整步骤更新已经拼好了流式 Tool Call 参数。
                      args: call.args,
                    },
                  };
                }
              }

              // ToolMessage 是另一类消息，必须在 AIMessage 分支之外处理。
              // 参数校验或调用上限产生的失败也会出现在 updates 中。
              if (!ToolMessage.isInstance(message)) {
                continue;
              }

              // 用调用 ID 关联，不按工具名猜测。
              const toolCallId = message.tool_call_id;
              const name = activeTools.get(toolCallId);
              if (!name) {
                // 已完成的历史消息可能被 Middleware 再次带出，不能重复发送终态。
                continue;
              }
              // 删除后，这次调用只会发出一次完成或失败事件。
              activeTools.delete(toolCallId);

              if (message.status === 'error') {
                // Tool 失败先交给模型恢复，不在这里把整个 Run 标成失败。
                yield toolFailed(runId, toolCallId, name, '工具执行失败');
              } else {
                // 完整结果仍由框架交给模型；前端只接收标题、URL 等展示数据。
                const result = projectToolResult(name, message);
                yield {
                  type: 'tool.completed',
                  runId,
                  payload: {
                    toolCallId,
                    name,
                    summary: result.summary,
                    result: result.result,
                  },
                };
              }
            }
          }
        }

        // 即使底层流正常关闭，也不能把已经取消的执行标记为成功。
        signal.throwIfAborted();

        // 流结束不一定等于任务完成：还必须有最终答复，且所有工具都有终态。
        if (!hasFinalAnswer || activeTools.size > 0) {
          failure = {
            code: 'AGENT_INCOMPLETE_RESPONSE',
            message: 'Agent 未生成有效的最终答复',
            retryable: false,
          };
        }
      } catch (error) {
        const errorName = error instanceof Error ? error.name : 'UnknownError';

        // 优先看 Run 的信号，避免底层 AbortError 被工具包装后误判成普通异常。
        if (signal.aborted) {
          // 此时尚未进入 finally，内部 controller 只可能被超时计时器取消。
          // 两个来源都取消时，用 reason 判断最先触发的是哪一个。
          const timedOut =
            controller.signal.aborted &&
            signal.reason === controller.signal.reason;

          failure = {
            code: timedOut ? 'AGENT_RUN_TIMEOUT' : 'AGENT_RUN_CANCELLED',
            message: timedOut ? 'Agent 执行超时' : 'Agent 执行已取消',
            retryable: timedOut,
          };
        } else if (
          errorName === 'ModelCallLimitMiddlewareError' ||
          errorName === 'GraphRecursionError'
        ) {
          failure = {
            code: 'AGENT_CALL_LIMIT',
            message: 'Agent 已达到本轮调用上限',
            retryable: false,
          };
        } else {
          failure = {
            code: 'AGENT_EXECUTION_FAILED',
            message: 'Agent 执行失败',
            retryable: true,
          };
        }

        // 主动停止不是服务故障；其他错误也只记录安全字段，不打印原始异常。
        if (failure.code !== 'AGENT_RUN_CANCELLED') {
          console.error('Agent run failed', { runId, errorName });
        }
      } finally {
        // 正常结束、异常或消费者提前结束迭代时，都释放计时器。
        clearTimeout(timeout);
        // 同时通知仍在等待的模型或网络请求停止工作。
        controller.abort();
      }

      if (failure) {
        // Run 中断时补齐未完成工具的终态，前端卡片不能一直停留在“调用中”。
        for (const [toolCallId, name] of activeTools) {
          yield toolFailed(runId, toolCallId, name, '本次运行已终止，工具未完成');
        }
      }

      yield {
        type: 'content.completed',
        runId,
        payload: {
          // 即使失败，也保留用户已经看到的部分正文。
          content,
          format: 'markdown',
          status: failure ? 'failed' : 'completed',
          error: failure ? { ...failure } : null,
        },
      };

      // 每轮只产生一种 Run 终态，HTTP 层不需要了解框架内部的失败类型。
      if (failure) {
        yield runFailed(runId, failure.code, failure.message, failure.retryable);
      } else {
        yield { type: 'run.completed', runId, payload: {} };
      }
    },
  };
}

/** 工具自身失败和 Run 中断共用同一种事件，避免两处返回结构不一致。 */
function toolFailed(
  runId: string,
  toolCallId: string,
  name: string,
  message: string,
): AgentEvent {
  return {
    type: 'tool.failed',
    runId,
    payload: {
      toolCallId,
      name,
      error: { code: 'TOOL_EXECUTION_FAILED', message, retryable: false },
    },
  };
}
