import { parseInlineMarkdown } from './inlineParser';

import type { MarkdownBlockId, MarkdownBlockNode, MarkdownHeadingLevel } from './ast';

type FenceCharacter = '`' | '~';

interface OpeningFence {
  character: FenceCharacter;
  length: number;
  language: string | null;
}

interface ListLine {
  ordered: boolean;
  start: number | null;
  content: string;
}

interface ActiveParagraph {
  type: 'paragraph';
  id: MarkdownBlockId;
  lines: string[];
}

interface ActiveFencedCode {
  type: 'code';
  id: MarkdownBlockId;
  character: FenceCharacter;
  fenceLength: number;
  language: string | null;
  lines: string[];
}

interface ActiveList {
  type: 'list';
  id: MarkdownBlockId;
  ordered: boolean;
  start: number | null;
  items: string[];
}

interface ActiveBlockquote {
  type: 'blockquote';
  id: MarkdownBlockId;
  lines: string[];
}

type ActiveBlock = ActiveParagraph | ActiveFencedCode | ActiveList | ActiveBlockquote;

/** Block ID 只依赖原始文本起始 offset，活动块内容变化时 ID 不会抖动。 */
function createBlockId(startOffset: number): MarkdownBlockId {
  return `md:${startOffset}`;
}

function isBlankLine(line: string): boolean {
  return /^[\t ]*$/.test(line);
}

/** opening fence 允许最多三个前导空格，并记录字符、长度和语言。 */
function matchOpeningFence(line: string): OpeningFence | null {
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);

  if (!match) {
    return null;
  }

  const marker = match[2];
  const info = match[3].trim();
  const language = info ? info.split(/[\t ]+/, 1)[0] : null;

  return {
    character: marker[0] as FenceCharacter,
    length: marker.length,
    language,
  };
}

/** closing fence 必须使用相同字符，长度不少于 opening fence，尾部只能有空白。 */
function isClosingFence(line: string, active: ActiveFencedCode): boolean {
  const match = /^( {0,3})(`{3,}|~{3,})[\t ]*$/.exec(line);

  if (!match) {
    return false;
  }

  const marker = match[2];
  return marker[0] === active.character && marker.length >= active.fenceLength;
}

function matchHeading(line: string): { level: MarkdownHeadingLevel; content: string } | null {
  const match = /^ {0,3}(#{1,6})((?:[\t ]+.*)?)[\t ]*$/.exec(line);

  if (!match) {
    return null;
  }

  return {
    level: match[1].length as MarkdownHeadingLevel,
    content: match[2].trim(),
  };
}

function matchListLine(line: string): ListLine | null {
  const unordered = /^ {0,3}[-+*][\t ]+(.*)$/.exec(line);

  if (unordered) {
    return {
      ordered: false,
      start: null,
      content: unordered[1],
    };
  }

  const ordered = /^ {0,3}(\d{1,9})\.[\t ]+(.*)$/.exec(line);

  if (!ordered) {
    return null;
  }

  return {
    ordered: true,
    start: Number(ordered[1]),
    content: ordered[2],
  };
}

function matchBlockquoteLine(line: string): string | null {
  const match = /^ {0,3}>[\t ]?(.*)$/.exec(line);
  return match ? match[1] : null;
}

/**
 * 消费完整逻辑行的块级状态机。
 *
 * chunk 切分和不完整尾行不属于这里，后续 StreamingMarkdownParser 会先把
 * chunk 组装成完整行，再调用 pushLine。
 */
export class MarkdownBlockParser {
  private activeBlock: ActiveBlock | null = null;

  /**
   * 处理一行不含 \r 或 \n 的文本，返回这一行使其稳定下来的 Block。
   * startOffset 必须是该行在原始 Markdown 字符串中的 UTF-16 offset。
   */
  pushLine(line: string, startOffset: number): readonly MarkdownBlockNode[] {
    if (this.activeBlock?.type === 'code') {
      return this.pushCodeLine(line);
    }

    return this.pushRegularLine(line, startOffset);
  }

  /** 返回当前仍可能被后续行修改的活动 Block。 */
  getActiveBlock(): MarkdownBlockNode | null {
    const active = this.activeBlock;

    if (!active) {
      return null;
    }

    switch (active.type) {
      case 'paragraph':
        return {
          type: 'paragraph',
          id: active.id,
          children: parseInlineMarkdown(active.lines.join('\n')),
        };

      case 'code':
        return {
          type: 'code',
          id: active.id,
          language: active.language,
          /** 第一版规范化为 \n 分隔，并且不保留 closing fence 前的末尾换行。 */
          value: active.lines.join('\n'),
        };

      case 'list':
        return {
          type: 'list',
          id: active.id,
          ordered: active.ordered,
          start: active.start,
          items: active.items.map((item) => ({
            children: parseInlineMarkdown(item),
          })),
        };

      case 'blockquote':
        return {
          type: 'blockquote',
          id: active.id,
          children: parseInlineMarkdown(active.lines.join('\n')),
        };
    }
  }

  /**
   * 用尚未换行的 buffer 生成活动预览，但不修改正式状态。
   * 如果当前尾行可能开启新 Block，则保守保留旧活动块，等完整换行后再切换，
   * 避免把仍可能反转的判断提前放进 stableBlocks。
   */
  previewLine(line: string, startOffset: number): MarkdownBlockNode | null {
    const currentActive = this.getActiveBlock();
    const previewParser = this.createPreviewParser();
    const previewStable = previewParser.pushLine(line, startOffset);

    if (currentActive && previewStable.length > 0) {
      return currentActive;
    }

    return previewParser.getActiveBlock() ?? previewStable.at(-1) ?? currentActive;
  }

  /** 流结束时把最后一个 Paragraph、未闭合 Code、List 或 Quote 强制稳定。 */
  finish(): readonly MarkdownBlockNode[] {
    const active = this.takeActiveBlock();
    return active ? [active] : [];
  }

  private pushCodeLine(line: string): readonly MarkdownBlockNode[] {
    const active = this.activeBlock;

    if (!active || active.type !== 'code') {
      return [];
    }

    if (isClosingFence(line, active)) {
      const completed = this.takeActiveBlock();
      return completed ? [completed] : [];
    }

    active.lines.push(line);
    return [];
  }

  private pushRegularLine(line: string, startOffset: number): readonly MarkdownBlockNode[] {
    const openingFence = matchOpeningFence(line);

    if (openingFence) {
      const completed = this.takeActiveBlock();
      this.activeBlock = {
        type: 'code',
        id: createBlockId(startOffset),
        character: openingFence.character,
        fenceLength: openingFence.length,
        language: openingFence.language,
        lines: [],
      };
      return completed ? [completed] : [];
    }

    if (isBlankLine(line)) {
      const completed = this.takeActiveBlock();
      return completed ? [completed] : [];
    }

    const heading = matchHeading(line);

    if (heading) {
      const completed = this.takeActiveBlock();
      const headingNode: MarkdownBlockNode = {
        type: 'heading',
        id: createBlockId(startOffset),
        level: heading.level,
        children: parseInlineMarkdown(heading.content),
      };
      return completed ? [completed, headingNode] : [headingNode];
    }

    const blockquote = matchBlockquoteLine(line);

    if (blockquote !== null) {
      return this.pushBlockquoteLine(blockquote, startOffset);
    }

    const list = matchListLine(line);

    if (list) {
      return this.pushListLine(list, startOffset);
    }

    return this.pushParagraphLine(line, startOffset);
  }

  private pushParagraphLine(line: string, startOffset: number): readonly MarkdownBlockNode[] {
    if (this.activeBlock?.type === 'paragraph') {
      this.activeBlock.lines.push(line);
      return [];
    }

    const completed = this.takeActiveBlock();
    this.activeBlock = {
      type: 'paragraph',
      id: createBlockId(startOffset),
      lines: [line],
    };
    return completed ? [completed] : [];
  }

  private pushListLine(list: ListLine, startOffset: number): readonly MarkdownBlockNode[] {
    if (this.activeBlock?.type === 'list' && this.activeBlock.ordered === list.ordered) {
      this.activeBlock.items.push(list.content);
      return [];
    }

    const completed = this.takeActiveBlock();
    this.activeBlock = {
      type: 'list',
      id: createBlockId(startOffset),
      ordered: list.ordered,
      start: list.start,
      items: [list.content],
    };
    return completed ? [completed] : [];
  }

  private pushBlockquoteLine(content: string, startOffset: number): readonly MarkdownBlockNode[] {
    if (this.activeBlock?.type === 'blockquote') {
      this.activeBlock.lines.push(content);
      return [];
    }

    const completed = this.takeActiveBlock();
    this.activeBlock = {
      type: 'blockquote',
      id: createBlockId(startOffset),
      lines: [content],
    };
    return completed ? [completed] : [];
  }

  /** 生成最终 AST 后立刻清空内部状态，保证已稳定节点以后不会再被修改。 */
  private takeActiveBlock(): MarkdownBlockNode | null {
    const completed = this.getActiveBlock();
    this.activeBlock = null;
    return completed;
  }

  /** Preview 使用独立副本，任何试探性解析都不会污染真实的 Block 状态机。 */
  private createPreviewParser(): MarkdownBlockParser {
    const parser = new MarkdownBlockParser();
    const active = this.activeBlock;

    if (!active) {
      return parser;
    }

    switch (active.type) {
      case 'paragraph':
        parser.activeBlock = { ...active, lines: [...active.lines] };
        break;
      case 'code':
        parser.activeBlock = { ...active, lines: [...active.lines] };
        break;
      case 'list':
        parser.activeBlock = { ...active, items: [...active.items] };
        break;
      case 'blockquote':
        parser.activeBlock = { ...active, lines: [...active.lines] };
        break;
    }

    return parser;
  }
}
