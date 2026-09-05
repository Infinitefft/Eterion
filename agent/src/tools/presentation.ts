import { z } from 'zod';

import type { JsonValue } from '../protocol.js';

export interface ToolPresentation {
  summary: string;
  result: JsonValue;
}

const webSearchResultSchema = z.object({
  query: z.string(),
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
    }),
  ),
});

const webFetchResultSchema = z.object({
  url: z.string(),
  title: z.string(),
  content: z.string(),
  truncated: z.boolean(),
});

/**
 * Tool 的完整输出会返回给模型，但前端只需要适合展示的精简数据。
 * 尤其不能把 web_fetch 的整篇网页正文塞进 SSE 和聊天状态。
 */
export function projectToolResult(
  toolName: string,
  rawOutput: unknown,
): ToolPresentation {
  let output = rawOutput;

  // LangChain 通常把 Tool 对象结果序列化到 ToolMessage.content 中。
  // 直接调用 Tool 时收到的普通对象则不需要解包。
  if (
    typeof rawOutput === 'object' &&
    rawOutput !== null &&
    'tool_call_id' in rawOutput &&
    'content' in rawOutput
  ) {
    output = rawOutput.content;
    if (typeof output === 'string') {
      try {
        output = JSON.parse(output) as unknown;
      } catch {
        // 非 JSON 内容交给下方 Schema 判断，降级为仅展示完成状态。
      }
    }
  }

  if (toolName === 'web_search') {
    const parsed = webSearchResultSchema.safeParse(output);
    if (!parsed.success) return { summary: '网页搜索已完成', result: null };

    return {
      summary: `找到 ${parsed.data.results.length} 个相关网页`,
      result: parsed.data,
    };
  }

  if (toolName === 'web_fetch') {
    const parsed = webFetchResultSchema.safeParse(output);
    if (!parsed.success) return { summary: '网页读取已完成', result: null };

    const { url, title, truncated } = parsed.data;
    return {
      summary: `已读取网页：${title}`,
      // content 只供模型总结，不能进入前端 Tool 卡片。
      result: { url, title, truncated },
    };
  }

  return { summary: '工具调用已完成', result: null };
}
