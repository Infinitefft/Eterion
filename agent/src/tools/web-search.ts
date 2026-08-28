import { tool } from '@langchain/core/tools';
import { z } from 'zod';

const BRAVE_SEARCH_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const SEARCH_TIMEOUT_MS = 10_000;

/** 只校验当前 Tool 真正使用的 Brave Search 响应字段。 */
const braveSearchResponseSchema = z.object({
  web: z
    .object({
      results: z.array(
        z.object({
          title: z.string(),
          url: z.string().url(),
        }),
      ),
    })
    .optional(),
});

/** 创建一个只返回网页标题和 URL、不读取网页正文的搜索 Tool。 */
export function createWebSearchTool(apiKey: string) {
  const normalizedApiKey = apiKey.trim();

  if (!normalizedApiKey) {
    throw new Error('BRAVE_SEARCH_API_KEY is required');
  }

  return tool(
    async ({ query, count }) => {
      const searchParams = new URLSearchParams({
        q: query,
        count: String(count),
        safesearch: 'moderate',
      });

      let response: Response;

      try {
        response = await fetch(
          `${BRAVE_SEARCH_ENDPOINT}?${searchParams.toString()}`,
          {
            method: 'GET',
            headers: {
              Accept: 'application/json',
              'X-Subscription-Token': normalizedApiKey,
            },
            signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
          },
        );
      } catch (error) {
        throw new Error('web_search request failed', { cause: error });
      }

      if (!response.ok) {
        throw new Error(
          `web_search request failed with HTTP ${response.status}`,
        );
      }

      const rawBody: unknown = await response.json();
      const parsedBody = braveSearchResponseSchema.safeParse(rawBody);

      if (!parsedBody.success) {
        throw new Error('Brave Search returned an invalid response');
      }

      const results = (parsedBody.data.web?.results ?? [])
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
          .max(400)
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
