import { randomUUID } from 'node:crypto';
import type { PhrasingContent } from 'mdast';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import type { MarkdownSection } from './types.js';

const parser = unified().use(remarkParse);

function headingText(node: PhrasingContent): string {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value;
  if (node.type === 'image' || node.type === 'imageReference') return node.alt ?? '';
  if (node.type === 'break') return ' ';
  if ('children' in node) return node.children.map(headingText).join('');
  return '';
}

export function parseMarkdownSections(markdown: string): MarkdownSection[] {
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
