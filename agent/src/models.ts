import { ChatOpenAI } from '@langchain/openai';

import type { Settings } from './config.js';

/** SDK 创建集中在这里，Runtime 不感知 API Key、Base URL 等厂商细节。 */
export function buildModelClients(settings: Settings): Map<string, ChatOpenAI> {
  return new Map(
    settings.models.map((model) => [
      model.id,
      new ChatOpenAI({
        model: model.providerModel,
        apiKey: model.apiKey,
        timeout: settings.modelTimeoutMs,
        maxRetries: 2,

        // 部分 OpenAI-compatible 服务不支持 stream_options。
        streamUsage: false,

        ...(model.provider === 'deepseek'
          ? {
              /**
               * DeepSeek 默认开启 Thinking。Thinking 与多轮 Tool Calling 组合时，
               * 必须额外回传 reasoning_content；第一阶段先关闭，单独验证后再开启。
               *
               * modelKwargs 会把 SDK 未显式声明的厂商参数透传给 Chat API。
               */
              modelKwargs: {
                thinking: { type: 'disabled' },

                // 请求模型不要并行调用 Tools；这不是 Runtime 的并发锁。
                parallel_tool_calls: false,
              },
            }
          : {}),

        ...(model.baseUrl
          ? { configuration: { baseURL: model.baseUrl } }
          : {}),
      }),
    ]),
  );
}

/**
 * 不同 Provider 的 chunk 形状可能不同，这里只抽取正式 Content。
 * reasoning/tool-call block 不能误混进前端正式回复。
 */
export function extractContentDelta(chunk: unknown): string {
  if (!isRecord(chunk)) return '';

  if (typeof chunk.text === 'string' && chunk.text) {
    return chunk.text;
  }

  const content = chunk.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .filter(isRecord)
    .filter((block) => block.type === 'text' || block.type === 'output_text')
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
