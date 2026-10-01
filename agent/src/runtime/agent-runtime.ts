import { AIMessage, AIMessageChunk, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';
import { Command } from '@langchain/langgraph';
import { askUser, validateAnswers } from '../tools/ask-user.js';

import { createWebAgent, buildSystemPrompt, type WebAgent } from './create-agent.js';
import { toJsonSchema } from '@langchain/core/utils/json_schema';
import { createContextCompaction, estimateTokens, isContextLimitError } from '../memory/compaction.js';
import { toPublicModel, type Settings } from '../config.js';
import { buildModelClients, extractContentDelta } from './models.js';
import { serializeContext } from '../memory/messages.js';
import { createWebSearchTool } from '../tools/web-search.js';
import { webFetch } from '../tools/web-fetch.js';
import { createKnowledgeSearchTool } from '../rag/search/index.js';
import { projectToolResult } from '../tools/presentation.js';
import { withRunRecording, type RecordingCallbacks } from '../recording/with-run-recording.js';
import {
  runFailed,
  type AgentError,
  type AgentEvent,
  type AgentRuntime,
  type RunInput,
  type JsonValue,
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
  knowledge_search: '检索知识库',
  ask_user: '询问用户',
};

/** 初始化可复用的 Agent，返回符合 HTTP 层契约的 Runtime 对象。 */
export function createAgentRuntime(
  settings: Settings,
  clients: Map<string, ChatOpenAI> = buildModelClients(settings),
): AgentRuntime {
  const knowledgeSearch = createKnowledgeSearchTool(settings.rag);
  const tools = [
    createWebSearchTool(settings.bochaApiKey),
    webFetch,
    knowledgeSearch.tool,
    askUser,
  ] as const;

  const agents = new Map<string, WebAgent>();
  // 框架保存执行检查点；这里仅保留跨 SSE 请求的展示累积值和恢复身份。
  const runs = new Map<string, {
    input: RunInput;
    content: string;
    activeTools: Map<string, string>;
    contextTruncated: boolean;
    remainingMs: number;
    busy: boolean;
    controller?: AbortController;
    interaction?: { id: string; questions: z.infer<typeof askUser.schema>['questions'] };
  }>();

  async function discardRun(runId: string, finished = false) {
    const saved = runs.get(runId);
    if (!saved) return;
    // 活跃执行先取消，由它的 finally 在框架停止写检查点后清理。
    if (!finished && saved.busy && saved.controller) {
      saved.controller.abort();
      return;
    }
    runs.delete(runId);
    const checkpointer = agents.get(saved.input.model_id)?.checkpointer;
    if (checkpointer && typeof checkpointer !== 'boolean') await checkpointer.deleteThread(runId);
  }
  const compactions = new Map<string, ReturnType<typeof createContextCompaction>>();
  const summaryClients = buildModelClients(settings, true);
  const fixedInputTokens = estimateTokens(buildSystemPrompt(settings.systemPrompt))
    + estimateTokens(tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: toJsonSchema(tool.schema) })));

  // 按模型组装一次；每次 stream() 的消息和运行状态仍彼此独立。
  for (const [modelId, model] of clients) {
    const config = settings.models.find((entry) => entry.id === modelId);
    const summaryModel = summaryClients.get(modelId);
    if (!config || !summaryModel) throw new Error('Missing memory model configuration');
    const compaction = createContextCompaction(summaryModel, config.contextWindow, fixedInputTokens, config.autoCompactTokenLimit);
    compactions.set(modelId, compaction);
    agents.set(modelId, createWebAgent({
      model,
      prompt: settings.systemPrompt,
      tools,
      compaction: compaction.middleware,
    }));
  }

  return withRunRecording(settings, {
    async close() {
      for (const runId of runs.keys()) await discardRun(runId);
      await knowledgeSearch.close();
    },
    discardRun,
    prepareResume(request) {
      const saved = runs.get(request.run_id);
      if (!saved || !saved.interaction || saved.busy || saved.input.user_id !== request.user_id
        || saved.input.thread_id !== request.thread_id || saved.interaction?.id !== request.interaction_id) {
        throw new Error('交互已失效或已处理');
      }
      const response = validateAnswers(saved.interaction.questions, { answers: request.answers });
      // 同步占用，两个 HTTP 请求不能同时恢复同一检查点。
      saved.busy = true;
      delete saved.controller;
      return { ...saved.input, resume: { interactionId: request.interaction_id, answers: response.answers } };
    },
    defaultModelId: settings.defaultModelId,
    models: settings.models.map(toPublicModel),
    contextUsage(modelId, messages) {
      const config = settings.models.find((entry) => entry.id === modelId);
      if (!config) throw new Error('Model not available');
      // 与压缩阈值共用估算口径，包含主提示词与工具定义；不调用模型。
      const usedTokens = fixedInputTokens + estimateTokens(messages.map((message) => message.toDict()));
      return { modelId, contextWindow: config.contextWindow, usedTokens,
        autoCompactTokenLimit: config.autoCompactTokenLimit,
        remainingTokens: Math.max(0, config.contextWindow - usedTokens) };
    },
    async compact(modelId, messages, signal) {
      const compaction = compactions.get(modelId);
      if (!compaction) throw new Error('Model not available');
      return compaction.compact(messages, { signal, context: {} }, true);
    },

    /** 执行一次请求，转换领域事件，并响应调用方取消或运行超时。 */
    async *stream(
      input: RunInput,
      externalSignal?: AbortSignal,
      recordingCallbacks?: RecordingCallbacks,
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

      if (!input.resume && runs.has(runId)) {
        yield runFailed(runId, 'AGENT_RUN_ACTIVE', '本次任务已在执行', false);
        return;
      }
      if (!input.resume) runs.set(runId, {
        input, content: '', activeTools: new Map<string, string>(), contextTruncated: false,
        remainingMs: settings.runTimeoutMs, busy: true,
      });
      const saved = runs.get(runId);
      if (!saved) {
        yield runFailed(runId, 'INTERACTION_NOT_AVAILABLE', '交互已失效，请重新发送任务', false);
        return;
      }
      // 累积已经发出的正文，供 content.completed 返回完整内容。
      let content = saved.content;
      // 有中途说明不等于最后已经生成有效答复。
      let hasFinalAnswer = false;
      // Agent 按模型复用，但接收结果的变量与回调属于本次 Run，不能共享。
      let finalContext: JsonValue[] | undefined;
      let contextTruncated = saved.contextTruncated;

      // 保存本次运行的失败原因，统一在最后输出终态。
      let failure: AgentError | undefined;

      // toolCallId -> 工具名；只保存尚未结束的调用。
      const activeTools = saved.activeTools;
      let paused = false;

      // 将一次 Run 的取消信号交给框架，再由 Tool 传给实际的 fetch。
      const controller = new AbortController();
      saved.controller = controller;

      // any() 合并调用方取消与内部取消，保留最先触发取消的 reason。
      const signal = externalSignal
        ? AbortSignal.any([externalSignal, controller.signal])
        : controller.signal;

      // 同一个 Run 累计执行时间，等待用户期间不消耗执行预算。
      const segmentStartedAt = Date.now();
      let timeoutTriggered = false;
      const timeout = setTimeout(() => {
        timeoutTriggered = true;
        controller.abort();
      }, Math.max(1, saved.remainingMs));

      try {
        // 已经取消的请求不再启动模型；异常统一交给 catch 收尾。
        signal.throwIfAborted();

        yield { type: input.resume ? 'run.resumed' : 'run.started', runId,
          payload: { modelId: input.model_id } };
        if (!input.resume) yield { type: 'content.started', runId, payload: { format: 'markdown' } };
        signal.throwIfAborted();

        // stream() 真正启动 Agent Loop；不用手动执行 Tool 或回填 ToolMessage。
        const events = await agent.stream(
          input.resume ? new Command({
            resume: { [input.resume.interactionId]: { answers: input.resume.answers } },
          }) : {
            messages: input.contextMessages ?? input.messages,
          },
          {
            // messages 接收文本片段，updates 接收完整步骤结果。
            streamMode: STREAM_MODES,
            configurable: {
              thread_id: input.run_id,
            },
            context: {
              ...(input.user_id === undefined ? {} : { userId: input.user_id }),
              onContextTruncated() { contextTruncated = true; },
              captureMessages(messages: BaseMessage[]) {
                // 先完成 JSON 编码转换，去掉可选的 undefined 字段，并在成功终态前发现编码错误。
                finalContext = z.array(z.json()).parse(
                  JSON.parse(JSON.stringify(serializeContext(messages))),
                );
              },
            },
            // 外部取消或 Run 超时时，框架停止后续模型与工具调用。
            signal,
            ...(recordingCallbacks ? { callbacks: [recordingCallbacks] } : {}),
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
            if (node === '__interrupt__') continue;
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

              // 在展示投影之前交付完整消息；采集边界自行隔离失败并忽略历史重放。
              recordingCallbacks?.recordToolMessage?.(message);

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

        const snapshot = await agent.graph.getState({ configurable: { thread_id: runId } });
        signal.throwIfAborted();
        const pending = snapshot.tasks.flatMap((task) => task.interrupts)[0];
        if (pending) {
          if (!pending.id) throw new Error('Interrupt omitted its id');
          const { questions } = askUser.schema.parse(pending.value);
          saved.content = content;
          saved.contextTruncated = contextTruncated;
          saved.remainingMs -= Date.now() - segmentStartedAt;
          saved.interaction = { id: pending.id, questions };
          paused = true;
          // 一个暂停事件结束当前 SSE 段，业务 Run 仍未结束。
        }

        // 除有效答复和工具终态外，还必须取得最终上下文，供后续持久化使用。
        if (!paused && (!hasFinalAnswer || activeTools.size > 0 || finalContext === undefined)) {
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
          // 区分执行超时和显式取消；等待用户不在计时范围内。
          const timedOut =
            timeoutTriggered &&
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
        } else if (isContextLimitError(error)) {
          failure = { code: 'AGENT_CONTEXT_LIMIT', message: '上下文仍超过模型限制，请缩短输入或手动压缩后重试', retryable: false };
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
        if (!paused) await discardRun(runId, true);
      }

      if (paused && saved.interaction) {
        // 先结束框架迭代和计时器，再开放恢复入口。
        saved.busy = false;
        yield { type: 'run.paused', runId, payload: {
          interactionId: saved.interaction.id,
          questions: JSON.parse(JSON.stringify(saved.interaction.questions)) as JsonValue,
        } };
        return;
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
        yield {
          type: 'run.completed', runId,
          // 内部上下文由 Go 保存，不进入前端的消息完成事件。
          payload: { agentContext: finalContext ?? null, contextTruncated },
        };
      }
    },
  });
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
