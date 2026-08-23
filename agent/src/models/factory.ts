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

        ...(model.baseUrl
          ? { configuration: { baseURL: model.baseUrl } }
          : {}),
      }),
    ]),
  );
}
