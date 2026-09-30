import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import type { PhrasingContent } from 'mdast';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import {
  buildEmbeddingText,
  countBudgetTokens,
  EMBEDDING_TEXT_BUDGET,
  MAX_OVERLAP_BUDGET,
} from '../embedding.js';
import type { MarkdownSection, PrepareChunksInput, RagChunk } from '../types.js';
// 监控采集：可选观察器只保存实际切分结果；记录失败不影响业务执行。
import type { IngestionRecording } from '../../recording/ingestion.js';

const parser = unified().use(remarkParse);

function headingText(node: PhrasingContent): string {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value;
  if (node.type === 'image' || node.type === 'imageReference') return node.alt ?? '';
  if (node.type === 'break') return ' ';
  if ('children' in node) return node.children.map(headingText).join('');
  return '';
}

function parseMarkdownSections(markdown: string): MarkdownSection[] {
  // 解析器不需要 BOM，但所有对外位置仍指向未经修改的输入字符串。
  const bomOffset = markdown.startsWith('\uFEFF') ? 1 : 0;
  const tree = parser.parse(markdown.slice(bomOffset));
  const sections: MarkdownSection[] = [];
  const headings: { depth: number; text: string }[] = [];
  let startOffset = 0;

  function appendSection(endOffset: number): void {
    const content = markdown.slice(startOffset, endOffset);
    if (!content.trim()) return;
    sections.push({
      id: randomUUID(),
      content,
      headingPath: headings.map((heading) => heading.text),
      startOffset,
      endOffset,
    });
  }

  // 只处理文档根节点的标题，引用和列表内部的标题不改变 Section 归属。
  for (const node of tree.children) {
    if (node.type !== 'heading') continue;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) {
      throw new Error('Markdown heading is missing source offsets');
    }
    appendSection(start + bomOffset);
    while (headings.length && headings[headings.length - 1]!.depth >= node.depth) {
      headings.pop();
    }
    headings.push({ depth: node.depth, text: node.children.map(headingText).join('') });
    startOffset = end + bomOffset;
  }
  appendSection(markdown.length);
  return sections;
}

const SEPARATORS = ['\r\n\r\n', '\n\n', '\r\n', '\n', '。', '！', '？', '.', '!', '?', ' ', ''];

// 监控采集：直接使用算法常量记录规则，避免展示值与实际实现漂移。
export const CHUNKING_RULES = {
  algorithm: 'markdown-sections-or-txt-recursive', budgetTokenizer: 'cl100k_base',
  embeddingTextBudget: EMBEDDING_TEXT_BUDGET, maxOverlapBudget: MAX_OVERLAP_BUDGET,
  overlapRatio: 0.125, separators: SEPARATORS, keepSeparator: true,
  unicodeFallback: 'code-point', offsetUnit: 'UTF-16',
};

// 只替换库的字符兜底，保留其递归、合并和 overlap 算法。
class UnicodeRecursiveSplitter extends RecursiveCharacterTextSplitter {
  protected override splitOnSeparator(text: string, separator: string): string[] {
    return separator === '' ? Array.from(text) : super.splitOnSeparator(text, separator);
  }
}

async function chunkMarkdownSection(
  fileId: string,
  section: MarkdownSection,
  recording?: IngestionRecording,
): Promise<RagChunk[]> {
  if (!section.content.trim()) return [];

  const prefix = buildEmbeddingText({ headingPath: section.headingPath, content: '' });
  let bodyBudget = EMBEDDING_TEXT_BUDGET - countBudgetTokens(prefix);
  while (bodyBudget > 0) {
    const overlap = Math.min(MAX_OVERLAP_BUDGET, Math.floor(bodyBudget * CHUNKING_RULES.overlapRatio));
    const splitter = new UnicodeRecursiveSplitter({
      chunkSize: bodyBudget,
      chunkOverlap: overlap,
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

    const chunks = contents.map((content, chunkIndex) => {
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
    // 监控采集：每个 Section 完成后保存快照，后续失败仍可复盘；记录失败不影响业务执行。
    recording?.section(section, chunks, bodyBudget, overlap);
    return chunks;
  }
  throw new Error(`Section ${section.id} cannot fit heading and body within the embedding text budget`);
}

export async function prepareChunks({ fileId, format, text }: PrepareChunksInput, signal?: AbortSignal, recording?: IngestionRecording): Promise<RagChunk[]> {
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
    // 监控采集：透传可选观察器；记录失败不影响业务执行。
    chunks.push(...await chunkMarkdownSection(fileId, section, recording));
  }
  await setImmediate();
  signal?.throwIfAborted();
  return chunks;
}
