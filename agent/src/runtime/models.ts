import { ChatOpenAI } from '@langchain/openai';

import { MODEL_MAX_OUTPUT_TOKENS, type Settings } from '../config.js';

/** SDK 创建集中在这里，Runtime 不感知 API Key、Base URL 等厂商细节。 */
export function buildModelClients(settings: Settings, summary = false): Map<string, ChatOpenAI> {
  return new Map(
    settings.models.map((model) => [
      model.id,
      new ChatOpenAI({
        model: model.providerModel,
        apiKey: model.apiKey,
        timeout: settings.modelTimeoutMs,
        maxRetries: summary ? 0 : 2,
        // 正式回答为长代码留出空间；摘要和标题保持较小的输出预算。
        maxTokens: summary ? 4096 : MODEL_MAX_OUTPUT_TOKENS,

        // 部分 OpenAI-compatible 服务不支持 stream_options。
        streamUsage: false,

        ...(model.provider === 'deepseek'
          ? {
              /**
               * 正式对话开启 Thinking；内部摘要与标题保持关闭。
               * 多轮工具调用的 reasoning_content 回传由已登记的 SDK 补丁保留。
               *
               * modelKwargs 会把 SDK 未显式声明的厂商参数透传给 Chat API。
               */
              modelKwargs: {
                thinking: { type: summary ? 'disabled' : 'enabled' },

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

/** 只读取模型明确公开的思考字段，不从普通正文猜测。 */
export function extractThinkingDelta(chunk: unknown): string {
  if (!isRecord(chunk) || !isRecord(chunk.additional_kwargs)) return '';
  const reasoning = chunk.additional_kwargs.reasoning_content;
  return typeof reasoning === 'string' ? reasoning : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
