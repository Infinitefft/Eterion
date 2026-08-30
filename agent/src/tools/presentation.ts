import { z } from 'zod';

import type { JsonValue } from '../runtime/events.js';

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
  const output = unwrapToolOutput(rawOutput);

  if (toolName === 'web_search') {
    const parsed = webSearchResultSchema.safeParse(output);
    if (!parsed.success) return unknownResult('网页搜索已完成');

    return {
      summary: `找到 ${parsed.data.results.length} 个相关网页`,
      result: parsed.data,
    };
  }

  if (toolName === 'web_fetch') {
    const parsed = webFetchResultSchema.safeParse(output);
    if (!parsed.success) return unknownResult('网页读取已完成');

    const { url, title, truncated } = parsed.data;
    return {
      summary: `已读取网页：${title}`,
      // content 只供模型总结，不能进入前端 Tool 卡片。
      result: { url, title, truncated },
    };
  }

  return unknownResult('工具调用已完成');
}

/**
 * Agent 调用 Tool 时，LangChain 会把返回值包装成 ToolMessage。
 * 对象结果通常位于 content 中，并被 JSON.stringify() 转换成字符串。
 */
function unwrapToolOutput(rawOutput: unknown): unknown {
  if (
    !isRecord(rawOutput) ||
    !('tool_call_id' in rawOutput) ||
    !('content' in rawOutput)
  ) {
    return rawOutput;
  }

  const content = rawOutput.content;
  if (typeof content !== 'string') return content;

  try {
    return JSON.parse(content) as unknown;
  } catch {
    return content;
  }
}

function unknownResult(summary: string): ToolPresentation {
  return { summary, result: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
