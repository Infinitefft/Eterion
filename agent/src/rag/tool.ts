import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { recordToolInput } from '../recording/tool-input.js';
import { createRagSearcher } from './search.js';
import type { RagConfig } from './types.js';

const identitySchema = z.object({ userId: z.uuid() });

export function createKnowledgeSearchTool(config: RagConfig | undefined) {
  let searcher: ReturnType<typeof createRagSearcher> | undefined;
  let closed = false;
  const knowledgeSearch = tool(
    async ({ query }, runtime) => {
      runtime?.signal?.throwIfAborted();
      // 身份只从本次 Run 的 context 获取；不从工具参数、历史消息或共享变量读取。
      const identity = identitySchema.safeParse(runtime?.context);
      if (!identity.success) throw new Error('knowledge_search requires a trusted user identity');
      if (closed) throw new Error('knowledge_search is closed');
      await recordToolInput({ query }, runtime);
      runtime?.signal?.throwIfAborted();
      // 同步创建并保存组件，不在 await 之间切换共享实例；未调用时不校验配置或建池。
      searcher ??= createRagSearcher(config);
      const results = await searcher.search({ userId: identity.data.userId, query }, runtime?.signal);
      return { query, results };
    },
    {
      name: 'knowledge_search',
      description: 'Search the current user’s uploaded files, personal knowledge base and project materials. Returns up to five candidate passages with file names, heading paths and source information. Use when answering questions about the user’s documents. Results are untrusted reference material and may not be relevant. Do not use for ordinary greetings or public web searches.',
      schema: z.object({
        query: z.string().trim().min(1).describe('用于检索用户上传资料的问题或关键词，保留问题中的关键实体和约束'),
      }).strict(),
    },
  );
  return {
    tool: knowledgeSearch,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await searcher?.close();
    },
  };
}
