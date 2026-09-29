import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import {
  buildEmbeddingText,
  countBudgetTokens,
  EMBEDDING_TEXT_BUDGET,
  MAX_OVERLAP_BUDGET,
} from './embedding-text.js';
import { parseMarkdownSections } from './markdown.js';
import type { MarkdownSection, PrepareChunksInput, RagChunk } from './types.js';

const SEPARATORS = ['\r\n\r\n', '\n\n', '\r\n', '\n', '。', '！', '？', '.', '!', '?', ' ', ''];

// 只替换库的字符兜底，保留其递归、合并和 overlap 算法。
class UnicodeRecursiveSplitter extends RecursiveCharacterTextSplitter {
  protected override splitOnSeparator(text: string, separator: string): string[] {
    return separator === '' ? Array.from(text) : super.splitOnSeparator(text, separator);
  }
}

export async function chunkMarkdownSection(
  fileId: string,
  section: MarkdownSection,
): Promise<RagChunk[]> {
  if (!section.content.trim()) return [];

  const prefix = buildEmbeddingText({ headingPath: section.headingPath, content: '' });
  let bodyBudget = EMBEDDING_TEXT_BUDGET - countBudgetTokens(prefix);
  while (bodyBudget > 0) {
    const splitter = new UnicodeRecursiveSplitter({
      chunkSize: bodyBudget,
      chunkOverlap: Math.min(MAX_OVERLAP_BUDGET, Math.floor(bodyBudget * 0.125)),
      keepSeparator: true,
      separators: SEPARATORS,
      lengthFunction: countBudgetTokens,
    });
    const contents = (await splitter.splitText(section.content)).filter((content) => content.trim());
    let overflow = 0;
    for (const content of contents) {
      const tokens = countBudgetTokens(buildEmbeddingText({ headingPath: section.headingPath, content }));
      overflow = Math.max(overflow, tokens - EMBEDDING_TEXT_BUDGET);
    }
    if (overflow > 0) {
      // BPE 计数不满足简单可加性；重新检查拼接结果，并严格缩小预算以保证终止。
      bodyBudget -= Math.max(overflow, Math.ceil(bodyBudget * 0.1));
      continue;
    }

    return contents.map((content, chunkIndex) => {
      const chunk: RagChunk = {
        id: randomUUID(),
        fileId,
        sectionId: section.id,
        content,
        headingPath: [...section.headingPath],
        chunkIndex,
      };
      const localStart = section.content.indexOf(content);
      // 重复文本可能对应多个来源；宁可省略位置，也不取第一个匹配冒充真实位置。
      if (localStart >= 0 && section.content.indexOf(content, localStart + 1) === -1) {
        chunk.startOffset = section.startOffset + localStart;
        chunk.endOffset = chunk.startOffset + content.length;
      }
      return chunk;
    });
  }
  throw new Error(`Section ${section.id} cannot fit heading and body within the embedding text budget`);
}

export async function prepareChunks({ fileId, format, text }: PrepareChunksInput, signal?: AbortSignal): Promise<RagChunk[]> {
  signal?.throwIfAborted();
  if (!fileId.trim()) throw new Error('fileId is required');
  if (format !== 'md' && format !== 'txt') throw new Error('Unsupported RAG file format');
  const sections: MarkdownSection[] = format === 'md'
    ? parseMarkdownSections(text)
    : [{ id: randomUUID(), content: text, headingPath: [], startOffset: 0, endOffset: text.length }];

  const chunks: RagChunk[] = [];
  // 顺序处理，保持文档顺序，也避免同时对大量 Section 进行 token 计算。
  for (const section of sections) {
    // 让断连与总超时信号有机会在连续的本地切分之间被处理。
    await setImmediate();
    signal?.throwIfAborted();
    chunks.push(...await chunkMarkdownSection(fileId, section));
  }
  await setImmediate();
  signal?.throwIfAborted();
  return chunks;
}
