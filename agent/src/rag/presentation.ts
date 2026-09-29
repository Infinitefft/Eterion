import { z } from 'zod';
import type { ToolPresentation } from '../tools/presentation.js';

// 通过白名单只投影来源；完整正文留在 ToolMessage 中供模型使用。
const resultSchema = z.object({
  query: z.string(),
  results: z.array(z.object({
    chunkId: z.uuid(), fileId: z.uuid(), knowledgeBaseId: z.uuid(), fileName: z.string(),
    sectionId: z.uuid(), chunkIndex: z.number().int().nonnegative(), headingPath: z.array(z.string()),
    startOffset: z.number().int().nonnegative().optional(),
    endOffset: z.number().int().positive().optional(),
  })),
});

export function projectKnowledgeSearchResult(output: unknown): ToolPresentation {
  const parsed = resultSchema.safeParse(output);
  if (!parsed.success) return { summary: '知识库检索已完成', result: null };
  const results = parsed.data.results.map(({ startOffset, endOffset, ...source }) =>
    startOffset !== undefined && endOffset !== undefined && startOffset < endOffset
      ? { ...source, startOffset, endOffset }
      : source);
  return {
    summary: results.length === 0 ? '未检索到资料片段' : '检索到 ' + results.length + ' 个资料片段',
    result: { query: parsed.data.query, results },
  };
}
