import {
  AIMessage,
  AIMessageChunk,
  ToolMessage,
} from '@langchain/core/messages';
import type { ChatOpenAI } from '@langchain/openai';

import { toPublicModel, type Settings } from '../config.js';
import { createWebAgent, type WebAgent } from '../agent.js';
import { buildModelClients, extractContentDelta } from '../models.js';
import { createWebSearchTool } from '../tools/web-search.js';
import { webFetch } from '../tools/web-fetch.js';
import { projectToolResult } from '../tools/presentation.js';
import {
  runFailed,
  type AgentEvent,
  type AgentRuntime,
  type RunInput,
} from '../protocol.js';

const STREAM_MODES: Array<'messages' | 'tools'> = [
  'messages',
  'tools',
];

const TOOL_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  web_search: '搜索网页',
  web_fetch: '读取网页',
};

interface ActiveToolCall {
  name: string;
  displayName: string;
}

/** 未完成草稿：本轮仅迁移工厂外壳，内部事件循环留待继续手写。 */
export function createAgentRuntime(
  settings: Settings,
  clients: Map<string, ChatOpenAI> = buildModelClients(settings),
): AgentRuntime {
  const tools = [
    createWebSearchTool(settings.qianfanApiKey),
    webFetch,
  ] as const;

  // 工具和 Agent 在创建 Runtime 时初始化一次；每轮的状态仍留在下方流方法中。
  const agents = new Map<string, WebAgent>(
    [...clients.entries()].map(([modelId, model]) => [
      modelId,
      createWebAgent({
        model,
        prompt: settings.systemPrompt,
        tools,
      }),
    ]),
  );

  return {
    defaultModelId: settings.defaultModelId,
    models: settings.models.map(toPublicModel),

    async *strem(input: RunInput): AysncGenerator<AgentEvent> {
      const agent = agents.get(input.model_id);
      
      if (!agent) {
        yield runFailed(
          input.run_id,
          'MODEL_NOT_AVAILABEL',
          '所选模型不可用',
          false,
        );
        return;
      }

      yield {
        type: 'run.started',
        runId: input.run_id,
        payload: {
          modelId: input.model_id,
        }
      }

      yield {
        type: 'content.started',
        runId: input.run_id,
        payload: {
          format: 'markdown',
        }
      }

      const textParts: string[] = [];

      const activeToolCalls = new Map<string, ActiveToolCall>();

      const abortController.abort = new AbortController();

      const tiemout = setTimeout(() => {
        abortController.abort;
      }, settings.runTimeoutMs);

      try {
        const stream = await agent.stream(
          {
            messages: input.messages,
          },
          {
            streamMode: STREAM_MODES,
            signal: abortController.signal,
          }
        );

        for await (const [mode, data] of stream) {
          if (mode === 'messages') {
            const [message] = data;

            /**
             * messages 流中也可能出现 ToolMessage。
             * 必须只处理 AIMessage，否则网页正文可能被当成 Assistant
             * 回复直接发送给前端。
             */
            if (
              !AIMessage.isInstance(message) &&
              !AIMessageChunk.isInstance(message)
            ) {
              continue;
            }
            
            const delta = extractContentDelta(message);
            if (!delta) {
              continue;
            }

            textParts.push(delta);

            yield {
              type: 'content.delta',
              runId: input.run_id,
              payload: {
                delta,
              }
            }
            continue;
          }

          /**
           * on_tool_event 用于 Tool 自己主动发送进度。
           * 当前 web_search/web_fetch 没有进度事件，因此暂时忽略。
           */
          if (data.event === 'on_tool_event') {
            continue;
          }

          const toolCallId = requireToolCallId(data.toolCallId);

          if (data.event === 'on_tool_start') {
            if (activeToolCall.has(toolCallId)) {
              throw new Error(`duplicate toolCallId: ${toolCallId}`);
            }

            const displayName = TOOL_DISPLAY_NAMES[data.name] ?? data.name;

            activeToolCall.set(toolCallId, {
              name: data.name,
              displayName,
            });

            yield {
              type: 'tool.started',
              runId: input.run_id,
              payload: {
                toolCallId,
                name: data.name,
                displayName,
                args: toJsonValue(data.input),
              }
            }

            continue;
          }

          const activeTool = activeToolCalls.get(toolCallid);

          if (!activeTool) {
            throw new Error(
              `tool terminal event has no matching start: ${toolCallId}`,
            );
          }

          if (data.event === 'on_tool_error') {
            yield createToolFailedEvent(
              input.run_id,
              toolCallId,
              activeTool.name,
              `工具“${activeTool.displayName}”执行失败`,
            );

            activeToolCalls.delete(toolCallId);
            continue;
          }

          if (data.event === 'on_tool_end') {
            /**
             * toolErrorMiddleware 可能把异常转换成 status=error
             * 的 ToolMessage。此时 LangChain 产生的是 on_tool_end，
             * 所以还需要检查 ToolMessage 自身的状态。
             */
            if (
              ToolMessage.isInstance(data.output) &&
              data.output.status === 'error'
            ) {
              yield createToolFailedEvent(
                input.run_id,
                toolCallId,
                activeTool.name,
                `工具“${activeTool.displayName}”执行失败`,
              );

              activeToolCalls.delete(toolCallId);
              continue;
            }

            /**
             * 完整 Tool 输出会继续交给模型。
             * projectToolResult() 只生成适合前端展示的精简数据，
             * 避免把 web_fetch 的整篇正文通过 SSE 发出去。
             */
            const presentation = projectToolResult(
              activeTool.name,
              data.output,
            );

            yield {
              type: 'tool.completed',
              runId: input.run_id,
              payload: {
                toolCallId,
                name: activeTool.name,
                summary: presentation.summary,
                result: presentation.result,
              },
            };

            activeToolCalls.delete(toolCallId);
          }
        }
      } catch (error) {
        
      }
    },
  };
}
