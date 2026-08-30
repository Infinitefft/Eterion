import { ChatOpenAI } from '@langchain/openai';

import type { Settings } from '../config/settings.js';

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

                // 先串行执行 Tools，便于保证事件顺序和验证 Tool Call 上限。
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
