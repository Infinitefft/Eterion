import { tool } from '@langchain/core/tools';
import { z } from 'zod';

const QIANFAN_SEARCH_ENDPOINT =
  'https://qianfan.baidubce.com/v2/ai_search/web_search';
const SEARCH_TIMEOUT_MS = 10_000;

/**
 * zod 在运行时检查外部 API 的返回值，避免把不符合预期的数据交给模型。
 * 这里只声明 Tool 真正需要的 title 和 url，不复制百度响应的所有字段。
 */
const qianfanSearchResponseSchema = z.object({
  code: z.union([z.string(), z.number()]).optional(),
  references: z
    .array(
      z.object({
        title: z.string(),
        url: z.string().url(),
      }),
    )
    .optional(),
});

/** 创建一个只返回网页标题和 URL、不读取网页正文的搜索 Tool。 */
export function createWebSearchTool(apiKey: string) {
  const normalizedApiKey = apiKey.trim();

  if (!normalizedApiKey) {
    throw new Error('QIANFAN_API_KEY is required');
  }

  return tool(
    async ({ query, count }) => {
      let response: Response;

      try {
        response = await fetch(QIANFAN_SEARCH_ENDPOINT, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            // 百度千帆通过 Bearer 方式认证 API Key，Key 不会出现在 URL 中。
            Authorization: `Bearer ${normalizedApiKey}`,
          },
          // 超时后中止 fetch，防止搜索服务卡住整个 Agent 循环。
          signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
          body: JSON.stringify({
            messages: [{ role: 'user', content: query }],
            search_source: 'baidu_search_v2',
            // 只搜索网页；top_k 对应 Tool 参数 count。
            resource_type_filter: [{ type: 'web', top_k: count }],
            safe_search: true,
          }),
        });
      } catch (error) {
        throw new Error('web_search request failed', { cause: error });
      }

      if (!response.ok) {
        throw new Error(
          `web_search request failed with HTTP ${response.status}`,
        );
      }

      const rawBody: unknown = await response.json();
      // safeParse 不会抛出异常，而是返回 success 标记供我们判断。
      const parsedBody = qianfanSearchResponseSchema.safeParse(rawBody);

      if (!parsedBody.success) {
        throw new Error('Qianfan Search returned an invalid response');
      }

      // 百度在业务错误时可能返回 code，即使 HTTP 状态码是成功也不应当作搜索结果。
      if (parsedBody.data.code !== undefined) {
        throw new Error('Qianfan Search returned an error');
      }

      const results = (parsedBody.data.references ?? [])
        .slice(0, count)
        .map((result) => ({
          title: result.title,
          url: result.url,
        }));

      return {
        query,
        results,
      };
    },
    {
      name: 'web_search',
      description:
        'Search the public web for relevant webpages. Use this when the user requests an online search or needs current information. Returns webpage titles and URLs only; it does not open or read page contents.',
      schema: z.object({
        query: z
          .string()
          .trim()
          .min(1)
          .max(72)
          .describe('Search query sent to the web search engine'),
        count: z
          .number()
          .int()
          .min(1)
          .max(10)
          .default(5)
          .describe('Maximum number of search results to return'),
      }),
    },
  );
}
