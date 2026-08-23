import { tool } from '@langchain/core/tools';
import { z } from 'zod';

const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';

/**
 * Zod 类似前端常用的表单 Schema：既校验模型参数，也生成 Tool JSON Schema。
 * 模型会根据字段 description 判断应该传什么内容。
 */
const webSearchInputSchema = z.object({
  query: z.string().min(1).max(400).describe('需要搜索的关键词或问题'),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(5)
    .describe('需要返回的网页数量，默认 5，最多 10'),
});

/**
 * 一个真正调用 Brave Search API 的网页搜索 Tool。
 *
 * tool() 会把函数、名称、描述和 Zod Schema 组合成模型能理解的 Tool。
 * 当前它还没有注册给 Direct Runtime；后续 Agent Runtime 只需放入 tools 数组。
 */
export const webSearch = tool(
  async ({ query, maxResults }) => {
    const apiKey = process.env.BRAVE_SEARCH_API_KEY?.trim();
    if (!apiKey) {
      throw new Error('BRAVE_SEARCH_API_KEY 未配置，无法使用网页搜索');
    }

    // URLSearchParams 相当于 Axios 的 params，会安全编码中文和空格。
    const params = new URLSearchParams({
      q: query,
      count: String(maxResults),
      result_filter: 'web',
      text_decorations: 'false',
      safesearch: 'moderate',
    });

    let response: Response;
    try {
      response = await fetch(`${BRAVE_SEARCH_URL}?${params}`, {
        headers: {
          Accept: 'application/json',
          'X-Subscription-Token': apiKey,
        },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new Error('网页搜索服务请求超时', { cause: error });
      }
      throw new Error('无法连接到 Brave Search API', { cause: error });
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error('Brave Search API Key 无效或没有访问权限');
      }
      if (response.status === 429) {
        throw new Error('Brave Search API 请求过于频繁');
      }
      throw new Error(`Brave Search API 请求失败，状态码：${response.status}`);
    }

    const data: unknown = await response.json();
    const rawResults = readWebResults(data);
    const seenUrls = new Set<string>();
    const results: Array<{ title: string; url: string; snippet: string }> = [];

    for (const item of rawResults) {
      if (!isRecord(item)) continue;

      const title = typeof item.title === 'string' ? item.title.trim() : '';
      const url = typeof item.url === 'string' ? item.url : '';
      const snippet = typeof item.description === 'string' ? item.description.trim() : '';

      if (!title || !url.startsWith('http') || seenUrls.has(url)) continue;
      seenUrls.add(url);
      results.push({ title, url, snippet });

      if (results.length >= maxResults) break;
    }

    // 返回 JSON 兼容结构：模型能读，未来也能直接放进 tool.completed.payload。
    return { query, results };
  },
  {
    name: 'web_search',
    description:
      '搜索公开互联网中的网页。用户要求查找网页、资料或最新公开信息时使用；返回标题、URL 和摘要，不读取网页全文。',
    schema: webSearchInputSchema,
  },
);

function readWebResults(data: unknown): unknown[] {
  if (!isRecord(data) || !isRecord(data.web) || !Array.isArray(data.web.results)) {
    return [];
  }
  return data.web.results;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
